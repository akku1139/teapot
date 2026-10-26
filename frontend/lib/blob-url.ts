/**
 * Turn a stored image reference into a URL the browser can load.
 *
 * A session logs `blobs/<sha256>.<ext>` beside `chat.jsonl` — the bytes must live outside the JSONL,
 * and the session must be deletable in one `rm -r`. Those references are NOT browser paths:
 * MEASURED before this mapping existed, `<img src="blobs/3220fc….png">` resolved against
 * `/session/blobs/…`, 404'd, and every attachment on the timeline rendered broken
 * (`naturalWidth: 0`).
 *
 * Anything that is already loadable — an `http(s)` URL from a remote image, or a `data:` URL from an
 * older session — is returned untouched, so logs written before `blobs/` keep rendering.
 */
export function blobUrl(agentId: string | undefined, ref: string): string {
  if (!ref.startsWith("blobs/")) return ref;
  if (!agentId) return ref;
  const name = ref.slice("blobs/".length);
  return `/api/agents/${encodeURIComponent(agentId)}/blobs/${encodeURIComponent(name)}`;
}

/** The name inside a `blobs/` reference, or null when the value is not one. */
export function blobName(ref: string): string | null {
  if (!ref.startsWith("blobs/")) return null;
  const name = ref.slice("blobs/".length);
  return name && name === name.replace(/[/\\]/g, "") ? name : null;
}
