
export interface ComposerKeyState {
  key: string;
  shiftKey: boolean;
  composing: boolean;
  maximized: boolean;
}

export function shouldSendOnKey(s: ComposerKeyState): boolean {
  if (s.key !== "Enter") return false;
  if (s.shiftKey) return false;
  if (s.composing) return false;
  if (s.maximized) return false;
  return true;
}

export function shouldRestoreAfterSend(maximized: boolean): boolean {
  return maximized;
}
