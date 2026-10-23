export async function api(path: string, opts?: RequestInit) {
  const token = localStorage.getItem("teapot.token");
  const headers = new Headers(opts?.headers);
  if (token && !headers.has("authorization")) headers.set("authorization", `Bearer ${token}`);
  const res = await fetch(path, { ...opts, headers });
  if (!res.ok) {
    // auth gate: surface once so the login overlay can appear
    if (res.status === 401) window.dispatchEvent(new CustomEvent("teapot:unauthorized"));
    let body: unknown = null;
    try { body = await res.json(); } catch { /* not json */ }
    const detail =
      (body && typeof body === "object" && "error" in body ? String((body as any).error) : "") ||
      `${path}: HTTP ${res.status}`;
    // carry the full payload (e.g. a 409's `current` file content) to callers
    throw Object.assign(new Error(detail), { payload: body });
  }
  return res.json();
}
