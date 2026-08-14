'use strict';

/**
 * Microsoft Entra ID (Azure AD) sign-in — authorization code flow with PKCE.
 *
 * There is no local password anywhere in this application. The only way a
 * session is created is by a successfully verified Azure AD id_token, or, when
 * DEMO_MODE is on, by the clearly-labelled demo stub below so the shop can be
 * clicked through before a tenant exists. Set the three AZURE_* variables and
 * DEMO_MODE=false and the stub is gone: /auth/demo returns 404.
 *
 * Roles come from Azure AD app roles (the `roles` claim), mapped through
 * AZURE_ROLE_MAP. Group-based mapping is supported too via the `groups` claim.
 */

const crypto = require('crypto');
const { createRemoteJWKSet, jwtVerify, decodeJwt } = require('jose');
const { db, nowIso, audit } = require('./db');
const config = require('./config');

let jwksCache = null;
let discoveryCache = null;

function tenantSegment() {
  return config.azure.tenantId || 'common';
}

async function discovery() {
  if (discoveryCache) return discoveryCache;
  const url = `${config.azure.authority}/${tenantSegment()}/v2.0/.well-known/openid-configuration`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Azure AD discovery failed (${res.status}) at ${url}`);
  discoveryCache = await res.json();
  return discoveryCache;
}

async function jwks() {
  if (!jwksCache) {
    const doc = await discovery();
    jwksCache = createRemoteJWKSet(new URL(doc.jwks_uri));
  }
  return jwksCache;
}

function base64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

async function buildAuthUrl(req, returnTo = '/') {
  const doc = await discovery();
  const state = base64url(crypto.randomBytes(24));
  const nonce = base64url(crypto.randomBytes(24));
  const verifier = base64url(crypto.randomBytes(48));
  const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());

  req.session.oidc = { state, nonce, verifier, returnTo };

  const params = new URLSearchParams({
    client_id: config.azure.clientId,
    response_type: 'code',
    redirect_uri: config.azure.redirectUri,
    response_mode: 'query',
    scope: config.azure.scopes.join(' '),
    state,
    nonce,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });
  return `${doc.authorization_endpoint}?${params.toString()}`;
}

async function handleCallback(req) {
  const { code, state, error, error_description: errorDescription } = req.query;
  if (error) throw new Error(`${error}: ${errorDescription || ''}`);
  const pending = req.session.oidc;
  if (!pending) throw new Error('No sign-in is in progress. Please start again.');
  if (state !== pending.state) throw new Error('State mismatch — possible CSRF, sign-in rejected.');

  const doc = await discovery();
  const body = new URLSearchParams({
    client_id: config.azure.clientId,
    client_secret: config.azure.clientSecret,
    grant_type: 'authorization_code',
    code: String(code),
    redirect_uri: config.azure.redirectUri,
    code_verifier: pending.verifier,
    scope: config.azure.scopes.join(' '),
  });

  const res = await fetch(doc.token_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const tokens = await res.json();
  if (!res.ok) throw new Error(tokens.error_description || tokens.error || 'Token exchange failed');

  const keySet = await jwks();
  const { payload } = await jwtVerify(tokens.id_token, keySet, {
    audience: config.azure.clientId,
    // Multi-tenant apps get a tenant-specific issuer; check the {tenantid} template.
    issuer: doc.issuer.includes('{tenantid}')
      ? doc.issuer.replace('{tenantid}', decodeJwt(tokens.id_token).tid)
      : doc.issuer,
  });

  if (payload.nonce !== pending.nonce) throw new Error('Nonce mismatch — sign-in rejected.');
  delete req.session.oidc;

  const user = upsertUser({
    oid: payload.oid || payload.sub,
    tenantId: payload.tid || null,
    email: payload.preferred_username || payload.email || null,
    name: payload.name || payload.preferred_username || 'Unknown',
    roleClaims: [].concat(payload.roles || [], payload.groups || []),
  }, req);

  return { user, returnTo: pending.returnTo || '/' };
}

function mapRole(roleClaims = []) {
  const map = config.azure.roleMap || {};
  const ranked = ['admin', 'sales', 'customer'];
  let best = null;
  for (const claim of roleClaims) {
    const mapped = map[claim];
    if (!mapped) continue;
    if (best === null || ranked.indexOf(mapped) < ranked.indexOf(best)) best = mapped;
  }
  return best || config.azure.defaultRole;
}

/**
 * Licenses belong to a company, not to one person. The Azure AD tenant id is
 * the natural company boundary: a colleague signing in from the same tenant
 * lands on the same account and sees the same licenses.
 */
function upsertAccount({ tenantId, email, name }) {
  const domain = email && email.includes('@') ? email.split('@')[1].toLowerCase() : null;
  let account = tenantId
    ? db.prepare(`SELECT * FROM accounts WHERE azure_tenant_id = ?`).get(tenantId)
    : null;
  if (!account && domain) {
    account = db.prepare(`SELECT * FROM accounts WHERE email_domain = ?`).get(domain);
  }
  if (account) {
    if (tenantId && !account.azure_tenant_id) {
      db.prepare(`UPDATE accounts SET azure_tenant_id = ? WHERE id = ?`).run(tenantId, account.id);
    }
    return account;
  }
  const id = 'acc_' + crypto.randomUUID().replace(/-/g, '').slice(0, 18);
  db.prepare(`INSERT INTO accounts (id, name, azure_tenant_id, email_domain, created_at) VALUES (?, ?, ?, ?, ?)`)
    .run(id, domain || name || 'New customer', tenantId || null, domain, nowIso());
  audit({ actor: email || 'system', action: 'account.created', entityType: 'account', entityId: id, detail: { tenantId, domain } });
  return db.prepare(`SELECT * FROM accounts WHERE id = ?`).get(id);
}

function upsertUser({ oid, tenantId, email, name, roleClaims }, req) {
  const account = upsertAccount({ tenantId, email, name });
  const role = mapRole(roleClaims);
  const existing = db.prepare(`SELECT * FROM users WHERE oid = ?`).get(oid);
  const ts = nowIso();

  if (existing) {
    db.prepare(`UPDATE users SET email = ?, name = ?, role = ?, tenant_id = ?, account_id = ?, last_login_at = ? WHERE id = ?`)
      .run(email, name, role, tenantId, account.id, ts, existing.id);
    audit({ actor: email || oid, action: 'user.signin', entityType: 'user', entityId: existing.id, detail: { role, returning: true }, ip: req && req.ip });
    return db.prepare(`SELECT * FROM users WHERE id = ?`).get(existing.id);
  }

  const id = 'usr_' + crypto.randomUUID().replace(/-/g, '').slice(0, 18);
  db.prepare(`INSERT INTO users (id, oid, tenant_id, email, name, role, account_id, created_at, last_login_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, oid, tenantId, email, name, role, account.id, ts, ts);
  audit({ actor: email || oid, action: 'user.signin', entityType: 'user', entityId: id, detail: { role, returning: false }, ip: req && req.ip });
  return db.prepare(`SELECT * FROM users WHERE id = ?`).get(id);
}

// ---- Demo stub (only when DEMO_MODE=true) ---------------------------------

const DEMO_PERSONAS = {
  customer: { name: 'Anna Berg', email: 'anna.berg@northwind-demo.com', tenant: 'demo-tenant-northwind', roles: ['Shop.Customer'] },
  customer2: { name: 'Piet de Vries', email: 'piet@northwind-demo.com', tenant: 'demo-tenant-northwind', roles: ['Shop.Customer'] },
  sales: { name: 'Sam Okafor', email: 'sam@vendor-demo.com', tenant: 'demo-tenant-vendor', roles: ['Shop.Sales'] },
  admin: { name: 'Admin User', email: 'admin@vendor-demo.com', tenant: 'demo-tenant-vendor', roles: ['Shop.Admin'] },
};

function demoSignIn(personaKey, req) {
  const persona = DEMO_PERSONAS[personaKey] || DEMO_PERSONAS.customer;
  return upsertUser({
    oid: 'demo-' + personaKey,
    tenantId: persona.tenant,
    email: persona.email,
    name: persona.name,
    roleClaims: persona.roles,
  }, req);
}

// ---- Express helpers ------------------------------------------------------

function currentUser(req) {
  if (!req.session || !req.session.userId) return null;
  return db.prepare(`SELECT * FROM users WHERE id = ?`).get(req.session.userId) || null;
}

function attachUser(req, res, next) {
  req.user = currentUser(req);
  res.locals.user = req.user;
  next();
}

function requireAuth(req, res, next) {
  if (!req.user) {
    if (req.accepts('json') && !req.accepts('html')) return res.status(401).json({ error: 'authentication_required' });
    return res.redirect('/auth/login?returnTo=' + encodeURIComponent(req.originalUrl));
  }
  next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return requireAuth(req, res, next);
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'forbidden', message: `Requires role: ${roles.join(' or ')}` });
    }
    next();
  };
}

module.exports = {
  buildAuthUrl,
  handleCallback,
  demoSignIn,
  DEMO_PERSONAS,
  currentUser,
  attachUser,
  requireAuth,
  requireRole,
  mapRole,
  upsertAccount,
};
