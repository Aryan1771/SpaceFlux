"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { api } from "../lib/api";

const WS_URL = process.env.NEXT_PUBLIC_WS_URL;
const THEME_STORAGE_KEY = "spaceflux-theme";
const POINTER_BREAKPOINT = 820;
const PHONE_FILE_LIMIT_BYTES = 25 * 1024 * 1024;
const DESKTOP_FILE_LIMIT_BYTES = 100 * 1024 * 1024;
const ICE_SERVERS = [{ urls: "stun:stun.l.google.com:19302" }];

const STATUS_COPY = {
  offered: "Waiting for recipient",
  accepted: "Connecting peers",
  complete: "Completed",
  rejected: "Rejected",
  failed: "Failed"
};

function applyTheme(theme) {
  const root = document.documentElement;
  const resolvedTheme = theme === "system"
    ? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")
    : theme;

  root.dataset.theme = resolvedTheme;
}

function initialsFromName(name) {
  return String(name || "")
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("") || "SS";
}

function formatBytes(value) {
  if (!Number.isFinite(value)) {
    return "-";
  }

  const units = ["B", "KB", "MB", "GB"];
  let amount = value;
  let unitIndex = 0;

  while (amount >= 1024 && unitIndex < units.length - 1) {
    amount /= 1024;
    unitIndex += 1;
  }

  return `${amount.toFixed(amount >= 10 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

function formatTime(timestamp) {
  if (!timestamp) {
    return "";
  }

  return new Date(timestamp).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit"
  });
}

function mergeTransfer(list, nextTransfer) {
  const existingIndex = list.findIndex((item) => item.id === nextTransfer.id);
  if (existingIndex === -1) {
    return [nextTransfer, ...list];
  }

  const updated = [...list];
  updated[existingIndex] = {
    ...updated[existingIndex],
    ...nextTransfer
  };
  return updated;
}

export default function Page() {
  const [theme, setTheme] = useState("system");
  const [user, setUser] = useState(null);
  const [authMode, setAuthMode] = useState("login");
  const [authForm, setAuthForm] = useState({ displayName: "", email: "", password: "" });
  const [rooms, setRooms] = useState([]);
  const [activeRoomId, setActiveRoomId] = useState("");
  const [messages, setMessages] = useState([]);
  const [fileTransfers, setFileTransfers] = useState([]);
  const [members, setMembers] = useState([]);
  const [pointers, setPointers] = useState([]);
  const [chatDraft, setChatDraft] = useState("");
  const [roomDraft, setRoomDraft] = useState("");
  const [joinCodeDraft, setJoinCodeDraft] = useState("");
  const [roomLoadState, setRoomLoadState] = useState("idle");
  const [authError, setAuthError] = useState("");
  const [globalError, setGlobalError] = useState("");
  const [infoMessage, setInfoMessage] = useState("");
  const [socketStatus, setSocketStatus] = useState("disconnected");
  const [isCompactLayout, setIsCompactLayout] = useState(false);
  const [selectedRecipientId, setSelectedRecipientId] = useState("");
  const [fileInputKey, setFileInputKey] = useState(0);

  const socketRef = useRef(null);
  const activeRoomIdRef = useRef("");
  const joinedRoomRef = useRef("");
  const peerConnectionsRef = useRef(new Map());
  const pendingOutgoingFilesRef = useRef(new Map());
  const incomingTransfersRef = useRef(new Map());
  const reconnectTimeoutRef = useRef(null);

  const activeRoom = useMemo(
    () => rooms.find((room) => room.id === activeRoomId) || null,
    [rooms, activeRoomId]
  );

  const isAuthenticated = Boolean(user);
  const recipients = members.filter((member) => member.userId !== user?.id);

  useEffect(() => {
    const savedTheme = window.localStorage.getItem(THEME_STORAGE_KEY) || "system";
    setTheme(savedTheme);
    applyTheme(savedTheme);

    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const handleSystemChange = () => {
      const currentTheme = window.localStorage.getItem(THEME_STORAGE_KEY) || "system";
      if (currentTheme === "system") {
        applyTheme("system");
      }
    };
    const updateLayout = () => {
      setIsCompactLayout(window.innerWidth < POINTER_BREAKPOINT);
    };

    mediaQuery.addEventListener("change", handleSystemChange);
    window.addEventListener("resize", updateLayout);
    updateLayout();

    return () => {
      mediaQuery.removeEventListener("change", handleSystemChange);
      window.removeEventListener("resize", updateLayout);
    };
  }, []);

  useEffect(() => {
    applyTheme(theme);
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  }, [theme]);

  useEffect(() => {
    let cancelled = false;

    async function bootstrap() {
      try {
        const me = await api.getMe();
        if (cancelled) {
          return;
        }
        setUser(me.user);
      } catch {
        if (!cancelled) {
          setUser(null);
        }
      }
    }

    bootstrap();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    activeRoomIdRef.current = activeRoomId;
  }, [activeRoomId]);

  useEffect(() => {
    if (!user) {
      setRooms([]);
      setActiveRoomId("");
      setMessages([]);
      setFileTransfers([]);
      setMembers([]);
      setPointers([]);
      if (socketRef.current) {
        socketRef.current.close();
        socketRef.current = null;
      }
      return;
    }

    loadRooms();
  }, [user]);

  useEffect(() => {
    if (!user) {
      return;
    }

    connectSocket();

    return () => {
      if (reconnectTimeoutRef.current) {
        window.clearTimeout(reconnectTimeoutRef.current);
      }
      socketRef.current?.close();
      socketRef.current = null;
    };
  }, [user]);

  useEffect(() => {
    if (!activeRoomId || !user) {
      return;
    }

    loadRoomData(activeRoomId);

    if (socketRef.current?.readyState === WebSocket.OPEN) {
      if (joinedRoomRef.current && joinedRoomRef.current !== activeRoomId) {
        sendSocket({
          type: "room:leave",
          payload: { roomId: joinedRoomRef.current }
        });
      }

      sendSocket({
        type: "room:join",
        payload: { roomId: activeRoomId }
      });
      joinedRoomRef.current = activeRoomId;
    }
  }, [activeRoomId, user]);

  useEffect(() => {
    return () => {
      for (const connection of peerConnectionsRef.current.values()) {
        connection.close();
      }
      peerConnectionsRef.current.clear();
    };
  }, []);

  async function loadRooms(selectNewest = false) {
    try {
      const response = await api.listRooms();
      setRooms(response.rooms);
      if (!response.rooms.length) {
        setActiveRoomId("");
        return;
      }

      if (selectNewest) {
        setActiveRoomId(response.rooms[0].id);
        return;
      }

      setActiveRoomId((current) => {
        if (current && response.rooms.some((room) => room.id === current)) {
          return current;
        }
        return response.rooms[0].id;
      });
    } catch (error) {
      setGlobalError(error.message);
    }
  }

  async function loadRoomData(roomId) {
    setRoomLoadState("loading");
    setGlobalError("");

    try {
      const [messagesResponse, filesResponse] = await Promise.all([
        api.getMessages(roomId),
        api.getFiles(roomId)
      ]);

      setMessages(messagesResponse.messages);
      setFileTransfers(filesResponse.files);
      setRoomLoadState("ready");
    } catch (error) {
      setGlobalError(error.message);
      setRoomLoadState("error");
    }
  }

  function connectSocket() {
    if (!WS_URL) {
      setGlobalError("Missing NEXT_PUBLIC_WS_URL.");
      return;
    }

    if (socketRef.current && [WebSocket.OPEN, WebSocket.CONNECTING].includes(socketRef.current.readyState)) {
      return;
    }

    const socket = new WebSocket(WS_URL);
    socketRef.current = socket;
    setSocketStatus("connecting");

    socket.addEventListener("open", () => {
      setSocketStatus("connected");

      if (activeRoomIdRef.current) {
        sendSocket({
          type: "room:join",
          payload: { roomId: activeRoomIdRef.current }
        });
        joinedRoomRef.current = activeRoomIdRef.current;
      }
    });

    socket.addEventListener("close", () => {
      setSocketStatus("disconnected");
      socketRef.current = null;
      if (user) {
        reconnectTimeoutRef.current = window.setTimeout(connectSocket, 2000);
      }
    });

    socket.addEventListener("error", () => {
      setSocketStatus("error");
    });

    socket.addEventListener("message", async (event) => {
      const message = JSON.parse(event.data);

      if (message.type === "room:state") {
        if (message.payload.roomId !== activeRoomId) {
          return;
        }
        setMembers(message.payload.members || []);
        setPointers(message.payload.pointers || []);
        if (!selectedRecipientId && message.payload.members?.length) {
          const nextRecipient = message.payload.members.find((member) => member.userId !== user?.id);
          setSelectedRecipientId(nextRecipient?.userId || "");
        }
        return;
      }

      if (message.type === "presence:update") {
        setMembers(message.payload || []);
        return;
      }

      if (message.type === "chat:new") {
        setMessages((current) => [...current, message.payload]);
        return;
      }

      if (message.type === "pointer:update") {
        setPointers((current) => {
          const filtered = current.filter((pointer) => pointer.userId !== message.payload.userId);
          return [...filtered, message.payload];
        });
        return;
      }

      if (message.type === "file:offered") {
        setFileTransfers((current) => mergeTransfer(current, message.payload));
        setInfoMessage(`${message.payload.senderName} offered ${message.payload.filename}`);
        return;
      }

      if (message.type === "file:status") {
        setFileTransfers((current) => mergeTransfer(current, message.payload));

        if (message.payload.clientOfferId && pendingOutgoingFilesRef.current.has(message.payload.clientOfferId)) {
          const pendingFile = pendingOutgoingFilesRef.current.get(message.payload.clientOfferId);
          pendingOutgoingFilesRef.current.delete(message.payload.clientOfferId);
          pendingOutgoingFilesRef.current.set(message.payload.id, pendingFile);
        }

        if (message.payload.status === "accepted" && message.payload.senderId === user?.id) {
          await beginSendingTransfer(message.payload.id, message.payload.recipientId);
        }

        if (message.payload.status === "complete") {
          setInfoMessage(`Transfer complete: ${message.payload.filename || message.payload.id}`);
        }
        return;
      }

      if (message.type === "webrtc:signal") {
        await handleIncomingSignal(message.payload);
        return;
      }

      if (message.type === "error") {
        setGlobalError(message.payload?.message || "Realtime error");
      }
    });
  }

  function sendSocket(payload) {
    if (socketRef.current?.readyState !== WebSocket.OPEN) {
      return;
    }

    socketRef.current.send(JSON.stringify(payload));
  }

  async function handleAuthSubmit(event) {
    event.preventDefault();
    setAuthError("");

    try {
      const action = authMode === "login" ? api.login : api.register;
      const response = await action(authForm);
      setUser(response.user);
      setAuthForm({ displayName: "", email: "", password: "" });
    } catch (error) {
      setAuthError(error.message);
    }
  }

  async function handleLogout() {
    try {
      await api.logout();
      setUser(null);
      setInfoMessage("Logged out");
    } catch (error) {
      setGlobalError(error.message);
    }
  }

  async function handleCreateRoom(event) {
    event.preventDefault();
    setGlobalError("");

    try {
      const response = await api.createRoom({ name: roomDraft });
      setRoomDraft("");
      setRooms((current) => [response.room, ...current]);
      setActiveRoomId(response.room.id);
      setInfoMessage(`Room created. Code: ${response.room.joinCode}`);
    } catch (error) {
      setGlobalError(error.message);
    }
  }

  async function handleJoinRoom(event) {
    event.preventDefault();
    setGlobalError("");

    try {
      const response = await api.joinRoom({ code: joinCodeDraft });
      setJoinCodeDraft("");
      await loadRooms();
      setActiveRoomId(response.room.id);
      setInfoMessage(`Joined ${response.room.name}`);
    } catch (error) {
      setGlobalError(error.message);
    }
  }

  async function handleLeaveRoom() {
    if (!activeRoomId) {
      return;
    }

    try {
      await api.leaveRoom(activeRoomId);
      if (joinedRoomRef.current === activeRoomId) {
        sendSocket({
          type: "room:leave",
          payload: { roomId: activeRoomId }
        });
      }
      await loadRooms(true);
      setInfoMessage("Left room");
    } catch (error) {
      setGlobalError(error.message);
    }
  }

  function handlePointerMove(event) {
    if (!activeRoomId || isCompactLayout) {
      return;
    }

    const bounds = event.currentTarget.getBoundingClientRect();
    const x = (event.clientX - bounds.left) / bounds.width;
    const y = (event.clientY - bounds.top) / bounds.height;

    sendSocket({
      type: "pointer:move",
      payload: {
        roomId: activeRoomId,
        x,
        y,
        viewport: "desktop"
      }
    });
  }

  function handleSendChat(event) {
    event.preventDefault();
    if (!chatDraft.trim() || !activeRoomId) {
      return;
    }

    sendSocket({
      type: "chat:send",
      payload: {
        roomId: activeRoomId,
        content: chatDraft
      }
    });
    setChatDraft("");
  }

  async function handleFileSelection(event) {
    const file = event.target.files?.[0];
    if (!file || !activeRoomId || !selectedRecipientId) {
      return;
    }

    const maxBytes = isCompactLayout ? PHONE_FILE_LIMIT_BYTES : DESKTOP_FILE_LIMIT_BYTES;
    if (file.size > maxBytes) {
      setGlobalError(`File is too large. Limit is ${formatBytes(maxBytes)} on this device class.`);
      setFileInputKey((current) => current + 1);
      return;
    }

    const clientOfferId = crypto.randomUUID();
    pendingOutgoingFilesRef.current.set(clientOfferId, {
      file,
      recipientUserId: selectedRecipientId
    });

    sendSocket({
      type: "file:offer",
      payload: {
        roomId: activeRoomId,
        recipientUserId: selectedRecipientId,
        filename: file.name,
        mimeType: file.type || "application/octet-stream",
        sizeBytes: file.size,
        clientOfferId
      }
    });

    setFileInputKey((current) => current + 1);
    setInfoMessage(`Offer sent for ${file.name}`);
  }

  async function beginSendingTransfer(transferId, recipientUserId) {
    const pendingEntry = pendingOutgoingFilesRef.current.get(transferId);
    if (!pendingEntry) {
      return;
    }

    const peerConnection = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    const channel = peerConnection.createDataChannel("file-transfer");
    peerConnectionsRef.current.set(transferId, peerConnection);

    channel.binaryType = "arraybuffer";
    channel.onopen = async () => {
      await sendFileOverChannel({
        channel,
        file: pendingEntry.file,
        transferId
      });
    };
    channel.onerror = () => {
      setGlobalError(`File transfer failed for ${pendingEntry.file.name}`);
    };

    peerConnection.onicecandidate = (iceEvent) => {
      if (!iceEvent.candidate) {
        return;
      }

      sendSocket({
        type: "webrtc:signal",
        payload: {
          roomId: activeRoomId,
          targetUserId: recipientUserId,
          transferId,
          signal: {
            type: "candidate",
            candidate: iceEvent.candidate
          }
        }
      });
    };

    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);

    sendSocket({
      type: "webrtc:signal",
      payload: {
        roomId: activeRoomId,
        targetUserId: recipientUserId,
        transferId,
        signal: {
          type: "offer",
          sdp: offer
        }
      }
    });
  }

  async function handleIncomingSignal(payload) {
    const { transferId, fromUserId, signal } = payload;

    if (signal.type === "offer") {
      const transfer = fileTransfers.find((item) => item.id === transferId);
      if (!transfer) {
        return;
      }

      const peerConnection = new RTCPeerConnection({ iceServers: ICE_SERVERS });
      peerConnectionsRef.current.set(transferId, peerConnection);

      const transferState = {
        chunks: [],
        receivedBytes: 0,
        metadata: transfer
      };
      incomingTransfersRef.current.set(transferId, transferState);

      peerConnection.onicecandidate = (iceEvent) => {
        if (!iceEvent.candidate) {
          return;
        }

        sendSocket({
          type: "webrtc:signal",
          payload: {
            roomId: activeRoomId,
            targetUserId: fromUserId,
            transferId,
            signal: {
              type: "candidate",
              candidate: iceEvent.candidate
            }
          }
        });
      };

      peerConnection.ondatachannel = (dataEvent) => {
        const channel = dataEvent.channel;
        channel.binaryType = "arraybuffer";

        channel.onmessage = async (channelEvent) => {
          if (typeof channelEvent.data === "string") {
            const parsed = JSON.parse(channelEvent.data);
            if (parsed.type === "meta") {
              transferState.metadata = {
                ...transferState.metadata,
                ...parsed.payload
              };
            }
            if (parsed.type === "complete") {
              await finalizeIncomingTransfer(transferId);
            }
            return;
          }

          transferState.chunks.push(channelEvent.data);
          transferState.receivedBytes += channelEvent.data.byteLength;
        };
      };

      await peerConnection.setRemoteDescription(signal.sdp);
      const answer = await peerConnection.createAnswer();
      await peerConnection.setLocalDescription(answer);

      sendSocket({
        type: "webrtc:signal",
        payload: {
          roomId: activeRoomId,
          targetUserId: fromUserId,
          transferId,
          signal: {
            type: "answer",
            sdp: answer
          }
        }
      });
      return;
    }

    const peerConnection = peerConnectionsRef.current.get(transferId);
    if (!peerConnection) {
      return;
    }

    if (signal.type === "answer") {
      await peerConnection.setRemoteDescription(signal.sdp);
      return;
    }

    if (signal.type === "candidate") {
      await peerConnection.addIceCandidate(signal.candidate);
    }
  }

  async function sendFileOverChannel({ channel, file, transferId }) {
    channel.send(JSON.stringify({
      type: "meta",
      payload: {
        filename: file.name,
        mimeType: file.type || "application/octet-stream",
        sizeBytes: file.size
      }
    }));

    const chunkSize = 64 * 1024;
    let offset = 0;

    while (offset < file.size) {
      while (channel.bufferedAmount > 1024 * 1024) {
        await new Promise((resolve) => window.setTimeout(resolve, 40));
      }

      const chunk = await file.slice(offset, offset + chunkSize).arrayBuffer();
      channel.send(chunk);
      offset += chunk.byteLength;
    }

    channel.send(JSON.stringify({ type: "complete" }));
    pendingOutgoingFilesRef.current.delete(transferId);
  }

  async function finalizeIncomingTransfer(transferId) {
    const transferState = incomingTransfersRef.current.get(transferId);
    if (!transferState) {
      return;
    }

    const blob = new Blob(transferState.chunks, {
      type: transferState.metadata.mimeType || "application/octet-stream"
    });
    const downloadUrl = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = downloadUrl;
    anchor.download = transferState.metadata.filename || `spaceflux-${transferId}`;
    anchor.click();
    URL.revokeObjectURL(downloadUrl);

    incomingTransfersRef.current.delete(transferId);
    sendSocket({
      type: "file:complete",
      payload: { transferId }
    });
    setInfoMessage(`Downloaded ${transferState.metadata.filename}`);
  }

  function acceptTransfer(transferId) {
    sendSocket({
      type: "file:accept",
      payload: { transferId }
    });
  }

  if (!isAuthenticated) {
    return (
      <main className="auth-shell">
        <div className="auth-hero">
          <span className="eyebrow">Hybrid Realtime Collaboration</span>
          <h1>SpaceFlux</h1>
          <p>
            Create rooms, chat live, share files peer-to-peer, and collaborate with live pointers on desktop.
          </p>
          <ThemePicker theme={theme} setTheme={setTheme} />
        </div>

        <form className="auth-card" onSubmit={handleAuthSubmit}>
          <div className="auth-header">
            <h2>{authMode === "login" ? "Welcome back" : "Create your account"}</h2>
            <p>{authMode === "login" ? "Sign in to your rooms." : "Start collaborating in minutes."}</p>
          </div>

          {authMode === "register" ? (
            <label>
              Nickname
              <input
                value={authForm.displayName}
                onChange={(event) => setAuthForm((current) => ({ ...current, displayName: event.target.value }))}
                placeholder="Aryan"
              />
            </label>
          ) : null}

          <label>
            Email
            <input
              type="email"
              value={authForm.email}
              onChange={(event) => setAuthForm((current) => ({ ...current, email: event.target.value }))}
              placeholder="you@example.com"
            />
          </label>

          <label>
            Password
            <input
              type="password"
              value={authForm.password}
              onChange={(event) => setAuthForm((current) => ({ ...current, password: event.target.value }))}
              placeholder="At least 8 characters"
            />
          </label>

          {authError ? <p className="inline-error">{authError}</p> : null}

          <button className="primary-button" type="submit">
            {authMode === "login" ? "Login" : "Create account"}
          </button>

          <button
            type="button"
            className="secondary-button"
            onClick={() => {
              setAuthMode((current) => current === "login" ? "register" : "login");
              setAuthError("");
            }}
          >
            {authMode === "login" ? "Need an account?" : "Already have an account?"}
          </button>
        </form>
      </main>
    );
  }

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand-card">
          <div className="avatar-badge">{initialsFromName(user.displayName)}</div>
          <div>
            <h1>SpaceFlux</h1>
            <p>{user.displayName}</p>
          </div>
        </div>

        <div className="stack">
          <form className="panel" onSubmit={handleCreateRoom}>
            <div className="panel-header">
              <h2>Create room</h2>
            </div>
            <input
              value={roomDraft}
              onChange={(event) => setRoomDraft(event.target.value)}
              placeholder="Product sync"
            />
            <button className="primary-button" type="submit">Create</button>
          </form>

          <form className="panel" onSubmit={handleJoinRoom}>
            <div className="panel-header">
              <h2>Join by code</h2>
            </div>
            <input
              value={joinCodeDraft}
              onChange={(event) => setJoinCodeDraft(event.target.value.toUpperCase())}
              placeholder="ABC123"
            />
            <button className="secondary-button" type="submit">Join room</button>
          </form>

          <div className="panel room-list-panel">
            <div className="panel-header">
              <h2>Your rooms</h2>
              <span className={`status-pill status-${socketStatus}`}>{socketStatus}</span>
            </div>

            <div className="room-list">
              {rooms.map((room) => (
                <button
                  key={room.id}
                  className={`room-tile ${room.id === activeRoomId ? "active" : ""}`}
                  onClick={() => setActiveRoomId(room.id)}
                  type="button"
                >
                  <div>
                    <strong>{room.name}</strong>
                    <span>Code {room.joinCode}</span>
                  </div>
                </button>
              ))}

              {!rooms.length ? <p className="muted-text">No rooms yet. Create or join one to begin.</p> : null}
            </div>
          </div>
        </div>

        <div className="sidebar-footer">
          <ThemePicker theme={theme} setTheme={setTheme} compact />
          <button className="ghost-button" onClick={handleLogout} type="button">Logout</button>
        </div>
      </aside>

      <section className="workspace">
        {activeRoom ? (
          <>
            <header className="workspace-header">
              <div>
                <p className="eyebrow">Active room</p>
                <h2>{activeRoom.name}</h2>
                <p className="muted-text">Room code {activeRoom.joinCode}</p>
              </div>

              <div className="header-actions">
                <button className="ghost-button" type="button" onClick={handleLeaveRoom}>
                  Leave room
                </button>
              </div>
            </header>

            {globalError ? <div className="banner error-banner">{globalError}</div> : null}
            {infoMessage ? <div className="banner info-banner">{infoMessage}</div> : null}

            <div className="workspace-grid">
              <div className="main-column">
                <div className="panel chat-panel">
                  <div className="panel-header">
                    <h3>Chat</h3>
                    <span>{messages.length} messages</span>
                  </div>

                  <div className="message-list">
                    {roomLoadState === "loading" ? <p className="muted-text">Loading room data...</p> : null}

                    {messages.map((message) => (
                      <article className={`message-card ${message.userId === user.id ? "own" : ""}`} key={message.id}>
                        <div className="message-meta">
                          <strong>{message.displayName}</strong>
                          <span>{formatTime(message.createdAt)}</span>
                        </div>
                        <p>{message.content}</p>
                      </article>
                    ))}
                  </div>

                  <form className="chat-compose" onSubmit={handleSendChat}>
                    <input
                      value={chatDraft}
                      onChange={(event) => setChatDraft(event.target.value)}
                      placeholder="Send a message to the room"
                    />
                    <button className="primary-button" type="submit">Send</button>
                  </form>
                </div>

                <div className="panel file-panel">
                  <div className="panel-header">
                    <h3>File transfer</h3>
                    <span>{isCompactLayout ? "Phone mode" : "Desktop mode"}</span>
                  </div>

                  <div className="file-toolbar">
                    <select
                      value={selectedRecipientId}
                      onChange={(event) => setSelectedRecipientId(event.target.value)}
                    >
                      <option value="">Choose recipient</option>
                      {recipients.map((member) => (
                        <option key={member.userId} value={member.userId}>
                          {member.displayName}
                        </option>
                      ))}
                    </select>

                    <label className="file-picker">
                      <input
                        key={fileInputKey}
                        type="file"
                        onChange={handleFileSelection}
                      />
                      <span>Select file</span>
                    </label>
                  </div>

                  <div className="transfer-list">
                    {fileTransfers.map((transfer) => {
                      const canAccept = transfer.recipientId === user.id && transfer.status === "offered";
                      return (
                        <article className="transfer-card" key={transfer.id}>
                          <div>
                            <strong>{transfer.filename}</strong>
                            <p>
                              {transfer.senderName} → {transfer.recipientName || "Room"} · {formatBytes(transfer.sizeBytes)}
                            </p>
                          </div>
                          <div className="transfer-actions">
                            <span className="status-text">{STATUS_COPY[transfer.status] || transfer.status}</span>
                            {canAccept ? (
                              <button className="secondary-button" type="button" onClick={() => acceptTransfer(transfer.id)}>
                                Accept
                              </button>
                            ) : null}
                          </div>
                        </article>
                      );
                    })}

                    {!fileTransfers.length ? (
                      <p className="muted-text">No transfer activity yet. Select a recipient and send a file.</p>
                    ) : null}
                  </div>
                </div>
              </div>

              <div className="side-column">
                <div className="panel members-panel">
                  <div className="panel-header">
                    <h3>Members</h3>
                    <span>{members.length}</span>
                  </div>

                  <div className="member-list">
                    {members.map((member) => (
                      <div className="member-row" key={member.userId}>
                        <span className="member-dot" style={{ background: member.color }} />
                        <span>{member.displayName}</span>
                        <span className={`status-pill ${member.online ? "online" : "offline"}`}>
                          {member.online ? "online" : "offline"}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>

                {!isCompactLayout ? (
                  <div className="panel pointer-panel">
                    <div className="panel-header">
                      <h3>Pointer stage</h3>
                      <span>Desktop only</span>
                    </div>
                    <div className="pointer-surface" onMouseMove={handlePointerMove}>
                      {pointers.map((pointer) => (
                        <div
                          key={pointer.userId}
                          className="pointer-avatar"
                          style={{
                            left: `${pointer.x * 100}%`,
                            top: `${pointer.y * 100}%`,
                            borderColor: pointer.color
                          }}
                        >
                          <span style={{ background: pointer.color }}>{initialsFromName(pointer.displayName)}</span>
                          <small>{pointer.displayName}</small>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : (
                  <div className="panel compact-note">
                    <div className="panel-header">
                      <h3>Mobile view</h3>
                    </div>
                    <p className="muted-text">
                      Pointer sharing is hidden on smaller screens so chat and file transfer stay easy to use on phones.
                    </p>
                  </div>
                )}
              </div>
            </div>
          </>
        ) : (
          <div className="empty-room-state">
            <h2>No active room</h2>
            <p>Create a room or join one with a code to start chatting and sharing files.</p>
          </div>
        )}
      </section>
    </main>
  );
}

function ThemePicker({ theme, setTheme, compact = false }) {
  return (
    <div className={`theme-picker ${compact ? "compact" : ""}`}>
      {["light", "dark", "system"].map((option) => (
        <button
          key={option}
          className={`theme-chip ${theme === option ? "active" : ""}`}
          type="button"
          onClick={() => setTheme(option)}
        >
          {option}
        </button>
      ))}
    </div>
  );
}
