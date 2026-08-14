'use strict';

/**
 * Ed25519 signing keys for license tokens.
 *
 * The PRIVATE key never leaves this server and is never stored in the database.
 * Only the public key is published (JWKS + PEM), which is all a customer's
 * application needs to verify a license completely offline.
 *
 * Key rotation: `rotate()` mints a new key and marks the previous one retired.
 * Retired keys stay published so tokens already in the field keep verifying
 * until they expire (default 7 days), then they can be dropped.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { db, nowIso, audit } = require('./db');
const config = require('./config');

const KEY_DIR = config.license.keyDir;

function ensureDir() {
  fs.mkdirSync(KEY_DIR, { recursive: true, mode: 0o700 });
}

function privatePath(kid) {
  return path.join(KEY_DIR, `${kid}.private.pem`);
}

function generate() {
  ensureDir();
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const kid = 'lic-' + crypto.randomBytes(6).toString('hex');

  const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const publicPem = publicKey.export({ type: 'spki', format: 'pem' });
  const publicJwk = publicKey.export({ format: 'jwk' });
  publicJwk.kid = kid;
  publicJwk.alg = 'EdDSA';
  publicJwk.use = 'sig';

  fs.writeFileSync(privatePath(kid), privatePem, { mode: 0o600 });

  db.prepare(
    `INSERT INTO signing_keys (kid, public_jwk, public_pem, status, created_at)
     VALUES (?, ?, ?, 'active', ?)`
  ).run(kid, JSON.stringify(publicJwk), publicPem, nowIso());

  return { kid, publicJwk, publicPem };
}

function activeKeyRow() {
  return db.prepare(`SELECT * FROM signing_keys WHERE status = 'active' ORDER BY created_at DESC LIMIT 1`).get();
}

/** Returns { kid, privateKey (KeyObject), publicPem }. Creates a key on first use. */
function getSigningKey() {
  let row = activeKeyRow();
  if (!row) {
    generate();
    row = activeKeyRow();
  }
  const pem = fs.readFileSync(privatePath(row.kid), 'utf8');
  return {
    kid: row.kid,
    privateKey: crypto.createPrivateKey(pem),
    publicPem: row.public_pem,
    publicJwk: JSON.parse(row.public_jwk),
  };
}

function getPublicKey(kid) {
  const row = db.prepare(`SELECT * FROM signing_keys WHERE kid = ?`).get(kid);
  if (!row) return null;
  return crypto.createPublicKey(row.public_pem);
}

function jwks() {
  const rows = db.prepare(`SELECT public_jwk FROM signing_keys ORDER BY created_at DESC`).all();
  return { keys: rows.map((r) => JSON.parse(r.public_jwk)) };
}

function rotate(actor) {
  const previous = activeKeyRow();
  if (previous) {
    db.prepare(`UPDATE signing_keys SET status = 'retired', retired_at = ? WHERE kid = ?`).run(nowIso(), previous.kid);
  }
  const next = generate();
  audit({
    actor: actor || 'system',
    action: 'signing_key.rotated',
    entityType: 'signing_key',
    entityId: next.kid,
    detail: { previous: previous ? previous.kid : null },
  });
  return next;
}

module.exports = { getSigningKey, getPublicKey, jwks, rotate, generate };
