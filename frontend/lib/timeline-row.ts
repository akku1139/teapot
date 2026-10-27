import { truncate } from "./format.ts";
import { mcpToolLabel } from "./mcp-tool-label.ts";

export interface Ev {
  id: string; seq: number; ts: string; session: string; branch: string;
  type: string; parent: string | null; data: any;
}

export const AUTHORS: Record<string, { name: string; icon: string; color: string }> = {
  prompt: { name: "you", icon: "🟧", color: "#faa81a" },
  user: { name: "you", icon: "🟧", color: "#faa81a" },
  message: { name: "agent", icon: "🫖", color: "#5865f2" },
  progress: { name: "progress", icon: "📈", color: "#3ba55d" },
  question: { name: "agent", icon: "❓️", color: "#5865f2" }, 
};

export const HARNESS_AUTH = { name: "harness", icon: "📣", color: "#3ba55d" };

export const AUTHOR_TONES = ["you", "agent", "progress", "harness", "tool"] as const;
export type AuthorTone = (typeof AUTHOR_TONES)[number];

const TONE_OF: Record<string, AuthorTone> = {
  "#faa81a": "you",
  "#5865f2": "agent",
  "#3ba55d": "progress",
  "#3ba0c9": "tool",
};

export const toneOf = (color: string): AuthorTone => TONE_OF[color] ?? "agent";

export const authorOf = (e: Ev) => {
  if (e.data?.actor) return { name: `@${String(e.data.actor)}`, icon: "🧩", color: "#3ba0c9" };
  if (e.type === "tool_call" || e.type === "tool_result") {
    const name = String(e.data?.name ?? "tool");
    /**
     * A `run_tool` row is credited to the MCP tool it ran, not to the dispatcher.
     *
     * "run_tool をactor名に表示するんじゃなくて、MCPサーバーのツール名を表示する" — `run_tool` says
     * nothing about what happened; `Ghidra/get_xrefs_to` says everything. The id is the model's own
     * string, so it is parsed rather than trusted to have one spelling.
     */
    if (name === "run_tool") {
      const label = mcpToolLabel(e.data?.args?.tool_id);
      if (label) return { name: label, icon: "⚙️", color: "#3ba0c9" };
    }
    /**
     * …and a DIRECT MCP call is credited the same way.
     *
     * `mcp__Ghidra__disassemble_function` is the flat name the request uses; the operator should read
     * `Ghidra/disassemble_function`, identical to what the deferred route shows for the same tool. Two
     * spellings for one thing is the drift this helper exists to stop.
     *
     * Same pattern the card renderer uses, so a server whose own name contains `_` splits the same way
     * in both places.
     */
    const direct = /^mcp__([^_]+(?:_[^_]+)*)__(.+)$/.exec(name);
    if (direct) return { name: `${direct[1]!}/${direct[2]!}`, icon: "⚙️", color: "#3ba0c9" };
    return { name, icon: "⚙️", color: "#3ba0c9" };
  }
  if (e.type === "prompt") {
    const src = String(e.data?.source ?? "user");
    if (src === "user") return AUTHORS.prompt;
    return src.startsWith("scheduler:") ? { name: src.slice(10), icon: "📣", color: "#3ba55d" } : HARNESS_AUTH;
  }
  return AUTHORS[e.type] ?? { name: e.type, icon: "•", color: "#9298a5" };
};

export const fmtTs = (iso: string) => {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

export function rawOf(e: Ev): string {
  const d = e.data ?? {};
  if (e.type === "prompt") return String(d.text ?? "");
  if (e.type === "message") {
    const r = typeof d.reasoning === "string" && d.reasoning.trim()
      ? `<reasoning>\n${d.reasoning}\n</reasoning>\n\n`
      : "";
    return `${r}${String(d.content ?? "")}`;
  }
  if (e.type === "tool_call") {
    return "";
  }
  return "";
}

export function fmtK(n: number): string {
  if (n >= 1e9) return `${+(n / 1e9).toFixed(1)}b`;
  if (n >= 1e6) return `${+(n / 1e6).toFixed(1)}m`;
  if (n >= 10_000) return `${Math.round(n / 1000)}k`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

export function oneLine(s: string, n: number): string {
  const line = s.replace(/\s+/g, " ").trim();
  return truncate(line, n);
}
