# SpaceFlux

SpaceFlux is a responsive room-based collaboration app with separate frontend and backend deployments. Users can create accounts, join multiple rooms by code, chat, share files directly over WebRTC, and see live mouse pointers on larger screens.

## Stack

- Frontend: Next.js on Vercel Hobby
- Backend: Node.js + Express + WebSocket server on Render
- Database: Turso
- Auth: Cookie-based sessions
- File transfer: WebRTC data channels

## Features

- Account signup, login, logout
- Create rooms and join rooms by room code
- Join multiple rooms per account
- Room chat with persisted history
- Live pointer sharing on desktop and tablet
- Direct peer-to-peer file transfer for phone and desktop
- Theme settings: light, dark, system
- `GET /ping` for Uptime Robot

## Monorepo layout

```text
SpaceFlux/
├─ apps/
│  ├─ server/   # Render backend
│  └─ web/      # Vercel frontend
├─ docs/
├─ .gitignore
├─ package.json
└─ render.yaml
```

## Quick start

### 1. Create Turso database

Create a Turso database and auth token, then run the schema in `apps/server/src/db/schema.sql`.

### 2. Configure backend

Copy `apps/server/.env.example` to `apps/server/.env` and fill in:

- `DATABASE_URL`
- `DATABASE_AUTH_TOKEN`
- `SESSION_SECRET`
- `FRONTEND_ORIGIN`
- `CORS_ORIGIN`

### 3. Configure frontend

Copy `apps/web/.env.local.example` to `apps/web/.env.local` and fill in:

- `NEXT_PUBLIC_API_BASE_URL`
- `NEXT_PUBLIC_WS_URL`

### 4. Install and run

From the repo root:

```bash
npm install
npm run dev
```

This runs:

- frontend on `http://localhost:3000`
- backend on `http://localhost:4000`

## Deployment

### Vercel

- Project root directory: `apps/web`
- Framework preset: Next.js
- Set the frontend environment variables from the example file

### Render

- Service type: Web Service
- Region: choose the closest region to your users
- Root directory: `apps/server`
- Build command: `npm install`
- Start command: `npm start`
- Add backend environment variables from the example file
- Use `/ping` with Uptime Robot

## Important limits

- The backend stores file metadata only
- File binaries are not stored in Turso
- Large file transfers require both peers to be online
- Pointer sharing is intentionally hidden on phone layouts
- Hosting plans may suspend idle services; verify current provider limits before deployment

## Configuration and security

- Passwords are hashed with Argon2
- Sessions are stored server-side and sent via HttpOnly cookies
- No secrets should be committed; use the provided example env files

## Documentation

- [Backend setup](apps/server/README.md)
- [Frontend setup](apps/web/README.md)
- [Architecture](docs/architecture.md)

## License

See [LICENSE](LICENSE) for the GNU GPL v3 terms.
