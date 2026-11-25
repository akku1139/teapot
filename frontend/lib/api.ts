export async function api(path: string, opts?: RequestInit) {
  const token = localStorage.getItem("teapot.token");
  const headers = new Headers(opts?.headers);
  if (token && !headers.has("authorization")) headers.set("authorization", `Bearer ${token}`);
  const res = await fetch(path, { ...opts, headers });
  if (!res.ok) {
    if (res.status === 401) window.dispatchEvent(new CustomEvent("teapot:unauthorized"));
    let body: unknown = null;
    try { body = await res.json(); } catch {  }
    const detail =
      (body && typeof body === "object" && "error" in body ? String((body as { error?: unknown }).error) : "") ||
      `${path}: HTTP ${res.status}`;
    throw Object.assign(new Error(detail), { payload: body });
  }
  return res.json();
}

/**
 * The API token as a query parameter, for a WebSocket.
 *
 * A browser cannot set headers on a WebSocket handshake, so the token has to travel in the URL. Shared from here because more
 * than one socket now needs it (the app socket, a terminal, the files watcher) and three copies of a security-relevant helper
 * is three places to get it wrong.
 */
export function wsTokenQuery(): string {
  const t = localStorage.getItem("teapot.token");
  return t ? `?token=${encodeURIComponent(t)}` : "";
}
