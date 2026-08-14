'use strict';

/**
 * Demo catalogue.
 *
 * These three products exist only so the CPQ engine has something to configure.
 * Everything here — editions, modules, tiers, rules, the mapping to license
 * features — is data in products.model_json and is editable in the admin panel.
 * Replacing it with the real catalogue is a data change, not a code change.
 */

const { db, nowIso } = require('../src/db');

const products = [
  {
    sku: 'ATLAS-DESKTOP',
    name: 'Atlas Design Suite',
    summary: 'Desktop design and simulation software, licensed per named user.',
    description:
      'The flagship desktop product. Licensed per named user with an offline-verifiable ' +
      'license token, so it keeps running on machines that are behind a corporate firewall ' +
      'or off the network entirely.',
    currency: 'EUR',
    sortOrder: 1,
    model: {
      options: [
        {
          id: 'edition',
          label: 'Edition',
          type: 'select',
          required: true,
          default: 'professional',
          choices: [
            {
              id: 'standard', label: 'Standard', price_per_seat_year: 480,
              blurb: '2D design, standard export formats, community support.',
              features: { max_projects: 25, export_formats: ['pdf', 'dxf'], simulation: false },
            },
            {
              id: 'professional', label: 'Professional', price_per_seat_year: 960,
              blurb: '3D modelling, simulation, unlimited projects.',
              features: { max_projects: -1, export_formats: ['pdf', 'dxf', 'step', 'iges'], simulation: true },
            },
            {
              id: 'enterprise', label: 'Enterprise', price_per_seat_year: 1680,
              blurb: 'Everything in Professional plus deployment tooling and audit logging.',
              features: { max_projects: -1, export_formats: ['pdf', 'dxf', 'step', 'iges', 'jt'], simulation: true, audit_log: true, silent_deploy: true },
            },
          ],
        },
        { id: 'seats', label: 'Named users', type: 'quantity', min: 1, max: 5000, default: 5, unit: 'users' },
        {
          id: 'modules',
          label: 'Add-on modules',
          type: 'multiselect',
          default: [],
          choices: [
            { id: 'api', label: 'Automation API / SDK', price_per_seat_year: 240, features: { api: true } },
            { id: 'cam', label: 'CAM toolpath module', price_per_seat_year: 420, features: { cam: true } },
            { id: 'cloud_sync', label: 'Cloud project sync', price_per_seat_year: 120, features: { cloud_sync: true } },
            { id: 'offline', label: 'Air-gapped activation', price_flat_year: 1200, features: { offline_activation: true } },
            { id: 'priority_patch', label: 'Priority security patches', price_flat_year: 2400, features: { priority_patches: true } },
          ],
        },
        {
          id: 'term',
          label: 'Contract term',
          type: 'select',
          default: '12',
          choices: [
            { id: '12', label: '1 year', months: 12, discount_pct: 0 },
            { id: '24', label: '2 years', months: 24, discount_pct: 8 },
            { id: '36', label: '3 years', months: 36, discount_pct: 15 },
          ],
        },
        {
          id: 'support',
          label: 'Support level',
          type: 'select',
          default: 'standard',
          choices: [
            { id: 'standard', label: 'Standard (next business day)', uplift_pct: 0 },
            { id: 'plus', label: 'Plus (4h response, business hours)', uplift_pct: 12 },
            { id: 'premium', label: 'Premium (24/7, named engineer)', uplift_pct: 25 },
          ],
        },
      ],
      volume_tiers: [
        { min: 1, max: 9, discount_pct: 0 },
        { min: 10, max: 24, discount_pct: 5 },
        { min: 25, max: 99, discount_pct: 12 },
        { min: 100, max: 249, discount_pct: 18 },
        { min: 250, max: null, discount_pct: 25 },
      ],
      rules: [
        {
          when: { option: 'modules', includes: 'cam' },
          then: { require: { option: 'edition', in: ['professional', 'enterprise'] } },
          message: 'The CAM toolpath module requires the Professional or Enterprise edition.',
        },
        {
          when: { option: 'modules', includes: 'offline' },
          then: { require: { option: 'edition', equals: 'enterprise' } },
          message: 'Air-gapped activation is an Enterprise feature.',
        },
        {
          when: { option: 'edition', equals: 'enterprise' },
          then: { option: 'seats', min: 5 },
          message: 'Enterprise starts at 5 named users.',
        },
        {
          when: { option: 'support', equals: 'premium' },
          then: { require: { option: 'edition', in: ['professional', 'enterprise'] } },
          message: 'Premium support is available on Professional and Enterprise.',
        },
      ],
      license: {
        key_prefix: 'ATLS',
        base_features: { product: 'atlas-desktop' },
      },
    },
  },
  {
    sku: 'ATLAS-SERVER',
    name: 'Atlas Collaboration Server',
    summary: 'On-premise server, licensed per installed instance with a connected-user cap.',
    description:
      'Runs inside the customer\'s own network. Licensed per server instance; the license ' +
      'token carries the concurrent-user cap the server enforces itself.',
    currency: 'EUR',
    sortOrder: 2,
    model: {
      options: [
        {
          id: 'edition',
          label: 'Capacity',
          type: 'select',
          required: true,
          default: 'team',
          choices: [
            { id: 'team', label: 'Team (up to 50 connected users)', price_per_seat_year: 2400, features: { max_connected_users: 50 } },
            { id: 'division', label: 'Division (up to 250)', price_per_seat_year: 7200, features: { max_connected_users: 250 } },
            { id: 'global', label: 'Global (unlimited)', price_per_seat_year: 18000, features: { max_connected_users: -1 } },
          ],
        },
        { id: 'seats', label: 'Server instances', type: 'quantity', min: 1, max: 100, default: 1, unit: 'instances' },
        {
          id: 'modules',
          label: 'Add-ons',
          type: 'multiselect',
          choices: [
            { id: 'ha', label: 'High availability / failover node', price_per_seat_year: 3600, features: { ha: true } },
            { id: 'sso_saml', label: 'SAML / Entra ID single sign-on', price_flat_year: 1800, features: { sso: true } },
            { id: 'audit', label: 'Compliance audit export', price_flat_year: 1200, features: { audit_export: true } },
          ],
        },
        {
          id: 'term',
          label: 'Contract term',
          type: 'select',
          default: '12',
          choices: [
            { id: '12', label: '1 year', months: 12, discount_pct: 0 },
            { id: '36', label: '3 years', months: 36, discount_pct: 12 },
          ],
        },
        {
          id: 'support',
          label: 'Support level',
          type: 'select',
          default: 'plus',
          choices: [
            { id: 'plus', label: 'Plus (4h response)', uplift_pct: 0 },
            { id: 'premium', label: 'Premium (24/7, named engineer)', uplift_pct: 20 },
          ],
        },
      ],
      volume_tiers: [
        { min: 1, max: 2, discount_pct: 0 },
        { min: 3, max: 9, discount_pct: 8 },
        { min: 10, max: null, discount_pct: 15 },
      ],
      rules: [
        {
          when: { option: 'modules', includes: 'ha' },
          then: { require: { option: 'edition', in: ['division', 'global'] } },
          message: 'High availability requires the Division or Global capacity tier.',
        },
      ],
      license: { key_prefix: 'ATSV', base_features: { product: 'atlas-server' } },
    },
  },
  {
    sku: 'ATLAS-CLOUD',
    name: 'Atlas Analytics Cloud',
    summary: 'Hosted analytics, per user per month, billed annually.',
    description: 'Fully hosted. The license token drives feature flags and the seat cap inside the tenant.',
    currency: 'EUR',
    sortOrder: 3,
    model: {
      options: [
        {
          id: 'edition',
          label: 'Plan',
          type: 'select',
          required: true,
          default: 'growth',
          choices: [
            { id: 'starter', label: 'Starter', price_per_seat_year: 180, features: { dashboards: 5, retention_months: 6 } },
            { id: 'growth', label: 'Growth', price_per_seat_year: 360, features: { dashboards: 50, retention_months: 24 } },
            { id: 'scale', label: 'Scale', price_per_seat_year: 720, features: { dashboards: -1, retention_months: 60 } },
          ],
        },
        { id: 'seats', label: 'Users', type: 'quantity', min: 3, max: 10000, default: 10, unit: 'users' },
        {
          id: 'modules',
          label: 'Add-ons',
          type: 'multiselect',
          choices: [
            { id: 'warehouse', label: 'Data warehouse connector', price_flat_year: 2400, features: { warehouse: true } },
            { id: 'whitelabel', label: 'White-label embedding', price_flat_year: 4800, features: { whitelabel: true } },
          ],
        },
        {
          id: 'term',
          label: 'Contract term',
          type: 'select',
          default: '12',
          choices: [
            { id: '12', label: '1 year', months: 12, discount_pct: 0 },
            { id: '24', label: '2 years', months: 24, discount_pct: 10 },
          ],
        },
        {
          id: 'support',
          label: 'Support level',
          type: 'select',
          default: 'standard',
          choices: [
            { id: 'standard', label: 'Standard', uplift_pct: 0 },
            { id: 'premium', label: 'Premium (24/7)', uplift_pct: 18 },
          ],
        },
      ],
      volume_tiers: [
        { min: 3, max: 24, discount_pct: 0 },
        { min: 25, max: 99, discount_pct: 10 },
        { min: 100, max: null, discount_pct: 20 },
      ],
      rules: [
        {
          when: { option: 'modules', includes: 'whitelabel' },
          then: { require: { option: 'edition', equals: 'scale' } },
          message: 'White-label embedding is only available on the Scale plan.',
        },
      ],
      license: { key_prefix: 'ATCL', base_features: { product: 'atlas-cloud' } },
    },
  },
];

function ensureSeeded() {
  const count = db.prepare(`SELECT COUNT(*) AS n FROM products`).get().n;
  if (count > 0) return { seeded: false, products: count };
  const insert = db.prepare(
    `INSERT INTO products (sku, name, summary, description, currency, active, sort_order, model_json, updated_at)
     VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)`
  );
  for (const p of products) {
    insert.run(p.sku, p.name, p.summary, p.description, p.currency, p.sortOrder, JSON.stringify(p.model), nowIso());
  }
  return { seeded: true, products: products.length };
}

if (require.main === module) {
  console.log(ensureSeeded());
}

module.exports = { ensureSeeded, products };
