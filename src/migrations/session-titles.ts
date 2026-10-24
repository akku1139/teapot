import { closeSync, openSync, readSync } from "node:fs";
import path from "node:path";
import type { Migration } from "./index.ts";

/**
 * Derive each agent's session title ONCE and store it in `config.agents[].sessionTitle`.
 *
 * Titles used to be recomputed on every `allSessions()` — opening up to 830 session logs and
 * allocating a 16KB buffer for each, MEASURED at 83.8ms, 8.1MB read and ~38MB of short-lived
 * garbage per scan, on every `/api/sessions`. Storing it makes listing a config lookup.
 *
 * Runs ONCE PER SESSION rather than once per process: the check is `sessionTitle` on the agent's
 * CURRENT session, so a machine that has already been through this does no file I/O at all. That
 * is what makes it idempotent — and why it must come AFTER any step that could change `agents[]`.
 *
 * A session whose first prompt is a HARNESS prompt yields no title: sub-agent sessions receive only
 * those and are labelled from their id, so inventing one would name a child after its parent's
 * instruction.
 */
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
      // already stored (possibly hand-edited — a chosen name must never be overwritten)
      if (typeof a.sessionTitle === "string" && a.sessionTitle.trim()) continue;
      if (session.includes("/") || session.includes("..")) continue; // never a path segment
      const title = firstUserPromptText(path.join(ctx.dataDir, "sessions", session, "chat.jsonl"));
      if (!title) continue;
      a.sessionTitle = title;
      changed = true;
    }
    if (changed) ctx.touch();
    return changed;
  },
};

/**
 * The first USER prompt in a log, trimmed to a title. `null` when there is none.
 *
 * Bounded (256KB) and stops at the first prompt, so one enormous log cannot dominate boot. A torn
 * final line at a chunk boundary is skipped rather than aborting the read.
 */
function firstUserPromptText(file: string): string | null {
  let fd: number | undefined;
  try {
    fd = openSync(file, "r");
    const CHUNK = 16 * 1024;
    const CAP = 256 * 1024;
    const buf = Buffer.alloc(CHUNK);
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
          continue; // torn line at a chunk boundary
        }
        if (e.type !== "prompt") continue;
        if (e.data?.source !== "user") return null; // a harness prompt is not a label
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
        /* already closed */
      }
    }
  }
}

/** the first usable line of a prompt, clipped — the sidebar shows one short label */
function titleOf(text: string | null): string | null {
  const line = (text ?? "")
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!line) return null;
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
}
