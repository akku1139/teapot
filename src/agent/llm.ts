import OpenAI from "openai";
import { providerHeaders } from "./provider-headers.ts";

export { providerHeaders };
import { isRateLimitStatus, nextKey, type KeyPoolState } from "./key-pool.ts";

export interface ToolSpec {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface ContentPart {
  type: "text" | "image_url";
  text?: string;
  image_url?: { url: string }; 
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  content_parts?: ContentPart[];
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}

export interface LlmConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs?: number;
  sessionId?: string;
  reasoningEffort?: string;
  supportedParameters?: string[];
  supportedEfforts?: string[];
  oneOff?: boolean;
  maxRetries?: number;
  keyPool?: KeyPoolState;
}

export interface LlmResult {
  message: ChatMessage;
  reasoning?: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    cachedInputTokens?: number;
  };
}

const clients = new WeakMap<LlmConfig, OpenAI>();

export function rotateKey(cfg: LlmConfig): LlmConfig | null {
  const pool = cfg.keyPool;
  if (!pool) return null;
  const next = nextKey(pool);
  if (!next) return null; 
  return { ...cfg, apiKey: next };
}

export function effortForRequest(
  cfg: LlmConfig,
  supported: string[] | undefined = cfg.supportedParameters,
): { reasoning_effort?: Effort } {
  const e = cfg.reasoningEffort;
  if (!e || !(REASONING_EFFORTS as readonly string[]).includes(e)) return {};
  if (supported && !supported.includes("reasoning_effort")) return {};
  const clamped = clampEffort(e, cfg.supportedEfforts);
  if (!(EFFORT_LADDER as readonly string[]).includes(clamped)) return {};
  return { reasoning_effort: clamped as Effort };
}

export function isEffortUnsupported(err: unknown): boolean {
  const msg = String((err as { message?: unknown })?.message ?? err ?? "");
  if (!/reasoning_effort|thinking level|effort/i.test(msg)) return false;
  return /not supported|unsupported|unknown (parameter|field)|invalid/i.test(msg);
}

export function effortChoosable(supported: string[] | undefined): boolean {
  if (!supported) return true; 
  return supported.includes("reasoning_effort");
}

export function isOpenRouterEndpoint(baseUrl: string | undefined): boolean {
  try {
    return /(^|\.)openrouter\.ai$/i.test(new URL(String(baseUrl ?? "")).host);
  } catch {
    return false;
  }
}

export function cacheControlForRequest(cfg: LlmConfig): { prompt_cache_retention?: "24h" } {
  if (!cfg.oneOff) return {};
  if (!isOpenRouterEndpoint(cfg.baseUrl)) return {};
  return { prompt_cache_retention: "24h" };
}

const REASONING_EFFORTS = ["minimal", "low", "medium", "high"] as const;
type Effort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

const EFFORT_LADDER = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export function clampEffort(requested: string, supported: readonly string[] | undefined): string {
  if (!requested || !supported?.length) return requested;
  const norm = supported.map((s) => String(s).toLowerCase());
  if (norm.includes(requested)) return requested;
  const reqIdx = (EFFORT_LADDER as readonly string[]).indexOf(requested);
  if (reqIdx < 0) return requested; 
  const candidates = norm.filter((l) => l !== "none" && (EFFORT_LADDER as readonly string[]).includes(l));
  if (!candidates.length) return requested;
  const weaker = candidates.filter((l) => (EFFORT_LADDER as readonly string[]).indexOf(l) < reqIdx);
  if (weaker.length) {
    return weaker.reduce((best, l) =>
      (EFFORT_LADDER as readonly string[]).indexOf(l) > (EFFORT_LADDER as readonly string[]).indexOf(best) ? l : best,
    );
  }
  return candidates.reduce((best, l) =>
    (EFFORT_LADDER as readonly string[]).indexOf(l) < (EFFORT_LADDER as readonly string[]).indexOf(best) ? l : best,
  );
}

function client(cfg: LlmConfig): OpenAI {
  let c = clients.get(cfg);
  if (!c) {
    c = new OpenAI({
      baseURL: cfg.baseUrl,
      apiKey: cfg.apiKey,
      timeout: cfg.timeoutMs ?? 120_000,
      maxRetries: cfg.maxRetries ?? 4, 
      defaultHeaders: providerHeaders(cfg.baseUrl, cfg.sessionId),
    });
    clients.set(cfg, c);
  }
  return c;
}

async function withKeyRotation<T>(
  cfg: LlmConfig,
  run: (cfg: LlmConfig) => Promise<T>,
): Promise<{ value: T; cfg: LlmConfig }> {
  let cur = cfg;
  let lastErr: unknown;
  for (let i = 0; i < Math.max(1, cfg.keyPool?.keys.length ?? 1); i++) {
    try {
      return { value: await run(cur), cfg: cur };
    } catch (err) {
      lastErr = err;
      const status = (err as { status?: unknown })?.status;
      if (typeof status !== "number" || !isRateLimitStatus(status)) throw err;
      const rotated = rotateKey(cur);
      if (!rotated) throw err;
      console.warn(
        `[teapot] rate limited (HTTP ${status}) on this key — moving to the next of ${cur.keyPool?.keys.length ?? 1} for this provider`,
      );
      cur = rotated;
    }
  }
  throw lastErr;
}

export type ChatFn = (
  cfg: LlmConfig,
  messages: ChatMessage[],
  tools: ToolSpec[],
  signal?: AbortSignal,
  onDelta?: (snap: { text: string; reasoning: string }) => void,
) => Promise<LlmResult>;

function repairMangledToolName(raw: string): { id?: string; name: string; arguments: string }[] {
  const calls: { id?: string; name: string; arguments: string }[] = [];
  const tagRe = /([a-zA-Z_][\w.]*)<\/tool_call>|<tool_call>\s*<?([a-zA-Z_][\w.]*)?/g;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(raw))) {
    const name = m[1] ?? m[2];
    if (name && !calls.some((c) => c.name === name)) calls.push({ name, arguments: "{}" });
  }
  if (calls.length) return calls;
  const parts = raw.split(/[\ufffd]+/).filter((p) => /^[a-zA-Z_][\w.]*$/.test(p));
  for (const p of parts) calls.push({ name: p, arguments: "{}" });
  return calls;
}

function looksMangled(name: string): boolean {
  return !name || /[\ufffd<>]/.test(name) || /<tool_call>|<\/tool/.test(name);
}

export function repairToolPairing(messages: ChatMessage[]): ChatMessage[] {
  const callOrder = new Map<string, number>();
  for (const m of messages) for (const t of m.tool_calls ?? []) if (t.id && !callOrder.has(t.id)) callOrder.set(t.id, callOrder.size);

  const seen = new Set<string>();
  let ok = true;
  for (const m of messages) {
    if (m.role === "tool") {
      const id = m.tool_call_id;
      if (!id || !callOrder.has(id) || seen.has(id)) ok = false;
      else seen.add(id);
      continue;
    }
    for (const t of m.tool_calls ?? []) if (t.id && seen.has(t.id)) ok = false;
  }
  if (ok && seen.size === callOrder.size) return messages;

  const out: ChatMessage[] = [];
  const answered = new Set<string>();
  for (const m of messages) {
    if (m.role !== "tool") {
      out.push(m);
      continue;
    }
    const id = m.tool_call_id;
    if (!id || !callOrder.has(id) || answered.has(id)) continue; 
    if (!issuedBefore(messages, m)) continue; 
    answered.add(id);
    out.push(m);
  }
  const filled: ChatMessage[] = [];
  for (const m of out) {
    filled.push(m);
    for (const t of m.tool_calls ?? []) {
      if (!t.id || answered.has(t.id)) continue;
      filled.push({
        role: "tool",
        tool_call_id: t.id,
        content: "(not completed — the tool did not run)",
      });
    }
  }
  let first = 0;
  while (first < filled.length && filled[first]!.role === "tool") first++;
  return first ? filled.slice(first) : filled;
}

function issuedBefore(messages: ChatMessage[], result: ChatMessage): boolean {
  for (const m of messages) {
    if (m === result) return false;
    if ((m.tool_calls ?? []).some((t) => t.id === result.tool_call_id)) return true;
  }
  return false;
}

function sanitize(messages: ChatMessage[]): Record<string, unknown>[] {
  return repairToolPairing(messages).map((m): Record<string, unknown> => {
    if (m.content_parts?.length) {
      const parts = m.content_parts.map((p) =>
        p.type === "image_url"
          ? { type: "image_url" as const, image_url: { url: p.image_url!.url } }
          : { type: "text" as const, text: p.text ?? "" },
      );
      return { role: m.role, content: parts };
    }
    if ((m.role === "user" || m.role === "assistant") && !m.content) {
      return { ...m, content: m.tool_calls?.length ? "(tool call)" : "(no content)" };
    }
    if (m.role === "tool" && typeof m.content !== "string") {
      return { ...m, content: String(m.content ?? "(no output)") };
    }
    return { ...m };
  });
}

function reasoningTextOf(m: Record<string, unknown> | undefined): string | undefined {
  for (const key of ["reasoning", "reasoning_content"]) {
    const v = m?.[key];
    if (typeof v === "string" && v) return v;
  }
  return undefined;
}

function noChoicesDetail(res: unknown): string {
  const base = "LLM API returned no choices";
  const err = (res as { error?: { message?: unknown; type?: unknown; code?: unknown } })?.error;
  if (err && typeof err === "object") {
    const msg = typeof err.message === "string" ? err.message : JSON.stringify(err);
    const code = err.code ?? err.type;
    return `${base}: provider returned an error in a 200 response${
      code ? ` (${String(code)})` : ""
    } — ${String(msg).slice(0, 300)}`;
  }
  if (typeof res === "string") {
    const head = res.slice(0, 160).replace(/\s+/g, " ").trim();
    return `${base}: response was not a completion object (${res.length} bytes of ${
      res.trimStart().startsWith("data:") || res.trimStart().startsWith("event:") ? "SSE" : "text"
    })${head ? ` — ${head}` : ""}`;
  }
  const choices = (res as { choices?: unknown[] })?.choices;
  if (Array.isArray(choices)) {
    const first = choices[0] as { message?: unknown; delta?: unknown; finish_reason?: unknown } | undefined;
    if (!first) return `${base}: the provider returned an empty choices array (0 candidates)`;
    if (first.delta && !first.message) {
      return `${base}: the provider returned a streaming delta on a non-streaming request (finish_reason=${String(
        first.finish_reason,
      )})`;
    }
    if (first.message === null) {
      return `${base}: the provider returned a choice with a null message (finish_reason=${String(
        first.finish_reason,
      )})`;
    }
    return `${base}: the provider returned a choice with no message field (finish_reason=${String(
      first.finish_reason,
    )})`;
  }
  return `${base}: the response had no choices array (${safeShape(res)})`;
}

function safeShape(res: unknown): string {
  try {
    const o = res as Record<string, unknown> | null;
    if (!o || typeof o !== "object") return `got ${typeof res}`;
    return `keys: ${Object.keys(o).slice(0, 8).join(", ") || "(none)"}`;
  } catch {
    return "unreadable response";
  }
}

const STREAM_REJECTED_STATUS = new Set([400, 404, 405, 406, 415, 422, 501]);

export async function chat(
  cfg: LlmConfig,
  messages: ChatMessage[],
  tools: ToolSpec[],
  signal?: AbortSignal,
  onDelta?: (snap: { text: string; reasoning: string }) => void,
): Promise<LlmResult> {
  try {
    const { value: res } = await withKeyRotation(cfg, (c) =>
      client(c).chat.completions.create(
        {
          model: c.model,
          messages: sanitize(messages) as unknown as OpenAI.Chat.Completions.ChatCompletionMessageParam[],
          ...(tools.length ? { tools } : {}),
          ...effortForRequest(c),
          ...cacheControlForRequest(c),
        },
        { signal },
      ),
    );
    const raw = res?.choices?.[0];
    const rm = raw?.message as unknown as Record<string, unknown> | undefined;
    if (!rm) throw new Error(noChoicesDetail(res));
    const message: ChatMessage = {
      role: "assistant",
      content: typeof rm.content === "string" ? rm.content : "",
    };
    const reasoning = reasoningTextOf(rm);
    const calls = rm.tool_calls as
      | { id?: string; function?: { name?: string; arguments?: string } }[]
      | undefined;
    if (calls?.length) {
      message.tool_calls = calls.flatMap((c, i) => {
        const name = c.function?.name ?? "";
        if (looksMangled(name)) {
          const repaired = repairMangledToolName(name);
          if (repaired.length)
            return repaired.map((r, k) => ({
              id: `${c.id ?? `call_${i}`}_${k}`,
              type: "function" as const,
              function: { name: r.name, arguments: r.arguments },
            }));
          return []; 
        }
        return [{
          id: c.id ?? `call_${i}`,
          type: "function" as const,
          function: { name, arguments: c.function?.arguments ?? "{}" },
        }];
      });
    }
    const finishReason = (raw as { finish_reason?: string } | undefined)?.finish_reason;
    if (finishReason === "error") {
      throw new Error("LLM API error: provider returned an errored completion");
    }
    if (!message.content && !message.tool_calls) {
      throw new Error("LLM API error: empty completion");
    }
    onDelta?.({ text: message.content ?? "", reasoning: reasoning ?? "" });
    return {
      message,
      reasoning,
      usage: res.usage
        ? {
            inputTokens: res.usage.prompt_tokens,
            outputTokens: res.usage.completion_tokens,
            cachedInputTokens:
              (res.usage as { prompt_tokens_details?: { cached_tokens?: number | null } })
                .prompt_tokens_details?.cached_tokens ?? undefined,
          }
        : undefined,
    };
  } catch (err) {
    if (!signal?.aborted && isEffortUnsupported(err) && effortForRequest(cfg).reasoning_effort) {
      return chat({ ...cfg, reasoningEffort: "" }, messages, tools, signal);
    }
    const e = err as { status?: number; message?: string; error?: { message?: string } };
    if (String((err as Error).message ?? "").startsWith("LLM API returned no choices")) throw err;
    if (e.status === undefined && !String((err as Error).message).includes("provider returned"))
      throw err; 
    const detail = e.error?.message ?? e.message ?? "unknown provider error";
    throw new Error(`LLM API error ${e.status ?? "?"}: ${String(detail).slice(0, 500)}`);
  }
}

export async function chatStream(
  cfg: LlmConfig,
  messages: ChatMessage[],
  tools: ToolSpec[],
  signal?: AbortSignal,
  onDelta?: (snap: { text: string; reasoning: string }) => void,
): Promise<LlmResult> {
  let gotChunk = false;
  let text = "";
  let reasoning = "";
  try {
    const { value: stream } = await withKeyRotation(cfg, (c) =>
      client(c).chat.completions.create(
        {
          model: c.model,
          messages: sanitize(messages) as unknown as OpenAI.Chat.Completions.ChatCompletionMessageParam[],
          ...(tools.length ? { tools } : {}),
          ...effortForRequest(c),
          ...cacheControlForRequest(c),
          stream: true,
          stream_options: { include_usage: true },
        },
        { signal },
      ),
    );
    const calls: Record<number, { id: string; name: string; args: string }> = {};
    let finishReason: string | undefined;
    let usage: LlmResult["usage"];

    for await (const chunk of stream) {
      gotChunk = true;
      const ch = chunk as unknown as {
        choices?: {
          delta?: {
            content?: string | null;
            reasoning?: string | null;
            tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[];
          };
          finish_reason?: string | null;
        }[];
        usage?: {
          prompt_tokens?: number;
          completion_tokens?: number;
          prompt_tokens_details?: { cached_tokens?: number | null } | null;
        } | null;
      };
      const c = ch.choices?.[0];
      const d = c?.delta;
      if (d?.content) text += d.content;
      reasoning += reasoningTextOf(d as Record<string, unknown> | undefined) ?? "";
      for (const tc of d?.tool_calls ?? []) {
        const i = tc.index ?? 0;
        calls[i] ??= { id: "", name: "", args: "" };
        if (tc.id) calls[i].id = tc.id;
        if (tc.function?.name) calls[i].name += tc.function.name;
        if (tc.function?.arguments) calls[i].args += tc.function.arguments;
      }
      if (c?.finish_reason) finishReason = c.finish_reason;
      if (ch.usage)
        usage = {
          inputTokens: ch.usage.prompt_tokens,
          outputTokens: ch.usage.completion_tokens,
          cachedInputTokens: ch.usage.prompt_tokens_details?.cached_tokens ?? undefined,
        };
      if (onDelta) onDelta({ text, reasoning });
    }

    if (finishReason === "error")
      throw new Error("LLM API error: provider returned an errored completion");
    const message: ChatMessage = { role: "assistant", content: text };
    const list = Object.keys(calls)
      .map(Number)
      .sort((a, b) => a - b)
      .map((i) => calls[i]!);
    if (list.length)
      message.tool_calls = list.flatMap((c, i) => {
        if (looksMangled(c.name)) {
          const repaired = repairMangledToolName(c.name);
          if (repaired.length)
            return repaired.map((r, k) => ({
              id: `${c.id || `call_${i}`}_${k}`,
              type: "function" as const,
              function: { name: r.name, arguments: r.arguments },
            }));
          return [];
        }
        return [{
          id: c.id || `call_${i}`,
          type: "function" as const,
          function: { name: c.name, arguments: c.args || "{}" },
        }];
      });
    if (!message.content && !message.tool_calls) {
      const e = new Error("LLM API error: empty completion") as Error & { emptyStream?: boolean };
      e.emptyStream = true;
      throw e;
    }
    return { message, reasoning: reasoning || undefined, usage };
  } catch (err) {
    const status = (err as { status?: unknown })?.status;
    if (!signal?.aborted && isEffortUnsupported(err) && effortForRequest(cfg).reasoning_effort) {
      return chatStream({ ...cfg, reasoningEffort: "" }, messages, tools, signal, onDelta);
    }
    const rejectedByProvider =
      typeof status === "number" && STREAM_REJECTED_STATUS.has(status);
    const emptyStream = (err as { emptyStream?: boolean })?.emptyStream === true;
    if (!gotChunk && !signal?.aborted && (rejectedByProvider || emptyStream)) {
      return chat(cfg, messages, tools, signal, onDelta);
    }
    if (signal?.aborted && (text || reasoning)) {
      (err as { partial?: unknown }).partial = { text, reasoning };
    }
    throw err;
  }
}
