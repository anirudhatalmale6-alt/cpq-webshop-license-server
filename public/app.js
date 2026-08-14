/* Shared helpers: session state, the nav bar, formatting. */

export const api = {
  async get(path) {
    const res = await fetch(path, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw await toError(res);
    return res.json();
  },
  async send(path, body, method = 'POST') {
    const res = await fetch(path, {
      method,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) throw await toError(res);
    return res.json();
  },
};

async function toError(res) {
  let payload = {};
  try { payload = await res.json(); } catch { /* not JSON */ }
  const err = new Error(payload.message || payload.error || `${res.status} ${res.statusText}`);
  err.status = res.status;
  err.payload = payload;
  return err;
}

export function money(cents, currency = 'EUR') {
  return new Intl.NumberFormat(navigator.language || 'en-GB', {
    style: 'currency',
    currency,
    maximumFractionDigits: 0,
  }).format((cents || 0) / 100);
}

export function money2(cents, currency = 'EUR') {
  return new Intl.NumberFormat(navigator.language || 'en-GB', { style: 'currency', currency }).format((cents || 0) / 100);
}

export function date(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString(navigator.language || 'en-GB', { year: 'numeric', month: 'short', day: 'numeric' });
}

export function dateTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString(navigator.language || 'en-GB', { dateStyle: 'medium', timeStyle: 'short' });
}

export function daysFromNow(iso) {
  if (!iso) return null;
  return Math.round((new Date(iso) - Date.now()) / 86400000);
}

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined && v !== false) node.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return node;
}

let sessionCache = null;
export async function session(force = false) {
  if (!sessionCache || force) sessionCache = await api.get('/auth/me');
  return sessionCache;
}

const NAV = [
  { href: '/', label: 'Catalogue' },
  { href: '/account.html', label: 'My licenses', auth: true },
  { href: '/activation.html', label: 'Activation demo' },
  { href: '/admin.html', label: 'Admin', roles: ['admin', 'sales'] },
];

export async function mountNav(current) {
  const s = await session();
  const bar = el('header', { class: 'topbar' },
    el('a', { class: 'brand', href: '/' }, el('span', { class: 'dot' }), 'Atlas Store'),
    el('nav', {},
      NAV.filter((n) => {
        if (n.roles) return s.signedIn && n.roles.includes(s.user.role);
        if (n.auth) return s.signedIn;
        return true;
      }).map((n) => el('a', { href: n.href, class: n.href === current ? 'active' : '' }, n.label))
    ),
    s.signedIn
      ? el('div', { class: 'who' },
          el('span', {}, el('strong', {}, s.user.name), ` · ${s.user.role}`),
          el('button', {
            class: 'small',
            onclick: async () => { await api.send('/auth/logout'); location.href = '/'; },
          }, 'Sign out'))
      : el('div', { class: 'who' },
          el('a', { class: 'btn primary', href: '/auth/login?returnTo=' + encodeURIComponent(location.pathname + location.search) },
            'Sign in with Microsoft'))
  );
  document.body.prepend(bar);
  return s;
}

export function toast(message, kind = 'info') {
  const t = el('div', {
    class: `notice ${kind}`,
    style: 'position:fixed;bottom:22px;left:50%;transform:translateX(-50%);z-index:99;box-shadow:0 6px 24px rgba(0,0,0,.16);max-width:min(560px,90vw)',
  }, message);
  document.body.append(t);
  setTimeout(() => t.remove(), 5200);
}

export function statusBadge(status) {
  const map = {
    active: 'good', paid: 'good', done: 'good', approved: 'good',
    pending: 'warn', past_due: 'warn', pending_approval: 'warn', suspended: 'warn', draft: '',
    revoked: 'bad', failed: 'bad', expired: 'bad', cancelled: 'bad', rejected: 'bad',
  };
  return el('span', { class: `badge ${map[status] ?? ''}` }, String(status || '').replace(/_/g, ' '));
}
