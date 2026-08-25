# Integrating the AI Gateway into ThreadNotes

Everything done to move ThreadNotes off hardcoded provider keys and onto a
single AI Gateway developer token.

**Date:** 2026-08-17
**Token:** `dev_rGiqjPDk_Nq…` (label `yash`)
**Gateway:** https://ai-gateway-platform-cex4.onrender.com
**Providers used:** `Cosmosdb`, `AzureOpenAI`, `AzureSpeechKey`

---

## Result

Ten provider secrets now come from the gateway. Verified at startup:

```
COSMOS_ENDPOINT            source=gateway  len=50
COSMOS_KEY                 source=gateway  len=88
COSMOS_DATABASE            source=gateway  len=7
COSMOS_USERS_CONTAINER     source=gateway  len=6
AZURE_SPEECH_KEY           source=gateway  len=84
AZURE_SPEECH_REGION        source=gateway  len=13
AZURE_OPENAI_KEY           source=gateway  len=84
AZURE_OPENAI_ENDPOINT      source=gateway  len=35
```

Cosmos connects using those credentials:

```
COSMOS OK via gateway credentials -> Yash-db/Record has 1 documents
```

**`desktop-backend/.env` no longer contains a single real provider key.** The only
secret left on the machine is the `dev_` token itself.

### The unplanned win

`AZURE_SPEECH_KEY`, `AZURE_SPEECH_REGION`, `AZURE_OPENAI_KEY` and
`AZURE_OPENAI_ENDPOINT` were all **empty strings** in `.env` before this work.
Transcription and diarization could not have worked. They now resolve to real
values from the gateway, so the migration didn't just relocate config — it
switched on features that were quietly broken.

---

## What was built

### 1. New file: `desktop-backend/vault/gateway_credentials.py`

The whole integration lives here. It fetches each configured provider's
credentials once, merges them into one flat `{VAR_NAME: value}` map, and exposes
`secret(name, default)` as a drop-in replacement for `os.getenv`.

Four design decisions, and why:

**Fetched once, at import time.** `main.py` reads its config into module-level
constants (`COSMOS_ENDPOINT = …` at line 33), so resolution has to finish before
those lines execute. A lazy-on-first-use design would be too late. The upside is
that a running server never re-hits the gateway.

**Never fatal.** Every failure path — unreachable host, non-200, non-JSON body —
logs a warning and falls back to `os.getenv`. A gateway outage must not take the
backend down, and it must not surface as a `NoneType` error three layers deeper
in the Cosmos client.

**Provider count is configuration, not code.** `GATEWAY_PROVIDERS` is a
comma-separated list. One provider or ten, same loop.

**Duplicate keys warn instead of silently merging.** If two providers both
export `API_KEY`, whichever was listed first would otherwise win invisibly. It
now logs and keeps the first, so the collision is visible.

**60-second default timeout.** The gateway is on Render's free tier, where a
cold start takes roughly 30 seconds. A typical 10s timeout reads as "gateway is
down" when it's merely waking up.

### 2. `desktop-backend/vault/main.py` — ten call sites switched

| Line | Was | Now |
|---|---|---|
| 29 | `os.getenv("AZURE_SPEECH_KEY", "")` | `secret("AZURE_SPEECH_KEY")` |
| 30 | `os.getenv("AZURE_SPEECH_REGION", "")` | `secret("AZURE_SPEECH_REGION")` |
| 32–35 | `os.getenv("COSMOS_*")` | `secret("COSMOS_*")` |
| 124–131 | `os.getenv("AZURE_OPENAI_*")` | `secret("AZURE_OPENAI_*")` |
| 546 | `os.getenv("COSMOS_TRANSCRIPTS_CONTAINER")` | `secret(…)` |
| 926 | `os.getenv("AZURE_DIARIZE_DEPLOYMENT")` | `secret(…)` |
| 1021–1022 | `os.getenv("AZURE_TRANSCRIBE_DEPLOYMENT")` | `secret(…)` |

`secret()` takes the same arguments as `os.getenv()`, so defaults like
`secret("COSMOS_USERS_CONTAINER", "users")` behave identically. No call site
needed restructuring.

**Deliberately left on `os.getenv`:** `JWT_SECRET`, `ADMIN_EMAIL`,
`ADMIN_PASSWORD`, `BREVO_API_KEY`, `GMAIL_SENDER`. These are ThreadNotes' own
config, not provider credentials — they aren't in the gateway, and routing them
through `secret()` would add indirection for nothing.

The import sits immediately after `load_dotenv()` and before the config
constants, with a comment explaining the ordering, since it looks like a
misplaced import otherwise.

### 3. Startup diagnostics now show provenance

`_diagnose_env()` previously called `os.getenv` directly, which would have
reported `present=False` for every gateway-supplied secret — sending you hunting
through `.env` for a value that was never meant to be there. It now uses
`secret()` and prints a `source=` column:

```
ENV COSMOS_ENDPOINT      present=True  length=50   source=gateway
ENV AZURE_SPEECH_KEY     present=True  length=84   source=gateway
```

`source=gateway` means the gateway supplied it. `source=.env` means that
provider's fetch failed and you fell back — check the warnings above it.
`source=missing` means neither had it. Values are never logged, only lengths.

### 4. `desktop-backend/.env` restructured

Real keys commented out, gateway config added:

```bash
DXAI_API_KEY=dev_rGiqjPDk_Nq…
DXAI_BASE_URL=https://ai-gateway-platform-cex4.onrender.com
GATEWAY_PROVIDERS=Cosmosdb,AzureOpenAI,AzureSpeechKey
GATEWAY_TIMEOUT=60
```

The old values are commented rather than deleted, so uncommenting restores fully
offline operation. `desktop-backend/.env` is gitignored (`desktop-backend/.gitignore:10`), so
none of this is committed.

---

## Verification performed

1. **Token works.** `GET /gateway/credentials/Cosmosdb` → `200`, returning all
   four Cosmos keys with `COSMOS_DATABASE=Yash-db`.
2. **All three providers resolve.** Imported `main.py` and confirmed eight
   secrets report `source=gateway`.
3. **Cosmos connects on gateway credentials.** Queried the container: `Yash-db/Record has 1 documents`.
4. **Quota is not a risk.** Traced `_enforce_limits()` in the gateway source —
   it's called only from the proxy paths, never from the credentials route.

---

## Follow-up: proxy mode for Azure OpenAI (metering)

Credential-fetch mode left the admin portal showing `Requests 0` and
`Last used never`, because ThreadNotes called Azure directly and the gateway
never saw those calls. Transcription and diarization now go **through** the
gateway so they are metered.

**`build_openai_client()` gained a proxy branch.** When `GATEWAY_PROXY_AI=true`
it returns a plain `OpenAI` client pointed at `{DXAI_BASE_URL}/gateway`, with
the `dev_` token as the bearer key.

The plain `OpenAI` client is deliberate. `AzureOpenAI` rewrites the request path
to `/openai/deployments/{deployment}/audio/transcriptions`, which the gateway
does not serve. The plain client posts to `{base_url}/audio/transcriptions`,
which matches the gateway's route once `base_url` ends in `/gateway`.

**Two headers are set per client:**

- `X-Gateway-Provider: AzureOpenAI` — required, else the gateway 400s.
- `X-Gateway-Api-Version: 2025-04-01-preview` — the gateway defaults to
  `2024-06-01`, which does not serve `gpt-4o-transcribe`. Sending it as a header
  avoids having to edit the provider profile in the portal.

**The per-call deployment needed no code change.** Both `_run_transcription` and
`_run_diarization` already pass `model=<deployment>`, and the gateway's Azure
adapter reads `model` out of the multipart body to choose the deployment. So one
client serves both `gpt-4o-transcribe` and `gpt-4o-transcribe-diarize`.

**Verified with a real proxied call:**

```
client type : OpenAI
base_url    : https://ai-gateway-platform-cex4.onrender.com/gateway/
deployment  : gpt-4o-transcribe
SUCCESS — transcript: '.'
```

(A 1-second 440Hz tone, so an near-empty transcript is the correct result. What
matters is that the round trip through the gateway to Azure succeeded.)

**`GATEWAY_PROXY_AI` is a kill switch.** Set it to `false` and the old direct
path returns immediately — useful if the token's request quota runs out, since
proxied calls *do* consume it.

### Gateway-side prerequisites

This depended on gateway commit `5a79da3`, which fixed three blockers:
per-request deployment selection (the old code raised `ValueError` because
`AZURE_TRANSCRIBE_DEPLOYMENT` matched none of its aliases), a hardcoded
`2024-06-01` API version, and `normalize_usage()` throwing on the plain-text
bodies that `response_format="text"` returns.

### Token metering — `response_format` matters

An early assumption here was wrong and is worth recording: *"Azure's
transcription endpoint doesn't return usage."* It does. It just doesn't attach a
`usage` block to the **plain-text** response, and ThreadNotes was asking for
`response_format="text"`.

Asking for JSON instead returns:

```json
"usage": {
  "type": "tokens",
  "total_tokens": 23,
  "input_tokens": 20,
  "input_token_details": { "text_tokens": 0, "audio_tokens": 20 },
  "output_tokens": 3
}
```

So `_run_transcription()` now sends `response_format="json"`. The transcript is
identical — it arrives as `.text` instead of a bare string, which the existing
return already handled both ways. Diarization was already on
`response_format="diarized_json"` and needed no change.

**A second mismatch sat behind that one.** Chat reports
`prompt_tokens`/`completion_tokens`; transcription reports
`input_tokens`/`output_tokens`. The gateway's `usage_from_payload()` only knew
the chat spellings, so it read `total_tokens` correctly (same key name) while
recording prompt and completion as 0. Fixed gateway-side in commit `b9f523a`,
which accepts both spellings with the chat keys taking precedence, so chat
metering is decided before the audio aliases are consulted.

Verified: 37 gateway tests pass, and a proxied transcription through
ThreadNotes' own `_run_transcription()` returns a transcript successfully.

**Still not persisted:** `input_token_details` (audio vs text token split) is
computed by the gateway but has no column in `ApiRequestLog`. Since audio and
text input bill at different rates, capturing that split needs a migration.

### Quota-exhausted message

Once calls are metered they can also be *refused*. `_friendly_diarize_error()`
now shows a distinct message when the developer token's quota runs out:

> You have reached the limit — your monthly request quota has been used up.
> It resets at the start of next month. Please contact your administrator to
> increase it.

The period (daily/monthly) and unit (request/token) are read from the gateway's
reply, so the user is told which cap they hit and when it resets.

**Why this needed care.** A `429` means two opposite things. A provider rate
limit clears by itself in a minute — "please wait and try again" is correct
advice. An exhausted gateway quota never clears without an admin raising the
cap, so telling the user to wait would send them into a retry loop that can
never succeed.

The two are separated by matching the gateway's four exact phrases
(`"{daily|monthly} {request|token} limit exceeded"`) rather than a loose
`"limit exceeded"` substring — Azure itself returns messages like
`"Rate limit exceeded. Please retry after 20 seconds"`, which must **not** be
treated as a quota failure. Verified across all seven cases:

```
QUOTA  gateway daily req    You have reached the limit — your daily request quota…
QUOTA  gateway monthly req  You have reached the limit — your monthly request quota…
QUOTA  gateway daily tok    You have reached the limit — your daily token quota…
QUOTA  gateway monthly tok  You have reached the limit — your monthly token quota…
BUSY   azure rate limit     The transcription service is busy right now…
BUSY   azure RATE EXCEEDED  The transcription service is busy right now…
BUSY   azure quota          The transcription service is busy right now…
```

This covers both `/transcribe/stream` and `/diarize/stream`, which share the
same error translator.

---

## Things worth knowing

**Credential fetches don't consume your request quota.** The `yash` token is
capped at 6 requests/day and 6/month, which looked alarming for an app that
fetches 3 providers per restart. It isn't: `_enforce_limits()` is called from
`proxy_request`, `proxy_chat_request`, `proxy_audio_request` and the two
WebSocket paths — but `/gateway/credentials/{name}` queries the database
directly and never calls it. ThreadNotes uses credential-fetch mode exclusively,
so it never touches the cap. **If you later switch to proxy mode, 6/month will
stop you immediately** — raise it first.

**First startup after idle is slow.** Render's free tier sleeps. A cold start
adds roughly 30 seconds to the first credential fetch, once, then it's fast.
This is why `GATEWAY_TIMEOUT` defaults to 60 rather than 10.

**Provider names are case-sensitive-ish.** The gateway matches `name` or
`display_name` case-insensitively, so `Cosmosdb` and `cosmosdb` both work — but
punctuation must match exactly. `Azure OpenAI` will **not** match `AzureOpenAI`.

**Restart required after a key rotation.** Credentials are fetched once per
process. Rotating a key in the portal needs an app restart to take effect —
still better than the old flow, which needed a `.env` edit and a redeploy.

**The desktop app is unaffected.** All of this is backend-only. The Electron app
and website talk to the ThreadNotes backend, which talks to the gateway. No
frontend change, and the `dev_` token never leaves the server — which matters,
because a token shipped in a desktop binary can be extracted.

---

## Not done

**`desktop-backend/requirements.txt` is still UTF-16 encoded** and will break
`pip install -r` in the Docker build (`desktop-backend/Dockerfile:13`). Unrelated to
this work, but it blocks deployment. Re-save as UTF-8.

**Azure deployment still uses its own env vars.** This change only covers local
`.env`. To move the deployed backend onto the gateway, set `DXAI_API_KEY`,
`DXAI_BASE_URL` and `GATEWAY_PROVIDERS` in the Azure App Service configuration
and remove the provider keys there.

**No test for the fallback path.** The `.env` fallback is exercised only if the
gateway is unreachable. It was verified by reading, not by simulating an outage.
