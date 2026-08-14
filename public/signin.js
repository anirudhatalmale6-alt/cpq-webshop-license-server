import { api, el, mountNav, toast } from '/app.js';

await mountNav('/signin.html');
const cfg = await api.get('/api/config');
const returnTo = new URLSearchParams(location.search).get('returnTo') || '/';

const real = document.getElementById('real');
real.append(
  el('a', {
    class: 'btn primary',
    style: 'display:block;text-align:center;padding:12px',
    href: '/auth/login?returnTo=' + encodeURIComponent(returnTo),
  }, 'Sign in with Microsoft'),
  el('p', { class: 'small muted', style: 'margin:0' },
    cfg.azureConfigured
      ? 'Azure AD is configured on this deployment. This starts the real authorization-code + PKCE flow.'
      : 'Azure AD is not configured yet, so this button falls back to the demo personas below. ' +
        'Set AZURE_TENANT_ID, AZURE_CLIENT_ID and AZURE_CLIENT_SECRET to use a real tenant.')
);

if (cfg.demoMode) {
  const personas = await api.get('/auth/personas');
  const box = el('div', { class: 'card stack', style: 'margin-top:16px' },
    el('h3', {}, 'Demo personas'),
    el('p', { class: 'small muted', style: 'margin:0' },
      'Each persona stands in for an Azure AD user with a different app role. The two Northwind ' +
      'users share a tenant, which is how they end up on the same customer account and see the same licenses.'));

  for (const p of personas) {
    box.append(
      el('button', {
        class: 'persona',
        onclick: async () => {
          try {
            await api.send('/auth/demo', { persona: p.key });
            location.href = returnTo;
          } catch (err) {
            toast(err.message, 'bad');
          }
        },
      },
        el('span', { class: 'av' }, p.name.split(' ').map((w) => w[0]).join('').slice(0, 2)),
        el('span', { class: 'who2' },
          el('span', { class: 'n' }, p.name),
          el('span', { class: 'e' }, `${p.email} · tenant ${p.tenant}`)),
        el('span', { class: 'badge' }, p.role))
    );
  }
  document.getElementById('demo').append(box);
}
