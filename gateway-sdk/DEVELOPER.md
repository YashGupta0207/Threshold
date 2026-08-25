# AI Gateway — Developer Integration Guide

Everything you need to call the AI Gateway from your application.

Source: https://github.com/YashGupta0207/ai-gateway-platform

---

## 1. What this is

The Gateway is a **credential broker and proxy**. You authenticate with a
developer token that looks like `dev_xxxxxxxx`. You never hold a real OpenAI,
Azure, Gemini, or Deepgram key.

```
your app  ──[ Bearer dev_xxx ]──>  Gateway  ──[ real provider key ]──>  OpenAI / Azure / Deepgram / …
                                      │
                                      └── decrypts the key, logs the call, enforces authorization
```

What this buys you:

- **No provider secrets in your app.** Nothing to leak, nothing to rotate on your side.
- **Swap providers without shipping code.** An admin repoints your token; you change one string.
- **Central revocation.** A token can be disabled or expired instantly.
- **Usage tracking.** Every call is attributed to your token.

There are two distinct ways to use it, and you need to know which one you want:

| Mode | Endpoint | What happens |
|---|---|---|
| **Proxy** | `/gateway/chat/completions`, `/gateway/listen`, … | The Gateway calls the provider for you. Keys never leave the Gateway. |
| **Credential fetch** | `/gateway/credentials/{provider}` | The Gateway hands you the decrypted keys and you connect directly. |

Prefer **proxy** mode. Use credential fetch only for services that can't be
proxied — a database driver like Cosmos DB, for example, that needs a direct
connection.

---

## 2. Get a token

Developer tokens are issued from the **Admin Portal** — you cannot mint one
yourself. Ask your gateway admin for:

1. A **developer token** (`dev_` followed by 43 characters).
2. The **gateway base URL**.
3. The **exact provider name(s)** your token is authorized for.

That third item matters more than it sounds. Provider names are matched against
either `name` or `display_name`, case-insensitively, so `Azure OpenAI`,
`azure openai`, and `AZURE OPENAI` all resolve — but `azure-openai` does not.
Get the exact string from the portal.

> The token is shown **once**, at creation. It's stored server-side as a hash and
> cannot be recovered — only regenerated. Save it immediately.

Your token must be explicitly authorized for each provider it uses. Having a
valid token is not enough; an unauthorized provider returns `403`.

---

## 3. Install

```bash
cd gateway-sdk
pip install -e .
```

This installs three importable packages: `gateway`, `dxai`, and `dxazure`.
Requires Python ≥ 3.9. Dependencies (`httpx`, `websockets`) install automatically.

---

## 4. Configure

Set these environment variables and every SDK surface picks them up:

```bash
DXAI_API_KEY=dev_xxxxxxxxxxxxxxxxxxxx      # your developer token — required
DXAI_BASE_URL=https://your-gateway.example.com   # optional, see below
DXAI_PROVIDER=Azure OpenAI                  # optional default provider
```

**Only `DXAI_API_KEY` is required.** All three packages default to the hosted
gateway at `https://ai-gateway-platform-cex4.onrender.com`, declared as a
`DEFAULT_BASE_URL` constant in each package. Set `DXAI_BASE_URL` only to point
somewhere else — a self-hosted instance, or `http://localhost:8000` when running
the gateway locally.

Precedence is `base_url=` argument, then `DXAI_BASE_URL`, then the default.

In Python, load it before importing the SDK:

```python
from dotenv import load_dotenv
load_dotenv()

import gateway  # now sees DXAI_BASE_URL
```

---

## 5. Quick start

```python
import gateway

response = gateway.chat(
    provider="Azure OpenAI",
    model="gpt-4o",
    prompt="Summarize this meeting transcript.",
)
print(response["choices"][0]["message"]["content"])
```

That's the whole integration. `api_key` and `base_url` come from the environment.

---

## 6. The three SDK surfaces

All three do the same thing underneath. Pick one and stay consistent.

### `gateway` — simplest, function-style

Best for most applications.

```python
import gateway

# Chat
res = gateway.chat(provider="Azure OpenAI", model="gpt-4o", prompt="Hello!")

# Chat with full message history
res = gateway.chat(
    provider="Azure OpenAI",
    model="gpt-4o",
    messages=[
        {"role": "system", "content": "You are concise."},
        {"role": "user", "content": "Explain WebSockets."},
    ],
    temperature=0.2,
)

# Streaming — yields raw bytes
for chunk in gateway.chat(provider="Azure OpenAI", prompt="Write a poem", stream=True):
    print(chunk.decode(), end="")

# Transcription from a file path
res = gateway.transcribe(provider="Deepgram", file="audio.wav", mimetype="audio/wav")

# Any other provider path
res = gateway.request(provider="Deepgram", method="POST", path="/listen", content=audio_bytes)
```

Every function accepts `api_key=`, `profile=`, and `tags=` as overrides.

### `dxai` — OpenAI-SDK-shaped

Use this when you're migrating code already written against the OpenAI SDK.

```python
from dxai import DXAI

client = DXAI(provider="Azure OpenAI")   # set a default provider once

res = client.chat.completions.create(
    model="gpt-4o",
    messages=[{"role": "user", "content": "Hello"}],
)

# Streaming yields parsed SSE dicts, not bytes
for event in client.chat.completions.create(model="gpt-4o", messages=[...], stream=True):
    print(event)

# Override the provider per call
res = client.chat.completions.create(model="gpt-4o", messages=[...], provider="OpenAI")
```

Set `provider` on the constructor, per call, or via `DXAI_PROVIDER`. **If none
is set, the Gateway returns `400 Missing X-Gateway-Provider header`.**

### `dxazure` — Azure Speech, including live audio

```python
from dxazure import AzureSpeechClient

client = AzureSpeechClient()

# Batch: whole file
result = client.transcribe_file("meeting.wav", mimetype="audio/wav")

# Live: stream microphone audio over a WebSocket
async with client.listen() as ws:
    await ws.send_bytes(audio_chunk)
    transcript = await ws.receive_json()
```

This client hardcodes provider `azure_speech`.

---

## 7. Choosing a provider, profile, and tags

Three headers control routing. The SDK sets them for you; you need them if
calling over raw HTTP.

| Header | Required | Purpose |
|---|---|---|
| `Authorization: Bearer dev_…` | **Yes** | Your developer token |
| `X-Gateway-Provider` | **Yes** | Which provider to route to |
| `X-Gateway-Profile` | No | A specific named credential set |
| `X-Gateway-Tags` | No | JSON object; selects a profile by tag |

A **profile** is one credential set belonging to a provider — think "prod" vs
"staging" Azure OpenAI deployments. Resolution order:

1. `X-Gateway-Tags` present → first active profile matching all tags
2. `X-Gateway-Profile` present → the profile with that exact name
3. Neither → the default profile, then highest priority

```python
# Pin to a named profile
gateway.chat(provider="Azure OpenAI", prompt="Hi", profile="production")

# Or select by tags
gateway.chat(provider="Azure OpenAI", prompt="Hi", tags={"env": "prod", "region": "uk"})
```

Profile names are matched **exactly** (case-sensitive), unlike provider names.

---

## 8. Endpoint reference

Gateway routes are **not** versioned. They sit at `/gateway/*`, while
`/api/v1/*` is the admin API you won't touch.

| Method | Path | Purpose |
|---|---|---|
| POST | `/gateway/chat/completions` | Chat completions, streaming or not |
| POST | `/gateway/audio/transcriptions` | Multipart audio transcription |
| GET | `/gateway/credentials/{provider_name}` | Fetch decrypted credentials |
| ANY | `/gateway/{any/path}` | Catch-all passthrough to the provider |
| WS | `/api/v1/gateway/ws/listen` | Live transcription |
| WS | `/ws/live` | Live audio, `?format=` & `?sample_rate=` |
| GET | `/health` | Liveness check, no auth |

The catch-all is why the SDK can reach any provider endpoint — `gateway.request(path="/listen")`
becomes `POST /gateway/listen`, and the adapter maps it onto the real provider URL.

The two WebSocket routes take the token as a **query parameter**
(`?token=dev_xxx`) since browsers can't set headers on a WebSocket handshake.

---

## 9. Raw HTTP — no SDK

For Node, Go, or any non-Python stack:

```bash
curl -X POST "https://your-gateway.example.com/gateway/chat/completions" \
  -H "Authorization: Bearer dev_xxxxxxxx" \
  -H "X-Gateway-Provider: Azure OpenAI" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o","messages":[{"role":"user","content":"Hello"}]}'
```

```javascript
const res = await fetch(`${GATEWAY_URL}/gateway/chat/completions`, {
  method: "POST",
  headers: {
    "Authorization": `Bearer ${process.env.DXAI_API_KEY}`,
    "X-Gateway-Provider": "Azure OpenAI",
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    model: "gpt-4o",
    messages: [{ role: "user", content: "Hello" }],
  }),
});
if (!res.ok) throw new Error(`Gateway ${res.status}: ${await res.text()}`);
const data = await res.json();
```

The response body is the provider's own response, passed through unchanged — so
existing OpenAI-shaped parsing code keeps working.

---

## 10. Credential fetch mode

For services that can't be proxied. The Gateway returns decrypted credentials
for the resolved profile:

```python
import os, httpx

def fetch_credentials(provider_name: str) -> dict:
    res = httpx.get(
        f"{os.environ['DXAI_BASE_URL']}/gateway/credentials/{provider_name}",
        headers={"Authorization": f"Bearer {os.environ['DXAI_API_KEY']}"},
        timeout=15.0,
    )
    res.raise_for_status()
    return res.json()["credentials"]

creds = fetch_credentials("cosmos-db")
client = CosmosClient(creds["endpoint"], creds["key"])
```

The returned `credentials` object is a flat `{variable_name: value}` map. The
key names are whatever the admin configured on the profile — confirm them in the
portal rather than guessing.

**Treat these as live secrets.** They are real provider keys. Never log them,
never send them to a frontend, and cache them in memory only. Fetch once at
startup and reuse; don't call this per request.

**Credential fetches do not count against your token's request quota.** The
daily and monthly request limits are enforced in `_enforce_limits()`, which only
the proxy paths call — `/gateway/credentials/…` queries the database directly
and never touches it. So a token capped at 6 requests/month can still restart
your app freely; the cap applies to proxied AI calls (chat, transcription).

Section 12 walks through the whole integration step by step.

---

## 11. Error handling

```python
import gateway
from gateway import GatewayError

try:
    res = gateway.chat(provider="Azure OpenAI", prompt="Hello")
except GatewayError as e:
    print(e.status_code, e.response_body)
```

`dxai` raises `DXAIError` and `dxazure` raises `AzureSpeechClientError`; all
three carry `.status_code` and `.response_body`.

| Status | Meaning | Fix |
|---|---|---|
| `400` | Missing `X-Gateway-Provider` | Pass `provider=` or set `DXAI_PROVIDER` |
| `401` | Missing or invalid token | Check `DXAI_API_KEY` |
| `403` | Token disabled, expired, or not authorized for that provider | Ask an admin |
| `404` | Provider or profile doesn't exist | Check the exact name in the portal |
| `503` | Provider disabled, or no active profile | Ask an admin |

`403` is the one that catches people out: your token is valid, but it hasn't
been granted access to the provider you asked for. The message names the
provider — read it before assuming the token is broken.

---

## 12. Step-by-step: integrating into your application

This is the full migration path, from "an admin gave me a token" to "my app runs
on gateway credentials." It works the same whether you were assigned **one**
provider or **ten** — the only thing that changes is one comma-separated list.

### Step 1 — Collect three things from your admin

| What | Example | Notes |
|---|---|---|
| Developer token | `dev_rGiqjPDk_Nq…` | Shown once at creation. Cannot be recovered |
| Gateway URL | `https://ai-gateway-platform-cex4.onrender.com` | The SDK's built-in default |
| Provider names | `Cosmosdb`, `AzureOpenAI` | Must match the portal **exactly** |

Ask for the provider names as written in the portal, not from memory.
`AzureOpenAI` and `Azure OpenAI` are different strings, and a mismatch gives you
`404 Provider does not exist`.

### Step 2 — Look up your variable names

Open each provider in the admin portal and read the **Key** column of its
profile. Those key names are exactly what the gateway returns to you. For example:

| Provider | Keys it returns |
|---|---|
| `Cosmosdb` | `COSMOS_KEY`, `COSMOS_ENDPOINT`, `COSMOS_DATABASE`, `COSMOS_USERS_CONTAINER` |
| `AzureOpenAI` | `AZURE_OPENAI_KEY`, `AZURE_OPENAI_ENDPOINT`, `AZURE_TRANSCRIBE_DEPLOYMENT`, `AZURE_DIARIZE_DEPLOYMENT` |
| `AzureSpeechKey` | `AZURE_SPEECH_KEY`, `AZURE_SPEECH_REGION` |

If the portal names match the env-var names your code already uses, the
migration is nearly free — that's the case worth aiming for. If they don't,
you'll map them in step 5.

### Step 3 — Add config to `.env`

```bash
DXAI_API_KEY=dev_xxxxxxxxxxxxxxxxxxxxxxxx
DXAI_BASE_URL=https://ai-gateway-platform-cex4.onrender.com

# One provider:
GATEWAY_PROVIDERS=AzureOpenAI

# Two:
GATEWAY_PROVIDERS=AzureOpenAI,Cosmosdb

# Any number — order only matters for tie-breaking duplicate key names:
GATEWAY_PROVIDERS=Cosmosdb,AzureOpenAI,AzureSpeechKey

GATEWAY_TIMEOUT=60
```

**That list is the only thing you change when your provider count changes.** No
new code, no new branches.

Then **comment out the real provider secrets**. That's the entire point — those
values now live in the gateway. Keep them commented rather than deleted so you
can fall back offline.

### Step 4 — Drop in the resolver

Save this as `gateway_credentials.py` next to your app. It fetches every
configured provider once at startup, merges the results into one flat lookup,
and falls back to `.env` if anything goes wrong.

```python
"""Resolve provider secrets from the AI Gateway, with .env as the fallback."""
from __future__ import annotations
import logging, os
import httpx

log = logging.getLogger("gateway")

GATEWAY_TOKEN = os.getenv("DXAI_API_KEY", "").strip()
GATEWAY_BASE_URL = (os.getenv("DXAI_BASE_URL") or
                    "https://ai-gateway-platform-cex4.onrender.com").rstrip("/")
GATEWAY_PROVIDERS = [p.strip() for p in
                     os.getenv("GATEWAY_PROVIDERS", "").split(",") if p.strip()]
GATEWAY_TIMEOUT = float(os.getenv("GATEWAY_TIMEOUT", "60"))

_secrets: dict[str, str] = {}
_loaded = False


def load() -> dict[str, str]:
    """Fetch every configured provider once and merge the results."""
    global _loaded
    if _loaded:
        return _secrets
    _loaded = True

    if not GATEWAY_TOKEN or not GATEWAY_PROVIDERS:
        log.info("GATEWAY disabled — using .env values")
        return _secrets

    with httpx.Client(base_url=GATEWAY_BASE_URL,
                      headers={"Authorization": f"Bearer {GATEWAY_TOKEN}"},
                      timeout=GATEWAY_TIMEOUT) as client:
        for provider in GATEWAY_PROVIDERS:
            try:
                resp = client.get(f"/gateway/credentials/{provider}")
            except httpx.RequestError as exc:
                log.warning("GATEWAY %s unreachable: %s", provider, exc)
                continue
            if resp.status_code != 200:
                log.warning("GATEWAY %s HTTP %s: %s",
                            provider, resp.status_code, resp.text[:200])
                continue
            for name, value in (resp.json().get("credentials") or {}).items():
                if name in _secrets and _secrets[name] != value:
                    log.warning("GATEWAY %r from multiple providers; keeping first", name)
                    continue
                _secrets[name] = str(value)

    log.info("GATEWAY resolved %d secret(s)", len(_secrets))
    return _secrets


def secret(name: str, default: str = "") -> str:
    """Drop-in replacement for os.getenv: gateway first, then .env."""
    load()
    value = _secrets.get(name)
    if not value:
        value = os.getenv(name, default)
    return value if value is not None else default


def source_of(name: str) -> str:
    """Diagnostics only — never returns the value itself."""
    load()
    if _secrets.get(name):
        return "gateway"
    return ".env" if os.getenv(name) else "missing"
```

Four properties worth understanding, because they're what make this safe:

- **Fetched once per process.** Most apps read config into module-level
  constants at import time, so the fetch has to happen before those lines run.
  A side effect is that a running server never re-hits the gateway.
- **Never fatal.** A gateway outage degrades to `.env` instead of crashing your
  app or surfacing as a confusing error three layers deeper.
- **Scales to any provider count.** The loop doesn't care whether the list has
  one entry or ten.
- **Duplicate keys are logged, not silently merged.** If two providers both
  export `API_KEY`, you'll see a warning instead of whichever-was-first winning
  invisibly.

### Step 5 — Replace your `os.getenv` calls

Import the resolver **after** `load_dotenv()` and **before** your config
constants:

```python
from dotenv import load_dotenv
load_dotenv()

from gateway_credentials import secret, source_of
```

Then swap the calls. This is a mechanical find-and-replace:

```diff
- COSMOS_ENDPOINT = os.getenv("COSMOS_ENDPOINT")
- COSMOS_KEY      = os.getenv("COSMOS_KEY")
- AZURE_SPEECH_KEY = os.getenv("AZURE_SPEECH_KEY", "").strip()
+ COSMOS_ENDPOINT = secret("COSMOS_ENDPOINT")
+ COSMOS_KEY      = secret("COSMOS_KEY")
+ AZURE_SPEECH_KEY = secret("AZURE_SPEECH_KEY").strip()
```

`secret()` takes the same arguments as `os.getenv()`, so defaults keep working:
`secret("COSMOS_USERS_CONTAINER", "users")`.

**Only swap the provider secrets.** Leave `os.getenv` alone for your own
application config — ports, feature flags, JWT secrets. Those don't come from
the gateway, and routing them through `secret()` just adds noise.

If the portal's key names *don't* match your code's names, map them here rather
than renaming throughout:

```python
COSMOS_KEY = secret("COSMOS_PRIMARY_KEY") or secret("COSMOS_KEY")
```

### Step 6 — Verify

Log where each secret resolved from. Never log the values:

```python
for key in ("COSMOS_ENDPOINT", "COSMOS_KEY", "AZURE_OPENAI_KEY"):
    val = secret(key)
    log.info("ENV %-24s present=%-5s length=%-4s source=%s",
             key, bool(val), len(val) if val else 0, source_of(key))
```

A healthy startup looks like this:

```
GATEWAY fetching 3 provider(s) from https://ai-gateway-platform-cex4.onrender.com
GATEWAY Cosmosdb           OK: COSMOS_DATABASE, COSMOS_ENDPOINT, COSMOS_KEY, COSMOS_USERS_CONTAINER
GATEWAY AzureOpenAI        OK: AZURE_DIARIZE_DEPLOYMENT, AZURE_OPENAI_ENDPOINT, AZURE_OPENAI_KEY, …
GATEWAY AzureSpeechKey     OK: AZURE_SPEECH_KEY, AZURE_SPEECH_REGION
GATEWAY resolved 10 secret(s)
ENV COSMOS_ENDPOINT        present=True  length=50   source=gateway
```

`source=gateway` on every provider secret means you're done. Any `source=.env`
means that provider failed and you silently fell back — check the warnings above
it. `source=missing` means neither had it.

### Step 7 — Rotating keys

Once you're on the gateway, rotating a provider key is an admin-portal edit plus
a restart of your app. No redeploy, no code change, no `.env` edit. That's the
main day-two payoff, and it's worth confirming it works before you need it.

---

## 13. Security notes

- **The `dev_` token is a secret.** Backend only. Never ship it in a desktop app,
  a browser bundle, or a mobile binary — anyone who extracts it can spend your quota.
  If a client app needs AI, proxy through your own backend.
- **Never commit it.** Keep it in `.env` and keep `.env` gitignored.
- **It cannot be recovered**, only regenerated — which invalidates the old value.
- **Tokens can carry an expiry.** A call that worked yesterday and returns `403`
  today has probably expired; check the portal before debugging your code.
- **Credential-fetch results are real keys.** Everything above applies doubly.

---

## 14. Fixed bugs — history

This section is kept as context. **All of these are fixed in upstream `main`**
(commits `9332969` and `4e2b52e`), and this vendored copy matches upstream. If
you're reading older SDK code or an SDK pinned before those commits, these are
what you'll hit.

**1. Wrong path in `gateway/client.py`.** It requested `/api/v1/gateway/*`, but
gateway routes are mounted at `/gateway/*` — `backend/app/main.py` mounts the
router with no prefix and comments that gateway routes are deliberately
unversioned. Every call 404'd.

**2. `gateway` package not installable.** `pyproject.toml` declared only
`["dxai", "dxai.resources", "dxazure"]`, so `pip install` silently omitted the
`gateway` package and `import gateway` failed — despite it being the package the
SDK README documents.

**3. `chat.completions.create()` never sent a provider.** It didn't forward
`X-Gateway-Provider`, and the Gateway rejects requests without it, so the
README's flagship `dxai` example returned `400`. Now takes a `provider`
parameter, with a client-level default via `DXAI(provider=…)` or `DXAI_PROVIDER`.

**4. `_stream()` never sent a provider either** — same failure on every
streaming call.

**5. Three different placeholder base URLs.** `gateway` defaulted to
`http://localhost:8000`, `dxai` and `dxazure` to the non-existent
`https://gateway.yourdomain.com`. All three now share a `DEFAULT_BASE_URL`
constant pointing at the hosted gateway.

One upstream quirk remains **by design**:

- **`gateway.chat(stream=True)` yields raw bytes**, while `dxai`'s streaming
  yields parsed SSE dicts. Same operation, different return type — don't assume
  they're interchangeable.

---

## 15. Troubleshooting

| Symptom | Cause |
|---|---|
| `ConnectError` to `gateway.yourdomain.com` | SDK predates commit `4e2b52e` — upgrade, or set `DXAI_BASE_URL` |
| `400 Missing X-Gateway-Provider header` | No provider passed; set `provider=` or `DXAI_PROVIDER` |
| `404 Provider 'x' does not exist` | Name mismatch. Hyphens vs spaces is the usual culprit |
| `403 Developer is not authorized` | Token is valid but lacks access to that provider |
| `ModuleNotFoundError: gateway` | SDK predates commit `9332969` — see issue 2 above |
| `401` on a token that used to work | Regenerated, disabled, or expired |
| Everything 404s at `/api/v1/gateway/…` | SDK predates commit `9332969` — see issue 1 above |
| First call after idle takes ~30s | Render free tier cold start, not a bug |

Check the Gateway itself is reachable before debugging your code:

```bash
curl https://ai-gateway-platform-cex4.onrender.com/health
# {"status":"ok","service":"AI Gateway"}
```

`/health` needs no authentication, so a failure there is network or DNS, not
your token.
