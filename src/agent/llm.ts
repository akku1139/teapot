/**
 * LLM access via the official `openai` npm client (OpenAI-compatible APIs:
 * OpenAI, OpenRouter, local vLLM/Ollama, ...).
 *
 * Retries, timeouts and response-shape handling are delegated to the SDK rather
 * than hand-rolled.
 */
import OpenAI from "openai";

export interface ToolSpec {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

/** One content part of a multimodal message (OpenAI chat format). */
export interface ContentPart {
  type: "text" | "image_url";
  text?: string;
  image_url?: { url: string }; // http(s) or data: URL
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  /** string for plain messages; content-parts array for multimodal user turns */
  content: string | null;
  /** present on multimodal user messages — parts render as text + images */
  content_parts?: ContentPart[];
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}

export interface LlmConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs?: number;
  /**
   * The conversation this request belongs to. OpenCode's endpoints route and
   * prompt-cache per session and refuse a request that names none — see
   * providerHeaders(). Absent means "this caller has no session to name", and
   * then no session header is invented.
   */
  sessionId?: string;
  /**
   * Reasoning effort for models that support it (#47, #150). Sent when the model
   * advertises `reasoning_effort` OR the provider is explicitly opted in — see
   * effortForRequest(). Absent means "provider default".
   */
  reasoningEffort?: string;
  /** per-model capabilities from the endpoint catalogue; gates the above */
  supportedParameters?: string[];
  /**
   * The levels THIS model accepts, when published (OpenRouter's
   * `reasoning.supported_efforts`). The request is clamped into them, so a level the
   * model does not have is never sent (#150).
   */
  supportedEfforts?: string[];
  /**
   * A one-off call whose prompt will never be sent again (the compaction
   * summarizer). Providers that cache on a byte-identical prefix charge a WRITE
   * premium to populate the cache, and a one-off prompt is never read back — so
   * the premium is pure loss. Setting this asks the endpoint not to retain the
   * request where the API can express that; see cacheControlForRequest().
   */
  oneOff?: boolean;
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
 * Reasoning effort for a request body (#47, #150).
 *
 * MEASURED against the live endpoints (one probe each, `max_tokens: 3` with
 * `reasoning_effort: "low"`):
 *
 *   commandcode-goat   200 OK, reply carried `reasoning_content`   -> accepts
 *   google             400 "Thinking level is not supported for this model."
 *   openrouter         documented, catalogue advertises the field
 *
 * and — the fact that decides the design — what each endpoint PUBLISHES in
 * `/models`:
 *
 *   openrouter         `supported_parameters: [… "reasoning_effort" …]` per model
 *   commandcode-goat   only `id`, `name`, `context_length`, `supported_endpoints`
 *   google             no capability list either
 *
 * So for a gateway that publishes nothing there is NO per-model signal to gate on,
 * and the only honest way to find out whether it accepts the field is to TRY it.
 * A wrong guess is cheap to recover from: the endpoint answers 400 with a
 * recognisable message, and `isEffortUnsupported()` + the retry in `chat()` drop
 * the field for that request. That is better than a config flag the operator has to
 * know about, and better than hiding the control behind a capability list most
 * endpoints do not publish.
 *
 * Consequences, in order:
 *   1. a catalogue that explicitly EXCLUDES `reasoning_effort` is respected (no
 *      point provoking a 400 for a model that tells us up front it will refuse);
 *   2. a catalogue that INCLUDES it, or publishes no capability list at all, gets
 *      the field — and self-corrects on refusal;
 *   3. an invalid or absent level is never sent, whatever the endpoint says.
 */
export function effortForRequest(
  cfg: LlmConfig,
  supported: string[] | undefined = cfg.supportedParameters,
): { reasoning_effort?: Effort } {
  const e = cfg.reasoningEffort;
  if (!e || !(REASONING_EFFORTS as readonly string[]).includes(e)) return {};
  // a catalogue that names the parameter it supports and does NOT list this one is
  // a definite "no" — only the ones that omit the question are worth a probe
  if (supported && !supported.includes("reasoning_effort")) return {};
  // Clamp into the model's own levels when it publishes them (#150). The USER's input
  // is validated against the four levels we offer, but the CLAMPED result may be a
  // provider-specific one (`xhigh`, `max`) — deepseek advertises `["max","high","low"]`,
  // so refusing to send `max` because it is not in our own four would throw away the
  // model's real top tier.
  const clamped = clampEffort(e, cfg.supportedEfforts);
  if (!(EFFORT_LADDER as readonly string[]).includes(clamped)) return {};
  return { reasoning_effort: clamped as Effort };
}

/**
 * Did the endpoint refuse `reasoning_effort` as an unsupported PARAMETER? (#150)
 *
 * Google's wording is "Thinking level is not supported for this model."; other
 * gateways phrase it as an unknown/unsupported parameter or field. Matched
 * narrowly: a retry that drops the field is only correct when THIS is the
 * complaint, and misreading an unrelated 400 as one would silently discard the
 * operator's choice instead of surfacing the real error.
 */
export function isEffortUnsupported(err: unknown): boolean {
  const msg = String((err as { message?: unknown })?.message ?? err ?? "");
  if (!/reasoning_effort|thinking level|effort/i.test(msg)) return false;
  return /not supported|unsupported|unknown (parameter|field)|invalid/i.test(msg);
}

/**
 * Is this model OFFERED a reasoning-effort control? (#150)
 *
 * The right panel shows the row when it can do something. A model whose catalogue
 * says it does not take the parameter hides it; one whose catalogue is silent
 * still shows it, because the endpoints that publish nothing (measured: commandcode,
 * google) accept the field for some models and refuse it for others, and a silent
 * 400 with an automatic retry is a better experience than a control that is missing
 * where it would have worked.
 */
export function effortChoosable(supported: string[] | undefined): boolean {
  if (!supported) return true; // no capability list published: worth a try
  return supported.includes("reasoning_effort");
}

function isOpenRouterEndpoint(baseUrl: string | undefined): boolean {
  try {
    return /(^|\.)openrouter\.ai$/i.test(new URL(String(baseUrl ?? "")).host);
  } catch {
    return false;
  }
}

/**
 * Ask the endpoint NOT to retain a one-off request (Pi does the same with
 * `cacheRetention: "none"`; its docs say "summarization requests disable
 * prompt-cache writes because these one-off prompts are unlikely to be reused").
 *
 * Sent ONLY to OpenRouter, which is the one endpoint in use here that both
 * accepts the field and documents it. Every other OpenAI-compatible endpoint gets
 * nothing: an unrecognised body field is a 400 on strict providers, and "send
 * nothing" is exactly today's behaviour, so this can only ever add a saving.
 *
 * `24h` is the value that means "do not retain beyond this request's lifetime" for
 * an organisation with zero-data-retention off; with ZDR on the default is already
 * `in_memory` and this is a no-op.
 */
export function cacheControlForRequest(cfg: LlmConfig): { prompt_cache_retention?: "24h" } {
  if (!cfg.oneOff) return {};
  if (!isOpenRouterEndpoint(cfg.baseUrl)) return {};
  return { prompt_cache_retention: "24h" };
}

const REASONING_EFFORTS = ["minimal", "low", "medium", "high"] as const;
/**
 * The value sent on the wire. Wider than the four the UI offers: a model's own
 * published levels can include `xhigh`/`max`, and clamping must be able to land on
 * them (deepseek-v4.1-flash advertises `["max","high","low"]`).
 */
type Effort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/**
 * Canonical low→high ordering used for clamping, including the levels this harness
 * does not itself offer (`none`, `xhigh`, `max`) because a provider's own list is
 * spelled in those terms and the comparison needs the full ladder.
 *
 * Same ladder and the same rules as Hermes' `EFFORT_LADDER` / `clamp_effort`, which
 * is the clearest statement of the problem: a provider that does not have the
 * requested level should not receive a request it will refuse, and should not be
 * silently escalated either.
 */
const EFFORT_LADDER = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/**
 * Map a requested level onto the levels a MODEL actually accepts (#150).
 *
 * Measured: OpenRouter publishes `reasoning.supported_efforts` per model (198 of 458
 * models), and the levels are not the four a naive UI would offer — deepseek-v4.1-flash
 * advertises `["max","high","low"]`, so `minimal` and `medium` do not exist for it and
 * `max` does. Sending an absent level is a refused turn; offering one is a control that
 * does nothing.
 *
 * Rules, matching Hermes:
 *   - unknown or empty support → the request passes through (we cannot judge it)
 *   - already supported → unchanged
 *   - a level that is not on the ladder at all → unchanged (custom providers use
 *     bespoke names, and rewriting one would be guesswork)
 *   - otherwise the nearest WEAKER level, so a clamp never escalates cost; if nothing
 *     weaker exists, the weakest supported level
 *   - never to `none`, which would silently switch thinking OFF for a caller who asked
 *     for it to be on
 */
export function clampEffort(requested: string, supported: readonly string[] | undefined): string {
  if (!requested || !supported?.length) return requested;
  const norm = supported.map((s) => String(s).toLowerCase());
  if (norm.includes(requested)) return requested;
  const reqIdx = (EFFORT_LADDER as readonly string[]).indexOf(requested);
  if (reqIdx < 0) return requested; // not a ladder level: not ours to rewrite
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

/**
 * Per-endpoint request headers. Empty (harmless no-op) for every provider that
 * does not ask for any.
 *
 * OpenRouter app attribution (https://openrouter.ai/docs/app-attribution):
 * `HTTP-Referer` is the required identifier that puts teapot's usage on the
 * public rankings/analytics; the title names it; `programming-app` files it
 * under coding tools.
 *
 * OpenCode Go (https://opencode.ai/docs/go/#where-can-i-use-it) identifies a
 * conversation by `x-opencode-session` and returns HTTP 400 without it —
 * "Request is missing x-opencode-session and cannot be routed efficiently" —
 * so a turn on that endpoint must name the session it belongs to. The value is
 * the session directory name, which is stable for the whole conversation:
 * a compaction is a new request but not a new conversation, so it keeps the id,
 * while a fork/incarnation switch (`currentSession`) gets its own.
 */
export function providerHeaders(baseUrl: string, sessionId?: string): Record<string, string> {
  try {
    const host = new URL(baseUrl).host;
    if (/(^|\.)openrouter\.ai$/i.test(host)) {
      return {
        "HTTP-Referer": "https://github.com/akku1139/teapot",
        "X-OpenRouter-Title": "teapot",
        "X-OpenRouter-Categories": "programming-app",
      };
    }
    // scoped to this host so the id cannot follow the operator to another
    // provider, and skipped entirely when there is no session to name
    if (sessionId && /(^|\.)opencode\.ai$/i.test(host)) return { "x-opencode-session": sessionId };
    return {};
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
      defaultHeaders: providerHeaders(cfg.baseUrl, cfg.sessionId),
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

/**
 * Repair tool-call pairing so a provider will accept the request (#152).
 *
 * MEASURED against commandcode/deepseek: a request is rejected with
 *
 *     {"message":"invalid request error","type":"invalid_request_error"}
 *
 * — a message that names neither the call nor the message — in three cases, all the
 * same defect:
 *
 *   - an assistant `tool_calls` entry with NO matching `tool` result
 *   - a `tool` result whose `tool_calls` entry is absent (e.g. the prefix that issued
 *     it was compacted away)
 *   - a leading `tool` message, which cannot be answered by anything before it
 *
 * The consequences are worse than a bad status code: the failure is not recognisable
 * as a context overflow, so recovery never runs, and the generic message gives the
 * operator nothing to act on. It also costs the full retry staircase first (5s + 5s +
 * 30s) for a request that could never succeed.
 *
 * Dropping is the only safe repair for a result with no call: there is no id to
 * synthesise a call from, and keeping it re-creates the rejection. An unanswered CALL
 * gets a placeholder result instead, which preserves the exchange's meaning.
 *
 * Returns the input unchanged when it is already valid, so the common path allocates
 * nothing and the prompt stays byte-identical for prefix caching.
 */
export function repairToolPairing(messages: ChatMessage[]): ChatMessage[] {
  const calls = new Set<string>();
  for (const m of messages) for (const t of m.tool_calls ?? []) if (t.id) calls.add(t.id);
  const answered = new Set<string>();
  for (const m of messages) if (m.role === "tool" && m.tool_call_id) answered.add(m.tool_call_id);

  // fast path: nothing to do
  let ok = true;
  for (const m of messages) {
    if (m.role === "tool" && (!m.tool_call_id || !calls.has(m.tool_call_id))) ok = false;
    for (const t of m.tool_calls ?? []) if (t.id && !answered.has(t.id)) ok = false;
  }
  if (ok) return messages;

  const out: ChatMessage[] = [];
  for (const m of messages) {
    // a result whose call is gone cannot be attributed to anything — drop it
    if (m.role === "tool" && (!m.tool_call_id || !calls.has(m.tool_call_id))) continue;
    out.push(m);
    // an unanswered call would be rejected; answer it so the exchange survives
    for (const t of m.tool_calls ?? []) {
      if (t.id && !answered.has(t.id)) {
        out.push({
          role: "tool",
          tool_call_id: t.id,
          content: "(not completed — the tool did not run)",
        });
      }
    }
  }
  // and drop a leading run of tool messages: a prefix drop can leave the kept tail
  // starting on one, which no preceding call can justify
  let start = 0;
  while (start < out.length && out[start]!.role === "tool") start++;
  return start ? out.slice(start) : out;
}

function sanitize(messages: ChatMessage[]): Record<string, unknown>[] {
  // #152: repair pairing BEFORE mapping — every request path goes through here, and a
  // violated pairing is refused with an unhelpful "invalid request error"
  return repairToolPairing(messages).map((m): Record<string, unknown> => {
    // multimodal user message → OpenAI content-parts array (text + images);
    // providers without vision reject it, but those models were never a fit
    if (m.content_parts?.length) {
      const parts = m.content_parts.map((p) =>
        p.type === "image_url"
          ? { type: "image_url" as const, image_url: { url: p.image_url!.url } }
          : { type: "text" as const, text: p.text ?? "" },
      );
      return { role: m.role, content: parts };
    }
    // empty text content makes many providers 400 — send a harmless placeholder
    if ((m.role === "user" || m.role === "assistant") && !m.content) {
      return { ...m, content: m.tool_calls?.length ? "(tool call)" : "(no content)" };
    }
    if (m.role === "tool" && typeof m.content !== "string") {
      return { ...m, content: String(m.content ?? "(no output)") };
    }
    return { ...m };
  });
}

/**
 * Why did the response carry no usable message? (#50)
 *
 * The leading text is kept stable at "LLM API returned no choices" so existing
 * matching (and the retry notes operators have learned to read) still works; the
 * diagnosis follows after a colon.
 */
function noChoicesDetail(res: unknown): string {
  const base = "LLM API returned no choices";
  // a gateway that answers 200 with an error object instead of failing: the
  // actionable message is right there
  const err = (res as { error?: { message?: unknown; type?: unknown; code?: unknown } })?.error;
  if (err && typeof err === "object") {
    const msg = typeof err.message === "string" ? err.message : JSON.stringify(err);
    const code = err.code ?? err.type;
    return `${base}: provider returned an error in a 200 response${
      code ? ` (${String(code)})` : ""
    } — ${String(msg).slice(0, 300)}`;
  }
  // the SDK returned raw text — e.g. an SSE body served to a non-streaming
  // request. JSON.parse succeeds for a real object, so a failure here means we
  // were handed something that is not a completion at all.
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

/** a short type summary of an unexpected response, for the log line */
function safeShape(res: unknown): string {
  try {
    const o = res as Record<string, unknown> | null;
    if (!o || typeof o !== "object") return `got ${typeof res}`;
    return `keys: ${Object.keys(o).slice(0, 8).join(", ") || "(none)"}`;
  } catch {
    return "unreadable response";
  }
}

/**
 * HTTP statuses that mean "this request shape is not supported here", so
 * re-issuing it without `stream: true` is a genuinely different request.
 *
 * Deliberately an allow-list rather than the whole 4xx range. 408/425/429 are
 * TRANSIENT: replaying them immediately against an already-saturated provider
 * just doubles the request count without changing anything. 401/403 mean the
 * credentials are wrong, which is not fixed by dropping `stream` either — they
 * are excluded on purpose, since a fallback there would replace one honest
 * auth error with the same one and a wasted round trip.
 */
const STREAM_REJECTED_STATUS = new Set([400, 404, 405, 406, 415, 422, 501]);

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
        ...effortForRequest(cfg),
        ...cacheControlForRequest(cfg),
      },
      { signal },
    );
    // #50: a gateway may answer with `null` (or any non-object) on some proxy
    // error paths, so the guard is on `rm`, not on `res` being truthy —
    // reading `res.choices` unguarded threw a bare TypeError that named neither
    // the provider nor the shape.
    const raw = res?.choices?.[0];
    const rm = raw?.message as unknown as Record<string, unknown> | undefined;
    if (!rm) throw new Error(noChoicesDetail(res));
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
    // #150: retry ONCE without the effort field when the endpoint says it does not
    // take it, so a level that a particular model refuses never costs a turn
    if (!signal?.aborted && isEffortUnsupported(err) && effortForRequest(cfg).reasoning_effort) {
      return chat({ ...cfg, reasoningEffort: "" }, messages, tools, signal);
    }
    const e = err as { status?: number; message?: string; error?: { message?: string } };
    // #50: our own shape-diagnosis reads as a full sentence but carries no HTTP
    // status (the request SUCCEEDED — that is the whole problem), so the generic
    // wrapper below would relabel it "LLM API error ?: …".
    if (String((err as Error).message ?? "").startsWith("LLM API returned no choices")) throw err;
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
        ...effortForRequest(cfg),
        ...cacheControlForRequest(cfg),
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
    if (!message.content && !message.tool_calls) {
      // #50: a stream that opened, produced NOTHING, and closed cleanly. The
      // marker lets the handler below tell this apart from a request the provider
      // actively rejected — re-issuing THIS one without `stream` usually succeeds.
      const e = new Error("LLM API error: empty completion") as Error & { emptyStream?: boolean };
      e.emptyStream = true;
      throw e;
    }
    return { message, reasoning: reasoning || undefined, usage };
  } catch (err) {
    // #50 — a provider that doesn't support streaming at all still gets ONE clean
    // fallback, but ONLY when the failure could plausibly be the stream itself.
    // The condition must NOT be `!gotChunk && !signal?.aborted`: that also matches
    // a request that FAILED (a 200 carrying an SSE `error` frame, a context-length
    // rejection), and the fallback then re-issues the same oversized request,
    // replacing the real diagnosis — a restored 1500-message session reports "no
    // choices" instead of "context length exceeded", so isContextOverflow() never
    // runs compact-and-retry.
    //
    //  1. A status in STREAM_REJECTED_STATUS: only a request rejected outright is a
    //     genuinely DIFFERENT request when re-issued without `stream`.
    //  2. `emptyStream`: a 200 that streams zero chunks and closes cleanly is a
    //     broken/flaky proxy — precisely the case the retry rescues. Requiring a
    //     4xx here would delete that safety net, a regression this file's own
    //     tests caught.
    //
    // Everything else — 5xx, an error frame, a mid-stream failure — is the ANSWER,
    // rethrown untouched so overflow recovery can see it.
    const status = (err as { status?: unknown })?.status;
    // #150: the endpoint refused `reasoning_effort` itself. Retry ONCE without it,
    // so choosing a level never costs a turn — this is what makes the control safe
    // to offer on an endpoint whose capabilities cannot be known in advance.
    if (!signal?.aborted && isEffortUnsupported(err) && effortForRequest(cfg).reasoning_effort) {
      return chatStream({ ...cfg, reasoningEffort: "" }, messages, tools, signal, onDelta);
    }
    const rejectedByProvider =
      typeof status === "number" && STREAM_REJECTED_STATUS.has(status);
    const emptyStream = (err as { emptyStream?: boolean })?.emptyStream === true;
    if (!gotChunk && !signal?.aborted && (rejectedByProvider || emptyStream)) {
      return chat(cfg, messages, tools, signal, onDelta);
    }
    // user interrupt: hand back whatever streamed so far so the harness can
    // keep the partial output visible instead of losing it
    if (signal?.aborted && (text || reasoning)) {
      (err as { partial?: unknown }).partial = { text, reasoning };
    }
    throw err;
  }
}
