import { EventEmitter } from "node:events";

export const bus = new EventEmitter();
bus.setMaxListeners(1000); 

export type BusEvent =
  | { kind: "agent-update"; agentId: string }
  | { kind: "compaction-progress"; agentId: string; phase: string; summarized?: number }
  | { kind: "llm-delta"; agentId: string; sessionId: string; text: string; reasoning: string }
  | { kind: "event"; agentId: string; event: unknown }
  | { kind: "metrics"; metrics: unknown }
  | { kind: "tasks"; tasks: unknown }
  /** a pty the UI still has a tab for is gone — the tab must not dangle forever (#219) */
  | { kind: "terminal-closed"; terminalId: string; reason: "idle" | "exited" | "requested" }
  /**
   * The SHELL said what it wants to be called (OSC 0/2), so the tab can be renamed without polling (#238).
   *
   * Pushed only when the text changes, which is a few times per session of real work — compare it with asking the server
   * for the whole terminal list every two seconds just to notice a `cd`.
   */
  | { kind: "terminal-title"; agentId: string; terminalId: string; title: string; cwd: string };
