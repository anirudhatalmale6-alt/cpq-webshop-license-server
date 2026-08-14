# License server API

Base path: `/api/v1`

Three groups of endpoints, with three different trust levels.

| Group | Who calls it | Authentication |
|---|---|---|
| Public key material | anyone | none |
| Activation | the customer's installed software | the license key + a device fingerprint |
| Management | the shop, your ERP, support tooling | `Api-Token` header |

---

## Public

### `GET /api/v1/health`

```json
{ "ok": true, "service": "license-server", "issuer": "https://licenses.example.com",
  "token_ttl_days": 7, "grace_days": 14, "active_kid": "lic-3f3c30ea1a24" }
```

### `GET /.well-known/license-jwks.json`

The public keys in JWKS form, current and retired. Retired keys stay published
until every token they signed has expired.

### `GET /api/v1/public-key.pem`

The active public key as PEM, with the key id in the `X-Key-Id` response header.
This is the file you embed in your application.

---

## Activation — called by the customer's software

### `POST /api/v1/activate`

```json
{
  "license_key": "ATLS-6334E-2XVTA-XHFX3-FVFTW",
  "fingerprint": "sha256-of-machine-identifiers",
  "hostname": "WS-ENG-014",
  "os": "Windows 11 23H2",
  "app_version": "4.2.1",
  "sku": "ATLAS-DESKTOP"
}
```

`sku` is optional; when present the server rejects a key that belongs to a
different product rather than letting the app misbehave later.

**200**

```json
{
  "token": "eyJhbGciOiJFZERTQSIsImtpZCI6...",
  "kid": "lic-3f3c30ea1a24",
  "expires_at": "2026-08-21T05:44:12.000Z",
  "refresh_after": "2026-08-17T17:44:12.000Z",
  "license": { "id": "lic_...", "seats": 30, "seats_used": 1, "...": "..." }
}
```

Store the token. Re-activating the *same* fingerprint is idempotent and does not
consume a second seat.

**Errors**

| Status | `error` | Meaning |
|---|---|---|
| 404 | `invalid_key` | No such license key |
| 409 | `wrong_product` | Key belongs to a different SKU |
| 409 | `seat_limit_reached` | All seats in use — deactivate a device or buy more |
| 403 | `revoked` / `suspended` / `expired` | Self-explanatory; show the message |
| 400 | `missing_fingerprint` | No device fingerprint supplied |

Every error carries a human-readable `message` intended to be shown to the end
user as-is.

### `POST /api/v1/refresh`

```json
{ "license_key": "ATLS-...", "fingerprint": "..." }
```

Same response as activate. Call it in the background once the clock passes
`refresh_after`. A failure is not fatal — keep using the existing token until it
expires. That is the whole point of the design.

`403 not_activated` means this device was deactivated (by the customer, an
admin, or a downgrade). The application should stop and tell the user to
re-activate.

### `POST /api/v1/deactivate`

```json
{ "license_key": "ATLS-...", "fingerprint": "..." }
```

Frees the seat. Call it from your uninstaller and from a "deactivate this
machine" menu item.

### `POST /api/v1/verify`

```json
{ "token": "eyJ...", "sku": "ATLAS-DESKTOP" }
```

Server-side convenience for debugging and for support staff. **Your application
should not use this** — verify offline instead (see `docs/CLIENT-SDK.md`).

---

## Management — `Api-Token` header required

```
Api-Token: <one of LICENSE_API_KEYS>
```

### `POST /api/v1/licenses` — issue

```json
{
  "accountId": "acc_...",
  "sku": "ATLAS-DESKTOP",
  "edition": "professional",
  "seats": 25,
  "modules": ["api", "cam"],
  "features": { "simulation": true, "max_projects": -1 },
  "termMonths": 12,
  "startsAt": "2026-08-14T00:00:00Z",
  "keyPrefix": "ATLS"
}
```

Returns the full license including the generated `license_key`.

### `GET /api/v1/licenses/:id`

`:id` accepts either the license id or the license key.

### `PATCH /api/v1/licenses/:id` — change

```json
{ "seats": 40, "modules": ["api", "cam", "cloud_sync"], "endsAt": "2027-08-14T00:00:00Z" }
```

Reducing seats below the number of active machines releases the most recently
activated ones automatically, so a license is never left over its own limit.

### `POST /api/v1/licenses/:id/renew`

```json
{ "termMonths": 12 }
```

or an explicit `{ "endsAt": "..." }`. Renewing early extends from the current
end date, not from today, so the customer never loses days.

### `POST /api/v1/licenses/:id/revoke`

```json
{ "reason": "chargeback" }
```

Marks the license revoked and deactivates every device. Online applications stop
at their next refresh; offline ones stop when their current token expires
(≤ `LICENSE_TOKEN_TTL_DAYS`).

### `POST /api/v1/licenses/:id/reinstate`

Undoes a revocation. Devices must activate again.

### `GET /api/v1/licenses`

The 200 most recent licenses.

---

## The token

Header:

```json
{ "alg": "EdDSA", "kid": "lic-3f3c30ea1a24", "typ": "license+jwt" }
```

Payload:

```json
{
  "iss": "https://licenses.example.com",
  "sub": "lic_9f2c1a...",
  "aud": "ATLAS-DESKTOP",
  "iat": 1786... , "nbf": 1786..., "exp": 1786...,
  "lic": {
    "id": "lic_9f2c1a...",
    "key": "ATLS-6334E-2XVTA-XHFX3-FVFTW",
    "sku": "ATLAS-DESKTOP",
    "edition": "enterprise",
    "seats": 30,
    "modules": ["api", "cam", "offline"],
    "features": { "simulation": true, "cam": true, "max_projects": -1 },
    "status": "active",
    "starts_at": "2026-08-14T05:42:34.121Z",
    "ends_at": "2029-08-14T05:42:34.121Z",
    "grace_days": 14
  },
  "cust": { "id": "acc_...", "name": "northwind-demo.com", "tenant": "..." },
  "dev": "9a7f2c...",
  "refresh_after": "2026-08-17T17:44:12.000Z"
}
```

Two dates matter and they are different:

- `exp` — when this **token** goes stale. Refresh after this; do not stop.
- `lic.ends_at` — when the **subscription** ends. Stop after this plus
  `lic.grace_days`.

Getting those two backwards is the one implementation mistake that turns a good
licensing system into support tickets.
