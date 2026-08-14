'use strict';

/**
 * The license server.
 *
 * Design in one paragraph: a license is a database row (the source of truth)
 * plus a short-lived Ed25519-signed JWT (the thing the customer's software
 * actually reads). The token carries the real subscription end date, so an app
 * that cannot reach the network keeps working until the subscription genuinely
 * ends. The token itself expires in days, so a revoked or downgraded license
 * stops working quickly without the app ever needing to be online at the exact
 * moment of the change. Nothing in the token can be forged: verification needs
 * only the public key, and only this server holds the private one.
 */

const crypto = require('crypto');
const { SignJWT, jwtVerify } = require('jose');
const { db, nowIso, audit } = require('./db');
const keys = require('./keys');
const config = require('./config');

const KEY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I, O, 0, 1 — dictated over the phone without pain

function generateLicenseKey(prefix = 'LIC') {
  const groups = [];
  for (let g = 0; g < 4; g += 1) {
    let s = '';
    for (let i = 0; i < 5; i += 1) {
      s += KEY_ALPHABET[crypto.randomInt(KEY_ALPHABET.length)];
    }
    groups.push(s);
  }
  return `${prefix}-${groups.join('-')}`;
}

function addMonths(date, months) {
  const d = new Date(date.getTime());
  const day = d.getUTCDate();
  d.setUTCMonth(d.getUTCMonth() + months);
  // Clamp for month-length differences (31 Jan + 1 month -> 28/29 Feb).
  if (d.getUTCDate() < day) d.setUTCDate(0);
  return d;
}

function addDays(date, days) {
  return new Date(date.getTime() + days * 86400000);
}

/** Effective status, taking expiry into account without needing a cron job. */
function effectiveStatus(license, at = new Date()) {
  if (license.status === 'revoked') return 'revoked';
  if (license.status === 'suspended') return 'suspended';
  const hardStop = addDays(new Date(license.ends_at), config.license.graceDays);
  if (at > hardStop) return 'expired';
  return 'active';
}

function getLicenseByKey(licenseKey) {
  return db.prepare(`SELECT * FROM licenses WHERE license_key = ?`).get(String(licenseKey || '').trim().toUpperCase());
}

function getLicense(id) {
  return db.prepare(`SELECT * FROM licenses WHERE id = ?`).get(id);
}

function hydrate(license) {
  if (!license) return null;
  const activations = db
    .prepare(`SELECT * FROM activations WHERE license_id = ? ORDER BY activated_at DESC`)
    .all(license.id);
  return {
    ...license,
    modules: JSON.parse(license.modules_json),
    features: JSON.parse(license.features_json),
    effective_status: effectiveStatus(license),
    seats_used: activations.filter((a) => a.status === 'active').length,
    activations,
  };
}

// ---------------------------------------------------------------------------
// Lifecycle: issue / update / renew / revoke
// ---------------------------------------------------------------------------

function issueLicense(input, ctx = {}) {
  const {
    accountId,
    subscriptionId = null,
    sku,
    edition = null,
    seats = 1,
    modules = [],
    features = {},
    startsAt = new Date(),
    termMonths = 12,
    endsAt,
  } = input;

  if (!accountId) throw new Error('accountId is required');
  if (!sku) throw new Error('sku is required');

  const start = new Date(startsAt);
  const end = endsAt ? new Date(endsAt) : addMonths(start, termMonths);
  const id = 'lic_' + crypto.randomUUID().replace(/-/g, '').slice(0, 20);
  const licenseKey = generateLicenseKey(input.keyPrefix || sku.split('-')[0].slice(0, 4).toUpperCase());
  const ts = nowIso();

  db.prepare(
    `INSERT INTO licenses
      (id, license_key, account_id, subscription_id, sku, edition, seats, modules_json, features_json,
       status, starts_at, ends_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`
  ).run(
    id, licenseKey, accountId, subscriptionId, sku, edition, seats,
    JSON.stringify(modules), JSON.stringify(features),
    start.toISOString(), end.toISOString(), ts, ts
  );

  audit({
    actor: ctx.actor || 'system',
    action: 'license.issued',
    entityType: 'license',
    entityId: id,
    detail: { sku, edition, seats, modules, ends_at: end.toISOString() },
    ip: ctx.ip,
  });

  return hydrate(getLicense(id));
}

/**
 * Applies a change to an existing license (upgrade, seat change, module change,
 * new end date). Used for renewals and mid-term upgrades alike — the customer's
 * app picks the change up on its next token refresh, no reinstall.
 */
function updateLicense(licenseId, changes, ctx = {}) {
  const license = getLicense(licenseId);
  if (!license) throw new Error('license not found');

  const next = {
    edition: changes.edition !== undefined ? changes.edition : license.edition,
    seats: changes.seats !== undefined ? Number(changes.seats) : license.seats,
    modules: changes.modules !== undefined ? changes.modules : JSON.parse(license.modules_json),
    features: changes.features !== undefined ? changes.features : JSON.parse(license.features_json),
    ends_at: changes.endsAt ? new Date(changes.endsAt).toISOString() : license.ends_at,
    status: changes.status || license.status,
  };

  if (next.seats < 1) throw new Error('seats must be at least 1');

  db.prepare(
    `UPDATE licenses SET edition = ?, seats = ?, modules_json = ?, features_json = ?,
      ends_at = ?, status = ?, updated_at = ? WHERE id = ?`
  ).run(
    next.edition, next.seats, JSON.stringify(next.modules), JSON.stringify(next.features),
    next.ends_at, next.status, nowIso(), licenseId
  );

  // If seats were reduced, release the most recently activated machines so the
  // license is never left over its own limit.
  if (next.seats < license.seats) {
    const active = db
      .prepare(`SELECT * FROM activations WHERE license_id = ? AND status = 'active' ORDER BY activated_at DESC`)
      .all(licenseId);
    const excess = active.slice(0, Math.max(0, active.length - next.seats));
    for (const a of excess) {
      db.prepare(`UPDATE activations SET status = 'deactivated', deactivated_at = ? WHERE id = ?`).run(nowIso(), a.id);
      audit({
        actor: ctx.actor || 'system',
        action: 'activation.released_on_downgrade',
        entityType: 'activation',
        entityId: a.id,
        detail: { license_id: licenseId, fingerprint: a.fingerprint },
      });
    }
  }

  audit({
    actor: ctx.actor || 'system',
    action: changes.reason === 'renewal' ? 'license.renewed' : 'license.updated',
    entityType: 'license',
    entityId: licenseId,
    detail: { from: { edition: license.edition, seats: license.seats, ends_at: license.ends_at }, to: next },
    ip: ctx.ip,
  });

  return hydrate(getLicense(licenseId));
}

function renewLicense(licenseId, termMonths, ctx = {}) {
  const license = getLicense(licenseId);
  if (!license) throw new Error('license not found');
  // Renew from the current end date if still in the future, otherwise from now,
  // so an early renewal never costs the customer days.
  const base = new Date(license.ends_at) > new Date() ? new Date(license.ends_at) : new Date();
  return updateLicense(licenseId, { endsAt: addMonths(base, termMonths), status: 'active', reason: 'renewal' }, ctx);
}

function revokeLicense(licenseId, reason, ctx = {}) {
  const license = getLicense(licenseId);
  if (!license) throw new Error('license not found');
  const ts = nowIso();
  db.prepare(`UPDATE licenses SET status = 'revoked', revoked_at = ?, revoke_reason = ?, updated_at = ? WHERE id = ?`)
    .run(ts, reason || null, ts, licenseId);
  db.prepare(`UPDATE activations SET status = 'deactivated', deactivated_at = ? WHERE license_id = ? AND status = 'active'`)
    .run(ts, licenseId);
  audit({
    actor: ctx.actor || 'system',
    action: 'license.revoked',
    entityType: 'license',
    entityId: licenseId,
    detail: { reason },
    ip: ctx.ip,
  });
  return hydrate(getLicense(licenseId));
}

function suspendLicense(licenseId, reason, ctx = {}) {
  db.prepare(`UPDATE licenses SET status = 'suspended', updated_at = ? WHERE id = ?`).run(nowIso(), licenseId);
  audit({ actor: ctx.actor || 'system', action: 'license.suspended', entityType: 'license', entityId: licenseId, detail: { reason } });
  return hydrate(getLicense(licenseId));
}

function reinstateLicense(licenseId, ctx = {}) {
  db.prepare(`UPDATE licenses SET status = 'active', revoked_at = NULL, revoke_reason = NULL, updated_at = ? WHERE id = ?`)
    .run(nowIso(), licenseId);
  audit({ actor: ctx.actor || 'system', action: 'license.reinstated', entityType: 'license', entityId: licenseId });
  return hydrate(getLicense(licenseId));
}

// ---------------------------------------------------------------------------
// Activation (what the customer's software calls)
// ---------------------------------------------------------------------------

function fingerprintHash(raw) {
  return crypto.createHash('sha256').update(String(raw)).digest('hex').slice(0, 32);
}

class LicenseError extends Error {
  constructor(code, message, httpStatus = 400) {
    super(message);
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

function activate({ licenseKey, fingerprint, hostname, os, appVersion, sku }, ctx = {}) {
  const license = getLicenseByKey(licenseKey);
  if (!license) throw new LicenseError('invalid_key', 'Unknown license key', 404);
  if (sku && license.sku !== sku) throw new LicenseError('wrong_product', 'This key belongs to a different product', 409);

  const status = effectiveStatus(license);
  if (status === 'revoked') throw new LicenseError('revoked', 'This license has been revoked', 403);
  if (status === 'suspended') throw new LicenseError('suspended', 'This license is suspended', 403);
  if (status === 'expired') throw new LicenseError('expired', 'This license has expired', 403);
  if (!fingerprint) throw new LicenseError('missing_fingerprint', 'A device fingerprint is required', 400);

  const fp = fingerprintHash(fingerprint);
  const existing = db.prepare(`SELECT * FROM activations WHERE license_id = ? AND fingerprint = ?`).get(license.id, fp);
  const ts = nowIso();

  if (existing) {
    db.prepare(`UPDATE activations SET status = 'active', last_seen_at = ?, deactivated_at = NULL,
                app_version = COALESCE(?, app_version), hostname = COALESCE(?, hostname) WHERE id = ?`)
      .run(ts, appVersion || null, hostname || null, existing.id);
  } else {
    const used = db
      .prepare(`SELECT COUNT(*) AS n FROM activations WHERE license_id = ? AND status = 'active'`)
      .get(license.id).n;
    if (used >= license.seats) {
      throw new LicenseError(
        'seat_limit_reached',
        `All ${license.seats} seat(s) on this license are in use. Deactivate a device or add seats.`,
        409
      );
    }
    db.prepare(
      `INSERT INTO activations (id, license_id, fingerprint, hostname, os, app_version, status, activated_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)`
    ).run('act_' + crypto.randomUUID().replace(/-/g, '').slice(0, 18), license.id, fp, hostname || null, os || null, appVersion || null, ts, ts);
  }

  audit({
    actor: ctx.actor || 'device',
    action: existing ? 'license.reactivated' : 'license.activated',
    entityType: 'license',
    entityId: license.id,
    detail: { fingerprint: fp, hostname, os, app_version: appVersion },
    ip: ctx.ip,
  });

  return mintToken(license, fp);
}

function refresh({ licenseKey, fingerprint }, ctx = {}) {
  const license = getLicenseByKey(licenseKey);
  if (!license) throw new LicenseError('invalid_key', 'Unknown license key', 404);
  const fp = fingerprintHash(fingerprint);
  const act = db.prepare(`SELECT * FROM activations WHERE license_id = ? AND fingerprint = ?`).get(license.id, fp);
  if (!act || act.status !== 'active') throw new LicenseError('not_activated', 'This device is not activated on the license', 403);

  const status = effectiveStatus(license);
  if (status !== 'active') throw new LicenseError(status, `License is ${status}`, 403);

  db.prepare(`UPDATE activations SET last_seen_at = ? WHERE id = ?`).run(nowIso(), act.id);
  return mintToken(license, fp);
}

function deactivate({ licenseKey, fingerprint }, ctx = {}) {
  const license = getLicenseByKey(licenseKey);
  if (!license) throw new LicenseError('invalid_key', 'Unknown license key', 404);
  const fp = fingerprintHash(fingerprint);
  const res = db
    .prepare(`UPDATE activations SET status = 'deactivated', deactivated_at = ? WHERE license_id = ? AND fingerprint = ? AND status = 'active'`)
    .run(nowIso(), license.id, fp);
  if (!res.changes) throw new LicenseError('not_activated', 'No active activation for this device', 404);
  audit({
    actor: ctx.actor || 'device',
    action: 'license.deactivated',
    entityType: 'license',
    entityId: license.id,
    detail: { fingerprint: fp },
    ip: ctx.ip,
  });
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Token minting and offline verification
// ---------------------------------------------------------------------------

async function mintToken(license, fingerprint) {
  const { kid, privateKey } = keys.getSigningKey();
  const account = db.prepare(`SELECT * FROM accounts WHERE id = ?`).get(license.account_id);
  const now = Math.floor(Date.now() / 1000);
  const exp = now + config.license.tokenTtlDays * 86400;

  const payload = {
    lic: {
      id: license.id,
      key: license.license_key,
      sku: license.sku,
      edition: license.edition,
      seats: license.seats,
      modules: JSON.parse(license.modules_json),
      features: JSON.parse(license.features_json),
      status: effectiveStatus(license),
      starts_at: license.starts_at,
      // The real subscription end. The app keeps running to this date even
      // if it never reaches the network again.
      ends_at: license.ends_at,
      grace_days: config.license.graceDays,
    },
    cust: account ? { id: account.id, name: account.name, tenant: account.azure_tenant_id || null } : null,
    dev: fingerprint || null,
    refresh_after: new Date((now + Math.floor(config.license.tokenTtlDays * 86400 * 0.5)) * 1000).toISOString(),
  };

  const token = await new SignJWT(payload)
    .setProtectedHeader({ alg: 'EdDSA', kid, typ: 'license+jwt' })
    .setIssuer(config.license.issuer)
    .setSubject(license.id)
    .setAudience(license.sku)
    .setIssuedAt(now)
    .setNotBefore(now - 60)
    .setExpirationTime(exp)
    .sign(privateKey);

  return {
    token,
    kid,
    expires_at: new Date(exp * 1000).toISOString(),
    refresh_after: payload.refresh_after,
    license: hydrate(license),
  };
}

/** Server-side verification helper. The same check runs offline in the client SDK. */
async function verifyToken(token, { sku } = {}) {
  const [headerB64] = String(token).split('.');
  let header;
  try {
    header = JSON.parse(Buffer.from(headerB64, 'base64url').toString('utf8'));
  } catch {
    throw new LicenseError('malformed', 'Token is not a valid JWT', 400);
  }
  const publicKey = keys.getPublicKey(header.kid);
  if (!publicKey) throw new LicenseError('unknown_key', 'Token was signed with an unknown key', 400);

  const { payload } = await jwtVerify(token, publicKey, {
    issuer: config.license.issuer,
    audience: sku || undefined,
  });
  return payload;
}

module.exports = {
  LicenseError,
  generateLicenseKey,
  addMonths,
  addDays,
  effectiveStatus,
  getLicense,
  getLicenseByKey,
  hydrate,
  issueLicense,
  updateLicense,
  renewLicense,
  revokeLicense,
  suspendLicense,
  reinstateLicense,
  activate,
  refresh,
  deactivate,
  mintToken,
  verifyToken,
  fingerprintHash,
};
