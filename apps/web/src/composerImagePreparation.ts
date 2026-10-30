import { composerTargetKey, type DraftId } from "@ryco/client-runtime/state/composer";
import {
  createImagePreparationTracker,
  imagePreparationSendBlock,
} from "@ryco/client-runtime/state/composer/imageCompression";
import type { ScopedThreadRef } from "@ryco/contracts";
import { useSyncExternalStore } from "react";

import type { CompressImageFileResult } from "./lib/imageCompression";

/**
 * Images over the provider's image limit that are being shrunk before they join a composer's
 * draft. Process-wide, like the upload engine: a composer may change threads meanwhile, and the
 * image still belongs to the draft it was added to.
 */
export const composerImagePreparations = createImagePreparationTracker();

/** Why this composer cannot send yet: an image added to it is still being shrunk. */
export function useComposerImagePreparationSendBlock(
  target: ScopedThreadRef | DraftId,
): string | null {
  const pending = useSyncExternalStore(
    composerImagePreparations.subscribe,
    composerImagePreparations.snapshot,
    composerImagePreparations.snapshot,
  );
  return imagePreparationSendBlock(pending, composerTargetKey(target));
}

/** Shrinks an oversized image; the canvas code loads only now, never with the app. */
export async function shrinkComposerImage(
  file: File,
  maxBytes: number,
): Promise<CompressImageFileResult> {
  const { compressImageFileToByteLimit } = await import("./lib/imageCompression");
  return compressImageFileToByteLimit(file, maxBytes);
}
