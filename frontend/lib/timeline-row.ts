import { truncate } from "./format";

export interface Ev {
  id: string; seq: number; ts: string; session: string; branch: string;
  type: string; parent: string | null; data: any;
}

export const AUTHORS: Record<string, { name: string; icon: string; color: string }> = {
  prompt: { name: "you", icon: "🟧", color: "#faa81a" },
  user: { name: "you", icon: "🟧", color: "#faa81a" },
  message: { name: "agent", icon: "🫖", color: "#5865f2" },
  progress: { name: "progress", icon: "📈", color: "#3ba55d" },
  question: { name: "agent", icon: "❓️", color: "#5865f2" }, // ask_user comes from the agent too
};

export const HARNESS_AUTH = { name: "harness", icon: "📣", color: "#3ba55d" };

export const authorOf = (e: Ev) => {
  if (e.data?.actor) return { name: `@${String(e.data.actor)}`, icon: "🧩", color: "#3ba0c9" };
  if (e.type === "tool_call" || e.type === "tool_result")
    return { name: String(e.data?.name ?? "tool"), icon: "⚙️", color: "#3ba0c9" };
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
    // include reasoning when present, separated, so nothing is lost
    const r = typeof d.reasoning === "string" && d.reasoning.trim()
      ? `<reasoning>\n${d.reasoning}\n</reasoning>\n\n`
      : "";
    return `${r}${String(d.content ?? "")}`;
  }
  if (e.type === "tool_call") {
    // the header copy button used to sit on tool rows too and copied ""
    // (rawOf only knew prompts/messages) — tool rows get dedicated
    // command/output buttons inside ToolRow instead, so nothing here
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
