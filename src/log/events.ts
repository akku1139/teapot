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
  | "sub"; // mirrored child activity in the parent feed: data:{sub, type, data}

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
        if (!this.stream) return resolve(evt);
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
