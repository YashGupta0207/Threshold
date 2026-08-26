"""Resolve provider secrets from the AI Gateway, with .env as the fallback.

Instead of storing real provider keys in .env, this module fetches them at
startup using a single developer token (`dev_...`). The token is the only
secret that lives on this machine.

Design notes
------------
* **Fetched once per process.** `main.py` reads its config as module-level
  constants, so the fetch has to happen at import time, before those lines run.
  It also means a running server never re-hits the gateway — which matters,
  because developer tokens carry request quotas.

* **Never fatal.** If the gateway is unreachable, slow, or the token is
  rejected, every failure is logged and we fall back to `os.getenv`. A gateway
  outage must not take the backend down, and it must not turn into a confusing
  error three layers deeper.

* **Any number of providers.** `GATEWAY_PROVIDERS` is a comma-separated list.
  One provider, five providers, or none — same code path.

Configuration (.env)
--------------------
    DXAI_API_KEY=dev_xxxxxxxx           # required to enable the gateway
    DXAI_BASE_URL=https://...           # optional, defaults to the hosted gateway
    GATEWAY_PROVIDERS=Cosmosdb,AzureOpenAI,AzureSpeechKey
    GATEWAY_TIMEOUT=60                  # optional, seconds
"""
from __future__ import annotations

import logging
import os
import time

import httpx

log = logging.getLogger("threadnotes.gateway")

DEFAULT_BASE_URL = "https://ai-gateway-platform-cex4.onrender.com"

GATEWAY_TOKEN = os.getenv("DXAI_API_KEY", "").strip()
GATEWAY_BASE_URL = (os.getenv("DXAI_BASE_URL") or DEFAULT_BASE_URL).rstrip("/")
GATEWAY_PROVIDERS = [
    p.strip() for p in os.getenv("GATEWAY_PROVIDERS", "").split(",") if p.strip()
]
# The gateway runs on Render's free tier, where a cold start can take ~30s.
# A short timeout here reads as "gateway is down" when it is merely waking up.
GATEWAY_TIMEOUT = float(os.getenv("GATEWAY_TIMEOUT", "60"))

# Flat {VARIABLE_NAME: value} map merged across every provider we fetched.
_secrets: dict[str, str] = {}
_loaded = False
_last_attempt = 0.0

# The gateway is itself on Render's free tier. If it happens to be spun down
# when this process boots, the first request pays a ~50s cold start and can
# still time out, so one attempt is not enough.
_RETRY_DELAYS = (2.0, 5.0)

# Ceiling on one whole load(), across every provider. load() runs at import, so
# an unbounded retry budget would multiply by the provider count and stall boot
# long enough for Render's health check to fail the deploy. Since a failed load
# is no longer latched, giving up early costs nothing -- the next request
# retries, by which point these attempts have usually woken the gateway anyway.
_LOAD_BUDGET = 25.0

# A failed load leaves _loaded False so a later call can retry. This is the
# floor between those retries, so a broken gateway cannot be hammered once per
# secret() call.
_RETRY_COOLDOWN = 30.0


def _fetch_provider(
    client: httpx.Client, provider: str, deadline: float
) -> dict[str, str]:
    """Fetch one provider's credentials. Returns {} on any failure.

    Retries transport errors and 5xx, which is what a waking gateway looks
    like. A 4xx is a real answer -- bad token, unknown provider, unauthorised
    -- and retrying it would only delay the log line that explains the problem.
    """
    resp = None
    for attempt, delay in enumerate((0.0,) + _RETRY_DELAYS):
        if delay:
            if time.monotonic() >= deadline:
                log.warning(
                    "GATEWAY %-18s giving up early, load budget spent", provider
                )
                break
            time.sleep(delay)
        try:
            resp = client.get(f"/gateway/credentials/{provider}")
        except httpx.RequestError as exc:
            log.warning(
                "GATEWAY %-18s unreachable (try %d): %s", provider, attempt + 1, exc
            )
            resp = None
            continue
        if resp.status_code < 500:
            break
        log.warning(
            "GATEWAY %-18s HTTP %s (try %d), retrying",
            provider, resp.status_code, attempt + 1,
        )

    if resp is None:
        return {}

    if resp.status_code != 200:
        # The gateway's error bodies are specific and worth surfacing verbatim:
        # 403 means "token valid but not authorized for this provider", which
        # looks nothing like 401 "bad token" but is easy to confuse.
        log.warning(
            "GATEWAY %-18s HTTP %s: %s", provider, resp.status_code, resp.text[:200]
        )
        return {}

    try:
        creds = resp.json().get("credentials") or {}
    except ValueError:
        log.warning("GATEWAY %-18s returned a non-JSON body", provider)
        return {}

    log.info("GATEWAY %-18s OK: %s", provider, ", ".join(sorted(creds)) or "(empty)")
    return {str(k): str(v) for k, v in creds.items()}


def load() -> dict[str, str]:
    """Fetch every configured provider and merge the results.

    Success is latched; failure is NOT. An earlier version set _loaded before
    fetching, so one transient failure -- a gateway that happened to be cold at
    boot -- left the process permanently secret-less and serving 500s until
    somebody restarted it by hand. Now a failed attempt can be retried by the
    next caller, subject to _RETRY_COOLDOWN.
    """
    global _loaded, _last_attempt
    if _loaded:
        return _secrets

    if not GATEWAY_TOKEN:
        _loaded = True
        log.info("GATEWAY disabled (no DXAI_API_KEY) — using .env values")
        return _secrets
    if not GATEWAY_PROVIDERS:
        _loaded = True
        log.warning("GATEWAY DXAI_API_KEY is set but GATEWAY_PROVIDERS is empty")
        return _secrets

    now = time.monotonic()
    if _last_attempt and (now - _last_attempt) < _RETRY_COOLDOWN:
        return _secrets
    _last_attempt = now
    deadline = now + _LOAD_BUDGET

    log.info(
        "GATEWAY fetching %d provider(s) from %s",
        len(GATEWAY_PROVIDERS), GATEWAY_BASE_URL,
    )
    with httpx.Client(
        base_url=GATEWAY_BASE_URL,
        headers={"Authorization": f"Bearer {GATEWAY_TOKEN}"},
        timeout=GATEWAY_TIMEOUT,
    ) as client:
        for provider in GATEWAY_PROVIDERS:
            for name, value in _fetch_provider(client, provider, deadline).items():
                if name in _secrets and _secrets[name] != value:
                    # Two providers exporting the same variable name is a
                    # config mistake worth shouting about — otherwise whichever
                    # provider happens to be listed first silently wins.
                    log.warning(
                        "GATEWAY %r supplied by multiple providers; keeping first", name
                    )
                    continue
                _secrets[name] = value

    if _secrets:
        _loaded = True
        log.info("GATEWAY resolved %d secret(s)", len(_secrets))
    else:
        log.error(
            "GATEWAY resolved 0 secret(s) — will retry in %.0fs. "
            "Until it succeeds this vault cannot reach Cosmos or Azure.",
            _RETRY_COOLDOWN,
        )
    return _secrets


def secret(name: str, default: str = "") -> str:
    """Read a secret: gateway first, then .env, then the default.

    Drop-in replacement for os.getenv(name, default). Gateway values win so
    that rotating a key in the admin portal takes effect without redeploying,
    but a local .env override still works when the gateway is unavailable.
    """
    load()
    value = _secrets.get(name)
    if value is None or value == "":
        value = os.getenv(name, default)
    return value if value is not None else default


def source_of(name: str) -> str:
    """Where a given secret came from. Diagnostics only — never logs values."""
    load()
    if _secrets.get(name):
        return "gateway"
    if os.getenv(name):
        return ".env"
    return "missing"
