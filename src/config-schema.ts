/**
 * Zod schema for teapot's config — the single source of truth for what a
 * valid config looks like, used to gate web-UI edits (PUT /api/config) and any
 * programmatic writes with human-readable error messages.
 *
 * Validation gates; it is not the storage format — the master persists the raw
 * user JSON so unknown fields survive round-trips.
 */
import { z } from "zod";

export const ProviderSchema = z.object({
  baseUrl: z.union([z.string().url("baseUrl must be a valid URL"), z.literal("")]).optional(),
  apiKey: z.string().optional(),
  /**
   * Several credentials for ONE provider, rotated round-robin (#170). Blank entries
   * are rejected rather than silently dropped: the operator wrote them, and a key
   * that vanishes without a word is how "I added 3 keys but it still rate-limits"
   * happens.
   */
  apiKeys: z
    .array(z.string().min(1, "an api key entry must not be empty"))
    .max(50, "at most 50 keys per provider")
    .optional(),
  model: z.string().optional(),
});

export const AgentEntrySchema = z.object({
  id: z
    .string()
    .regex(/^[A-Za-z0-9._-]{1,64}$/, "id: letters/digits/dots/dashes only, max 64"),
  workspace: z.string().min(1, "workspace required"),
  provider: z.string().optional(),
  model: z.string().optional(),
  baseUrl: z.string().optional(),
  apiKey: z.string().optional(),
  contextWindowTokens: z.number().int().positive().optional(),
  parent: z.string().optional(),
});

export const TaskSchema = z.object({
  id: z.string().min(1, "task id required").max(64),
  agent: z.string().min(1, "task agent required"),
  schedule: z.string().min(3, "schedule required (cron or 'every Nm')"),
  prompt: z.string().min(1, "prompt required"),
  forked: z.boolean().optional(),
});

/** the patch shape accepted by PUT /api/config */
export const ConfigPatchSchema = z.object({
  providers: z.record(z.string().min(1, "provider name required"), ProviderSchema).optional(),
  defaultProvider: z.string().optional(),
  progressIntervalMs: z.number().int().min(10_000, "progress interval must be ≥ 10s").optional(),
  progressMinChars: z.number().int().min(100).optional(),
  // null clears a previously pinned compact budget → back to per-model derivation
  contextTokenBudget: z.number().int().min(1_000).nullable().optional(),
  // null clears a saved window pin → back to per-model inference (same contract as contextTokenBudget)
  contextWindowTokens: z.number().int().min(1_000).nullable().optional(),
  maxSpawnDepth: z.number().int().min(0).max(8).optional(),
  /** #161: prune old tool output early (opt-in, for small-window models) */
  shortContext: z.boolean().optional(),
  // soft cap on LLM turns in one round; reaching it nudges the model to wrap
  // up (not an error) — 0 disables the cap
  maxTurnsPerRound: z.number().int().min(0).optional(),
  // round-fatal API errors: "stop" (default) or "retry" (back off + fresh
  // round — for unattended agents that should ride out outages)
  onError: z.enum(["stop", "retry"]).optional(),
  retryDelayMs: z.number().int().min(1_000).optional(),
  tasks: z.array(TaskSchema).optional(),
  /**
   * MCP servers (#67). Validated here so a bad entry fails the SAVE with a readable
   * message instead of surfacing later as a tool that never appears: a stdio server
   * needs a command, a network one needs a url, and the name is what namespaces every
   * tool it exposes.
   */
  mcpServers: z
    .array(
      z
        .object({
          name: z.string().min(1, "MCP server name required"),
          url: z.string().optional(),
          command: z.string().optional(),
          args: z.array(z.string()).optional(),
          env: z.record(z.string(), z.string()).optional(),
          headers: z.record(z.string(), z.string()).optional(),
          transport: z.enum(["http", "sse", "stdio"]).optional(),
          enabled: z.boolean().optional(),
          timeoutMs: z.number().int().min(1_000).optional(),
        })
        .refine((v) => Boolean(v.url || v.command), {
          message: "an MCP server needs a url or a command",
        })
        .refine((v) => v.transport !== "stdio" || Boolean(v.command), {
          message: "stdio transport requires a command",
        }),
    )
    .optional(),
});

export type ConfigPatch = z.infer<typeof ConfigPatchSchema>;

/** Format a ZodError into a compact operator-readable message. */
export function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("; ")
    .slice(0, 500);
}
