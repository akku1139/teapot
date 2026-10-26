
export interface ProviderLike {
  model?: string;
}

export interface AgentLike {
  provider?: string;
  model?: string;
}

export function effectiveProviderOf(
  agent: AgentLike | undefined,
  providers: Record<string, ProviderLike | undefined> | undefined,
  defaultProvider: string | undefined,
): string {
  return agent?.provider || defaultProvider || Object.keys(providers ?? {})[0] || "";
}

export function providerDefaultModel(
  providers: Record<string, ProviderLike | undefined> | undefined,
  provider: string,
): string {
  if (!provider) return "";
  return String(providers?.[provider]?.model ?? "").trim();
}

export function modelOnProviderSwitch(
  providers: Record<string, ProviderLike | undefined> | undefined,
  toProvider: string,
  agent: AgentLike | undefined,
): string {
  const fallback = providerDefaultModel(providers, toProvider);
  if (fallback) return fallback;
  if (agent && toProvider === (agent.provider ?? "")) return agent.model ?? "";
  return "";
}

export function modelPlaceholderFor(
  providers: Record<string, ProviderLike | undefined> | undefined,
  provider: string,
  agent: AgentLike | undefined,
  agentProvider: string,
): string {
  if (agent?.model && provider === agentProvider) return agent.model;
  return providerDefaultModel(providers, provider) || agent?.model || "";
}

export function mayResyncProvider(userTouchedProvider: boolean): boolean {
  return !userTouchedProvider;
}
