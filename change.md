# Changes Made

---

# Session: 2026-08-17

## ✅ Status: OTP email is working (verified end to end)

A real OTP was sent through the application's own `send_otp_email()` code path:

```
POST https://api.brevo.com/v3/smtp/email -> HTTP 201 Created
[BREVO] OTP email sent to zonelittlebaby@gmail.com
        {'messageId': '<202608170945.61407068720@smtp-relay.mailin.fr>'}
```

Account state confirmed healthy: plan `free`, **300 send credits**, sender
`zonelittlebaby@gmail.com` `active=True`. The earlier *"0 left out of 0"*
dashboard reading was activation lag, not a real quota problem.

### Resolved along the way — Brevo IP authorization

Brevo initially rejected every API call from this machine:

```
HTTP 401 {"message":"We have detected you are using an unrecognised IP address
103.139.56.248. ...","code":"unauthorized"}
```

This cleared once IP blocking was set to **Deactivated** for API keys at
https://app.brevo.com/security/authorised_ips.

Worth remembering: the Security page showed *"API keys: Deactivated"* while
Brevo was **still** returning 401 for the unrecognised IP. The toggle's display
state lagged the enforcement. If 401s reappear, trust the API response over the
dashboard, and either re-toggle blocking off or authorize the IP explicitly.

This is a residential IP and can change when the router reconnects. When the
backend is deployed to Azure, the App Service outbound IP must be allowed too —
or IP blocking left deactivated.

---

## 1. Cosmos DB was not connected — database name case mismatch

**File:** `desktop-backend/.env`

**Issue:** Every request touching the database returned `500 Internal Server
Error`. `POST /login` returned 500 instead of the expected 401.

**Cause:** `COSMOS_DATABASE` was set to `yash-db`, but the database in the
Cosmos account is named `Yash-db` with a capital Y. **Cosmos DB resource names
are case-sensitive**, so every query failed with `CosmosResourceNotFoundError
(404)`.

The startup log was misleading here — it printed `COSMOS_DATABASE present=True`,
which only confirms the variable is set, not that it points at a real database.
The Cosmos client is also built lazily (`get_users_container()`,
`desktop-backend/vault/main.py:104-112`), so a clean startup never proved connectivity.

**Verified by listing the account directly:**

```
databases found: 3
  - 'krishna-cosmos-db'       containers: users, jobs
  - 'krishna-threadnotes-db'  containers: users
  - 'Yash-db'                 containers: Record  (partitionKey /tenantIdy)

COSMOS_DATABASE='yash-db' -> CosmosResourceNotFoundError (404)
COSMOS_DATABASE='Yash-db' -> OK, 'Record' has 0 documents
```

**Change:**

```diff
- COSMOS_DATABASE=yash-db
+ COSMOS_DATABASE=Yash-db
```

**Note:** the `Record` container holds **0 documents**, so no user accounts exist
yet. Login will correctly return 401 until someone completes signup.

---

## 2. Gmail OTP sending was broken — revoked OAuth token

**File:** `desktop-backend/token.json`

**Issue:** Signup could not complete. `POST /signup` rejects any email that has
not been OTP-verified first (`desktop-backend/vault/main.py:352-358`), and
`/send-signup-otp` could not send the code.

**Cause:** the stored OAuth refresh token is dead:

```
token loaded. valid=False expired=True has_refresh=True
refreshing...
RESULT: GMAIL FAILED -> RefreshError: ('invalid_grant: Bad Request')
```

`invalid_grant` means Google is rejecting the refresh token outright — it has
been revoked or expired. Restarting cannot help. Usual causes: the Google Cloud
project is still in "Testing" mode (those refresh tokens expire after 7 days),
the token sat unused for six months, or the account password changed.

**Resolution:** rather than regenerate the token, OTP sending was migrated to
Brevo (section 3). The Gmail code path is retained as a fallback.

---

## 3. OTP email migrated to Brevo

**Files:** `desktop-backend/vault/main.py`, `desktop-backend/.env`

**Why Brevo:** it is the only major free transactional email service that does
not require you to own a domain — you verify a single sender address and can
send to any recipient. Free tier is 300 emails/day. Unlike an OAuth refresh
token, an API key does not silently expire.

**Change:** added `_send_otp_via_brevo()`, which posts to Brevo's
`/v3/smtp/email` endpoint using `httpx` (already a dependency — no new
packages). `send_otp_email()` now dispatches on whether `BREVO_API_KEY` is set:

```python
def send_otp_email(target_email: str, otp: str, subject_prefix: str):
    if BREVO_API_KEY:
        return _send_otp_via_brevo(target_email, otp, subject_prefix)
    # ... existing Gmail API path unchanged ...
```

This means the Gmail path still runs when the key is absent, so nothing breaks
if `BREVO_API_KEY` is left blank in another environment. Callers, OTP
generation, and OTP verification are all untouched.

Failures now log the full Brevo response body rather than a bare 502, so a
rejected send states its own cause.

**Sender address:** the Brevo account verified `zonelittlebaby@gmail.com`, not
`threadnotes12@gmail.com`. Brevo rejects any From address that is not verified.
Rather than overwrite `GMAIL_SENDER` — which is also set in the Azure
deployment and feeds the Gmail fallback — a separate `BREVO_SENDER_EMAIL` was
added, falling back to `GMAIL_SENDER` when unset.

**New environment variables in `desktop-backend/.env`:**

```
BREVO_API_KEY=xkeysib-...
BREVO_SENDER_NAME=ThreadNotes
BREVO_SENDER_EMAIL=zonelittlebaby@gmail.com
```

`BREVO_API_KEY` was also added to the startup env log, so each boot prints which
provider is active.

**Deliverability warning:** the Brevo dashboard flags DKIM as `Default` and
DMARC as *"Freemail domain is not recommended"*, because `gmail.com` is a
freemail domain you do not control and Brevo cannot sign as it. Mail sends, but
**OTPs will often land in spam.** Acceptable for testing; use your own domain
before real users.

---

## 4. Outstanding issues (not yet fixed)

**`desktop-backend/requirements.txt` is UTF-16 encoded.** It reads as spaced-out
characters (`f a s t a p i = = 0 . 1 1 5 . 0`). `pip install -r` will fail on
this inside the Docker build (`desktop-backend/Dockerfile:13`). Re-save it as UTF-8
before the next deploy.

**Partition key mismatch.** The `Record` container's partition key is
`/tenantIdy` (note the trailing "y"), but signup writes a field named
`tenantId` (`desktop-backend/vault/main.py:374`). Cosmos accepts documents missing the
partition key path, so writes succeed, but every document lands in a single
undefined partition. This is a scaling concern, not a correctness bug, and it
looks like a typo in the container definition.

**`JWT_SECRET` is not set.** The backend falls back to a hardcoded default
(`desktop-backend/vault/main.py:27`). Fine locally; must be set in production.

**`GMAIL_SENDER` is now commented out** in `desktop-backend/.env`. This is harmless
while Brevo is active, since `BREVO_SENDER_EMAIL` is set explicitly. But it
means the Gmail fallback path would send with no `From` header if
`BREVO_API_KEY` were ever cleared. Uncomment it if you restore the Gmail path.

---

## 5. How to run the app

**One backend serves both the desktop app and the website** — do not start it
twice. Two terminals total.

**Terminal 1 — backend:**

```powershell
cd desktop-backend\vault
..\venv\Scripts\activate
uvicorn main:app --host 127.0.0.1 --port 8000
```

**Terminal 2 — desktop + website together:**

```powershell
cd desktop-frontend
npm run electron:dev
```

`electron:dev` (`desktop-frontend/package.json:12`) runs `next dev` and Electron side by
side, so the website comes up at http://localhost:3000 and the desktop window
opens pointing at that same dev server (`desktop-frontend/electron/main.js:469-470`
loads `localhost:3000` whenever the app is not packaged).

To run them separately, use `npm run dev` for the website and `npm run electron`
in a third terminal. **Do not** run `npm run dev` and `npm run electron:dev` at
the same time — `electron:dev` starts its own Next server and the two will
fight over port 3000.

**Restarting is required after any `.env` change.** The Cosmos client is cached
in a module-level global, so a reload will not reconnect on its own.

---

# Earlier sessions

## Frontend Environment Configuration
**Files:** `desktop-frontend/.env` and `desktop-frontend/.env.development`

**Issue:**
The frontend was failing to log in with a "Failed to fetch" error because it was trying to connect to the production backend URL (`https://threadnotes-backend.onrender.com`) instead of the local backend running on port 8000. Additionally, Next.js was prioritizing `.env.development` which still had the wrong URL.

**Change:**
Updated the `NEXT_PUBLIC_API_URL` environment variable in both files to point to the local backend using `127.0.0.1` (which works better with Electron than `localhost`).

**Code Change:**
```diff
- NEXT_PUBLIC_API_URL=https://threadnotes-backend.onrender.com
+ NEXT_PUBLIC_API_URL=http://127.0.0.1:8000
```

Note that `desktop-frontend/.env.production` still points at the Azure backend
(`https://threadnotes-desktop-backend-...azurewebsites.net`), so a packaged
desktop build talks to Azure rather than your local server.

## Backend Server Status
**Issue:**
The frontend was still showing "Failed to fetch" even after updating the API URL.

**Cause:**
The backend server (`uvicorn`) was stopped or shut down. The frontend cannot connect to a server that is not running.

**Fix:**
Ensure the backend server is running continuously in its own terminal window. The `--reload` flag was causing the server to crash on your machine, so it has been removed.

## Admin vs Regular User Login
**Issue:**
Trying to log in with `siddhantsingh898989@gmail.com` on the main login screen fails with "Invalid credentials" or "Failed to fetch" (if the backend is down).

**Cause:**
`siddhantsingh898989@gmail.com` is configured as the `ADMIN_EMAIL` in `desktop-backend/.env`. The main login screen (`/login`) is for regular users stored in Cosmos DB, not for the admin account.

**Fix:**
To log in on the main screen, you must first create a regular user account:
1. Click **Sign up** at the bottom of the login screen.
2. Enter your name, email, and a password.
3. Verify your email with the OTP.
4. Log in with those credentials.
</content>
