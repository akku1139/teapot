/**
 * LLM access via the official `openai` npm client (OpenAI-compatible APIs:
 * OpenAI, OpenRouter, local vLLM/Ollama, ...).
 *
 * We deliberately delegate retries/timeouts/response-shape handling to the
 * SDK instead of hand-rolling them.
 */
import OpenAI from "openai";

export interface ToolSpec {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}

export interface LlmConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs?: number;
}

export interface LlmResult {
  message: ChatMessage;
  /** chain-of-thought text some providers attach; never sent back upstream */
  reasoning?: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    /** served from the provider's prompt cache — billed far cheaper */
    cachedInputTokens?: number;
  };
}

const clients = new WeakMap<LlmConfig, OpenAI>();

/**
 * OpenRouter app attribution (https://openrouter.ai/docs/app-attribution):
 * `HTTP-Referer` is the required identifier that puts teapot's usage on the
 * public rankings/analytics; the title names it; `programming-app` files it
 * under coding tools. Empty (harmless no-op) for every other provider.
 */
export function providerHeaders(baseUrl: string): Record<string, string> {
  try {
    const host = new URL(baseUrl).host;
    if (!/(^|\.)openrouter\.ai$/i.test(host)) return {};
    return {
      "HTTP-Referer": "https://github.com/akku1139/teapot",
      "X-OpenRouter-Title": "teapot",
      "X-OpenRouter-Categories": "programming-app",
    };
  } catch {
    return {}; // unparseable baseUrl — never block a request over metadata
  }
}

function client(cfg: LlmConfig): OpenAI {
  let c = clients.get(cfg);
  if (!c) {
    c = new OpenAI({
      baseURL: cfg.baseUrl,
      apiKey: cfg.apiKey,
      timeout: cfg.timeoutMs ?? 120_000,
      maxRetries: 4, // SDK handles backoff for 429/5xx/network errors
      defaultHeaders: providerHeaders(cfg.baseUrl),
    });
    clients.set(cfg, c);
  }
  return c;
}

export type ChatFn = (
  cfg: LlmConfig,
  messages: ChatMessage[],
  tools: ToolSpec[],
  signal?: AbortSignal,
  onDelta?: (snap: { text: string; reasoning: string }) => void,
) => Promise<LlmResult>;

/**
 * Providers are picky in different ways; the common denominator is that
 * empty text content in user/assistant messages makes many of them 400.
 * Fill blanks with a harmless placeholder before sending.
 */
/**
 * Providers occasionally glue MULTIPLE tool calls into one entry, or leak
 * their internal framing into the name field (seen live: a name of
 * `get_goal\uFFFD\uFFFDlist_dir` whose raw bytes were
 * `get_goal</tool_call><…><tool_call><…>`). Detect the tag boundaries and
 * split the blob back into individual calls so the round stays usable
 * instead of failing with "unknown tool".
 */
function repairMangledToolName(raw: string): { id?: string; name: string; arguments: string }[] {
  const calls: { id?: string; name: string; arguments: string }[] = [];
  // Form 1 — framing tags survived: <name></tool_call>[<id>…]<tool_call><name>
  const tagRe = /([a-zA-Z_][\w.]*)<\/tool_call>|<tool_call>\s*<?([a-zA-Z_][\w.]*)?/g;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(raw))) {
    const name = m[1] ?? m[2];
    if (name && !calls.some((c) => c.name === name)) calls.push({ name, arguments: "{}" });
  }
  if (calls.length) return calls;
  // Form 2 — tags were already destroyed into U+FFFD replacement chars:
  // "get_goal\uFFFD\uFFFDlist_dir" → split on the replacement runs
  const parts = raw.split(/[\ufffd]+/).filter((p) => /^[a-zA-Z_][\w.]*$/.test(p));
  for (const p of parts) calls.push({ name: p, arguments: "{}" });
  return calls;
}

/** true when a tool name can't possibly be one of ours (framing leaked in) */
function looksMangled(name: string): boolean {
  return !name || /[\ufffd<>]/.test(name) || /<tool_call>|<\/tool/.test(name);
}

function sanitize(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((m) => {
    if ((m.role === "user" || m.role === "assistant") && !m.content) {
      return { ...m, content: m.tool_calls?.length ? "(tool call)" : "(no content)" };
    }
    if (m.role === "tool" && typeof m.content !== "string") {
      return { ...m, content: String(m.content ?? "(no output)") };
    }
    return m;
  });
}

export async function chat(
  cfg: LlmConfig,
  messages: ChatMessage[],
  tools: ToolSpec[],
  signal?: AbortSignal,
  onDelta?: (snap: { text: string; reasoning: string }) => void,
): Promise<LlmResult> {
  try {
    const res = await client(cfg).chat.completions.create(
      {
        model: cfg.model,
        messages: sanitize(messages) as unknown as OpenAI.Chat.Completions.ChatCompletionMessageParam[],
        ...(tools.length ? { tools } : {}),
      },
      { signal },
    );
    const raw = res.choices?.[0];
    const rm = raw?.message as unknown as Record<string, unknown> | undefined;
    if (!rm) throw new Error("LLM API returned no choices");
    // normalize: providers attach extra fields (reasoning, refusal, ...) and
    // nullable content — keep only what our protocol understands
    const message: ChatMessage = {
      role: "assistant",
      content: typeof rm.content === "string" ? rm.content : "",
    };
    const reasoning = typeof rm.reasoning === "string" && rm.reasoning ? rm.reasoning : undefined;
    const calls = rm.tool_calls as
      | { id?: string; function?: { name?: string; arguments?: string } }[]
      | undefined;
    if (calls?.length) {
      message.tool_calls = calls.flatMap((c, i) => {
        const name = c.function?.name ?? "";
        // provider glued several calls together / leaked framing into the
        // name — split the blob back into real calls so the round survives
        if (looksMangled(name)) {
          const repaired = repairMangledToolName(name);
          if (repaired.length)
            return repaired.map((r, k) => ({
              id: `${c.id ?? `call_${i}`}_${k}`,
              type: "function" as const,
              function: { name: r.name, arguments: r.arguments },
            }));
          return []; // unsalvageable — drop rather than feed "unknown tool"
        }
        return [{
          id: c.id ?? `call_${i}`,
          type: "function" as const,
          function: { name, arguments: c.function?.arguments ?? "{}" },
        }];
      });
    }
    // some gateways answer 200 with finish_reason "error"; those tool calls /
    // text are often truncated garbage — discard the whole completion so the
    // caller retries cleanly instead of poisoning history
    const finishReason = (raw as { finish_reason?: string } | undefined)?.finish_reason;
    if (finishReason === "error") {
      throw new Error("LLM API error: provider returned an errored completion");
    }
    if (!message.content && !message.tool_calls) {
      throw new Error("LLM API error: empty completion");
    }
    // non-streaming fallback still feeds the UI one final snapshot
    onDelta?.({ text: message.content ?? "", reasoning: reasoning ?? "" });
    return {
      message,
      reasoning,
      usage: res.usage
        ? {
            inputTokens: res.usage.prompt_tokens,
            outputTokens: res.usage.completion_tokens,
            // OpenAI-compatible providers attach cache details here (OpenRouter included)
            cachedInputTokens:
              (res.usage as { prompt_tokens_details?: { cached_tokens?: number | null } })
                .prompt_tokens_details?.cached_tokens ?? undefined,
          }
        : undefined,
    };
  } catch (err) {
    const e = err as { status?: number; message?: string; error?: { message?: string } };
    if (e.status === undefined && !String((err as Error).message).includes("provider returned"))
      throw err; // not an API error (abort, bug, ...)
    const detail = e.error?.message ?? e.message ?? "unknown provider error";
    throw new Error(`LLM API error ${e.status ?? "?"}: ${String(detail).slice(0, 500)}`);
  }
}

/**
 * Streaming variant of chat(): same result shape, but calls onDelta with
 * cumulative {text, reasoning} snapshots as chunks arrive so the UI can show
 * the response live. Falls back to plain chat() once if the provider rejects
 * streaming before producing any chunk.
 */
export async function chatStream(
  cfg: LlmConfig,
  messages: ChatMessage[],
  tools: ToolSpec[],
  signal?: AbortSignal,
  onDelta?: (snap: { text: string; reasoning: string }) => void,
): Promise<LlmResult> {
  let gotChunk = false;
  // hoisted so the abort handler below can attach whatever streamed so far
  let text = "";
  let reasoning = "";
  try {
    const stream = await client(cfg).chat.completions.create(
      {
        model: cfg.model,
        messages: sanitize(messages) as unknown as OpenAI.Chat.Completions.ChatCompletionMessageParam[],
        ...(tools.length ? { tools } : {}),
        stream: true,
        // ask providers to include the final usage chunk in streaming mode
        // (OpenAI-compatible; harmless where unsupported)
        stream_options: { include_usage: true },
      },
      { signal },
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
      if (d?.reasoning) reasoning += d.reasoning;
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
    if (!message.content && !message.tool_calls)
      throw new Error("LLM API error: empty completion");
    return { message, reasoning: reasoning || undefined, usage };
  } catch (err) {
    // provider may not support streaming at all — one clean fallback
    if (!gotChunk && !signal?.aborted) return chat(cfg, messages, tools, signal, onDelta);
    // user interrupt: hand back whatever streamed so far so the harness can
    // keep the partial output visible instead of losing it
    if (signal?.aborted && (text || reasoning)) {
      (err as { partial?: unknown }).partial = { text, reasoning };
    }
    throw err;
  }
}
