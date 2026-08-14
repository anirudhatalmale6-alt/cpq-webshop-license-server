import { api, el, money2, date, mountNav } from '/app.js';

await mountNav('/');
const params = new URLSearchParams(location.search);
const orderId = params.get('order');
const root = document.getElementById('root');

try {
  const res = await api.send('/api/checkout/confirm', { orderId });
  const license = res.license;

  root.replaceChildren(
    el('div', { class: 'notice good', style: 'margin-bottom:20px' },
      res.alreadyProcessed
        ? 'This order was already processed — no second license was issued (the checkout is idempotent).'
        : 'Payment received. Your license was issued automatically.'),

    el('h1', {}, 'Order complete'),
    el('p', { class: 'lead' },
      `Order ${res.order.number} · ${money2(res.order.total_cents, res.order.currency)} · paid ${date(res.order.paid_at)}`),

    license
      ? el('div', { class: 'card stack' },
          el('h2', { style: 'margin:0' }, 'Your license key'),
          el('div', { class: 'keychip', style: 'font-size:17px;padding:10px 16px' }, license.license_key),
          el('table', {},
            el('tbody', {},
              el('tr', {}, el('td', { class: 'muted' }, 'Product'), el('td', {}, `${license.sku} — ${license.edition || ''}`)),
              el('tr', {}, el('td', { class: 'muted' }, 'Seats'), el('td', {}, license.seats)),
              el('tr', {}, el('td', { class: 'muted' }, 'Modules'), el('td', {}, license.modules.join(', ') || '—')),
              el('tr', {}, el('td', { class: 'muted' }, 'Valid until'), el('td', {}, date(license.ends_at))))),
          el('div', { class: 'row' },
            el('a', { class: 'btn primary', href: '/account.html' }, 'Manage licenses and devices'),
            el('a', { class: 'btn', href: `/activation.html?key=${encodeURIComponent(license.license_key)}` }, 'Try activating it')))
      : el('div', { class: 'notice warn' },
          'Payment is recorded and the license issue job is queued. It will appear in your account within a few seconds — ' +
          'the bridge retries automatically if the license server is briefly unreachable.')
  );
} catch (err) {
  root.replaceChildren(
    el('div', { class: 'notice bad' }, 'Could not confirm this order: ' + err.message),
    el('p', {}, el('a', { href: '/account.html' }, 'Go to my licenses'))
  );
}
