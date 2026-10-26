/**
 * Typed access to a log event's payload.
 *
 * `TeapotEvent.data` is `unknown`, and that is correct in production: the log is an open
 * record and different event types carry different fields. A test, though, knows which
 * fields it is asserting, so it needs a narrowing that is written down ONCE instead of
 * repeated as `(e.data as any)` at every call site — those casts also silently accept a
 * misspelled field, which is how an assertion ends up checking nothing.
 *
 *   events.filter((e) => dataOf(e).event === "audit-retry-cap")
 */
import type { TeapotEvent } from "../../src/log/events.ts";

/** the payload, seen as a plain record (fields still optional — check them) */
export function dataOf(e: Pick<TeapotEvent, "data"> | { data?: unknown }): Record<string, any> {
  const d = (e as { data?: unknown }).data;
  return d && typeof d === "object" ? (d as Record<string, any>) : {};
}
