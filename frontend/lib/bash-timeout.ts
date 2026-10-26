
export const BASH_DEFAULT_TIMEOUT_MS = 120_000;

export const BASH_MAX_TIMEOUT_MS = 600_000;

export const effectiveBashTimeout = (timeoutMs: unknown): number => {
  const n = Number(timeoutMs);
  return Math.min(Number.isFinite(n) && n > 0 ? n : BASH_DEFAULT_TIMEOUT_MS, BASH_MAX_TIMEOUT_MS);
};
