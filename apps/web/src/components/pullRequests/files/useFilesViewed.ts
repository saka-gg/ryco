import type { EnvironmentId } from "@ryco/contracts";
import { useLayoutEffect, useMemo, useRef, useState } from "react";

import { usePullRequestFilesViewed } from "../../projectExplorer/usePullRequestFilesViewed";
import { stackedThreadToast, toastManager } from "../../ui/toast";
import type { FileViewedState } from "./pullRequestFiles.logic";

export interface FilesViewedModel {
  /** The host stores viewed state for this change request. */
  readonly supported: boolean;
  readonly states: ReadonlyMap<string, FileViewedState>;
  readonly pendingPaths: ReadonlySet<string>;
  /** False while the viewed data describes another head than the diff on screen. */
  readonly writable: boolean;
  readonly setViewed: (path: string, viewed: boolean) => void;
  /** Bumped when viewed data first arrives, so files can collapse once. */
  readonly loadedToken: string | null;
}

const EMPTY_STATES: ReadonlyMap<string, FileViewedState> = new Map();
const EMPTY_PENDING: ReadonlySet<string> = new Set();

/**
 * Host-stored "viewed" marks for the Files tab. Reads poll only while the tab
 * is on screen; the last known marks stay up while a re-read is in flight
 * (including the re-read a new head starts), so checkboxes never blink back
 * to empty and viewed files do not spring open. Marks read at another head
 * are shown but not writable.
 */
export function useFilesViewed(input: {
  readonly environmentId: EnvironmentId | null;
  readonly cwd: string | null;
  readonly reference: string;
  readonly headSha: string | null;
  readonly active: boolean;
}): FilesViewedModel {
  const viewed = usePullRequestFilesViewed(input);
  const [last, setLast] = useState<{ key: string; data: NonNullable<typeof viewed.data> } | null>(
    null,
  );
  const key = input.reference;
  // Remember the latest marks during render (no effect round-trip).
  if (viewed.data && (last?.key !== key || last.data !== viewed.data)) {
    setLast({ key, data: viewed.data });
  }
  const data = viewed.data ?? (last?.key === key ? last.data : null);

  // The model keeps one identity across mutation-state renders; its setter
  // reaches the latest mutation through this ref.
  const setViewedRef = useRef(viewed.setViewed);
  useLayoutEffect(() => {
    setViewedRef.current = viewed.setViewed;
  });

  return useMemo<FilesViewedModel>(() => {
    const supported = data !== null && data.capability.storage !== "unsupported";
    const states = data ? new Map(data.files.map((file) => [file.path, file.state])) : EMPTY_STATES;
    return {
      supported,
      states,
      pendingPaths: viewed.pendingPaths.size > 0 ? viewed.pendingPaths : EMPTY_PENDING,
      writable: supported && input.headSha !== null && data?.headSha === input.headSha,
      setViewed: (path, next) => {
        void setViewedRef.current(path, next).catch((error: unknown) =>
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: next ? "Could not mark the file viewed" : "Could not unmark the file",
              description: error instanceof Error ? error.message : String(error),
            }),
          ),
        );
      },
      loadedToken: data ? `${key}\0${data.headSha ?? ""}` : null,
    };
  }, [data, input.headSha, key, viewed.pendingPaths]);
}
