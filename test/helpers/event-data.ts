import type { TeapotEvent } from "../../src/log/events.ts";

export function dataOf(e: Pick<TeapotEvent, "data"> | { data?: unknown }): Record<string, any> {
  const d = (e as { data?: unknown }).data;
  return d && typeof d === "object" ? (d as Record<string, any>) : {};
}
