/**
 * Model capabilities, from models.dev.
 *
 * WHY models.dev and not the provider's own `/models`: MEASURED against the operator's four
 * configured providers, only OpenRouter publishes anything about capabilities. Command Code (93
 * models), Google (38) and orcarouter all return just an id, a name and a context length — no
 * `modalities`, no `reasoning`, no `supported_parameters`. That is why this file used to conclude
 * "cannot be known", which was WRONG: models.dev carries the same information for 232 providers,
 * including `commandcode` (71 models) and `opencode` (130), keyed by the provider's own API host.
 *
 * The shape mirrors what Pi (and its forks) do — models.dev is the authority, `reasoning_options`
 * becomes the selectable effort list, `modalities.input` becomes the accepted input kinds. Keeping a
 * second parser for each provider's ad-hoc `/models` JSON was the "wasteful and a source of bugs"
 * the operator called out, so it is gone.
 */
import { providerHeaders } from "./agent/provider-headers.ts";

export interface ModelMeta {
  id: string;
  name?: string;
  contextLength?: number;
  /** USD per TOKEN, the unit `Agent.stats.costUsd` multiplies by. models.dev publishes per MILLION. */
  pricing?: { prompt: number; completion: number; cacheRead?: number };
  /** what the model ACCEPTS and produces, e.g. `{ input: ["text","image"], output: ["text"] }` */
  modalities?: { input: string[]; output: string[] };
  /** the effort levels this model publishes, in the provider's own spelling */
  supportedEfforts?: string[];
  /**
   * The provider's OWN list of accepted request parameters (`supported_parameters`).
   *
   * This is the only way to know which spelling of a turn's thinking the endpoint accepts: OpenRouter
   * advertises `reasoning`, Command Code advertises nothing and wants `reasoning_content`. Sending the
   * wrong one is a 400, so the name is chosen from here rather than guessed (#187).
   */
  supportedParameters?: string[];
  /** the model reasons at all — `supportedEfforts` may still be empty (a plain toggle) */
  reasoning?: boolean;
}

/** one models.dev record, as much of it as we use */
type MdModel = {
  id?: string;
  name?: string;
  reasoning?: boolean;
  reasoning_options?: Array<{ type?: string; values?: unknown[] }>;
  modalities?: { input?: unknown[]; output?: unknown[] };
  limit?: { context?: number };
  cost?: { input?: number; output?: number; cache_read?: number };
};

type MdProvider = { id?: string; api?: string | null; models?: Record<string, MdModel> };

const DB_URL = "https://models.dev/api.json";
/** the whole DB is ~6MB; it changes on the order of days, so an hour is generous and cheap. */
const TTL = 60 * 60_000;
/** a failed fetch must not re-run per agent (15s × every agent at boot was the old bug) */
const NEGATIVE_TTL = 5 * 60_000;

type Snapshot = { at: number; providers: Map<string, MdProvider>; negative?: boolean };
let db: Snapshot | undefined;
let inFlight: Promise<Snapshot> | undefined;

const hostOf = (baseUrl: string | undefined): string => {
  try {
    return new URL(String(baseUrl ?? "")).host.toLowerCase();
  } catch {
    return "";
  }
};

const fresh = (s: Snapshot | undefined): s is Snapshot =>
  !!s && Date.now() - s.at < (s.negative ? NEGATIVE_TTL : TTL);

/**
 * Find the models.dev provider for a baseUrl.
 *
 * HOST FIRST, then the path as a tie-break, because both are needed:
 *
 *   - a host match is what makes `commandcode` work: FIVE config entries share
 *     `api.commandcode.ai`, and models.dev lists that host once;
 *   - a host match alone is ambiguous for `opencode.ai`, which models.dev splits into `opencode`
 *     (130 models, `/inference/openai/v1`) and `opencode-go` (37, `/inference/go/openai/v1`).
 *     MEASURED: host-only picked whichever came first and resolved the session's provider to the
 *     wrong catalog — 37 models, and its model not found.
 *
 * The operator's `https://opencode.ai/zen/v1` matches NEITHER path exactly, so the path only
 * disambiguates when it actually agrees; otherwise the host match stands.
 */
export function providerFor(dbProviders: Map<string, MdProvider>, baseUrl: string | undefined): MdProvider | undefined {
  const host = hostOf(baseUrl);
  if (!host) return undefined;
  const sameHost = [...dbProviders.values()].filter((p) => hostOf(p.api ?? undefined) === host);
  if (sameHost.length <= 1) return sameHost[0];
  const path = (() => {
    try {
      return new URL(String(baseUrl ?? "")).pathname;
    } catch {
      return "";
    }
  })();
  // prefer the entry whose path is a prefix/suffix relation with ours, longest overlap wins
  const scored = sameHost
    .map((p) => {
      const apiPath = (() => {
        try {
          return new URL(String(p.api ?? "")).pathname;
        } catch {
          return "";
        }
      })();
      let common = 0;
      for (let i = 0; i < Math.min(apiPath.length, path.length) && apiPath[i] === path[i]; i++) common++;
      /**
       * When the shared prefix is only the leading `/`, the paths disagree entirely — `zen/v1` is
       * neither `inference/openai/v1` nor `inference/go/openai/v1`. In that case prefer the entry
       * with MORE models: a real provider catalog is the general one, and the narrower variant is a
       * strict subset (opencode: 130 vs opencode-go: 37, MEASURED).
       */
      const models = Object.keys(p.models ?? {}).length;
      return { p, common, models };
    })
    .sort((a, b) => b.common - a.common || b.models - a.models);
  return scored[0]?.p ?? sameHost[0];
}

async function loadDb(): Promise<Snapshot> {
  if (fresh(db)) return db;
  if (inFlight) return inFlight;
  const p = (async (): Promise<Snapshot> => {
    try {
      const res = await fetch(DB_URL, {
        headers: providerHeaders(DB_URL),
        signal: AbortSignal.timeout(8_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = (await res.json()) as Record<string, MdProvider>;
      const providers = new Map<string, MdProvider>();
      for (const [key, value] of Object.entries(j)) {
        if (value && typeof value === "object") providers.set(key, value);
      }
      const snap: Snapshot = { at: Date.now(), providers };
      db = snap;
      return snap;
    } catch {
      /**
       * Remember the FAILURE briefly, and always return a usable snapshot.
       *
       * Without the negative cache every agent paid an 8s timeout at boot — the same shape as the
       * old per-endpoint fetch. An empty map is not an error to the caller: it means "no data", and
       * every consumer treats absent metadata as UNKNOWN rather than as "unsupported".
       */
      const snap: Snapshot = { at: Date.now(), providers: new Map(), negative: true };
      db = snap;
      return snap;
    }
  })();
  inFlight = p;
  try {
    return await p;
  } finally {
    inFlight = undefined;
  }
}

/** the effort levels a models.dev record publishes, flattened out of `reasoning_options` */
export function effortsFrom(m: MdModel | undefined): string[] | undefined {
  const values = (m?.reasoning_options ?? [])
    .filter((o) => o?.type === "effort")
    .flatMap((o) => (Array.isArray(o.values) ? o.values : []))
    .filter((v): v is string => typeof v === "string");
  return values.length ? [...new Set(values)] : undefined;
}

const strings = (v: unknown): string[] | undefined => {
  const out = (Array.isArray(v) ? v : []).filter((x): x is string => typeof x === "string");
  return out.length ? out : undefined;
};

/** one models.dev record → our shape; unknown fields stay absent, never invented */
export function metaFrom(m: MdModel): ModelMeta {
  const input = strings(m.modalities?.input);
  const output = strings(m.modalities?.output);
  const efforts = effortsFrom(m);
  return {
    id: String(m.id ?? ""),
    ...(typeof m.name === "string" ? { name: m.name } : {}),
    ...(typeof m.limit?.context === "number" ? { contextLength: m.limit.context } : {}),
    /**
     * models.dev quotes USD per MILLION tokens; everything downstream multiplies by TOKENS.
     *
     * MEASURED: `claude-sonnet-4-5` is `{input: 3, output: 15}`, i.e. $3/$15 per million — so feeding
     * those raw made a 892.6M-token session cost $15,239,168 instead of $15.31, and the picker badge
     * read `150000/M`. Normalise here, at the single boundary, and keep the per-token convention the
     * cost code and the badge already assume.
     */
    ...(m.cost && (typeof m.cost.input === "number" || typeof m.cost.output === "number")
      ? {
          pricing: {
            prompt: Number(m.cost.input ?? 0) / 1e6,
            completion: Number(m.cost.output ?? 0) / 1e6,
            ...(typeof m.cost.cache_read === "number" ? { cacheRead: m.cost.cache_read / 1e6 } : {}),
          },
        }
      : {}),
    ...(input ? { modalities: { input, output: output ?? ["text"] } } : {}),
    ...(efforts ? { supportedEfforts: efforts } : {}),
    ...(m.reasoning === true ? { reasoning: true } : {}),
  };
}

/**
 * The model list for a provider: the PROVIDER's own catalogue, enriched by models.dev.
 *
 * The provider is the authority on which models exist — models.dev lags and omits entries. MEASURED:
 * `reflection/beam:free` is served by Command Code (94 models) and absent from models.dev's
 * `commandcode` record (72), so a models.dev-only list silently drops models the operator can
 * actually call.
 *
 * models.dev is still needed for CAPABILITY, because most providers publish none: Command Code's
 * `/models` returns only `{context_length, created, id, name, object, owned_by, supported_endpoints}`
 * while OpenRouter publishes `architecture` (modalities) and `supported_parameters`. So:
 *
 *   - provider list wins for MEMBERSHIP;
 *   - a provider field, when present, wins for that field;
 *   - models.dev fills only what the provider did not say.
 *
 * When the provider cannot be reached at all we fall back to the models.dev list rather than showing
 * nothing.
 */
export async function fetchModelList(baseUrl: string, apiKey?: string): Promise<ModelMeta[]> {
  const [snap, upstream] = await Promise.all([
    loadDb(),
    fetchProviderModels(baseUrl, apiKey).catch(() => null),
  ]);
  const provider = providerFor(snap.providers, baseUrl);
  const dbModels = provider?.models ? Object.values(provider.models).map(metaFrom).filter((m) => m.id) : [];
  if (!upstream) return dbModels;
  const byId = new Map(dbModels.map((m) => [m.id, m]));
  return upstream
    .map((m) => mergeMeta(m, byId.get(m.id)))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** a provider's own `/models`, normalised, or null when it does not answer usefully */
async function fetchProviderModels(baseUrl: string, apiKey?: string): Promise<ModelMeta[] | null> {
  const url = `${String(baseUrl).replace(/\/+$/, "")}/models`;
  const res = await fetch(url, {
    headers: { ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}), ...providerHeaders(baseUrl) },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) return null;
  const j = (await res.json()) as {
    data?: {
      id?: unknown;
      name?: unknown;
      context_length?: unknown;
      architecture?: { input_modalities?: unknown; output_modalities?: unknown };
      supported_parameters?: unknown;
      pricing?: { prompt?: unknown; completion?: unknown };
    }[];
  };
  const out: ModelMeta[] = [];
  for (const m of j.data ?? []) {
    if (typeof m.id !== "string" || !m.id) continue;
    const input = strings(m.architecture?.input_modalities);
    const output = strings(m.architecture?.output_modalities);
    const ctx = typeof m.context_length === "number" ? m.context_length : undefined;
    // `reasoning` in supported_parameters means the model accepts a reasoning_effort-style control
    const params = strings(m.supported_parameters);
    out.push({
      id: m.id,
      ...(typeof m.name === "string" ? { name: m.name } : {}),
      ...(ctx !== undefined ? { contextLength: ctx } : {}),
      ...(input ? { modalities: { input, output: output ?? ["text"] } } : {}),
      ...(params?.some((p) => p === "reasoning" || p === "reasoning_effort") ? { reasoning: true } : {}),
      ...(params ? { supportedParameters: params } : {}),
    });
  }
  return out.length ? out : null;
}

/** provider fields win; models.dev fills only the gaps */
function mergeMeta(own: ModelMeta, db: ModelMeta | undefined): ModelMeta {
  if (!db) return own;
  return {
    id: own.id,
    ...(own.name ?? db.name ? { name: own.name ?? db.name } : {}),
    ...(own.contextLength ?? db.contextLength ? { contextLength: own.contextLength ?? db.contextLength } : {}),
    ...(own.modalities ?? db.modalities
      ? { modalities: own.modalities ?? db.modalities }
      : {}),
    /**
     * Efforts come from models.dev even when the provider listed the model: no provider publishes the
     * effort LEVELS, only that reasoning exists. `own.reasoning` still wins for the yes/no question.
     */
    ...(db.supportedEfforts ? { supportedEfforts: db.supportedEfforts } : {}),
    ...(own.supportedParameters ?? db.supportedParameters
      ? { supportedParameters: own.supportedParameters ?? db.supportedParameters }
      : {}),
    ...(own.reasoning ?? db.reasoning ? { reasoning: own.reasoning ?? db.reasoning } : {}),
    ...(db.pricing ? { pricing: db.pricing } : {}),
  };
}

export function peekModelList(baseUrl: string): ModelMeta[] | undefined {
  if (!fresh(db)) return undefined;
  const provider = providerFor(db.providers, baseUrl);
  if (!provider?.models) return undefined;
  return Object.values(provider.models).map(metaFrom).filter((m) => m.id);
}

export function contextLengthFor(list: ModelMeta[], model: string): number | undefined {
  return list.find((m) => m.id === model)?.contextLength;
}

export const REASONING_EFFORTS = ["minimal", "low", "medium", "high"] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export function isReasoningEffort(v: unknown): v is ReasoningEffort {
  return typeof v === "string" && (REASONING_EFFORTS as readonly string[]).includes(v);
}

/**
 * Should the UI offer a reasoning-effort control for this model?
 *
 * THREE answers, not two. `true` when models.dev says the model reasons; `false` when it says it
 * does not; and TRUE when the model is simply not in the database — because the previous rule
 * ("only OpenRouter") hid the control for every other provider even though the request would have
 * worked. A wire that rejects `reasoning_effort` is recovered from at runtime
 * (`isEffortUnsupported`), so an optimistic default costs one retry at worst, while a pessimistic one
 * silently removes a feature the model does have.
 */
export function effortSupportedFor(opts: { list?: ModelMeta[]; model?: string }): boolean {
  const meta = opts.list?.find((m) => m.id === opts.model);
  if (!meta) return true; // not in models.dev → unknown, not "unsupported"
  return meta.reasoning === true || !!meta.supportedEfforts?.length;
}

/** the effort levels to offer, or undefined to let the caller use its default ladder */
export function effortsFor(opts: { list?: ModelMeta[]; model?: string }): string[] | undefined {
  return opts.list?.find((m) => m.id === opts.model)?.supportedEfforts;
}
