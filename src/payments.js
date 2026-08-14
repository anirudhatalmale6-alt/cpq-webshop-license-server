'use strict';

/**
 * Payment provider adapter.
 *
 * `mock`   — used by the demo. Approves everything except amounts ending in .13,
 *            which fail, so the dunning / past-due path can actually be tested.
 * `stripe` — real Checkout Session + webhook. Subscriptions are billed from our
 *            own renewal worker against a saved payment method, which keeps the
 *            CPQ engine (not Stripe's price catalogue) as the source of truth
 *            for what a configured product costs.
 */

const crypto = require('crypto');
const config = require('./config');

const mock = {
  name: 'mock',
  async createCheckout({ order, successUrl, cancelUrl }) {
    return { url: `${successUrl}?mock_payment=1&order=${order.id}`, reference: 'mock_' + crypto.randomUUID().slice(0, 12), cancelUrl };
  },
  async charge({ amountCents, reference }) {
    if (String(amountCents).endsWith('13')) {
      return { ok: false, error: 'card_declined (demo: amounts ending in 13 always decline)' };
    }
    return { ok: true, reference: reference || 'mock_' + crypto.randomUUID().slice(0, 12) };
  },
};

function stripeAdapter() {
  const key = config.payments.stripeSecretKey;

  async function api(path, body, method = 'POST') {
    const res = await fetch('https://api.stripe.com/v1' + path, {
      method,
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body ? new URLSearchParams(flatten(body)).toString() : undefined,
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error ? json.error.message : `Stripe ${res.status}`);
    return json;
  }

  // Stripe's form encoding: nested[keys][like][this]
  function flatten(obj, prefix = '', out = {}) {
    for (const [k, v] of Object.entries(obj)) {
      const key = prefix ? `${prefix}[${k}]` : k;
      if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, key, out);
      else if (Array.isArray(v)) v.forEach((item, i) => flatten({ [i]: item }, key, out));
      else if (v !== undefined && v !== null) out[key] = String(v);
    }
    return out;
  }

  return {
    name: 'stripe',
    async createCheckout({ order, quote, successUrl, cancelUrl, customerEmail }) {
      const session = await api('/checkout/sessions', {
        mode: 'payment',
        success_url: `${successUrl}?session_id={CHECKOUT_SESSION_ID}&order=${order.id}`,
        cancel_url: cancelUrl,
        customer_email: customerEmail || undefined,
        client_reference_id: order.id,
        payment_intent_data: { setup_future_usage: 'off_session' },
        metadata: { order_id: order.id, quote: quote ? quote.number : '' },
        line_items: {
          0: {
            quantity: 1,
            price_data: {
              currency: order.currency.toLowerCase(),
              unit_amount: order.total_cents,
              product_data: { name: quote ? `${quote.sku} — quote ${quote.number}` : order.number },
            },
          },
        },
      });
      return { url: session.url, reference: session.id };
    },
    async charge({ amountCents, currency, description, customerId, paymentMethodId }) {
      try {
        const intent = await api('/payment_intents', {
          amount: amountCents,
          currency: (currency || config.payments.currency).toLowerCase(),
          customer: customerId,
          payment_method: paymentMethodId,
          off_session: true,
          confirm: true,
          description,
        });
        return { ok: intent.status === 'succeeded', reference: intent.id, error: intent.status !== 'succeeded' ? intent.status : undefined };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    },
  };
}

const provider = config.payments.provider === 'stripe' && config.payments.stripeSecretKey ? stripeAdapter() : mock;

module.exports = {
  name: provider.name,
  createCheckout: (...args) => provider.createCheckout(...args),
  charge: (...args) => provider.charge(...args),
};
