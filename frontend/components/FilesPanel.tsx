import { For, Show, createEffect, createSignal, onCleanup } from "solid-js";
import { api } from "../lib/api";
import { flashHint } from "../lib/flash";
import { IconBtn, Modal } from "./chrome";
import { CodePreview } from "./settings-parts";
import { renderMarkdown } from "../md";
import { highlightChunks } from "../lib/shiki";
import { ficon, fileUiFor, mediaKindOf, type FileUiState, type TreeNode } from "../lib/file-tree";
import { fmtK } from "../lib/timeline-row";

export function FilesPanel(props: { agentId: string; workspace: string }) {
  const ui = fileUiFor(props.agentId);
  const [kids, setKids] = createSignal<Map<string, TreeNode[]>>(new Map());
  const [expanded, setExpandedRaw] = createSignal<Set<string>>(ui.expanded);
  const [preview, setPreviewRaw] = createSignal(ui.preview);
  const setPreview = (v: FileUiState["preview"]) => { ui.preview = v; setPreviewRaw(v); };
  const setExpanded = (v: Set<string>) => { ui.expanded = v; setExpandedRaw(v); };
  const [media, setMediaRaw] = createSignal(ui.media);
  const setMedia = (v: FileUiState["media"]) => { ui.media = v; setMediaRaw(v); };
  const [viewMode, setViewModeRaw] = createSignal(ui.viewMode);
  const setViewMode = (v: FileUiState["viewMode"]) => { ui.viewMode = v; setViewModeRaw(v); };
  const [err, setErr] = createSignal("");
  const [ignoreMode, setIgnoreMode] = createSignal(
    localStorage.getItem("teapot.ignoreMode") ?? "dim",
  );
  const cycleIgnoreMode = () => {
    const order = ["dim", "hide", "show"] as const;
    const next = order[(order.indexOf(ignoreMode() as any) + 1) % 3];
    setIgnoreMode(next);
    localStorage.setItem("teapot.ignoreMode", next);
  };
  const ignoreFilter = (n: TreeNode) => (ignoreMode() === "hide" ? !n.ignored : true);
  const [showHidden, setShowHidden] = createSignal(
    localStorage.getItem("teapot.showHidden") === "1",
  );
  const toggleHidden = () => {
    const next = !showHidden();
    const targets = ["", ...expanded()];
    void Promise.all(targets.map(async (p) => ({ p, rows: await fetchDirWith(p, next) })))
      .then((results) => {
        setShowHidden(next);
        localStorage.setItem("teapot.showHidden", next ? "1" : "0");
        for (const { p, rows } of results) if (rows) mergeKids(p, rows);
      });
  };

  const parseEntries = (parentPath: string, list: any[]): TreeNode[] =>
    list.map((e) => ({
      name: String(e.name),
      path: parentPath ? `${parentPath}/${e.name}` : String(e.name),
      dir: !!e.dir,
      ...(typeof e.size === "number" ? { size: e.size } : {}),
      ...(e.ignored ? { ignored: true } : {}),
    }));

  async function fetchDir(path: string): Promise<TreeNode[] | null> {
    return fetchDirWith(path, showHidden());
  }

  async function fetchDirWith(path: string, hidden: boolean): Promise<TreeNode[] | null> {
    try {
      const qs = new URLSearchParams();
      if (path) qs.set("path", path);
      if (hidden) qs.set("hidden", "1");
      const r = await api(
        `/api/agents/${props.agentId}/tree?${qs.toString()}`,
      );
      return parseEntries(path, r.entries ?? []);
    } catch (ex) {
      setErr((ex as Error).message);
      return null;
    }
  }

  const mergeKids = (path: string, rows: TreeNode[]) =>
    setKids((prev) => {
      const old = prev.get(path);
      if (!old) return new Map(prev).set(path, rows);
      const byPath = new Map(old.map((o) => [o.path, o]));
      const merged = rows.map((fresh) => {
        const o = byPath.get(fresh.path);
        return o && o.dir === fresh.dir && o.size === fresh.size &&
               o.ignored === fresh.ignored && o.name === fresh.name
          ? o
          : fresh;
      });
      const kept = merged.filter((m) => rows.some((r) => r.path === m.path) || ui.preview?.path === m.path);
      const next = new Map(prev);
      next.set(path, kept);
      return next;
    });

  let kidsFor = "";
  createEffect(() => {
    const id = props.agentId;
    if (id === kidsFor) return; 
    kidsFor = id;
    setExpanded(new Set<string>());
    setPreview(null);
    setMedia(null);
    setKids(new Map());
    void fetchDir("").then((rows) => {
      if (rows && kidsFor === id) setKids(new Map([[ "", rows ]]));
    });
  });

  const toggleDir = async (node: TreeNode) => {
    const next = new Set<string>(expanded());
    if (next.has(node.path)) {
      next.delete(node.path);
      setExpanded(next);
      return;
    }
    next.add(node.path);
    setExpanded(next);
    if (!kids().has(node.path)) {
      const rows = await fetchDir(node.path);
      if (rows) mergeKids(node.path, rows);
    }
  };

  const [hlHtml, setHlHtml] = createSignal("");
  const [hlPending, setHlPending] = createSignal(false);
  const [editBuf, setEditBuf] = createSignal("");
  const [saving, setSaving] = createSignal(false);
  const isMd = (path: string) => /\.(md|markdown|mdx)$/i.test(path);
  let hlRun = 0;
  const startHighlighting = async (p: { path: string; content: string; truncated?: boolean }) => {
    const run = ++hlRun;
    setHlHtml("");
    setHlPending(true);
    try {
      const { highlightChunks } = await import("../lib/shiki");
      for await (const chunk of highlightChunks(p.path, p.content)) {
        if (hlRun !== run) return;
        setHlHtml((prev) => prev + chunk);
      }
    } catch {
      if (hlRun === run) setHlHtml(""); 
    } finally {
      if (hlRun === run) setHlPending(false);
    }
  };
  onCleanup(() => { hlRun++; });

  const openFileWith = async (
    node: TreeNode,
    mode: "code" | "edit" | "md",
  ) => {
    const mk = mediaKindOf(node.path);
    if (mk) {
      setPreview({ path: node.path, content: "", binary: true });
      setMedia({ path: node.path, kind: mk });
      setViewMode("media");
      return;
    }
    try {
      const r = await api(
        `/api/agents/${props.agentId}/file?path=${encodeURIComponent(node.path)}`,
      );
      setMedia(null);
      setPreview({ path: node.path, content: r.content ?? "", binary: r.binary, truncated: r.truncated });
      setEditBuf(r.content ?? "");
      setViewMode(r.binary ? "code" : mode);
      if (!r.binary && mode !== "md") {
        startHighlighting({ path: node.path, content: r.content ?? "", truncated: r.truncated });
      }
    } catch (ex) {
      flashHint(`open failed: ${(ex as Error).message}`);
    }
  };

  const saveFile = async () => {
    const pv = preview();
    if (!pv || saving()) return;
    setSaving(true);
    try {
      await api(`/api/agents/${props.agentId}/file?path=${encodeURIComponent(pv.path)}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: editBuf(), baseContent: pv.content }),
      });
      setPreview({ ...pv, content: editBuf() }); 
      flashHint(`saved ${pv.path}`);
    } catch (ex) {
      const raw = (ex as { payload?: unknown }).payload;
      const conflict =
        raw && typeof raw === "object" && (raw as any).error === "file changed on disk"
          ? (raw as { current?: string })
          : null;
      if (conflict?.current !== undefined) {
        const take = confirm(
          "This file changed on disk since you opened it.\n" +
            "OK = load the disk version into the editor (your edits are discarded)\n" +
            "Cancel = keep editing your copy",
        );
        if (take) {
          setEditBuf(conflict.current!);
          setPreview({ ...pv, content: conflict.current! });
          flashHint("loaded the current file from disk");
        } else {
          flashHint("kept your edits — use Save As via bash to force-write");
        }
      } else {
        flashHint(`save failed: ${(ex as Error).message}`);
      }
    } finally {
      setSaving(false);
    }
  };

  const isEditable = (pv: { binary?: boolean; truncated?: boolean }) =>
    !pv.binary && !pv.truncated;

  const row = (node: TreeNode, depth: number): any => (
    <>
      <div
        class={
          "filerow" + (node.dir ? " isdir" : "") +
          (node.ignored && ignoreMode() === "dim" ? " gitignored" : "")
        }
        style={`padding-left:${depth * 13 + 8}px`}
        onclick={() => (node.dir ? void toggleDir(node) : void openFileWith(node, "code"))}
        title={node.dir ? `browse ${node.path}` : `preview ${node.path}`}
      >
        <span class="ficon">{node.dir ? (expanded().has(node.path) ? "▾" : "▸") : ficon(node.name)}</span>
        <span class="fname">{node.name}</span>
        <Show when={!node.dir && node.size !== undefined}>
          <span class="fsize">{fmtK(node.size!)}</span>
        </Show>
      </div>
      <Show when={node.dir && expanded().has(node.path)}>
        <For each={(kids().get(node.path) ?? []).filter(ignoreFilter)}>{(child) => row(child, depth + 1)}</For>
      </Show>
    </>
  );

  const wsName = () => props.workspace.split("/").filter(Boolean).pop() ?? props.workspace;

  /** refresh root + every expanded dir IN PLACE — mergeKids keeps unchanged
   * row objects, so the tree updates without flicker and an open file popup
   * is never touched (its state lives outside the row list entirely). */
  const [refreshing, setRefreshing] = createSignal(false);
  const refreshTree = async () => {
    if (refreshing()) return;
    setRefreshing(true);
    try {
      const targets = ["", ...expanded()];
      const results = await Promise.all(
        targets.map(async (p) => ({ p, rows: await fetchDirWith(p, showHidden()) })),
      );
      for (const { p, rows } of results) if (rows) mergeKids(p, rows);
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <>
      <h3 style="display:flex;align-items:center;gap:6px" title="the agent's workspace — lazy-loaded, dotfiles hidden; click a folder to expand, a file to preview">
        🗂 files <span class="muted" style="text-transform:none;letter-spacing:0">· {wsName()}</span>
        <IconBtn
          class="filetoggle"
          icon={refreshing() ? "…" : "⟳"}
          title="refresh the tree (root + expanded folders) — open popups are kept"
          onClick={() => void refreshTree()}
        />
        <IconBtn
          class="filetoggle"
          style="margin-left:auto"
          icon={ignoreMode() === "hide" ? "🙈" : ignoreMode() === "dim" ? "👁" : "✨"}
          title={`gitignored files: ${ignoreMode()} — click to cycle (dim → hidden → shown)`}
          onClick={cycleIgnoreMode}
        />
        <IconBtn
          class="filetoggle"
          icon={showHidden() ? "◉." : "○."}
          title={showHidden() ? "dotfiles shown — click to hide" : "dotfiles hidden — click to show"}
          onClick={toggleHidden}
        />
      </h3>
      <div class="filebox">
        <Show
          when={(kids().get("") ?? []).length > 0}
          fallback={<div class="muted" style="padding:6px">{err() || "empty workspace"}</div>}
        >
          <For each={(kids().get("") ?? []).filter(ignoreFilter)}>
            {(node) => row(node, 0)}
          </For>
        </Show>
      </div>
      <Show when={preview()}>
        {(pv) => (
          <Modal title={`🗂 ${pv().path}`} onClose={() => { hlRun++; setPreview(null); setMedia(null); }}>
            <Show
              when={media()}
              fallback={
                <>
                  <div class="filetoolbar">
                    <Show when={isMd(pv().path) && !pv().binary}>
                      <button class={viewMode() === "md" ? "on" : ""} onclick={() => setViewMode("md")} title="rendered markdown">👁 preview</button>
                    </Show>
                    <button class={viewMode() === "code" ? "on" : ""} onclick={() => { setViewMode("code"); if (!hlHtml()) startHighlighting({ path: pv().path, content: pv().content, truncated: pv().truncated }); }} title="syntax-highlighted source">{"</>"} code</button>
                    <Show when={isEditable(pv())}>
                      <button class={viewMode() === "edit" ? "on" : ""} onclick={() => setViewMode("edit")} title="edit and save back to the workspace">✎ edit</button>
                    </Show>
                  </div>
                  <Show
                    when={!pv().binary}
                    fallback={
                      <div class="mono" style="margin:0;color:var(--dim)">
                        (binary file — inspect it from the terminal)
                      </div>
                    }
                  >
                    <Show when={viewMode() === "edit"} fallback={
                      <Show when={viewMode() === "md" && isMd(pv().path)} fallback={
                        <CodePreview
                          path={pv().path}
                          content={pv().content}
                          html={hlHtml()}
                          pending={hlPending()}
                          truncated={!!pv().truncated}
                        />
                      }>
                        <div class="content mdpreview shikiwrap" innerHTML={renderMarkdown(pv().content)} />
                      </Show>
                    }>
                      <div class="fileeditor">
                        <textarea
                          class="mono"
                          value={editBuf()}
                          oninput={(e) => setEditBuf(e.currentTarget.value)}
                          spellcheck={false}
                        />
                        <div class="filerow-actions">
                          <span class="muted">{fmtK(editBuf().length)} bytes</span>
                          <button class="savebtn" disabled={saving() || editBuf() === pv().content} onclick={() => void saveFile()}>
                            {saving() ? "saving…" : "💾 save"}
                          </button>
                        </div>
                      </div>
                    </Show>
                  </Show>
                </>
              }
            >
              {}
              <div class="mediapreview">
                <Show when={media()!.kind === "image"} fallback={
                  <Show when={media()!.kind === "video"} fallback={
                    <audio controls src={`/api/agents/${props.agentId}/raw?path=${encodeURIComponent(media()!.path)}`} />
                  }>
                    <video controls src={`/api/agents/${props.agentId}/raw?path=${encodeURIComponent(media()!.path)}`} />
                  </Show>
                }>
                  <img src={`/api/agents/${props.agentId}/raw?path=${encodeURIComponent(media()!.path)}`} alt={media()!.path.split("/").pop()} />
                </Show>
                <div class="meta muted">{media()!.kind} preview</div>
              </div>
            </Show>
          </Modal>
        )}
      </Show>
    </>
  );
}
