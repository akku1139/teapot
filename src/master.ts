/**
 * Master server: owns all agents and one low-frequency scheduler tick.
 * Agents are in-process async loops (I/O bound only); all CPU-heavy work is
 * delegated to subprocesses managed by the bash tool with hard timeouts.
 */
import { closeAllTerminals, closeTerminalsFor } from "./server/terminals.ts";
import {
  readFileSync,
  existsSync,
  mkdirSync,
  writeFileSync,
  readdirSync,
  statSync,
  lstatSync,
  renameSync,
  unlinkSync,
  openSync,
  closeSync,
  readSync,
  fsyncSync,
  rmSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { currentKey, makeKeyPool, resetPool, type KeyPoolState } from "./agent/key-pool.ts";
import { sessionTitleFrom } from "./session-title.ts";
import path from "node:path";
import os from "node:os";
import { expandTilde, homeDir } from "./home.ts";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { Agent } from "./agent/agent.ts";
import { parseSchedule, matches, nextFireAt, type Schedule } from "./scheduler/cron.ts";
import type { LlmConfig, ChatFn } from "./agent/llm.ts";
import type { TeapotEvent } from "./log/events.ts";
import { bus, type BusEvent } from "./bus.ts";
import { mcp } from "./agent/mcp-registry.ts";
import { loadPlugins, type LoadedPlugin } from "./agent/plugins.ts";
import type { McpServerConfig } from "./agent/mcp.ts";
import {
  fetchModelList,
  peekModelList,
  contextLengthFor,
  isReasoningEffort,
  type ModelMeta,
  type ReasoningEffort,
} from "./model-meta.ts";

/** how deep sub-agent spawning may nest (parent=0, its subs=1, …) */
/**
 * Did the effective data dir come from an ENV OVERRIDE that disagrees with the
 * config file's own `dataDir`? (#143)
 *
 * When it does, the config's session pointers are meaningless: they name
 * directories under the OLD root, and this process is looking at a different
 * one. Every agent therefore mints a fresh session — and `recordSession` writes
 * those new pointers back into the config, destroying the real mapping. The
 * caller then throws the new root away (a test's temp dir), leaving a config that
 * points at sessions that never existed.
 *
 * That is not hypothetical: `test/cli-boot-and-host.test.ts` spawns the built CLI
 * with `TEAPOT_DATA_DIR=<temp>` but NO config override, so `pnpm test` on a
 * developer machine rewrote their real config and orphaned 493 sessions' pointers
 * — twice, before this guard. On CI it is invisible, because CI has no config
 * file to damage.
 *
 * So: a mismatched root makes session resolution READ-ONLY. The boot still works
 * (agents get working sessions in the new root) — it just does not rewrite a
 * config that is describing somebody else's data dir.
 */
function dataDirOverrideMismatch(configFilePath: string, effective: string): boolean {
  if (!process.env.TEAPOT_DATA_DIR) return false; // not an override: the file is the truth
  try {
    const raw = JSON.parse(readFileSync(configFilePath, "utf8")) as { dataDir?: unknown };
    if (typeof raw.dataDir !== "string" || !raw.dataDir) return false;
    return path.resolve(raw.dataDir) !== path.resolve(effective);
  } catch {
    return false; // unreadable/new config — nothing to protect
  }
}

const MAX_SPAWN_DEPTH = 3;
/**
 * How long boot waits for an endpoint's model catalogue (#143).
 *
 * The window and the reasoning-effort gate both come from `/models`, so a boot
 * that waits on it is waiting for metadata, not for anything it needs to start.
 * The lookup is fired concurrently for every distinct endpoint before the agent
 * loop (see prefetchModelLists), so this bound is paid once per ENDPOINT rather
 * than once per agent — and only when the endpoint is slow or dead.
 */
const MODEL_META_BOOT_MS = 1_500;
/** statuses that mean a child has finished working, for #130 */
// `needs_operator` is settled too: the child has stopped working and is waiting on a human, so
// the parent must not treat it as "still busy" and wait forever for it to finish.
const SETTLED: ReadonlySet<string> = new Set([
  "idle",
  "stopped",
  "waiting",
  "needs_operator",
  "error",
]);

/**
 * Skills shipped with the package — resolved relative to this module so it
 * works from a global `npm install -g` install, an npx cache, or a repo
 * checkout alike. Lowest-priority skill root (workspace > global > bundled).
 */
const BUNDLED_SKILLS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../skills",
);

/**
 * Application version, read from package.json next to this module.
 *
 * Walks up from `dist/master.js` / `src/master.ts` to the package root so it
 * resolves in every layout (repo checkout, global install, npx cache). Falls
 * back to `"0.0.0"` rather than throwing: a missing/unreadable package.json
 * must never stop the server from booting.
 */
function readAppVersion(): string {
  try {
    let dir = path.dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 6; i++) {
      const pkg = path.join(dir, "package.json");
      if (existsSync(pkg)) {
        const v = (JSON.parse(readFileSync(pkg, "utf8")) as { version?: string }).version;
        if (typeof v === "string" && v) return v;
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    /* fall through to the sentinel below */
  }
  return "0.0.0";
}

/**
 * Turn a user-supplied workspace path into an absolute one.
 *
 * A relative path used to be resolved against `process.cwd()`, so a config
 * entry like `"workspace": "workspaces/alpha"` (the form shipped in
 * teapot.config.example.json) silently pointed at whatever directory the
 * daemon happened to be started from — and the agent's bash tool then ran in
 * the wrong directory (#34). Relative workspaces are now anchored to the
 * config file's own directory, which is what "the workspace" means inside a
 * config file.
 *
 * `~` is expanded for both forms; absolute paths pass through untouched.
 */
export function resolveWorkspace(input: string, base: string): string {
  // #110: `~` must not expand to the LITERAL "~" — that is how a directory named
  // `~` got created on Windows, where process.env.HOME is unset. See src/home.ts.
  const expanded = expandTilde(input.trim());
  if (path.isAbsolute(expanded)) return path.normalize(expanded);
  return path.resolve(base, expanded);
}

/** default sub-agent personas — mentionable from the composer (@name) and
 *  usable by agents via spawn_agent({persona}) */
export const SUB_PERSONAS: Record<
  string,
  { label: string; directive: string; readOnly?: boolean }
> = {
  reviewer: {
    label: "🔍 reviewer",
    directive:
      "ROLE: code reviewer. Inspect the change set, judge correctness, style, tests; report concrete findings as a prioritized list.",
    readOnly: true,
  },
  tester: {
    label: "🧪 tester",
    directive:
      "ROLE: test engineer. Write and run tests for the task at hand, hunt edge cases, report pass/fail with exact commands.",
  },
  researcher: {
    label: "🔎 researcher",
    directive:
      "ROLE: read-only explorer. Search the codebase/docs, map how things work, and report a compact briefing with file:line references.",
    readOnly: true,
  },
  implementer: {
    label: "🔨 implementer",
    directive:
      "ROLE: hands-on implementer. Make the change end-to-end (code + tests), keep edits small and verified, then report what changed and why.",
  },
  "gyaru-reviewer": {
    label: "💅 gyaru reviewer",
    directive:
      "ROLE: pre-commit diff reviewer in a blunt gyaru voice. Read the whole diff and hunt: debug leftovers, unclear UI copy, silent data-loss risks, convention drift. Every finding must be concrete — suggested fix or an explicit shrug.",
    readOnly: true,
  },
};

export interface ProviderConfig {
  /** OpenAI-compatible base URL, e.g. https://openrouter.ai/api/v1 */
  baseUrl: string;
  /**
   * A SINGLE key. Still honoured, and still what the UI writes when a provider has
   * one credential, so existing configs and hand-written files keep working.
   *
   * When both are present `apiKeys` wins as the pool; `apiKey` is then the first
   * entry for display. See migrateKeyPools().
   */
  apiKey?: string;
  /**
   * Several keys for ONE provider, rotated round-robin (#170). A rate-limited key is
   * parked for a cooldown instead of failing the request. See
   * src/agent/key-pool.ts for the rules.
   */
  apiKeys?: string[];
  /** optional default model for this provider */
  model?: string;
}

export interface AgentConfig {
  id: string;
  workspace: string;
  /** which named provider to use (defaults to config.defaultProvider) */
  provider?: string;
  model?: string;
  /** inline overrides win over the provider entry */
  baseUrl?: string;
  apiKey?: string;
  /** optional: this model's context window, for the UI usage gauge */
  contextWindowTokens?: number;
  /** set when this agent was spawned by another agent — survives restarts */
  parent?: string;
  /**
   * Archived: hidden from the normal agent list, not started at boot, but its
   * config entry and its session history are kept so it can be restored.
   *
   * This is what "remove" should always have been. `removeAgent` deleted the config
   * entry while leaving `sessions/` on disk, which made the session unreachable from
   * the UI forever — recoverable only by knowing the id and editing config.json by
   * hand. Archiving is reversible; deleting is not, so deleting is now a separate,
   * explicitly destructive action.
   */
  archived?: boolean;
  /** epoch ms when it was archived — lets the UI sort newest-first */
  archivedAt?: number;
  /** test hook: inject a mock LLM function */
  chatFn?: ChatFn;
  /** restrict to read-only tools (set automatically for read-only personas) */
  readOnly?: boolean;
  /** keep looping toward an active goal after each round (default true) */
  autoContinue?: boolean;
  /** automatically compact when context exceeds budget (default true) */
  autoCompact?: boolean;
  /** #161: prune old tool output early — for small-window models. Opt-in. */
  shortContext?: boolean;
  /** reasoning effort for models that support it (#47); omit = provider default */
  reasoningEffort?: string;
  /**
   * Internal session id this agent is currently bound to. Persisted so a
   * restart reattaches to the SAME session instead of guessing: sessions were
   * discovered by scanning the sessions dir and sorting by chat.jsonl mtime,
   * so a newer-but-older-in-reality dir (or a deleted one still on disk) could
   * win and hand the agent a timeline the operator had moved off (#39).
   */
  session?: string;
};

export interface TaskConfig {
  id: string;
  agent: string;
  schedule: string;
  prompt: string;
  /** run in a forked branch so scheduled chatter never disturbs the main line */
  forked?: boolean;
  /** runtime dedupe marker, persisted across restarts */
  lastRunMin?: number;
}

export interface TeapotConfig {
  port: number;
  /** listen address — "127.0.0.1" (default), "0.0.0.0" for LAN, … */
  host?: string;
  dataDir: string;
  llm: Partial<LlmConfig>;
  /** named OpenAI-compatible providers */
  providers?: Record<string, ProviderConfig>;
  /** provider used when an agent does not specify one (default "openrouter") */
  defaultProvider?: string;
  agents: AgentConfig[];
  tasks?: TaskConfig[];
  /**
   * MCP servers (#67). Tools from these are exposed to every agent as
   * `mcp__<server>__<tool>`. Omitted entirely = no MCP, which is the common case.
   */
  mcpServers?: McpServerConfig[];
  /**
   * Short-context mode (#161): prune old tool output early instead of waiting for the
   * window to fill. Opt-in — on a large window it discards information you had room
   * for. Meant for 32k–262k models.
   */
  shortContext?: boolean;
  /**
   * Directory of Agent Plugins (#162), each a subdirectory with `plugin.json`.
   * Defaults to `<config dir>/plugins`. `false` disables plugin discovery.
   *
   * A plugin contributes SKILLS (its `skills/` becomes a skill root) and MCP servers
   * (from its `mcp.json`) — the two component types the format defines that teapot
   * has something to attach them to.
   */
  pluginsDir?: string | false;
  progressIntervalMs?: number;
  /** progress prompts also require this much real model output since the last report */
  progressMinChars?: number;
  /** per-agent estimated-token history budget before compaction kicks in */
  contextTokenBudget?: number;
  /** default model context window for agents that don't set their own */
  contextWindowTokens?: number;
  /** how deep agents may nest sub-agent spawning (default 3) */
  maxSpawnDepth?: number;
  /**
   * Default reasoning effort for spawned sub-agents (#105), applied when the
   * spawn call does not name one. Named after OpenAI Codex's
   * `agent_default_subagent_reasoning_effort`, which exists for the same reason:
   * a per-spawn argument is the most specific, but a global backstop stops every
   * sub-agent from silently inheriting a parent's expensive effort. The parent's
   * own effort remains the last resort.
   */
  defaultSubagentReasoningEffort?: ReasoningEffort;
  /** soft cap on LLM turns per round (0 disables); reaching it is not an error */
  maxTurnsPerRound?: number;
  /** round-fatal API errors: "stop" (default) or "retry" (backoff + fresh round) */
  onError?: "stop" | "retry";
  retryDelayMs?: number;
  /** optional shared secret protecting /api/* (env TEAPOT_API_TOKEN wins) */
  password?: string;
  /**
   * Custom themes, stored SERVER-side so they follow the config rather than one browser.
   *
   * They lived in `localStorage`, which means a theme made on the desktop did not exist on a
   * phone, in a second browser, or after clearing site data — and the operator runs this over a
   * reverse proxy from another device. Asked for as "カスタムテーマをlocalStorageじゃなくてサーバーで
   * 管理するようにしたい".
   *
   * The shape is the frontend's `CustomTheme` as-is (palette, optional image URL, dim, alpha), and
   * the background image is already a server URL (`/api/assets/<hex>.<ext>`), so a theme transfers
   * between browsers with no rewriting. Typed loosely here: `master.ts` is the config layer and
   * must not import frontend types, and an unknown field must survive a load/save round trip
   * rather than be silently dropped (that is how a theme would lose its image).
   */
  customThemes?: unknown[];
  /** which custom theme id each appearance slot names, when following the system */
  themePrefs?: { fixed?: string; auto?: boolean; dark?: string; light?: string };
  /**
   * Sessions a LIVE UPDATE must resume.
   *
   * Written immediately before the process replaces itself, consumed on the next boot and cleared.
   * It exists because "which agents were working" is not derivable from the log afterwards: an
   * agent that was mid-round looks exactly like one the operator stopped, and resume-on-boot for
   * EVERY configured agent would start work nobody asked for. So the set is decided at shutdown,
   * when the answer is still known, and is deliberately transient.
   */
  resumeAfterUpdate?: string[];
}

const CONFIG_DIR =
  process.env.TEAPOT_CONFIG_DIR ??
  path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"), "teapot-coding-agent");

const DATA_DIR =
  process.env.TEAPOT_DATA_DIR ??
  process.env.XDG_DATA_HOME ??
  path.join(os.homedir(), ".local", "share", "teapot-coding-agent");

const DEFAULT_CONFIG: TeapotConfig = {
  port: Number(process.env.TEAPOT_PORT ?? 7788),
  // #140: this was `process.env.TEAPOT_HOST`, i.e. UNDEFINED when unset — and an
  // undefined hostname makes `@hono/node-server` bind every interface. So the
  // default was the opposite of the documented one: `--help` says
  // "127.0.0.1 (default) · 0.0.0.0 exposes the UI to your network", and yet the
  // default WAS "expose to your network".
  //
  // Measured: with no --host the server answered on the machine's LAN address as
  // well as loopback.
  //
  // Loopback is the right default for something holding API tokens and agent
  // workspaces; exposing it has to be a deliberate act.
  host: process.env.TEAPOT_HOST ?? "127.0.0.1",
  dataDir: DATA_DIR,
  llm: {
    baseUrl: process.env.TEAPOT_BASE_URL ?? "https://openrouter.ai/api/v1",
    apiKey: process.env.TEAPOT_API_KEY ?? "",
    model: process.env.TEAPOT_MODEL ?? "",
  },
  providers: {},
  agents: [],
  tasks: [],
};

/** Where config is looked up / stored. */
export function configDir(): string {
  return CONFIG_DIR;
}

/**
 * Resolution order:
 *   1. explicit path argument (CLI)
 *   2. $TEAPOT_CONFIG
 *   3. ~/.config/teapot-coding-agent/config.json
 *   4. ./teapot.config.json (legacy project-local)
 */
export function resolveConfigPath(explicitPath?: string): string {
  if (explicitPath) return path.resolve(explicitPath);
  if (process.env.TEAPOT_CONFIG) return path.resolve(process.env.TEAPOT_CONFIG);
  const xdg = path.join(CONFIG_DIR, "config.json");
  if (existsSync(xdg)) return xdg;
  return path.resolve("teapot.config.json");
}

let masterRawConfig: Record<string, unknown> = {};

/**
 * Normalise a provider entry's credentials into `apiKeys` (#170).
 *
 * Both spellings are read, and the result is written back in the shape the UI and
 * the pool consume. The rules:
 *
 *   - `apiKeys` present  -> used as-is (trimmed, blanks and duplicates dropped)
 *   - `apiKey` only      -> becomes `apiKeys: [apiKey]`  (the OLD shape, which is
 *                           every config written before this feature)
 *   - neither            -> left alone (a local endpoint may need no key)
 *
 * `apiKey` is KEPT in step with `apiKeys[0]` rather than deleted, because other
 * readers still expect it (the setup wizard, `/api/providers`, hand-edited files) and
 * a migration that removes a field the operator can see is a migration they will
 * report as data loss.
 *
 * Returns a NEW entry; the caller decides whether to persist.
 */
export function migrateProviderKeys(p: ProviderConfig): ProviderConfig {
  const seen = new Set<string>();
  const clean = (list: readonly unknown[]): string[] => {
    const out: string[] = [];
    for (const k of list) {
      const t = typeof k === "string" ? k.trim() : "";
      if (!t || seen.has(t)) continue;
      seen.add(t);
      out.push(t);
    }
    return out;
  };

  // `apiKeys` is AUTHORITATIVE once present. The single `apiKey` only SEEDS the pool
  // when there is no list — appending it as well would resurrect a credential the
  // operator had already replaced (they set a list precisely because the old key was
  // exhausted), and the pool would happily rotate back onto it.
  const hasList = Array.isArray(p.apiKeys);
  const keys = hasList
    ? clean(p.apiKeys!)
    : clean(typeof p.apiKey === "string" ? [p.apiKey] : []);

  if (keys.length === 0) {
    // no credential at all (a local endpoint may need none): do not invent an empty
    // array, which would read as "this provider has keys" to anything counting them
    const { apiKeys: _drop, ...rest } = p;
    return rest as ProviderConfig;
  }
  // `apiKey` is kept in step with the FIRST key rather than deleted: other readers
  // still expect it (the setup wizard, `/api/providers`), and a migration that
  // removes a field the operator can see reads as data loss.
  return { ...p, apiKeys: keys, apiKey: keys[0] };
}

/** Every key for a provider, in order, with the legacy single key folded in. */
export function providerKeys(p: ProviderConfig | undefined): string[] {
  if (!p) return [];
  return migrateProviderKeys(p).apiKeys ?? [];
}

export function loadConfig(configPath: string): TeapotConfig {
  if (!existsSync(configPath)) return DEFAULT_CONFIG;
  mkdirSync(CONFIG_DIR, { recursive: true });
  const user = JSON.parse(readFileSync(configPath, "utf8")) as Partial<TeapotConfig>;
  masterRawConfig = user as Record<string, unknown>;
  return {
    ...DEFAULT_CONFIG,
    ...user,
    dataDir: user.dataDir ? path.resolve(user.dataDir.replace(/^~/, os.homedir())) : DEFAULT_CONFIG.dataDir,
    llm: { ...DEFAULT_CONFIG.llm, ...user.llm },
    // #170: fold a legacy single `apiKey` into `apiKeys` on load, so every consumer
    // below sees one shape. Done here rather than at each use site because the pool,
    // the UI and the spawn path all need the same answer.
    providers: Object.fromEntries(
      Object.entries(user.providers ?? {}).map(([name, p]) => [name, migrateProviderKeys(p)]),
    ),
  };
}

/** Raw parsed user config (for lossless persistence of web edits). */
/**
 * Can this path be replaced by an atomic rename?
 *
 * #144: `/dev/null`, a fifo, or a directory are all legitimate values for
 * `configPath`, and `rename` over them either fails outright (EACCES for a temp
 * beside `/dev/null`) or is not what the caller wants. Only a regular file gets
 * the write-temp-then-rename treatment.
 */
function isRegularFileTarget(p: string): boolean {
  try {
    // lstat, not stat: a SYMLINK must take the plain-write path. statSync
    // follows the link, so a symlink→regular-file passed this check and the
    // atomic rename then REPLACED THE LINK with a real file — the link's
    // target (a dotfile repo, stow/chezmoi) kept the old value and a restart
    // resurrected it. Same reasoning covers hardlinks (rename splits the
    // inode; the write must go through the existing directory entry).
    const st = lstatSync(p);
    return st.isFile() && !st.isSymbolicLink();
  } catch {
    // Does not exist yet. The ATOMIC path needs a real directory to rename within, so
    // only take it when the parent exists — otherwise a test that passes `/dev/null`
    // (present on POSIX, absent on Windows) tried to create `/dev/.config.json.tmp…`
    // and failed with a bare 400 that read like a schema rejection.
    return existsSync(path.dirname(p));
  }
}

export function loadedRaw(): Record<string, unknown> {
  return masterRawConfig;
}

/* ---------- console activity log ---------- */

const isTTY = process.stdout.isTTY;
const c = (code: string, s: string) => (isTTY ? `\x1b[${code}m${s}\x1b[0m` : s);
const dim = (s: string) => c("2", s);
const clip1 = (s: unknown, n: number) => {
  const one = String(s ?? "").replace(/\s+/g, " ").trim();
  return one.length > n ? one.slice(0, n) + "…" : one;
};
const hhmmss = () => new Date().toTimeString().slice(0, 8);

/** Print one agent event as a compact human-readable console line. */
function printAgentEvent(e: TeapotEvent): void {
  const ts = dim(hhmmss());
  const who = c("36", e.agent); // cyan
  const d = e.data as Record<string, unknown>;
  let line: string | null = null;
  switch (e.type) {
    case "prompt":
      line = `${c("33", "▶ prompt")} (${d.source}) ${clip1(d.text, 110)}`;
      break;
    case "tool_call":
      line = `${c("36", "⚙ exec")} ${d.name} ${dim(clip1(JSON.stringify(d.args ?? {}), 130))}`;
      break;
    case "tool_result": {
      const ok = d.ok !== false;
      const mark = ok ? c("32", "✔ done") : c("31", "✖ fail");
      line = `${mark} ${d.name} ${dim(`${d.durationMs}ms`)} ${dim(clip1(d.result, 90))}`;
      break;
    }
    case "state": {
      if (d.from === d.to && !d.reason && !d.detail) break;
      if (d.detail === "llm turn start") {
        line = `${c("35", "· llm")} turn ${d.turn}`;
        break;
      }
      line = `${c("35", "◆ state")} ${d.from}→${d.to}${d.reason ? ` (${clip1(d.reason, 80)})` : ""}`;
      break;
    }
    case "message":
      if (d.final && d.content) line = `${c("34", "🏁 final")} ${clip1(d.content, 140)}`;
      break; // regular assistant messages are visible in the UI
    case "progress":
      line = `${c("32", "📈 progress")} ${clip1(d.doing, 100)}`;
      break;
    case "goal":
      line = `🎯 goal ${d.event}: ${clip1(d.text ?? d.status, 100)}`;
      break;
    case "error":
      line = `${c("31", "⚠ error")} ${clip1(d.message, 160)}`;
      break;
    case "system_note": {
      if (d.event === "runaway-detected")
        line = `${c("31", "🛑 runaway")} ${d.failures} consecutive tool failures (limit ${d.limit}) — last: ${clip1(String(d.lastTool), 24)}: ${clip1(String(d.lastError), 90)}`;
      else if (d.event === "error-retry")
        line = `${c("33", "↻ error-retry")} attempt ${d.attempt} — next round in ${Math.round(Number(d.waitMs) / 1000)}s`;
      if (d.event === "llm-retry")
        line = `${c("33", "↻ retry")} attempt ${d.attempt} in ${Math.round(Number(d.waitMs) / 1000)}s — ${clip1(d.error, 100)}`;
      else if (d.event === "context-compacted")
        line = `${c("33", "🗜 compact")} tokens ${d.tokensBefore}→${d.tokensAfter} (${d.mode})`;
      else if (d.event === "session-restored")
        line = `${c("33", "⟲ restore")} branch ${d.branch}, ${d.messages} messages`;
      else if (d.event === "model-changed")
        line = `${c("33", "🧦 model")} → ${d.model} (${d.provider})`;
      else if (d.event === "round-turn-cap")
        // The code deliberately does NOT nudge the model here (see the note at the
        // emit site): telling it "the round ended, consider finish()" invited premature
        // finishes. The old text claimed a nudge that does not happen, which sends
        // anyone reading the log looking for behaviour that was removed on purpose.
        line = `${c("33", "⏸ round cap")} ${d.turns} turns — round ended, auto-continue starts the next one`;
      break;
    }
    default:
      break;
  }
  if (line) console.log(`${dim(ts)} ${who} ${line}`);
}

/**
 * Reduce an agent id to a safe single path segment.
 *
 * Agent ids become directory names, so anything path-like in one is an escape
 * from the sessions root (#72). Kept in step with the per-call-site
 * `.replace(/[^\w.-]/g, "-")` calls, and applied in `addAgent` too so the
 * guarantee holds for every caller.
 */
export function sanitizeAgentId(id: string): string {
  const cleaned = String(id ?? "")
    .replace(/[^\w.-]/g, "-")
    // a leading dot would create a hidden dir; ".." would climb out
    .replace(/^\.+/, "")
    .slice(0, 60);
  return cleaned || "agent";
}

export class Master {
  readonly agents = new Map<string, Agent>();
  /** Agent Plugins loaded at boot (#162); their skill roots are offered to every agent */
  plugins: LoadedPlugin[] = [];

  /**
   * ONE key pool per provider name (#170), shared by every agent on it.
   *
   * Shared on purpose: a 429 is a statement about the CREDENTIAL, not about the
   * agent that happened to send the request. Per-agent pools would let agent B walk
   * straight back into the key agent A just got rate-limited on — the rotation would
   * exist and do nothing, which is the failure shape this repo keeps re-learning.
   *
   * Keyed by PROVIDER NAME rather than baseUrl: two entries for the same endpoint may
   * legitimately hold different credentials, and those must not be merged.
   */
  private readonly keyPools = new Map<string, KeyPoolState>();
  /**
   * pid of the process that replaced us in a live update, or null while we are
   * still the server. `restartServer()` sets it; `index.ts` reads it to keep
   * supervising the replacement instead of exiting and dropping the operator
   * back at the shell prompt (#35).
   */
  replacementPid: number | null = null;
  private tasks: {
    task: TaskConfig;
    schedule: Schedule;
    lastRunMin: number;
    lastRunAt?: number;
  }[] = [];
  private childWaiters = new Map<string, Set<(note: string) => void>>();
  /**
   * Children that have actually started, for #130.
   *
   * A child is `idle` between `addAgent` and `start()`, and that is its FIRST
   * status transition — so without this the parent is told a brand-new sub-agent is
   * idle before it has done anything.
   */
  private reportedRunning = new Set<string>();
  private startedAt = Date.now();
  readonly config: TeapotConfig;
  readonly configPath: string;
  /** false on first boot with no config file → web UI shows the setup wizard */
  configFileExists = true;

  constructor(
    config: TeapotConfig,
    configPath: string,
  ) {
    this.config = config;
    this.configPath = configPath;
    // #143: an env data-dir override that disagrees with the config file means
    // this config describes a DIFFERENT data dir — its session pointers cannot be
    // valid here, so rewriting them would destroy the real mapping. See
    // dataDirOverrideMismatch().
    this.sessionsReadOnly = dataDirOverrideMismatch(configPath, config.dataDir);
    if (this.sessionsReadOnly) {
      console.warn(
        `[teapot] TEAPOT_DATA_DIR (${config.dataDir}) disagrees with the config's own dataDir; ` +
          `sessions will be resolved in the override but NOT written back to ${configPath}. ` +
          `Set TEAPOT_CONFIG to an isolated config to silence this.`,
      );
    }
  }

  /**
   * Persist current logical config back to disk (lossless via raw user config).
   *
   * #144: this was a bare `writeFileSync`, which TRUNCATES the target before it
   * writes. config.json holds every agent, provider and scheduled task, so any
   * interruption during the write — SIGINT, a crash, a full disk — left a ZERO-LENGTH
   * file, and the next boot read `{}` and came up empty.
   *
   * Boot made this far more likely than it sounds: every agent that mints a
   * session calls `recordSession` → `saveConfig`, so a machine with 30 configured
   * agents rewrites the whole file 30 times before the server listens. A user
   * pressing Ctrl-C during that window lost the lot.
   *
   * Now: write a sibling temp file, fsync it, then `rename` over the target.
   * `rename` is atomic within a filesystem, so the file is either the old content
   * or the new — never empty. A crash mid-write leaves the temp file behind and
   * the real config untouched.
   */
  saveConfig(): void {
    // #144: during boot, mark dirty instead of writing; flushed once at the end
    if (this.deferConfigWrites) {
      this.configDirty = true;
      return;
    }
    this.raw.agents = this.config.agents;
    this.raw.providers = this.config.providers;
    this.raw.defaultProvider = this.config.defaultProvider;
    this.raw.tasks = this.config.tasks;
    // #67: `raw` is what gets WRITTEN, and it is a hand-maintained mirror of `config`.
    // `mcpServers` was added to the config and to the API but never to this list, so the
    // servers existed in memory and in `GET /api/config` and were STILL lost on restart —
    // a save→reopen appeared to work while the file never carried them.
    //
    // Every field that must survive a restart belongs here. Caught by asserting the FILE
    // contents in test/mcp-config-roundtrip.test.ts, which was impossible while that test
    // wrote to /dev/null.
    this.raw.mcpServers = this.config.mcpServers;
    /**
     * Custom themes live in the config so they follow the machine, not one browser.
     *
     * This line is the whole persistence: `raw` is the hand-maintained mirror that actually gets
     * written, and a field missing from it exists in memory and in `GET /api/config` while never
     * reaching the file — exactly the #67 failure above, which is why it is called out there.
     */
    if (this.config.customThemes !== undefined) this.raw.customThemes = this.config.customThemes;
    /**
     * The API password — same mirror, same trap.
     *
     * It was never in `raw` because it was only ever written by the first-run setup path, which
     * wrote the file wholesale. Now that the settings panel can change it, a missing mirror would
     * make "set a password" appear to work and vanish on the next restart, leaving the server open
     * while the operator believes it is closed — the worst possible direction for this field.
     */
    if (this.config.password !== undefined) this.raw.password = this.config.password;
    else delete this.raw.password;
    if (this.config.themePrefs !== undefined) this.raw.themePrefs = this.config.themePrefs;
    /**
     * The live-update resume set — and the reason it needs this line is the whole point of it.
     *
     * `resumeAfterUpdate()` CLEARS the set so a crash cannot make a later boot resume hours-old
     * work. Without this mirror the clear lived only in memory, so the file kept the old set and the
     * NEXT update would resume the same sessions again — MEASURED: a boot with
     * `resumeAfterUpdate: ["worker"]` left the file unchanged at `["worker"]` after consuming it.
     *
     * Written unconditionally (not only when defined): `[]` is a meaningful value here, and skipping
     * it is what kept the stale list on disk.
     */
    this.raw.resumeAfterUpdate = this.config.resumeAfterUpdate;
    if (this.config.shortContext !== undefined) this.raw.shortContext = this.config.shortContext;
    if (this.config.pluginsDir !== undefined) this.raw.pluginsDir = this.config.pluginsDir;
    if (this.raw.progressIntervalMs === undefined && this.config.progressIntervalMs !== undefined)
      this.raw.progressIntervalMs = this.config.progressIntervalMs;
    if (this.raw.progressMinChars === undefined && this.config.progressMinChars !== undefined)
      this.raw.progressMinChars = this.config.progressMinChars;
    this.writeConfigAtomic(JSON.stringify(this.raw, null, 2) + "\n");
  }

  /**
   * Coalesce config writes. #144.
   *
   * Boot calls `addAgent` for every configured agent, and any agent whose recorded
   * session is gone mints a new one — which calls `recordSession` → `saveConfig`.
   * A machine with 30 agents therefore rewrote the whole file 30 times before the
   * server listened, and each was a window in which the file could be truncated.
   *
   * With the write now atomic that is no longer dangerous, but it is still 30
   * unnecessary writes of a 148KB file. During boot, saves are marked dirty and
   * flushed ONCE at the end. Outside boot (an edit, a spawn, a rename) behaviour is
   * unchanged: synchronous and immediate.
   */
  private deferConfigWrites = false;
  private configDirty = false;
  /**
   * Endpoints whose catalogue boot has already WAITED for (#143).
   *
   * The wait must be paid once per endpoint, not once per agent. `Promise.race`
   * against a timeout is per-CALL: with a dead endpoint every agent on it paid
   * the full timeout again, because the shared request was still pending. 493
   * agents over one unreachable provider measured 4.4s of boot spent purely
   * idle, for a single request.
   */
  private metaWaited = new Set<string>();
  /**
   * #143: `TEAPOT_DATA_DIR` points somewhere other than the config's own dataDir,
   * so session pointers must not be written back (see dataDirOverrideMismatch).
   */
  private sessionsReadOnly = false;

  /** write once and clear the dirty flag — used at the end of a batched section */
  private flushConfig(): void {
    this.configDirty = false;
    this.saveConfig();
  }

  /** write-and-rename, so config.json is never observed empty or half-written */
  /**
   * The shared pool for a provider, created on first use (#170).
   *
   * Cached so the cooldown state survives across agents AND across a provider being
   * re-read: rebuilding the pool on every spawn would forget that a key is cooling
   * down and hand it straight back out. Rebuilt only if the KEY LIST changes (the
   * operator edited the provider), which is when the old cooldowns stop being
   * meaningful.
   */
  private keyPoolFor(name: string, prov: ProviderConfig | undefined): KeyPoolState | undefined {
    const keys = providerKeys(prov);
    if (keys.length === 0) return undefined;
    const existing = this.keyPools.get(name);
    // reuse while the KEY LIST is unchanged, so the pool keeps its position in the
    // cycle across spawns; a changed list is a new pool
    if (existing && existing.keys.length === keys.length && existing.keys.every((k, i) => k === keys[i])) {
      return existing;
    }
    const pool = makeKeyPool(keys);
    this.keyPools.set(name, pool);
    return pool;
  }

  /**
   * Diagnostics: each provider's keys and which one is in use.
   *
   * Deliberately shows only position, not "spent until" timestamps: this pool has no
   * such state — a key is rotated past once its retries are spent, and a new turn
   * starts the cycle again.
   */
  keyPoolReport(): { provider: string; keys: number; current: number }[] {
    return [...this.keyPools.entries()].map(([provider, pool]) => ({
      provider,
      keys: pool.keys.length,
      current: pool.current,
    }));
  }

  /** start every provider's cycle over from its first key */
  resetKeyPool(provider?: string): void {
    const names = provider ? [provider] : [...this.keyPools.keys()];
    for (const n of names) {
      const pool = this.keyPools.get(n);
      if (pool) resetPool(pool);
    }
  }

  private writeConfigAtomic(body: string): void {
    // #144: `/dev/null` is a real, intentional value here — many callers (and
    // every test that does not care about persistence) pass it as "no config
    // file". The old `writeFileSync("/dev/null", …)` succeeded and discarded.
    //
    // Atomic writing cannot honour that: the temp file would be
    // `/dev/.config.json.tmp-…`, which is EACCES for a normal user, so 22 tests
    // failed with a bare 400 from POST /api/agents. Keep the old behaviour for a
    // non-regular target, and only do write-rename where rename means something.
    if (!isRegularFileTarget(this.configPath)) {
      writeFileSync(this.configPath, body);
      return;
    }
    const dir = path.dirname(this.configPath);
    // same directory as the target, so rename() stays within one filesystem
    const tmp = path.join(dir, `.config.json.tmp-${process.pid}-${Date.now()}`);
    let fd: number | undefined;
    try {
      fd = openSync(tmp, "w");
      writeFileSync(fd, body);
      // fsync BEFORE the rename: without it the rename can land while the data is
      // still in the page cache, which is the same data-loss window on a crash
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      renameSync(tmp, this.configPath);
    } catch (err) {
      if (fd !== undefined) {
        try {
          closeSync(fd);
        } catch {
          /* already closed */
        }
      }
      try {
        unlinkSync(tmp);
      } catch {
        /* nothing to clean up */
      }
      // Losing the new state is survivable; losing the file is not, so rethrow
      // rather than pretending the save succeeded
      throw err;
    }
  }
  private raw: Record<string, unknown> = loadedRaw();

  /** Apply partial config edits from the web UI and persist them. */
  updateConfig(patch: {
    providers?: Record<string, ProviderConfig>;
    defaultProvider?: string;
    progressIntervalMs?: number;
    progressMinChars?: number;
    contextTokenBudget?: number | null;
    contextWindowTokens?: number | null;
    maxSpawnDepth?: number;
    maxTurnsPerRound?: number;
    onError?: "stop" | "retry";
    retryDelayMs?: number;
    tasks?: TaskConfig[];
    mcpServers?: McpServerConfig[];
  /**
   * Short-context mode (#161): prune old tool output early instead of waiting for the
   * window to fill. Opt-in — on a large window it discards information you had room
   * for. Meant for 32k–262k models.
   */
  shortContext?: boolean;
  /**
   * Directory of Agent Plugins (#162), each a subdirectory with `plugin.json`.
   * Defaults to `<config dir>/plugins`. `false` disables plugin discovery.
   *
   * A plugin contributes SKILLS (its `skills/` becomes a skill root) and MCP servers
   * (from its `mcp.json`) — the two component types the format defines that teapot
   * has something to attach them to.
   */
  pluginsDir?: string | false;
  /**
   * The `/api/*` shared secret. `""` clears it (loopback-only trust).
   *
   * Read DYNAMICALLY by `apiToken()`, so a change takes effect on the next request with no restart —
   * which is the point: the operator sets it here, the panel starts sending `Authorization`, and an
   * open server closes without dropping the session.
   */
  password?: string;
  }): void {
    if (patch.providers) this.config.providers = patch.providers;
    /**
     * `!== undefined`, so `""` is honoured as "clear it".
     *
     * A truthiness check would silently keep the old password when the operator emptied the field,
     * which is the one case where they are explicitly asking to remove the protection.
     */
    if (patch.password !== undefined) this.config.password = patch.password || undefined;
    if (patch.defaultProvider !== undefined) this.config.defaultProvider = patch.defaultProvider;
    if (patch.progressIntervalMs !== undefined) {
      this.config.progressIntervalMs = patch.progressIntervalMs;
      for (const a of this.agents.values())
        (a as unknown as { opts: { progressIntervalMs: number } }).opts.progressIntervalMs =
          patch.progressIntervalMs;
    }
    if (patch.progressMinChars !== undefined) {
      this.config.progressMinChars = patch.progressMinChars;
      for (const a of this.agents.values())
        (a as unknown as { opts: { progressMinChars: number } }).opts.progressMinChars =
          patch.progressMinChars;
    }
    // explicit null clears a previously saved budget → back to per-model
    // derivation (75% of each agent's known window); a positive number pins it
    if (patch.contextTokenBudget !== undefined) {
      this.config.contextTokenBudget =
        (patch.contextTokenBudget ?? 0) > 0 ? patch.contextTokenBudget! : undefined;
    }
    if (patch.maxSpawnDepth !== undefined) this.config.maxSpawnDepth = patch.maxSpawnDepth;
    // #67: the registry is applied by the caller (it also connects); this only
    // records the list so a restart comes back with the same servers.
    if (patch.mcpServers !== undefined) this.config.mcpServers = patch.mcpServers;
    if (patch.shortContext !== undefined) {
      this.config.shortContext = patch.shortContext;
      // apply to LIVE agents too: the mode is read every turn, so a restart should not
      // be the price of switching it
      for (const a of this.agents.values())
        (a as unknown as { opts: { shortContext?: boolean } }).opts.shortContext =
          patch.shortContext;
    }
    if (patch.maxTurnsPerRound !== undefined) this.config.maxTurnsPerRound = patch.maxTurnsPerRound;
    if (patch.onError !== undefined) this.config.onError = patch.onError;
    if (patch.retryDelayMs !== undefined) this.config.retryDelayMs = patch.retryDelayMs;
    // #PUT-config: an explicit null clears a saved window pin → back to
    // per-model inference; a positive number pins it (same contract as
    // contextTokenBudget above)
    if (patch.contextWindowTokens !== undefined) {
      this.config.contextWindowTokens =
        (patch.contextWindowTokens ?? 0) > 0 ? patch.contextWindowTokens! : undefined;
    }
    // persist the scalar edits: saveConfig only mirrors agents/providers/etc.
    // into raw, so these would otherwise pass validation, live for one
    // process, and silently vanish from the file (a restart resurrected the
    // old values). undefined DELETES the key so a null-clear also persists.
    for (const k of [
      "contextTokenBudget", "contextWindowTokens", "maxSpawnDepth",
      "maxTurnsPerRound", "onError", "retryDelayMs",
    ] as const) {
      const v = this.config[k];
      if (v === undefined) delete this.raw[k];
      else this.raw[k] = v;
    }
    if (patch.tasks) {
      this.config.tasks = patch.tasks;
      // rebuild schedule table live
      this.tasks = patch.tasks.map((t) => ({
        task: t,
        schedule: parseSchedule(t.schedule),
        lastRunMin: t.lastRunMin ?? -1,
      }));
    }
    this.saveConfig();
  }

  /**
   * Load Agent Plugins (#162) and merge their MCP servers with the configured ones.
   *
   * Separate from `start()` so it can be exercised without booting a server: this is
   * where plugin servers get QUALIFIED with their plugin name, and a naming collision
   * here silently makes one plugin's tools disappear.
   */
  async loadPluginsAndMcp(): Promise<McpServerConfig[]> {
    const pluginMcp: McpServerConfig[] = [];
    if (this.config.pluginsDir !== false) {
      const dir = this.config.pluginsDir ?? path.join(CONFIG_DIR, "plugins");
      const { plugins, errors } = await loadPlugins(dir, path.join(DATA_DIR, "plugin-data"));
      this.plugins = plugins;
      for (const e of errors) console.error(`[teapot] skipping plugin ${e.dir}: ${e.error}`);
      for (const p of plugins) {
        for (const w of p.warnings) console.error(`[teapot] plugin "${p.name}": ${w}`);
        // QUALIFY each server with its plugin name. A plugin's own `mcp.json` names its
        // servers locally ("db"), and two plugins may each have one — the registry keys
        // by name, so an unqualified collision would silently replace one with the other
        // and its tools would appear to vanish. The plugin name is the natural prefix.
        pluginMcp.push(...p.mcpServers.map((s) => ({ ...s, name: `${p.name}:${s.name}` })));
      }
      if (plugins.length)
        console.error(
          `[teapot] loaded ${plugins.length} plugin(s): ${plugins.map((p) => p.name).join(", ")}`,
        );
    }
    return [...(this.config.mcpServers ?? []), ...pluginMcp];
  }

  async start(): Promise<void> {
    mkdirSync(this.config.dataDir, { recursive: true });
    // #144: ONE config write for the whole boot instead of one per agent.
    //
    // Every agent whose recorded session is gone mints a new one, and minting
    // calls recordSession → saveConfig. With ~30 configured agents the user's log
    // showed ~30 "session … is gone" lines, and therefore ~30 full rewrites of a
    // 148KB config.json — all before the server ever listened. That is the window
    // in which Ctrl-C emptied the file.
    //
    // `finally` so a throw mid-boot still flushes what it already changed: a
    // deferred write that never flushes would leave config.json describing the PREVIOUS
    // boot, which is its own silent data loss.
    this.deferConfigWrites = true;
    this.configDirty = false;
    // #143: start every endpoint's model-catalogue lookup NOW, concurrently.
    //
    // `addAgent` awaits this per agent, and the endpoints are shared by many
    // agents (493 agents over 6 providers here). Fired up front, the requests
    // overlap and each subsequent agent finds the promise already in flight or
    // resolved — instead of the requests being serialised behind the agent loop,
    // where a slow endpoint's timeout is paid again and again.
    this.prefetchModelLists();
    // #67: connect configured MCP servers in the background. Deliberately NOT
    // awaited: a slow or unreachable server must not delay listening, and its tools
    // appear as the connection lands (an agent's next turn picks them up because
    // `allToolSpecs()` reads the registry each call).
    // #162: Agent Plugins contribute skill roots and MCP servers. Loaded BEFORE the
    // MCP connect below so a plugin's servers connect in the same pass as configured
    // ones, and before any agent starts so its skills are discoverable on turn one.
    if (this.config.mcpServers?.length || this.config.pluginsDir !== false) {
      // OAuth grants live beside the data, not in config.json (a refresh token is a
      // credential, and config.json is the file operators copy around). Must be pointed
      // at the data dir BEFORE any server connects, or a stored grant is invisible.
      mcp.init(this.config.dataDir);
      const allMcp = await this.loadPluginsAndMcp();
      if (allMcp.length) {
        mcp.apply(allMcp);
        void mcp.connectAll();
      }
    }
    try {
      for (const ac of this.config.agents) {
        // archived agents keep their config entry and their history but do not run;
        // starting one would spend a provider request and mint/rewrite a session for
        // something the operator deliberately put away.
        if (ac.archived) continue;
        try {
          await this.addAgent(ac);
        } catch (err) {
          // one bad entry (duplicate id, unknown provider, …) must not take the
          // whole master down — skip it loudly and keep serving the rest
          console.error(`[teapot] skipping agent "${ac.id}": ${(err as Error).message}`);
        }
      }
      for (const t of this.config.tasks ?? []) {
        try {
          this.tasks.push({
            task: t,
            schedule: parseSchedule(t.schedule),
            lastRunMin: t.lastRunMin ?? -1,
          });
        } catch (err) {
          // a hand-edited schedule typo must not stop the server from listening
          console.error(`[teapot] skipping task "${t.id}": ${(err as Error).message}`);
        }
      }
    } finally {
      this.deferConfigWrites = false;
      if (this.configDirty) this.flushConfig();
    }
    // single low-frequency tick for everything periodic (idle cost ≈ 0)
    setInterval(() => void this.tick(), 15_000).unref();
  }

  /**
   * First-run wizard bootstrap: write a minimal config file, apply it to the
   * running master, and optionally create + start the first agent. Only
   * available while no config file exists — after this, edits go through
   * PUT /api/config behind whatever auth is configured.
   */
  async applySetup(body: {
    baseUrl: string;
    apiKey?: string;
    model: string;
    defaultProvider?: string;
    workspace?: string;
    agentName?: string;
    password?: string;
  }): Promise<{ ok: true; agentId?: string }> {
    if (this.configFileExists)
      throw new Error("setup already completed — edit the config file instead");

    const llm = {
      baseUrl: body.baseUrl,
      ...(body.apiKey ? { apiKey: body.apiKey } : {}),
      model: body.model,
    };
    const raw: Record<string, unknown> = {
      llm,
      ...(body.password ? { password: body.password } : {}),
      agents: [] as unknown[],
    };

    const dir = path.dirname(this.configPath);
    mkdirSync(dir, { recursive: true });
    writeFileSync(this.configPath, JSON.stringify(raw, null, 2) + "\n");

    // hot-apply to the running master (no restart needed)
    this.config.llm = { ...this.config.llm, ...llm };
    if (body.password) this.config.password = body.password;
    this.configFileExists = true;
    this.raw.llm = llm;
    if (body.password) this.raw.password = body.password;
    // learn the window size up front so compaction derives 75% of it
    try {
      const list = await fetchModelList(llm.baseUrl, body.apiKey);
      const cl = contextLengthFor(list, llm.model);
      if (cl) {
        this.config.contextWindowTokens = cl;
        this.raw.contextWindowTokens = cl;
        raw.contextWindowTokens = cl; // also persist into the fresh config file
        writeFileSync(this.configPath, JSON.stringify(raw, null, 2) + "\n");
      }
    } catch {
      /* metadata is best-effort */
    }

    let agentId: string | undefined;
    if (body.workspace?.trim()) {
      const ws = resolveWorkspace(body.workspace, path.dirname(this.configPath));
      await mkdirSync(ws, { recursive: true });
      const name =
        (body.agentName?.trim() || path.basename(ws))
          .replace(/[^\w.-]/g, "-")
          .slice(0, 40) || "agent";
      let id = name;
      let n = 2;
      while (this.agents.has(id)) id = `${name.slice(0, 38)}-${n++}`;
      const agent = await this.addAgent(
        { id, workspace: ws },
        { persist: true, fresh: true },
      );
      agentId = id;
      agent.start("created by setup wizard");
    }
    return { ok: true, agentId };
  }

  /**
   * Create an agent; optionally persist it to the config file.
   * Each incarnation gets its own session directory under
   * <dataDir>/sessions/<agentId>-<uuid>/ (chat.jsonl, goal.md, memory.md).
   * Restarts reuse the latest existing session; fresh creations never touch
   * an older one's history.
   */
  /**
   * Fire the model-catalogue lookup for every distinct endpoint, concurrently.
   *
   * `fetchModelList` already shares an in-flight request per baseUrl, so this is
   * about STARTING them together: without it the requests begin one at a time, as
   * the agent loop reaches each provider, and a slow endpoint's timeout is paid
   * serially by every agent on it.
   *
   * Best-effort by design — nothing awaits this. A failure is cached briefly by
   * `fetchModelList`, and an agent whose lookup is not ready simply gets no
   * inferred window, which is the same outcome as today's timeout.
   */
  private prefetchModelLists(): void {
    const endpoints = new Set<string>();
    const add = (baseUrl?: string, apiKey?: string): void => {
      if (!baseUrl) return;
      const key = baseUrl.replace(/\/+$/, "");
      if (endpoints.has(key)) return;
      endpoints.add(key);
      void fetchModelList(baseUrl, apiKey).catch(() => []);
    };
    for (const ac of this.config.agents) {
      const prov = this.config.providers?.[ac.provider ?? this.config.defaultProvider ?? ""];
      add(ac.baseUrl ?? prov?.baseUrl ?? this.config.llm.baseUrl, ac.apiKey ?? prov?.apiKey ?? this.config.llm.apiKey);
    }
    // no configured agents yet (first-run wizard) — still warm the default so the
    // first created agent does not wait
    if (endpoints.size === 0) add(this.config.llm.baseUrl, this.config.llm.apiKey);
  }

  async addAgent(
    ac: AgentConfig,
    opts: { persist?: boolean; fresh?: boolean } = {},
  ): Promise<Agent> {
    // #72: an agent id becomes a DIRECTORY name (sessions/<id>-<hash>), so it
    // must be a safe path segment. Every caller sanitised its own id — the HTTP
    // route, spawnChildFor's child name — except the ACP adapter, which passed
    // the raw client string through, so `session/load {"sessionId":"../../x"}`
    // created an agent logged outside <dataDir>/sessions/.
    //
    // Sanitised HERE as well as at the call sites: this is the one place that
    // guarantees the property, so a future caller cannot reintroduce the escape
    // by forgetting. A caller that already sanitised is unaffected — the
    // transform is idempotent on a safe id.
    const safeId = sanitizeAgentId(ac.id);
    if (safeId !== ac.id) {
      console.warn(`[teapot] agent id ${JSON.stringify(ac.id)} contained unsafe characters; using ${JSON.stringify(safeId)}`);
    }
    ac = { ...ac, id: safeId };
    if (this.agents.has(ac.id)) throw new Error(`agent id already exists: ${ac.id}`);
    // provider resolution: inline overrides > named provider > legacy llm block
    const provName = ac.provider ?? this.config.defaultProvider ?? "openrouter";
    const prov = this.config.providers?.[provName];
    if (!prov && !ac.baseUrl && !this.config.llm.baseUrl) {
      throw new Error(`agent ${ac.id}: unknown provider "${provName}" and no fallback`);
    }
    // #170: an INLINE `ac.apiKey` is this agent's own credential, so it must NOT be
    // joined to the provider's pool — the pool belongs to the named provider, and
    // folding a one-off override in would rotate an agent onto keys its operator did
    // not choose for it. Only the named provider gets a pool.
    const inlineKey = typeof ac.apiKey === "string" && ac.apiKey.trim() ? ac.apiKey.trim() : undefined;
    const pool = inlineKey ? undefined : this.keyPoolFor(provName, prov);
    const llm: LlmConfig = {
      baseUrl: ac.baseUrl ?? prov?.baseUrl ?? this.config.llm.baseUrl!,
      // the pool's CURRENT key is the sticky one: a restart must resume on the
      // account the operator's cycle had reached, not start over on a spent first one
      apiKey:
        inlineKey ??
        currentKey(pool) ??
        prov?.apiKey ??
        this.config.llm.apiKey!,
      model: ac.model ?? prov?.model ?? this.config.llm.model!,
      timeoutMs: 120_000,
      ...(pool && pool.keys.length > 1 ? { keyPool: pool } : {}),
    };
    if (!llm.model) throw new Error(`agent ${ac.id}: no model configured (set model on the agent or on its provider)`);
    // spawn-tree depth: computed from the config chain (ac may not be
    // registered yet when this runs — spawnChildFor persists AFTER creation)
    const myDepth = ac.parent ? this.depthOf(ac.parent) + 1 : 0;
    // Model metadata: the context window (for the compaction budget) and the
    // catalogue entry that gates reasoning_effort support (#47) come from the
    // SAME `/models` list.
    //
    // #143: boot must not WAIT for this. It only tunes the compaction budget and
    // the effort controls, so a missing list costs nothing that matters; what it
    // cost was boot time — measured at 4.4s of pure idle on 493 agents pointed at
    // one unreachable endpoint, because the `Promise.race` timeout below is
    // per-CALL and the shared request stayed pending for every agent.
    //
    // So: use the catalogue if `prefetchModelLists()` has already produced it
    // (the common case — the lookups were fired when boot started), and wait only
    // ONCE per endpoint for the stragglers, where the wait overlaps a request
    // that is already in flight.
    const needsWindow = !ac.contextWindowTokens && !this.config.contextWindowTokens;
    const root = llm.baseUrl.replace(/\/+$/, "");
    let list = peekModelList(llm.baseUrl);
    if (list === undefined && !this.metaWaited.has(root)) {
      this.metaWaited.add(root);
      list = await Promise.race([
        fetchModelList(llm.baseUrl, llm.apiKey),
        // a placeholder so the race can settle without the list
        new Promise<undefined>((r) => setTimeout(() => r(undefined), MODEL_META_BOOT_MS)),
      ]);
    }
    const inferredWindow = needsWindow && list ? contextLengthFor(list, llm.model) : undefined;
    const modelMeta = list?.find((m) => m.id === llm.model);
    const sessionDir = this.resolveSessionDir(ac.id, opts.fresh === true);
    await mkdirSync(sessionDir, { recursive: true });
    // every session dir this master hands out carries an ownership manifest —
    // legacy dirs get backfilled on their first restart under the new code
    this.writeSessionManifest(sessionDir, ac.id);
    const agent = new Agent({
      id: ac.id,
      workspace: resolveWorkspace(ac.workspace, path.dirname(this.configPath)),
      llm,
      sessionDir,
      progressIntervalMs: this.config.progressIntervalMs,
      ...(this.config.progressMinChars ? { progressMinChars: this.config.progressMinChars } : {}),
      ...(this.config.maxTurnsPerRound !== undefined ? { maxTurnsPerRound: this.config.maxTurnsPerRound } : {}),
      ...(this.config.onError ? { onError: this.config.onError } : {}),
      ...(this.config.retryDelayMs ? { retryDelayMs: this.config.retryDelayMs } : {}),
      autoContinue: ac.autoContinue ?? true,
      // BUG found while wiring #161: `autoCompact` was a field on AgentConfig and on
      // AgentOptions, but nothing ever carried it between the two — so a configured
      // `"autoCompact": false` was silently ignored and compaction stayed on. Passed
      // here for the same reason as shortContext: a config knob that does nothing is
      // worse than no knob.
      ...(ac.autoCompact === false ? { autoCompact: false } : {}),
      // #161: per-agent choice, else the global default. This mode DISCARDS information
      // early by design, so it must never switch on by accident.
      ...((ac.shortContext ?? this.config.shortContext) ? { shortContext: true } : {}),
      ...(this.config.contextTokenBudget ? { contextTokenBudget: this.config.contextTokenBudget } : {}),
      ...(ac.contextWindowTokens || this.config.contextWindowTokens || inferredWindow
        ? {
            contextWindowTokens: (
              ac.contextWindowTokens ??
              this.config.contextWindowTokens ??
              inferredWindow
            )!,
          }
        : {}),
      globalSkillsDir: path.join(CONFIG_DIR, "skills"),
      bundledSkillsDir: BUNDLED_SKILLS_DIR,
      // #162: a plugin's own skills/ is a skill root, ranked with the global ones so
      // a workspace skill still wins on a name clash
      pluginSkillRoots: this.plugins
        .filter((p) => p.skillsDir)
        .map((p) => ({ dir: p.skillsDir!, source: `plugin:${p.name}` })),
      provider: provName,
      spawnDepth: myDepth,
      ...(ac.readOnly ? { readOnlyTools: true } : {}),
      ...(ac.parent ? { parent: ac.parent } : {}),
      ...(ac.chatFn ? { chatFn: ac.chatFn } : {}),
      // #47: reasoning effort is a per-agent choice; the catalogue decides
      // whether it can actually be sent (see effortForRequest)
      ...(ac.reasoningEffort ? { reasoningEffort: ac.reasoningEffort } : {}),
      ...(modelMeta?.supportedParameters
        ? { supportedParameters: modelMeta.supportedParameters }
        : {}),
      // #150: the model's own reasoning levels, so the picker offers exactly those
      ...(modelMeta?.supportedEfforts?.length ? { supportedEfforts: modelMeta.supportedEfforts } : {}),
    });
    // pricing metadata (USD/token) for the runtime cost estimate — best
    // effort: providers without pricing in /models simply show no cost
    void fetchModelList(llm.baseUrl, llm.apiKey)
      .then((list) => agent.setModelPricing(list.find((m) => m.id === llm.model)?.pricing))
      .catch(() => {});
    // console line + broadcast: the web UI only refreshes on bus traffic, so
    // every appended event must reach it (otherwise messages sit invisible
    // until an unrelated status change happens to fire)
    agent.log.onEvent = (e) => {
      printAgentEvent(e);
      bus.emit("update", { kind: "event", agentId: e.agent, event: e } satisfies BusEvent);
      this.onChildEvent(ac, e);
    };
    // #126: the CONTROL PLANE, separate from the event pipeline above.
    //
    // `onChildEvent` used to be what woke a parent's `wait_children`, and it runs
    // after the event is persisted. So a failed or slow write left the parent
    // parked forever — measured with every write failing, the wake never fired.
    //
    // A status change is CONTROL FLOW, not an observation, so it gets its own
    // immediate path. `onChildEvent` keeps its other job (mirroring the child's
    // activity into the parent's timeline, forwarding its final report), which
    // legitimately belongs to the event stream.
    agent.onControlStatusChange = (agentId, status) => {
      if (!ac.parent) return;
      const parent = this.agents.get(ac.parent);
      if (!parent) return;
      // the waiter re-checks whether ITS targets are all settled, so waking on
      // every movement is correct and cheap. ANCESTORS too: a waiter's targets
      // now span the whole subtree, so a grandchild's movement must reach it.
      this.wakeAncestorWaiters(ac.parent);
      // #130: report only a SETTLED child, never its birth. A freshly spawned
      // child is `idle` before `start()` runs, so that first idle->running flip
      // would tell the parent "@kid is now idle" the instant it existed.
      // Requiring a prior `running` is what filters it out; the wake above is
      // unconditional, so `wait_children` is unaffected.
      //
      // #135: the wording addresses the CHILD's outcome, not the parent's goal.
      // "Continue your task, or finish()..." invited the parent to finish its own
      // goal over a child's status; the child's report already states what
      // happened, so this points at it instead.
      if (this.reportedRunning.has(agentId) && SETTLED.has(status))
        parent.enqueuePrompt(
          `[harness] Sub-agent @${agentId} is now ${status} without having called finish(), so it has not reported a result.` +
            (status === "error"
              ? ` Check its last output before deciding whether to re-spawn it.`
              : status === "stopped"
                ? ` It may have been stopped mid-task; message it to resume, or re-spawn it.`
                : ` If you expected a result, message it or re-spawn it.`),
          "harness",
        );
      if (status === "running") this.reportedRunning.add(agentId);
      else if (SETTLED.has(status)) this.reportedRunning.delete(agentId);
    };
    // sub-agent management hooks — only when this agent can legally spawn
    if (myDepth < this.maxSpawnDepth()) {
      const self = agent;
      const hooks = {
        depth: myDepth,
        spawn: (o: { task: string; context: "none" | "fork"; name?: string; persona?: string }) =>
          this.spawnChildFor(self, o),
        list: () =>
          // DIRECT children are the ones this agent can address (stop/message are
          // refused for anything deeper), but a descendant still working is
          // invisible to the parent unless it is LISTED — and the parent then
          // resumes over it. So the whole subtree is listed, each row naming its
          // own `parent` and flagged `nested`, which is what tells the model who
          // to address instead of guessing a level (the error `message_agent`
          // raises names the owner for the same reason).
          this.subtreeOf(ac.id).flatMap(({ id, depth, parent }) => {
            const inst = this.agents.get(id);
            if (!inst) return []; // suspended: not addressable, so not listed
            return [
              {
                id,
                status: inst.status,
                goal: inst.goal.text,
                parent,
                nested: depth > 1,
              },
            ];
          }),
        stop: (ids?: string[]) => this.stopChildrenFor(ac.id, ids),
        message: (id: string, text: string) => this.messageChild(ac.id, id, text),
        wait: (ids: string[] | undefined, ms: number) =>
          // wire the parent's tool-abort signal: a user stop / dispose must
          // interrupt the park immediately instead of leaving the run chain
          // blocked until the full timeout (up to 1h)
          this.waitChildren(ac.id, ids, ms, self.toolCtx.signal),
      };
      (
        agent as unknown as {
          toolCtx: { subAgents: typeof hooks };
        }
      ).toolCtx.subAgents = hooks;
    }
    await agent.init();
    this.agents.set(ac.id, agent);
    if (opts.persist) {
      this.config.agents.push(ac);
      this.saveConfig();
    }
    // Remember which session this agent is bound to, so a restart reattaches
    // deterministically instead of re-guessing from directory mtimes (#39).
    // Done for EVERY agent (persisted or spawned): a spawned child is re-created
    // on boot too, and guessing there is the same resurrection bug.
    this.recordSession(ac, path.basename(sessionDir));
    return agent;
  }

  /** Persist an agent's current session id into the config, if it changed. */
  private recordSession(ac: AgentConfig, sessionId: string): void {
    if (!sessionId || ac.session === sessionId) return;
    ac.session = sessionId;
    const entry = this.config.agents.find((a) => a.id === ac.id);
    if (!entry) return; // not a configured agent — nothing to persist yet
    entry.session = sessionId;
    // #143: never write session pointers into a config that is describing another
    // data dir — every one of them would be wrong, and the correct mapping is
    // destroyed. The in-memory session above still works for this process.
    if (this.sessionsReadOnly) return;
    this.saveConfig();
  }

  /** spawn-tree depth of an agent (0 = top level); unknown → 0 */
  private depthOf(id: string, seen = new Set<string>()): number {
    const cap = this.maxSpawnDepth();
    let depth = 0;
    let cur = this.config.agents.find((a) => a.id === id);
    while (cur?.parent && !seen.has(cur.id) && depth < cap + 2) {
      seen.add(cur.id);
      cur = this.config.agents.find((a) => a.id === cur!.parent);
      depth++;
    }
    return depth;
  }

  /** configured nesting limit (config.maxSpawnDepth, default 3) */
  private maxSpawnDepth(): number {
    const v = this.config.maxSpawnDepth;
    return typeof v === "number" && v >= 0 ? v : MAX_SPAWN_DEPTH;
  }

  /** direct children of an agent, with their Agent instances */
  private childrenOf(id: string): { id: string; agent: Agent }[] {
    const kids = this.config.agents.filter((a) => a.parent === id);
    const out: { id: string; agent: Agent }[] = [];
    for (const k of kids) {
      const inst = this.agents.get(k.id);
      if (inst) out.push({ id: k.id, agent: inst });
    }
    return out;
  }

  /**
   * Every configured descendant of `id`, at any depth, with its depth (1 = direct
   * child) and its own parent id.
   *
   * A parent's work is not finished while anything it caused is still running,
   * and that includes a sub-agent's sub-agent: C can delegate to G and return its
   * own turn, leaving C idle while G works. Deciding from DIRECT children alone
   * therefore let an ancestor report "all settled" over a live grandchild — the
   * reported "it delegates further and the parent never knows".
   *
   * Returns configured ids (not instances) so a suspended descendant still counts
   * as part of the subtree. `seen` guards a cycle in `parent`.
   */
  private subtreeOf(id: string, depth = 1, seen = new Set<string>()): { id: string; depth: number; parent: string }[] {
    const out: { id: string; depth: number; parent: string }[] = [];
    for (const a of this.config.agents) {
      if (a.parent !== id) continue;
      if (seen.has(a.id)) continue;
      seen.add(a.id);
      out.push({ id: a.id, depth, parent: id }, ...this.subtreeOf(a.id, depth + 1, seen));
    }
    return out;
  }

  /** the ids of every descendant of `id`, at any depth */
  private descendantsOf(id: string, seen = new Set<string>()): string[] {
    return this.subtreeOf(id, 1, seen).map((x) => x.id);
  }

  /**
   * Create a sub-agent on behalf of `parent`. context "fork" writes a
   * sub_fork header into the child log pointing at the parent's current
   * tip — the parent's history is NEVER copied into the child's file; the
   * child resolves it at restore time.
   */
  async spawnChildFor(
    parent: Agent,
    o: {
      task: string;
      context: "none" | "fork";
      name?: string;
      persona?: string;
      /** #105: per-spawn effort; highest-precedence step of the chain below */
      reasoning_effort?: string;
    },
  ): Promise<{ id: string }> {
    const parentId = parent.opts_id();
    const persona =
      o.persona && Object.prototype.hasOwnProperty.call(SUB_PERSONAS, o.persona)
        ? o.persona
        : undefined;
    const base = `${parentId}-sub${persona ? `-${persona}` : ""}${o.name ? `-${o.name.replace(/[^\w.-]/g, "-").slice(0, 24)}` : ""}`.slice(0, 60);
    let id = base;
    let n = 2;
    while (this.agents.has(id) || this.config.agents.some((a) => a.id === id))
      id = `${base.slice(0, 56)}-${n++}`;

    // persona directives shape how the sub approaches the task
    const directive = persona ? `${SUB_PERSONAS[persona].label}\n${SUB_PERSONAS[persona].directive}\n\n` : "";
    const pcfg = this.config.agents.find((a) => a.id === parentId);
    let forkTip: string | null | undefined;
    let forkBranch: string | undefined;
    if (o.context === "fork") {
      // capture the fork tip BEFORE creating the child (parent keeps running)
      forkTip = parent.log.lastEventId(parent.currentBranch);
      forkBranch = parent.currentBranch;
    }
    // #105: reasoning effort for the child.
    //
    // Precedence mirrors OpenAI Codex (codex-rs/core/src/agent/child_config.rs:
    // `requested.or_else(configured_default).or(parent)`):
    //
    //   1. the spawn argument        — explicit, per-call
    //   2. `defaultSubagentReasoningEffort` from config — a global backstop
    //   3. the parent's effort       — last resort
    //
    // Codex deliberately does NOT inherit by default, and its own test proves the
    // intent: parent at XHigh, spawn requests Low, and the child runs at Low
    // (codex-rs/core/tests/suite/subagent_notifications.rs). Sub-agents are
    // usually narrow and cheap, so inheriting a parent's `high` across twenty
    // trivial scouts multiplies cost and latency for no gain.
    //
    // Before this, `reasoningEffort` was simply omitted here while `provider`,
    // `model` and `contextWindowTokens` two lines below WERE inherited — so a
    // parent's effort vanished silently, with no way for a spawn to express one.
    const childEffort =
      o.reasoning_effort || this.config.defaultSubagentReasoningEffort || pcfg?.reasoningEffort;
    const child = await this.addAgent(
      {
        id,
        workspace: parent.workspace,
        provider: pcfg?.provider,
        model: pcfg?.model,
        contextWindowTokens: pcfg?.contextWindowTokens,
        // #105: persisted with the child, like every other inherited field, so a
        // restart restores the same effort rather than reverting to the default
        ...(childEffort ? { reasoningEffort: childEffort } : {}),
        parent: parentId,
        ...(persona && SUB_PERSONAS[persona]?.readOnly ? { readOnly: true } : {}),
      },
      { persist: true, fresh: true },
    );
    if (o.context === "fork" && forkTip) {
      await child.log.append("sub_fork", id, "br0", {
        parentAgent: parentId,
        parentSession: path.basename(parent.snapshot().sessionDir),
        parentBranch: forkBranch,
        upToEvent: forkTip,
      });
      // the inherited prefix becomes visible history for the child's loop
      child.importMessages(parent.exportMessages());
    }
    await child.setGoal(`${directive}${o.task}`.slice(0, 2000));
    // SCOPE GUARD: a forked child inherits the parent's whole conversation as
    // reference context — without an explicit boundary, models have been seen
    // "continuing" some EARLIER task that appears in that history instead of
    // the task they were actually spawned for. State the boundary twice
    // (goal + first prompt) so it survives goal-driven auto-continue.
    await child.enqueuePrompt(
      (o.context === "fork"
        ? `[harness] You are sub-agent ${id}, spawned by @${parentId}.

The conversation above is REFERENCE CONTEXT ONLY — background on why this work is needed.
It contains older tasks and discussions that are NOT yours. Do not resume, continue, or
finish any of them; other agents own those. If you find yourself working on anything other
than the task below, STOP and return to it.

YOUR ONE AND ONLY TASK — everything else in the inherited context is out of scope:

${directive}${o.task}

When this task is done (or truly blocked), call finish() with a summary for @${parentId}.`
        : `[harness] You are sub-agent ${id}, spawned by @${parentId}. Work solely on this task:\n\n${directive}${o.task}\n\nWhen it is done (or truly blocked), call finish() with a summary for @${parentId}.`),
      "harness",
    );
    child.start(`spawned by ${parentId}`);
    console.log(`[teapot] sub-agent ${id} spawned by ${parentId} (context: ${o.context ?? "none"}${persona ? `, persona: ${persona}` : ""})`);
    return { id };
  }

  /** Stop direct children (and their descendants by default) of an agent. */
  async stopChildrenFor(parentId: string, ids?: string[]): Promise<{ stopped: string[] }> {
    const stopped: string[] = [];
    // `inScope` is true once we are INSIDE a subtree we were asked to stop, and
    // stays true all the way down.
    //
    // #142: the old walk passed `ids` down unchanged, so after matching an
    // explicit id every DESCENDANT failed `ids.includes(id)` and was skipped —
    // which is why the explicit branch hand-rolled its own one-level loop, and
    // why that loop could not reach a great-grandchild.
    const walk = (pid: string, inScope: boolean) => {
      for (const { id, agent } of this.childrenOf(pid)) {
        const take = inScope || !ids || ids.includes(id);
        if (!take) {
          // out of scope, but its own subtree may hold something in scope
          walk(id, false);
          continue;
        }
        agent.stop("stopped by parent agent");
        stopped.push(id);
        // #142: RECURSE for both modes.
        //
        // The explicit-id branch used to iterate `childrenOf(id)` exactly once, so
        // a great-grandchild was never reached — stopping a child left its
        // grandchild's child running, indefinitely, still holding a model
        // connection and billing tokens:
        //
        //     root-sub           stopped
        //     root-sub-sub       stopped
        //     root-sub-sub-sub   running     <-- orphaned
        //
        // `walk` already means "this subtree", and it stops every node it visits,
        // so one code path serves both cases. The only difference between the two
        // modes is the `ids && !ids.includes(id)` test at the top, which decides
        // whether a node is in scope — not how deep the walk goes.
        walk(id, true);
      }
    };
    walk(parentId, false);
    return { stopped };
  }

  /** Deliver a parent's message into a child's mailbox (and wake it). */
  /**
   * Event-driven parking for a parent waiting on sub-agents: resolves as soon
   * as ANY listed child settles (finish/error/stop/waiting) — zero API cost
   * while parked. Falls back to a timeout so waits can never hang forever.
   */
  waitChildren(
    parentId: string,
    ids: string[] | undefined,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<{ note: string }> {
    // The whole DESCENDANT subtree, not just direct children: C can delegate to G
    // and return its own turn, so C reads idle while G works. Waiting on C must
    // therefore mean "C and everything C caused" — otherwise an ancestor resumes
    // over live work it cannot see (see descendantsOf).
    const named = ids && ids.length ? ids : this.descendantsOf(parentId);
    const targets = [...new Set(named.flatMap((id) => [id, ...this.descendantsOf(id)]))].filter((id) =>
      this.agents.has(id),
    );
    if (targets.length === 0)
      return Promise.resolve({ note: "no live sub-agents to wait for" });

    // isBusy(), not the raw status: parkForTool overwrites a parked child's
    // status to "idle" (spinner suppression) while its loop is very much
    // alive — the raw check counted that child as settled and let the parent
    // resume over unfinished work. isBusy() sees parked tools, compactions
    // and an open ask_user; queued prompts are DORMANT (isLive()'s "stop vs
    // start" extra) and must not hold the wait. A stop request reads settled.
    const active = () => targets.filter((id) => this.agents.get(id)?.isBusy());

    const first = active();
    if (first.length === 0)
      return Promise.resolve({ note: `all sub-agents already settled: ${targets.join(", ")}` });

    return new Promise((resolve) => {
      let done = false;
      const finish = (note: string) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        set.delete(wake);
        signal?.removeEventListener("abort", onAbort);
        resolve({ note });
      };
      const onAbort = () => finish("aborted while waiting");
      signal?.addEventListener("abort", onAbort, { once: true });
      const timer = setTimeout(() => {
        const left = active();
        finish(`timeout after ${Math.round(timeoutMs / 1000)}s — still running: ${left.join(", ") || "(none)"}`);
      }, timeoutMs);

      const wake = (_note?: string) => {
        const left = active();
        if (left.length > 0) return; // something is still working — keep parked
        clearTimeout(timer);
        finish(`all sub-agents settled: ${targets.join(", ")}`);
      };

      const set = this.childWaiters.get(parentId) ?? new Set();
      if (!this.childWaiters.has(parentId)) this.childWaiters.set(parentId, set);
      set.add(wake);
      // re-check immediately: children may have settled between snapshot & register
if (active().length === 0) wake();
    });
  }

  /** wake every waiter of a parent (child lifecycle event happened) */
  private wakeParentWaiters(parentId: string): void {
    const set = this.childWaiters.get(parentId);
    if (!set) return;
    for (const fn of set) {
      try { fn("child event"); } catch { /* ignore */ }
    }
  }

  /**
   * Wake the waiters of EVERY ancestor of an agent, not just its direct parent.
   *
   * A parked `wait_children` is woken by lifecycle events, and its targets now
   * span the whole subtree — so a grandchild settling has to reach the
   * grandparent, or the wake never arrives and the ancestor sits until its
   * timeout even though the work finished.
   *
   * `parentId` is passed in rather than looked up: the caller already has it, and
   * a spawned child that is not PERSISTED (a test, or a transient spawn) is absent
   * from `config.agents`, so a lookup would find no parent at all and the wake
   * would be silently skipped.
   */
  private wakeAncestorWaiters(parentId: string | undefined): void {
    const seen = new Set<string>();
    let cur = parentId;
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      this.wakeParentWaiters(cur);
      cur = this.config.agents.find((a) => a.id === cur)?.parent;
    }
  }

  private async messageChild(parentId: string, childId: string, text: string): Promise<void> {
    // childId is normally the live agent id — but an internal session id
    // (sessions/<id>, the stable timeline handle) also resolves, so callers
    // holding only a session reference can still reach the owning agent.
    let targetId = childId;
    const owned = this.sessionById(childId);
    if (owned) targetId = owned.agentId;

    // #132: a sub-agent must be able to message its OWN PARENT.
    //
    // The rule below only ever permitted parent -> child, so a child asking its
    // parent a question was refused with the actively misleading
    //
    //     not your sub-agent: p1. no such sub-agent exists.
    //
    // — naming the parent as nonexistent, when it is the caller's own parent and
    // plainly listed in config.agents. The parent link is the trust boundary: a
    // child may address its parent, a parent may address its children, and
    // NOTHING may address a sibling or an unrelated agent.
    const caller = this.config.agents.find((a) => a.id === parentId);
    const target = this.config.agents.find((a) => a.id === targetId);
    const childToParent = target?.parent === parentId;
    if (target && caller?.parent === targetId) {
      const p = this.agents.get(targetId);
      if (!p) throw new Error(`sub-agent not running: ${targetId}`);
      // mirrored wording, so the recipient knows who is writing
      p.enqueuePrompt(`[harness] Message from sub-agent @${parentId}:\n\n${text}`, "harness");
      if (p.status !== "running") p.start(`message from sub-agent ${parentId}`);
      return;
    }

    const cfg = target;
    if (!cfg || (!childToParent && cfg.parent !== parentId)) {
      // Scoping is correct — only the DIRECT parent may message a child, so a
      // grandchild is rightly refused. But "not your sub-agent: <id>" reads
      // like a bug when the agent simply guessed the wrong level of the tree.
      // Name the real owner so the model can re-address the message (#11).
      const actual = cfg?.parent;
      const live = actual ? this.agents.get(actual) : undefined;
      const detail = actual
        ? ` its parent is @${actual}${live ? ` (message @${actual} instead, or spawn your own sub-agent for it)` : ""}.`
        : " no such sub-agent exists.";
      throw new Error(`not your sub-agent: ${childId}.${detail}`);
    }
    const child = this.agents.get(targetId);
    if (!child) throw new Error(`sub-agent not running: ${targetId}`);
    child.enqueuePrompt(`[harness] Message from @${parentId}:\n\n${text}`, "harness");
    if (child.status !== "running") child.start(`message from ${parentId}`);
  }

  /**
   * Mirror interesting child events into the parent's timeline (tagged with
   * the acting sub id) and forward terminal outcomes to the parent's mailbox.
   */
  private onChildEvent(ac: { parent?: string; id: string }, e: { type: string; data: unknown; agent: string }): void {
    const parentId = ac.parent;
    if (!parentId) return;
    // any child lifecycle movement wakes a parked wait_children (the waiter
    // re-checks whether its targets are all settled) — ancestors included, since
    // a waiter's targets span its whole subtree
    this.wakeAncestorWaiters(parentId);
    const parent = this.agents.get(parentId!);
    if (!parent) return;

    // forward outcomes so the parent hears the result without polling
    if (e.type === "message" && (e.data as { final?: boolean; content?: string }).final) {
      const d = e.data as { content?: string; recentContext?: string[] };
      const summary = String(d.content ?? "").trim();
      // the finish() summary alone is often thin — the agent's last few real
      // conversation turns (findings, paths, numbers) carry the substance.
      // Include them so the parent can act without re-reading the child log.
      let report = summary;
      if (Array.isArray(d.recentContext) && d.recentContext.length) {
        report +=
          "\n\n[Last conversation turns before finishing]\n" +
          d.recentContext.map((r) => r).join("\n\n");
      }
      parent.enqueuePrompt(
        // NO truncation: the sub's report is the parent's primary input for
        // deciding what to do next. Clipping it (the old 2000/6000 caps)
        // silently dropped exactly the details the operator spawned the sub
        // to gather. Context management is compaction's job, not the pipe's.
        `[harness] Sub-agent ${ac.id} finished. Final report:\n${report || "(no summary)"}`,
        "harness",
      );
      // #123: a parent's report is delivered INTO a live agent — queueing it is
      // not enough. If the parent is idle (finished, or parked) the report sat in
      // the queue until something else started the loop, so the operator saw a
      // finished sub-agent and a parent that never reacted.
      if (parent.status !== "running") parent.start(`sub-agent ${ac.id} finished`);
    } else if (e.type === "error") {
      parent.enqueuePrompt(
        `[harness] Sub-agent ${ac.id} hit an error: ${String((e.data as { message?: string }).message ?? "").slice(0, 500)}`,
        "harness",
      );
      // #123: same for an error report
      if (parent.status !== "running") parent.start(`sub-agent ${ac.id} error`);
    }

    // #63: a child's activity is NOT mirrored into the parent's log. Mirroring
    // bought nothing — `sub` rows are display-only (`rebuildMessagesFrom` never
    // read them, so the model never saw them) and once they DID render (#40) the
    // parent's timeline was flooded with a child's transcript. What the parent
    // needs is the child's report, which already arrives as a harness prompt
    // above. A chat's timeline is its own.
  }

  /** sessions root + helpers */
  /**
   * Where session directories live.
   *
   * Public: it is the layout contract every part of the harness depends on, and a test
   * that plants a directory (a foreign manifest, an impostor owner) needs the same path
   * the master resolves rather than a re-derivation that can drift from it.
   */
  sessionsRoot(): string {
    return path.join(this.config.dataDir, "sessions");
  }

  /**
   * Session-dir ownership manifest (sessions/<dir>/session.json). Ownership
   * used to be GUESSED from the directory name's prefix, which is ambiguous:
   * agent "teapot" matches "teapot-3-<hash>", and sibling ids where one is a
   * prefix of the other ("prismrv-root-sub-review" vs
   * "…-review-kernel") excluded each other's own dirs — every restart then
   * generated a fresh empty session and history read as zero. The owner is
   * now recorded explicitly at creation time; legacy dirs without a manifest
   * fall back to longest-prefix inference and get one backfilled on first
   * touch.
   */
  private readSessionOwner(dirName: string): string | null {
    try {
      const raw = JSON.parse(readFileSync(path.join(this.sessionsRoot(), dirName, "session.json"), "utf8")) as {
        agentId?: unknown;
      };
      return typeof raw.agentId === "string" ? raw.agentId : null;
    } catch {
      return null; // legacy dir or unreadable manifest → fall back to names
    }
  }

  /**
   * Owner of a session dir — manifest first; legacy dirs are inferred from
   * the LONGEST configured/live id whose "<id>" or "<id>-<rest>" shape the
   * name matches. Returns {owner, hadManifest} so callers can backfill.
   */
  private inferSessionOwner(
    dirName: string,
    candidateIds: Iterable<string>,
  ): { owner: string | null; hadManifest: boolean } {
    const fromManifest = this.readSessionOwner(dirName);
    if (fromManifest) return { owner: fromManifest, hadManifest: true };
    let best: { id: string; len: number } | null = null;
    for (const id of candidateIds) {
      if (!id) continue;
      if ((id === dirName || dirName.startsWith(`${id}-`)) && (!best || id.length > best.len))
        best = { id, len: id.length };
    }
    return { owner: best?.id ?? null, hadManifest: false };
  }

  /**
   * Who does this session directory really belong to, according to its LOG?
   *
   * The manifest is a CACHE; the log is the truth. Every event carries the
   * `agent` that wrote it, and only that agent ever appends — so the first
   * event's value cannot be stale or wrong.
   *
   * This matters because ownership decided from the manifest ALONE is how a
   * whole data directory gets abandoned. A manifest that is missing, unreadable,
   * or simply wrong made `inferSessionOwner` reject every directory the agent
   * owned, `findLatestSessionDir` return null, and the boot mint a fresh empty
   * session — REWRITING the agent's pointer in config.json. Nothing warned, and
   * the real history was left on disk, orphaned and unreachable.
   *
   * Measured after an accidental in-place `addAgent()` run had rewritten 813
   * manifests: 493 agents were silently moved to empty sessions, and the
   * mapping back was only recoverable from these `agent` fields.
   */
  private logOwner(dirName: string): string | null {
    try {
      const first = readFileSync(path.join(this.sessionsRoot(), dirName, "chat.jsonl"), "utf8")
        .split("\n")
        .find((l) => l.trim());
      if (!first) return null;
      const parsed = JSON.parse(first) as { agent?: unknown };
      return typeof parsed.agent === "string" && parsed.agent ? parsed.agent : null;
    } catch {
      return null; // no log / unreadable head — cannot prove anything
    }
  }

  /**
   * A human title for a session dir, from its first user prompt (#155), or null.
   *
   * Reads in bounded chunks and stops at the FIRST prompt event of any source —
   * see the note in allSessions() for why that early exit is what makes this
   * affordable. A torn final line is skipped rather than parsed: a chunk boundary
   * can cut a JSON object in half, and that must not abort the scan.
   */
  private sessionTitleOf(dirPath: string): string | null {
    let fd: number | undefined;
    try {
      fd = openSync(path.join(dirPath, "chat.jsonl"), "r");
      const CHUNK = 16 * 1024;
      // cap per session so one enormous log cannot dominate boot
      const CAP = 256 * 1024;
      const buf = Buffer.alloc(CHUNK);
      let offset = 0;
      let carry = "";
      while (offset < CAP) {
        const n = readSync(fd, buf, 0, CHUNK, offset);
        if (n <= 0) break;
        offset += n;
        const lines = (carry + buf.subarray(0, n).toString("utf8")).split("\n");
        carry = lines.pop() ?? "";
        for (const l of lines) {
          if (!l) continue;
          let e: { type?: unknown; data?: { source?: unknown; text?: unknown } };
          try {
            e = JSON.parse(l) as typeof e;
          } catch {
            continue; // torn line at a chunk boundary
          }
          if (e.type !== "prompt") continue;
          // a sub-agent session receives only harness prompts and is labelled from
          // its id, so a harness prompt is not a title
          if (e.data?.source !== "user") return null;
          return sessionTitleFrom(typeof e.data.text === "string" ? e.data.text : null);
        }
      }
      return null;
    } catch {
      return null; // no log / unreadable — fall back to the id
    } finally {
      if (fd !== undefined)
        try {
          closeSync(fd);
        } catch {
          /* already closed */
        }
    }
  }

  private writeSessionManifest(dirPath: string, agentId: string): void {
    try {
      const file = path.join(dirPath, "session.json");
      if (existsSync(file)) {
        // A WRONG manifest must be repairable, or the mistake is permanent: the
        // old code returned here unconditionally, so one bad value kept every
        // later boot from recognising the directory (see logOwner()).
        const current = this.readSessionOwner(path.basename(dirPath));
        if (current === agentId) return;
        const proven = this.logOwner(path.basename(dirPath));
        if (proven !== agentId) return; // not provably ours — leave it alone
        console.log(
          `[teapot] repairing session manifest for ${path.basename(dirPath)}: ` +
            `${JSON.stringify(current)} → ${JSON.stringify(agentId)} (the log says ${JSON.stringify(agentId)})`,
        );
      }
      writeFileSync(file, `${JSON.stringify({ v: 1, agentId }, null, 2)}\n`);
    } catch {
      /* best-effort metadata */
    }
  }

  private findLatestSessionDir(agentId: string): string | null {
    // Directory names alone are ambiguous: agent "teapot" prefix-matches
    // "teapot-3-<hash>", and sibling ids where one is a prefix of the other
    // ("prismrv-root-sub-review" vs "…-review-kernel") used to exclude each
    // other's own dirs. Ownership comes from the manifest; legacy dirs are
    // inferred by longest matching id.
    const candidateIds = new Set<string>([agentId]); // the agent itself owns its bare-name dir
    for (const a of this.config.agents) if (a.id) candidateIds.add(a.id);
    for (const [liveId] of this.agents) candidateIds.add(liveId);
    let dirs: string[] = [];
    try {
      const withHistory: { d: string; m: number }[] = [];
      const empty: { d: string; m: number }[] = [];
      for (const d of readdirSync(this.sessionsRoot())) {
        const { owner } = this.inferSessionOwner(d, candidateIds);
        // A wrong manifest must not hide a directory: consult the LOG before
        // rejecting. Without this, one bad manifest value made every dir the
        // agent owned invisible here, so the caller minted a fresh session and
        // rewrote config — silently orphaning the real history.
        const mineByLog = owner !== agentId && this.logOwner(d) === agentId;
        if (owner !== agentId && !mineByLog) continue;
        if (mineByLog) this.writeSessionManifest(path.join(this.sessionsRoot(), d), agentId);
        const dirPath = path.join(this.sessionsRoot(), d);
        const m = this.sessionMtime(dirPath);
        // an EMPTY chat.jsonl means the session was never really used — but it
        // must not SHADOW a real history dir: an incarnation's state events
        // keep refreshing the empty log's mtime, and newest-wins would then
        // pick the empty one forever ("timeline of zero" on every restart).
        let size = 0;
        try {
          size = statSync(path.join(dirPath, "chat.jsonl")).size;
        } catch { /* no log yet */ }
        (size > 0 ? withHistory : empty).push({ d, m });
      }
      const pick = (list: { d: string; m: number }[]) =>
        list.sort((a, b) => b.m - a.m)[0]?.d;
      // prefer a dir that actually carries history; fall back to the newest
      // empty one ONLY when no history exists under this id at all
      dirs = [pick(withHistory) ?? pick(empty)].filter((x): x is string => !!x);
    } catch {
      return null;
    }
    return dirs[0] ? path.join(this.sessionsRoot(), dirs[0]) : null;
  }

  private sessionMtime(dir: string): number {
    try {
      return statSync(path.join(dir, "chat.jsonl")).mtimeMs;
    } catch {
      return 0;
    }
  }

  private resolveSessionDir(agentId: string, fresh: boolean): string {
    const root = this.sessionsRoot();
    mkdirSync(root, { recursive: true });

    // one-time migration from the ≤0.5.0 flat layout (<dataDir>/<id>.jsonl)
    // MUST run first so the bare-name directory exists for subsequent checks
    if (!fresh) {
      const legacy = path.join(this.config.dataDir, `${agentId}.jsonl`);
      if (existsSync(legacy)) {
        const target = path.join(root, agentId);
        if (!existsSync(target)) {
          mkdirSync(target, { recursive: true });
          renameSync(legacy, path.join(target, "chat.jsonl"));
          console.log(`[teapot] migrated session storage: ${agentId}.jsonl → sessions/${agentId}/chat.jsonl`);
        }
      }
    }

    // Prefer the recorded session: the config says exactly which timeline this
    // agent was on. Guessing by mtime let a stale-or-deleted dir whose
    // chat.jsonl happened to be newer win, handing the agent a timeline the
    // operator had moved off — the "deleted session comes back" report (#39).
    const recorded = this.config.agents.find((a) => a.id === agentId)?.session;
    if (!fresh && recorded) {
      const dir = path.join(root, recorded);
      // Trust it when it exists and is really THIS agent's dir. Ownership comes
      // from the manifest, but the LOG is consulted too: a wrong/absent manifest
      // must not make teapot abandon history it can plainly see (see logOwner).
      const owner = this.readSessionOwner(recorded);
      const mineByManifest = owner === null || owner === agentId;
      const mineByLog = owner !== agentId && this.logOwner(recorded) === agentId;
      if (existsSync(dir) && (mineByManifest || mineByLog)) {
        if (mineByLog) this.writeSessionManifest(dir, agentId); // repair it
        return dir;
      }
      // the recorded dir is gone, or provably belongs to someone else — fall
      // through and mint a new one. Say WHICH, and do not do it quietly: this
      // line is the only trace that an agent changed session.
      console.log(
        `[teapot] session ${recorded} for ${agentId} is unusable ` +
          `(${existsSync(dir) ? `manifest owner ${JSON.stringify(owner)}` : "directory missing"}); ` +
          `starting a new one`,
      );
    }

    // Prefer the LATEST session directory that actually carries history.
    // This handles the case where a bare-name directory (e.g. from legacy
    // migration) would otherwise shadow a newer UUID-suffixed incarnation
    // (the "example-session-2 timeline empty" bug).
    if (!fresh) {
      const existing = this.findLatestSessionDir(agentId);
      if (existing) return existing; // restart → continue where we left off
    }

    // exact-restart match: bare <agentId> directory — only if no history-carrying
    // UUID-suffixed directory was found above. This covers the very first run
    // before any UUID-suffixed dir exists, and legacy flat migrations.
    const selfDir = path.join(root, agentId);
    const selfOwner = this.readSessionOwner(agentId);
    const selfUsable = selfOwner === null || selfOwner === agentId;
    if (
      !fresh &&
      selfUsable &&
      statSync(path.join(selfDir, "chat.jsonl"), { throwIfNoEntry: false })?.size
    ) {
      return selfDir; // restart → continue where we left off
    }

    // fresh incarnation: guaranteed-unique directory
    let sid = "";
    do {
      sid = `${agentId}-${randomUUID().slice(0, 8)}`;
    } while (existsSync(path.join(root, sid)));
    this.writeSessionManifest(path.join(root, sid), agentId);
    return path.join(root, sid);
  }

  /**
   * All session dirs on disk with their inferred/manifested owner, newest
   * log first. One readdir powers every "list sessions" need — the UI calls
   * the aggregated endpoint instead of fanning out one request per agent.
   */
  allSessions(): { id: string; agentId: string; mtimeMs: number; sizeBytes: number; title?: string }[] {
    const candidateIds = new Set<string>(this.config.agents.map((a) => a.id).filter(Boolean) as string[]);
    for (const [liveId] of this.agents) candidateIds.add(liveId);
    // dir names themselves are candidate owners too: "s" owns legacy "s",
    // "teapot-3-3c0048d7" is best matched by the longest configured id —
    // inference needs the id set only, so nothing extra to add here.
    let names: string[] = [];
    try {
      names = readdirSync(this.sessionsRoot());
    } catch {
      return [];
    }
    const out: { id: string; agentId: string; mtimeMs: number; sizeBytes: number }[] = [];
    for (const d of names) {
      const dirPath = path.join(this.sessionsRoot(), d);
      const { owner, hadManifest } = this.inferSessionOwner(d, candidateIds);
      if (!owner) continue; // orphan dir (unknown owner) — not addressable
      // backfill legacy dirs so the inference result becomes durable
      if (!hadManifest) this.writeSessionManifest(dirPath, owner);
      let m = 0;
      let size = 0;
      try {
        const st = statSync(path.join(dirPath, "chat.jsonl"));
        m = st.mtimeMs;
        size = st.size;
      } catch { /* no log yet — still listable */ }
      // #155: a title derived from the session's FIRST user prompt, so the
      // sidebar does not make the operator read `teapot-10-16854917`.
      //
      // Read here rather than from the live agent because boot leaves agents
      // STOPPED: their logs are not restored, so a title computed during restore
      // would be missing for every session the operator has not opened yet —
      // i.e. exactly the ones they need it for.
      //
      // BOUNDED and cheap: the scan stops at the FIRST `prompt` event of ANY
      // source, which is what makes it affordable. Measured over 817 real
      // sessions: 36 ms / 7.9 MB with the early exit, versus 804 ms / 169 MB
      // scanning to find a USER prompt specifically (sub-agents receive only
      // `harness` prompts, 758 of the 817, so they were what made it slow).
      // Those sub-sessions correctly produce no title — the sidebar already
      // labels them from their id via subAgentDisplayName().
      const title = this.sessionTitleOf(dirPath);
      out.push({ id: d, agentId: owner, mtimeMs: m, sizeBytes: size, ...(title ? { title } : {}) });
    }
    return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  }

  /**
   * Internal session ids (= directory names) owned by an agent, newest log
   * first. These are the stable handles the web UI routes by — agent ids can
   * be recycled across incarnations, internal session ids cannot.
   */
  sessionsOf(agentId: string): { id: string; mtimeMs: number; sizeBytes: number }[] {
    return this.allSessions()
      .filter((s) => s.agentId === agentId)
      .map(({ id, mtimeMs, sizeBytes }) => ({ id, mtimeMs, sizeBytes }));
  }

  /** resolve an internal session id to (ownerAgentId, absolute dir) — null when it doesn't exist */
  sessionById(sessionId: string): { agentId: string; dir: string } | null {
    // internal ids are directory names: refuse anything path-like up front
    if (!sessionId || sessionId.includes("/") || sessionId.includes("\\") || sessionId.startsWith(".")) return null;
    const root = this.sessionsRoot();
    const candidateIds = new Set<string>(this.config.agents.map((a) => a.id).filter(Boolean) as string[]);
    for (const [liveId] of this.agents) candidateIds.add(liveId);
    const { owner } = this.inferSessionOwner(sessionId, candidateIds);
    if (!owner) return null;
    try {
      const st = statSync(path.join(root, sessionId));
      if (!st.isDirectory()) return null;
    } catch {
      return null;
    }
    return { agentId: owner, dir: path.join(root, sessionId) };
  }

  async removeAgent(id: string): Promise<void> {
    const agent = this.agents.get(id);
    if (!agent) throw new Error(`no such agent: ${id}`);
    this.agents.delete(id);
    await agent.dispose();
    this.config.agents = this.config.agents.filter((a) => a.id !== id);
    this.saveConfig();
  }

  /**
   * Put an agent away without losing it: stop it, drop it from the running set, and
   * mark its config entry archived. The entry and its session history stay on disk,
   * so `restoreAgent` can bring it back byte-identically.
   *
   * This exists because the old "remove" conflated two very different wishes —
   * "I am done with this for now" and "destroy it" — and implemented the first as
   * the second: it deleted the config entry, which orphaned the session directory
   * (the files survived, but nothing in the UI could reach them again).
   */
  async archiveAgent(id: string): Promise<{ archived: boolean; ids: string[] }> {
    const root = this.config.agents.find((a) => a.id === id);
    if (!root) throw new Error(`no such agent: ${id}`);
    // The whole SUBTREE goes with it. A sub-agent whose parent is archived can never
    // run again — its parent is what spawns and messages it — so leaving it un-archived
    // put orphans in the list that look usable and are not. The descendants are found
    // from the config (not the live map), so sub-agents that are already stopped or
    // suspended are included.
    const ids = [id, ...this.subtreeOf(id).map((s) => s.id)];
    const now = Date.now();
    for (const one of ids) {
      const live = this.agents.get(one);
      if (live) {
        this.agents.delete(one);
        await live.dispose();
      }
      // an archived agent's shells are unreachable from the UI (its tabs go with it), so
      // leaving the ptys running would strand them until the idle reaper noticed
      closeTerminalsFor(one);
      const ac = this.config.agents.find((a) => a.id === one);
      if (!ac) continue;
      ac.archived = true;
      ac.archivedAt = now;
    }
    this.saveConfig();
    return { archived: true, ids };
  }

  /**
   * Bring an archived agent back. Its session pointer was never touched.
   *
   * Restores the SUBTREE too, because archiving took it: a parent restored without its
   * children would come back unable to reach the work it delegated, and the children
   * would sit invisibly in the archive with no way to know why.
   */
  async restoreAgent(id: string): Promise<{ restored: boolean; live: boolean; ids: string[] }> {
    const ac = this.config.agents.find((a) => a.id === id);
    if (!ac) throw new Error(`no such agent: ${id}`);
    const ids = [id, ...this.subtreeOf(id).map((s) => s.id)];
    for (const one of ids) {
      const e = this.config.agents.find((a) => a.id === one);
      if (!e) continue;
      delete e.archived;
      delete e.archivedAt;
    }
    this.saveConfig();
    // start it again unless it was never configured to run (it is in the list, so it
    // was) — a restore is the operator asking for it back, so it comes back LIVE
    try {
      await this.addAgent(ac);
      return { restored: true, live: true, ids };
    } catch (err) {
      // the entry is restored either way; starting it can fail on a provider/auth
      // problem, and reporting that is more useful than undoing the restore
      console.error(`[teapot] restored "${id}" but could not start it: ${(err as Error).message}`);
      return { restored: true, live: false, ids };
    }
  }

  /** Archived entries, newest first — what the settings panel lists. */
  archivedAgents(): Array<{
    id: string;
    workspace: string;
    archivedAt?: number;
    sessions: number;
    /** the archived parent, when this entry came along with one */
    parent?: string;
    /** how many archived descendants hang under this entry */
    subs: number;
  }> {
    const archived = this.config.agents.filter((a) => a.archived);
    const ids = new Set(archived.map((a) => a.id));
    return archived
      .map((a) => ({
        id: a.id,
        workspace: a.workspace,
        ...(a.archivedAt !== undefined ? { archivedAt: a.archivedAt } : {}),
        sessions: this.sessionsOf(a.id).length,
        // A sub-agent is listed under its parent rather than as an equal entry: the
        // operator archived ONE thing, and a flat list of every descendant makes it
        // look like they did several. Only an ARCHIVED parent counts — otherwise a
        // live parent would hide a genuinely standalone entry.
        ...(a.parent && ids.has(a.parent) ? { parent: a.parent } : {}),
        subs: this.subtreeOf(a.id).filter((s) => ids.has(s.id)).length,
      }))
      .sort((a, b) => (b.archivedAt ?? 0) - (a.archivedAt ?? 0));
  }

  /**
   * Delete an agent FOR REAL: config entry, live instance, and its session
   * directories on disk. Irreversible — the UI asks first and says how much is
   * being destroyed.
   */
  async purgeAgent(id: string): Promise<{ purged: true; dirs: number }> {
    const ac = this.config.agents.find((a) => a.id === id);
    if (!ac) throw new Error(`no such agent: ${id}`);
    const live = this.agents.get(id);
    if (live) {
      this.agents.delete(id);
      await live.dispose();
    }
    // collect the directories BEFORE dropping the config entry, because
    // `sessionsOf` resolves ownership through the config + live map
    const dirs = this.sessionsOf(id);
    this.config.agents = this.config.agents.filter((a) => a.id !== id);
    this.saveConfig();
    let removed = 0;
    for (const d of dirs) {
      try {
        rmSync(path.join(this.sessionsRoot(), d.id), { recursive: true, force: true });
        removed++;
      } catch (err) {
        console.error(`[teapot] could not delete ${d.id}: ${(err as Error).message}`);
      }
    }
    return { purged: true, dirs: removed };
  }

  /**
   * Switch a running agent's model/provider mid-session.
   * With provider: use that named provider's baseUrl/key (+ model override).
   * Without: keep the current endpoint, swap only the model name.
   * The choice is persisted on the agent config so it survives restarts.
   */
  async setAgentModel(
    id: string,
    providerName?: string,
    model?: string,
    contextWindowTokens?: number,
    reasoningEffort?: string, // "" clears it back to the provider default (#47)
  ): Promise<{ provider: string; model: string; reasoningEffort?: string }> {
    const agent = this.agents.get(id);
    if (!agent) throw new Error(`no such agent: ${id}`);
    let llm: LlmConfig;
    let effectiveProvider = providerName ?? "";
    if (providerName) {
      const prov = this.config.providers?.[providerName];
      if (!prov?.baseUrl) throw new Error(`unknown provider: ${providerName}`);
      llm = {
        baseUrl: prov.baseUrl,
        apiKey: prov.apiKey ?? "",
        model: model || prov.model || "",
        timeoutMs: 120_000,
      };
    } else {
      llm = { ...agent.llm };
      if (model) llm.model = model;
      const ac = this.config.agents.find((a) => a.id === id);
      effectiveProvider = ac?.provider ?? this.config.defaultProvider ?? "";
    }
    // #47: re-resolve the catalogue for the (possibly new) model so the
    // effort gate reflects THIS model's advertised capabilities
    const effortList = await fetchModelList(llm.baseUrl, llm.apiKey).catch(() => [] as ModelMeta[]);
    const meta = effortList.find((m) => m.id === (model || llm.model));
    const opts = agent as unknown as {
      opts: { reasoningEffort: string; supportedParameters?: string[]; supportedEfforts?: string[] };
    };
    if (reasoningEffort !== undefined) {
      // validated here so an unsupported value never reaches the request body;
      // "" or an unrecognised level clears it (provider default)
      opts.opts.reasoningEffort = isReasoningEffort(reasoningEffort) ? reasoningEffort : "";
      const cfgEntry = this.config.agents.find((a) => a.id === id);
      if (cfgEntry) cfgEntry.reasoningEffort = opts.opts.reasoningEffort || undefined;
    }
    // keep `undefined` for "published nothing" — see the note on the option (#150)
    opts.opts.supportedParameters = meta?.supportedParameters;
    opts.opts.supportedEfforts = meta?.supportedEfforts;
    if (!llm.model) throw new Error("no model resolved (pass model or set one on the provider)");
    if (!llm.baseUrl) throw new Error("no baseUrl resolved");
    agent.setLlmConfig(llm);
    // keep the snapshot's provider in sync — the UI's model switcher reads
    // sel().provider, and the old code only updated the config entry (ac)
    // so the live snapshot kept the stale provider (the "right panel model
    // switching doesn't work" backend half).
    (agent as unknown as { opts: { provider: string } }).opts.provider = effectiveProvider;
    const ac = this.config.agents.find((a) => a.id === id);
    if (ac && providerName) ac.provider = providerName;
    if (ac) ac.model = llm.model;
    // learn the new model's window (metadata lookup) unless explicitly given
    let win = contextWindowTokens;
    if (win === undefined && ac && !ac.contextWindowTokens && !this.config.contextWindowTokens) {
      try {
        const list = await fetchModelList(llm.baseUrl, llm.apiKey);
        win = contextLengthFor(list, llm.model);
      } catch {
        /* metadata is best-effort */
      }
    }
    if (win !== undefined) {
      if (ac) ac.contextWindowTokens = win;
      const opts = agent as unknown as {
        opts: {
          contextWindowTokens: number;
          contextTokenBudget: number;
          manualCompactBudget?: boolean;
        };
      };
      opts.opts.contextWindowTokens = win;
      // re-derive the compaction budget for the NEW window — unless the
      // operator pinned one. Without this, a model switch kept the previous
      // budget and the panel showed "manual override" out of nowhere.
      if (!agent.compactBudgetIsManual)
        opts.opts.contextTokenBudget = Math.round(win * 0.75);
    }
    // re-price for the NEW model (cost estimate follows the model switch)
    try {
      const list = await fetchModelList(llm.baseUrl, llm.apiKey);
      await agent.setModelPricing(list.find((m) => m.id === llm.model)?.pricing);
    } catch { /* pricing stays stale — cosmetic only */ }
    this.saveConfig();
    void agent.log.append("system_note", agent.currentSession, agent.currentBranch, {
      event: "model-changed",
      provider: effectiveProvider,
      model: llm.model,
    });
    return { provider: effectiveProvider, model: llm.model };
  }

  /** 4 ticks/min; each tick is a few integer compares per task. */
  private tick(): void {
    const now = new Date();
    const minuteKey = Math.floor(now.getTime() / 60_000);
    for (const t of this.tasks) {
      try {
        if (!matches(t.schedule, now)) continue;
        if (t.lastRunMin === minuteKey) continue; // dedupe within the same minute
        t.lastRunMin = minuteKey;
        t.lastRunAt = Date.now();
        // persist so a master restart doesn't re-fire the same minute
        t.task.lastRunMin = minuteKey;
        this.saveConfig();
        const agent = this.agents.get(t.task.agent);
        if (!agent) continue;
        console.log(`[teapot] scheduled task "${t.task.id}" -> agent ${t.task.agent}`);
        void (async () => {
          if (t.task.forked) await agent.fork();
          await agent.enqueuePrompt(t.task.prompt, `scheduler:${t.task.id}`);
          if (agent.status !== "running") agent.start(`scheduled:${t.task.id}`);
        })();
      } catch (err) {
        console.error(`[teapot] scheduler error (${t.task.id}):`, (err as Error).message);
      }
    }
  }

  /** Everything the UI needs to make cron schedules legible. */
  tasksView(): {
    id: string;
    agent: string;
    schedule: string;
    forked: boolean;
    prompt: string;
    next: string | null;
    last: string | null;
  }[] {
    return this.tasks.map((t) => ({
      id: t.task.id,
      agent: t.task.agent,
      schedule: t.schedule.raw,
      forked: !!t.task.forked,
      prompt: t.task.prompt,
      next: nextFireAt(t.schedule),
      last: t.lastRunAt ? new Date(t.lastRunAt).toISOString() : null,
    }));
  }

  metrics() {
    const mu = process.memoryUsage();
    const cu = process.cpuUsage();
    return {
      uptimeSec: Math.floor((Date.now() - this.startedAt) / 1000),
      rssMb: +(mu.rss / 1048576).toFixed(1),
      heapUsedMb: +(mu.heapUsed / 1048576).toFixed(1),
      cpuMsTotal: cu.user + cu.system,
      loadavg1: +(os.loadavg()[0]).toFixed(2),
      agents: [...this.agents.values()].map((a) => ({
        id: a.opts_id(),
        turns: a.stats.turns,
        toolCalls: a.stats.toolCalls,
        inputTokens: a.stats.inputTokens,
        outputTokens: a.stats.outputTokens,
      })),
    };
  }

  /**
   * Current application version.
   *
   * Read from package.json at runtime rather than via a `"__APP_VERSION__"`
   * literal: `__APP_VERSION__` is substituted by *vite* only, so the tsc-built
   * backend used to ship the raw placeholder and the settings panel rendered
   * "current version: __APP_VERSION__" (#33). A runtime read is correct in the
   * built app, in `pnpm dev` and under `node --test`, which never run vite.
   */
  static readonly VERSION = readAppVersion();

  /** Return the current server version. */
  getVersion(): string {
    return Master.VERSION;
  }

  /** Gracefully stop all agents with a timeout. Returns when all are stopped or timeout. */
  async stopAllAgents(timeoutMs = 30_000): Promise<void> {
    console.log(`[teapot] stopping all ${this.agents.size} agents...`);
    const ids = [...this.agents.keys()];
    const stopPromises = ids.map(async (id) => {
      const a = this.agents.get(id);
      if (!a) return;
      try {
        await a.dispose();
      } catch (err) {
        console.error("[teapot] dispose error:", err);
      }
      // remove from map so a re-spawn after restart doesn't carry state
      this.agents.delete(id);
    });
    // #79: two problems with racing a timeout against the real work.
    //
    // 1. The timer was never cleared, so it kept the event loop alive for the
    //    FULL timeout after a fast, successful stop — a 30s handle on a stop
    //    that took milliseconds.
    // 2. On timeout, the promises that HAD completed had already deleted their
    //    agents from `this.agents`, while their peers were still mid-dispose.
    //    `restartServer` then threw BEFORE spawning its replacement, so the
    //    process was left serving with a half-empty agent map and no successor.
    //
    // Fixed by clearing the timer, and by reporting which agents did NOT stop
    // so the caller can decide rather than being left half-dead.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((_, reject) => {
      timer = setTimeout(() => reject(new Error("agent stop timeout")), timeoutMs);
    });
    try {
      await Promise.race([Promise.all(stopPromises), timeout]);
      console.log("[teapot] all agents stopped");
    } finally {
      if (timer) clearTimeout(timer);
      /**
       * Close the human terminals too.
       *
       * Their ptys are spawned `detached` so one close can signal the whole process group (see
       * terminals.ts). The cost of that is that they do NOT die with this process — a restart
       * would leave every open shell orphaned and unreachable, still holding the operator's
       * workspace. Closing here is what makes `detached` safe.
       */
      const n = closeAllTerminals();
      if (n) console.log(`[teapot] ⌨ closed ${n} terminal(s)`);
    }
  }

  /**
   * Live update: stop at a turn boundary, write the resume set, then REPLACE THIS PROCESS IN PLACE.
   *
   * ## Why exec instead of spawning a successor
   *
   * The previous design spawned a child and kept the old process alive as its supervisor, polling
   * `pidAlive(replacement)` forever. That is the reported memory leak — and it was structural, not
   * a stray handle:
   *
   *   - the OLD process stayed resident for the ENTIRE LIFETIME of the new one, holding its agent
   *     objects, its log file handles, every `bus` listener and its 15s tick;
   *   - `supervise()` added three MORE signal listeners (`SIGINT`/`SIGTERM`/`SIGHUP`) to a process
   *     that had already registered the same three for `shutdown()`, so each update left a process
   *     with doubled handlers;
   *   - and the handover needed a 1.5s sleep plus a port-polling dance in the new process, because
   *     two processes cannot hold one port.
   *
   * `process.execve()` (Node 26+) removes the whole category: the image is replaced under the SAME
   * pid, so the process group, the controlling terminal and therefore the operator's foreground job
   * all stay put — the daemonization problem #35 fixed by hand cannot occur. The port is released
   * as part of the exec (verified: a listener bound before `execve` is free immediately after), so
   * the successor binds with no polling and no window in which both are half-served.
   *
   * `execveSync` does not exist; this is the async form. It does not return on success.
   */
  /**
   * How long a live update waits for agents to reach a turn boundary.
   *
   * Generous: a round can be a several-minute build. The alternative to waiting is aborting a tool
   * mid-write, so the cap exists only to bound a wedged agent, and those are reported.
   */
  private updateWindDownMs = 180_000;

  /**
   * Ask every agent to stop at its next turn boundary; returns the ids that did not make it.
   *
   * Distinct from `stopAllAgents` (which DISPOSES): disposal aborts in-flight work, and the whole
   * point here is to leave the log on a completed round. A live update must not truncate the turn
   * it interrupted.
   */
  async windDownAllAgents(timeoutMs = this.updateWindDownMs): Promise<string[]> {
    const ids = [...this.agents.keys()];
    if (!ids.length) return [];
    console.log(`[teapot] live update: waiting for ${ids.length} agent(s) to reach a turn boundary...`);
    const stuck = await Promise.all(
      ids.map(async (id) => {
        const a = this.agents.get(id);
        if (!a) return null;
        try {
          await a.windDownForUpdate(timeoutMs);
          return null;
        } catch {
          return id;
        }
      }),
    );
    return stuck.filter((v): v is string => v !== null);
  }

  /**
   * The sessions the successor must resume: everything that was WORKING at this moment.
   *
   * Captured here (not derived on boot) because after the exec the log cannot distinguish "stopped
   * by a live update mid-round" from "finished" or "stopped by the operator".
   */
  takeResumeSet(): string[] {
    const out: string[] = [];
    for (const [id, a] of this.agents) {
      // `live` covers running, parked on a tool, and needs_operator — all states where the
      // operator's mental model is "this thing is in the middle of something".
      if (a.isLive()) out.push(id);
    }
    return out;
  }

  /**
   * Resume what the previous image was running, then FORGET the set.
   *
   * Called once at boot. Clearing it immediately means a crash before the agents start cannot make
   * the next boot resume work that has been idle for hours: the set describes one handover.
   */
  async resumeAfterUpdate(): Promise<string[]> {
    const ids = this.config.resumeAfterUpdate ?? [];
    if (!ids.length) return [];
    this.config.resumeAfterUpdate = [];
    this.saveConfig();
    const started: string[] = [];
    for (const id of ids) {
      const a = this.agents.get(id);
      if (!a) continue; // the agent was removed while we were restarting
      try {
        a.start("resumed after a live update");
        started.push(id);
      } catch (err) {
        console.error(`[teapot] could not resume ${id}:`, (err as Error).message);
      }
    }
    const missing = ids.filter((id) => !this.agents.has(id));
    if (missing.length)
      console.log(`[teapot] live update: not resuming removed agent(s): ${missing.join(", ")}`);
    if (started.length) console.log(`[teapot] live update: resumed ${started.length} session(s)`);
    return started;
  }

  async restartServer(): Promise<void> {
    console.log("[teapot] live update: restarting...");

    /**
     * 1. WIND DOWN — do not abort.
     *
     * `stopAllAgents` calls `dispose()`, which aborts the in-flight LLM call and the running tool.
     * For an operator pressing ■ that is correct; for a live update it cuts a tool off mid-write
     * and leaves a call whose result never arrives, so the resumed session starts from a state that
     * never existed. `windDownForUpdate()` instead lets each agent finish its current round.
     */
    const interrupted = await this.windDownAllAgents(this.updateWindDownMs);
    if (interrupted.length)
      console.log(
        `[teapot] live update: ${interrupted.length} agent(s) did not reach a turn boundary in ` +
          `time and were stopped: ${interrupted.join(", ")}`,
      );

    /**
     * 2. REMEMBER WHAT TO RESUME.
     *
     * Written to the config BEFORE the exec, because after it this process no longer exists. Only
     * agents that were actually working go in — an idle agent must NOT be started by the new
     * process, or a live update would begin doing work the operator never asked for.
     */
    this.config.resumeAfterUpdate = this.takeResumeSet();
    this.saveConfig();
    console.log(
      `[teapot] live update: ${this.config.resumeAfterUpdate.length} session(s) will resume`,
    );

    // 3. terminals: closing them is what makes their `detached` spawns safe (see stopAllAgents)
    const closed = closeAllTerminals();
    if (closed) console.log(`[teapot] ⌻ closed ${closed} terminal(s)`);

    /**
     * 4. EXEC.
     *
     * `TEAPOT_RESUMED` tells the new image this was a live update, so it resumes rather than
     * treating the sessions as merely idle. It also suppresses the "config was edited" banner in
     * cases where the operator did not touch anything.
     */
    const env: NodeJS.ProcessEnv = { ...process.env, TEAPOT_RESUMED: "1" };
    const execve = (process as unknown as {
      execve?: (file: string, args: string[], env: NodeJS.ProcessEnv) => Promise<never>;
    }).execve;
    if (!execve) {
      throw new Error(
        "live update needs process.execve (Node 22+); restart the server by hand on this runtime",
      );
    }
    console.log("[teapot] live update: replacing this process in place (same pid, same terminal)");
    /**
     * Build the argv for the replacement image.
     *
     * `process.execArgv` carries runtime flags that must precede the entry file — but under
     * `node --test` it is polluted with the RUNNER's own flags (`--test-concurrency`,
     * `--test-isolation=process`, dozens of tuning knobs). Re-passing those made the new image
     * re-enter test-runner mode instead of booting: MEASURED as
     * `src/index.ts: bad option: --config`, i.e. the new image never started.
     *
     * So only the flags that make a TypeScript entry runnable are forwarded. A flag missing here
     * simply means the new image boots with node's defaults, which is what a live update wants;
     * anything else the operator set lives in `env` and the shell.
     */
    const FORWARDABLE =
      /^--(experimental-strip-types|experimental-transform-types|no-warnings|enable-source-maps|import|require|conditions)$/;
    const forwardable = process.execArgv.filter((a) => FORWARDABLE.test(a.split("=")[0] ?? ""));
    /**
     * `args[0]` MUST be the program, exactly as a shell would pass it.
     *
     * `execve` does not use the `file` argument as `argv[0]` — node then reads what it thinks is
     * the first ARGUMENT as the entry point and hands the rest to its own option parser. Verified
     * in isolation: passing `[script, "--config", …]` yields `script: bad option: --config`, while
     * `[execPath, script, "--config", …]` boots. The new image would otherwise never start, leaving
     * the port dark after a live update.
     */
    await execve(process.execPath, [process.execPath, ...forwardable, ...process.argv.slice(1)], env);
    // execve only resolves if it FAILED to exec
    throw new Error("execve returned without replacing the process");
  }
}
