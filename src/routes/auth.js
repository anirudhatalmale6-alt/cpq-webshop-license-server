'use strict';

const express = require('express');
const config = require('../config');
const auth = require('../auth');
const { audit } = require('../db');

const router = express.Router();

router.get('/me', (req, res) => {
  if (!req.user) return res.json({ signedIn: false, demoMode: config.demoMode, azureConfigured: config.azure.configured });
  res.json({
    signedIn: true,
    demoMode: config.demoMode,
    azureConfigured: config.azure.configured,
    user: {
      id: req.user.id,
      name: req.user.name,
      email: req.user.email,
      role: req.user.role,
      accountId: req.user.account_id,
      tenantId: req.user.tenant_id,
    },
  });
});

router.get('/login', async (req, res) => {
  const returnTo = typeof req.query.returnTo === 'string' ? req.query.returnTo : '/';
  if (!config.azure.configured) {
    if (config.demoMode) return res.redirect('/signin.html?returnTo=' + encodeURIComponent(returnTo));
    return res.status(500).send('Azure AD is not configured on this deployment.');
  }
  try {
    res.redirect(await auth.buildAuthUrl(req, returnTo));
  } catch (err) {
    res.status(500).send('Could not start sign-in: ' + err.message);
  }
});

// This router is mounted at /auth, so this handles the default redirect URI
// /auth/callback. If you change AZURE_REDIRECT_PATH, keep the /auth prefix.
router.get('/callback', async (req, res) => {
  try {
    const { user, returnTo } = await auth.handleCallback(req);
    req.session.userId = user.id;
    res.redirect(returnTo || '/');
  } catch (err) {
    res.status(401).send('Sign-in failed: ' + err.message);
  }
});

// Demo stub. Returns 404 when DEMO_MODE is off, so it cannot exist in production.
router.post('/demo', (req, res) => {
  if (!config.demoMode) return res.status(404).json({ error: 'not_found' });
  const user = auth.demoSignIn(String((req.body && req.body.persona) || 'customer'), req);
  req.session.userId = user.id;
  res.json({ ok: true, user: { id: user.id, name: user.name, email: user.email, role: user.role } });
});

router.get('/personas', (req, res) => {
  if (!config.demoMode) return res.status(404).json({ error: 'not_found' });
  res.json(
    Object.entries(auth.DEMO_PERSONAS).map(([key, p]) => ({
      key,
      name: p.name,
      email: p.email,
      role: auth.mapRole(p.roles),
      tenant: p.tenant,
    }))
  );
});

router.post('/logout', (req, res) => {
  if (req.user) audit({ actor: req.user.email, action: 'user.signout', entityType: 'user', entityId: req.user.id });
  req.session.destroy(() => res.json({ ok: true }));
});

router.get('/logout', (req, res) => {
  const done = () => {
    if (config.azure.configured) {
      const url = `${config.azure.authority}/${config.azure.tenantId || 'common'}/oauth2/v2.0/logout` +
        `?post_logout_redirect_uri=${encodeURIComponent(config.publicUrl + config.azure.postLogoutPath)}`;
      return res.redirect(url);
    }
    res.redirect('/');
  };
  req.session.destroy(done);
});

module.exports = router;
