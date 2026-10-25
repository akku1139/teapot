/**
 * Looking up a server's OAuth state.
 *
 * The map is keyed by server NAME, so this is the only correct lookup — and the reason it exists as
 * a function is that a writer once used the row INDEX and the two mixed silently: `{ 0: state }` in
 * a name-keyed map answered for whichever server happened to be first, so an unrelated row showed
 * "🔑 authorized" while an authorized one showed nothing.
 *
 * A numeric key can therefore never be a name. Refusing it makes the old shape fail loudly-ish
 * (no badge) instead of attributing one server's grant to another.
 */

export type OAuthStateLike = {
  required?: boolean;
  authorized?: boolean;
  hasRefreshToken?: boolean;
  flow?: { phase: string; url?: string };
};

/** the state for `name`, or null when there is none (or the key is a numeric index) */
export const oauthStateFrom = (
  map: Record<string, OAuthStateLike> | undefined,
  name: string,
): OAuthStateLike | null => {
  const key = String(name ?? "").trim();
  if (!key) return null;
  if (/^\d+$/.test(key)) return null; // an index is not an identity
  return map?.[key] ?? null;
};
