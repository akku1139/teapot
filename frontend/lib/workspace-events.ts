/**
 * File-change notifications, carried on the app's ONE WebSocket.
 *
 * The files panel briefly had its own socket (`/api/agents/:id/files-watch`), which worked but duplicated what the app socket
 * already has: a token, a 30-second ping with an unresponsive-client reaper, and a 1.5-second reconnect. MEASURED from the smoke
 * run: six `files-watch` sockets accumulated in a single pass (one per panel mount) beside ONE app socket. So the server folds it
 * into the app socket, and this module is the client half.
 *
 * The protocol is a subscription, not a broadcast: a panel says which agent it is looking at, and the server only watches those
 * workspaces, sending `files-changed` to the sockets that asked. That keeps the refcount honest — a workspace is watched because
 * somebody is looking at it, not because a tab is open.
 *
 * Refcounted here too, because a panel can mount twice for one agent (two tabs' worth of UI in one tab, a switch that remounts),
 * and only the last release should tell the server to stop.
 */
type Frame = { kind: string; agentId?: string };

/** How the app's socket is reached. Bound on open, cleared on close: frames must never be sent into a dead socket. */
let sendFrame: ((msg: Frame) => void) | null = null;

/** agentId -> the callbacks interested in it. The SIZE is the refcount sent to the server. */
const watchers = new Map<string, Set<() => void>>();

/**
 * Bind (or unbind) the app socket.
 *
 * Every subscription is re-announced when a socket opens, because a reconnect means the server forgot: the subscription lived in
 * the socket's own scope. Without this the panel would look alive and never refresh again — the same "a socket that goes quiet
 * does not fail" trap the terminal had.
 */
export function bindFileWatchSocket(send: ((msg: Frame) => void) | null): void {
  sendFrame = send;
  if (!send) return;
  for (const agentId of watchers.keys()) send({ kind: "watch-files", agentId });
}

/** A `files-changed` frame arrived: tell everyone watching that agent. */
export function dispatchFilesChanged(agentId: string): void {
  const set = watchers.get(agentId);
  if (!set) return;
  for (const cb of set) {
    try {
      cb();
    } catch {
    }
  }
}

/** Watch one agent's workspace. The returned function releases this watcher only. */
export function watchFiles(agentId: string, onChange: () => void): () => void {
  let set = watchers.get(agentId);
  if (!set) {
    set = new Set();
    watchers.set(agentId, set);
    sendFrame?.({ kind: "watch-files", agentId });
  }
  const first = set.size === 0;
  set.add(onChange);
  if (first && set.size === 1) sendFrame?.({ kind: "watch-files", agentId });

  let released = false;
  return () => {
    if (released) return;
    released = true;
    const current = watchers.get(agentId);
    if (!current) return;
    current.delete(onChange);
    if (current.size === 0) {
      watchers.delete(agentId);
      sendFrame?.({ kind: "unwatch-files", agentId });
    }
  };
}

/** How many agents have a live watcher (a test asserts the refcount). */
export function watchedFileAgents(): string[] {
  return [...watchers.keys()];
}
