/**
 * Reading a folder dropped from the OS. Chromium marks a directory on its drag
 * item (`webkitGetAsEntry`), not on the item's `File`, and the items can only
 * be read while the drop event is dispatched.
 */

/** The parts of a `DataTransferItem` read here; a real one satisfies it. */
interface DroppedItem {
  readonly kind: string;
  getAsFile(): File | null;
  webkitGetAsEntry?(): { readonly isDirectory: boolean } | null;
}

/** True for a drag that carries files from the OS, as opposed to text or links. */
export function isFileDrag(event: {
  readonly dataTransfer: { readonly types: ArrayLike<string> } | null;
}): boolean {
  return Array.from(event.dataTransfer?.types ?? []).includes("Files");
}

export type DroppedFolderCandidate =
  | { readonly kind: "folder"; readonly file: File }
  | { readonly kind: "notFolder" }
  | { readonly kind: "none" };

/**
 * The first dropped file item, and whether it is a folder; later items are
 * ignored. Must run synchronously inside the drop handler: DataTransfer items
 * are unreadable once it returns. The `File` stays valid, so its path can be
 * resolved afterwards.
 */
export function readDroppedFolderCandidate(dataTransfer: {
  readonly items: ArrayLike<DroppedItem>;
  readonly files: ArrayLike<File>;
}): DroppedFolderCandidate {
  const item = Array.from(dataTransfer.items).find((entry) => entry.kind === "file");
  if (!item) return { kind: "none" };
  if (item.webkitGetAsEntry?.()?.isDirectory !== true) return { kind: "notFolder" };
  const file = item.getAsFile() ?? dataTransfer.files[0];
  return file ? { kind: "folder", file } : { kind: "none" };
}
