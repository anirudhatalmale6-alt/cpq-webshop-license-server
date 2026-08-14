# Verifying a license inside your software

The check is always the same three steps, in every language:

1. Split the token on `.` into header, payload and signature.
2. Verify the Ed25519 signature over `header.payload` using the embedded public
   key. If it fails, stop — the token is forged or corrupt.
3. Read the dates and decide.

There is no library to install from us and no service to call.

## The decision logic

```
if (!signatureValid)                    -> refuse to start
if (lic.status is revoked or suspended) -> refuse to start
if (now > lic.ends_at + grace_days)     -> refuse to start   ("subscription ended")
if (now > exp)                          -> START ANYWAY, and try to refresh
                                           ("token stale" — never block on this)
else                                    -> start; refresh in the background
                                           once now > refresh_after
```

The fourth line is the one that keeps support quiet. A stale token means *we
have not spoken to the server lately*, not *this customer has not paid*.

## Embedding the public key

Fetch it once at build time and compile it in:

```bash
curl -s https://licenses.example.com/api/v1/public-key.pem -o license_pub.pem
```

Embed the file contents as a string constant. Do **not** download it at runtime —
an attacker who can swap the key at runtime can mint their own licenses.

Handling rotation: embed the current key, and accept a second "next" key in the
same build when you plan to rotate. Retired keys stay published in the JWKS, so
tokens signed by an old key keep verifying until they expire.

---

## Node.js

```js
const crypto = require('crypto');

const PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEA...
-----END PUBLIC KEY-----`;

function verifyLicense(token) {
  const [h, p, sig] = token.split('.');
  const ok = crypto.verify(
    null,                                        // Ed25519 takes no digest
    Buffer.from(`${h}.${p}`),
    crypto.createPublicKey(PUBLIC_KEY),
    Buffer.from(sig, 'base64url')
  );
  if (!ok) return { valid: false, reason: 'bad_signature' };

  const payload = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
  const now = Date.now();
  const hardStop = new Date(payload.lic.ends_at).getTime() + payload.lic.grace_days * 86400000;

  if (['revoked', 'suspended'].includes(payload.lic.status)) return { valid: false, reason: payload.lic.status };
  if (now > hardStop) return { valid: false, reason: 'subscription_ended' };
  return { valid: true, stale: now > payload.exp * 1000, entitlements: payload.lic };
}
```

The complete version, with CLI output, is `tools/verify-license.js` in this repo.

---

## C# / .NET

.NET has no Ed25519 in the BCL yet, so use BouncyCastle
(`dotnet add package BouncyCastle.Cryptography`).

```csharp
using System.Text;
using System.Text.Json;
using Org.BouncyCastle.Crypto.Parameters;
using Org.BouncyCastle.Crypto.Signers;
using Org.BouncyCastle.OpenSsl;

public static class LicenseCheck
{
    private const string PublicKeyPem = @"-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEA...
-----END PUBLIC KEY-----";

    public static LicenseResult Verify(string token)
    {
        var parts = token.Split('.');
        if (parts.Length != 3) return LicenseResult.Invalid("malformed");

        var reader = new PemReader(new StringReader(PublicKeyPem));
        var key = (Ed25519PublicKeyParameters)reader.ReadObject();

        var signer = new Ed25519Signer();
        signer.Init(false, key);
        var signed = Encoding.ASCII.GetBytes($"{parts[0]}.{parts[1]}");
        signer.BlockUpdate(signed, 0, signed.Length);

        if (!signer.VerifySignature(Base64Url(parts[2])))
            return LicenseResult.Invalid("bad_signature");

        using var doc = JsonDocument.Parse(Encoding.UTF8.GetString(Base64Url(parts[1])));
        var root = doc.RootElement;
        var lic  = root.GetProperty("lic");

        var status = lic.GetProperty("status").GetString();
        if (status is "revoked" or "suspended") return LicenseResult.Invalid(status);

        var endsAt   = lic.GetProperty("ends_at").GetDateTimeOffset();
        var grace    = lic.GetProperty("grace_days").GetInt32();
        var hardStop = endsAt.AddDays(grace);
        if (DateTimeOffset.UtcNow > hardStop) return LicenseResult.Invalid("subscription_ended");

        var exp   = DateTimeOffset.FromUnixTimeSeconds(root.GetProperty("exp").GetInt64());
        var stale = DateTimeOffset.UtcNow > exp;

        return LicenseResult.Valid(
            edition:  lic.GetProperty("edition").GetString(),
            seats:    lic.GetProperty("seats").GetInt32(),
            features: lic.GetProperty("features"),
            stale:    stale);
    }

    private static byte[] Base64Url(string s) =>
        Convert.FromBase64String(s.Replace('-', '+').Replace('_', '/')
                                  .PadRight(s.Length + (4 - s.Length % 4) % 4, '='));
}
```

---

## Python

```python
import base64, json, time
from datetime import datetime, timezone, timedelta
from cryptography.hazmat.primitives.serialization import load_pem_public_key
from cryptography.exceptions import InvalidSignature

PUBLIC_KEY_PEM = b"""-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEA...
-----END PUBLIC KEY-----"""


def _b64(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def verify_license(token: str):
    header_b64, payload_b64, sig_b64 = token.split(".")
    key = load_pem_public_key(PUBLIC_KEY_PEM)
    try:
        key.verify(_b64(sig_b64), f"{header_b64}.{payload_b64}".encode())
    except InvalidSignature:
        return {"valid": False, "reason": "bad_signature"}

    payload = json.loads(_b64(payload_b64))
    lic = payload["lic"]

    if lic["status"] in ("revoked", "suspended"):
        return {"valid": False, "reason": lic["status"]}

    ends_at = datetime.fromisoformat(lic["ends_at"].replace("Z", "+00:00"))
    hard_stop = ends_at + timedelta(days=lic["grace_days"])
    if datetime.now(timezone.utc) > hard_stop:
        return {"valid": False, "reason": "subscription_ended"}

    return {"valid": True, "stale": time.time() > payload["exp"], "entitlements": lic}
```

---

## C++ (libsodium)

```cpp
#include <sodium.h>
// pub_key: the 32 raw bytes decoded from the PEM's base64 body (strip the
// 12-byte SPKI prefix), embedded as a constant.

bool verify_signature(const std::string& token,
                      const unsigned char pub_key[crypto_sign_PUBLICKEYBYTES]) {
    auto dot1 = token.find('.');
    auto dot2 = token.find('.', dot1 + 1);
    if (dot1 == std::string::npos || dot2 == std::string::npos) return false;

    std::string signed_part = token.substr(0, dot2);
    std::vector<unsigned char> sig = base64url_decode(token.substr(dot2 + 1));
    if (sig.size() != crypto_sign_BYTES) return false;

    return crypto_sign_verify_detached(
        sig.data(),
        reinterpret_cast<const unsigned char*>(signed_part.data()),
        signed_part.size(),
        pub_key) == 0;
}
```

Then parse the payload JSON and apply the same date logic.

---

## Refresh loop

```
on start:
    result = verifyLicense(storedToken)
    if (!result.valid) -> show the reason, offer to re-enter the key
    start the application
    if (now > payload.refresh_after) -> refresh in the background

background refresh (non-blocking, failures ignored):
    POST /api/v1/refresh { license_key, fingerprint }
    on 200  -> replace the stored token
    on 403 not_activated -> this device was released; stop and prompt
    on anything else / no network -> do nothing, try again later
```

Refresh once a day is plenty with a 7-day token. Never refresh synchronously on
the start path — that turns your license server into a single point of failure
for every customer's application launch.

## Device fingerprints

Whatever you use, hash it before sending. Something stable across reboots but
not across machines:

- **Windows** — machine GUID from `HKLM\SOFTWARE\Microsoft\Cryptography\MachineGuid`,
  optionally with the motherboard serial.
- **macOS** — `IOPlatformUUID` from `IOKit`.
- **Linux** — `/etc/machine-id`.

Avoid MAC addresses: docks, VPNs and virtual adapters change them and your
customer loses a seat every time they plug in a different dock.
