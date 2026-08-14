import { api, el, money2, date, mountNav, toast, statusBadge } from '/app.js';

const id = new URLSearchParams(location.search).get('id');
const s = await mountNav('/');
const root = document.getElementById('root');

async function render() {
  const q = await api.get(`/api/quotes/${encodeURIComponent(id)}`);
  const p = q.pricing;
  const isStaff = s.signedIn && ['sales', 'admin'].includes(s.user.role);

  const lines = el('div', {});
  for (const line of p.lines) {
    lines.append(
      el('div', { class: `qline${line.kind === 'discount' ? ' discount' : ''}` },
        el('div', { class: 'l' }, el('div', {}, line.label), line.detail && el('div', { class: 'd' }, line.detail)),
        el('div', { class: 'v' }, money2(line.amount_cents, p.currency)))
    );
  }

  const actions = el('div', { class: 'row', style: 'margin-top:18px' });

  if (q.status === 'pending_approval') {
    if (isStaff) {
      actions.append(
        el('button', {
          class: 'primary',
          onclick: async () => { await api.send(`/api/quotes/${q.id}/approve`, { approve: true }); render(); },
        }, 'Approve discount'),
        el('button', {
          class: 'danger',
          onclick: async () => { await api.send(`/api/quotes/${q.id}/approve`, { approve: false }); render(); },
        }, 'Reject')
      );
    } else {
      actions.append(el('div', { class: 'notice warn' }, 'Waiting for sales approval before this quote can be checked out.'));
    }
  } else if (q.status === 'ordered') {
    actions.append(el('a', { class: 'btn', href: '/account.html' }, 'View my licenses'));
  } else {
    const btn = el('button', {
      class: 'primary',
      style: 'padding:11px 22px',
      onclick: async () => {
        btn.disabled = true;
        btn.textContent = 'Redirecting to payment…';
        try {
          const res = await api.send('/api/checkout', { quoteId: q.id });
          location.href = res.redirectUrl;
        } catch (err) {
          toast(err.message, 'bad');
          btn.disabled = false;
          btn.textContent = 'Proceed to checkout';
        }
      },
    }, 'Proceed to checkout');
    actions.append(btn, el('a', { class: 'btn', href: `/configure.html?sku=${encodeURIComponent(q.sku)}` }, 'Reconfigure'));
  }

  root.replaceChildren(
    el('div', { style: 'margin-bottom:18px' },
      el('a', { href: '/', class: 'small' }, '← Catalogue'),
      el('div', { class: 'spread', style: 'margin-top:8px' },
        el('h1', { style: 'margin:0' }, `Quote ${q.number}`),
        statusBadge(q.status)),
      el('p', { class: 'muted small', style: 'margin:6px 0 0' },
        `${q.sku} · created ${date(q.created_at)} · valid until ${date(q.expires_at)}`)),

    el('div', { class: 'card' },
      lines,
      el('div', { class: 'qtotal' },
        el('div', {},
          el('div', { style: 'font-weight:600' }, 'Total today'),
          el('div', { class: 'small muted' }, `renews at ${money2(p.renewal_cents, p.currency)} every ${p.term_months} months`)),
        el('div', { class: 'v' }, money2(q.total_cents, p.currency))),
      actions),

    el('div', { class: 'card', style: 'margin-top:16px' },
      el('h3', {}, 'Configuration'),
      el('pre', { class: 'code' }, JSON.stringify(q.config, null, 2)))
  );
}

await render();
