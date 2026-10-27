/**
 * Read a `run_tool` id well enough to display it.
 *
 * The id is a string the MODEL wrote, and it varies: MEASURED on one session, the same tool arrived as
 * `["Ghidra","get_xrefs_to"]`, `['Ghidra', 'get_xrefs_to']`, `Ghidra/get_xrefs_to` and a bare name. The
 * timeline must not show `run_tool` (or a raw JSON blob) for any of them.
 *
 * This is display only — the server has its own, authoritative resolver. Keeping the parsing tolerant in
 * both places is deliberate: the frontend cannot ask the server what a string meant, and a label is not
 * worth a round trip.
 */
export function mcpToolLabel(raw: unknown): string | null {
  const text = String(raw ?? "").trim();
  if (!text) return null;

  if (text.startsWith("[")) {
    const pair = (() => {
      try {
        return JSON.parse(text) as unknown;
      } catch {
        try {
          return JSON.parse(text.replace(/'/g, '"')) as unknown;
        } catch {
          return undefined;
        }
      }
    })();
    if (Array.isArray(pair) && pair.length >= 2) return `${String(pair[0])}/${String(pair[1])}`;
  }

  for (const sep of ["__", "/", "::"]) {
    const at = text.lastIndexOf(sep);
    if (at <= 0) continue;
    return `${text.slice(0, at).replace(/^mcp__/, "")}/${text.slice(at + sep.length)}`;
  }
  return text;
}
