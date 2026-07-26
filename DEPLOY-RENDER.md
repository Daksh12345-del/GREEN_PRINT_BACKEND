# Deploying the Green Print backend to Render

This folder is a standalone Express + Postgres API. It expects a Supabase
Postgres database (see the main README/HONESTY.md if you have them, or
the setup steps below) and serves a frontend hosted separately (e.g. Vercel
— see the `greenprint-frontend` zip for that).

## Steps

1. Push this folder to a GitHub repo (or push the whole `greenprint` project
   and set Render's "Root Directory" to `server`).
2. Go to **https://dashboard.render.com** → **New +** → **Web Service**.
3. Connect your repo. Render should pick up `render.yaml` automatically
   (Blueprint) — or set manually:
   - Root directory: `server`
   - Build command: `npm install`
   - Start command: `npm start`
   - Runtime: Node
4. Add environment variables (Render dashboard → Environment):
   - `DATABASE_URL` — your Supabase **pooler** connection string (see below)
   - `JWT_SECRET` — a long random string (`render.yaml` can auto-generate one)
   - `ALLOWED_ORIGIN` — your Vercel frontend's URL, e.g. `https://greenprint.vercel.app`
   - `GROQ_API_KEY` — optional, for live AI recommendations
   - `GROQ_MODEL` — optional, defaults to `openai/gpt-oss-120b`
5. Deploy. First boot will log:
   ```
   Connecting to Supabase Postgres and running schema migration…
   Seeded 15 emission factors (DEFRA 2026 / CEA v21.0 / EPA AP-42).
   Green Print server running on http://localhost:3000
   ```
6. Your API is now live at `https://your-service-name.onrender.com`. Use
   `https://your-service-name.onrender.com/api` as `VITE_API_URL` when
   deploying the frontend.

## Getting the Supabase connection string (if you haven't already)

Use the **Connection Pooling** URI, not the direct "Connection string" one
— the direct one requires IPv6 and commonly fails with `ENOTFOUND` from
most hosts, Render included.

Supabase dashboard → your project → **Project Settings → Database →
Connection Pooling** → copy the URI (port **5432**, Session mode):
```
postgresql://postgres.xxxxxxxxxxxx:[YOUR-PASSWORD]@aws-0-xx-xxxx-1.pooler.supabase.com:5432/postgres
```

## A note on Render's free tier

Free web services on Render spin down after inactivity and take ~30-50
seconds to wake up on the next request. That's fine for a demo/pilot; if
this needs to feel instant for real users, upgrade to a paid instance type.

## CORS

`ALLOWED_ORIGIN` controls which frontend domain is allowed to call this
API (see `server.js`). Leaving it unset defaults to `*` (any origin) —
fine for quick testing, but set it to your real Vercel URL once you have one.

## Local development

```bash
npm install
cp .env.example .env   # fill in DATABASE_URL, JWT_SECRET
npm start
```
Runs on `http://localhost:3000`. Pair with the frontend's `npm run dev`
(no `VITE_API_URL` needed locally — see the frontend's own deploy guide).
