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
    if (sessionId && /(^|\.)opencode\.ai$/i.test(host)) return { "x-opencode-session": sessionId };
    return {};
  } catch {
    return {}; 
  }
}
