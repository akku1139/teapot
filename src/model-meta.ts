/**
 * Provider model metadata (context window sizes) with a small TTL cache.
 * Used to auto-populate contextWindowTokens so compaction budgets derive
 * from the real window instead of the safe default.
 */
import fs from "node:fs";
import { providerHeaders } from "./agent/llm.ts";

export interface ModelMeta {
  id: string;
  contextLength?: number;
  /** USD per token (OpenRouter-style) — powers the runtime cost estimate */
  pricing?: { prompt: number; completion: number };
  /** what the model can accept and produce — drives the 📄🖼️→📄 badge */
  modalities?: { input: string[]; output: string[] };
  /**
   * Parameters the endpoint advertises for this model (OpenRouter publishes
   * `supported_parameters`). Lets the UI show reasoning-effort controls only
   * where they actually work — support is far from universal (#47).
   */
  supportedParameters?: string[];
}

const cache = new Map<string, { at: number; list: ModelMeta[] }>();
const inFlight = new Map<string, Promise<ModelMeta[]>>();
const TTL = 10 * 60_000;

/** Fetch GET /models from an OpenAI-compatible endpoint (cached ~10 min). */
export async function fetchModelList(
  baseUrl: string,
  apiKey?: string,
): Promise<ModelMeta[]> {
  const root = baseUrl.replace(/\/+$/, "");
  const hit = cache.get(root);
  if (hit && Date.now() - hit.at < TTL) return hit.list;
  // An in-flight lookup is SHARED: without this, two callers racing for the
  // same endpoint each paid the full timeout, and `newSession` in ACP mode
  // blocked on it before it could even reply to the editor (#15).
  const inflight = inFlight.get(root);
  if (inflight) return inflight;
  const p = (async () => {
  try {
    const res = await fetch(`${root}/models`, {
      headers: {
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        ...providerHeaders(baseUrl), // OpenRouter app attribution
      },
      // boot-time calls happen per agent; a slow/unroutable endpoint used to
      // stall startup for up to 15s PER AGENT before this was tightened
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
      }[];
    };
    const list = (j.data ?? [])
      .map((m) => ({
        id: typeof m.id === "string" ? m.id : "",
        contextLength: typeof m.context_length === "number" ? m.context_length : undefined,
        // OpenRouter-style USD per token (e.g. "0.000003") — powers the
        // runtime cost estimate. Providers without pricing stay undefined.
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
        // OpenRouter advertises per-model capabilities; other endpoints omit
        // the field entirely, which leaves support "unknown" rather than false.
        supportedParameters: Array.isArray(m.supported_parameters)
          ? m.supported_parameters.filter((p): p is string => typeof p === "string")
          : undefined,
      }))
      .filter((m) => m.id);
    cache.set(root, { at: Date.now(), list });
    return list;
  } catch {
    return []; // unreachable provider — caller treats as "unknown"
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

/** Reasoning-effort levels OpenRouter accepts (`reasoning_effort`). */
export const REASONING_EFFORTS = ["minimal", "low", "medium", "high"] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export function isReasoningEffort(v: unknown): v is ReasoningEffort {
  return typeof v === "string" && (REASONING_EFFORTS as readonly string[]).includes(v);
}

/** True when the endpoint is OpenRouter (the only one that documents effort). */
export function isOpenRouter(baseUrl: string | undefined): boolean {
  try {
    return /(^|\.)openrouter\.ai$/i.test(new URL(String(baseUrl ?? "")).host);
  } catch {
    return false;
  }
}

/**
 * The `reasoning_effort` value to actually SEND, or undefined to omit it.
 *
 * Verified against the live OpenRouter /models endpoint (462 models): 196
 * advertise `reasoning_effort`, 331 the broader `reasoning`, and NONE a bare
 * top-level `effort`. Support is therefore far from universal, and sending the
 * parameter to a model that does not advertise it is how a request gets
 * rejected or a setting silently ignored (#47) — so it is sent only when the
 * endpoint is OpenRouter AND the model advertises it. Off by default: an absent
 * setting means "let the provider apply its own default".
 */
export function resolveReasoningEffort(opts: {
  baseUrl?: string;
  model?: string;
  list?: ModelMeta[];
  effort?: string | null;
}): ReasoningEffort | undefined {
  if (!isReasoningEffort(opts.effort)) return undefined;
  if (!isOpenRouter(opts.baseUrl)) return undefined;
  const meta = opts.list?.find((m) => m.id === opts.model);
  // No catalogue for this endpoint: we cannot verify support, so do not send.
  // A wrong body field is worse than an unset one.
  if (!meta?.supportedParameters) return undefined;
  if (!meta.supportedParameters.includes("reasoning_effort")) return undefined;
  return opts.effort;
}

/** test hook */
export function clearModelListCache(): void {
  cache.clear();
  void fs;
}
