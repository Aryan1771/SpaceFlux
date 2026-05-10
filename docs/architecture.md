# Architecture

## Frontend

- Next.js app served from Vercel
- Calls Render backend over HTTPS for auth and room history
- Opens a WebSocket connection to Render for realtime events
- Uses WebRTC for direct file transfer

## Backend

- Express REST API
- WebSocket server on the same Render service
- Uses Turso for persistence
- Keeps realtime presence and peer-connection state in memory

## Database

Primary tables:

- `users`
- `sessions`
- `rooms`
- `room_members`
- `messages`
- `file_transfers`

## Realtime flow

1. User logs in and receives an HttpOnly session cookie
2. Frontend fetches rooms over REST
3. Frontend opens WebSocket and joins room
4. Chat, presence, pointer, and signaling events are broadcast through the backend
5. File transfer happens peer-to-peer after signaling succeeds
