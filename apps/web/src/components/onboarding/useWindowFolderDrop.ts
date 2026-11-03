import { useEffect, useEffectEvent, useState } from "react";

import { isFileDrag, readDroppedFolderCandidate } from "../../lib/folderDrop";
import { readLocalApi } from "../../localApi";

async function resolveFolderPath(file: File): Promise<string | null> {
  try {
    const path = await readLocalApi()?.shell.getPathForFile?.(file);
    return path?.trim() ? path : null;
  } catch {
    return null;
  }
}

export interface WindowFolderDropState {
  /** A file drag is over the window. */
  readonly dragging: boolean;
  /** Why the last drop was not taken, until the next drag or until disabled. */
  readonly error: string | null;
}

/**
 * While `enabled`, takes a folder dropped anywhere in the window: a small
 * target is easy to miss, and a missed drop would vanish. Listeners bind on
 * `window` in the capture phase and claim file drags only. A drop whose path
 * resolves after `enabled` turned off is discarded.
 */
export function useWindowFolderDrop(options: {
  readonly enabled: boolean;
  /** Called with the dropped folder's absolute path. */
  readonly onFolder: (path: string) => void;
}): WindowFolderDropState {
  const { enabled } = options;
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The latest callback, so the listeners bind once per `enabled` change.
  const onFolder = useEffectEvent(options.onFolder);

  useEffect(() => {
    if (!enabled) return;
    let active = true;
    let dragDepth = 0;
    const onDragEnter = (event: DragEvent) => {
      if (!isFileDrag(event)) return;
      dragDepth += 1;
      setDragging(true);
      setError(null);
    };
    const onDragOver = (event: DragEvent) => {
      if (!isFileDrag(event)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    };
    const onDragLeave = (event: DragEvent) => {
      if (!isFileDrag(event)) return;
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) setDragging(false);
    };
    const onDrop = (event: DragEvent) => {
      const { dataTransfer } = event;
      if (!dataTransfer || !isFileDrag(event)) return;
      event.preventDefault();
      event.stopPropagation();
      dragDepth = 0;
      setDragging(false);
      setError(null);
      const candidate = readDroppedFolderCandidate(dataTransfer);
      if (candidate.kind === "none") return;
      if (candidate.kind === "notFolder") {
        setError("Drop a folder, not a file.");
        return;
      }
      void resolveFolderPath(candidate.file).then((path) => {
        if (!active) return;
        if (path) onFolder(path);
        else setError("Could not read the folder's path. Use Add project instead.");
      });
    };
    window.addEventListener("dragenter", onDragEnter, true);
    window.addEventListener("dragover", onDragOver, true);
    window.addEventListener("dragleave", onDragLeave, true);
    window.addEventListener("drop", onDrop, true);
    return () => {
      active = false;
      setDragging(false);
      setError(null);
      window.removeEventListener("dragenter", onDragEnter, true);
      window.removeEventListener("dragover", onDragOver, true);
      window.removeEventListener("dragleave", onDragLeave, true);
      window.removeEventListener("drop", onDrop, true);
    };
  }, [enabled]);

  return { dragging, error };
}
