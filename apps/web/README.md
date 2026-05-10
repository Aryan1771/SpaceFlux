# SiteShare Web

Next.js frontend deployed on Vercel.

## Environment

Copy `.env.local.example` to `.env.local` and set:

- `NEXT_PUBLIC_API_BASE_URL`
- `NEXT_PUBLIC_WS_URL`

Example local values:

```env
NEXT_PUBLIC_API_BASE_URL=http://localhost:4000
NEXT_PUBLIC_WS_URL=ws://localhost:4000
```

## Local run

```bash
npm install
npm run dev
```

## Deploy on Vercel

- Root directory: `apps/web`
- Framework preset: Next.js
- Add the two public environment variables from your deployed Render backend
