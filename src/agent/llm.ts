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
  usage?: { inputTokens?: number; outputTokens?: number };
}

const clients = new WeakMap<LlmConfig, OpenAI>();

function client(cfg: LlmConfig): OpenAI {
  let c = clients.get(cfg);
  if (!c) {
    c = new OpenAI({
      baseURL: cfg.baseUrl,
      apiKey: cfg.apiKey,
      timeout: cfg.timeoutMs ?? 120_000,
      maxRetries: 4, // SDK handles backoff for 429/5xx/network errors
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
) => Promise<LlmResult>;

/**
 * Providers are picky in different ways; the common denominator is that
 * empty text content in user/assistant messages makes many of them 400.
 * Fill blanks with a harmless placeholder before sending.
 */
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
    const calls = rm.tool_calls as
      | { id?: string; function?: { name?: string; arguments?: string } }[]
      | undefined;
    if (calls?.length) {
      message.tool_calls = calls.map((c, i) => ({
        id: c.id ?? `call_${i}`,
        type: "function" as const,
        function: { name: c.function?.name ?? "", arguments: c.function?.arguments ?? "{}" },
      }));
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
    return {
      message,
      usage: res.usage
        ? { inputTokens: res.usage.prompt_tokens, outputTokens: res.usage.completion_tokens }
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
