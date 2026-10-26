
export function shouldWriteComposerValue(composing: boolean): boolean {
  return !composing;
}

export function composerValueChanged(nodeValue: string, next: string): boolean {
  return nodeValue !== next;
}
