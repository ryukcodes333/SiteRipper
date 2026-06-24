# SiteRipper — Full Render Deployment Guide

This guide walks you through deploying SiteRipper on [Render](https://render.com) from zero to a live URL. SiteRipper has two services:

| Service | What it is | Render type |
|---|---|---|
| **API Server** | Express 5 + scraper + WebSocket terminal | Web Service (Node.js) |
| **Frontend** | React + Vite SPA | Static Site |

---

## Step 0 — Prerequisites

1. A [Render account](https://render.com) (free tier works)
2. A [GitHub account](https://github.com) — Render deploys from Git
3. A **Clerk account** at [clerk.com](https://clerk.com) (free tier) — for auth
4. A **PostgreSQL database** — Render provides one free (or use Neon/Supabase)

---

## Step 1 — Push code to GitHub

Unzip `siteripper-source.zip`, then:

```bash
cd siteripper
git init
git add .
git commit -m "Initial commit"
gh repo create siteripper --public --push --source=.
# or push to an existing repo manually
```

---

## Step 2 — Create a PostgreSQL database on Render

1. In the Render dashboard → **New +** → **PostgreSQL**
2. Name it `siteripper-db`
3. Choose the **Free** plan
4. Click **Create Database**
5. After it's created, copy the **Internal Database URL** — you'll need it shortly

---

## Step 3 — Set up Clerk (Auth)

1. Go to [clerk.com](https://clerk.com) → Create application
2. Name it **SiteRipper**, enable **Google** as a sign-in option
3. Go to **API Keys** in the Clerk dashboard
4. Copy:
   - `CLERK_PUBLISHABLE_KEY` (starts with `pk_live_...` or `pk_test_...`)
   - `CLERK_SECRET_KEY` (starts with `sk_live_...` or `sk_test_...`)
5. After deploying (Step 6), come back and add your Render domain to Clerk → **Domains** (e.g. `siteripper-api.onrender.com`)

---

## Step 4 — Deploy the API Server (Web Service)

1. Render dashboard → **New +** → **Web Service**
2. Connect your GitHub repo
3. Fill in the settings:

| Field | Value |
|---|---|
| **Name** | `siteripper-api` |
| **Region** | Pick closest to you |
| **Branch** | `main` |
| **Runtime** | **Node** |
| **Build Command** | `npm install -g pnpm && pnpm install --frozen-lockfile && pnpm --filter @workspace/api-server run build` |
| **Start Command** | `node --enable-source-maps artifacts/api-server/dist/index.mjs` |
| **Instance Type** | Free (or Starter for always-on) |

4. Click **Advanced** → **Add Environment Variables** and add all of these:

```
PORT                    = 10000
NODE_ENV                = production
DATABASE_URL            = <paste your Render Postgres Internal URL>
CLERK_SECRET_KEY        = <from Clerk dashboard>
CLERK_PUBLISHABLE_KEY   = <from Clerk dashboard>
SESSION_SECRET          = <any random 32+ character string>
```

> **How to generate SESSION_SECRET:**
> Run this in any terminal: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`

5. Click **Create Web Service** — Render will build and deploy (takes ~2 minutes)
6. Once deployed, copy your service URL: `https://siteripper-api.onrender.com`

### Verify the API is alive

Visit `https://siteripper-api.onrender.com/api/healthz` — you should see `{"ok":true}`.

---

## Step 5 — Deploy the Frontend (Static Site)

1. Render dashboard → **New +** → **Static Site**
2. Connect the same GitHub repo
3. Fill in the settings:

| Field | Value |
|---|---|
| **Name** | `siteripper` |
| **Branch** | `main` |
| **Build Command** | `npm install -g pnpm && pnpm install --frozen-lockfile && pnpm --filter @workspace/siteripper run build` |
| **Publish Directory** | `artifacts/siteripper/dist/public` |

4. Click **Advanced** → **Add Environment Variables**:

```
VITE_CLERK_PUBLISHABLE_KEY  = <same key from Clerk>
PORT                        = 4173
BASE_PATH                   = /
```

> Note: `VITE_` prefix is required — Vite only exposes variables with this prefix to the browser.

5. Click **Create Static Site**

Once deployed you'll get a URL like `https://siteripper.onrender.com`.

---

## Step 6 — Connect Frontend → API (CORS + Clerk)

### Update CORS on the API server

In `artifacts/api-server/src/app.ts`, change the CORS line to allow your frontend domain:

```ts
app.use(cors({
  credentials: true,
  origin: [
    'https://siteripper.onrender.com',   // your Render static site URL
    'http://localhost:5173',              // local dev
  ],
}));
```

Commit and push — Render auto-redeploys.

### Tell the frontend where the API lives

In `artifacts/siteripper/src/App.tsx` (and any API call), the base URL for API requests needs to point to your API server in production. Add this environment variable to your **Static Site** on Render:

```
VITE_API_BASE_URL = https://siteripper-api.onrender.com
```

Then use it in your code wherever you call the API:

```ts
const API = import.meta.env.VITE_API_BASE_URL ?? '';
// e.g. fetch(`${API}/api/scrape`, { ... })
```

### Add your domain to Clerk

1. Clerk dashboard → **Domains**
2. Add `siteripper.onrender.com` (the static site URL) as an **Allowed origin**
3. Add `siteripper-api.onrender.com` as a domain

---

## Step 7 — Run the Database Migration

Once the API server is deployed and `DATABASE_URL` is set, run the schema push. Render doesn't have a built-in console, so do it from your local machine:

```bash
# From the project root:
DATABASE_URL="<your Render Postgres URL>" pnpm --filter @workspace/db run push
```

Or add a one-time **Job** on Render:
- New + → **Cron Job** → same repo
- Command: `pnpm --filter @workspace/db run push`
- Schedule: `0 0 1 1 *` (runs once — just trigger it manually from the Render dashboard)

---

## Step 8 — WebSocket Terminal (Codespace)

The WebSocket terminal connects to `wss://YOUR_API_URL/api/terminal`. This works automatically on Render because Render supports WebSocket upgrades on Web Services.

If you see connection errors:
1. Make sure you're using `wss://` (not `ws://`) in production
2. In `artifacts/siteripper/src/App.tsx`, find the WS URL construction and ensure it uses `location.host` correctly or `VITE_API_BASE_URL`:

```ts
const wsHost = import.meta.env.VITE_API_BASE_URL
  ? import.meta.env.VITE_API_BASE_URL.replace(/^https/, 'wss').replace(/^http/, 'ws')
  : `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`;
const ws = new WebSocket(`${wsHost}/api/terminal`);
```

---

## Step 9 — Custom Domain (Optional)

1. Render dashboard → your Static Site → **Settings** → **Custom Domains**
2. Add your domain (e.g. `siteripper.com`)
3. Add the CNAME record Render shows you to your DNS provider
4. Render auto-provisions a TLS certificate

Do the same for the API service if you want it on a subdomain like `api.siteripper.com`.

---

## Environment Variables — Full Reference

### API Server (Web Service)

| Variable | Required | Description |
|---|---|---|
| `PORT` | ✅ | Set to `10000` on Render |
| `NODE_ENV` | ✅ | `production` |
| `DATABASE_URL` | ✅ | Postgres connection string |
| `CLERK_SECRET_KEY` | ✅ | From Clerk dashboard (server-side) |
| `CLERK_PUBLISHABLE_KEY` | ✅ | From Clerk dashboard |
| `SESSION_SECRET` | ✅ | Random 32+ char string |

### Frontend (Static Site)

| Variable | Required | Description |
|---|---|---|
| `VITE_CLERK_PUBLISHABLE_KEY` | ✅ | From Clerk dashboard (browser-safe) |
| `VITE_API_BASE_URL` | ✅ | Full URL of your API server |
| `PORT` | ✅ | `4173` (Vite preview port) |
| `BASE_PATH` | ✅ | `/` |

---

## Render Service Architecture Diagram

```
User's browser
      │
      ▼
┌─────────────────────────────────┐
│  Render Static Site             │
│  siteripper.onrender.com        │
│  (React/Vite SPA)               │
└──────────────┬──────────────────┘
               │ HTTPS API calls + WSS
               ▼
┌─────────────────────────────────┐
│  Render Web Service             │
│  siteripper-api.onrender.com    │
│  (Express 5 + WebSocket)        │
│                                 │
│  /api/scrape  ← BFS crawler     │
│  /api/terminal ← WS shell       │
│  /api/scrape/preview/:id ← ZIP  │
└──────────────┬──────────────────┘
               │
               ▼
┌─────────────────────────────────┐
│  Render PostgreSQL              │
│  (user sessions, job history)   │
└─────────────────────────────────┘
               │
               ▼
┌─────────────────────────────────┐
│  Clerk (hosted, external)       │
│  (auth, Google OAuth)           │
└─────────────────────────────────┘
```

---

## Common Problems & Fixes

| Problem | Fix |
|---|---|
| Build fails: `workspace:*` not found | Make sure you run `pnpm install --frozen-lockfile` from the **repo root**, not from inside an artifact folder |
| API returns 404 | Check that the Start Command points to `artifacts/api-server/dist/index.mjs` and the build ran first |
| CORS error in browser | Add your static site URL to the `origin` array in `app.ts` |
| Clerk "invalid publishable key" | Use `VITE_CLERK_PUBLISHABLE_KEY` (with VITE_ prefix) in the static site env vars |
| WebSocket disconnects | Free tier Render services sleep after 15 min of inactivity — upgrade to Starter ($7/mo) for always-on |
| DB migration not applied | Run `DATABASE_URL="..." pnpm --filter @workspace/db run push` from local or a Render one-off job |
| ZIP download is empty | This is an in-memory job store — scrape jobs reset on server restart; add persistent job storage to fix |

---

## Free Tier Limitations on Render

- **Web Services** spin down after 15 minutes of inactivity and take ~30s to wake up on the next request
- **PostgreSQL** databases on the free plan are deleted after 90 days (upgrade to $7/mo to keep them)
- **Static Sites** are always-on and free with no limits

**Recommended paid upgrade path:** Upgrade the API Web Service to **Starter ($7/mo)** — this keeps it always-on and removes the cold-start delay.
