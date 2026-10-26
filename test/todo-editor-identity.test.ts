/**
 * #30 — an in-progress todo edit lost focus/caret whenever the right panel
 * re-rendered for an agent-update snapshot.
 *
 * The panel was gated on the agent OBJECT (`<Show when={sel()}>`). The
 * compiled children getter builds a fresh array on every `sel()` change, so a
 * new snapshot identity made Solid rebuild the whole right panel — taking the
 * focused textarea with it. Verified by staging the real UI: the editor
 * survived typing, saving and the /api/agents poll, and was recreated ONLY by
 * the websocket `agent-update` (sameNode=false, focus lost).
 *
 * Gating on the agent ID (keyed) rebuilds only when the operator actually
 * switches agent, which is the only case where discarding UI state is correct.
 * The editor is also its own component with primitive props, giving Solid a
 * stable element to keep.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
// #126: normalises CRLF so source anchors behave the same on Windows

/* ---------- the gate ---------- */


/* ---------- the real check lives in the bundle smoke test ---------- */

/* ---------- EACH gate is keyed, not just one of them (#75 T5c/T5d) ---------- */

/**
 * The two assertions above were satisfied by the OUTER gate alone. Removing
 * `keyed` from the session panel gate (:3378) or the FilesPanel gate (:3391)
 * individually left all seven tests green — while the whole point of #30 is that
 * each of these re-renders its subtree on every snapshot.
 *
 * The outer gate cannot mask that in practice: Solid rebuilds the nested JSX
 * when the outer one re-runs, and a nested unkeyed gate is exactly what then
 * thrashes. So each gate is pinned by its own surroundings.
 */
