'use strict';

/** Admin: product/price model editing, license operations, jobs, audit trail. */

const express = require('express');
const { db, nowIso, audit } = require('../db');
const cpq = require('../cpq');
const lic = require('../license');
const commerce = require('../commerce');
const bridge = require('../bridge');
const keys = require('../keys');
const { requireRole } = require('../auth');

const router = express.Router();
router.use(requireRole('admin', 'sales'));

const adminOnly = requireRole('admin');

// ---- Products / pricing ----------------------------------------------------

router.get('/products', (req, res) => res.json(cpq.listProducts({ includeInactive: true })));

router.get('/products/:sku', (req, res) => {
  const p = cpq.getProduct(req.params.sku);
  if (!p) return res.status(404).json({ error: 'not_found' });
  res.json(p);
});

router.put('/products/:sku', adminOnly, (req, res) => {
  const { name, summary, description, currency = 'EUR', active = true, sortOrder = 0, model } = req.body || {};
  if (!name || !model) return res.status(400).json({ error: 'name and model are required' });

  // Reject a model that cannot price its own defaults, so a bad edit can never
  // reach the storefront.
  try {
    const probe = { sku: req.params.sku, name, currency, model };
    const cfg = cpq.normaliseConfig(probe, {});
    cpq.price(probe, cfg);
  } catch (err) {
    return res.status(422).json({ error: 'invalid_model', message: err.message });
  }

  const existing = cpq.getProduct(req.params.sku);
  if (existing) {
    db.prepare(`UPDATE products SET name=?, summary=?, description=?, currency=?, active=?, sort_order=?, model_json=?, updated_at=? WHERE sku=?`)
      .run(name, summary || null, description || null, currency, active ? 1 : 0, sortOrder, JSON.stringify(model), nowIso(), req.params.sku);
  } else {
    db.prepare(`INSERT INTO products (sku, name, summary, description, currency, active, sort_order, model_json, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(req.params.sku, name, summary || null, description || null, currency, active ? 1 : 0, sortOrder, JSON.stringify(model), nowIso());
  }

  audit({
    actor: req.user.email,
    action: existing ? 'product.updated' : 'product.created',
    entityType: 'product',
    entityId: req.params.sku,
  });
  res.json(cpq.getProduct(req.params.sku));
});

router.delete('/products/:sku', adminOnly, (req, res) => {
  // Products are deactivated, never deleted — existing licenses reference the SKU.
  db.prepare(`UPDATE products SET active = 0, updated_at = ? WHERE sku = ?`).run(nowIso(), req.params.sku);
  audit({ actor: req.user.email, action: 'product.deactivated', entityType: 'product', entityId: req.params.sku });
  res.json({ ok: true });
});

// ---- Licenses --------------------------------------------------------------

router.get('/licenses', (req, res) => {
  const rows = db.prepare(`SELECT * FROM licenses ORDER BY created_at DESC LIMIT 500`).all();
  res.json(rows.map((r) => {
    const h = lic.hydrate(r);
    const account = db.prepare(`SELECT name FROM accounts WHERE id = ?`).get(r.account_id);
    return { ...h, account_name: account ? account.name : null };
  }));
});

router.get('/licenses/:id', (req, res) => {
  const license = lic.getLicense(req.params.id) || lic.getLicenseByKey(req.params.id);
  if (!license) return res.status(404).json({ error: 'not_found' });
  res.json(lic.hydrate(license));
});

router.post('/licenses/:id/revoke', adminOnly, (req, res) => {
  res.json(lic.revokeLicense(req.params.id, (req.body || {}).reason || 'admin_action', { actor: req.user.email, ip: req.ip }));
});

router.post('/licenses/:id/reinstate', adminOnly, (req, res) => {
  res.json(lic.reinstateLicense(req.params.id, { actor: req.user.email }));
});

router.post('/licenses/:id/renew', adminOnly, (req, res) => {
  res.json(lic.renewLicense(req.params.id, Number((req.body || {}).termMonths || 12), { actor: req.user.email }));
});

router.patch('/licenses/:id', adminOnly, (req, res) => {
  try {
    res.json(lic.updateLicense(req.params.id, req.body || {}, { actor: req.user.email }));
  } catch (err) {
    res.status(400).json({ error: 'update_failed', message: err.message });
  }
});

// ---- Subscriptions / orders ------------------------------------------------

router.get('/subscriptions', (req, res) => res.json(commerce.listSubscriptions()));

router.post('/subscriptions/:id/renew-now', adminOnly, async (req, res) => {
  try {
    res.json(await commerce.renewSubscription(req.params.id, { actor: req.user.email }));
  } catch (err) {
    res.status(400).json({ error: 'renew_failed', message: err.message });
  }
});

router.post('/subscriptions/:id/cancel', adminOnly, async (req, res) => {
  res.json(await commerce.cancelSubscription(req.params.id, {
    immediate: Boolean((req.body || {}).immediate),
    reason: (req.body || {}).reason || 'admin_action',
    actor: req.user.email,
  }));
});

router.get('/orders', (req, res) => {
  res.json(db.prepare(`SELECT * FROM orders ORDER BY created_at DESC LIMIT 200`).all());
});

router.post('/orders/:id/refund', adminOnly, async (req, res) => {
  try {
    res.json(await commerce.refundOrder(req.params.id, { actor: req.user.email, reason: (req.body || {}).reason }));
  } catch (err) {
    res.status(400).json({ error: 'refund_failed', message: err.message });
  }
});

// ---- The bridge: job queue -------------------------------------------------

router.get('/jobs', (req, res) => {
  res.json({ adapter: bridge.adapterName(), jobs: bridge.listJobs({ status: req.query.status }) });
});

router.post('/jobs/:id/retry', adminOnly, async (req, res) => {
  bridge.retryJob(req.params.id);
  const results = await bridge.drain();
  res.json({ ok: true, results });
});

router.post('/jobs/drain', adminOnly, async (req, res) => res.json(await bridge.drain()));

// ---- Keys ------------------------------------------------------------------

router.get('/signing-keys', (req, res) => {
  res.json(db.prepare(`SELECT kid, status, created_at, retired_at FROM signing_keys ORDER BY created_at DESC`).all());
});

router.post('/signing-keys/rotate', adminOnly, (req, res) => {
  const next = keys.rotate(req.user.email);
  res.json({ ok: true, kid: next.kid });
});

// ---- Audit -----------------------------------------------------------------

router.get('/audit', (req, res) => {
  const { entityId, action, limit = 200 } = req.query;
  let sql = `SELECT * FROM audit_log`;
  const where = [];
  const params = [];
  if (entityId) { where.push('entity_id = ?'); params.push(entityId); }
  if (action) { where.push('action LIKE ?'); params.push(`%${action}%`); }
  if (where.length) sql += ' WHERE ' + where.join(' AND ');
  sql += ' ORDER BY id DESC LIMIT ?';
  params.push(Number(limit));
  res.json(db.prepare(sql).all(...params).map((r) => ({ ...r, detail: r.detail_json ? JSON.parse(r.detail_json) : null })));
});

router.get('/stats', (req, res) => {
  const one = (sql, ...p) => db.prepare(sql).get(...p);
  res.json({
    products: one(`SELECT COUNT(*) AS n FROM products WHERE active = 1`).n,
    quotes: one(`SELECT COUNT(*) AS n FROM quotes`).n,
    orders_paid: one(`SELECT COUNT(*) AS n FROM orders WHERE status = 'paid'`).n,
    mrr_cents: one(`SELECT COALESCE(SUM(renewal_cents * 12 / term_months), 0) AS n FROM subscriptions WHERE status = 'active'`).n / 12,
    subscriptions_active: one(`SELECT COUNT(*) AS n FROM subscriptions WHERE status = 'active'`).n,
    licenses_active: one(`SELECT COUNT(*) AS n FROM licenses WHERE status = 'active'`).n,
    activations: one(`SELECT COUNT(*) AS n FROM activations WHERE status = 'active'`).n,
    jobs_failed: one(`SELECT COUNT(*) AS n FROM license_jobs WHERE status = 'failed'`).n,
    jobs_pending: one(`SELECT COUNT(*) AS n FROM license_jobs WHERE status = 'pending'`).n,
  });
});

module.exports = router;
