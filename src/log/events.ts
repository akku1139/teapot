import { createWriteStream, WriteStream } from "node:fs";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

export type EventType =
  | "session_start" 
  | "fork" 
  | "prompt" 
  | "system_note" 
  | "message" 
  | "tool_call" 
  | "tool_result" 
  | "state" 
  | "progress" 
  | "error" 
  | "usage" 
  | "goal" 
  | "todo" 
  | "question" 
  | "sub_fork" 
  | "sub" 
  | "decision" 
  | "compaction" 
  | "audit_step"; 

/**
 * ONE line of a session's log.
 *
 * This is the whole format: what is written is what is read. It deliberately does NOT repeat what the FILE already says —
 * a line belongs to its session (the directory) and to that session's agent (the manifest beside it) — because carrying two
 * constants on every line cost 69MB of 973MB (7.1%, MEASURED over 1,000,000 events). A `v` version field was written on every
 * line and read by nothing, so it is gone rather than kept for a hypothetical reader.
 *
 * Anything that needs the identity asks for it: `TeapotEvent` is this plus the identity, and only `readEvents` and its
 * siblings can produce one.
 */
export interface LogEvent {
  seq: number;
  ts: string;
  branch: string;
  parent: string | null;
  type: EventType;
  data: unknown;
}

/** A log line AND what the FILE it came from already says — the only shape the rest of the code sees. */
export interface TeapotEvent extends LogEvent {
  /** `e<seq>`: the id is the sequence, so storing it stored the same number twice */
  id: string;
  /** the session the log belongs to: its directory name */
  session: string;
  /** the agent that owns that session, from its manifest */
  agent: string;
}

/**
 * The line as WRITTEN: the identity is not in it.
 *
 * `append()` builds a `TeapotEvent` because everything downstream wants the identity, so the write has to drop it here — one
 * place, so a new field cannot be half-persisted.
 */
export function logLine(e: TeapotEvent): LogEvent {
  const { session: _session, agent: _agent, id: _id, ...line } = e;
  return line;
}

/**
 * Where a log lives, and who owns it — resolved once per file, not per line.
 *
 * `sessions/<session>/chat.jsonl`, with `session.json` beside it naming the agent. A session with no manifest is named by its
 * directory, which is what the directory IS.
 */
export function sessionIdentityOf(filePath: string): { session: string; agent: string } {
  const dir = path.dirname(filePath);
  const session = path.basename(dir);
  let agent = "";
  try {
    const raw = JSON.parse(readFileSync(path.join(dir, "session.json"), "utf8")) as { agentId?: unknown };
    if (typeof raw.agentId === "string") agent = raw.agentId;
  } catch {
    // no manifest: the directory name is the session, and it names the agent too
  }
  return { session, agent: agent || session };
}

/**
 * A parsed line plus what the file it came from already says.
 *
 * The fields are listed EXPLICITLY rather than spread, so a key an old line still carries (`v`, a stored `agent`) cannot ride
 * along into the event every caller sees. MEASURED: a spread kept `v` on the returned object, so deleting the field from the
 * format would have left it reachable from outside — exactly the "do not access it any more" the type is meant to enforce.
 */
function decorate(line: LogEvent, identity: { session: string; agent: string }): TeapotEvent {
  return {
    id: eventId(line.seq),
    seq: line.seq,
    ts: line.ts,
    branch: line.branch,
    parent: line.parent,
    type: line.type,
    data: line.data,
    session: identity.session,
    agent: identity.agent,
  };
}

/**
 * The event id, from its sequence.
 *
 * `id` was `e${++seq}` and nothing else, so it was the same number written twice — 13.1MB of 973MB (1.3%, MEASURED). Every
 * reader asks for `e.id`, and it is a function of `seq`, which IS stored.
 */
export function eventId(seq: number): string {
  return `e${seq}`;
}

const IDLE_CLOSE_MS = 15_000;

export class EventLog {
  private stream: WriteStream | null = null;
  private seq = 0;
  private chain: Promise<void> = Promise.resolve();
  private lastByBranch = new Map<string, string>();
  onEvent: ((e: TeapotEvent) => void) | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
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

  private static readonly LOAD_TAIL_BYTES = 512 * 1024;

  /**
   * Read the log TAIL to learn `seq` and the last event per branch.
   *
   * LAZY, and memoised. `Agent.init()` ran it for every agent at boot, which is the startup cost the
   * operator reported: 445 agents × up to 512KB of `chat.jsonl` parsed before the first request —
   * MEASURED 3.5s of a 7.8s boot, plus the parsed events on the heap ("起動直後のメモリバースト",
   * rss 1GB / heap 800MB).
   *
   * Nothing needs it until something WRITES (`append` increments `seq`) or asks for a branch's last
   * event, so it now happens then. The rule from the operator: "起動中に読んでいいのはconfig.jsonと
   * skillsだけ / セッションディレクトリはセッションがロードされるまで開かない".
   */
  ensureLoaded(): Promise<void> {
    this.loadPromise ??= this.load();
    return this.loadPromise;
  }

  private loadPromise?: Promise<void>;

  async load(): Promise<void> {
    mkdirSync(path.dirname(this.filePath), { recursive: true });
    try {
      const { readFile, stat, open } = await import("node:fs/promises");
      const st = await stat(this.filePath);
      let text: string;
      if (st.size <= EventLog.LOAD_TAIL_BYTES) {
        text = await readFile(this.filePath, "utf8"); 
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
        const nl = text.indexOf("\n");
        text = nl === -1 ? "" : text.slice(nl + 1);
      }
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        try {
          // only the sequence and the branch chain matter here — the event is not retained, so it is not decorated
          const e = JSON.parse(line) as LogEvent;
          if (typeof e.seq === "number" && e.seq > this.seq) this.seq = e.seq;
          this.lastByBranch.set(e.branch, eventId(e.seq));
        } catch {
        }
      }
    } catch {
    }
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
    }
  }

  private openStream(): WriteStream {
    if (this.stream) return this.stream;
    const s = createWriteStream(this.filePath, { flags: "a" });
    s.on("error", (err) => {
      console.error(`[teapot] log write error (${this.filePath}):`, err.message);
    });
    this.stream = s;
    return s;
  }

  private scheduleIdleClose(): void {
    if (this.idleTimer) return; 
    this.idleTimer = setTimeout(() => this.fireIdleClose(), IDLE_CLOSE_MS);
    this.idleTimer.unref?.();
  }

  private fireIdleClose(): void {
    this.idleTimer = null;
    void this.releaseIdleStream();
  }

  private async releaseIdleStream(): Promise<void> {
    await this.chain.catch(() => {});
    if (this.disposed) return;
    if (!this.stream) return;
    if (this.idleTimer) return;
    const s = this.stream;
    this.stream = null;
    await new Promise<void>((res) => s.end(res)).catch(() => {
    });
  }

  /**
   * Queue a write, reading the log first if it has not been read yet.
   *
   * NOT `async` on purpose. An `async` function returns a NEW promise, so `void this.log.append(…)`
   * — which is how most call sites fire a log write — would leave that wrapper promise unhandled when
   * the write fails, and the failure surfaced as an `unhandledRejection` instead of the caller's
   * problem. Returning the inner promise (which already has handlers attached below) keeps the old
   * behaviour: awaiting still throws, ignoring stays silent.
   */
  append(type: EventType, session: string, branch: string, data: unknown): Promise<TeapotEvent> {
    const p = this.ensureLoaded().then(() => this.writeEvent(type, session, branch, data));
    void p.catch(() => {});
    return p;
  }

  private async writeEvent(
    type: EventType,
    session: string,
    branch: string,
    data: unknown,
  ): Promise<TeapotEvent> {
    /**
     * The line carries NONE of `id`, `agent`, `session` or `v`.
     *
     * `id` is the sequence spelled out, `agent` and `session` are the file's own identity (its directory and the manifest
     * beside it), and `v` was written on every line and read by nothing. All four are derived on read — see `TeapotEvent`.
     */
    const evt: TeapotEvent = {
      id: eventId(this.seq + 1),
      seq: ++this.seq,
      ts: new Date().toISOString(),
      agent: this.agentId,
      session,
      branch,
      parent: this.lastByBranch.get(branch) ?? null,
      type,
      data,
    };
    this.lastByBranch.set(branch, evt.id);
    let written = false;
    const p = new Promise<TeapotEvent>((resolve, reject) => {
      this.chain = this.chain.then(() => {
        if (this.disposed) {
          console.error(`[teapot] event dropped after log close (${this.agentId}): ${type}`);
          return resolve(evt);
        }
        this.openStream().write(JSON.stringify(logLine(evt)) + "\n", "utf8", (err) => {
          if (err) return reject(err);
          written = true;
          resolve(evt);
        });
      }, () => resolve(evt));
    });
    this.scheduleIdleClose();
    this.chain = this.chain.then(
      () => {},
      () => {},
    );
    void p
      .then(() => {
        if (!written) return; 
        try {
          this.onEvent?.(evt);
        } catch {
        }
      })
      .catch(() => {
      });
    return p;
  }

  lastEventId(branch: string): string | null {
    return this.lastByBranch.get(branch) ?? null;
  }

  seedBranch(branch: string, parentEventId: string | null): void {
    if (!branch) return;
    this.lastByBranch.set(branch, parentEventId ?? "");
  }

  async close(): Promise<void> {
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

/**
 * Parse a whole log file, STREAMING it.
 *
 * It used to `readFile()` the entire file into one string and `.split("\n")` it, so a large session paid for three
 * copies at once: the file's bytes, one string per line, and the parsed objects. MEASURED on the operator's server:
 * `master rss 1034.4MB · heap 599.1MB` at the moment of a burst, back to `heap 248.2MB` a moment later — a transient
 * allocation that GC could reclaim, not a leak.
 *
 * Reading line-by-line through a stream removes the first two copies: the only thing retained is the events, and the
 * peak no longer scales with (file bytes × 3).
 */
export async function readEvents(filePath: string): Promise<TeapotEvent[]> {
  const out: TeapotEvent[] = [];
  const identity = sessionIdentityOf(filePath);
  try {
    const [{ createReadStream }, { createInterface }] = await Promise.all([
      import("node:fs"),
      import("node:readline"),
    ]);
    const rl = createInterface({
      input: createReadStream(filePath, { encoding: "utf8" }),
      crlfDelay: Infinity,
    });
    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        out.push(decorate(JSON.parse(line) as LogEvent, identity));
      } catch {
      }
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * A bounded page of the log, read by streaming — nothing is retained after the call.
 *
 * The whole-file cache this replaces held every parsed event of every session the UI had opened: MEASURED on the
 * operator's data, two sessions of ~100k events each retained **221MB of heap** for a page the UI shows 400 rows of.
 * `readEventsTail` already answers the newest page and the `after=` catch-up from the end of the file, so the only
 * remaining readers are "the page before this id" (scrolling up) and the branch filter; both are answered here with a
 * ring buffer of `limit` events, so the memory cost is the page, not the session.
 */
export async function readEventsWindow(
  filePath: string,
  opts: { before?: string | undefined; after?: string | undefined; limit: number; branch?: string | undefined },
): Promise<{ events: TeapotEvent[]; total: number; found: boolean }> {
  const limit = Math.max(0, opts.limit);
  const empty = { events: [] as TeapotEvent[], total: 0, found: false };
  if (limit <= 0) return empty;
  const accept = (e: TeapotEvent) => !opts.branch || e.branch === opts.branch;
  const ring: TeapotEvent[] = [];
  const push = (e: TeapotEvent) => {
    ring.push(e);
    if (ring.length > limit) ring.shift();
  };
  try {
    const [{ createReadStream }, { createInterface }] = await Promise.all([
      import("node:fs"),
      import("node:readline"),
    ]);
    const rl = createInterface({
      input: createReadStream(filePath, { encoding: "utf8" }),
      crlfDelay: Infinity,
    });
    const identity = sessionIdentityOf(filePath);
    let seen = 0;
    let collecting = opts.after === undefined;
    let found = opts.after === undefined;
    for await (const line of rl) {
      if (!line.trim()) continue;
      let e: TeapotEvent;
      try {
        e = decorate(JSON.parse(line) as LogEvent, identity);
      } catch {
        continue;
      }
      if (!accept(e)) continue;
      if (!collecting) {
        if (e.id === opts.after) {
          collecting = true;
          found = true;
          seen++;
          continue;
        }
        seen++;
        continue;
      }
      if (opts.before !== undefined && e.id === opts.before) {
        return { events: ring.slice(-limit), total: seen, found: true };
      }
      push(e);
      seen++;
      if (opts.after !== undefined && ring.length >= limit) {
        // the count still has to be complete: `total` drives the client's "is there more history" decision
        for await (const rest of rl) {
          if (!rest.trim()) continue;
          try {
            if (accept(JSON.parse(rest) as TeapotEvent)) seen++;
          } catch {}
        }
        return { events: ring.slice(-limit), total: seen, found };
      }
    }
    return { events: opts.before !== undefined ? [] : ring.slice(-limit), total: seen, found };
  } catch {
    return empty;
  }
}

/** Branch counts without holding the log: the endpoint only needs `{branch, events}` pairs. */
export async function branchCounts(
  filePath: string,
): Promise<Map<string, { events: number; forkedFrom?: unknown }>> {
  const out = new Map<string, { events: number; forkedFrom?: unknown }>();
  try {
    const [{ createReadStream }, { createInterface }] = await Promise.all([
      import("node:fs"),
      import("node:readline"),
    ]);
    const rl = createInterface({
      input: createReadStream(filePath, { encoding: "utf8" }),
      crlfDelay: Infinity,
    });
    const identity = sessionIdentityOf(filePath);
    for await (const line of rl) {
      if (!line.trim()) continue;
      let e: TeapotEvent;
      try {
        e = decorate(JSON.parse(line) as LogEvent, identity);
      } catch {
        continue;
      }
      const b = out.get(e.branch) ?? { events: 0 };
      b.events++;
      if (e.type === "fork") {
        const created = String((e.data as { newBranch?: string } | undefined)?.newBranch ?? "");
        if (created && created !== e.branch) {
          const nb = out.get(created) ?? { events: 0 };
          nb.forkedFrom = e.data;
          out.set(created, nb);
          b.events--;
          if (b.events > 0) out.set(e.branch, b);
          else out.delete(e.branch);
          continue;
        }
        b.forkedFrom = e.data;
      }
      out.set(e.branch, b);
    }
    return out;
  } catch {
    return out;
  }
}

const TAIL_MIN_BYTES = 64 * 1024;

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

    let want = Math.min(st.size, Math.max(TAIL_MIN_BYTES, limit * 512));
    for (;;) {
      const r = await readWindow(fh, st.size, want, sessionIdentityOf(filePath));
      if (r.events.length >= limit || want >= st.size) {
        return {
          events: r.events.slice(-limit),
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

async function readWindow(
  fh: import("node:fs/promises").FileHandle,
  size: number,
  bytes: number,
  identity: { session: string; agent: string },
): Promise<{ events: TeapotEvent[]; bytes: number }> {
  const start = Math.max(0, size - bytes);
  const buf = Buffer.alloc(size - start);
  if (buf.length) await fh.read(buf, 0, buf.length, start);
  const text = buf.toString("utf8");
  const nl = text.indexOf("\n");
  const body = start > 0 ? (nl === -1 ? "" : text.slice(nl + 1)) : text;
  const events: TeapotEvent[] = [];
  for (const line of body.split("\n")) {
    if (!line.trim()) continue;
    try {
      events.push(decorate(JSON.parse(line) as LogEvent, identity));
    } catch {
    }
  }
  return { events, bytes: buf.length };
}

export function filterByBranch(
  events: readonly TeapotEvent[],
  branch: string,
  includeInherited = false,
): TeapotEvent[] {
  if (!includeInherited) return events.filter((e) => e.branch === branch);
  const byId = new Map(events.map((e) => [e.id, e]));
  const wanted = new Set<string>();
  const queue: string[] = [];
  for (const e of events) {
    if (e.branch !== branch) continue;
    if (wanted.has(e.id)) continue;
    wanted.add(e.id);
    queue.push(e.id);
  }
  while (queue.length) {
    const cur = byId.get(queue.pop()!);
    if (cur?.parent && !wanted.has(cur.parent)) {
      wanted.add(cur.parent);
      queue.push(cur.parent);
    }
  }
  return events.filter((e) => wanted.has(e.id));
}
