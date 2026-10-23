/* ---------- workspace file tree ---------- */

export interface TreeNode {
  name: string;
  path: string;
  dir: boolean;
  size?: number;
  ignored?: boolean;
}

export type MediaKind = "image" | "video" | "audio";
export const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "avif"]);
export const VIDEO_EXT = new Set(["mp4", "webm", "mov", "mkv", "avi", "m4v"]);
export const AUDIO_EXT = new Set(["mp3", "wav", "ogg", "m4a", "flac", "aac", "opus"]);
export function ficon(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  const mk = mediaKindOf(name);
  if (mk === "image") return "🖼";
  if (mk === "video") return "🎬";
  if (mk === "audio") return "🎵";
  if (["ts", "tsx", "mts", "cts"].includes(ext)) return "🟦";
  if (["js", "mjs", "cjs", "jsx"].includes(ext)) return "🟨";
  if (ext === "json" || ext === "jsonc") return "🧾";
  if (ext === "md" || ext === "mdx" || ext === "markdown") return "📝";
  if (ext === "css" || ext === "scss" || ext === "less") return "🎨";
  if (ext === "html" || ext === "htm" || ext === "svg") return "🌐";
  if (["py", "pyi"].includes(ext)) return "🐍";
  if (ext === "rs") return "🦀";
  if (ext === "go") return "🐹";
  if (ext === "java" || ext === "kt" || ext === "kts") return "☕";
  if (ext === "rb") return "💎";
  if (ext === "php") return "🐘";
  if (ext === "c" || ext === "h" || ext === "cpp" || ext === "hpp" || ext === "cc") return "🧩";
  if (ext === "sh" || ext === "bash" || ext === "zsh" || ext === "fish") return "🐚";
  if (ext === "sql") return "🗄";
  if (ext === "yml" || ext === "yaml" || ext === "toml" || ext === "ini" || ext === "conf") return "⚙";
  if (ext === "lock") return "🔒";
  if (name === "Dockerfile" || ext === "dockerfile") return "🐳";
  if (ext === "zip" || ext === "gz" || ext === "tar" || ext === "tgz" || ext === "bz2") return "📦";
  if (ext === "pdf") return "📕";
  if (ext === "txt" || ext === "log") return "📄";
  return "·";
}

export function mediaKindOf(path: string): MediaKind | null {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  if (IMAGE_EXT.has(ext)) return "image";
  if (VIDEO_EXT.has(ext)) return "video";
  if (AUDIO_EXT.has(ext)) return "audio";
  return null;
}

/* ---------- per-agent file-panel UI state (remount-proof) ----------
 * Preview popups / expanded dirs used to live INSIDE FilesPanel. Any parent
 * re-render that remounted the panel (agent snapshot churn re-evaluating the
 * keyed <Show>) wiped them: an open file popup vanished mid-read and the
 * tree collapsed. Keeping the state in a module-level store keyed by agent
 * makes it survive remounts; only a REAL agent switch starts fresh. */
export type FileUiState = {
  expanded: Set<string>;
  preview: { path: string; content: string; binary?: boolean; truncated?: boolean } | null;
  media: { path: string; kind: MediaKind } | null;
  viewMode: "code" | "edit" | "md" | "media";
};
export const fileUi = new Map<string, FileUiState>();
export const fileUiFor = (agentId: string): FileUiState => {
  let s = fileUi.get(agentId);
  if (!s) {
    s = { expanded: new Set(), preview: null, media: null, viewMode: "code" };
    fileUi.set(agentId, s);
  }
  return s;
};
