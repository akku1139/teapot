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
}

const cache = new Map<string, { at: number; list: ModelMeta[] }>();
const TTL = 10 * 60_000;

/** Fetch GET /models from an OpenAI-compatible endpoint (cached ~10 min). */
export async function fetchModelList(
  baseUrl: string,
  apiKey?: string,
): Promise<ModelMeta[]> {
  const root = baseUrl.replace(/\/+$/, "");
  const hit = cache.get(root);
  if (hit && Date.now() - hit.at < TTL) return hit.list;
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
      }))
      .filter((m) => m.id);
    cache.set(root, { at: Date.now(), list });
    return list;
  } catch {
    return []; // unreachable provider — caller treats as "unknown"
  }
}

export function contextLengthFor(
  list: ModelMeta[],
  model: string,
): number | undefined {
  return list.find((m) => m.id === model)?.contextLength;
}

/** test hook */
export function clearModelListCache(): void {
  cache.clear();
  void fs;
}
