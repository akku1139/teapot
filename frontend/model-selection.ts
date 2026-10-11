/**
 * What the right panel's provider dropdown does to the model field.
 *
 * The panel has two controls that must agree: `provider` and the model input.
 * They must not drift: a model belonging to one provider must never be carried
 * over to another endpoint.
 */

export interface ProviderLike {
  model?: string;
}

export interface AgentLike {
  provider?: string;
  model?: string;
}

/** The provider a session resolves to: its own, else the configured default. */
export function effectiveProviderOf(
  agent: AgentLike | undefined,
  providers: Record<string, ProviderLike | undefined> | undefined,
  defaultProvider: string | undefined,
): string {
  return agent?.provider || defaultProvider || Object.keys(providers ?? {})[0] || "";
}

/** The model a provider falls back to: its configured default, else "". */
export function providerDefaultModel(
  providers: Record<string, ProviderLike | undefined> | undefined,
  provider: string,
): string {
  if (!provider) return "";
  return String(providers?.[provider]?.model ?? "").trim();
}

/**
 * The model the input must hold once the provider dropdown lands on
 * `toProvider`.
 *
 * The provider's configured default wins. With none configured, the agent's
 * current model is kept only when the dropdown is back on the provider that
 * model belongs to; otherwise the field is emptied rather than carrying a
 * foreign model across.
 */
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

/**
 * Placeholder for the model input — what an empty field would resolve to:
 * the session's own model while the dropdown points at its provider, else the
 * new provider's configured default.
 */
export function modelPlaceholderFor(
  providers: Record<string, ProviderLike | undefined> | undefined,
  provider: string,
  agent: AgentLike | undefined,
  agentProvider: string,
): string {
  if (agent?.model && provider === agentProvider) return agent.model;
  return providerDefaultModel(providers, provider) || agent?.model || "";
}

/**
 * May the sync effect pull the provider dropdown back to the session's own
 * provider?
 *
 * Only when the operator has NOT touched the dropdown — that is the external
 * change (another tab, a restart) the re-sync exists for. Once touched, the
 * choice is theirs: without this, picking a provider with no default model
 * leaves the draft empty, the next poll reads that as "not mid-edit" and yanks
 * the dropdown back before `apply` can be pressed.
 */
export function mayResyncProvider(userTouchedProvider: boolean): boolean {
  return !userTouchedProvider;
}
