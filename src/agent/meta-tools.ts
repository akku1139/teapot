/**
 * The META tools: the ones the AGENT LOOP handles itself instead of dispatching to
 * `executeTool` (finish, the goal/todo/memory/feedback tools, ask_user…).
 *
 * ## Why this is a table and not two lists
 *
 * A meta tool used to be declared in TWO hand-maintained places: a 389-line block of
 * `if (call.function.name === "…")` in `runTurnsUntilIdle`, and its spec among the
 * literals in `allToolSpecs`. Nothing connected them, so the failure modes were silent:
 *
 *   - a spec with no branch → the model calls a tool that falls through to
 *     `executeTool`, which answers "unknown tool" even though the prompt advertised it;
 *   - a branch with no spec → dead code, and the model never learns the tool exists.
 *
 * Named in one place, both mistakes become a missing key rather than a runtime surprise.
 * `META_TOOL_NAMES` is derived from this table, so `allToolSpecs()` cannot advertise a
 * meta tool the loop does not handle (see `test/meta-tools.test.ts`).
 */

/** one entry per meta tool: the wire spec, and the name the loop matches on */
export interface MetaTool {
  name: string;
  spec: {
    type: "function";
    function: {
      name: string;
      description: string;
      parameters: Record<string, unknown>;
    };
  };
}

/**
 * Every meta tool, in the order the model sees them.
 *
 * Adding one: add the entry here AND the matching branch in `runTurnsUntilIdle`. The test
 * asserts the two agree, so a half-done addition fails rather than shipping.
 */
export const META_TOOLS: MetaTool[] = [
  {
    name: "finish",
    spec: {
        type: "function" as const,
        function: {
          name: "finish",
          description:
            "End the current round. Call with goalComplete=true only when the current goal (shown in your prompt) is fully achieved.",
          parameters: {
            type: "object",
            properties: {
              goalComplete: { type: "boolean" },
              summary: { type: "string" },
            },
          },
        },
      },
  },
  {
    name: "report_progress",
    spec: {
        type: "function" as const,
        function: {
          name: "report_progress",
          description:
            "Report current progress to humans: doing, goalStatus, recent attempts, problems, next step.",
          parameters: {
            type: "object",
            properties: {
              doing: { type: "string" },
              goalStatus: { type: "string" },
              recent: { type: "string" },
              problems: { type: "string" },
              next: { type: "string" },
            },
            required: ["doing", "goalStatus", "recent"],
          },
        },
      },
  },
  {
    name: "set_goal",
    spec: {
        type: "function" as const,
        function: {
          name: "set_goal",
          description:
            "Replace the harness-managed goal text. Use when the objective itself changes — not for routine updates. " +
            "Optionally attach a verification contract (plain-text completion requirements); finish(goalComplete=true) " +
            "is then audited against it by an independent reviewer before the goal counts as done.",
          parameters: {
            type: "object",
            properties: {
              text: { type: "string" },
              verify: {
                type: "string",
                description:
                  "completion requirements that must verifiably hold, e.g. 'npm test passes with zero failures; " +
                  "the new endpoint appears in README'. Omit for no audit.",
              },
            },
            required: ["text"],
          },
        },
      },
  },
  {
    name: "ask_user",
    spec: {
        type: "function" as const,
        function: {
          name: "ask_user",
          description:
            "Pause and ask the operator a question — plan confirmation, ambiguous requirements, " +
            "a decision only they can make. The loop parks until they reply; their message arrives " +
            "as your next user turn. Use sparingly: do your homework first, then ask once, concretely.",
          parameters: {
            type: "object",
            properties: {
              question: { type: "string", description: "what you need decided — include the context and trade-offs" },
              options: {
                type: "array",
                items: { type: "string" },
                description: "optional short answer choices the operator can tap",
              },
            },
            required: ["question"],
          },
        },
      },
  },
  {
    name: "get_goal",
    spec: {
        type: "function" as const,
        function: {
          name: "get_goal",
          description:
            "Fetch the current goal and its status. Cheap — call at session start, after a compaction notice, or when unsure.",
          parameters: { type: "object", properties: {} },
        },
      },
  },
  {
    name: "record_decision",
    spec: {
        type: "function" as const,
        function: {
          name: "record_decision",
          description:
            "Log a significant choice you made AND why — alternatives considered, trade-offs. Compaction forgets reasoning; this file doesn't.",
          parameters: {
            type: "object",
            properties: {
              decision: { type: "string", description: "what was decided, in one sentence" },
              rationale: { type: "string", description: "why — the reasoning and trade-offs" },
              alternatives: {
                type: "array",
                items: { type: "string" },
                description: "options considered but rejected",
              },
            },
            required: ["decision", "rationale"],
          },
        },
      },
  },
  {
    name: "get_decisions",
    spec: {
        type: "function" as const,
        function: {
          name: "get_decisions",
          description: "Read previously logged decisions and their rationale (decisions.md).",
          parameters: { type: "object", properties: {} },
        },
      },
  },
  {
    name: "get_feedback",
    spec: {
        type: "function" as const,
        function: {
          name: "get_feedback",
          description:
            "Read the operator's feedback rules (corrections they've given you, with repetition counts). Check after being corrected.",
          parameters: { type: "object", properties: {} },
        },
      },
  },
  {
    name: "add_feedback",
    spec: {
        type: "function" as const,
        function: {
          name: "add_feedback",
          description:
            "Record a correction as a durable rule (or raise an existing rule's count). Call whenever the operator corrects your behavior so the same mistake isn't repeated.",
          parameters: {
            type: "object",
            properties: { rule: { type: "string", description: "the rule in one imperative sentence" } },
            required: ["rule"],
          },
        },
      },
  },
  {
    name: "get_todo",
    spec: {
        type: "function" as const,
        function: {
          name: "get_todo",
          description:
            "Fetch the operator-maintained task list (todo.md). Check it when picking up work or when unsure what to do next.",
          parameters: { type: "object", properties: {} },
        },
      },
  },
  {
    name: "set_todo",
    spec: {
        type: "function" as const,
        function: {
          name: "set_todo",
          description:
            "Update the operator-visible task list (todo.md). PREFERRED: pass updates to change specific " +
            "items — cheap, surgical, no risk of mangling other sections or the operator's own notes. " +
            "Each entry names an item by its exact text and says what to do: done (default), reopen, " +
            "add, or remove. Only pass content to rewrite the whole list when restructuring it. " +
            "Call this promptly on every item you complete.",
          parameters: {
            type: "object",
            properties: {
              updates: {
                type: "array",
                description: "surgical item changes — match existing items by their exact text in todo.md",
                items: {
                  type: "object",
                  properties: {
                    item: { type: "string", description: "item text (without the \"- [ ]\" marker)" },
                    action: {
                      type: "string",
                      enum: ["done", "reopen", "add", "remove"],
                      description:
                        "done = check off (default), reopen = uncheck, add = append a new item " +
                        "(works even when nothing matches), remove = delete the line",
                    },
                    done: { type: "boolean", description: "shorthand for action done/reopen (default true)" },
                  },
                  required: ["item"],
                },
              },
              content: {
                type: "string",
                description: "full replacement markdown — only for restructures; prefer updates",
              },
            },
          },
        },
      },
  },
  {
    name: "read_memory",
    spec: {
        type: "function" as const,
        function: {
          name: "read_memory",
          description:
            "Read your durable notes (memory.md). Pass `query` to search for the lines that mention something — cheaper than reading the whole file, and the right call when you only need to check one fact.",
          parameters: {
            type: "object",
            properties: {
              query: {
                type: "string",
                description: "case-insensitive substring; omit it to get the whole file",
              },
            },
          },
        },
      },
  },
  {
    name: "forget_memory",
    spec: {
        type: "function" as const,
        function: {
          name: "forget_memory",
          description:
            "Delete the lines of memory.md that match a substring. Use it to remove a note that became wrong, or to consolidate duplicates. Returns what was removed, so a mistake is visible and re-addable.",
          parameters: {
            type: "object",
            properties: {
              query: { type: "string", description: "case-insensitive substring of the line(s) to delete" },
            },
            required: ["query"],
          },
        },
      },
  },
  {
    name: "set_memory",
    spec: {
        type: "function" as const,
        function: {
          name: "set_memory",
          description:
            "REPLACE your durable notes (memory.md) entirely — anything you do not include is lost. Prefer add_memory unless you are rewriting the whole file. Keep notes terse: decisions, gotchas, where you left off.",
          parameters: {
            type: "object",
            properties: { content: { type: "string" } },
            required: ["content"],
          },
        },
      },
  },
  {
    name: "add_memory",
    spec: {
        type: "function" as const,
        function: {
          name: "add_memory",
          description:
            "Append one note to memory.md without touching what is already there. Use this to remember a decision, a gotcha, or where you left off — it cannot lose earlier notes (#48).",
          parameters: {
            type: "object",
            properties: { text: { type: "string", description: "the note to append, one or two lines" } },
            required: ["text"],
          },
        },
      },
  },
  {
    name: "list_skills",
    spec: {
        type: "function" as const,
        function: {
          name: "list_skills",
          description:
            "List available skills (name + description). Call before load_skill or to avoid duplicating an existing skill.",
          parameters: { type: "object", properties: {} },
        },
      },
  },
];

/** the names the tool loop must handle itself, in wire order */
export const META_TOOL_NAMES: string[] = META_TOOLS.map((t) => t.name);

/** just the specs, for splicing into the full tool list */
export function metaToolSpecs(): MetaTool["spec"][] {
  return META_TOOLS.map((t) => t.spec);
}
