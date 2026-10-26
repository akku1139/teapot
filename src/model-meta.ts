import { providerHeaders } from "./agent/provider-headers.ts";

export interface ModelMeta {
  id: string;
  contextLength?: number;
  pricing?: { prompt: number; completion: number };
  modalities?: { input: string[]; output: string[] };
  supportedParameters?: string[];
  supportedEfforts?: string[];
  defaultEffort?: string;
  reasoningMandatory?: boolean;
}

const cache = new Map<string, { at: number; list: ModelMeta[]; negative?: boolean }>();
const inFlight = new Map<string, Promise<ModelMeta[]>>();
const TTL = 10 * 60_000;

const NEGATIVE_TTL = 30_000;

function fresh(entry: { at: number; negative?: boolean }): boolean {
  return Date.now() - entry.at < (entry.negative ? NEGATIVE_TTL : TTL);
}

export function peekModelList(baseUrl: string): ModelMeta[] | undefined {
  const root = baseUrl.replace(/\/+$/, "");
  const hit = cache.get(root);
  if (!hit) return undefined;
  if (!fresh(hit)) return undefined;
  return hit.negative ? [] : hit.list;
}

export async function fetchModelList(
  baseUrl: string,
  apiKey?: string,
): Promise<ModelMeta[]> {
  const root = baseUrl.replace(/\/+$/, "");
  const hit = cache.get(root);
  if (hit && fresh(hit)) return hit.list;
  const inflight = inFlight.get(root);
  if (inflight) return inflight;
  const p = (async () => {
  try {
    const res = await fetch(`${root}/models`, {
      headers: {
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        ...providerHeaders(baseUrl), 
      },
      signal: AbortSignal.timeout(3_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j = (await res.json()) as {
      data?: {
        id?: string;
        context_length?: number;
        pricing?: { prompt?: string | number; completion?: string | number };
        architecture?: {
          modality?: string;
          input_modalities?: string[];
          output_modalities?: string[];
        };
        supported_parameters?: string[];
        reasoning?: {
          mandatory?: boolean;
          default_enabled?: boolean;
          supported_efforts?: string[];
          default_effort?: string;
        };
      }[];
    };
    const list = (j.data ?? [])
      .map((m) => ({
        id: typeof m.id === "string" ? m.id : "",
        contextLength: typeof m.context_length === "number" ? m.context_length : undefined,
        pricing:
          m.pricing && (m.pricing.prompt !== undefined || m.pricing.completion !== undefined)
            ? {
                prompt: Number(m.pricing.prompt ?? 0),
                completion: Number(m.pricing.completion ?? 0),
              }
            : undefined,
        modalities:
          Array.isArray(m.architecture?.input_modalities) && m.architecture!.input_modalities!.length
            ? {
                input: m.architecture!.input_modalities!,
                output: m.architecture!.output_modalities ?? ["text"],
              }
            : undefined,
        supportedParameters: Array.isArray(m.supported_parameters)
          ? m.supported_parameters.filter((p): p is string => typeof p === "string")
          : undefined,
        supportedEfforts: Array.isArray(m.reasoning?.supported_efforts)
          ? m.reasoning!.supported_efforts!.filter((e): e is string => typeof e === "string")
          : undefined,
        ...(typeof m.reasoning?.default_effort === "string"
          ? { defaultEffort: m.reasoning.default_effort }
          : {}),
        ...(m.reasoning?.mandatory === true ? { reasoningMandatory: true } : {}),
      }))
      .filter((m) => m.id);
    cache.set(root, { at: Date.now(), list });
    return list;
  } catch {
    cache.set(root, { at: Date.now(), list: [], negative: true });
    return []; 
  }
  })();
  inFlight.set(root, p);
  try {
    return await p;
  } finally {
    inFlight.delete(root);
  }
}

export function contextLengthFor(
  list: ModelMeta[],
  model: string,
): number | undefined {
  return list.find((m) => m.id === model)?.contextLength;
}

export const REASONING_EFFORTS = ["minimal", "low", "medium", "high"] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export function isReasoningEffort(v: unknown): v is ReasoningEffort {
  return typeof v === "string" && (REASONING_EFFORTS as readonly string[]).includes(v);
}

export function isOpenRouter(baseUrl: string | undefined): boolean {
  try {
    return /(^|\.)openrouter\.ai$/i.test(new URL(String(baseUrl ?? "")).host);
  } catch {
    return false;
  }
}

export function resolveReasoningEffort(opts: {
  baseUrl?: string;
  model?: string;
  list?: ModelMeta[];
  effort?: string | null;
}): ReasoningEffort | undefined {
  if (!isReasoningEffort(opts.effort)) return undefined;
  if (!isOpenRouter(opts.baseUrl)) return undefined;
  const meta = opts.list?.find((m) => m.id === opts.model);
  if (!meta?.supportedParameters) return undefined;
  if (!meta.supportedParameters.includes("reasoning_effort")) return undefined;
  return opts.effort;
}
