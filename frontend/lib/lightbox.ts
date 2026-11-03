import { createSignal } from "solid-js";

/**
 * One enlarged image at a time, opened from anywhere.
 *
 * A module-level signal rather than props: the images live in `rows.tsx` (which renders a timeline row) and in
 * the composer, while the overlay belongs to App — threading a callback through both would be two owners of one
 * piece of state. Reported as "添付画像やread_fileの画像をクリックしたら拡大するように / 画像を新しいタブで開くのは
 * めんどくさい".
 */
const [src, setSrc] = createSignal<string | null>(null);

export const lightboxSrc = src;

export function openLightbox(url: string): void {
  if (url) setSrc(url);
}

export function closeLightbox(): void {
  setSrc(null);
}
