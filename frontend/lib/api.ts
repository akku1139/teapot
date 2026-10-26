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
      (body && typeof body === "object" && "error" in body ? String((body as any).error) : "") ||
      `${path}: HTTP ${res.status}`;
    throw Object.assign(new Error(detail), { payload: body });
  }
  return res.json();
}
