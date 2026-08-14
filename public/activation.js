import { api, el, date, dateTime, mountNav, toast } from '/app.js';

await mountNav('/activation.html');

const left = document.getElementById('left');
const right = document.getElementById('right');

const STORE = 'atlas-activation-demo';
const state = JSON.parse(localStorage.getItem(STORE) || 'null') || {
  licenseKey: new URLSearchParams(location.search).get('key') || '',
  fingerprint: 'demo-' + Math.random().toString(36).slice(2, 12),
  hostname: 'WS-' + Math.random().toString(36).slice(2, 7).toUpperCase(),
  token: null,
  fetchedAt: null,
};
if (new URLSearchParams(location.search).get('key')) state.licenseKey = new URLSearchParams(location.search).get('key');

function save() {
  localStorage.setItem(STORE, JSON.stringify(state));
}

// ---------------------------------------------------------------------------
// Offline verification — exactly what ships inside the customer's application.
// Nothing here touches the network except the one-time public key fetch, which
// in a real app is compiled into the binary.
// ---------------------------------------------------------------------------

let publicKeys = null;

async function loadKeys() {
  if (publicKeys) return publicKeys;
  const jwks = await api.get('/.well-known/license-jwks.json');
  publicKeys = {};
  for (const jwk of jwks.keys) {
    try {
      publicKeys[jwk.kid] = await crypto.subtle.importKey('jwk', { ...jwk, ext: true }, { name: 'Ed25519' }, true, ['verify']);
    } catch {
      publicKeys[jwk.kid] = null; // browser without Ed25519 in WebCrypto
    }
  }
  return publicKeys;
}

function b64urlToBytes(s) {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

function decode(token) {
  const [h, p] = token.split('.');
  return {
    header: JSON.parse(new TextDecoder().decode(b64urlToBytes(h))),
    payload: JSON.parse(new TextDecoder().decode(b64urlToBytes(p))),
  };
}

async function verifyLocally(token) {
  const [h, p, sig] = token.split('.');
  const { header, payload } = decode(token);
  const keys = await loadKeys();
  const key = keys[header.kid];

  let signatureOk = null; // null = this browser cannot check Ed25519
  if (key) {
    signatureOk = await crypto.subtle.verify(
      { name: 'Ed25519' },
      key,
      b64urlToBytes(sig),
      new TextEncoder().encode(`${h}.${p}`)
    );
  }

  const now = Date.now();
  const tokenExpired = payload.exp * 1000 < now;
  const hardStop = new Date(new Date(payload.lic.ends_at).getTime() + (payload.lic.grace_days || 0) * 86400000);
  const subscriptionOver = now > hardStop;
  const revoked = ['revoked', 'suspended'].includes(payload.lic.status);

  return {
    header,
    payload,
    signatureOk,
    tokenExpired,
    subscriptionOver,
    revoked,
    hardStop,
    verdict: signatureOk === false ? 'BAD SIGNATURE'
      : revoked ? 'REFUSED — ' + payload.lic.status
        : subscriptionOver ? 'REFUSED — subscription ended'
          : tokenExpired ? 'RUNNING — token stale, refresh when online'
            : 'RUNNING — fully valid',
  };
}

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------

function renderControls() {
  left.replaceChildren(
    el('div', { class: 'card stack' },
      el('h2', { style: 'margin:0' }, 'The customer’s machine'),
      el('label', { class: 'field' }, el('span', {}, 'License key'),
        el('input', { type: 'text', value: state.licenseKey, placeholder: 'ATLS-XXXXX-XXXXX-XXXXX-XXXXX',
          oninput: (e) => { state.licenseKey = e.target.value.trim().toUpperCase(); save(); } })),
      el('div', { class: 'grid cols-2' },
        el('label', { class: 'field' }, el('span', {}, 'Machine name'),
          el('input', { type: 'text', value: state.hostname, oninput: (e) => { state.hostname = e.target.value; save(); } })),
        el('label', { class: 'field' }, el('span', {}, 'Hardware fingerprint'),
          el('input', { type: 'text', value: state.fingerprint, class: 'mono',
            oninput: (e) => { state.fingerprint = e.target.value; save(); } }))),
      el('div', { class: 'small muted' },
        'Change the fingerprint and activate again to simulate a second machine — that is how the seat limit gets tested.'),
      el('div', { class: 'row' },
        el('button', { class: 'primary', onclick: () => call('activate') }, 'Activate'),
        el('button', { onclick: () => call('refresh') }, 'Refresh token'),
        el('button', { class: 'danger', onclick: () => call('deactivate') }, 'Deactivate'))),

    el('div', { class: 'card stack' },
      el('h3', {}, 'What your application actually ships'),
      el('p', { class: 'small muted', style: 'margin:0' },
        'One HTTP call at activation, then a signature check on every start. The check needs no server.'),
      el('pre', { class: 'code' },
`// once, when the user enters their key
POST /api/v1/activate
  { license_key, fingerprint, hostname, os, app_version }
  -> { token, expires_at, refresh_after }

// on every application start — offline, no network
const ok = verifyEd25519(token, EMBEDDED_PUBLIC_KEY);
if (ok && now < token.lic.ends_at + grace) start();

// in the background, whenever the network happens to be there
POST /api/v1/refresh -> a fresh token`))
  );
}

async function call(action) {
  if (!state.licenseKey) return toast('Enter a license key first.', 'warn');
  try {
    const body = { license_key: state.licenseKey, fingerprint: state.fingerprint };
    if (action === 'activate') Object.assign(body, { hostname: state.hostname, os: navigator.platform || 'demo', app_version: '4.2.1' });
    const res = await api.send(`/api/v1/${action}`, body);
    if (action === 'deactivate') {
      state.token = null;
      state.fetchedAt = null;
      toast('Deactivated. The seat is free and this machine will refuse to start.', 'info');
    } else {
      state.token = res.token;
      state.fetchedAt = new Date().toISOString();
      toast(action === 'activate' ? 'Activated — signed license token received.' : 'Token refreshed.', 'good');
    }
    save();
    await renderStatus();
  } catch (err) {
    toast(err.message, 'bad');
  }
}

async function renderStatus() {
  if (!state.token) {
    right.replaceChildren(el('div', { class: 'card' },
      el('h3', {}, 'License state on this machine'),
      el('p', { class: 'muted', style: 'margin:0' }, 'No token stored. The application would refuse to start.')));
    return;
  }

  const v = await verifyLocally(state.token);
  const lic = v.payload.lic;
  const good = v.verdict.startsWith('RUNNING');

  right.replaceChildren(
    el('div', { class: 'card stack' },
      el('div', { class: 'spread' },
        el('h2', { style: 'margin:0' }, 'Local verification'),
        el('span', { class: `badge ${good ? 'good' : 'bad'}` }, v.verdict)),
      el('table', {}, el('tbody', {},
        row('Signature', v.signatureOk === null
          ? 'this browser has no Ed25519 in WebCrypto — the shipped SDK does'
          : v.signatureOk ? 'verified locally against the published public key' : 'INVALID'),
        row('Signed by key', v.header.kid),
        row('Token expires', dateTime(new Date(v.payload.exp * 1000).toISOString()) + (v.tokenExpired ? '  (stale)' : '')),
        row('Subscription ends', date(lic.ends_at)),
        row('Hard stop (incl. grace)', date(v.hardStop.toISOString())),
        row('Fetched', dateTime(state.fetchedAt)))),
      el('div', { class: 'small muted' },
        'Disconnect your network and reload this page: the verdict above does not change, because nothing here calls the server.')),

    el('div', { class: 'card stack' },
      el('h3', {}, 'Entitlements the app reads'),
      el('table', {}, el('tbody', {},
        row('Customer', v.payload.cust ? v.payload.cust.name : '—'),
        row('Product', `${lic.sku} / ${lic.edition || '—'}`),
        row('Seats', lic.seats),
        row('Modules', lic.modules.join(', ') || '—'),
        row('Status', lic.status))),
      el('pre', { class: 'code' }, JSON.stringify(lic.features, null, 2))),

    el('div', { class: 'card stack' },
      el('h3', {}, 'The raw token'),
      el('pre', { class: 'code', style: 'white-space:pre-wrap;word-break:break-all' }, state.token))
  );
}

function row(k, v) {
  return el('tr', {}, el('td', { class: 'muted', style: 'width:42%' }, k), el('td', { class: 'mono small' }, String(v)));
}

renderControls();
await renderStatus();
