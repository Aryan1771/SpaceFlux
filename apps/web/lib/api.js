const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL;

async function request(path, options = {}) {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
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

    throw new Error(payload?.error || `Request failed: ${response.status}`);
  }

  return response.json();
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
  getFiles: (roomId) => request(`/rooms/${roomId}/files`)
};
