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

/**
 * How long an idle write stream is kept open (#143).
 *
 * The stream used to be opened in `load()` and closed only by `close()`, which
 * runs on dispose and shutdown. A loaded agent therefore held a file descriptor
 * for the whole process lifetime — MEASURED on a real master: 493 agents in
 * config meant 493 open `chat.jsonl` descriptors, ~300 MB RSS, growing with
 * every session the operator creates.
 *
 * The log is append-only, so a stream is never needed to keep state: reopening
 * with `flags: "a"` continues exactly where the last write stopped. Closing it
 * is therefore free, and re-opening on the next append costs one `open()` per
 * burst of activity rather than one per session forever.
 *
 * 15s, because a working agent appends many times per second — holding the
 * stream across that activity means file rotation / inspection outside the app
 * still sees a quiet, closed file, and a burst of tool calls costs ONE open.
 */
const IDLE_CLOSE_MS = 15_000;

export class EventLog {
  private stream: WriteStream | null = null;
  private seq = 0;
  private chain: Promise<void> = Promise.resolve();
  /** branch -> last event id (in-memory reconstruction of parent chains) */
  private lastByBranch = new Map<string, string>();
  /** optional observer (e.g. console logger wired by the master) */
  onEvent: ((e: TeapotEvent) => void) | null = null;
  /** #143: timer that closes the stream once this log goes quiet */
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * #143: set by close() so an append that resumes afterwards knows the log was
   * DISPOSED rather than merely idle — an idle log must reopen, a disposed one
   * must keep dropping (and saying so), which is the pre-existing contract.
   */
  private disposed = false;

  readonly filePath: string;
  readonly agentId: string;

  constructor(
    filePath: string,
    agentId: string,
  ) {
    this.filePath = filePath;
    this.agentId = agentId;
  }

  /**
   * Bytes read from the END of the log to rebuild the in-memory head.
   *
   * `load()` used to `readFile()` the ENTIRE log and `JSON.parse` every event,
   * only to learn two things: the highest `seq`, and the last event id per
   * branch. MEASURED on a real 813-session data dir (369 MB of logs): that read
   * was the single largest boot cost — 1603 ms of `load()` against 493 agents,
   * plus the GC pressure of holding one whole log as a string and its `split`
   * array (~50 MB of temporary garbage for a 23 MB log).
   *
   * Both facts live at the END of an append-only file:
   *   - `seq` is assigned monotonically, so the last complete line holds the max
   *   - `lastEventId()` is only ever called for the CURRENT branch (fork/spawn),
   *     which is by definition the most recently written one
   *
   * So the tail is both sufficient and exact. A branch that has been dormant for
   * more than WINDOW bytes loses its in-memory head; that only affects
   * `parent:` on the next append to that stale branch, and the paths that matter
   * (`fork`, child spawn) re-seed explicitly through `seedBranch()`.
   */
  private static readonly LOAD_TAIL_BYTES = 512 * 1024;

  async load(): Promise<void> {
    mkdirSync(path.dirname(this.filePath), { recursive: true });
    try {
      const { readFile, stat, open } = await import("node:fs/promises");
      const st = await stat(this.filePath);
      let text: string;
      if (st.size <= EventLog.LOAD_TAIL_BYTES) {
        text = await readFile(this.filePath, "utf8"); // small log: read it all
      } else {
        const start = st.size - EventLog.LOAD_TAIL_BYTES;
        const fh = await open(this.filePath, "r");
        try {
          const buf = Buffer.alloc(EventLog.LOAD_TAIL_BYTES);
          const { bytesRead } = await fh.read(buf, 0, buf.length, start);
          text = buf.subarray(0, bytesRead).toString("utf8");
        } finally {
          await fh.close();
        }
        // the window starts mid-line: drop the partial first line
        const nl = text.indexOf("\n");
        text = nl === -1 ? "" : text.slice(nl + 1);
      }
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
    // #143: NO stream here. Opening it in load() is what held a descriptor per
    // loaded agent for the lifetime of the process (measured: 493 of them).
    // `load()` still reads and repairs the file — it just does not keep it open.
  }

  /**
   * Open the append stream if it is not already open (#143).
   *
   * Called from the write chain so an append cannot race a close: both run
   * inside `this.chain`, which is a promise queue.
   */
  private openStream(): WriteStream {
    if (this.stream) return this.stream;
    const s = createWriteStream(this.filePath, { flags: "a" });
    s.on("error", (err) => {
      console.error(`[teapot] log write error (${this.filePath}):`, err.message);
    });
    this.stream = s;
    return s;
  }

  /** #143: close the stream once this log has been quiet for IDLE_CLOSE_MS. */
  private scheduleIdleClose(): void {
    if (this.idleTimer) return; // already armed; the existing deadline stands
    this.idleTimer = setTimeout(() => this.fireIdleClose(), IDLE_CLOSE_MS);
    // the timer must never be the reason a process cannot exit
    this.idleTimer.unref?.();
  }

  /**
   * What the idle timer does — separated so it can be driven directly.
   *
   * Clears the deadline FIRST so `releaseIdleStream` can tell "nothing new
   * arrived" (close) from "an append re-armed it while I waited" (defer).
   */
  private fireIdleClose(): void {
    this.idleTimer = null;
    void this.releaseIdleStream();
  }

  /**
   * Close the stream after a quiet period.
   *
   * Runs behind `chain`, so it cannot interleave with a queued write. An append
   * that arrived while this was pending re-armed the timer, and that newer
   * deadline owns the close — hence the check on `idleTimer` AFTER draining,
   * not before.
   */
  private async releaseIdleStream(): Promise<void> {
    await this.chain.catch(() => {});
    if (this.disposed) return;
    if (!this.stream) return;
    // a later append re-armed the timer — let that deadline own the close
    if (this.idleTimer) return;
    const s = this.stream;
    this.stream = null;
    await new Promise<void>((res) => s.end(res)).catch(() => {
      /* the write error handler already reported it */
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
    // #54: WRITE FIRST, then notify.
    //
    // The observer used to fire BEFORE the write. The frontend receives a
    // `kind:"event"` frame and — by design — treats it as "something changed"
    // and re-reads `/events`. So the reload could read the log BEFORE this
    // event reached disk, and the reload would simply not contain it.
    //
    // Measured against a real EventLog, reloading on every notification:
    //
    //     appends: 30   WS-triggered reloads that MISSED the event: 30
    //
    // The 120ms debounce usually hides this, which is exactly why #54 felt
    // random: a slow write misses, a fast one lands. Notifying after the write
    // makes the event visible to any reader the observer triggers.
    // `written` distinguishes a REAL write from the post-close drop path, which
    // also resolves. #54: announcing a dropped event would tell the frontend to
    // reload for something that will never appear — the row would flicker in and
    // straight back out.
    let written = false;
    const p = new Promise<TeapotEvent>((resolve, reject) => {
      this.chain = this.chain.then(() => {
        if (this.disposed) {
          // log DISPOSED (not merely idle) — resolve so callers don't await
          // forever, but say so: silent drops made post-shutdown writes look
          // logged. #143: this is a distinct state from an idle stream, which
          // must reopen instead of dropping.
          console.error(`[teapot] event dropped after log close (${this.agentId}): ${type}`);
          return resolve(evt);
        }
        // #143: open on demand — an idle log keeps no descriptor
        this.openStream().write(JSON.stringify(evt) + "\n", "utf8", (err) => {
          if (err) return reject(err);
          written = true;
          resolve(evt);
        });
      }, () => resolve(evt));
    });
    // #143: re-arm the idle close for every append. Set here rather than inside
    // the write callback: the timer measures quiet time from the last APPEND, and
    // a long write must not count as activity after the fact.
    this.scheduleIdleClose();
    this.chain = this.chain.then(
      () => {},
      () => {},
    );
    // notify once the write is handed to the OS, so a reload the observer
    // triggers can actually see this event
    void p
      .then(() => {
        if (!written) return; // dropped after close: nothing on disk to announce
        try {
          this.onEvent?.(evt);
        } catch {
          /* observer must never break the log */
        }
      })
      .catch(() => {
        /* a failed write must not notify — the event is not on disk */
      });
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
    // #143: mark DISPOSED before draining, so an append queued behind us drops
    // loudly instead of reopening the log we are shutting down. This is the
    // difference between "idle" (reopen on the next write) and "closed".
    this.disposed = true;
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
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
