import { watch, type FSWatcher } from "node:fs";
import path from "node:path";

/**
 * Tell a connected panel that a workspace changed, instead of making it poll.
 *
 * The files panel had a ⟳ button because nothing could tell it. VS Code and every other editor watch the tree and refresh the
 * parts already on screen; a manual button is the fallback for when you cannot.
 *
 * ONE WATCHER PER WORKSPACE, refcounted: several panels can be open (two agents in one repo, or the same agent in two tabs) and
 * `fs.watch` holds a real inotify/FSEvents handle each time it is armed.
 *
 * Two things this deliberately does NOT do:
 *
 *  - report WHAT changed. The client already knows which directories it has expanded and refetches exactly those
 *    (`refreshTree`), and a path list would be redundant state to keep in step;
 *  - fire per event. A `pnpm install` writes thousands of files in a burst, so notifications are debounced — the panel needs to
 *    know "something moved", not to replay the syscall log.
 */

/** Directories whose churn says nothing about the operator's files. */
const IGNORED = /(^|\/)(node_modules|\.git|dist|public\/assets|\.cache|__pycache__)(\/|$)/;

/** Quiet period after the last event; a burst collapses into one notification. */
const DEBOUNCE_MS = 300;

interface Entry {
  watcher: FSWatcher;
  clients: Set<() => void>;
  timer: ReturnType<typeof setTimeout> | undefined;
}

const watching = new Map<string, Entry>();

/**
 * Watch `root` and call every subscriber once the changes settle.
 *
 * Returns a release function; the last release closes the watcher. `fs.watch` with `recursive: true` is supported on Linux and
 * macOS (the platforms this runs as a product); where it throws — Windows — the caller simply gets no live update, and the tree
 * still loads by fetching, which is the same as before this existed.
 */
export function watchWorkspace(root: string, onChange: () => void): () => void {
  const key = path.resolve(root);
  let entry = watching.get(key);
  if (!entry) {
    let watcher: FSWatcher;
    try {
      watcher = watch(key, { recursive: true });
    } catch {
      // no recursive watch here (Windows): report a no-op release rather than throwing at the caller
      return () => {};
    }
    const fresh: Entry = { watcher, clients: new Set(), timer: undefined };
    watcher.on("error", () => {
      // a watch can die with the directory (a removed workspace); drop it so a later open re-arms
      fresh.watcher.close();
      watching.delete(key);
    });
    watcher.on("change", (_event, filename) => {
      const rel = typeof filename === "string" ? filename : filename?.toString() ?? "";
      if (rel && IGNORED.test(rel.replace(/\\/g, "/"))) return;
      if (fresh.timer) clearTimeout(fresh.timer);
      fresh.timer = setTimeout(() => {
        fresh.timer = undefined;
        for (const notify of fresh.clients) {
          try {
            notify();
          } catch {
          }
        }
      }, DEBOUNCE_MS);
      // a pending timer must not hold the process open at shutdown
      fresh.timer.unref?.();
    });
    watching.set(key, fresh);
    entry = fresh;
  }
  entry.clients.add(onChange);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    entry!.clients.delete(onChange);
    if (entry!.clients.size === 0) {
      if (entry!.timer) clearTimeout(entry!.timer);
      entry!.watcher.close();
      watching.delete(key);
    }
  };
}

/** How many workspaces are watched right now (a test asserts the refcount closes it). */
export function watchedWorkspaces(): string[] {
  return [...watching.keys()];
}
