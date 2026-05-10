const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL;
const SESSION_TOKEN_KEY = "spaceflux-session-token";

function readSessionToken() {
  if (typeof window === "undefined") {
    return "";
  }

  return window.localStorage.getItem(SESSION_TOKEN_KEY) || "";
}

function writeSessionToken(token) {
  if (typeof window === "undefined") {
    return;
  }

  if (token) {
    window.localStorage.setItem(SESSION_TOKEN_KEY, token);
    return;
  }

  window.localStorage.removeItem(SESSION_TOKEN_KEY);
}

async function request(path, options = {}) {
  const sessionToken = readSessionToken();
  const response = await fetch(`${API_BASE_URL}${path}`, {
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...(sessionToken ? { Authorization: `Bearer ${sessionToken}` } : {}),
      ...(options.headers || {})
    },
    ...options
  });

  if (!response.ok) {
    let payload = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }

    const error = new Error(payload?.error || `Request failed: ${response.status}`);
    error.status = response.status;
    error.detail = payload?.detail || "";
    throw error;
  }

  const payload = await response.json();

  if (payload?.sessionToken) {
    writeSessionToken(payload.sessionToken);
  }

  return payload;
}

export const api = {
  getMe: () => request("/me"),
  register: (body) => request("/auth/register", { method: "POST", body: JSON.stringify(body) }),
  login: (body) => request("/auth/login", { method: "POST", body: JSON.stringify(body) }),
  logout: () => request("/auth/logout", { method: "POST" }),
  listRooms: () => request("/rooms"),
  createRoom: (body) => request("/rooms", { method: "POST", body: JSON.stringify(body) }),
  joinRoom: (body) => request("/rooms/join", { method: "POST", body: JSON.stringify(body) }),
  leaveRoom: (roomId) => request(`/rooms/${roomId}/leave`, { method: "POST" }),
  getMessages: (roomId) => request(`/rooms/${roomId}/messages`),
  getFiles: (roomId) => request(`/rooms/${roomId}/files`),
  clearStoredSession: () => writeSessionToken("")
};

export function getStoredSessionToken() {
  return readSessionToken();
}
