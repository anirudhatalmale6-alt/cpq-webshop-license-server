# CPQ webshop + license server

A working reference implementation of the system described in the brief: a
subscription webshop with a CPQ flow, Microsoft Entra ID (Azure AD) as the only
way in, and a real-time bridge that issues, renews and revokes licenses.

It runs. `npm install && npm start` gives you a storefront you can click through,
buy from, and then activate the resulting license from a simulated customer
machine — including the offline signature check that would run inside your
software.

---

## The licensing model

This is the part worth reading before anything else, because everything else
follows from it.

A license is **two things**:

1. **A database row** — the source of truth. Seats, edition, modules, feature
   flags, start and end date, status.
2. **A short-lived Ed25519-signed token** — what the customer's software
   actually reads.

```
 ┌───────────┐  configure/price/quote  ┌──────────┐   payment    ┌───────────────┐
 │  Browser  │ ──────────────────────► │   Shop   │ ───────────► │ Payment (Stripe)│
 └───────────┘                         └────┬─────┘              └───────┬───────┘
       ▲  Entra ID SSO                      │                            │ webhook
       │                                    │ durable job queue          │
       │                                    ▼   (idempotent, retried)    ▼
       │                            ┌────────────────┐  ◄──────────────────
       │                            │ License server │
       │                            └───────┬────────┘
       │                                    │ signs with Ed25519 private key
       │                                    ▼
 ┌─────┴──────────────────┐        ┌──────────────────┐
 │ Customer's application │ ◄──────│  license token   │
 │  verifies OFFLINE with └────────┤  (short-lived)   │
 │  the public key        │        └──────────────────┘
 └────────────────────────┘
```

**Why it is secure.** The private signing key lives only on the license server
and never in the database. A customer can read the token, decode it, and learn
nothing that helps them forge one — Ed25519 signatures cannot be produced
without the private key. Editing a single byte of the payload invalidates it
(there is a test for exactly this).

**Why it is easy.** Verification is one signature check against a public key
that ships inside your application. No network call, no license daemon, no
dongle. `tools/verify-license.js` is the complete implementation in ~40 lines
with zero dependencies.

**Why revocation still works without an always-online check.** The token expires
in days (default 7); the *subscription* end date inside it is the real one. An
application refreshes its token in the background whenever the network happens
to be available. Revoke a license and the next refresh fails — the software
stops within the token lifetime. Meanwhile a machine that is genuinely offline
keeps working until the subscription's own end date plus a grace period, so a
paying customer is never locked out by a firewall or a flight.

Those two numbers, `LICENSE_TOKEN_TTL_DAYS` and `LICENSE_GRACE_DAYS`, are the
only dial in the system: shorter TTL = faster revocation, longer grace = more
tolerance for offline customers.

---

## What is implemented

**Storefront and CPQ**
- Catalogue of subscription products; each product's entire commercial model
  (editions, add-on modules, volume tiers, contract terms, support levels,
  compatibility rules) is JSON, editable in the admin panel.
- Live pricing: the browser prices nothing itself, it asks the server on every
  change, so the number on screen is the number that will be charged.
- Compatibility rules block invalid combinations *with the reason attached*, so
  a customer cannot build a configuration that fails at checkout.
- Quotes with numbers, expiry, and a discount-approval gate for sales.
- Mid-term changes with proration (add seats, add a module, move up an edition).

**Authentication**
- Microsoft Entra ID authorization-code flow with PKCE, state and nonce checks,
  and id_token signature verification against the tenant JWKS.
- No local accounts, no password field, no social login.
- App roles from the `roles` claim map to admin / sales / customer.
- Licenses belong to the Azure AD **tenant**, so colleagues share the account.

**Licensing**
- Issue, renew, revoke, reinstate, seat changes, module changes.
- Per-device activation with seat enforcement and self-service deactivation.
- Signing key rotation with retired keys still published for verification.
- Every action in an append-only audit log.

**The bridge**
- Every call to the license server goes through a durable job queue with an
  idempotency key derived from *meaning* (`issue:<subscription id>`), so a
  retried payment webhook cannot double-issue.
- Exponential backoff, permanent-vs-transient error classification, retry from
  the admin panel.
- Two adapters: the built-in license server, or any external one over HTTP —
  point `LICENSE_SERVER_URL` at it and map the four endpoints.

**Billing**
- Renewal worker charges the next term and pushes the new end date to the
  license.
- A failed renewal marks the subscription past due but does **not** revoke —
  the grace period covers dunning.
- Cancel at period end, cancel immediately, refund (which revokes).

---

## Quick start

```bash
npm install
npm start
# open http://localhost:3000
```

Demo mode is on by default: Azure AD is stubbed by a persona picker so the flow
is clickable before a tenant exists. Everything else — the CPQ engine, the
license server, the signing, the bridge — is the real implementation.

Suggested walkthrough:

1. Sign in as **Anna Berg** (customer).
2. Configure *Atlas Design Suite* — try adding the CAM module on the Standard
   edition and watch it get blocked with the reason.
3. Create a quote, check out, and get a license key.
4. Open **Activation demo**, activate, and read the local verification panel.
   Change the fingerprint and activate again to test the seat limit.
5. Sign in as **Admin User**, revoke that license, then press *Refresh token* on
   the activation page.

### Going live

```bash
cp .env.example .env    # fill in AZURE_*, STRIPE_*, DEMO_MODE=false
npm start
```

With `DEMO_MODE=false` the demo sign-in route returns 404 and Azure AD is the
only path to a session.

---

## Tests

```bash
npm start &                              # or point at any running instance
node scripts/e2e.js http://127.0.0.1:3000
```

33 end-to-end checks over the real HTTP API, covering: anonymous access limits,
role enforcement, CPQ rule rejection, volume and term pricing, quote approval,
checkout idempotency, offline verification, **token tampering**, seat limits,
deactivation, mid-term upgrade, renewal, revocation, reinstatement, API-key
enforcement on the server-to-server API, and the audit trail.

---

## Layout

```
server.js                 wiring, security headers, Stripe webhook
src/config.js             all environment configuration
src/db.js                 schema + audit helper
src/keys.js               Ed25519 key management and rotation
src/license.js            the license server: issue/renew/revoke/activate/verify
src/cpq.js                configure -> price -> quote, and config -> license params
src/commerce.js           orders, subscriptions, renewals, proration
src/bridge.js             durable job queue + local/HTTP license adapters
src/payments.js           mock and Stripe adapters
src/auth.js               Entra ID OIDC, role mapping, tenant -> account
src/routes/               auth, shop, admin, public license API
public/                   storefront, configurator, account, admin, activation demo
tools/verify-license.js   the offline verifier that ships in YOUR software
scripts/seed.js           demo catalogue (data, not code)
scripts/e2e.js            end-to-end test suite
docs/                     Azure AD setup, license API, client SDK, deployment
```

## Documentation

- [`docs/AZURE-AD-SETUP.md`](docs/AZURE-AD-SETUP.md) — app registration, app
  roles, redirect URIs, what to hand the client.
- [`docs/LICENSE-API.md`](docs/LICENSE-API.md) — every endpoint, request and
  response, and error codes.
- [`docs/CLIENT-SDK.md`](docs/CLIENT-SDK.md) — offline verification in C#,
  Python, Node and C++.
- [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) — production checklist, key
  backup, rotation, monitoring.

## Notes on the demo catalogue

The three Atlas products exist only to give the CPQ engine something to
configure. They are rows in the database, not code. Replacing them with a real
catalogue is a data change made in the admin panel.
