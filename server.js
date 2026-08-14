'use strict';

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');

const config = require('./src/config');
const { db, audit } = require('./src/db');
const auth = require('./src/auth');
const keys = require('./src/keys');
const bridge = require('./src/bridge');
const commerce = require('./src/commerce');

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');

// Stripe's webhook signature is computed over the raw body, so it must be
// registered before the JSON parser.
app.post('/webhooks/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  const signature = req.get('Stripe-Signature') || '';
  const secret = config.payments.stripeWebhookSecret;
  if (!secret) return res.status(500).send('Webhook secret not configured');

  try {
    const parts = Object.fromEntries(signature.split(',').map((kv) => kv.split('=')));
    const expected = crypto.createHmac('sha256', secret).update(`${parts.t}.${req.body}`).digest('hex');
    if (!parts.v1 || !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(parts.v1))) {
      return res.status(400).send('Bad signature');
    }
    const age = Math.abs(Date.now() / 1000 - Number(parts.t));
    if (!Number.isFinite(age) || age > 300) return res.status(400).send('Stale webhook');
  } catch {
    return res.status(400).send('Bad signature');
  }

  const event = JSON.parse(req.body.toString('utf8'));
  try {
    if (event.type === 'checkout.session.completed') {
      const orderId = event.data.object.client_reference_id || (event.data.object.metadata || {}).order_id;
      if (orderId) await commerce.markOrderPaid(orderId, { paymentRef: event.data.object.payment_intent, actor: 'stripe-webhook' });
    } else if (event.type === 'charge.refunded') {
      const order = db.prepare(`SELECT id FROM orders WHERE payment_ref = ?`).get(event.data.object.payment_intent);
      if (order) await commerce.refundOrder(order.id, { actor: 'stripe-webhook', reason: 'stripe_refund' });
    }
    res.json({ received: true });
  } catch (err) {
    audit({ actor: 'stripe-webhook', action: 'webhook.error', detail: { type: event.type, error: err.message } });
    res.status(500).json({ error: err.message });
  }
});

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

app.use(
  session({
    name: 'cpqsid',
    secret: config.session.secret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: config.session.secure,
      maxAge: 8 * 3600 * 1000,
    },
  })
);

app.use(auth.attachUser);

// Security headers. The storefront ships no third-party scripts, so the CSP can
// stay tight.
app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Content-Security-Policy':
      "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'",
  });
  next();
});

app.use('/auth', require('./src/routes/auth'));
app.use('/api', require('./src/routes/shop'));
app.use('/api/admin', require('./src/routes/admin'));
app.use('/api/v1', require('./src/routes/license-api'));

// Published so any application can verify a license offline.
app.get('/.well-known/license-jwks.json', (req, res) => res.json(keys.jwks()));

app.get('/api/config', (req, res) => {
  res.json({
    demoMode: config.demoMode,
    azureConfigured: config.azure.configured,
    paymentProvider: config.payments.provider,
    licenseAdapter: bridge.adapterName(),
    currency: config.payments.currency,
    tokenTtlDays: config.license.tokenTtlDays,
    graceDays: config.license.graceDays,
  });
});

app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

app.use((req, res) => res.status(404).json({ error: 'not_found', path: req.path }));

app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  console.error('[error]', err);
  res.status(err.httpStatus || 500).json({ error: 'server_error', message: err.message });
});

if (require.main === module) {
  const seed = require('./scripts/seed');
  seed.ensureSeeded();

  keys.getSigningKey(); // mint the signing key on first boot
  bridge.startWorker();
  commerce.startRenewalWorker();

  app.listen(config.port, () => {
    console.log(`CPQ + license server listening on ${config.publicUrl}`);
    console.log(`  demo mode:        ${config.demoMode}`);
    console.log(`  Azure AD:         ${config.azure.configured ? 'configured' : 'NOT configured (demo sign-in active)'}`);
    console.log(`  payments:         ${config.payments.provider}`);
    console.log(`  license adapter:  ${bridge.adapterName()}`);
  });
}

module.exports = app;
