import { z } from "zod";

export const ProviderSchema = z.object({
  baseUrl: z.union([z.string().url("baseUrl must be a valid URL"), z.literal("")]).optional(),
  apiKey: z.string().optional(),
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

export const ConfigPatchSchema = z.object({
  providers: z.record(z.string().min(1, "provider name required"), ProviderSchema).optional(),
  defaultProvider: z.string().optional(),
  progressIntervalMs: z.number().int().min(10_000, "progress interval must be ≥ 10s").optional(),
  progressMinChars: z.number().int().min(100).optional(),
  contextTokenBudget: z.number().int().min(1_000).nullable().optional(),
  contextWindowTokens: z.number().int().min(1_000).nullable().optional(),
  maxSpawnDepth: z.number().int().min(0).max(8).optional(),
  password: z.string().max(200).optional(),
  shortContext: z.boolean().optional(),
  maxTurnsPerRound: z.number().int().min(0).optional(),
  onError: z.enum(["stop", "retry"]).optional(),
  retryDelayMs: z.number().int().min(1_000).optional(),
  tasks: z.array(TaskSchema).optional(),
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

export function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("; ")
    .slice(0, 500);
}
