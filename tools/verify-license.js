#!/usr/bin/env node
'use strict';

/**
 * Offline license verification — this is the code that ships inside YOUR software.
 *
 * Note what it does not do: it does not call the license server, it does not
 * need a database, and it has zero npm dependencies. It needs the token and the
 * public key, both of which are on the customer's machine. That is the whole
 * point of the design — the licensing check cannot be broken by your server
 * being down, by a customer's firewall, or by an air-gapped install.
 *
 * Usage:
 *   node tools/verify-license.js --token <jwt> --key public-key.pem [--sku ATLAS-DESKTOP]
 *   node tools/verify-license.js --token-file license.jwt --key public-key.pem
 */

const fs = require('fs');
const crypto = require('crypto');

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

/**
 * Verifies an Ed25519-signed license token.
 * Returns { valid, reason, entitlements }.
 */
function verifyLicense(token, publicKeyPem, { expectedSku, expectedIssuer, now = new Date() } = {}) {
  const parts = String(token).trim().split('.');
  if (parts.length !== 3) return { valid: false, reason: 'malformed_token' };

  const [headerB64, payloadB64, signatureB64] = parts;
  let header;
  let payload;
  try {
    header = JSON.parse(Buffer.from(headerB64, 'base64url').toString('utf8'));
    payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  } catch {
    return { valid: false, reason: 'malformed_token' };
  }
  if (header.alg !== 'EdDSA') return { valid: false, reason: 'unexpected_algorithm' };

  const publicKey = crypto.createPublicKey(publicKeyPem);
  const signed = Buffer.from(`${headerB64}.${payloadB64}`);
  const signature = Buffer.from(signatureB64, 'base64url');
  if (!crypto.verify(null, signed, publicKey, signature)) {
    return { valid: false, reason: 'bad_signature' };
  }

  const nowSec = Math.floor(now.getTime() / 1000);
  if (payload.exp && nowSec > payload.exp) {
    // The token is stale, not the subscription. Try to refresh; keep running
    // until the subscription's own end date plus grace.
    const hardStop = subscriptionHardStop(payload);
    if (now <= hardStop) {
      return { valid: true, stale: true, reason: 'token_stale_refresh_when_online', entitlements: entitlements(payload), hardStop };
    }
    return { valid: false, reason: 'expired' };
  }
  if (payload.nbf && nowSec + 120 < payload.nbf) return { valid: false, reason: 'not_yet_valid' };
  if (expectedSku && payload.aud !== expectedSku) return { valid: false, reason: 'wrong_product' };
  if (expectedIssuer && payload.iss !== expectedIssuer) return { valid: false, reason: 'wrong_issuer' };
  if (payload.lic && ['revoked', 'suspended'].includes(payload.lic.status)) {
    return { valid: false, reason: payload.lic.status };
  }
  if (now > subscriptionHardStop(payload)) return { valid: false, reason: 'subscription_ended' };

  return { valid: true, stale: false, entitlements: entitlements(payload), hardStop: subscriptionHardStop(payload) };
}

function subscriptionHardStop(payload) {
  const lic = payload.lic || {};
  const ends = new Date(lic.ends_at || 0);
  return new Date(ends.getTime() + (lic.grace_days || 0) * 86400000);
}

function entitlements(payload) {
  const lic = payload.lic || {};
  return {
    licenseKey: lic.key,
    sku: lic.sku,
    edition: lic.edition,
    seats: lic.seats,
    modules: lic.modules || [],
    features: lic.features || {},
    endsAt: lic.ends_at,
    customer: payload.cust ? payload.cust.name : null,
    device: payload.dev || null,
    refreshAfter: payload.refresh_after,
  };
}

module.exports = { verifyLicense };

if (require.main === module) {
  const token = arg('token') || (arg('token-file') ? fs.readFileSync(arg('token-file'), 'utf8') : null);
  const keyPath = arg('key');
  if (!token || !keyPath) {
    console.error('Usage: node tools/verify-license.js --token <jwt> --key <public-key.pem> [--sku SKU]');
    process.exit(2);
  }
  const result = verifyLicense(token, fs.readFileSync(keyPath, 'utf8'), { expectedSku: arg('sku') });

  if (!result.valid) {
    console.log(`LICENSE INVALID — ${result.reason}`);
    process.exit(1);
  }
  const e = result.entitlements;
  console.log('LICENSE VALID' + (result.stale ? '  (token stale — refresh when online)' : ''));
  console.log(`  customer   : ${e.customer}`);
  console.log(`  product    : ${e.sku} / ${e.edition}`);
  console.log(`  seats      : ${e.seats}`);
  console.log(`  modules    : ${e.modules.join(', ') || '(none)'}`);
  console.log(`  ends       : ${e.endsAt}`);
  console.log(`  hard stop  : ${result.hardStop.toISOString()} (includes grace period)`);
  console.log('  features   :');
  for (const [k, v] of Object.entries(e.features)) {
    console.log(`     ${k.padEnd(20)} ${JSON.stringify(v)}`);
  }
}
