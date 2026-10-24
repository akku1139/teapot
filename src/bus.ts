import { EventEmitter } from "node:events";

/** Tiny process-wide pub/sub used to push updates to SSE clients (no polling). */
export const bus = new EventEmitter();
bus.setMaxListeners(1000); // one per connected client (WS + SSE) — headroom for busy LAN setups

export type BusEvent =
  | { kind: "agent-update"; agentId: string }
  | { kind: "compaction-progress"; agentId: string; phase: string; summarized?: number }
  // #146: `sessionId` is REQUIRED, not optional. The live bubble is rendered
  // inside a session-scoped timeline, and an agent can have several sessions — so
  // an agent id alone cannot say which timeline a stream belongs to. That is how
  // a historical session ends up showing the current session's text and cursor
  // (#40). Optional would silently keep the bug: every emitter would still
  // compile.
  | { kind: "llm-delta"; agentId: string; sessionId: string; text: string; reasoning: string }
  | { kind: "event"; agentId: string; event: unknown }
  /**
   * Server-wide state the UI used to POLL for (`/api/metrics`, `/api/tasks` on a 30s timer).
   *
   * The frontend's whole state is meant to arrive over the socket; an HTTP GET is the recovery path
   * (a tab waking after a long sleep), not a heartbeat. Polling the same endpoints forever is the one
   * shape that cannot notice it is redundant.
   *
   * `metrics` is small and changes continuously (uptime, RSS), so it rides a timer; `tasks` only
   * changes when a schedule or a run does, so it is pushed when that happens.
   */
  | { kind: "metrics"; metrics: unknown }
  | { kind: "tasks"; tasks: unknown };
