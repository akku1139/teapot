
export type OAuthStateLike = {
  required?: boolean;
  authorized?: boolean;
  hasRefreshToken?: boolean;
  flow?: { phase: string; url?: string };
};

export const oauthStateFrom = (
  map: Record<string, OAuthStateLike> | undefined,
  name: string,
): OAuthStateLike | null => {
  const key = String(name ?? "").trim();
  if (!key) return null;
  if (/^\d+$/.test(key)) return null; 
  return map?.[key] ?? null;
};
