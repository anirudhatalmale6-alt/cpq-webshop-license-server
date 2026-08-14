import { api, el, money, money2, mountNav, toast } from '/app.js';

const sku = new URLSearchParams(location.search).get('sku');
const s = await mountNav('/');
const product = await api.get(`/api/products/${encodeURIComponent(sku)}`);

document.title = `${product.name} — configure`;
document.getElementById('head').append(
  el('div', { style: 'margin-bottom:20px' },
    el('a', { href: '/', class: 'small' }, '← Catalogue'),
    el('h1', { style: 'margin-top:6px' }, product.name),
    el('p', { class: 'lead' }, product.description))
);

let config = {};
let discountPct = 0;
let latest = null;
let pending = null;

const optionsBox = document.getElementById('options');
const quoteBox = document.getElementById('quote');
const licenseBox = document.getElementById('licensePreview');

function unitLabel(opt) {
  return opt.unit || 'users';
}

async function repriceNow() {
  const res = await api.send(`/api/products/${encodeURIComponent(sku)}/price`, { config, discountPct });
  latest = res;
  config = res.config;
  renderOptions();
  renderQuote();
  renderLicense();
}

function reprice() {
  clearTimeout(pending);
  pending = setTimeout(() => repriceNow().catch((err) => toast(err.message, 'bad')), 90);
}

// ---- Options ---------------------------------------------------------------

function renderOptions() {
  const blocked = latest ? latest.blocked : {};
  const frag = document.createDocumentFragment();

  for (const opt of product.model.options) {
    const group = el('div', { class: 'optgroup' },
      el('div', { class: 'label' }, opt.label));

    if (opt.type === 'quantity') {
      const tier = latest ? latest.pricing.volume_tier : null;
      group.append(
        el('div', { class: 'hint' },
          tier && tier.discount_pct
            ? `${tier.discount_pct}% volume discount applies at ${tier.min}+ ${unitLabel(opt)}`
            : `Volume discounts start at ${(product.model.volume_tiers.find((t) => t.discount_pct > 0) || {}).min || '—'} ${unitLabel(opt)}`),
        el('div', { class: 'qty' },
          el('button', { onclick: () => { config[opt.id] = Math.max(opt.min, (config[opt.id] || 1) - 1); reprice(); } }, '−'),
          el('input', {
            type: 'number', value: config[opt.id] ?? opt.default, min: opt.min, max: opt.max,
            oninput: (e) => { config[opt.id] = Number(e.target.value); reprice(); },
          }),
          el('button', { onclick: () => { config[opt.id] = Math.min(opt.max, (config[opt.id] || 1) + 1); reprice(); } }, '+'),
          el('span', { class: 'muted small' }, unitLabel(opt)))
      );
      frag.append(group);
      continue;
    }

    const choices = el('div', { class: 'choices' });
    for (const c of opt.choices || []) {
      const isBlocked = blocked[`${opt.id}:${c.id}`];
      const selected = opt.type === 'multiselect'
        ? (config[opt.id] || []).includes(c.id)
        : config[opt.id] === c.id;

      const priceText = c.price_per_seat_year
        ? `${money(c.price_per_seat_year * 100, product.currency)}/${unitLabel(opt).replace(/s$/, '')}/yr`
        : c.price_flat_year
          ? `${money(c.price_flat_year * 100, product.currency)}/yr`
          : c.uplift_pct
            ? `+${c.uplift_pct}%`
            : c.discount_pct
              ? `−${c.discount_pct}%`
              : '';

      choices.append(
        el('div', {
          class: `choice${selected ? ' selected' : ''}${isBlocked ? ' blocked' : ''}`,
          onclick: () => {
            if (isBlocked) return;
            if (opt.type === 'multiselect') {
              const set = new Set(config[opt.id] || []);
              set.has(c.id) ? set.delete(c.id) : set.add(c.id);
              config[opt.id] = [...set];
            } else {
              config[opt.id] = c.id;
            }
            reprice();
          },
        },
          el('div', { class: 'name' }, el('span', {}, c.label), priceText && el('span', { class: 'price' }, priceText)),
          c.blurb && el('div', { class: 'blurb' }, c.blurb),
          isBlocked && el('div', { class: 'why' }, isBlocked))
      );
    }
    group.append(choices);
    frag.append(group);
  }

  optionsBox.replaceChildren(frag);
}

// ---- Quote panel -----------------------------------------------------------

function renderQuote() {
  const p = latest.pricing;
  const box = el('div', { class: 'stack' },
    el('div', { class: 'spread' }, el('h2', { style: 'margin:0' }, 'Your quote'), el('span', { class: 'badge accent' }, p.term_label)));

  const lines = el('div', {});
  for (const line of p.lines) {
    lines.append(
      el('div', { class: `qline${line.kind === 'discount' ? ' discount' : ''}` },
        el('div', { class: 'l' }, el('div', {}, line.label), line.detail && el('div', { class: 'd' }, line.detail)),
        el('div', { class: 'v' }, money2(line.amount_cents, p.currency)))
    );
  }
  box.append(lines);

  box.append(
    el('div', { class: 'qtotal' },
      el('div', {}, el('div', { style: 'font-weight:600' }, 'Total today'),
        el('div', { class: 'small muted' }, `${p.term_label} term · renews at ${money2(p.renewal_cents, p.currency)}`)),
      el('div', { class: 'v' }, money2(p.total_cents, p.currency)))
  );

  if (p.effective_discount_pct > 0) {
    box.append(el('div', { class: 'notice good small' },
      `You save ${money2(p.list_total_cents - p.total_cents, p.currency)} (${p.effective_discount_pct}%) against list price.`));
  }

  if (latest.discount_allowed) {
    box.append(
      el('label', { class: 'field' },
        el('span', {}, 'Sales discount %'),
        el('input', {
          type: 'number', min: 0, max: 100, value: discountPct,
          oninput: (e) => { discountPct = Number(e.target.value) || 0; reprice(); },
        })),
      p.needs_approval && el('div', { class: 'notice warn small' },
        'Above the approval threshold — this quote will be created as “pending approval” and cannot be checked out until a manager approves it.')
    );
  }

  if (!latest.valid) {
    box.append(el('div', { class: 'notice bad small' },
      el('div', { style: 'font-weight:600;margin-bottom:4px' }, 'Configuration is not valid'),
      el('ul', { style: 'margin:0;padding-left:18px' }, latest.errors.map((e) => el('li', {}, e.message)))));
  }

  const actions = el('div', { class: 'stack' });
  if (!s.signedIn) {
    actions.append(
      el('a', { class: 'btn primary', style: 'display:block;text-align:center', href: '/auth/login?returnTo=' + encodeURIComponent(location.pathname + location.search) },
        'Sign in with Microsoft to continue'),
      el('div', { class: 'small muted', style: 'text-align:center' }, 'Pricing is public; quoting and checkout require sign-in.'));
  } else {
    const btn = el('button', {
      class: 'primary',
      style: 'width:100%;padding:12px',
      disabled: !latest.valid,
      onclick: async () => {
        btn.disabled = true;
        btn.textContent = 'Creating quote…';
        try {
          const quote = await api.send('/api/quotes', { sku, config, discountPct });
          location.href = `/quote.html?id=${quote.id}`;
        } catch (err) {
          toast(err.message, 'bad');
          btn.disabled = false;
          btn.textContent = 'Create quote';
        }
      },
    }, 'Create quote');
    actions.append(btn, el('div', { class: 'small muted', style: 'text-align:center' }, `Quote is valid for 30 days.`));
  }
  box.append(actions);

  quoteBox.replaceChildren(box);
}

// ---- What the license will contain ----------------------------------------

function renderLicense() {
  const lp = latest.license_preview;
  licenseBox.replaceChildren(
    el('h3', {}, 'License that will be issued'),
    el('p', { class: 'small muted', style: 'margin-top:-4px' },
      'Derived from the configuration above by the same code that runs at checkout — what you see here is exactly what lands in the signed token.'),
    el('div', { class: 'grid cols-2' },
      el('div', {},
        el('table', {},
          el('tbody', {},
            el('tr', {}, el('td', { class: 'muted' }, 'Product'), el('td', { class: 'mono' }, lp.sku)),
            el('tr', {}, el('td', { class: 'muted' }, 'Edition'), el('td', { class: 'mono' }, lp.edition || '—')),
            el('tr', {}, el('td', { class: 'muted' }, 'Seats'), el('td', { class: 'mono' }, lp.seats)),
            el('tr', {}, el('td', { class: 'muted' }, 'Term'), el('td', { class: 'mono' }, `${lp.termMonths} months`)),
            el('tr', {}, el('td', { class: 'muted' }, 'Modules'), el('td', { class: 'mono' }, lp.modules.join(', ') || '—'))))),
      el('div', {},
        el('div', { class: 'small muted', style: 'margin-bottom:6px' }, 'Feature flags in the token'),
        el('pre', { class: 'code' }, JSON.stringify(lp.features, null, 2))))
  );
}

await repriceNow();
