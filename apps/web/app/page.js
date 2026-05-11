"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { api, getStoredSessionToken } from "../lib/api";

const WS_URL = process.env.NEXT_PUBLIC_WS_URL;
const THEME_STORAGE_KEY = "spaceflux-theme";
const POINTER_BREAKPOINT = 820;
const INSTANT_TRANSFER_BYTES = 1024 * 1024;
const PHONE_FILE_LIMIT_BYTES = 25 * 1024 * 1024;
const DESKTOP_FILE_LIMIT_BYTES = 100 * 1024 * 1024;
const TRANSFER_TIMEOUT_MS = 20000;
const ICE_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
  { urls: "stun:stun.cloudflare.com:3478" }
];

const STATUS_COPY = {
  offered: "Waiting for recipient",
  accepted: "Connecting peers",
  transferring: "Transferring",
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

function mergeTransferRuntime(map, transferId, patch) {
  return {
    ...map,
    [transferId]: {
      ...(map[transferId] || {}),
      ...patch
    }
  };
}

function removeTransferRuntime(map, transferId) {
  const next = { ...map };
  delete next[transferId];
  return next;
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
  const [transferRuntime, setTransferRuntime] = useState({});
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
  const [primaryRecipientId, setPrimaryRecipientId] = useState("");
  const [ccRecipientIds, setCcRecipientIds] = useState([]);
  const [bccRecipientIds, setBccRecipientIds] = useState([]);
  const [fileInputKey, setFileInputKey] = useState(0);
  const [editingMessageId, setEditingMessageId] = useState("");
  const [editingMessageDraft, setEditingMessageDraft] = useState("");
  const [showLaunchOverlay, setShowLaunchOverlay] = useState(false);
  const [hasPrimedWorkspace, setHasPrimedWorkspace] = useState(false);
  const [isPointerStageExpanded, setIsPointerStageExpanded] = useState(false);

  const socketRef = useRef(null);
  const activeRoomIdRef = useRef("");
  const joinedRoomRef = useRef("");
  const peerConnectionsRef = useRef(new Map());
  const pendingOutgoingFilesRef = useRef(new Map());
  const incomingTransfersRef = useRef(new Map());
  const transferTimeoutsRef = useRef(new Map());
  const reconnectTimeoutRef = useRef(null);

  const activeRoom = useMemo(
    () => rooms.find((room) => room.id === activeRoomId) || null,
    [rooms, activeRoomId]
  );

  const isAuthenticated = Boolean(user);
  const recipients = members.filter((member) => member.userId !== user?.id);
  const currentMaxFileSize = isCompactLayout ? PHONE_FILE_LIMIT_BYTES : DESKTOP_FILE_LIMIT_BYTES;

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
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch(() => {});
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function bootstrap() {
      try {
        const me = await api.getMe();
        if (cancelled) {
          return;
        }
        setShowLaunchOverlay(Boolean(me.user));
        setHasPrimedWorkspace(false);
        setUser(me.user);
      } catch (error) {
        if (!cancelled) {
          if (error?.status === 401) {
            api.clearStoredSession();
          }
          setShowLaunchOverlay(false);
          setHasPrimedWorkspace(false);
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
      setTransferRuntime({});
      setMembers([]);
      setPointers([]);
      setShowLaunchOverlay(false);
      setHasPrimedWorkspace(false);
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
    const validRecipientIds = new Set(recipients.map((member) => member.userId));
    setPrimaryRecipientId((current) => validRecipientIds.has(current) ? current : (recipients[0]?.userId || ""));
    setCcRecipientIds((current) => current.filter((userId) => validRecipientIds.has(userId)));
    setBccRecipientIds((current) => current.filter((userId) => validRecipientIds.has(userId)));
  }, [recipients, activeRoomId, user?.id]);

  useEffect(() => {
    return () => {
      for (const timeoutId of transferTimeoutsRef.current.values()) {
        window.clearTimeout(timeoutId);
      }
      transferTimeoutsRef.current.clear();
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
        setHasPrimedWorkspace(true);
        setShowLaunchOverlay(false);
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
      setHasPrimedWorkspace(true);
      setShowLaunchOverlay(false);
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
      setHasPrimedWorkspace(true);
      setShowLaunchOverlay(false);
    } catch (error) {
      setGlobalError(error.message);
      setRoomLoadState("error");
      setHasPrimedWorkspace(true);
      setShowLaunchOverlay(false);
    }
  }

  function clearTransferTimeout(transferId) {
    const timeoutId = transferTimeoutsRef.current.get(transferId);
    if (timeoutId) {
      window.clearTimeout(timeoutId);
      transferTimeoutsRef.current.delete(transferId);
    }
  }

  function scheduleTransferTimeout(transferId, label) {
    clearTransferTimeout(transferId);
    const timeoutId = window.setTimeout(() => {
      failTransfer(transferId, `${label} timed out. Try again.`);
    }, TRANSFER_TIMEOUT_MS);
    transferTimeoutsRef.current.set(transferId, timeoutId);
  }

  function closeTransferPeer(transferId) {
    clearTransferTimeout(transferId);
    const connection = peerConnectionsRef.current.get(transferId);
    if (connection) {
      connection.close();
      peerConnectionsRef.current.delete(transferId);
    }
  }

  function updateTransferRuntime(transferId, patch) {
    setTransferRuntime((current) => mergeTransferRuntime(current, transferId, patch));
  }

  function failTransfer(transferId, message, shouldNotify = true) {
    incomingTransfersRef.current.delete(transferId);
    pendingOutgoingFilesRef.current.delete(transferId);
    closeTransferPeer(transferId);
    updateTransferRuntime(transferId, { phase: "failed", message });
    if (shouldNotify) {
      sendSocket({
        type: "file:failed",
        payload: { transferId }
      });
    }
    setGlobalError(message);
  }

  function clearTransferRuntime(transferId) {
    setTransferRuntime((current) => removeTransferRuntime(current, transferId));
  }

  function connectSocket() {
    if (!WS_URL) {
      setGlobalError("Missing NEXT_PUBLIC_WS_URL.");
      return;
    }

    if (socketRef.current && [WebSocket.OPEN, WebSocket.CONNECTING].includes(socketRef.current.readyState)) {
      return;
    }

    const sessionToken = getStoredSessionToken();
    const socketUrl = sessionToken
      ? `${WS_URL}${WS_URL.includes("?") ? "&" : "?"}token=${encodeURIComponent(sessionToken)}`
      : WS_URL;
    const socket = new WebSocket(socketUrl);
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
        if (!primaryRecipientId && message.payload.members?.length) {
          const nextRecipient = message.payload.members.find((member) => member.userId !== user?.id);
          setPrimaryRecipientId(nextRecipient?.userId || "");
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

      if (message.type === "chat:updated") {
        setMessages((current) => current.map((item) => item.id === message.payload.id ? message.payload : item));
        return;
      }

      if (message.type === "chat:deleted") {
        setMessages((current) => current.filter((item) => item.id !== message.payload.id));
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
        updateTransferRuntime(message.payload.id, {
          totalBytes: Number(message.payload.sizeBytes || 0),
          transferredBytes: 0,
          phase: "offered"
        });
        setInfoMessage(`${message.payload.senderName} offered ${message.payload.filename}`);
        return;
      }

      if (message.type === "file:status") {
        setFileTransfers((current) => mergeTransfer(current, message.payload));
        const totalBytes = Number(message.payload.sizeBytes || 0);

        if (message.payload.clientOfferId && pendingOutgoingFilesRef.current.has(message.payload.clientOfferId)) {
          const pendingFile = pendingOutgoingFilesRef.current.get(message.payload.clientOfferId);
          pendingOutgoingFilesRef.current.delete(message.payload.clientOfferId);
          pendingOutgoingFilesRef.current.set(message.payload.id, pendingFile);
          clearTransferRuntime(message.payload.clientOfferId);
          updateTransferRuntime(message.payload.id, {
            totalBytes: pendingFile.file.size,
            transferredBytes: 0,
            phase: message.payload.status === "accepted" ? "connecting" : message.payload.status
          });
        }

        if (message.payload.status === "accepted" && message.payload.senderId === user?.id) {
          updateTransferRuntime(message.payload.id, {
            totalBytes,
            transferredBytes: 0,
            phase: "connecting"
          });
          await beginSendingTransfer(message.payload.id, message.payload.recipientId);
        }

        if (message.payload.status === "accepted" && message.payload.recipientId === user?.id) {
          updateTransferRuntime(message.payload.id, {
            totalBytes,
            transferredBytes: 0,
            phase: "connecting"
          });
        }

        if (message.payload.status === "complete") {
          updateTransferRuntime(message.payload.id, {
            totalBytes,
            transferredBytes: totalBytes,
            phase: "complete"
          });
          closeTransferPeer(message.payload.id);
          setInfoMessage(`Transfer complete: ${message.payload.filename || message.payload.id}`);
          window.setTimeout(() => {
            setFileTransfers((current) => current.filter((transfer) => transfer.id !== message.payload.id));
            clearTransferRuntime(message.payload.id);
          }, 1200);
        }

        if (message.payload.status === "failed" || message.payload.status === "rejected") {
          updateTransferRuntime(message.payload.id, {
            totalBytes,
            phase: message.payload.status,
            message: message.payload.status === "failed" ? "Peer connection failed." : ""
          });
          closeTransferPeer(message.payload.id);
        }
        return;
      }

      if (message.type === "webrtc:signal") {
        await handleIncomingSignal(message.payload);
        return;
      }

      if (message.type === "error") {
        setGlobalError(message.payload?.message || "Realtime error");
        return;
      }

      if (message.type === "room:deleted") {
        if (message.payload?.roomId === activeRoomIdRef.current) {
          setInfoMessage(`${message.payload.roomName || "Room"} was deleted.`);
        }
        await loadRooms(true);
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
      setShowLaunchOverlay(true);
      setHasPrimedWorkspace(false);
      setUser(response.user);
      setAuthForm({ displayName: "", email: "", password: "" });
    } catch (error) {
      setAuthError(error.message);
    }
  }

  async function handleLogout() {
    try {
      await api.logout();
      api.clearStoredSession();
      setShowLaunchOverlay(false);
      setHasPrimedWorkspace(false);
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

  function startEditingMessage(message) {
    setEditingMessageId(message.id);
    setEditingMessageDraft(message.content);
  }

  function cancelEditingMessage() {
    setEditingMessageId("");
    setEditingMessageDraft("");
  }

  async function saveEditedMessage(messageId) {
    if (!activeRoomId || !editingMessageDraft.trim()) {
      return;
    }

    try {
      const response = await api.updateMessage(activeRoomId, messageId, {
        content: editingMessageDraft
      });
      setMessages((current) => current.map((message) => (
        message.id === messageId ? response.message : message
      )));
      cancelEditingMessage();
      setInfoMessage("Message updated");
    } catch (error) {
      setGlobalError(error.message);
    }
  }

  async function handleDeleteMessage(messageId) {
    if (!activeRoomId) {
      return;
    }

    try {
      await api.deleteMessage(activeRoomId, messageId);
      setMessages((current) => current.filter((message) => message.id !== messageId));
      if (editingMessageId === messageId) {
        cancelEditingMessage();
      }
      setInfoMessage("Message deleted");
    } catch (error) {
      setGlobalError(error.message);
    }
  }

  async function handleDeleteRoom() {
    if (!activeRoom?.id) {
      return;
    }

    try {
      await api.deleteRoom(activeRoom.id);
      await loadRooms(true);
      setMessages([]);
      setMembers([]);
      setPointers([]);
      setFileTransfers([]);
      setTransferRuntime({});
      setInfoMessage(`${activeRoom.name} deleted`);
    } catch (error) {
      setGlobalError(error.message);
    }
  }

  function toggleRecipient(list, userId) {
    return list.includes(userId)
      ? list.filter((item) => item !== userId)
      : [...list, userId];
  }

  function getTransferRecipients() {
    const uniqueIds = new Set([
      primaryRecipientId,
      ...ccRecipientIds,
      ...bccRecipientIds
    ].filter(Boolean));

    return [...uniqueIds];
  }

  async function handleFileSelection(event) {
    const file = event.target.files?.[0];
    const recipientIds = getTransferRecipients();
    if (!file || !activeRoomId || !recipientIds.length) {
      return;
    }

    if (file.size > currentMaxFileSize) {
      setGlobalError(`File is too large. Limit is ${formatBytes(currentMaxFileSize)} on this device class.`);
      setFileInputKey((current) => current + 1);
      return;
    }

    for (const recipientUserId of recipientIds) {
      const clientOfferId = crypto.randomUUID();
      pendingOutgoingFilesRef.current.set(clientOfferId, {
        file,
        recipientUserId
      });
      updateTransferRuntime(clientOfferId, {
        totalBytes: file.size,
        transferredBytes: 0,
        phase: "offered"
      });

      sendSocket({
        type: "file:offer",
        payload: {
          roomId: activeRoomId,
          recipientUserId,
          filename: file.name,
          mimeType: file.type || "application/octet-stream",
          sizeBytes: file.size,
          clientOfferId
        }
      });
    }

    setFileInputKey((current) => current + 1);
    setInfoMessage(`Transfer queued for ${file.name}`);
  }

  async function beginSendingTransfer(transferId, recipientUserId) {
    const pendingEntry = pendingOutgoingFilesRef.current.get(transferId);
    if (!pendingEntry) {
      return;
    }

    const peerConnection = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    const channel = peerConnection.createDataChannel("file-transfer");
    peerConnectionsRef.current.set(transferId, peerConnection);
    scheduleTransferTimeout(transferId, "Peer connection");
    updateTransferRuntime(transferId, {
      totalBytes: pendingEntry.file.size,
      transferredBytes: 0,
      phase: "connecting"
    });

    channel.binaryType = "arraybuffer";
    channel.onopen = async () => {
      clearTransferTimeout(transferId);
      updateTransferRuntime(transferId, {
        totalBytes: pendingEntry.file.size,
        transferredBytes: 0,
        phase: "transferring"
      });
      await sendFileOverChannel({
        channel,
        file: pendingEntry.file,
        transferId
      });
    };
    channel.onerror = () => {
      failTransfer(transferId, `File transfer failed for ${pendingEntry.file.name}`);
    };
    channel.onclose = () => {
      if (pendingOutgoingFilesRef.current.has(transferId) || incomingTransfersRef.current.has(transferId)) {
        failTransfer(transferId, `Connection closed before ${pendingEntry.file.name} finished sending.`);
      }
    };

    peerConnection.onconnectionstatechange = () => {
      if (peerConnection.connectionState === "connected") {
        clearTransferTimeout(transferId);
      }

      if (
        ["failed", "disconnected", "closed"].includes(peerConnection.connectionState)
        && (pendingOutgoingFilesRef.current.has(transferId) || incomingTransfersRef.current.has(transferId))
      ) {
        failTransfer(transferId, `Peer connection failed for ${pendingEntry.file.name}.`);
      }
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
      scheduleTransferTimeout(transferId, "Peer connection");
      updateTransferRuntime(transferId, {
        totalBytes: Number(transfer.sizeBytes || 0),
        transferredBytes: 0,
        phase: "connecting"
      });

      peerConnection.onconnectionstatechange = () => {
        if (peerConnection.connectionState === "connected") {
          clearTransferTimeout(transferId);
          updateTransferRuntime(transferId, {
            totalBytes: Number(transferState.metadata.sizeBytes || 0),
            transferredBytes: transferState.receivedBytes,
            phase: "transferring"
          });
        }

        if (
          ["failed", "disconnected", "closed"].includes(peerConnection.connectionState)
          && (pendingOutgoingFilesRef.current.has(transferId) || incomingTransfersRef.current.has(transferId))
        ) {
          failTransfer(transferId, `Peer connection failed for ${transfer.filename}.`);
        }
      };

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
              updateTransferRuntime(transferId, {
                totalBytes: Number(parsed.payload.sizeBytes || transferState.metadata.sizeBytes || 0),
                transferredBytes: transferState.receivedBytes,
                phase: "transferring"
              });
            }
            if (parsed.type === "complete") {
              await finalizeIncomingTransfer(transferId);
            }
            return;
          }

          transferState.chunks.push(channelEvent.data);
          transferState.receivedBytes += channelEvent.data.byteLength;
          updateTransferRuntime(transferId, {
            totalBytes: Number(transferState.metadata.sizeBytes || 0),
            transferredBytes: transferState.receivedBytes,
            phase: "transferring"
          });
        };
        channel.onerror = () => {
          failTransfer(transferId, `File transfer failed for ${transfer.filename}.`);
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
      updateTransferRuntime(transferId, {
        totalBytes: file.size,
        transferredBytes: offset,
        phase: "transferring"
      });
    }

    channel.send(JSON.stringify({ type: "complete" }));
    pendingOutgoingFilesRef.current.delete(transferId);
    updateTransferRuntime(transferId, {
      totalBytes: file.size,
      transferredBytes: file.size,
      phase: "complete"
    });
    closeTransferPeer(transferId);
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
    updateTransferRuntime(transferId, {
      totalBytes: Number(transferState.metadata.sizeBytes || transferState.receivedBytes || 0),
      transferredBytes: Number(transferState.metadata.sizeBytes || transferState.receivedBytes || 0),
      phase: "complete"
    });
    closeTransferPeer(transferId);
    setInfoMessage(`Downloaded ${transferState.metadata.filename}`);
  }

  function acceptTransfer(transferId) {
    updateTransferRuntime(transferId, {
      totalBytes: Number(fileTransfers.find((transfer) => transfer.id === transferId)?.sizeBytes || 0),
      transferredBytes: 0,
      phase: "connecting"
    });
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
                placeholder="Nickname"
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
    <>
      {showLaunchOverlay ? <LaunchOverlay hasPrimedWorkspace={hasPrimedWorkspace} /> : null}
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
                {activeRoom.ownerId === user.id ? (
                  <button className="danger-button" type="button" onClick={handleDeleteRoom}>
                    Delete room
                  </button>
                ) : null}
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
                        {editingMessageId === message.id ? (
                          <div className="message-edit-stack">
                            <textarea
                              value={editingMessageDraft}
                              onChange={(event) => setEditingMessageDraft(event.target.value)}
                              rows={3}
                            />
                            <div className="message-actions">
                              <button className="primary-button" type="button" onClick={() => saveEditedMessage(message.id)}>
                                Save
                              </button>
                              <button className="secondary-button" type="button" onClick={cancelEditingMessage}>
                                Cancel
                              </button>
                            </div>
                          </div>
                        ) : (
                          <>
                            <p>{message.content}</p>
                            {message.updatedAt && message.updatedAt !== message.createdAt ? (
                              <small className="edited-label">edited</small>
                            ) : null}
                          </>
                        )}
                        {message.userId === user.id && editingMessageId !== message.id ? (
                          <div className="message-actions">
                            <button className="secondary-button" type="button" onClick={() => startEditingMessage(message)}>
                              Edit
                            </button>
                            <button className="ghost-button danger-ghost" type="button" onClick={() => handleDeleteMessage(message.id)}>
                              Delete
                            </button>
                          </div>
                        ) : null}
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

                  <div className="file-limits-note">
                    <span>* Instant transfer target: {formatBytes(INSTANT_TRANSFER_BYTES)} when the recipient is online</span>
                    <span>Max allowed here: {formatBytes(currentMaxFileSize)}</span>
                  </div>

                  <div className="recipient-grid">
                    <RecipientPicker
                      label="To"
                      recipients={recipients}
                      selectedIds={primaryRecipientId ? [primaryRecipientId] : []}
                      onToggle={(userId) => setPrimaryRecipientId((current) => current === userId ? "" : userId)}
                      singleSelect
                    />
                    <RecipientPicker
                      label="Cc"
                      recipients={recipients.filter((member) => member.userId !== primaryRecipientId)}
                      selectedIds={ccRecipientIds}
                      onToggle={(userId) => setCcRecipientIds((current) => toggleRecipient(current, userId))}
                    />
                    <RecipientPicker
                      label="Bcc"
                      recipients={recipients.filter((member) => member.userId !== primaryRecipientId)}
                      selectedIds={bccRecipientIds}
                      onToggle={(userId) => setBccRecipientIds((current) => toggleRecipient(current, userId))}
                    />
                  </div>

                  <div className="file-toolbar">
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
                      const runtime = transferRuntime[transfer.id] || transferRuntime[transfer.clientOfferId];
                      const totalBytes = Number(runtime?.totalBytes || transfer.sizeBytes || 0);
                      const transferredBytes = Number(runtime?.transferredBytes || 0);
                      const percent = totalBytes > 0 ? Math.min(100, Math.round((transferredBytes / totalBytes) * 100)) : 0;
                      const runtimeStatus = runtime?.phase ? (STATUS_COPY[runtime.phase] || runtime.phase) : "";
                      const statusLabel = runtimeStatus || STATUS_COPY[transfer.status] || transfer.status;
                      return (
                        <article className="transfer-card" key={transfer.id}>
                          <div className="transfer-copy">
                            <strong>{transfer.filename}</strong>
                            <p>
                              {transfer.senderName} to {transfer.recipientName || "Room"} - {formatBytes(transfer.sizeBytes)}
                            </p>
                            {runtime ? (
                              <div className="transfer-progress-copy">
                                <span>{formatBytes(transferredBytes)} / {formatBytes(totalBytes)}</span>
                                <span>{percent}%</span>
                              </div>
                            ) : null}
                          </div>
                          <div className="transfer-actions">
                            {runtime ? (
                              <div
                                className="progress-ring"
                                style={{ "--progress": `${percent}%` }}
                                aria-label={`${percent}% transferred`}
                              >
                                <span>{percent}%</span>
                              </div>
                            ) : null}
                            <span className="status-text">{statusLabel}</span>
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
              </div>
            </div>
            {!isCompactLayout ? (
              <div className="panel pointer-panel pointer-panel-expanded">
                <div className="panel-header">
                  <h3>Pointer stage</h3>
                  <div className="pointer-panel-actions">
                    <span>Desktop only</span>
                    <button className="secondary-button" type="button" onClick={() => setIsPointerStageExpanded(true)}>
                      Expand stage
                    </button>
                  </div>
                </div>
                <PointerSurface pointers={pointers} onMouseMove={handlePointerMove} />
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
            </>
          ) : (
            <div className="empty-room-state">
              <h2>No active room</h2>
              <p>Create a room or join one with a code to start chatting and sharing files.</p>
            </div>
          )}
        </section>
        {isPointerStageExpanded && !isCompactLayout ? (
          <div className="pointer-stage-overlay">
            <div className="pointer-stage-frame">
              <div className="panel-header">
                <div>
                  <h3>Pointer stage</h3>
                  <p className="muted-text">Shared cursors fill the full stage with each nickname shown above its cursor.</p>
                </div>
                <button className="ghost-button" type="button" onClick={() => setIsPointerStageExpanded(false)}>
                  Close stage
                </button>
              </div>
              <PointerSurface pointers={pointers} onMouseMove={handlePointerMove} immersive />
            </div>
          </div>
        ) : null}
      </main>
    </>
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

function RecipientPicker({ label, recipients, selectedIds, onToggle, singleSelect = false }) {
  return (
    <div className="recipient-picker">
      <div className="recipient-picker-header">
        <strong>{label}</strong>
        <span>{selectedIds.length ? `${selectedIds.length} selected` : "None"}</span>
      </div>
      <div className="recipient-chip-list">
        {recipients.map((member) => {
          const selected = selectedIds.includes(member.userId);
          return (
            <button
              key={`${label}-${member.userId}`}
              className={`recipient-chip ${selected ? "active" : ""}`}
              type="button"
              onClick={() => onToggle(member.userId)}
            >
              <span className="member-dot" style={{ background: member.color }} />
              <span>{member.displayName}</span>
              {singleSelect ? <small>{selected ? "Primary" : "Set"}</small> : null}
            </button>
          );
        })}
        {!recipients.length ? <p className="muted-text">No eligible recipients</p> : null}
      </div>
    </div>
  );
}

function PointerSurface({ pointers, onMouseMove, immersive = false }) {
  return (
    <div className={`pointer-surface ${immersive ? "immersive" : ""}`} onMouseMove={onMouseMove}>
      {pointers.map((pointer) => (
        <div
          key={pointer.userId}
          className="pointer-avatar"
          style={{
            left: `${pointer.x * 100}%`,
            top: `${pointer.y * 100}%`
          }}
        >
          <small className="pointer-label">{pointer.displayName}</small>
          <span className="pointer-glyph" aria-hidden="true" />
        </div>
      ))}
    </div>
  );
}

function LaunchOverlay({ hasPrimedWorkspace }) {
  return (
    <div className="launch-overlay" aria-live="polite" aria-label="Loading SpaceFlux workspace">
      <div className="launch-core">
        <div className="black-hole-mark" aria-hidden="true">
          <div className="black-hole-ring ring-one" />
          <div className="black-hole-ring ring-two" />
          <div className="black-hole-center" />
          <div className="black-hole-glow" />
        </div>
        <div className="launch-copy">
          <span className="eyebrow">SpaceFlux Launch Sequence</span>
          <h2>Warping your rooms into view</h2>
          <p>
            The rocket loops until your workspace is ready, then the dashboard takes over.
          </p>
        </div>
        <div className={`rocket-lane ${hasPrimedWorkspace ? "ready" : ""}`} aria-hidden="true">
          <div className="rocket">
            <span className="rocket-window" />
            <span className="rocket-wing rocket-wing-left" />
            <span className="rocket-wing rocket-wing-right" />
            <span className="rocket-fin rocket-fin-left" />
            <span className="rocket-fin rocket-fin-right" />
            <span className="rocket-engine">
              <span className="rocket-flame flame-core" />
              <span className="rocket-flame flame-outer" />
            </span>
          </div>
          <div className="rocket-trail" />
        </div>
      </div>
    </div>
  );
}
