import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Migration } from "./index.ts";

export const sessionTitles: Migration = {
  order: 30,
  id: "agents-session-title",
  summary: "derive agents[].sessionTitle from each current session's first user prompt",
  run(ctx) {
    const raw = ctx.raw();
    const agents = Array.isArray(raw.agents) ? (raw.agents as Record<string, unknown>[]) : [];
    let changed = false;
    /**
     * Move the title out of `config.json` and into the session's own `session.json`.
     *
     * It used to be stored in `config.json` — a second copy of something the session directory owns,
     * and the copy that went stale. A title already present wins over a derived one, so an operator's
     * rename is never replaced by the auto-generated name.
     */
    for (const a of agents) {
      const session = typeof a.session === "string" ? a.session : "";
      if (!session) continue;
      if (session.includes("/") || session.includes("..")) continue;
      const dir = path.join(ctx.dataDir, "sessions", session);
      const file = path.join(dir, "session.json");
      let manifest: Record<string, unknown> = { v: 1 };
      try {
        manifest = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
      } catch {
      }
      const already = typeof manifest.title === "string" ? manifest.title.trim() : "";
      if (!already) {
        const fromConfig = typeof a.sessionTitle === "string" ? a.sessionTitle.trim() : "";
        const derived = fromConfig || firstUserPromptText(path.join(dir, "chat.jsonl")) || session;
        manifest.title = derived;
        try {
          mkdirSync(dir, { recursive: true });
          writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
        } catch {
        }
        changed = true;
      }
      /**
       * Only report a change when one happened: a migration that claims success every boot rewrites
       * the config file forever, and re-running must be a genuine no-op (the suite asserts it).
       */
      if (a.sessionTitle !== undefined) {
        delete a.sessionTitle;
        changed = true;
      }
    }

    if (changed) ctx.touch();
    return changed;
  },
};

let scanBuffer: Buffer | undefined;

function firstUserPromptText(file: string): string | null {
  let fd: number | undefined;
  try {
    fd = openSync(file, "r");
    const CHUNK = 16 * 1024;
    const CAP = 256 * 1024;
    scanBuffer ??= Buffer.alloc(CHUNK);
    const buf = scanBuffer;
    let offset = 0;
    let carry = "";
    while (offset < CAP) {
      const n = readSync(fd, buf, 0, CHUNK, offset);
      if (n <= 0) break;
      offset += n;
      const lines = (carry + buf.subarray(0, n).toString("utf8")).split("\n");
      carry = lines.pop() ?? "";
      for (const l of lines) {
        if (!l) continue;
        let e: { type?: unknown; data?: { source?: unknown; text?: unknown } };
        try {
          e = JSON.parse(l) as typeof e;
        } catch {
          continue; 
        }
        if (e.type !== "prompt") continue;
        if (e.data?.source !== "user") return null; 
        return titleOf(typeof e.data.text === "string" ? e.data.text : null);
      }
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
      }
    }
  }
}

function titleOf(text: string | null): string | null {
  const line = (text ?? "")
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!line) return null;
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
}
