export type CopyResult = "copied" | "unsupported" | "failed";

export interface StagingTextarea {
  value: string;
  style: { position: string; opacity: string };
  select(): void;
  remove(): void;
}

export interface CopyDeps {
  clipboard?: { writeText(text: string): Promise<void> } | null | undefined;
  execCommand?: ((cmd: string) => boolean) | undefined;
  makeTextarea?: (() => StagingTextarea) | undefined;
}

export async function copyText(text: string, deps: CopyDeps = {}): Promise<CopyResult> {
  if (!text) return "unsupported";

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
        style: { get position() { return el.style.position; }, set position(v: string) { el.style.position = v; },
                 get opacity() { return el.style.opacity; }, set opacity(v: string) { el.style.opacity = v; } },
        select: () => el.select(),
        remove: () => el.remove(),
      };
    });

  /**
   * Bound, so the call cannot lose `this` — a clipboard object with its own `writeText` implementation would otherwise be
   * invoked detached, which some browsers reject with an "Illegal invocation".
   *
   * The second `?.` is not decoration: `writeText` may be MISSING entirely (an older clipboard object, or a test double), and
   * `undefined.bind(...)` throws before the `typeof` check below can fall back to the textarea path.
   */
  const writeText = clipboard?.writeText?.bind(clipboard);
  if (typeof writeText === "function") {
    try {
      await writeText(text);
      return "copied";
    } catch {
    }
  }

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
    ta?.remove();
  }
}
