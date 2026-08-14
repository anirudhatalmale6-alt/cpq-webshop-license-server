'use strict';

/**
 * Orders, subscriptions and recurring billing.
 *
 * Every product here is subscription-based, so an order is never the end of the
 * story: a paid order creates a subscription, the subscription owns the license,
 * and the renewal worker moves both forward together. Cancelling, refunding or
 * letting a renewal fail all end up at the same place — the license reflects it.
 */

const crypto = require('crypto');
const { db, nowIso, audit } = require('./db');
const config = require('./config');
const cpq = require('./cpq');
const bridge = require('./bridge');
const licenseService = require('./license');
const payments = require('./payments');

function id(prefix) {
  return prefix + '_' + crypto.randomUUID().replace(/-/g, '').slice(0, 18);
}

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------

function createOrderFromQuote(quote, user, ctx = {}) {
  if (!quote) throw new Error('quote not found');
  if (quote.status === 'ordered') throw new Error('This quote has already been ordered');
  if (quote.status === 'pending_approval') throw new Error('This quote is waiting for sales approval');
  if (new Date(quote.expires_at) < new Date()) throw new Error('This quote has expired — please reconfigure');

  const orderId = id('ord');
  const number = cpq.nextNumber('orders', 'SO');
  db.prepare(
    `INSERT INTO orders (id, number, quote_id, account_id, user_id, status, currency, total_cents, payment_provider, created_at)
     VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`
  ).run(orderId, number, quote.id, quote.account_id, user ? user.id : null, quote.currency, quote.total_cents, config.payments.provider, nowIso());

  audit({
    actor: user ? user.email : 'system',
    action: 'order.created',
    entityType: 'order',
    entityId: orderId,
    detail: { number, quote: quote.number, total_cents: quote.total_cents },
    ip: ctx.ip,
  });

  return getOrder(orderId);
}

function getOrder(idOrNumber) {
  return db.prepare(`SELECT * FROM orders WHERE id = ? OR number = ?`).get(idOrNumber, idOrNumber);
}

/**
 * The single place where "money received" turns into "license exists".
 * Idempotent: calling it twice for the same order does nothing the second time,
 * which matters because payment webhooks are retried by design.
 */
async function markOrderPaid(orderId, { paymentRef, actor = 'payment-webhook', ip } = {}) {
  const order = getOrder(orderId);
  if (!order) throw new Error('order not found');
  if (order.status === 'paid') {
    return { order, subscription: getSubscriptionByOrder(order.id), alreadyProcessed: true };
  }

  const quote = cpq.getQuote(order.quote_id);
  const product = cpq.getProduct(quote.sku);
  const params = cpq.licenseParams(product, quote.config);

  db.prepare(`UPDATE orders SET status = 'paid', paid_at = ?, payment_ref = ? WHERE id = ?`)
    .run(nowIso(), paymentRef || null, order.id);

  const start = new Date();
  const end = licenseService.addMonths(start, params.termMonths);
  const subId = id('sub');
  db.prepare(
    `INSERT INTO subscriptions (id, account_id, order_id, sku, config_json, currency, renewal_cents, term_months,
      status, auto_renew, current_period_start, current_period_end, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', 1, ?, ?, ?, ?)`
  ).run(
    subId, order.account_id, order.id, quote.sku, JSON.stringify(quote.config), quote.currency,
    quote.pricing.renewal_cents, params.termMonths,
    start.toISOString(), end.toISOString(), nowIso(), nowIso()
  );

  db.prepare(`UPDATE quotes SET status = 'ordered' WHERE id = ?`).run(quote.id);

  audit({
    actor,
    action: 'order.paid',
    entityType: 'order',
    entityId: order.id,
    detail: { payment_ref: paymentRef, subscription_id: subId },
    ip,
  });

  // Hand off to the license server. Idempotency key is the subscription, so a
  // replayed webhook cannot issue two licenses for one purchase.
  bridge.enqueue(
    'issue',
    {
      accountId: order.account_id,
      subscriptionId: subId,
      sku: params.sku,
      edition: params.edition,
      seats: params.seats,
      modules: params.modules,
      features: params.features,
      termMonths: params.termMonths,
      startsAt: start.toISOString(),
      endsAt: end.toISOString(),
      keyPrefix: params.keyPrefix,
      orderNumber: order.number,
    },
    `issue:${subId}`
  );

  await bridge.drain();

  return { order: getOrder(order.id), subscription: getSubscription(subId), alreadyProcessed: false };
}

// ---------------------------------------------------------------------------
// Subscriptions
// ---------------------------------------------------------------------------

function getSubscription(subId) {
  const row = db.prepare(`SELECT * FROM subscriptions WHERE id = ?`).get(subId);
  if (!row) return null;
  const license = db.prepare(`SELECT * FROM licenses WHERE subscription_id = ?`).get(subId);
  return {
    ...row,
    config: JSON.parse(row.config_json),
    auto_renew: !!row.auto_renew,
    cancel_at_period_end: !!row.cancel_at_period_end,
    license: license ? licenseService.hydrate(license) : null,
  };
}

function getSubscriptionByOrder(orderId) {
  const row = db.prepare(`SELECT * FROM subscriptions WHERE order_id = ?`).get(orderId);
  return row ? getSubscription(row.id) : null;
}

function listSubscriptions({ accountId } = {}) {
  const rows = accountId
    ? db.prepare(`SELECT id FROM subscriptions WHERE account_id = ? ORDER BY created_at DESC`).all(accountId)
    : db.prepare(`SELECT id FROM subscriptions ORDER BY created_at DESC`).all();
  return rows.map((r) => getSubscription(r.id));
}

/** Charge the next term and push the new end date to the license server. */
async function renewSubscription(subId, { actor = 'renewal-worker' } = {}) {
  const sub = getSubscription(subId);
  if (!sub) throw new Error('subscription not found');
  if (sub.status === 'cancelled') throw new Error('subscription is cancelled');

  const periodEnd = new Date(sub.current_period_end);

  if (sub.cancel_at_period_end || !sub.auto_renew) {
    db.prepare(`UPDATE subscriptions SET status = 'expired', updated_at = ? WHERE id = ?`).run(nowIso(), subId);
    if (sub.license) {
      bridge.enqueue('revoke', { licenseId: sub.license.id, reason: 'subscription_not_renewed' }, `revoke:${subId}:${sub.current_period_end}`);
      await bridge.drain();
    }
    audit({ actor, action: 'subscription.lapsed', entityType: 'subscription', entityId: subId });
    return getSubscription(subId);
  }

  const charge = await payments.charge({
    amountCents: sub.renewal_cents,
    currency: sub.currency,
    description: `Renewal ${sub.sku} — ${sub.term_months} month(s)`,
    reference: `renew:${subId}:${sub.current_period_end}`,
  });

  if (!charge.ok) {
    db.prepare(`UPDATE subscriptions SET status = 'past_due', updated_at = ? WHERE id = ?`).run(nowIso(), subId);
    audit({
      actor,
      action: 'subscription.payment_failed',
      entityType: 'subscription',
      entityId: subId,
      detail: { error: charge.error },
    });
    // The license is NOT revoked here. It keeps working through the grace
    // period so a failed card does not lock a paying customer out of software
    // they are still entitled to; dunning handles the rest.
    return getSubscription(subId);
  }

  const newStart = periodEnd > new Date() ? periodEnd : new Date();
  const newEnd = licenseService.addMonths(newStart, sub.term_months);

  db.prepare(
    `UPDATE subscriptions SET status = 'active', current_period_start = ?, current_period_end = ?, updated_at = ? WHERE id = ?`
  ).run(newStart.toISOString(), newEnd.toISOString(), nowIso(), subId);

  const orderId = id('ord');
  db.prepare(
    `INSERT INTO orders (id, number, quote_id, account_id, user_id, status, currency, total_cents, payment_ref, payment_provider, created_at, paid_at)
     VALUES (?, ?, NULL, ?, NULL, 'paid', ?, ?, ?, ?, ?, ?)`
  ).run(orderId, cpq.nextNumber('orders', 'SO'), sub.account_id, sub.currency, sub.renewal_cents, charge.reference, config.payments.provider, nowIso(), nowIso());

  if (sub.license) {
    bridge.enqueue(
      'renew',
      { licenseId: sub.license.id, termMonths: sub.term_months, endsAt: newEnd.toISOString() },
      `renew:${subId}:${newEnd.toISOString()}`
    );
    await bridge.drain();
  }

  audit({
    actor,
    action: 'subscription.renewed',
    entityType: 'subscription',
    entityId: subId,
    detail: { new_period_end: newEnd.toISOString(), charged_cents: sub.renewal_cents },
  });

  return getSubscription(subId);
}

async function cancelSubscription(subId, { immediate = false, reason = 'customer_request', actor = 'system' } = {}) {
  const sub = getSubscription(subId);
  if (!sub) throw new Error('subscription not found');

  if (immediate) {
    db.prepare(`UPDATE subscriptions SET status = 'cancelled', auto_renew = 0, updated_at = ? WHERE id = ?`).run(nowIso(), subId);
    if (sub.license) {
      bridge.enqueue('revoke', { licenseId: sub.license.id, reason }, `revoke:${sub.license.id}:${reason}`);
      await bridge.drain();
    }
  } else {
    db.prepare(`UPDATE subscriptions SET cancel_at_period_end = 1, auto_renew = 0, updated_at = ? WHERE id = ?`).run(nowIso(), subId);
  }

  audit({
    actor,
    action: immediate ? 'subscription.cancelled_immediately' : 'subscription.cancel_at_period_end',
    entityType: 'subscription',
    entityId: subId,
    detail: { reason },
  });

  return getSubscription(subId);
}

async function resumeSubscription(subId, { actor = 'system' } = {}) {
  db.prepare(`UPDATE subscriptions SET cancel_at_period_end = 0, auto_renew = 1, status = 'active', updated_at = ? WHERE id = ?`)
    .run(nowIso(), subId);
  audit({ actor, action: 'subscription.resumed', entityType: 'subscription', entityId: subId });
  return getSubscription(subId);
}

/**
 * Mid-term change (add seats, add a module, move up an edition).
 * The customer pays the prorated difference; the license is updated in place so
 * the change is live on the next token refresh, without a reinstall.
 */
async function changeSubscription(subId, newConfigRaw, { actor = 'system' } = {}) {
  const sub = getSubscription(subId);
  if (!sub) throw new Error('subscription not found');
  const product = cpq.getProduct(sub.sku);
  const newConfig = cpq.normaliseConfig(product, newConfigRaw);
  const errors = cpq.validateConfig(product, newConfig);
  if (errors.length) throw new cpq.ConfigError(errors);

  const oldPricing = cpq.price(product, sub.config);
  const newPricing = cpq.price(product, newConfig);

  const msRemaining = Math.max(0, new Date(sub.current_period_end) - Date.now());
  const msTotal = new Date(sub.current_period_end) - new Date(sub.current_period_start);
  const fraction = msTotal > 0 ? msRemaining / msTotal : 0;
  const prorationCents = Math.round((newPricing.renewal_cents - oldPricing.renewal_cents) * fraction);

  if (prorationCents > 0) {
    const charge = await payments.charge({
      amountCents: prorationCents,
      currency: sub.currency,
      description: `Mid-term change ${sub.sku}`,
      reference: `change:${subId}:${Date.now()}`,
    });
    if (!charge.ok) throw new Error(`Proration charge failed: ${charge.error}`);
  }

  db.prepare(`UPDATE subscriptions SET config_json = ?, renewal_cents = ?, updated_at = ? WHERE id = ?`)
    .run(JSON.stringify(newConfig), newPricing.renewal_cents, nowIso(), subId);

  const params = cpq.licenseParams(product, newConfig);
  if (sub.license) {
    bridge.enqueue(
      'update',
      {
        licenseId: sub.license.id,
        changes: { edition: params.edition, seats: params.seats, modules: params.modules, features: params.features },
      },
      `update:${subId}:${JSON.stringify(newConfig)}`
    );
    await bridge.drain();
  }

  audit({
    actor,
    action: 'subscription.changed',
    entityType: 'subscription',
    entityId: subId,
    detail: { from: sub.config, to: newConfig, proration_cents: prorationCents },
  });

  return { subscription: getSubscription(subId), prorationCents, pricing: newPricing };
}

async function refundOrder(orderId, { reason = 'refund', actor = 'admin' } = {}) {
  const order = getOrder(orderId);
  if (!order) throw new Error('order not found');
  db.prepare(`UPDATE orders SET status = 'refunded' WHERE id = ?`).run(order.id);
  const sub = getSubscriptionByOrder(order.id);
  if (sub) await cancelSubscription(sub.id, { immediate: true, reason, actor });
  audit({ actor, action: 'order.refunded', entityType: 'order', entityId: order.id, detail: { reason } });
  return getOrder(order.id);
}

/** Renewal worker: everything whose period has ended. Run from cron or the timer. */
async function processDueRenewals({ now = new Date() } = {}) {
  const due = db
    .prepare(`SELECT id FROM subscriptions WHERE status IN ('active','past_due') AND current_period_end <= ?`)
    .all(now.toISOString());
  const results = [];
  for (const row of due) {
    try {
      const sub = await renewSubscription(row.id);
      results.push({ id: row.id, status: sub.status });
    } catch (err) {
      results.push({ id: row.id, error: err.message });
    }
  }
  return results;
}

let renewalTimer = null;
function startRenewalWorker(intervalMs = 3600000) {
  if (renewalTimer) return;
  renewalTimer = setInterval(() => {
    processDueRenewals().catch((err) => console.error('[renewals]', err.message));
  }, intervalMs);
  renewalTimer.unref();
}

module.exports = {
  createOrderFromQuote,
  getOrder,
  markOrderPaid,
  getSubscription,
  getSubscriptionByOrder,
  listSubscriptions,
  renewSubscription,
  cancelSubscription,
  resumeSubscription,
  changeSubscription,
  refundOrder,
  processDueRenewals,
  startRenewalWorker,
};
