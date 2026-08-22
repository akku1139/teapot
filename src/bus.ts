import { EventEmitter } from "node:events";

/** Tiny process-wide pub/sub used to push updates to SSE clients (no polling). */
export const bus = new EventEmitter();
bus.setMaxListeners(100);

export type BusEvent =
  | { kind: "agent-update"; agentId: string }
  | { kind: "llm-delta"; agentId: string; text: string; reasoning: string }
  | { kind: "event"; agentId: string; event: unknown };
