import { api, el, money, mountNav } from '/app.js';

const s = await mountNav('/');
const cfg = await api.get('/api/config');

if (cfg.demoMode && !s.signedIn) {
  document.getElementById('banner').append(
    el('div', { class: 'notice info', style: 'margin-bottom:22px' },
      'Demo mode: Azure AD is not wired to a tenant yet, so ',
      el('a', { href: '/signin.html' }, 'sign in with a demo persona'),
      ' to walk through the full flow. Point AZURE_TENANT_ID / CLIENT_ID / CLIENT_SECRET at a real tenant and this stub disappears.')
  );
}

const products = await api.get('/api/products');
const root = document.getElementById('catalogue');
root.replaceChildren();

for (const p of products) {
  const editions = (p.model.options.find((o) => o.id === 'edition') || { choices: [] }).choices;
  const from = Math.min(...editions.map((e) => e.price_per_seat_year || 0));
  const seatOpt = p.model.options.find((o) => o.type === 'quantity');

  root.append(
    el('div', { class: 'card stack' },
      el('div', {},
        el('div', { class: 'spread' },
          el('h2', { style: 'margin:0' }, p.name),
          el('span', { class: 'badge accent' }, p.sku)),
        el('p', { class: 'muted small', style: 'margin:6px 0 0' }, p.summary)),
      el('div', { class: 'row small muted' },
        el('span', {}, `${editions.length} editions`),
        el('span', {}, '·'),
        el('span', {}, `${((p.model.options.find((o) => o.id === 'modules') || { choices: [] }).choices).length} add-on modules`),
        el('span', {}, '·'),
        el('span', {}, `${p.model.volume_tiers.length} volume tiers`)),
      el('div', { class: 'spread' },
        el('div', {},
          el('div', { class: 'small muted' }, 'from'),
          el('div', { style: 'font-size:20px;font-weight:700;letter-spacing:-.4px' },
            money(from * 100, p.currency),
            el('span', { class: 'small muted', style: 'font-weight:400' }, ` / ${seatOpt ? seatOpt.unit.replace(/s$/, '') : 'user'} / year`))),
        el('a', { class: 'btn primary', href: `/configure.html?sku=${encodeURIComponent(p.sku)}` }, 'Configure')))
  );
}
