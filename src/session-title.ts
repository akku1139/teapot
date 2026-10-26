export function sessionTitleFrom(firstUserPrompt: string | undefined | null): string | null {
  if (typeof firstUserPrompt !== "string") return null;
  const lines = firstUserPrompt.split("\n");
  let inFence = false;
  let fence = "";
  for (const raw of lines) {
    const fenceOpen = raw.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (fenceOpen) {
      const marker = fenceOpen[1]!;
      if (!inFence) {
        inFence = true;
        fence = marker[0]!;
        continue;
      }
      if (marker[0] === fence) {
        inFence = false; 
        continue;
      }
    }
    if (inFence) continue; 
    const line = raw
      .replace(/^\s{0,3}#{1,6}\s*/, "")
      .replace(/^\s{0,3}>\s?/, "")
      .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "")
      .replace(/[*_`~]/g, "")
      .trim();
    if (!line) continue;
    if (/^https?:\/\/\S+$/.test(line)) continue;
    if (/^#?\d+[.)]?$/.test(line)) continue;
    return clip(line, 60);
  }
  return null;
}

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const at = cut.lastIndexOf(" ");
  const body = at > max * 0.6 ? cut.slice(0, at) : cut;
  return `${body.trimEnd()}…`;
}
