'use strict';

/**
 * End-to-end check of the whole path: sign in -> configure -> price -> quote ->
 * checkout -> license issued -> activate -> verify offline -> seat limit ->
 * upgrade -> renew -> revoke -> refuse.
 *
 * Run against a live server:  node scripts/e2e.js http://127.0.0.1:3000
 */

const assert = require('assert');
const { verifyLicense } = require('../tools/verify-license');

const BASE = process.argv[2] || 'http://127.0.0.1:3000';
let cookie = '';
const results = [];

async function req(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual',
  });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: res.status, body: json, text };
}

function check(name, fn) {
  return (async () => {
    try {
      await fn();
      results.push({ name, ok: true });
      console.log(`  PASS  ${name}`);
    } catch (err) {
      results.push({ name, ok: false, error: err.message });
      console.log(`  FAIL  ${name}\n        ${err.message}`);
    }
  })();
}

(async () => {
  console.log(`\nEnd-to-end run against ${BASE}\n`);

  // --- Authentication ------------------------------------------------------
  await check('anonymous cannot create a quote', async () => {
    const res = await req('POST', '/api/quotes', { sku: 'ATLAS-DESKTOP', config: {} });
    assert.strictEqual(res.status, 401, `expected 401, got ${res.status}`);
  });

  await check('anonymous can still see public pricing', async () => {
    const res = await req('POST', '/api/products/ATLAS-DESKTOP/price', { config: { edition: 'professional', seats: 5 } });
    assert.strictEqual(res.status, 200);
    assert.ok(res.body.pricing.total_cents > 0);
  });

  await check('demo sign-in creates a session with the mapped role', async () => {
    const res = await req('POST', '/auth/demo', { persona: 'customer' });
    assert.strictEqual(res.body.user.role, 'customer', JSON.stringify(res.body));
  });

  await check('a customer cannot apply a sales discount', async () => {
    const res = await req('POST', '/api/products/ATLAS-DESKTOP/price', {
      config: { edition: 'professional', seats: 10 },
      discountPct: 50,
    });
    assert.strictEqual(res.body.discount_allowed, false);
    assert.strictEqual(res.body.pricing.effective_discount_pct > 0, true, 'volume discount should still apply');
    const noManualLine = !res.body.pricing.lines.some((l) => l.id === 'manual');
    assert.ok(noManualLine, 'manual discount line must not be present for a customer');
  });

  await check('a customer cannot reach the admin API', async () => {
    const res = await req('GET', '/api/admin/licenses');
    assert.strictEqual(res.status, 403, `expected 403, got ${res.status}`);
  });

  // --- CPQ rules -----------------------------------------------------------
  await check('CPQ rejects a module that needs a higher edition', async () => {
    const res = await req('POST', '/api/products/ATLAS-DESKTOP/price', {
      config: { edition: 'standard', seats: 5, modules: ['cam'] },
    });
    assert.strictEqual(res.body.valid, false);
    assert.match(res.body.errors[0].message, /Professional or Enterprise/);
  });

  await check('CPQ blocks that choice in the UI with a reason', async () => {
    const res = await req('POST', '/api/products/ATLAS-DESKTOP/price', { config: { edition: 'standard', seats: 5 } });
    assert.ok(res.body.blocked['modules:cam'], 'expected modules:cam to be blocked');
  });

  await check('quote creation is refused for an invalid configuration', async () => {
    const res = await req('POST', '/api/quotes', { sku: 'ATLAS-DESKTOP', config: { edition: 'standard', seats: 5, modules: ['cam'] } });
    assert.strictEqual(res.status, 422);
  });

  await check('volume tier changes the price at the right seat count', async () => {
    const nine = await req('POST', '/api/products/ATLAS-DESKTOP/price', { config: { edition: 'professional', seats: 9 } });
    const ten = await req('POST', '/api/products/ATLAS-DESKTOP/price', { config: { edition: 'professional', seats: 10 } });
    assert.strictEqual(nine.body.pricing.volume_tier.discount_pct, 0);
    assert.strictEqual(ten.body.pricing.volume_tier.discount_pct, 5);
    const perSeat9 = nine.body.pricing.total_cents / 9;
    const perSeat10 = ten.body.pricing.total_cents / 10;
    assert.ok(perSeat10 < perSeat9, 'per-seat price must fall when the volume tier kicks in');
  });

  await check('3-year term applies the prepay discount and a longer license', async () => {
    const res = await req('POST', '/api/products/ATLAS-DESKTOP/price', {
      config: { edition: 'professional', seats: 5, term: '36' },
    });
    assert.strictEqual(res.body.pricing.term_months, 36);
    assert.ok(res.body.pricing.lines.some((l) => l.id === 'term' && l.amount_cents < 0));
    assert.strictEqual(res.body.license_preview.termMonths, 36);
  });

  // --- Purchase ------------------------------------------------------------
  let quote;
  let license;

  await check('a valid configuration becomes a quote', async () => {
    const res = await req('POST', '/api/quotes', {
      sku: 'ATLAS-DESKTOP',
      config: { edition: 'professional', seats: 2, modules: ['api'], term: '12', support: 'plus' },
    });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    quote = res.body;
    assert.match(quote.number, /^Q-\d{4}-\d{5}$/);
    assert.strictEqual(quote.status, 'draft');
  });

  await check('checkout issues a license automatically', async () => {
    const checkout = await req('POST', '/api/checkout', { quoteId: quote.id });
    assert.strictEqual(checkout.status, 200, JSON.stringify(checkout.body));
    const orderId = checkout.body.order.id;
    const confirm = await req('POST', '/api/checkout/confirm', { orderId });
    assert.strictEqual(confirm.status, 200, JSON.stringify(confirm.body));
    license = confirm.body.license;
    assert.ok(license, 'no license came back from checkout');
    assert.strictEqual(license.seats, 2);
    assert.deepStrictEqual(license.modules, ['api']);
    assert.match(license.license_key, /^ATLS(-[A-Z2-9]{5}){4}$/);
  });

  await check('paying the same order twice does not issue a second license', async () => {
    assert.strictEqual((await req('GET', `/api/quotes/${quote.id}`)).body.status, 'ordered');
    const before = (await req('GET', '/api/my/licenses')).body.length;
    const sub = (await req('GET', '/api/my/subscriptions')).body.find((x) => x.license && x.license.id === license.id);
    const again = await req('POST', '/api/checkout/confirm', { orderId: sub.order_id });
    assert.strictEqual(again.body.alreadyProcessed, true, 'second confirm should be a no-op');
    const after = (await req('GET', '/api/my/licenses')).body.length;
    assert.strictEqual(after, before, 'license count must not change');
  });

  // --- Activation ----------------------------------------------------------
  let token;

  await check('activation returns a signed token', async () => {
    const res = await req('POST', '/api/v1/activate', {
      license_key: license.license_key,
      fingerprint: 'machine-A',
      hostname: 'WS-A',
      os: 'Windows 11',
      app_version: '4.2.1',
    });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    token = res.body.token;
    assert.ok(token.split('.').length === 3);
  });

  await check('the token verifies offline against the published public key', async () => {
    const pem = await (await fetch(BASE + '/api/v1/public-key.pem')).text();
    const result = verifyLicense(token, pem, { expectedSku: 'ATLAS-DESKTOP' });
    assert.strictEqual(result.valid, true, result.reason);
    assert.strictEqual(result.entitlements.seats, 2);
    assert.strictEqual(result.entitlements.features.simulation, true);
    assert.strictEqual(result.entitlements.features.api, true);
  });

  await check('a tampered token is rejected', async () => {
    const pem = await (await fetch(BASE + '/api/v1/public-key.pem')).text();
    const [h, p, sig] = token.split('.');
    const payload = JSON.parse(Buffer.from(p, 'base64url').toString());
    payload.lic.seats = 9999;
    payload.lic.edition = 'enterprise';
    const forged = `${h}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${sig}`;
    const result = verifyLicense(forged, pem, {});
    assert.strictEqual(result.valid, false);
    assert.strictEqual(result.reason, 'bad_signature');
  });

  await check('second machine fits inside the 2 seats', async () => {
    const res = await req('POST', '/api/v1/activate', { license_key: license.license_key, fingerprint: 'machine-B', hostname: 'WS-B' });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  });

  await check('third machine is refused — seat limit enforced', async () => {
    const res = await req('POST', '/api/v1/activate', { license_key: license.license_key, fingerprint: 'machine-C' });
    assert.strictEqual(res.status, 409);
    assert.strictEqual(res.body.error, 'seat_limit_reached');
  });

  await check('re-activating an existing machine is not a new seat', async () => {
    const res = await req('POST', '/api/v1/activate', { license_key: license.license_key, fingerprint: 'machine-A' });
    assert.strictEqual(res.status, 200);
  });

  await check('deactivating frees the seat for a new machine', async () => {
    const off = await req('POST', '/api/v1/deactivate', { license_key: license.license_key, fingerprint: 'machine-B' });
    assert.strictEqual(off.status, 200);
    const on = await req('POST', '/api/v1/activate', { license_key: license.license_key, fingerprint: 'machine-C' });
    assert.strictEqual(on.status, 200, JSON.stringify(on.body));
    await req('POST', '/api/v1/deactivate', { license_key: license.license_key, fingerprint: 'machine-C' });
  });

  await check('an unknown key is refused', async () => {
    const res = await req('POST', '/api/v1/activate', { license_key: 'ATLS-AAAAA-AAAAA-AAAAA-AAAAA', fingerprint: 'x' });
    assert.strictEqual(res.status, 404);
  });

  // --- Mid-term change -----------------------------------------------------
  await check('adding seats mid-term updates the license in place', async () => {
    const subs = (await req('GET', '/api/my/subscriptions')).body;
    const sub = subs.find((x) => x.license && x.license.id === license.id);
    const res = await req('POST', `/api/my/subscriptions/${sub.id}/change`, {
      config: { edition: 'professional', seats: 6, modules: ['api'], term: '12', support: 'plus' },
    });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.subscription.license.seats, 6);
    assert.ok(res.body.prorationCents > 0, 'an upgrade should charge a prorated amount');
  });

  await check('the refreshed token carries the new seat count', async () => {
    const res = await req('POST', '/api/v1/refresh', { license_key: license.license_key, fingerprint: 'machine-A' });
    const pem = await (await fetch(BASE + '/api/v1/public-key.pem')).text();
    const result = verifyLicense(res.body.token, pem, {});
    assert.strictEqual(result.entitlements.seats, 6);
  });

  // --- Admin ---------------------------------------------------------------
  await check('admin persona gets the admin role', async () => {
    const res = await req('POST', '/auth/demo', { persona: 'admin' });
    assert.strictEqual(res.body.user.role, 'admin');
  });

  await check('every bridge job completed', async () => {
    const res = await req('GET', '/api/admin/jobs');
    const failed = res.body.jobs.filter((j) => j.status !== 'done');
    assert.strictEqual(failed.length, 0, 'unfinished jobs: ' + JSON.stringify(failed.map((j) => [j.kind, j.status, j.last_error])));
  });

  await check('renewing moves the end date forward a full term', async () => {
    const subs = (await req('GET', '/api/admin/subscriptions')).body;
    const sub = subs.find((x) => x.license && x.license.id === license.id);
    const before = new Date(sub.license.ends_at);
    const res = await req('POST', `/api/admin/subscriptions/${sub.id}/renew-now`);
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    const after = new Date(res.body.license.ends_at);
    const months = Math.round((after - before) / (30.44 * 86400000));
    assert.strictEqual(months, 12, `end date moved ${months} months, expected 12`);
  });

  await check('revoking stops activation immediately', async () => {
    const res = await req('POST', `/api/admin/licenses/${license.id}/revoke`, { reason: 'e2e-test' });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    const act = await req('POST', '/api/v1/activate', { license_key: license.license_key, fingerprint: 'machine-D' });
    assert.strictEqual(act.status, 403);
    assert.strictEqual(act.body.error, 'revoked');
    const refresh = await req('POST', '/api/v1/refresh', { license_key: license.license_key, fingerprint: 'machine-A' });
    assert.strictEqual(refresh.status, 403);
  });

  await check('the revocation window is bounded by a short token TTL', async () => {
    const pem = await (await fetch(BASE + '/api/v1/public-key.pem')).text();
    // Mint a token the way the app already holds one, then revoke behind its back.
    const result = verifyLicense(token, pem, {});
    // The old token was signed while active, so the signature is fine and the
    // app keeps running until the token expires — which is exactly why the TTL
    // is short. Prove the window is bounded rather than unlimited.
    assert.strictEqual(result.valid, true);
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
    const ttlDays = (payload.exp - payload.iat) / 86400;
    assert.ok(ttlDays <= 31, `token TTL is ${ttlDays} days — revocation window too wide`);
  });

  await check('reinstating brings the license back', async () => {
    const res = await req('POST', `/api/admin/licenses/${license.id}/reinstate`);
    assert.strictEqual(res.status, 200);
    const act = await req('POST', '/api/v1/activate', { license_key: license.license_key, fingerprint: 'machine-A' });
    assert.strictEqual(act.status, 200, JSON.stringify(act.body));
  });

  await check('the S2S license API rejects a missing Api-Token', async () => {
    const res = await fetch(BASE + '/api/v1/licenses', { headers: { Accept: 'application/json' } });
    assert.strictEqual(res.status, 401);
  });

  await check('the S2S license API accepts a valid Api-Token', async () => {
    const res = await fetch(BASE + '/api/v1/licenses', { headers: { 'Api-Token': 'demo-shop-key' } });
    assert.strictEqual(res.status, 200);
    const list = await res.json();
    assert.ok(Array.isArray(list) && list.length > 0);
  });

  await check('sales approval gate holds a big discount', async () => {
    await req('POST', '/auth/demo', { persona: 'sales' });
    const q = await req('POST', '/api/quotes', {
      sku: 'ATLAS-DESKTOP',
      config: { edition: 'professional', seats: 4 },
      discountPct: 35,
    });
    assert.strictEqual(q.body.status, 'pending_approval');
    const checkout = await req('POST', '/api/checkout', { quoteId: q.body.id });
    assert.strictEqual(checkout.status, 400, 'checkout must be blocked before approval');
    const approve = await req('POST', `/api/quotes/${q.body.id}/approve`, { approve: true });
    assert.strictEqual(approve.body.status, 'approved');
    const checkout2 = await req('POST', '/api/checkout', { quoteId: q.body.id });
    assert.strictEqual(checkout2.status, 200, 'checkout must work after approval');
  });

  await check('audit trail recorded the licensing actions', async () => {
    await req('POST', '/auth/demo', { persona: 'admin' });
    const res = await req('GET', `/api/admin/audit?entityId=${license.id}`);
    const actions = res.body.map((e) => e.action);
    for (const expected of ['license.issued', 'license.activated', 'license.revoked', 'license.reinstated']) {
      assert.ok(actions.includes(expected), `missing audit entry ${expected} (got ${actions.join(', ')})`);
    }
  });

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed\n`);
  if (failed.length) process.exit(1);
})();
