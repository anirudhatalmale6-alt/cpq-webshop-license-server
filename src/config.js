'use strict';

/**
 * Central configuration. Everything is environment-driven so the same build
 * runs in demo, staging and production without code changes.
 *
 * DEMO_MODE=true  -> a local sign-in stub stands in for Azure AD, and the
 *                    payment step is simulated. Nothing else changes: the CPQ
 *                    engine, the license server and the API bridge are the
 *                    real implementations in both modes.
 */

const path = require('path');

function bool(v, fallback = false) {
  if (v === undefined || v === null || v === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
}

function int(v, fallback) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

const root = path.resolve(__dirname, '..');

const config = {
  env: process.env.NODE_ENV || 'development',
  port: int(process.env.PORT, 3000),
  root,

  // Public origin of this deployment (used for OIDC redirect + token issuer).
  publicUrl: (process.env.PUBLIC_URL || `http://localhost:${int(process.env.PORT, 3000)}`).replace(/\/$/, ''),

  demoMode: bool(process.env.DEMO_MODE, true),

  session: {
    secret: process.env.SESSION_SECRET || 'dev-only-session-secret-change-me',
    secure: bool(process.env.SESSION_SECURE, false),
  },

  db: {
    file: process.env.DB_FILE || path.join(root, 'data', 'app.db'),
  },

  // ---- Azure AD (Microsoft Entra ID) ------------------------------------
  azure: {
    tenantId: process.env.AZURE_TENANT_ID || '',
    clientId: process.env.AZURE_CLIENT_ID || '',
    clientSecret: process.env.AZURE_CLIENT_SECRET || '',
    // "common" for multi-tenant, or the tenant GUID for single-tenant.
    authority: process.env.AZURE_AUTHORITY || 'https://login.microsoftonline.com',
    redirectPath: process.env.AZURE_REDIRECT_PATH || '/auth/callback',
    postLogoutPath: '/',
    scopes: (process.env.AZURE_SCOPES || 'openid profile email offline_access').split(/\s+/).filter(Boolean),
    // Azure AD app-role value  ->  application role
    roleMap: safeJson(process.env.AZURE_ROLE_MAP, {
      'Shop.Admin': 'admin',
      'Shop.Sales': 'sales',
      'Shop.Customer': 'customer',
    }),
    defaultRole: process.env.AZURE_DEFAULT_ROLE || 'customer',
  },

  // ---- Licensing --------------------------------------------------------
  license: {
    // Long-lived subscription end date is inside the token; the token itself is
    // short-lived so revocation propagates without an always-online check.
    tokenTtlDays: int(process.env.LICENSE_TOKEN_TTL_DAYS, 7),
    // Grace period appended to ends_at before the app hard-stops.
    graceDays: int(process.env.LICENSE_GRACE_DAYS, 14),
    issuer: process.env.LICENSE_ISSUER || 'https://licenses.example.com',
    keyDir: process.env.LICENSE_KEY_DIR || path.join(root, 'data', 'keys'),
    // Server-to-server API keys for the license API (webshop -> license server).
    apiKeys: (process.env.LICENSE_API_KEYS || 'demo-shop-key').split(',').map((s) => s.trim()).filter(Boolean),
  },

  // ---- Payments ---------------------------------------------------------
  payments: {
    provider: process.env.PAYMENT_PROVIDER || 'mock', // 'mock' | 'stripe'
    stripeSecretKey: process.env.STRIPE_SECRET_KEY || '',
    stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET || '',
    currency: process.env.CURRENCY || 'EUR',
  },

  quotes: {
    validDays: int(process.env.QUOTE_VALID_DAYS, 30),
    // Discounts above this need a sales/admin approval before checkout.
    approvalThresholdPct: int(process.env.QUOTE_APPROVAL_PCT, 20),
  },
};

function safeJson(raw, fallback) {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

config.azure.configured = Boolean(config.azure.tenantId && config.azure.clientId && config.azure.clientSecret);
config.azure.redirectUri = config.publicUrl + config.azure.redirectPath;

module.exports = config;
