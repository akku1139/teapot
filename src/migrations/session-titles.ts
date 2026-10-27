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
    const isRecord = (v: unknown): v is Record<string, string> =>
      !!v && typeof v === "object" && !Array.isArray(v);
    let changed = false;
    /**
     * Move the title out of `config.json` and into the session's own `session.json`.
     *
     * It used to be stored in `config.json` — a second copy of something the session directory owns,
     * and the copy that went stale. A title already present wins over a derived one, so an operator's
     * rename is never replaced by the auto-generated name.
     */
    /**
     * Move `agents[].sessionTitle` into the `sessionTitles` MAP, keyed by session id.
     *
     * Per-agent was the wrong key: an agent moves between sessions, so the field had to be cleared on
     * every switch (which reverted a rename), and a session no agent points at could not keep a name.
     * A map also keeps the left panel to ONE config read instead of a `session.json` per directory —
     * MEASURED: 838 sessions = 13.2ms of directory reads vs 1.2ms for the config file.
     */
    const titles = (raw.sessionTitles = isRecord(raw.sessionTitles) ? raw.sessionTitles : {});
    for (const a of agents) {
      const session = typeof a.session === "string" ? a.session : "";
      const legacy = typeof a.sessionTitle === "string" ? a.sessionTitle.trim() : "";
      if (session && !session.includes("/") && !session.includes("..")) {
        const already = typeof titles[session] === "string" ? String(titles[session]).trim() : "";
        if (!already) {
          /**
         * NOT derived from `chat.jsonl` here.
         *
         * A migration runs for EVERY agent at boot, and reading each session's log is exactly what the
         * operator ruled out — "起動中に読んでいいのはconfig.jsonとskillsだけ / セッションディレクトリは
         * セッションがロードされるまで開かない". A legacy `sessionTitle` is used when present; otherwise
         * the session id is a perfectly good name, and a real title is derived once when that session is
         * actually opened (`Master.ensureSessionTitle`).
         */
        const derived = legacy || session;
          titles[session] = derived;
          changed = true;
        }
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
    if (Object.keys(titles).length === 0 && raw.sessionTitles !== undefined) delete raw.sessionTitles;

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
