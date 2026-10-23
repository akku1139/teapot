/**
 * Clipboard copy with a legacy fallback.
 *
 * The `execCommand("copy")` path is what makes copy work on a plain-http page,
 * where `navigator.clipboard` is absent (#52).
 *
 * #75: it lived inside App.tsx with a copy in the test, so the test proved
 * nothing. The dependencies are injected so the fallback paths stay reachable
 * under `node --test`, where neither global exists.
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

  // a caller-injected dependency wins; otherwise read the globals lazily, so
  // importing this module does not require a DOM
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

  // legacy path, used when the modern API is missing or refused
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
    // the removal MUST stay in `finally`: a throw from execCommand would
    // otherwise leak an invisible element per failed copy, for the life of the tab
    ta?.remove();
  }
}
