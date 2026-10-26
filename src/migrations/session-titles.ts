import { closeSync, openSync, readSync } from "node:fs";
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
    for (const a of agents) {
      const session = typeof a.session === "string" ? a.session : "";
      if (!session) continue;
      if (typeof a.sessionTitle === "string" && a.sessionTitle.trim()) continue;
      if (session.includes("/") || session.includes("..")) continue; 
      const title = firstUserPromptText(path.join(ctx.dataDir, "sessions", session, "chat.jsonl"));
      a.sessionTitle = title ?? session;
      changed = true;
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
