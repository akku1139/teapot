/**
 * Which agent a fresh page load should open.
 *
 * The order is a priority chain, and it is worth stating once because getting it wrong is invisible: the app
 * simply opens something the operator did not ask for and looks stuck.
 *
 *   1. the agent that owns the session named in the URL (a deep link, or the route we saved ourselves)
 *   2. whatever was open last time
 *   3. the first agent
 *
 * The URL names a SESSION and nothing else. There used to be a step between 1 and 2 that accepted an AGENT
 * id in the URL and opened that agent's latest session — which is how two tabs deep-linked to two agent ids
 * collapsed onto one timeline, and it is the reason a freshly created session used to be *written* as its
 * agent id ("URLがエージェント間メッセージ用の短縮名になる"). Deleting the reader is what makes the writer's
 * mistake impossible to exploit; a URL that names an agent simply falls through to 2.
 *
 * Ghosts (workspaces that no longer exist on disk) are filtered out of EVERY step when the operator has
 * chosen to hide them — a ghost that wins the chain gets its session directory loaded for a workspace that
 * is gone, which is both useless and exactly the kind of read boot is supposed to avoid.
 *
 * Two edge cases decide what happens when the filter would leave nothing, and both are deliberate:
 *
 *   - EVERY agent is a ghost → the filter is dropped and a ghost is opened. Hiding ghosts is a preference
 *     about clutter, not a promise to render an empty app when that is all there is.
 *   - there are NO agents yet (a fresh install, or a boot where the list has not arrived) → `undefined`, and
 *     the caller selects nothing. Inventing a selection here would mean creating state for an agent that
 *     does not exist; the app's own empty state is the honest answer, and the next refresh can select.
 */
export interface RestorableAgent {
  id: string;
  workspaceMissing?: boolean;
}

export function pickInitialAgent(args: {
  agents: RestorableAgent[];
  /** the id in the URL: a session id, or an agent id */
  urlId: string | null;
  /** which agent owns a given session id, when it is one */
  ownerOf: (sessionId: string) => string | undefined;
  /** the agent open last time */
  lastId: string | null;
  hideGhosts: boolean;
}): RestorableAgent | undefined {
  const visible = args.hideGhosts ? args.agents.filter((a) => !a.workspaceMissing) : args.agents;
  const pool = visible.length ? visible : args.agents;
  const want = args.urlId;
  const owner = want ? args.ownerOf(want) : undefined;
  return (
    (owner ? pool.find((a) => a.id === owner) : undefined) ??
    pool.find((a) => a.id === args.lastId) ??
    pool[0]
  );
}
