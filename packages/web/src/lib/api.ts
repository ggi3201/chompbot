const API_BASE = "/api";

export function getToken(): string | null {
  return localStorage.getItem("chomp_token");
}

export function setToken(token: string) {
  localStorage.setItem("chomp_token", token);
}

export function clearToken() {
  localStorage.removeItem("chomp_token");
}

export async function apiFetch(path: string, options: RequestInit = {}) {
  const token = getToken();
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
  });
  if (res.status === 401) {
    clearToken();
    window.location.href = "/";
  }
  return res;
}
