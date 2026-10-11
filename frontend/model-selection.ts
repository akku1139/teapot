/**
 * What the right panel's provider dropdown does to the model field.
 *
 * The panel has two controls that must agree: `provider` and the model input.
 * Changing the provider used to leave the model input holding the PREVIOUS
 * provider's value, so the value the switch would actually use — the provider's
 * own configured default — was never selected, and pressing apply carried the
 * old provider's model over to the new endpoint.
 *
 * Pure and dependency-free so it is unit-testable under `node --test`.
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
 * current model is kept ONLY when the dropdown is back on the provider that
 * model already belongs to (re-selecting it must not blank the field);
 * otherwise the field is emptied rather than carrying a foreign model across,
 * and the server's "no model resolved" error is the honest outcome.
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
 * Placeholder for the model input — what an empty field would resolve to.
 *
 * While the dropdown still points at the session's own provider, that is the
 * model the session is actually using, which is the useful thing to show. Once
 * the dropdown moves elsewhere the session's model no longer describes it, so
 * the new provider's configured default takes over.
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
 * It may when the operator has NOT touched the dropdown — that is the external
 * change (another tab, a restart) the re-sync exists for. Once touched, the
 * choice is theirs: without this, picking a provider that has no default model
 * leaves the draft empty, the next poll reads that as "not mid-edit" and yanks
 * the dropdown back before `apply` can be pressed — the exact opposite of the
 * fix.
 */
export function mayResyncProvider(userTouchedProvider: boolean): boolean {
  return !userTouchedProvider;
}
