import { EventEmitter } from "node:events";

export const bus = new EventEmitter();
bus.setMaxListeners(1000); 

export type BusEvent =
  | { kind: "agent-update"; agentId: string }
  | { kind: "compaction-progress"; agentId: string; phase: string; summarized?: number }
  | { kind: "llm-delta"; agentId: string; sessionId: string; text: string; reasoning: string }
  | { kind: "event"; agentId: string; event: unknown }
  | { kind: "metrics"; metrics: unknown }
  | { kind: "tasks"; tasks: unknown };
