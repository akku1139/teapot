/**
 * What the right panel's provider dropdown does to the model field.
 *
 * The panel has two controls that must agree: `provider` and the model input.
 * Changing the provider used to leave the model input holding the PREVIOUS
 * provider's value (or an empty draft whose placeholder still named the
 * current model), so the value the switch would actually use — the provider's
 * own configured default — was never selected, and pressing apply carried the
 * old provider's model over to the new endpoint.
 *
 * Pure and dependency-free so it is unit-testable under `node --test`.
 */

export interface ProviderLike {
  model?: string;
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
  agent: { provider?: string; model?: string } | undefined,
): string {
  const fallback = providerDefaultModel(providers, toProvider);
  if (fallback) return fallback;
  if (agent && toProvider === (agent.provider ?? "")) return agent.model ?? "";
  return "";
}

/** Placeholder for an emptied model input: what a bare apply would use. */
export function modelPlaceholderFor(
  providers: Record<string, ProviderLike | undefined> | undefined,
  provider: string,
  agent: { model?: string } | undefined,
): string {
  return providerDefaultModel(providers, provider) || agent?.model || "";
}
