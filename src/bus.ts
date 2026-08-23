import { EventEmitter } from "node:events";

/** Tiny process-wide pub/sub used to push updates to SSE clients (no polling). */
export const bus = new EventEmitter();
bus.setMaxListeners(1000); // one per connected client (WS + SSE) — headroom for busy LAN setups

export type BusEvent =
  | { kind: "agent-update"; agentId: string }
  | { kind: "llm-delta"; agentId: string; text: string; reasoning: string }
  | { kind: "event"; agentId: string; event: unknown };
