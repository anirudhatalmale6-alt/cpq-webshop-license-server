'use strict';

/** Storefront: catalogue, configurator, quotes, checkout, and the customer's own licenses. */

const express = require('express');
const config = require('../config');
const cpq = require('../cpq');
const commerce = require('../commerce');
const payments = require('../payments');
const lic = require('../license');
const bridge = require('../bridge');
const { db, audit } = require('../db');
const { requireAuth } = require('../auth');

const router = express.Router();

const publicProduct = (p) => ({
  sku: p.sku,
  name: p.name,
  summary: p.summary,
  description: p.description,
  currency: p.currency,
  model: p.model,
});

router.get('/products', (req, res) => {
  res.json(cpq.listProducts().map(publicProduct));
});

router.get('/products/:sku', (req, res) => {
  const product = cpq.getProduct(req.params.sku);
  if (!product || !product.active) return res.status(404).json({ error: 'not_found' });
  res.json(publicProduct(product));
});

/**
 * Live pricing. The browser calls this on every change, so the number on screen
 * is always the number the server will charge — the UI never prices anything itself.
 */
router.post('/products/:sku/price', (req, res) => {
  const product = cpq.getProduct(req.params.sku);
  if (!product) return res.status(404).json({ error: 'not_found' });

  const cfg = cpq.normaliseConfig(product, (req.body && req.body.config) || {});
  const errors = cpq.validateConfig(product, cfg);

  // Only sales and admin may apply a manual discount.
  const requested = Number((req.body && req.body.discountPct) || 0);
  const discountPct = req.user && ['sales', 'admin'].includes(req.user.role) ? Math.max(0, Math.min(100, requested)) : 0;

  res.json({
    config: cfg,
    errors,
    valid: errors.length === 0,
    blocked: cpq.availability(product, cfg),
    pricing: cpq.price(product, cfg, { discountPct }),
    license_preview: cpq.licenseParams(product, cfg),
    discount_allowed: Boolean(req.user && ['sales', 'admin'].includes(req.user.role)),
  });
});

router.post('/quotes', requireAuth, (req, res) => {
  const product = cpq.getProduct((req.body || {}).sku);
  if (!product) return res.status(404).json({ error: 'not_found' });

  const cfg = cpq.normaliseConfig(product, req.body.config || {});
  const errors = cpq.validateConfig(product, cfg);
  if (errors.length) return res.status(422).json({ error: 'invalid_configuration', errors });

  const requested = Number(req.body.discountPct || 0);
  const discountPct = ['sales', 'admin'].includes(req.user.role) ? Math.max(0, Math.min(100, requested)) : 0;
  const pricing = cpq.price(product, cfg, { discountPct });

  const quote = cpq.createQuote(
    { product, cfg, pricing, user: req.user, accountId: req.user.account_id, discountPct },
    { ip: req.ip }
  );
  res.json(quote);
});

router.get('/quotes', requireAuth, (req, res) => {
  const rows = ['sales', 'admin'].includes(req.user.role)
    ? db.prepare(`SELECT * FROM quotes ORDER BY created_at DESC LIMIT 200`).all()
    : db.prepare(`SELECT * FROM quotes WHERE account_id = ? ORDER BY created_at DESC`).all(req.user.account_id);
  res.json(rows.map((r) => ({ ...r, config: JSON.parse(r.config_json), pricing: JSON.parse(r.pricing_json) })));
});

router.get('/quotes/:id', requireAuth, (req, res) => {
  const quote = cpq.getQuote(req.params.id);
  if (!quote) return res.status(404).json({ error: 'not_found' });
  if (quote.account_id !== req.user.account_id && !['sales', 'admin'].includes(req.user.role)) {
    return res.status(403).json({ error: 'forbidden' });
  }
  res.json(quote);
});

router.post('/quotes/:id/approve', requireAuth, (req, res) => {
  if (!['sales', 'admin'].includes(req.user.role)) return res.status(403).json({ error: 'forbidden' });
  const quote = cpq.getQuote(req.params.id);
  if (!quote) return res.status(404).json({ error: 'not_found' });
  const approve = (req.body || {}).approve !== false;
  db.prepare(`UPDATE quotes SET status = ?, approved_by = ?, approval_note = ? WHERE id = ?`)
    .run(approve ? 'approved' : 'rejected', req.user.email, (req.body || {}).note || null, quote.id);
  audit({
    actor: req.user.email,
    action: approve ? 'quote.approved' : 'quote.rejected',
    entityType: 'quote',
    entityId: quote.id,
    detail: { discount_pct: quote.discount_pct },
  });
  res.json(cpq.getQuote(quote.id));
});

// ---- Checkout --------------------------------------------------------------

router.post('/checkout', requireAuth, async (req, res) => {
  try {
    const quote = cpq.getQuote((req.body || {}).quoteId);
    if (!quote) return res.status(404).json({ error: 'quote_not_found' });
    if (quote.account_id !== req.user.account_id && !['sales', 'admin'].includes(req.user.role)) {
      return res.status(403).json({ error: 'forbidden' });
    }

    const order = commerce.createOrderFromQuote(quote, req.user, { ip: req.ip });
    const session = await payments.createCheckout({
      order,
      quote,
      customerEmail: req.user.email,
      successUrl: `${config.publicUrl}/checkout-complete.html`,
      cancelUrl: `${config.publicUrl}/quote.html?id=${quote.id}`,
    });

    db.prepare(`UPDATE orders SET payment_ref = ? WHERE id = ?`).run(session.reference, order.id);
    res.json({ order, redirectUrl: session.url, provider: payments.name });
  } catch (err) {
    res.status(400).json({ error: 'checkout_failed', message: err.message });
  }
});

/**
 * Demo-mode payment confirmation. With Stripe this is the webhook instead —
 * both call the exact same commerce.markOrderPaid().
 */
router.post('/checkout/confirm', requireAuth, async (req, res) => {
  if (payments.name !== 'mock') return res.status(400).json({ error: 'use_webhook' });
  try {
    const result = await commerce.markOrderPaid((req.body || {}).orderId, { actor: req.user.email, ip: req.ip });
    res.json({
      order: result.order,
      subscription: result.subscription,
      license: result.subscription ? result.subscription.license : null,
      alreadyProcessed: result.alreadyProcessed,
    });
  } catch (err) {
    res.status(400).json({ error: 'confirm_failed', message: err.message });
  }
});

// ---- The customer's own licenses ------------------------------------------

router.get('/my/subscriptions', requireAuth, (req, res) => {
  res.json(commerce.listSubscriptions({ accountId: req.user.account_id }));
});

router.get('/my/licenses', requireAuth, (req, res) => {
  const rows = db.prepare(`SELECT * FROM licenses WHERE account_id = ? ORDER BY created_at DESC`).all(req.user.account_id);
  res.json(rows.map(lic.hydrate));
});

router.post('/my/licenses/:id/deactivate-device', requireAuth, (req, res) => {
  const license = lic.getLicense(req.params.id);
  if (!license || license.account_id !== req.user.account_id) return res.status(404).json({ error: 'not_found' });
  const act = db.prepare(`SELECT * FROM activations WHERE id = ? AND license_id = ?`).get((req.body || {}).activationId, license.id);
  if (!act) return res.status(404).json({ error: 'activation_not_found' });
  db.prepare(`UPDATE activations SET status = 'deactivated', deactivated_at = datetime('now') WHERE id = ?`).run(act.id);
  audit({
    actor: req.user.email,
    action: 'license.deactivated',
    entityType: 'license',
    entityId: license.id,
    detail: { activation_id: act.id, self_service: true },
  });
  res.json(lic.hydrate(lic.getLicense(license.id)));
});

router.post('/my/subscriptions/:id/cancel', requireAuth, async (req, res) => {
  const sub = commerce.getSubscription(req.params.id);
  if (!sub || sub.account_id !== req.user.account_id) return res.status(404).json({ error: 'not_found' });
  res.json(await commerce.cancelSubscription(sub.id, { immediate: false, actor: req.user.email }));
});

router.post('/my/subscriptions/:id/resume', requireAuth, async (req, res) => {
  const sub = commerce.getSubscription(req.params.id);
  if (!sub || sub.account_id !== req.user.account_id) return res.status(404).json({ error: 'not_found' });
  res.json(await commerce.resumeSubscription(sub.id, { actor: req.user.email }));
});

router.post('/my/subscriptions/:id/change', requireAuth, async (req, res) => {
  const sub = commerce.getSubscription(req.params.id);
  if (!sub || sub.account_id !== req.user.account_id) return res.status(404).json({ error: 'not_found' });
  try {
    res.json(await commerce.changeSubscription(sub.id, (req.body || {}).config || {}, { actor: req.user.email }));
  } catch (err) {
    res.status(err.httpStatus || 400).json({ error: 'change_failed', message: err.message, errors: err.errors });
  }
});

module.exports = router;
