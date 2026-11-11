/**
 * One loading state, so every panel says the same thing in the same shape.
 *
 * Reported twice from opposite ends: the file tree showed "empty workspace" while it was still loading (#239 — "ファイルツリー
 * 読み込み中にemptyになる / UX悪い / loading状態をコンポーネント化すべき"), and the timeline's own "loading timeline…" was
 * wired to the session-switch path only, so returning from sleep showed nothing while it fetched (#246). A shared component
 * is what makes those two the same thing instead of two hand-rolled spans that drift.
 */
export function Loading(props: { what: string; class?: string }) {
  return (
    <div class={"loadingrow" + (props.class ? ` ${props.class}` : "")} role="status" aria-live="polite">
      <span class="spinner" aria-hidden="true" /> loading {props.what}…
    </div>
  );
}
