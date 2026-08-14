'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const config = require('./config');

fs.mkdirSync(path.dirname(config.db.file), { recursive: true });

const db = new Database(config.db.file);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id              TEXT PRIMARY KEY,
  oid             TEXT UNIQUE,            -- Azure AD object id
  tenant_id       TEXT,                   -- Azure AD tenant (home tenant of the user)
  email           TEXT,
  name            TEXT,
  role            TEXT NOT NULL DEFAULT 'customer',
  account_id      TEXT REFERENCES accounts(id),
  created_at      TEXT NOT NULL,
  last_login_at   TEXT
);

-- A customer company. Licenses belong to the account, not to a single user, so
-- a colleague signing in from the same Azure AD tenant sees the same licenses.
CREATE TABLE IF NOT EXISTS accounts (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  azure_tenant_id TEXT UNIQUE,
  email_domain    TEXT,
  vat_number      TEXT,
  country         TEXT,
  created_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS products (
  sku             TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  summary         TEXT,
  description     TEXT,
  currency        TEXT NOT NULL DEFAULT 'EUR',
  active          INTEGER NOT NULL DEFAULT 1,
  sort_order      INTEGER NOT NULL DEFAULT 0,
  -- The whole CPQ model for the product: option groups, price book, rules.
  model_json      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS quotes (
  id              TEXT PRIMARY KEY,
  number          TEXT UNIQUE NOT NULL,
  account_id      TEXT REFERENCES accounts(id),
  user_id         TEXT REFERENCES users(id),
  sku             TEXT NOT NULL,
  config_json     TEXT NOT NULL,          -- chosen options
  pricing_json    TEXT NOT NULL,          -- full priced breakdown (snapshot)
  currency        TEXT NOT NULL,
  total_cents     INTEGER NOT NULL,
  discount_pct    REAL NOT NULL DEFAULT 0,
  status          TEXT NOT NULL,          -- draft|pending_approval|approved|rejected|ordered|expired
  approval_note   TEXT,
  approved_by     TEXT,
  created_at      TEXT NOT NULL,
  expires_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS orders (
  id              TEXT PRIMARY KEY,
  number          TEXT UNIQUE NOT NULL,
  quote_id        TEXT REFERENCES quotes(id),
  account_id      TEXT REFERENCES accounts(id),
  user_id         TEXT REFERENCES users(id),
  status          TEXT NOT NULL,          -- pending|paid|failed|refunded|cancelled
  currency        TEXT NOT NULL,
  total_cents     INTEGER NOT NULL,
  payment_ref     TEXT,
  payment_provider TEXT,
  created_at      TEXT NOT NULL,
  paid_at         TEXT
);

-- Recurring billing agreement produced by a paid order.
CREATE TABLE IF NOT EXISTS subscriptions (
  id              TEXT PRIMARY KEY,
  account_id      TEXT NOT NULL REFERENCES accounts(id),
  order_id        TEXT REFERENCES orders(id),
  sku             TEXT NOT NULL,
  config_json     TEXT NOT NULL,
  currency        TEXT NOT NULL,
  renewal_cents   INTEGER NOT NULL,       -- amount charged each term
  term_months     INTEGER NOT NULL,
  status          TEXT NOT NULL,          -- active|past_due|cancelled|expired
  auto_renew      INTEGER NOT NULL DEFAULT 1,
  current_period_start TEXT NOT NULL,
  current_period_end   TEXT NOT NULL,
  cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS licenses (
  id              TEXT PRIMARY KEY,
  license_key     TEXT UNIQUE NOT NULL,
  account_id      TEXT NOT NULL REFERENCES accounts(id),
  subscription_id TEXT REFERENCES subscriptions(id),
  sku             TEXT NOT NULL,
  edition         TEXT,
  seats           INTEGER NOT NULL DEFAULT 1,
  modules_json    TEXT NOT NULL DEFAULT '[]',
  features_json   TEXT NOT NULL DEFAULT '{}',
  status          TEXT NOT NULL,          -- active|suspended|revoked|expired
  starts_at       TEXT NOT NULL,
  ends_at         TEXT NOT NULL,
  revoked_at      TEXT,
  revoke_reason   TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

-- One row per machine that activated the license. Seat enforcement lives here.
CREATE TABLE IF NOT EXISTS activations (
  id              TEXT PRIMARY KEY,
  license_id      TEXT NOT NULL REFERENCES licenses(id) ON DELETE CASCADE,
  fingerprint     TEXT NOT NULL,
  hostname        TEXT,
  os              TEXT,
  app_version     TEXT,
  status          TEXT NOT NULL,          -- active|deactivated
  activated_at    TEXT NOT NULL,
  last_seen_at    TEXT,
  deactivated_at  TEXT,
  UNIQUE (license_id, fingerprint)
);

CREATE TABLE IF NOT EXISTS signing_keys (
  kid             TEXT PRIMARY KEY,
  public_jwk      TEXT NOT NULL,
  public_pem      TEXT NOT NULL,
  status          TEXT NOT NULL,          -- active|retired
  created_at      TEXT NOT NULL,
  retired_at      TEXT
);

-- Append-only audit trail. Every licensing action lands here.
CREATE TABLE IF NOT EXISTS audit_log (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  at              TEXT NOT NULL,
  actor           TEXT,
  action          TEXT NOT NULL,
  entity_type     TEXT,
  entity_id       TEXT,
  detail_json     TEXT,
  ip              TEXT
);

-- Outbound calls to the license server are queued so a transient failure is
-- retried instead of silently losing a customer's license.
CREATE TABLE IF NOT EXISTS license_jobs (
  id              TEXT PRIMARY KEY,
  kind            TEXT NOT NULL,          -- issue|renew|revoke|update
  payload_json    TEXT NOT NULL,
  idempotency_key TEXT UNIQUE NOT NULL,
  status          TEXT NOT NULL,          -- pending|running|done|failed
  attempts        INTEGER NOT NULL DEFAULT 0,
  last_error      TEXT,
  result_json     TEXT,
  next_attempt_at TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_lic_account   ON licenses(account_id);
CREATE INDEX IF NOT EXISTS idx_lic_sub       ON licenses(subscription_id);
CREATE INDEX IF NOT EXISTS idx_act_license   ON activations(license_id);
CREATE INDEX IF NOT EXISTS idx_sub_account   ON subscriptions(account_id);
CREATE INDEX IF NOT EXISTS idx_jobs_status   ON license_jobs(status, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_audit_entity  ON audit_log(entity_type, entity_id);
`);

function nowIso() {
  return new Date().toISOString();
}

function audit(entry) {
  db.prepare(
    `INSERT INTO audit_log (at, actor, action, entity_type, entity_id, detail_json, ip)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    nowIso(),
    entry.actor || 'system',
    entry.action,
    entry.entityType || null,
    entry.entityId || null,
    entry.detail ? JSON.stringify(entry.detail) : null,
    entry.ip || null
  );
}

module.exports = { db, nowIso, audit };
