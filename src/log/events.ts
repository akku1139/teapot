/**
 * Append-only JSONL event log.
 *
 * Design goals:
 *  - One file per agent (sessions.log.jsonl). Every conversation, including
 *    forks, lives in the SAME file as an interleaved event stream.
 *  - Each line is one self-contained JSON object; humans can `cat`/`jq` it.
 *  - Lineage is explicit: every event carries `session`, `branch`, and
 *    `parent` (the previous event on the same branch). A `fork` event records
 *    where the new branch started (fromSession/fromBranch/fromEvent), so any
 *    session can be reconstructed by filtering `branch === X` or by walking
 *    parent links from the fork point backwards into ancestor branches.
 *  - Append-only + monotonic `seq` makes corruption detectable (a torn final
 *    line is simply ignored on read).
 */
import { createWriteStream, WriteStream } from "node:fs";
import { mkdirSync } from "node:fs";
import path from "node:path";

export type EventType =
  | "session_start" // data: {session, branch, title?}
  | "fork" // data: {fromSession, fromBranch, fromEvent, newSession?, newBranch}
  | "prompt" // data: {role:"user", text} human/scheduler input
  | "system_note" // harness-injected context (not shown to LLM unless flagged)
  | "message" // LLM message: data:{role, content, toolCalls?}
  | "tool_call" // data:{callId, name, args}
  | "tool_result" // data:{callId, name, ok, result, durationMs}
  | "state" // agent state change: data:{from,to,reason?}
  | "progress" // progress report: data:{doing, goalStatus, recent, problems?, next?}
  | "error" // data:{message, fatal?}
  | "usage" // data:{inputTokens, outputTokens, costEstimate?}
  | "goal" // data:{event:"set"|"status", ...}
  | "todo" // operator-maintained task list changed: data:{event:"set", by}
  | "question" // agent asked the operator something: data:{question, options?}
  | "sub_fork" // child session header: data:{parentAgent, parentSession, upToEvent}
  | "sub" // mirrored child activity in the parent feed: data:{sub, type, data}
  | "decision" // agent recorded a choice + rationale: data:{decision, rationale, alternatives?}
  | "compaction"; // context compaction happened: data:{summary?, tokensBefore/After, mode}

export interface TeapotEvent {
  v: 1;
  id: string;
  seq: number;
  ts: string;
  agent: string;
  session: string;
  branch: string;
  parent: string | null;
  type: EventType;
  data: unknown;
}

export class EventLog {
  private stream: WriteStream | null = null;
  private seq = 0;
  private chain: Promise<void> = Promise.resolve();
  /** branch -> last event id (in-memory reconstruction of parent chains) */
  private lastByBranch = new Map<string, string>();
  /** optional observer (e.g. console logger wired by the master) */
  onEvent: ((e: TeapotEvent) => void) | null = null;

  readonly filePath: string;
  readonly agentId: string;

  constructor(
    filePath: string,
    agentId: string,
  ) {
    this.filePath = filePath;
    this.agentId = agentId;
  }

  async load(): Promise<void> {
    mkdirSync(path.dirname(this.filePath), { recursive: true });
    try {
      const { readFile } = await import("node:fs/promises");
      const text = await readFile(this.filePath, "utf8");
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        try {
          const e = JSON.parse(line) as TeapotEvent;
          if (typeof e.seq === "number" && e.seq > this.seq) this.seq = e.seq;
          this.lastByBranch.set(e.branch, e.id);
        } catch {
          /* torn trailing line: ignore */
        }
      }
    } catch {
      /* new log */
    }
    // repair a torn tail: without this, the next append would fuse into the
    // corrupt partial line and destroy two events instead of one
    try {
      const { stat, appendFile } = await import("node:fs/promises");
      const st = await stat(this.filePath);
      if (st.size > 0) {
        const buf = Buffer.alloc(1);
        const fh = await import("node:fs/promises").then((m) => m.open(this.filePath, "r"));
        await fh.read(buf, 0, 1, st.size - 1);
        await fh.close();
        if (buf[0] !== 0x0a) await appendFile(this.filePath, "\n");
      }
    } catch {
      /* file may not exist yet */
    }
    this.stream = createWriteStream(this.filePath, { flags: "a" });
    this.stream.on("error", (err) => {
      console.error(`[teapot] log write error (${this.filePath}):`, err.message);
    });
  }

  /** Append an event; resolves when it is handed to the OS (write flushed). */
  append(type: EventType, session: string, branch: string, data: unknown): Promise<TeapotEvent> {
    const evt: TeapotEvent = {
      v: 1,
      id: `e${++this.seq}`,
      seq: this.seq,
      ts: new Date().toISOString(),
      agent: this.agentId,
      session,
      branch,
      parent: this.lastByBranch.get(branch) ?? null,
      type,
      data,
    };
    this.lastByBranch.set(branch, evt.id);
    try {
      this.onEvent?.(evt);
    } catch {
      /* observer must never break the log */
    }
    const p = new Promise<TeapotEvent>((resolve, reject) => {
      this.chain = this.chain.then(() => {
        if (!this.stream) {
          // log closed (dispose) — resolve so callers don't await forever,
          // but say so: silent drops made post-shutdown writes look logged
          console.error(`[teapot] event dropped after log close (${this.agentId}): ${type}`);
          return resolve(evt);
        }
        this.stream.write(JSON.stringify(evt) + "\n", "utf8", (err) =>
          err ? reject(err) : resolve(evt),
        );
      }, () => resolve(evt));
    });
    this.chain = this.chain.then(
      () => {},
      () => {},
    );
    return p;
  }

  lastEventId(branch: string): string | null {
    return this.lastByBranch.get(branch) ?? null;
  }

  /**
   * Seed the parent link for a brand-new branch so its first event chains to
   * the event that created it.
   *
   * `lastByBranch` is per branch, so without this a new branch's first event
   * got `parent: null` — severing the chain. lineageOf() walks parents from the
   * newest event, so the entire pre-fork history became unreachable and a
   * restart rebuilt the conversation with none of it (#38).
   */
  seedBranch(branch: string, parentEventId: string | null): void {
    if (!branch) return;
    this.lastByBranch.set(branch, parentEventId ?? "");
  }

  async close(): Promise<void> {
    await this.chain.catch(() => {});
    if (!this.stream) return;
    const s = this.stream;
    this.stream = null;
    await new Promise<void>((res) => s.end(res));
  }
}

/** Read all events from a JSONL file (tolerates a torn final line). */
export async function readEvents(filePath: string): Promise<TeapotEvent[]> {
  try {
    const { readFile } = await import("node:fs/promises");
    const out: TeapotEvent[] = [];
    for (const line of (await readFile(filePath, "utf8")).split("\n")) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as TeapotEvent);
      } catch {
        /* skip bad line */
      }
    }
    return out;
  } catch {
    return [];
  }
}

/** Default floor for a tail read, so a small `limit` cannot cause a tiny read. */
const TAIL_MIN_BYTES = 64 * 1024;

/**
 * Read only the LAST `limit` events from an append-only JSONL log.
 *
 * #59: the web UI polls this endpoint every ~120 ms for the selected agent, and
 * the full re-parse cost 348 ms on a 57 MB / 200 000-event log. The mtime cache
 * could not help — a RUNNING agent appends constantly, so `size` and `mtimeMs`
 * change on every single request and the cache only ever helped stopped agents.
 *
 * The log is strictly append-only: `EventLog.append` is the only writer and
 * always writes a whole `JSON.stringify(evt) + "\n"` under a serialized chain,
 * so an append never rewrites earlier bytes. That makes a tail read safe, and
 * makes byte-offset caching legitimate.
 *
 * Anchored to the tail deliberately. The read starts at a byte offset chosen for
 * the file's current size, so the FIRST line it sees is usually a fragment —
 * dropped. `bytesScanned` is reported so callers (and tests) can assert the read
 * really was partial rather than trusting a wall-clock number.
 */
export async function readEventsTail(
  filePath: string,
  limit: number,
): Promise<{ events: TeapotEvent[]; total: number; bytesScanned: number; truncated: boolean }> {
  const empty = { events: [] as TeapotEvent[], total: 0, bytesScanned: 0, truncated: false };
  if (limit <= 0) return empty;
  let fh: import("node:fs/promises").FileHandle | null = null;
  try {
    const fsp = await import("node:fs/promises");
    fh = await fsp.open(filePath, "r");
    const st = await fh.stat();
    if (st.size === 0) return empty;

    // grow the window until it holds `limit` whole lines. Start at a floor so a
    // small limit still reads a sensible block, then double — bounded by the
    // file size, because a pathological file must not make us read forever.
    let want = Math.min(st.size, Math.max(TAIL_MIN_BYTES, limit * 512));
    for (;;) {
      const r = await readWindow(fh, st.size, want);
      if (r.events.length >= limit || want >= st.size) {
        return {
          events: r.events.slice(-limit),
          // `total` is an APPROXIMATE count: only the window was parsed, so this
          // is "at least this many". /events uses it for the "load older" hint,
          // where approximate is fine — an exact count would mean reading the
          // entire file, which is the cost this function exists to avoid.
          total: r.events.length,
          bytesScanned: r.bytes,
          truncated: r.bytes < st.size,
        };
      }
      want = Math.min(st.size, want * 4);
    }
  } catch {
    return empty;
  } finally {
    await fh?.close().catch(() => {});
  }
}

/** read the last `bytes` of the file, dropping the leading partial line */
async function readWindow(
  fh: import("node:fs/promises").FileHandle,
  size: number,
  bytes: number,
): Promise<{ events: TeapotEvent[]; bytes: number }> {
  const start = Math.max(0, size - bytes);
  const buf = Buffer.alloc(size - start);
  if (buf.length) await fh.read(buf, 0, buf.length, start);
  const text = buf.toString("utf8");
  const nl = text.indexOf("\n");
  // the first line is a fragment unless we started at 0
  const body = start > 0 ? (nl === -1 ? "" : text.slice(nl + 1)) : text;
  const events: TeapotEvent[] = [];
  for (const line of body.split("\n")) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line) as TeapotEvent);
    } catch {
      /* torn or corrupt line: skip it, never return a fragment */
    }
  }
  return { events, bytes: buf.length };
}


/**
 * Keep one branch's rows out of a timeline, optionally including the history it
 * inherited before it forked.
 *
 * #38. A fork is a new timeline, but the agent's CONTEXT on it still includes
 * everything before the fork point — `rebuildMessagesFrom` walks the parent
 * chain across branch boundaries precisely so a restarted fork keeps its
 * history. Filtering the view by strict equality therefore showed *less* than
 * the model actually reasons over, which is why a filtered fork looked like
 * data loss even though nothing was missing from the log.
 *
 * `includeInherited` walks the parent links out of the branch's own events and
 * keeps everything they reach, so the view matches the model's context. Strict
 * remains the default: a caller that genuinely wants only a branch's own rows
 * (counting, auditing) should not be handed inherited history silently.
 *
 * Pure and exported so the rule can be tested without an HTTP server.
 */
export function filterByBranch(
  events: readonly TeapotEvent[],
  branch: string,
  includeInherited = false,
): TeapotEvent[] {
  if (!includeInherited) return events.filter((e) => e.branch === branch);
  const byId = new Map(events.map((e) => [e.id, e]));
  // every event belonging to the branch, plus everything reachable by `parent`
  const wanted = new Set<string>();
  // A WORKLIST, not a loop over the growing set: iterating `wanted` while
  // adding to it inside the same pass re-visits nodes and, on a parent cycle,
  // never terminates.
  const queue: string[] = [];
  for (const e of events) {
    if (e.branch !== branch) continue;
    if (wanted.has(e.id)) continue;
    wanted.add(e.id);
    queue.push(e.id);
  }
  while (queue.length) {
    const cur = byId.get(queue.pop()!);
    // walk up through the fork boundary — a fork's parent is the last event of
    // the SOURCE branch, and that branch's history is inherited too
    if (cur?.parent && !wanted.has(cur.parent)) {
      wanted.add(cur.parent);
      queue.push(cur.parent);
    }
  }
  return events.filter((e) => wanted.has(e.id));
}
