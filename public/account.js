import { api, el, money2, date, dateTime, daysFromNow, mountNav, toast, statusBadge } from '/app.js';

const s = await mountNav('/account.html');
const root = document.getElementById('root');

if (!s.signedIn) {
  root.replaceChildren(el('div', { class: 'notice info' },
    'Please ', el('a', { href: '/auth/login?returnTo=/account.html' }, 'sign in'), ' to see your licenses.'));
} else {
  await render();
}

async function render() {
  const [subs, licenses] = await Promise.all([api.get('/api/my/subscriptions'), api.get('/api/my/licenses')]);

  if (!licenses.length) {
    root.replaceChildren(el('div', { class: 'card' },
      el('p', { class: 'muted', style: 'margin:0' },
        'No licenses yet. ', el('a', { href: '/' }, 'Configure a product'), ' to get started.')));
    return;
  }

  const frag = document.createDocumentFragment();

  for (const license of licenses) {
    const sub = subs.find((x) => x.license && x.license.id === license.id);
    const remaining = daysFromNow(license.ends_at);

    const devices = el('table', {},
      el('thead', {}, el('tr', {},
        el('th', {}, 'Device'), el('th', {}, 'OS'), el('th', {}, 'Version'),
        el('th', {}, 'Activated'), el('th', {}, 'Last seen'), el('th', {}, ''))),
      el('tbody', {},
        license.activations.filter((a) => a.status === 'active').length
          ? license.activations.filter((a) => a.status === 'active').map((a) =>
              el('tr', {},
                el('td', {}, el('div', {}, a.hostname || 'unnamed'), el('div', { class: 'small muted mono' }, a.fingerprint.slice(0, 16) + '…')),
                el('td', {}, a.os || '—'),
                el('td', {}, a.app_version || '—'),
                el('td', { class: 'small' }, date(a.activated_at)),
                el('td', { class: 'small' }, dateTime(a.last_seen_at)),
                el('td', {},
                  el('button', {
                    class: 'small',
                    onclick: async () => {
                      await api.send(`/api/my/licenses/${license.id}/deactivate-device`, { activationId: a.id });
                      toast('Device released — the seat is free again.', 'good');
                      render();
                    },
                  }, 'Release seat'))))
          : el('tr', {}, el('td', { colspan: 6, class: 'muted small' }, 'No devices activated yet.'))));

    frag.append(
      el('div', { class: 'card stack', style: 'margin-bottom:16px' },
        el('div', { class: 'spread' },
          el('div', {},
            el('h2', { style: 'margin:0' }, license.sku),
            el('div', { class: 'small muted' }, `${license.edition || ''} · ${license.modules.join(', ') || 'no add-ons'}`)),
          el('div', { class: 'row' },
            statusBadge(license.effective_status),
            sub && sub.cancel_at_period_end ? el('span', { class: 'badge warn' }, 'cancels at period end') : null)),

        el('div', { class: 'row' },
          el('span', { class: 'keychip' }, license.license_key),
          el('button', {
            class: 'small',
            onclick: () => { navigator.clipboard.writeText(license.license_key); toast('License key copied.', 'good'); },
          }, 'Copy')),

        el('div', { class: 'grid cols-3' },
          stat('Seats', `${license.seats_used} / ${license.seats}`, 'in use'),
          stat('Renews', date(license.ends_at), remaining >= 0 ? `in ${remaining} days` : `${-remaining} days ago`),
          sub ? stat('Renewal price', money2(sub.renewal_cents, sub.currency), `every ${sub.term_months} months`) : null),

        el('div', {}, el('h3', {}, 'Activated devices'), devices),

        sub ? el('div', { class: 'row' },
          sub.cancel_at_period_end
            ? el('button', {
                onclick: async () => { await api.send(`/api/my/subscriptions/${sub.id}/resume`); toast('Auto-renew is back on.', 'good'); render(); },
              }, 'Resume auto-renew')
            : el('button', {
                class: 'danger',
                onclick: async () => {
                  if (!confirm('Cancel auto-renew? The license stays active until ' + date(sub.current_period_end) + '.')) return;
                  await api.send(`/api/my/subscriptions/${sub.id}/cancel`);
                  toast('Auto-renew cancelled. Your license runs to the end of the period.', 'info');
                  render();
                },
              }, 'Cancel auto-renew'),
          el('a', { class: 'btn', href: `/activation.html?key=${encodeURIComponent(license.license_key)}` }, 'Activation demo')) : null)
    );
  }

  root.replaceChildren(frag);
}

function stat(title, value, sub) {
  return el('div', { class: 'card stat', style: 'box-shadow:none' },
    el('div', { class: 't' }, title),
    el('div', { class: 'n' }, value),
    sub && el('div', { class: 'small muted' }, sub));
}
