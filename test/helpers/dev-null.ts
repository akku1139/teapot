import { devNull } from "node:os";

export const DEV_NULL = devNull;

export function throwawayConfigPath(): string {
  return DEV_NULL;
}
