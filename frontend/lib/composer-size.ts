export function composerHeight(scrollHeight: number, maxHeight: number): number {
  return Math.max(1, Math.min(scrollHeight, maxHeight));
}
