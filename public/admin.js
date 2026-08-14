import { api, el, money2, date, dateTime, mountNav, toast, statusBadge } from '/app.js';

const s = await mountNav('/admin.html');
const view = document.getElementById('view');
const tabsBox = document.getElementById('tabs');

if (!s.signedIn || !['admin', 'sales'].includes(s.user.role)) {
  view.replaceChildren(el('div', { class: 'notice bad' },
    'This page needs the Shop.Admin or Shop.Sales app role in Azure AD. ',
    el('a', { href: '/signin.html' }, 'Switch user')));
} else {
  const TABS = [
    ['overview', 'Overview', renderOverview],
    ['licenses', 'Licenses', renderLicenses],
    ['subscriptions', 'Subscriptions', renderSubscriptions],
    ['jobs', 'License server bridge', renderJobs],
    ['products', 'Products & pricing', renderProducts],
    ['audit', 'Audit trail', renderAudit],
  ];
  let active = location.hash.slice(1) || 'overview';

  function paint() {
    tabsBox.replaceChildren(...TABS.map(([id, label]) =>
      el('button', {
        class: id === active ? 'active' : '',
        onclick: () => { active = id; location.hash = id; paint(); },
      }, label)));
    view.replaceChildren(el('div', { class: 'spinner' }, 'Loading…'));
    const tab = TABS.find((t) => t[0] === active) || TABS[0];
    tab[2]().catch((err) => view.replaceChildren(el('div', { class: 'notice bad' }, err.message)));
  }
  paint();
}

// ---------------------------------------------------------------------------

async function renderOverview() {
  const [stats, cfg] = await Promise.all([api.get('/api/admin/stats'), api.get('/api/config')]);
  const stat = (t, n, sub) => el('div', { class: 'card stat' },
    el('div', { class: 't' }, t), el('div', { class: 'n' }, n), sub && el('div', { class: 'small muted' }, sub));

  view.replaceChildren(
    el('div', { class: 'grid cols-3' },
      stat('Active subscriptions', stats.subscriptions_active),
      stat('Monthly recurring revenue', money2(Math.round(stats.mrr_cents), cfg.currency), 'normalised from all terms'),
      stat('Active licenses', stats.licenses_active),
      stat('Device activations', stats.activations),
      stat('Paid orders', stats.orders_paid),
      stat('Quotes created', stats.quotes)),

    el('div', { class: 'card', style: 'margin-top:16px' },
      el('h3', {}, 'Deployment'),
      el('table', {}, el('tbody', {},
        r('Azure AD', cfg.azureConfigured ? 'configured — real SSO' : 'not configured — demo sign-in active'),
        r('Payments', cfg.paymentProvider),
        r('License server adapter', cfg.licenseAdapter + (cfg.licenseAdapter === 'local' ? ' (built-in)' : ' (external HTTP)')),
        r('Token lifetime', cfg.tokenTtlDays + ' days'),
        r('Grace period', cfg.graceDays + ' days'),
        r('Queued license jobs', `${stats.jobs_pending} pending, ${stats.jobs_failed} failed`)))),

    el('div', { class: 'card', style: 'margin-top:16px' },
      el('h3', {}, 'Signing keys'),
      el('div', { id: 'keys' }))
  );

  const keys = await api.get('/api/admin/signing-keys');
  document.getElementById('keys').replaceChildren(
    el('table', {},
      el('thead', {}, el('tr', {}, el('th', {}, 'Key ID'), el('th', {}, 'Status'), el('th', {}, 'Created'), el('th', {}, 'Retired'))),
      el('tbody', {}, keys.map((k) => el('tr', {},
        el('td', { class: 'mono' }, k.kid), el('td', {}, statusBadge(k.status)),
        el('td', { class: 'small' }, dateTime(k.created_at)), el('td', { class: 'small' }, k.retired_at ? dateTime(k.retired_at) : '—'))))),
    s.user.role === 'admin' ? el('div', { class: 'row', style: 'margin-top:12px' },
      el('button', {
        onclick: async () => {
          if (!confirm('Rotate the signing key? Existing tokens keep verifying until they expire.')) return;
          const res = await api.send('/api/admin/signing-keys/rotate');
          toast('New signing key ' + res.kid, 'good');
          renderOverview();
        },
      }, 'Rotate signing key'),
      el('a', { class: 'btn', href: '/api/v1/public-key.pem' }, 'Download public key')) : null
  );
}

function r(k, v) {
  return el('tr', {}, el('td', { class: 'muted', style: 'width:38%' }, k), el('td', {}, v));
}

// ---------------------------------------------------------------------------

async function renderLicenses() {
  const licenses = await api.get('/api/admin/licenses');
  const isAdmin = s.user.role === 'admin';

  view.replaceChildren(el('div', { class: 'card' },
    el('table', {},
      el('thead', {}, el('tr', {},
        el('th', {}, 'Key'), el('th', {}, 'Customer'), el('th', {}, 'Product'),
        el('th', { class: 'num' }, 'Seats'), el('th', {}, 'Ends'), el('th', {}, 'Status'), el('th', {}, ''))),
      el('tbody', {}, licenses.length ? licenses.map((l) => el('tr', {},
        el('td', {}, el('span', { class: 'keychip small' }, l.license_key)),
        el('td', {}, l.account_name || '—'),
        el('td', {}, el('div', {}, l.sku), el('div', { class: 'small muted' }, `${l.edition || ''} ${l.modules.join(', ')}`)),
        el('td', { class: 'num' }, `${l.seats_used}/${l.seats}`),
        el('td', { class: 'small' }, date(l.ends_at)),
        el('td', {}, statusBadge(l.effective_status)),
        el('td', {}, isAdmin ? el('div', { class: 'row' },
          l.status === 'revoked'
            ? el('button', { class: 'small', onclick: async () => { await api.send(`/api/admin/licenses/${l.id}/reinstate`); toast('Reinstated.', 'good'); renderLicenses(); } }, 'Reinstate')
            : el('button', { class: 'small danger', onclick: async () => {
                const reason = prompt('Reason for revoking?', 'chargeback');
                if (reason === null) return;
                await api.send(`/api/admin/licenses/${l.id}/revoke`, { reason });
                toast('Revoked. Devices stop at the next token refresh, and immediately if they are online.', 'info');
                renderLicenses();
              } }, 'Revoke'),
          el('button', { class: 'small', onclick: async () => {
            const seats = prompt('New seat count?', l.seats);
            if (!seats) return;
            await api.send(`/api/admin/licenses/${l.id}`, { seats: Number(seats) }, 'PATCH');
            toast('Seats updated.', 'good');
            renderLicenses();
          } }, 'Seats')) : null)))
        : el('tr', {}, el('td', { colspan: 7, class: 'muted' }, 'No licenses issued yet.'))))));
}

// ---------------------------------------------------------------------------

async function renderSubscriptions() {
  const subs = await api.get('/api/admin/subscriptions');
  view.replaceChildren(el('div', { class: 'card' },
    el('table', {},
      el('thead', {}, el('tr', {},
        el('th', {}, 'Subscription'), el('th', {}, 'Product'), el('th', { class: 'num' }, 'Renews at'),
        el('th', {}, 'Period ends'), el('th', {}, 'Status'), el('th', {}, ''))),
      el('tbody', {}, subs.length ? subs.map((sub) => el('tr', {},
        el('td', { class: 'mono small' }, sub.id),
        el('td', {}, sub.sku),
        el('td', { class: 'num' }, money2(sub.renewal_cents, sub.currency)),
        el('td', { class: 'small' }, date(sub.current_period_end)),
        el('td', {}, statusBadge(sub.status), sub.cancel_at_period_end ? el('span', { class: 'badge warn' }, 'ends at period') : null),
        el('td', {}, s.user.role === 'admin' ? el('div', { class: 'row' },
          el('button', { class: 'small', onclick: async () => {
            await api.send(`/api/admin/subscriptions/${sub.id}/renew-now`);
            toast('Renewal processed — the license end date moved forward.', 'good');
            renderSubscriptions();
          } }, 'Renew now'),
          el('button', { class: 'small danger', onclick: async () => {
            if (!confirm('Cancel immediately and revoke the license?')) return;
            await api.send(`/api/admin/subscriptions/${sub.id}/cancel`, { immediate: true });
            toast('Cancelled and license revoked.', 'info');
            renderSubscriptions();
          } }, 'Cancel now')) : null)))
        : el('tr', {}, el('td', { colspan: 6, class: 'muted' }, 'No subscriptions yet.'))))));
}

// ---------------------------------------------------------------------------

async function renderJobs() {
  const { adapter, jobs } = await api.get('/api/admin/jobs');
  view.replaceChildren(
    el('div', { class: 'notice info', style: 'margin-bottom:16px' },
      `Adapter: ${adapter}. Every issue, update, renew and revoke goes through this queue with an ` +
      'idempotency key, so a retried webhook cannot double-issue and a license server outage cannot lose a purchase.'),
    el('div', { class: 'card' },
      el('table', {},
        el('thead', {}, el('tr', {},
          el('th', {}, 'Job'), el('th', {}, 'Kind'), el('th', {}, 'Idempotency key'),
          el('th', { class: 'num' }, 'Attempts'), el('th', {}, 'Status'), el('th', {}, 'Result / error'), el('th', {}, ''))),
        el('tbody', {}, jobs.length ? jobs.map((j) => el('tr', {},
          el('td', { class: 'mono small' }, j.id),
          el('td', {}, j.kind),
          el('td', { class: 'mono small' }, j.idempotency_key),
          el('td', { class: 'num' }, j.attempts),
          el('td', {}, statusBadge(j.status)),
          el('td', {
            class: 'small mono',
            style: 'max-width:320px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap',
            title: j.last_error || j.result_json || '',
          }, j.last_error || (j.result_json || '').slice(0, 90)),
          el('td', {}, j.status !== 'done' && s.user.role === 'admin'
            ? el('button', { class: 'small', onclick: async () => { await api.send(`/api/admin/jobs/${j.id}/retry`); toast('Retried.', 'info'); renderJobs(); } }, 'Retry')
            : null)))
          : el('tr', {}, el('td', { colspan: 7, class: 'muted' }, 'No jobs yet.'))))));
}

// ---------------------------------------------------------------------------

async function renderProducts() {
  const products = await api.get('/api/admin/products');
  const list = el('div', { class: 'card stack' }, el('h3', {}, 'Products'));
  const editor = el('div', { class: 'card stack' });

  for (const p of products) {
    list.append(el('div', { class: 'spread', style: 'padding:8px 0;border-top:1px solid var(--border)' },
      el('div', {},
        el('div', { style: 'font-weight:600' }, p.name),
        el('div', { class: 'small muted mono' }, `${p.sku} · ${p.model.options.length} option groups`)),
      el('button', { class: 'small', onclick: () => openEditor(p) }, 'Edit model')));
  }

  function openEditor(p) {
    const area = el('textarea', { rows: 26, class: 'mono', style: 'font-size:12.5px' });
    area.value = JSON.stringify(p.model, null, 2);
    editor.replaceChildren(
      el('h3', {}, `Pricing model — ${p.sku}`),
      el('p', { class: 'small muted', style: 'margin:0' },
        'Editions, modules, volume tiers, compatibility rules and the mapping to license features. ' +
        'Saving validates the model by pricing its own defaults; a broken model is rejected before it can reach the storefront.'),
      area,
      el('div', { class: 'row' },
        el('button', {
          class: 'primary',
          onclick: async () => {
            let model;
            try { model = JSON.parse(area.value); } catch (err) { return toast('Invalid JSON: ' + err.message, 'bad'); }
            try {
              await api.send(`/api/admin/products/${encodeURIComponent(p.sku)}`, {
                name: p.name, summary: p.summary, description: p.description,
                currency: p.currency, active: p.active, sortOrder: p.sort_order, model,
              }, 'PUT');
              toast('Saved — live on the storefront immediately.', 'good');
            } catch (err) {
              toast(err.message, 'bad');
            }
          },
        }, 'Save model'),
        el('a', { class: 'btn', href: `/configure.html?sku=${encodeURIComponent(p.sku)}`, target: '_blank' }, 'Open configurator'))
    );
  }

  view.replaceChildren(el('div', { class: 'split' }, list, editor));
  if (products.length) openEditor(products[0]);
}

// ---------------------------------------------------------------------------

async function renderAudit() {
  const entries = await api.get('/api/admin/audit?limit=250');
  view.replaceChildren(el('div', { class: 'card' },
    el('table', {},
      el('thead', {}, el('tr', {}, el('th', {}, 'When'), el('th', {}, 'Actor'), el('th', {}, 'Action'), el('th', {}, 'Entity'), el('th', {}, 'Detail'))),
      el('tbody', {}, entries.map((e) => el('tr', {},
        el('td', { class: 'small' }, dateTime(e.at)),
        el('td', { class: 'small' }, e.actor),
        el('td', {}, el('span', { class: 'badge' }, e.action)),
        el('td', { class: 'mono small' }, e.entity_id || '—'),
        el('td', { class: 'mono small', style: 'max-width:420px;overflow:hidden;text-overflow:ellipsis' },
          e.detail ? JSON.stringify(e.detail) : '')))))));
}
