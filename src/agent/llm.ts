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

export async function chat(
  cfg: LlmConfig,
  messages: ChatMessage[],
  tools: ToolSpec[],
): Promise<LlmResult> {
  const res = await client(cfg).chat.completions.create({
    model: cfg.model,
    messages: messages as unknown as OpenAI.Chat.Completions.ChatCompletionMessageParam[],
    ...(tools.length ? { tools } : {}),
  });
  const message = res.choices?.[0]?.message as unknown as ChatMessage | undefined;
  if (!message) throw new Error("LLM API returned no choices");
  return {
    message,
    usage: res.usage
      ? { inputTokens: res.usage.prompt_tokens, outputTokens: res.usage.completion_tokens }
      : undefined,
  };
}
