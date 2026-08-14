# Deployment

## Requirements

- Node 20 or newer
- A persistent disk (SQLite database + the private signing keys)
- TLS in front — a reverse proxy is fine, the app trusts one proxy hop

A 1 GB VPS runs this comfortably. There is nothing here that needs a cluster.

## First run

```bash
git clone <repo> /opt/cpq && cd /opt/cpq
npm ci --omit=dev
cp .env.example .env      # fill it in
mkdir -p /var/lib/cpq/keys && chmod 700 /var/lib/cpq/keys
node server.js
```

On first boot the server creates the SQLite schema, seeds the demo catalogue if
the product table is empty, and mints the first Ed25519 signing key.

## systemd

```ini
[Unit]
Description=CPQ webshop and license server
After=network.target

[Service]
Type=simple
User=cpq
WorkingDirectory=/opt/cpq
EnvironmentFile=/opt/cpq/.env
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=5
# The private signing keys and the database are the only writable paths.
ProtectSystem=strict
ReadWritePaths=/var/lib/cpq
PrivateTmp=true
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
```

## nginx

```nginx
server {
    listen 443 ssl http2;
    server_name shop.example.com;

    ssl_certificate     /etc/letsencrypt/live/shop.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/shop.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Set `SESSION_SECURE=true` once you are behind https, or the session cookie will
not survive.

---

## The one thing you must back up

`LICENSE_KEY_DIR` — the Ed25519 private keys.

Lose them and every license token in the field becomes unverifiable against a
newly generated key: every customer's software stops at the end of its current
token lifetime, and there is no way to re-sign without shipping a new build of
your application with a new public key.

```bash
# nightly, to somewhere that is not this machine
tar czf - -C /var/lib/cpq keys | gpg -e -r ops@example.com > keys-$(date +%F).tar.gz.gpg
```

The database matters too, but a database can be rebuilt from payment records
and re-issued licenses. The signing key cannot be rebuilt from anything.

## Key rotation

**Admin → Overview → Rotate signing key.**

New tokens are signed with the new key immediately. The old key is marked
retired but stays in the published JWKS, so tokens already on customer machines
keep verifying until they expire (default 7 days). After that window the old key
can be dropped.

Applications that embed a single public key need a build with the new key
*before* you rotate. Ship the new key first, wait for adoption, then rotate.

## Stripe

1. Set `PAYMENT_PROVIDER=stripe` and `STRIPE_SECRET_KEY`.
2. Add a webhook endpoint at `https://shop.example.com/webhooks/stripe` for
   `checkout.session.completed` and `charge.refunded`.
3. Put the signing secret in `STRIPE_WEBHOOK_SECRET`.

The webhook signature is verified over the raw body with a 5-minute freshness
window, and `markOrderPaid` is idempotent, so Stripe's retries are safe.

Renewals are charged by this application's own worker against the saved payment
method, not by a Stripe subscription object. That is deliberate: the CPQ engine
stays the single source of truth for what a configured product costs, instead of
splitting pricing between your rules and Stripe's price catalogue.

## Bridging to a different license server

If licenses are issued by something else, leave the built-in server running for
its API surface and point the bridge outward:

```
LICENSE_SERVER_URL=https://licenses.internal.example.com
LICENSE_SERVER_TOKEN=...
LICENSE_SERVER_AUTH_HEADER=Api-Token
LICENSE_SERVER_ENDPOINTS={"issue":"POST /v1/licenses","update":"PATCH /v1/licenses/{licenseId}","renew":"POST /v1/licenses/{licenseId}/renew","revoke":"POST /v1/licenses/{licenseId}/revoke"}
```

The queue, the idempotency keys, the retries and the admin visibility all work
the same way; only the destination changes.

## Monitoring

Watch these three:

| What | Where | Why |
|---|---|---|
| Failed license jobs | `GET /api/admin/stats` → `jobs_failed` | a customer paid and did not get a license |
| Pending jobs older than a few minutes | `jobs_pending` | the license server is unreachable |
| Azure AD client secret expiry | your calendar | sign-in stops dead when it expires |

`/api/v1/health` is a suitable liveness probe.

## Security notes

- No local passwords exist. The only session source is a verified Azure AD
  id_token (or, when `DEMO_MODE=true`, the demo stub — which returns 404 when
  demo mode is off).
- Sessions are httpOnly, sameSite=lax, and secure when configured.
- A strict CSP is set; the storefront loads no third-party scripts.
- The server-to-server license API needs an `Api-Token`; rotate those keys by
  editing `LICENSE_API_KEYS` and restarting.
- Prices are never trusted from the browser. Every price shown is computed by
  the server, and checkout re-reads the stored quote rather than anything the
  client sends.
- Discounts above `QUOTE_APPROVAL_PCT` cannot be checked out until a user with
  the sales or admin role approves them.
