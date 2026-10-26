/**
 * #87 — "with a pending message, go to another session and come back: the
 * timeline no longer shows that it is pending."
 *
 * The top bar kept counting it (that comes from the server's `pendingPromptIds`)
 * while the timeline showed the message as a settled log row. The two disagreed,
 * and the timeline read as "already sent".
 *
 * Cause: `pendingMsgs` was ONE global list, cleared on every session switch —
 * while every other per-session store here survives one (`liveByAgent`,
 * `timelineCache`, `drafts`). So the echoes were simply gone on return, and
 * `stillPendingIds` (derived from that list) no longer covered the queued
 * prompt, so its log row rendered as settled.
 *
 * Now keyed by the same handle the timeline uses.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

// #126: normalises CRLF so source anchors behave the same on Windows

