import "dotenv/config";

import cookieParser from "cookie-parser";
import cors from "cors";
import cookie from "cookie";
import express from "express";
import http from "node:http";
import { nanoid } from "nanoid";
import { WebSocketServer } from "ws";

import { db, queryMany, queryOne } from "./db.js";
import {
  buildCookieOptions,
  cookieName,
  generateSessionToken,
  getSessionExpiry,
  hashPassword,
  hashText,
  normalizeCode,
  normalizeEmail,
  normalizeName,
  sanitizeMessage,
  sanitizeRoomName,
  verifyPassword
} from "./utils/auth.js";
import { createRoomCode, makePointerColor } from "./utils/rooms.js";

const PORT = Number(process.env.PORT || 4000);
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || "http://localhost:3000";
const CORS_ORIGIN = process.env.CORS_ORIGIN || FRONTEND_ORIGIN;
const MAX_CHAT_HISTORY = 50;
const POINTER_MIN_INTERVAL_MS = 75;

const app = express();
const server = http.createServer(app);
const wsServer = new WebSocketServer({ server });

const roomConnections = new Map();
const socketState = new Map();

app.use(cors({
  origin: CORS_ORIGIN,
  credentials: true
}));
app.use(express.json({ limit: "1mb" }));
app.use(cookieParser());

function asPlainRow(row) {
  if (!row) {
    return null;
  }

  return Object.fromEntries(Object.entries(row));
}

function asPlainRows(rows) {
  return rows.map((row) => asPlainRow(row));
}

async function createSessionForUser(userId) {
  const token = generateSessionToken();
  const sessionId = nanoid();
  const tokenHash = hashText(token);
  const expiresAt = getSessionExpiry();

  await db.execute({
    sql: "INSERT INTO sessions (id, user_id, token_hash, expires_at) VALUES (?, ?, ?, ?)",
    args: [sessionId, userId, tokenHash, expiresAt.toISOString()]
  });

  return { token, expiresAt };
}

async function getUserFromSessionToken(token) {
  if (!token) {
    return null;
  }

  const session = asPlainRow(await queryOne(
    `SELECT sessions.id, sessions.user_id, sessions.expires_at, users.email, users.display_name
     FROM sessions
     JOIN users ON users.id = sessions.user_id
     WHERE sessions.token_hash = ?`,
    [hashText(token)]
  ));

  if (!session) {
    return null;
  }

  if (new Date(session.expires_at).getTime() < Date.now()) {
    await db.execute({
      sql: "DELETE FROM sessions WHERE id = ?",
      args: [session.id]
    });
    return null;
  }

  return {
    id: session.user_id,
    email: session.email,
    displayName: session.display_name
  };
}

async function requireUser(req, res, next) {
  const token = req.cookies[cookieName];
  const user = await getUserFromSessionToken(token);

  if (!user) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  req.user = user;
  next();
}

async function userHasRoomAccess(userId, roomId) {
  const row = await queryOne(
    "SELECT 1 AS allowed FROM room_members WHERE room_id = ? AND user_id = ?",
    [roomId, userId]
  );
  return Boolean(row);
}

function shapeRoom(row) {
  return {
    id: row.id,
    name: row.name,
    joinCode: row.join_code_display,
    ownerId: row.owner_id,
    createdAt: row.created_at
  };
}

function shapeMessage(row) {
  return {
    id: row.id,
    roomId: row.room_id,
    userId: row.user_id,
    displayName: row.display_name,
    content: row.content,
    createdAt: row.created_at
  };
}

function shapeFileTransfer(row) {
  return {
    id: row.id,
    roomId: row.room_id,
    senderId: row.sender_id,
    senderName: row.sender_name,
    recipientId: row.recipient_id,
    recipientName: row.recipient_name,
    filename: row.filename,
    sizeBytes: Number(row.size_bytes),
    mimeType: row.mime_type,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

async function getRoomMembers(roomId) {
  const rows = asPlainRows(await queryMany(
    `SELECT users.id, users.display_name
     FROM room_members
     JOIN users ON users.id = room_members.user_id
     WHERE room_members.room_id = ?
     ORDER BY users.display_name ASC`,
    [roomId]
  ));

  return rows.map((row) => ({
    userId: row.id,
    displayName: row.display_name,
    color: makePointerColor(row.id)
  }));
}

function getRoomConnectionEntry(roomId) {
  if (!roomConnections.has(roomId)) {
    roomConnections.set(roomId, {
      sockets: new Map(),
      pointers: new Map()
    });
  }

  return roomConnections.get(roomId);
}

function addSocketToRoom(roomId, socket, user) {
  const entry = getRoomConnectionEntry(roomId);

  if (!entry.sockets.has(user.id)) {
    entry.sockets.set(user.id, new Set());
  }

  entry.sockets.get(user.id).add(socket);
}

function removeSocketFromRoom(roomId, socket, userId) {
  const entry = roomConnections.get(roomId);

  if (!entry) {
    return false;
  }

  const sockets = entry.sockets.get(userId);
  if (sockets) {
    sockets.delete(socket);
    if (sockets.size === 0) {
      entry.sockets.delete(userId);
      entry.pointers.delete(userId);
    }
  }

  if (entry.sockets.size === 0) {
    roomConnections.delete(roomId);
  }

  return !entry.sockets.has(userId);
}

function getPresence(roomId) {
  const entry = roomConnections.get(roomId);
  if (!entry) {
    return [];
  }

  return [...entry.sockets.keys()];
}

function broadcast(roomId, payload, options = {}) {
  const entry = roomConnections.get(roomId);
  if (!entry) {
    return;
  }

  const message = JSON.stringify(payload);

  for (const [userId, sockets] of entry.sockets.entries()) {
    if (options.excludeUserId && userId === options.excludeUserId) {
      continue;
    }
    if (options.onlyUserId && userId !== options.onlyUserId) {
      continue;
    }

    for (const socket of sockets) {
      if (socket.readyState === socket.OPEN) {
        socket.send(message);
      }
    }
  }
}

async function sendPresenceUpdate(roomId) {
  const members = await getRoomMembers(roomId);
  const onlineUserIds = new Set(getPresence(roomId));

  broadcast(roomId, {
    type: "presence:update",
    payload: members.map((member) => ({
      ...member,
      online: onlineUserIds.has(member.userId)
    }))
  });
}

async function bootstrapRoomState(roomId) {
  const members = await getRoomMembers(roomId);
  const onlineUserIds = new Set(getPresence(roomId));
  const entry = getRoomConnectionEntry(roomId);

  return {
    members: members.map((member) => ({
      ...member,
      online: onlineUserIds.has(member.userId)
    })),
    pointers: [...entry.pointers.values()]
  };
}

async function closeUserSession(req, res) {
  const token = req.cookies[cookieName];
  if (token) {
    await db.execute({
      sql: "DELETE FROM sessions WHERE token_hash = ?",
      args: [hashText(token)]
    });
  }

  res.clearCookie(cookieName, {
    httpOnly: true,
    sameSite: process.env.COOKIE_SECURE === "true" ? "none" : "lax",
    secure: process.env.COOKIE_SECURE === "true",
    path: "/"
  });
}

app.get("/ping", (_req, res) => {
  res.json({
    ok: true,
    service: "spaceflux",
    timestamp: new Date().toISOString()
  });
});

app.post("/auth/register", async (req, res) => {
  const email = normalizeEmail(req.body.email);
  const password = String(req.body.password || "");
  const displayName = normalizeName(req.body.displayName || email.split("@")[0]);

  if (!email || !password || password.length < 8 || !displayName) {
    res.status(400).json({ error: "Invalid registration payload" });
    return;
  }

  const existing = await queryOne("SELECT id FROM users WHERE email = ?", [email]);
  if (existing) {
    res.status(409).json({ error: "Email already in use" });
    return;
  }

  const userId = nanoid();
  const passwordHash = await hashPassword(password);

  await db.execute({
    sql: "INSERT INTO users (id, email, display_name, password_hash) VALUES (?, ?, ?, ?)",
    args: [userId, email, displayName, passwordHash]
  });

  const session = await createSessionForUser(userId);
  res.cookie(cookieName, session.token, buildCookieOptions());

  res.status(201).json({
    user: {
      id: userId,
      email,
      displayName
    }
  });
});

app.post("/auth/login", async (req, res) => {
  const email = normalizeEmail(req.body.email);
  const password = String(req.body.password || "");

  if (!email || !password) {
    res.status(400).json({ error: "Email and password are required" });
    return;
  }

  const user = asPlainRow(await queryOne(
    "SELECT id, email, display_name, password_hash FROM users WHERE email = ?",
    [email]
  ));

  if (!user || !(await verifyPassword(user.password_hash, password))) {
    res.status(401).json({ error: "Invalid credentials" });
    return;
  }

  const session = await createSessionForUser(user.id);
  res.cookie(cookieName, session.token, buildCookieOptions());

  res.json({
    user: {
      id: user.id,
      email: user.email,
      displayName: user.display_name
    }
  });
});

app.post("/auth/logout", requireUser, async (req, res) => {
  await closeUserSession(req, res);
  res.json({ ok: true });
});

app.get("/me", requireUser, async (req, res) => {
  res.json({ user: req.user });
});

app.get("/rooms", requireUser, async (req, res) => {
  const rows = asPlainRows(await queryMany(
    `SELECT rooms.id, rooms.name, rooms.owner_id, rooms.join_code_display, rooms.created_at
     FROM room_members
     JOIN rooms ON rooms.id = room_members.room_id
     WHERE room_members.user_id = ?
     ORDER BY rooms.created_at DESC`,
    [req.user.id]
  ));

  res.json({ rooms: rows.map(shapeRoom) });
});

app.post("/rooms", requireUser, async (req, res) => {
  const name = sanitizeRoomName(req.body.name);

  if (!name) {
    res.status(400).json({ error: "Room name is required" });
    return;
  }

  let code = createRoomCode(6);
  while (await queryOne("SELECT id FROM rooms WHERE join_code_hash = ?", [hashText(code)])) {
    code = createRoomCode(6);
  }

  const roomId = nanoid();
  await db.execute({
    sql: "INSERT INTO rooms (id, name, owner_id, join_code_hash, join_code_display) VALUES (?, ?, ?, ?, ?)",
    args: [roomId, name, req.user.id, hashText(code), code]
  });
  await db.execute({
    sql: "INSERT INTO room_members (room_id, user_id) VALUES (?, ?)",
    args: [roomId, req.user.id]
  });

  const room = shapeRoom(asPlainRow(await queryOne(
    "SELECT id, name, owner_id, join_code_display, created_at FROM rooms WHERE id = ?",
    [roomId]
  )));

  res.status(201).json({ room });
});

app.post("/rooms/join", requireUser, async (req, res) => {
  const code = normalizeCode(req.body.code);

  if (!code) {
    res.status(400).json({ error: "Room code is required" });
    return;
  }

  const room = asPlainRow(await queryOne(
    "SELECT id, name, owner_id, join_code_display, created_at FROM rooms WHERE join_code_hash = ?",
    [hashText(code)]
  ));

  if (!room) {
    res.status(404).json({ error: "Room not found" });
    return;
  }

  await db.execute({
    sql: "INSERT OR IGNORE INTO room_members (room_id, user_id) VALUES (?, ?)",
    args: [room.id, req.user.id]
  });

  res.json({ room: shapeRoom(room) });
});

app.post("/rooms/:roomId/leave", requireUser, async (req, res) => {
  const { roomId } = req.params;

  await db.execute({
    sql: "DELETE FROM room_members WHERE room_id = ? AND user_id = ?",
    args: [roomId, req.user.id]
  });

  res.json({ ok: true });
});

app.get("/rooms/:roomId/messages", requireUser, async (req, res) => {
  const { roomId } = req.params;

  if (!(await userHasRoomAccess(req.user.id, roomId))) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  const rows = asPlainRows(await queryMany(
    `SELECT messages.id, messages.room_id, messages.user_id, messages.content, messages.created_at, users.display_name
     FROM messages
     JOIN users ON users.id = messages.user_id
     WHERE messages.room_id = ?
     ORDER BY messages.created_at DESC
     LIMIT ?`,
    [roomId, MAX_CHAT_HISTORY]
  ));

  res.json({ messages: rows.reverse().map(shapeMessage) });
});

app.get("/rooms/:roomId/files", requireUser, async (req, res) => {
  const { roomId } = req.params;

  if (!(await userHasRoomAccess(req.user.id, roomId))) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  const rows = asPlainRows(await queryMany(
    `SELECT f.id, f.room_id, f.sender_id, sender.display_name AS sender_name,
            f.recipient_id, recipient.display_name AS recipient_name,
            f.filename, f.size_bytes, f.mime_type, f.status, f.created_at, f.updated_at
     FROM file_transfers f
     JOIN users sender ON sender.id = f.sender_id
     LEFT JOIN users recipient ON recipient.id = f.recipient_id
     WHERE f.room_id = ?
     ORDER BY f.created_at DESC
     LIMIT 50`,
    [roomId]
  ));

  res.json({ files: rows.map(shapeFileTransfer) });
});

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(500).json({ error: "Internal server error" });
});

wsServer.on("connection", async (socket, request) => {
  const parsedCookies = cookie.parse(request.headers.cookie || "");
  const token = parsedCookies[cookieName];
  const user = await getUserFromSessionToken(token);

  if (!user) {
    socket.close(4001, "Unauthorized");
    return;
  }

  socket.isAlive = true;
  socketState.set(socket, {
    user,
    joinedRooms: new Set(),
    lastPointerAt: 0
  });

  socket.on("pong", () => {
    socket.isAlive = true;
  });

  socket.on("message", async (rawMessage) => {
    try {
      const message = JSON.parse(rawMessage.toString());
      const state = socketState.get(socket);
      if (!state) {
        return;
      }

      if (message.type === "room:join") {
        const roomId = String(message.payload?.roomId || "");
        if (!roomId || !(await userHasRoomAccess(user.id, roomId))) {
          socket.send(JSON.stringify({ type: "error", payload: { message: "Cannot join room" } }));
          return;
        }

        addSocketToRoom(roomId, socket, user);
        state.joinedRooms.add(roomId);

        socket.send(JSON.stringify({
          type: "room:state",
          payload: {
            roomId,
            ...(await bootstrapRoomState(roomId))
          }
        }));

        await sendPresenceUpdate(roomId);
        return;
      }

      if (message.type === "room:leave") {
        const roomId = String(message.payload?.roomId || "");
        if (!state.joinedRooms.has(roomId)) {
          return;
        }

        state.joinedRooms.delete(roomId);
        removeSocketFromRoom(roomId, socket, user.id);
        await sendPresenceUpdate(roomId);
        return;
      }

      if (message.type === "chat:send") {
        const roomId = String(message.payload?.roomId || "");
        const content = sanitizeMessage(message.payload?.content);

        if (!state.joinedRooms.has(roomId) || !content) {
          return;
        }

        const messageId = nanoid();
        await db.execute({
          sql: "INSERT INTO messages (id, room_id, user_id, content) VALUES (?, ?, ?, ?)",
          args: [messageId, roomId, user.id, content]
        });

        const saved = shapeMessage(asPlainRow(await queryOne(
          `SELECT messages.id, messages.room_id, messages.user_id, messages.content, messages.created_at, users.display_name
           FROM messages
           JOIN users ON users.id = messages.user_id
           WHERE messages.id = ?`,
          [messageId]
        )));

        broadcast(roomId, {
          type: "chat:new",
          payload: saved
        });
        return;
      }

      if (message.type === "pointer:move") {
        const roomId = String(message.payload?.roomId || "");
        if (!state.joinedRooms.has(roomId)) {
          return;
        }

        const now = Date.now();
        if (now - state.lastPointerAt < POINTER_MIN_INTERVAL_MS) {
          return;
        }
        state.lastPointerAt = now;

        const x = Math.max(0, Math.min(1, Number(message.payload?.x || 0)));
        const y = Math.max(0, Math.min(1, Number(message.payload?.y || 0)));
        const viewport = String(message.payload?.viewport || "desktop");
        const entry = getRoomConnectionEntry(roomId);
        const pointer = {
          roomId,
          userId: user.id,
          displayName: user.displayName,
          color: makePointerColor(user.id),
          x,
          y,
          viewport,
          updatedAt: new Date().toISOString()
        };
        entry.pointers.set(user.id, pointer);

        broadcast(roomId, {
          type: "pointer:update",
          payload: pointer
        }, { excludeUserId: user.id });
        return;
      }

      if (message.type === "file:offer") {
        const roomId = String(message.payload?.roomId || "");
        const recipientUserId = String(message.payload?.recipientUserId || "");
        const filename = String(message.payload?.filename || "").trim().slice(0, 160);
        const mimeType = String(message.payload?.mimeType || "application/octet-stream").slice(0, 120);
        const sizeBytes = Number(message.payload?.sizeBytes || 0);
        const clientOfferId = String(message.payload?.clientOfferId || "");

        if (!state.joinedRooms.has(roomId) || !recipientUserId || !filename || !Number.isFinite(sizeBytes) || sizeBytes <= 0) {
          return;
        }

        if (!(await userHasRoomAccess(recipientUserId, roomId))) {
          socket.send(JSON.stringify({ type: "error", payload: { message: "Recipient is not in this room" } }));
          return;
        }

        const transferId = nanoid();
        await db.execute({
          sql: `INSERT INTO file_transfers (id, room_id, sender_id, recipient_id, filename, size_bytes, mime_type, status, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          args: [transferId, roomId, user.id, recipientUserId, filename, sizeBytes, mimeType, "offered", new Date().toISOString()]
        });

        const transfer = shapeFileTransfer(asPlainRow(await queryOne(
          `SELECT f.id, f.room_id, f.sender_id, sender.display_name AS sender_name,
                  f.recipient_id, recipient.display_name AS recipient_name,
                  f.filename, f.size_bytes, f.mime_type, f.status, f.created_at, f.updated_at
           FROM file_transfers f
           JOIN users sender ON sender.id = f.sender_id
           LEFT JOIN users recipient ON recipient.id = f.recipient_id
           WHERE f.id = ?`,
          [transferId]
        )));

        broadcast(roomId, {
          type: "file:offered",
          payload: {
            ...transfer,
            clientOfferId
          }
        }, { onlyUserId: recipientUserId });

        broadcast(roomId, {
          type: "file:status",
          payload: {
            ...transfer,
            clientOfferId
          }
        }, { onlyUserId: user.id });
        return;
      }

      if (message.type === "file:accept") {
        const transferId = String(message.payload?.transferId || "");

        const transfer = asPlainRow(await queryOne(
          "SELECT id, room_id, sender_id, recipient_id FROM file_transfers WHERE id = ?",
          [transferId]
        ));

        if (!transfer || transfer.recipient_id !== user.id) {
          return;
        }

        await db.execute({
          sql: "UPDATE file_transfers SET status = ?, updated_at = ? WHERE id = ?",
          args: ["accepted", new Date().toISOString(), transferId]
        });

        const updatedTransfer = shapeFileTransfer(asPlainRow(await queryOne(
          `SELECT f.id, f.room_id, f.sender_id, sender.display_name AS sender_name,
                  f.recipient_id, recipient.display_name AS recipient_name,
                  f.filename, f.size_bytes, f.mime_type, f.status, f.created_at, f.updated_at
           FROM file_transfers f
           JOIN users sender ON sender.id = f.sender_id
           LEFT JOIN users recipient ON recipient.id = f.recipient_id
           WHERE f.id = ?`,
          [transferId]
        )));

        broadcast(transfer.room_id, {
          type: "file:status",
          payload: updatedTransfer
        }, { onlyUserId: transfer.sender_id });

        broadcast(transfer.room_id, {
          type: "file:status",
          payload: updatedTransfer
        }, { onlyUserId: user.id });
        return;
      }

      if (message.type === "file:complete") {
        const transferId = String(message.payload?.transferId || "");

        const transfer = asPlainRow(await queryOne(
          "SELECT id, room_id FROM file_transfers WHERE id = ?",
          [transferId]
        ));

        if (!transfer) {
          return;
        }

        await db.execute({
          sql: "UPDATE file_transfers SET status = ?, updated_at = ? WHERE id = ?",
          args: ["complete", new Date().toISOString(), transferId]
        });

        const updatedTransfer = shapeFileTransfer(asPlainRow(await queryOne(
          `SELECT f.id, f.room_id, f.sender_id, sender.display_name AS sender_name,
                  f.recipient_id, recipient.display_name AS recipient_name,
                  f.filename, f.size_bytes, f.mime_type, f.status, f.created_at, f.updated_at
           FROM file_transfers f
           JOIN users sender ON sender.id = f.sender_id
           LEFT JOIN users recipient ON recipient.id = f.recipient_id
           WHERE f.id = ?`,
          [transferId]
        )));

        broadcast(transfer.room_id, {
          type: "file:status",
          payload: updatedTransfer
        });
        return;
      }

      if (message.type === "webrtc:signal") {
        const roomId = String(message.payload?.roomId || "");
        const targetUserId = String(message.payload?.targetUserId || "");
        const signal = message.payload?.signal;
        const transferId = String(message.payload?.transferId || "");

        if (!state.joinedRooms.has(roomId) || !targetUserId || !signal) {
          return;
        }

        broadcast(roomId, {
          type: "webrtc:signal",
          payload: {
            roomId,
            fromUserId: user.id,
            fromDisplayName: user.displayName,
            targetUserId,
            transferId,
            signal
          }
        }, { onlyUserId: targetUserId });
      }
    } catch (error) {
      console.error("WebSocket message error", error);
      socket.send(JSON.stringify({
        type: "error",
        payload: { message: "Invalid realtime payload" }
      }));
    }
  });

  socket.on("close", async () => {
    const state = socketState.get(socket);
    socketState.delete(socket);

    if (!state) {
      return;
    }

    for (const roomId of state.joinedRooms) {
      removeSocketFromRoom(roomId, socket, state.user.id);
      await sendPresenceUpdate(roomId);
    }
  });
});

const heartbeatInterval = setInterval(() => {
  for (const socket of wsServer.clients) {
    if (!socket.isAlive) {
      socket.terminate();
      continue;
    }

    socket.isAlive = false;
    socket.ping();
  }
}, 30000);

wsServer.on("close", () => {
  clearInterval(heartbeatInterval);
});

server.listen(PORT, () => {
  console.log(`SpaceFlux server listening on http://0.0.0.0:${PORT}`);
  console.log(`Allowed frontend origin: ${FRONTEND_ORIGIN}`);
});
