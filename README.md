# Threshold

**ThreadNotes** — a Windows desktop app that records meetings, transcribes them with
Azure Speech, and diarizes them with Azure OpenAI, backed by a FastAPI cloud vault.
No provider keys ever ship inside the client.

## Layout

| Path | What it is |
|---|---|
| `desktop-frontend/` | Next.js + Electron desktop client (the shipped `.exe`) |
| `desktop-backend/` | FastAPI "cloud vault" — auth, Azure token broker, diarization |
| `admin-web/` | Static admin panel (deployed to Vercel) |
| `gateway-sdk/` | Vendored AI Gateway SDK + integration guide |
| `render.yaml` | Render blueprint for the backend service |

## Local development

Two terminals:

```powershell
# 1) Cloud vault on :8000
cd desktop-backend\vault
..\venv\Scripts\activate
uvicorn main:app --host 127.0.0.1 --port 8000
```

```powershell
# 2) Desktop app + website together
cd desktop-frontend
npm install
npm run electron:dev
```

The client reads its API URL from `desktop-frontend/.env.development`.
`dev.bat` launches both at once (vault on :8001).

## Building the installer

Place a static Windows `ffmpeg.exe` at `desktop-frontend\resources\ffmpeg.exe`, then:

```powershell
build-app.bat
```

Output: `desktop-frontend\dist-electron\ThreadNotes Setup x.x.x.exe`.

`NEXT_PUBLIC_API_URL` is inlined at build time, so the backend URL is frozen into
the `.exe` — set `desktop-frontend/.env.production` before building.

## Configuration

Provider secrets live in `desktop-backend/.env`, which is gitignored. When
`DXAI_API_KEY` is set they resolve through the AI Gateway instead, falling back to
`.env` if the gateway is unreachable — see [`gateway-sdk/DEVELOPER.md`](gateway-sdk/DEVELOPER.md).

Deployment steps: [`DEPLOY.md`](DEPLOY.md).
