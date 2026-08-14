'use strict';

/**
 * The CPQ engine: Configure -> Price -> Quote.
 *
 * A product's entire commercial model lives in one JSON document (products.model_json)
 * that an admin can edit in the browser: option groups, price book, volume tiers,
 * compatibility rules and the mapping from a configuration to license parameters.
 * No code change is needed to add an edition, a module or a price tier.
 */

const crypto = require('crypto');
const { db, nowIso, audit } = require('./db');
const config = require('./config');

class ConfigError extends Error {
  constructor(errors) {
    super(errors.map((e) => e.message).join('; '));
    this.errors = errors;
    this.httpStatus = 422;
  }
}

function getProduct(sku) {
  const row = db.prepare(`SELECT * FROM products WHERE sku = ?`).get(sku);
  if (!row) return null;
  return { ...row, model: JSON.parse(row.model_json), active: !!row.active };
}

function listProducts({ includeInactive = false } = {}) {
  const rows = db
    .prepare(`SELECT * FROM products ${includeInactive ? '' : 'WHERE active = 1'} ORDER BY sort_order, name`)
    .all();
  return rows.map((r) => ({ ...r, model: JSON.parse(r.model_json), active: !!r.active }));
}

function findOption(model, id) {
  return (model.options || []).find((o) => o.id === id);
}

function findChoice(option, id) {
  return ((option && option.choices) || []).find((c) => c.id === id);
}

// ---------------------------------------------------------------------------
// Configure — normalise + validate a configuration against the product model
// ---------------------------------------------------------------------------

function normaliseConfig(product, raw = {}) {
  const model = product.model;
  const out = {};
  for (const option of model.options || []) {
    const value = raw[option.id];
    switch (option.type) {
      case 'select': {
        const chosen = findChoice(option, value) || (option.default ? findChoice(option, option.default) : null) || option.choices[0];
        out[option.id] = chosen ? chosen.id : null;
        break;
      }
      case 'multiselect': {
        const arr = Array.isArray(value) ? value : value ? [value] : option.default || [];
        out[option.id] = arr.filter((id) => findChoice(option, id));
        break;
      }
      case 'quantity': {
        const n = Number.isFinite(Number(value)) ? Math.floor(Number(value)) : option.default ?? option.min ?? 1;
        out[option.id] = Math.min(option.max ?? 100000, Math.max(option.min ?? 1, n));
        break;
      }
      case 'boolean': {
        out[option.id] = value === undefined ? Boolean(option.default) : Boolean(value);
        break;
      }
      default:
        out[option.id] = value ?? null;
    }
  }
  return out;
}

/**
 * Rule format (stored per product, editable in admin):
 *   { when: {option, equals|in|includes|gte|lte}, then: {...}, message }
 * `then` supports: require (same shape as when), forbid, min, max, auto_add.
 */
function testCondition(cond, cfg) {
  if (!cond) return true;
  const v = cfg[cond.option];
  if (cond.equals !== undefined) return v === cond.equals;
  if (cond.in !== undefined) return cond.in.includes(v);
  if (cond.not_in !== undefined) return !cond.not_in.includes(v);
  if (cond.includes !== undefined) return Array.isArray(v) && v.includes(cond.includes);
  if (cond.excludes !== undefined) return !(Array.isArray(v) && v.includes(cond.excludes));
  if (cond.gte !== undefined) return Number(v) >= cond.gte;
  if (cond.lte !== undefined) return Number(v) <= cond.lte;
  return true;
}

function validateConfig(product, cfg) {
  const errors = [];
  const model = product.model;

  for (const option of model.options || []) {
    if (option.required && (cfg[option.id] === null || cfg[option.id] === undefined)) {
      errors.push({ option: option.id, message: `${option.label} is required` });
    }
  }

  for (const rule of model.rules || []) {
    if (!testCondition(rule.when, cfg)) continue;
    if (rule.then && rule.then.require && !testCondition(rule.then.require, cfg)) {
      errors.push({ option: rule.then.require.option, message: rule.message || 'Configuration is not valid' });
    }
    if (rule.then && rule.then.forbid && testCondition(rule.then.forbid, cfg)) {
      errors.push({ option: rule.then.forbid.option, message: rule.message || 'These options cannot be combined' });
    }
    if (rule.then && rule.then.min !== undefined) {
      const target = rule.then.option || 'seats';
      if (Number(cfg[target]) < rule.then.min) {
        errors.push({ option: target, message: rule.message || `Minimum is ${rule.then.min}` });
      }
    }
  }

  return errors;
}

/**
 * Which choices would break the configuration if the user picked them next,
 * and why. This is what greys out an option in the UI with a reason attached
 * instead of letting someone build an invalid quote and fail at checkout.
 */
function availability(product, cfg) {
  const model = product.model;
  const key = (e) => `${e.option}|${e.message}`;
  const alreadyBroken = new Set(validateConfig(product, cfg).map(key));
  const blocked = {};

  for (const option of model.options || []) {
    for (const choice of option.choices || []) {
      const probe = { ...cfg };
      if (option.type === 'multiselect') {
        // Deselecting is always allowed; only test adding.
        if ((cfg[option.id] || []).includes(choice.id)) continue;
        probe[option.id] = [...(cfg[option.id] || []), choice.id];
      } else {
        if (cfg[option.id] === choice.id) continue;
        probe[option.id] = choice.id;
      }
      const introduced = validateConfig(product, probe).filter((e) => !alreadyBroken.has(key(e)));
      if (introduced.length) blocked[`${option.id}:${choice.id}`] = introduced[0].message;
    }
  }
  return blocked;
}

// ---------------------------------------------------------------------------
// Price
// ---------------------------------------------------------------------------

function eur(cents) {
  return Math.round(cents);
}

function volumeTier(model, seats) {
  const tiers = model.volume_tiers || [];
  return tiers.find((t) => seats >= (t.min ?? 0) && seats <= (t.max ?? Infinity)) || { discount_pct: 0, min: 1, max: null };
}

function price(product, cfg, { discountPct = 0 } = {}) {
  const model = product.model;
  const lines = [];

  const seatsOption = (model.options || []).find((o) => o.type === 'quantity');
  const seats = seatsOption ? Number(cfg[seatsOption.id] || 1) : 1;

  const editionOption = findOption(model, 'edition');
  const edition = findChoice(editionOption, cfg.edition);
  const basePerSeat = Math.round(((edition && edition.price_per_seat_year) || 0) * 100);

  lines.push({
    kind: 'base',
    id: edition ? edition.id : 'base',
    label: `${product.name} — ${edition ? edition.label : 'Base'}`,
    detail: `${seats} × ${(basePerSeat / 100).toFixed(2)} / user / year`,
    qty: seats,
    unit_cents: basePerSeat,
    amount_cents: basePerSeat * seats,
  });

  let perSeatAddOns = 0;
  let flatAddOns = 0;
  const moduleOption = findOption(model, 'modules');
  for (const modId of cfg.modules || []) {
    const mod = findChoice(moduleOption, modId);
    if (!mod) continue;
    if (mod.price_per_seat_year) {
      const unit = Math.round(mod.price_per_seat_year * 100);
      perSeatAddOns += unit;
      lines.push({
        kind: 'module',
        id: mod.id,
        label: mod.label,
        detail: `${seats} × ${(unit / 100).toFixed(2)} / user / year`,
        qty: seats,
        unit_cents: unit,
        amount_cents: unit * seats,
      });
    } else if (mod.price_flat_year) {
      const unit = Math.round(mod.price_flat_year * 100);
      flatAddOns += unit;
      lines.push({
        kind: 'module',
        id: mod.id,
        label: mod.label,
        detail: 'flat / year',
        qty: 1,
        unit_cents: unit,
        amount_cents: unit,
      });
    }
  }

  const seatSubtotal = (basePerSeat + perSeatAddOns) * seats;
  const tier = volumeTier(model, seats);
  const volumeDiscountCents = eur(seatSubtotal * (tier.discount_pct || 0) / 100);
  if (volumeDiscountCents > 0) {
    lines.push({
      kind: 'discount',
      id: 'volume',
      label: `Volume discount (${tier.discount_pct}% at ${tier.min}+ users)`,
      qty: 1,
      unit_cents: -volumeDiscountCents,
      amount_cents: -volumeDiscountCents,
    });
  }

  let annual = seatSubtotal - volumeDiscountCents + flatAddOns;

  const supportOption = findOption(model, 'support');
  const support = findChoice(supportOption, cfg.support);
  if (support && support.uplift_pct) {
    const uplift = eur(annual * support.uplift_pct / 100);
    lines.push({
      kind: 'support',
      id: support.id,
      label: `${support.label} (+${support.uplift_pct}%)`,
      qty: 1,
      unit_cents: uplift,
      amount_cents: uplift,
    });
    annual += uplift;
  }

  const termOption = findOption(model, 'term');
  const term = findChoice(termOption, cfg.term) || { months: 12, discount_pct: 0, label: '1 year' };
  const months = term.months || 12;
  const years = months / 12;

  let total = eur(annual * years);
  const termDiscountCents = eur(total * (term.discount_pct || 0) / 100);
  if (termDiscountCents > 0) {
    lines.push({
      kind: 'discount',
      id: 'term',
      label: `${term.label} prepay discount (${term.discount_pct}%)`,
      qty: 1,
      unit_cents: -termDiscountCents,
      amount_cents: -termDiscountCents,
    });
    total -= termDiscountCents;
  }

  const manualDiscountCents = discountPct > 0 ? eur(total * discountPct / 100) : 0;
  if (manualDiscountCents > 0) {
    lines.push({
      kind: 'discount',
      id: 'manual',
      label: `Sales discount (${discountPct}%)`,
      qty: 1,
      unit_cents: -manualDiscountCents,
      amount_cents: -manualDiscountCents,
    });
    total -= manualDiscountCents;
  }

  // List price = the same configuration with no volume, term or sales discount,
  // support uplift included. Comparing the total against anything else would
  // overstate or understate the saving.
  const supportPct = support && support.uplift_pct ? support.uplift_pct : 0;
  const listTotal = eur((seatSubtotal + flatAddOns) * (1 + supportPct / 100) * years);

  return {
    currency: product.currency,
    seats,
    term_months: months,
    term_label: term.label,
    lines,
    annual_cents: eur(annual),
    // What the customer is billed each renewal term.
    renewal_cents: eur(annual * years) - termDiscountCents,
    list_total_cents: listTotal,
    total_cents: Math.max(0, eur(total)),
    effective_discount_pct: listTotal > 0 ? Math.round(((listTotal - total) / listTotal) * 1000) / 10 : 0,
    volume_tier: tier,
    needs_approval: discountPct > config.quotes.approvalThresholdPct,
  };
}

// ---------------------------------------------------------------------------
// Configuration -> license parameters (the CPQ / licensing bridge)
// ---------------------------------------------------------------------------

function licenseParams(product, cfg) {
  const model = product.model;
  const editionOption = findOption(model, 'edition');
  const edition = findChoice(editionOption, cfg.edition);
  const moduleOption = findOption(model, 'modules');

  const features = { ...(model.license && model.license.base_features) };
  if (edition && edition.features) Object.assign(features, edition.features);
  const modules = [];
  for (const modId of cfg.modules || []) {
    const mod = findChoice(moduleOption, modId);
    if (!mod) continue;
    modules.push(mod.id);
    if (mod.features) Object.assign(features, mod.features);
  }

  const seatsOption = (model.options || []).find((o) => o.type === 'quantity');
  const support = findChoice(findOption(model, 'support'), cfg.support);
  if (support) features.support_tier = support.id;

  const term = findChoice(findOption(model, 'term'), cfg.term) || { months: 12 };

  return {
    sku: product.sku,
    edition: edition ? edition.id : null,
    seats: seatsOption ? Number(cfg[seatsOption.id] || 1) : 1,
    modules,
    features,
    termMonths: term.months || 12,
    keyPrefix: (model.license && model.license.key_prefix) || product.sku.slice(0, 4).toUpperCase(),
  };
}

// ---------------------------------------------------------------------------
// Quote
// ---------------------------------------------------------------------------

function nextNumber(table, prefix) {
  const n = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n + 1;
  const year = new Date().getUTCFullYear();
  return `${prefix}-${year}-${String(n).padStart(5, '0')}`;
}

function createQuote({ product, cfg, pricing, user, accountId, discountPct = 0 }, ctx = {}) {
  const id = 'qte_' + crypto.randomUUID().replace(/-/g, '').slice(0, 18);
  const number = nextNumber('quotes', 'Q');
  const created = new Date();
  const expires = new Date(created.getTime() + config.quotes.validDays * 86400000);
  const status = pricing.needs_approval ? 'pending_approval' : 'draft';

  db.prepare(
    `INSERT INTO quotes (id, number, account_id, user_id, sku, config_json, pricing_json, currency,
      total_cents, discount_pct, status, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id, number, accountId || null, user ? user.id : null, product.sku,
    JSON.stringify(cfg), JSON.stringify(pricing), pricing.currency,
    pricing.total_cents, discountPct, status, created.toISOString(), expires.toISOString()
  );

  audit({
    actor: user ? user.email || user.id : 'anonymous',
    action: 'quote.created',
    entityType: 'quote',
    entityId: id,
    detail: { number, sku: product.sku, total_cents: pricing.total_cents, status },
    ip: ctx.ip,
  });

  return getQuote(id);
}

function getQuote(id) {
  const row = db.prepare(`SELECT * FROM quotes WHERE id = ? OR number = ?`).get(id, id);
  if (!row) return null;
  return { ...row, config: JSON.parse(row.config_json), pricing: JSON.parse(row.pricing_json) };
}

module.exports = {
  ConfigError,
  getProduct,
  listProducts,
  normaliseConfig,
  validateConfig,
  availability,
  price,
  licenseParams,
  createQuote,
  getQuote,
  nextNumber,
};
