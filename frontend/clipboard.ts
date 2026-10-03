/**
 * Clipboard copy with a legacy fallback.
 *
 * #75: this lived inside App.tsx, and `test/copy-button.test.ts` carried its own
 * copy — so the test exercised the copy and the app ran something else.
 * Mutation testing proved the consequence: deleting the entire
 * `execCommand("copy")` fallback from App.tsx left the suite green 11/11. The #52
 * fix could be half-removed invisibly.
 *
 * Extracted so the tests drive the code that actually runs. The dependency is
 * injected so the fallback paths are reachable under `node --test`, where
 * `navigator.clipboard` and `document.execCommand` do not exist.
 */

export type CopyResult = "copied" | "unsupported" | "failed";

/** the staging element the legacy path needs; `style` is duck-typed so this
 *  module imports without a DOM */
export interface StagingTextarea {
  value: string;
  style: { position: string; opacity: string };
  select(): void;
  remove(): void;
}

export interface CopyDeps {
  /** `navigator.clipboard`, when the modern API is available */
  clipboard?: { writeText(text: string): Promise<void> } | null;
  /** `document.execCommand` — the legacy path */
  execCommand?: (cmd: string) => boolean;
  /** staging element factory; the real one appends to `document.body` */
  makeTextarea?: () => StagingTextarea;
}

export async function copyText(text: string, deps: CopyDeps = {}): Promise<CopyResult> {
  if (!text) return "unsupported";

  // read the globals lazily so a caller can inject them, and so importing this
  // module does not require a DOM
  const clipboard =
    deps.clipboard !== undefined
      ? deps.clipboard
      : typeof navigator !== "undefined"
        ? (navigator.clipboard ?? null)
        : null;
  const execCommand =
    deps.execCommand ?? (typeof document !== "undefined" ? document.execCommand.bind(document) : undefined);
  const makeTextarea =
    deps.makeTextarea ??
    (() => {
      const el = document.createElement("textarea");
      document.body.appendChild(el);
      return {
        set value(v: string) {
          el.value = v;
        },
        get value(): string {
          return el.value;
        },
        // CSSStyleDeclaration satisfies the two properties used here
        style: { get position() { return el.style.position; }, set position(v: string) { el.style.position = v; },
                 get opacity() { return el.style.opacity; }, set opacity(v: string) { el.style.opacity = v; } },
        select: () => el.select(),
        remove: () => el.remove(),
      };
    });

  const writeText = clipboard?.writeText;
  if (typeof writeText === "function") {
    try {
      await writeText.call(clipboard, text);
      return "copied";
    } catch {
      /* rejected (denied, unfocused, insecure) — try the legacy path */
    }
  }

  // legacy path, used when the API is missing OR refused
  let ta: StagingTextarea | null = null;
  try {
    const staging: StagingTextarea = makeTextarea();
    ta = staging;
    staging.value = text;
    staging.style.position = "fixed";
    staging.style.opacity = "0";
    staging.select();
    if (!execCommand) return "failed";
    return execCommand("copy") ? "copied" : "failed";
  } catch {
    return "failed";
  } finally {
    // ALWAYS remove the staging textarea: a throw from execCommand used to skip
    // the cleanup, leaving an invisible element in the document once per failed
    // copy — and they accumulate for the life of the tab
    ta?.remove();
  }
}
