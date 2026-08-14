# Microsoft Entra ID (Azure AD) setup

Everything below happens once, in the Azure portal, by someone with Application
Administrator (or higher) in the tenant. It takes about fifteen minutes.

## 1. Register the application

**Entra ID → App registrations → New registration**

| Field | Value |
|---|---|
| Name | Atlas Store (or your shop's name) |
| Supported account types | See "single vs multi tenant" below |
| Redirect URI | **Web** → `https://shop.example.com/auth/callback` |

Copy from the Overview page:
- **Application (client) ID** → `AZURE_CLIENT_ID`
- **Directory (tenant) ID** → `AZURE_TENANT_ID`

### Single vs multi tenant

- **Customers are guests in your tenant** (B2B): choose *Accounts in this
  organizational directory only*, invite each customer's users as guests, and
  set `AZURE_TENANT_ID` to your tenant GUID.
- **Customers sign in with their own company's Microsoft account**: choose
  *Accounts in any organizational directory*, and set
  `AZURE_TENANT_ID=common`. Each customer's tenant admin consents once, and
  their tenant id becomes the account boundary in the shop automatically.

The second is usually what a software vendor wants: a customer's IT admin does
not have to be added to your directory to buy your product.

## 2. Client secret

**Certificates & secrets → New client secret**, 24 months.

Copy the **Value** (not the Secret ID) → `AZURE_CLIENT_SECRET`. It is shown
once. Put a calendar reminder at 22 months — an expired secret takes sign-in
down completely.

## 3. App roles

**App roles → Create app role**, three times:

| Display name | Allowed member types | Value | Maps to |
|---|---|---|---|
| Shop Administrator | Users/Groups | `Shop.Admin` | full admin |
| Sales | Users/Groups | `Shop.Sales` | quotes, discounts, approvals |
| Customer | Users/Groups | `Shop.Customer` | own licenses only |

Then **Enterprise applications → (your app) → Users and groups → Add user** and
assign roles. Assign to *groups*, not individuals, or you will be doing this by
hand forever.

Anyone who signs in without a matching role gets `AZURE_DEFAULT_ROLE`
(`customer`), which is the safe default: they can buy, and see only what they
bought.

If your directory uses groups instead of app roles, put the group object IDs in
the role map — the `groups` claim is read as well:

```
AZURE_ROLE_MAP={"8f2a...-...-guid":"admin","Shop.Sales":"sales"}
```

## 4. Token configuration

**Token configuration → Add optional claim → ID → `email`**, and tick "Turn on
the Microsoft Graph email permission" when prompted.

If you use groups for roles, also **Add groups claim → Security groups**, and
choose *Group ID* in the ID token.

## 5. API permissions

The delegated Microsoft Graph permissions `openid`, `profile`, `email`,
`offline_access` are enough. Nothing else is requested — the shop reads the
id_token and does not call Graph.

Grant admin consent so users are not each prompted.

## 6. Configure the shop

```
AZURE_TENANT_ID=<tenant guid, or "common" for multi-tenant>
AZURE_CLIENT_ID=<application id>
AZURE_CLIENT_SECRET=<secret value>
PUBLIC_URL=https://shop.example.com
DEMO_MODE=false
```

`PUBLIC_URL` must match the redirect URI's origin exactly, including https and
any trailing path. A mismatch produces `AADSTS50011`.

## 7. Verify

1. Open the shop in a private window → **Sign in with Microsoft**.
2. Complete sign-in. You land back on the page you started from.
3. `GET /auth/me` shows your name, email and mapped role.
4. Sign in as a user with the `Shop.Admin` role — the Admin tab appears.
5. Sign in as a user with no role — no Admin tab, and `/api/admin/*` returns 403.
6. Sign in as a *second* user from the same tenant — they see the first user's
   licenses, because licenses belong to the company.

## Common errors

| Error | Cause |
|---|---|
| `AADSTS50011` redirect URI mismatch | Redirect URI in Azure ≠ `PUBLIC_URL` + `/auth/callback` |
| `AADSTS7000215` invalid client secret | Secret ID copied instead of the secret Value, or the secret expired |
| `AADSTS650057` invalid resource | Scopes changed; keep `openid profile email offline_access` |
| Signed in but always `customer` | App role not assigned in *Enterprise applications*, or the value in `AZURE_ROLE_MAP` does not match the role's **Value** field exactly |
| "State mismatch" | The browser lost the session cookie — check `SESSION_SECURE` matches http/https, and that a proxy is not stripping cookies |

## What the application does with the token

- Verifies the id_token signature against the tenant JWKS, checks `aud`, `iss`
  and `nonce` before trusting anything in it.
- Reads `oid` (stable user id), `tid` (tenant), `preferred_username`, `name`,
  `roles`/`groups`.
- Never stores a password, because there is not one.
- The access token is not persisted; the shop does not call Graph on the user's
  behalf.
