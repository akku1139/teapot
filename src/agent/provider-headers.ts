/**
 * Request headers a provider needs to route and cache a turn.
 *
 * Lives in its own module because it is a pure string computation and `llm.ts` imports the `openai`
 * SDK — which MEASURED +32MB RSS / +6.7MB heap just to be loaded. `model-meta.ts` needs exactly this
 * function and nothing else, so importing it from `llm.ts` pulled the whole SDK into the boot path of
 * every process (the server, every test file, every script).
 */
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
