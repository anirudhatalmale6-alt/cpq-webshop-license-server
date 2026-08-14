'use strict';

/**
 * The API bridge between the shop and the license server.
 *
 * Two adapters implement the same four operations (issue, update, renew,
 * revoke):
 *
 *   local  — the built-in license server in src/license.js (used by the demo,
 *            and a perfectly good production choice on its own).
 *   http   — any external license server. Point LICENSE_SERVER_URL at it, set
 *            LICENSE_SERVER_TOKEN, and map the four endpoints in
 *            config/license-endpoints.json. No other code changes.
 *
 * Every call goes through a durable job queue with an idempotency key, so a
 * timeout or a 500 from the license server never loses a paying customer's
 * license: the job is retried with exponential backoff and the whole history
 * is visible in the admin panel.
 */

const crypto = require('crypto');
const { db, nowIso, audit } = require('./db');
const licenseService = require('./license');

const MAX_ATTEMPTS = 8;
const BACKOFF_SECONDS = [0, 5, 30, 120, 600, 1800, 3600, 10800];

// ---------------------------------------------------------------------------
// Adapters
// ---------------------------------------------------------------------------

const localAdapter = {
  name: 'local',
  async issue(payload) {
    const license = licenseService.issueLicense(payload, { actor: 'bridge' });
    return { license_id: license.id, license_key: license.license_key, ends_at: license.ends_at };
  },
  async update(payload) {
    const license = licenseService.updateLicense(payload.licenseId, payload.changes, { actor: 'bridge' });
    return { license_id: license.id, seats: license.seats, ends_at: license.ends_at };
  },
  async renew(payload) {
    const license = licenseService.renewLicense(payload.licenseId, payload.termMonths, { actor: 'bridge' });
    return { license_id: license.id, ends_at: license.ends_at };
  },
  async revoke(payload) {
    const license = licenseService.revokeLicense(payload.licenseId, payload.reason, { actor: 'bridge' });
    return { license_id: license.id, status: license.status };
  },
};

function httpAdapter(settings) {
  const base = settings.url.replace(/\/$/, '');
  const endpoints = Object.assign(
    { issue: 'POST /licenses', update: 'PATCH /licenses/{licenseId}', renew: 'POST /licenses/{licenseId}/renew', revoke: 'POST /licenses/{licenseId}/revoke' },
    settings.endpoints || {}
  );

  async function call(kind, payload, idempotencyKey) {
    const [method, rawPath] = endpoints[kind].split(' ');
    const path = rawPath.replace(/\{(\w+)\}/g, (_, k) => encodeURIComponent(payload[k] ?? ''));
    const res = await fetch(base + path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': idempotencyKey,
        ...(settings.authHeader ? { [settings.authHeader]: settings.token } : { Authorization: `Bearer ${settings.token}` }),
      },
      body: method === 'GET' ? undefined : JSON.stringify(payload),
      signal: AbortSignal.timeout(settings.timeoutMs || 20000),
    });
    const text = await res.text();
    let json;
    try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
    if (!res.ok) {
      const err = new Error(`License server responded ${res.status}: ${text.slice(0, 300)}`);
      // 4xx (except 408/429) is a permanent failure — retrying will not help.
      err.permanent = res.status >= 400 && res.status < 500 && ![408, 429].includes(res.status);
      throw err;
    }
    return json;
  }

  return {
    name: 'http',
    issue: (p, k) => call('issue', p, k),
    update: (p, k) => call('update', p, k),
    renew: (p, k) => call('renew', p, k),
    revoke: (p, k) => call('revoke', p, k),
  };
}

let adapter = localAdapter;

function configureAdapter(settings) {
  adapter = settings && settings.url ? httpAdapter(settings) : localAdapter;
  return adapter.name;
}

if (process.env.LICENSE_SERVER_URL) {
  configureAdapter({
    url: process.env.LICENSE_SERVER_URL,
    token: process.env.LICENSE_SERVER_TOKEN || '',
    authHeader: process.env.LICENSE_SERVER_AUTH_HEADER || '',
    endpoints: process.env.LICENSE_SERVER_ENDPOINTS ? JSON.parse(process.env.LICENSE_SERVER_ENDPOINTS) : undefined,
    timeoutMs: Number(process.env.LICENSE_SERVER_TIMEOUT_MS) || 20000,
  });
}

// ---------------------------------------------------------------------------
// Durable job queue
// ---------------------------------------------------------------------------

/**
 * The idempotency key is derived from what the job means, not from when it ran.
 * Enqueueing "renew subscription X for period ending Y" twice produces one job,
 * so a retried webhook or a double-clicked button cannot double-issue.
 */
function enqueue(kind, payload, idempotencyKey) {
  const key = idempotencyKey || `${kind}:${crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 32)}`;
  const existing = db.prepare(`SELECT * FROM license_jobs WHERE idempotency_key = ?`).get(key);
  if (existing) return existing;

  const id = 'job_' + crypto.randomUUID().replace(/-/g, '').slice(0, 18);
  const ts = nowIso();
  db.prepare(
    `INSERT INTO license_jobs (id, kind, payload_json, idempotency_key, status, next_attempt_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)`
  ).run(id, kind, JSON.stringify(payload), key, ts, ts, ts);

  audit({ actor: 'bridge', action: 'license_job.enqueued', entityType: 'license_job', entityId: id, detail: { kind, key } });
  return db.prepare(`SELECT * FROM license_jobs WHERE id = ?`).get(id);
}

async function runJob(job) {
  const payload = JSON.parse(job.payload_json);
  db.prepare(`UPDATE license_jobs SET status = 'running', attempts = attempts + 1, updated_at = ? WHERE id = ?`)
    .run(nowIso(), job.id);

  try {
    const result = await adapter[job.kind](payload, job.idempotency_key);
    db.prepare(`UPDATE license_jobs SET status = 'done', result_json = ?, last_error = NULL, updated_at = ? WHERE id = ?`)
      .run(JSON.stringify(result || {}), nowIso(), job.id);
    audit({
      actor: 'bridge',
      action: `license_job.${job.kind}.succeeded`,
      entityType: 'license_job',
      entityId: job.id,
      detail: { adapter: adapter.name, result },
    });
    return { ok: true, result };
  } catch (err) {
    const attempts = job.attempts + 1;
    const permanent = err.permanent || attempts >= MAX_ATTEMPTS;
    const waitSeconds = BACKOFF_SECONDS[Math.min(attempts, BACKOFF_SECONDS.length - 1)];
    db.prepare(`UPDATE license_jobs SET status = ?, last_error = ?, next_attempt_at = ?, updated_at = ? WHERE id = ?`)
      .run(
        permanent ? 'failed' : 'pending',
        String(err.message).slice(0, 500),
        new Date(Date.now() + waitSeconds * 1000).toISOString(),
        nowIso(),
        job.id
      );
    audit({
      actor: 'bridge',
      action: `license_job.${job.kind}.failed`,
      entityType: 'license_job',
      entityId: job.id,
      detail: { attempts, permanent, error: String(err.message).slice(0, 500) },
    });
    return { ok: false, error: err.message, permanent };
  }
}

/** Runs every job that is due. Called after checkout and on a timer. */
async function drain(limit = 25) {
  const due = db
    .prepare(`SELECT * FROM license_jobs WHERE status = 'pending' AND next_attempt_at <= ? ORDER BY created_at LIMIT ?`)
    .all(nowIso(), limit);
  const results = [];
  for (const job of due) {
    results.push({ id: job.id, kind: job.kind, ...(await runJob(job)) });
  }
  return results;
}

function retryJob(id) {
  db.prepare(`UPDATE license_jobs SET status = 'pending', next_attempt_at = ?, updated_at = ? WHERE id = ?`)
    .run(nowIso(), nowIso(), id);
  return db.prepare(`SELECT * FROM license_jobs WHERE id = ?`).get(id);
}

function listJobs({ status, limit = 100 } = {}) {
  return status
    ? db.prepare(`SELECT * FROM license_jobs WHERE status = ? ORDER BY created_at DESC LIMIT ?`).all(status, limit)
    : db.prepare(`SELECT * FROM license_jobs ORDER BY created_at DESC LIMIT ?`).all(limit);
}

let timer = null;
function startWorker(intervalMs = 30000) {
  if (timer) return;
  timer = setInterval(() => {
    drain().catch((err) => console.error('[bridge] drain failed:', err.message));
  }, intervalMs);
  timer.unref();
}

module.exports = { enqueue, drain, runJob, retryJob, listJobs, startWorker, configureAdapter, adapterName: () => adapter.name };
