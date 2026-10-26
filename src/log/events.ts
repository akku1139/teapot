import { createWriteStream, WriteStream } from "node:fs";
import { mkdirSync } from "node:fs";
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
          const e = JSON.parse(line) as TeapotEvent;
          if (typeof e.seq === "number" && e.seq > this.seq) this.seq = e.seq;
          this.lastByBranch.set(e.branch, e.id);
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
    let written = false;
    const p = new Promise<TeapotEvent>((resolve, reject) => {
      this.chain = this.chain.then(() => {
        if (this.disposed) {
          console.error(`[teapot] event dropped after log close (${this.agentId}): ${type}`);
          return resolve(evt);
        }
        this.openStream().write(JSON.stringify(evt) + "\n", "utf8", (err) => {
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

export async function readEvents(filePath: string): Promise<TeapotEvent[]> {
  try {
    const { readFile } = await import("node:fs/promises");
    const out: TeapotEvent[] = [];
    for (const line of (await readFile(filePath, "utf8")).split("\n")) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as TeapotEvent);
      } catch {
      }
    }
    return out;
  } catch {
    return [];
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
      const r = await readWindow(fh, st.size, want);
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
      events.push(JSON.parse(line) as TeapotEvent);
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
