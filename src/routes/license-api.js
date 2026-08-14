'use strict';

/**
 * The license server's public API.
 *
 * Two audiences:
 *   1. The customer's software        — activate / refresh / deactivate.
 *      Authenticated by the license key itself plus a device fingerprint.
 *   2. Server-to-server (the shop, or your ERP)  — issue / update / renew / revoke.
 *      Authenticated by an API key in the `Api-Token` header.
 *
 * Verification of a license needs neither: the public key is published and the
 * token verifies offline.
 */

const express = require('express');
const config = require('../config');
const keys = require('../keys');
const lic = require('../license');
const { db } = require('../db');

const router = express.Router();

function requireApiKey(req, res, next) {
  const presented = req.get('Api-Token') || (req.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (!presented || !config.license.apiKeys.includes(presented)) {
    return res.status(401).json({ error: 'unauthorized', message: 'Missing or invalid Api-Token header' });
  }
  next();
}

/**
 * Runs a handler and turns a LicenseError into a clean, typed JSON response.
 * The callback form matters: these operations throw synchronously, and a bare
 * Promise.resolve(fn()) would let that escape to the generic error handler and
 * surface as an opaque 500 instead of, say, `seat_limit_reached`.
 */
function send(res, fn) {
  return Promise.resolve()
    .then(fn)
    .then((v) => res.json(v))
    .catch((err) => res.status(err.httpStatus || 500).json({ error: err.code || 'error', message: err.message }));
}

// ---- Key material (public) -------------------------------------------------

router.get('/.well-known/jwks.json', (req, res) => res.json(keys.jwks()));

router.get('/public-key.pem', (req, res) => {
  const { publicPem, kid } = keys.getSigningKey();
  res.type('text/plain').set('X-Key-Id', kid).send(publicPem);
});

router.get('/health', (req, res) => {
  res.json({
    ok: true,
    service: 'license-server',
    issuer: config.license.issuer,
    token_ttl_days: config.license.tokenTtlDays,
    grace_days: config.license.graceDays,
    active_kid: keys.getSigningKey().kid,
  });
});

// ---- Called by the customer's software -------------------------------------

router.post('/activate', (req, res) => {
  const { license_key: licenseKey, fingerprint, hostname, os, app_version: appVersion, sku } = req.body || {};
  send(res, () => lic.activate({ licenseKey, fingerprint, hostname, os, appVersion, sku }, { ip: req.ip }));
});

router.post('/refresh', (req, res) => {
  const { license_key: licenseKey, fingerprint } = req.body || {};
  send(res, () => lic.refresh({ licenseKey, fingerprint }, { ip: req.ip }));
});

router.post('/deactivate', (req, res) => {
  const { license_key: licenseKey, fingerprint } = req.body || {};
  send(res, () => lic.deactivate({ licenseKey, fingerprint }, { ip: req.ip }));
});

/** Convenience only — the same check runs offline inside the client SDK. */
router.post('/verify', async (req, res) => {
  const { token, sku } = req.body || {};
  try {
    const payload = await lic.verifyToken(token, { sku });
    res.json({ valid: true, payload });
  } catch (err) {
    res.json({ valid: false, reason: err.message });
  }
});

// ---- Server-to-server -------------------------------------------------------

router.post('/licenses', requireApiKey, (req, res) => {
  send(res, () => lic.issueLicense(req.body || {}, { actor: 'api', ip: req.ip }));
});

router.get('/licenses/:id', requireApiKey, (req, res) => {
  const license = lic.getLicense(req.params.id) || lic.getLicenseByKey(req.params.id);
  if (!license) return res.status(404).json({ error: 'not_found' });
  res.json(lic.hydrate(license));
});

router.patch('/licenses/:id', requireApiKey, (req, res) => {
  send(res, () => lic.updateLicense(req.params.id, req.body || {}, { actor: 'api', ip: req.ip }));
});

router.post('/licenses/:id/renew', requireApiKey, (req, res) => {
  const { termMonths = 12, endsAt } = req.body || {};
  send(res, () => (endsAt
    ? lic.updateLicense(req.params.id, { endsAt, status: 'active', reason: 'renewal' }, { actor: 'api', ip: req.ip })
    : lic.renewLicense(req.params.id, Number(termMonths), { actor: 'api', ip: req.ip })));
});

router.post('/licenses/:id/revoke', requireApiKey, (req, res) => {
  send(res, () => lic.revokeLicense(req.params.id, (req.body || {}).reason, { actor: 'api', ip: req.ip }));
});

router.post('/licenses/:id/reinstate', requireApiKey, (req, res) => {
  send(res, () => lic.reinstateLicense(req.params.id, { actor: 'api', ip: req.ip }));
});

router.get('/licenses', requireApiKey, (req, res) => {
  const rows = db.prepare(`SELECT * FROM licenses ORDER BY created_at DESC LIMIT 200`).all();
  res.json(rows.map(lic.hydrate));
});

module.exports = router;
