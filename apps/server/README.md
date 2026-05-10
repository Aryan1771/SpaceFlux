# SiteShare Backend

Render-hosted Node.js backend for:

- auth
- rooms
- chat persistence
- file-transfer metadata
- realtime WebSocket signaling
- `/ping`

## Environment

Copy `.env.example` to `.env` and configure:

- `PORT`
- `DATABASE_URL`
- `DATABASE_AUTH_TOKEN`
- `SESSION_SECRET`
- `FRONTEND_ORIGIN`
- `CORS_ORIGIN`
- `COOKIE_SECURE`

## Turso schema

Run `src/db/schema.sql` against your Turso database before starting the server.

## Local run

```bash
npm install
npm run dev
```

## Deploy on Render

- Root directory: `apps/server`
- Build command: `npm install`
- Start command: `npm start`
- Health check path: `/ping`
