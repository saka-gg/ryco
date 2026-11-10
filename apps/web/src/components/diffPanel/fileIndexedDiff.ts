import type { FileDiffMetadata } from "@pierre/diffs/react";
import {
  readCheckpointDiffFileIndex,
  type CheckpointDiffFileIndex,
} from "@ryco/client-runtime/rpc/checkpointDiffFiles";
import type { TurnDiffSummary } from "@ryco/client-runtime/state/threads";
import type {
  OrchestrationGetTurnDiffResult,
  OrchestrationTurnDiffFile,
} from "@ryco/contracts/orchestration";
import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";

import { getRenderablePatch } from "../../lib/diffParsing";
import { resolveDiffFilePath } from "../../lib/diffSearch";
import type { CheckpointDiffInput } from "../../rpc/providerAtoms";
import { checkpointDiffFilePatches } from "../../rpc/checkpointDiffFilePatches";

/**
 * Large turn diffs read file by file (D6): the panel lists every file from the
 * node's file index at once, and each file's patch loads when its file comes
 * near the viewport or is opened. Search and previous/next hunk load the rest
 * first. A loaded file is parsed on its own and becomes an ordinary
 * `FileDiffMetadata`; a file not loaded yet is a placeholder with the same
 * path, type and key, so collapse state, the file tree, file navigation and
 * route jumps see one stable list.
 */

/** Changed lines (from the turn summaries) from which a diff is read file by file. */
export const FILE_BY_FILE_MIN_CHANGED_LINES = 5_000;
/** A file index whose patches add up to less than this loads them all at once. */
export const FILE_BY_FILE_LOAD_ALL_BELOW_CHARS = 256 * 1024;

/**
 * Whether a checkpoint range is read file by file: its turn summaries count at
 * least `FILE_BY_FILE_MIN_CHANGED_LINES` changed lines, or do not say (older
 * summaries carry no counts). Smaller diffs keep the one request they make now.
 */
export function shouldReadDiffFileByFile(summaries: ReadonlyArray<TurnDiffSummary>): boolean {
  let lines = 0;
  for (const summary of summaries) {
    for (const file of summary.files) {
      if (file.additions === undefined || file.deletions === undefined) return true;
      lines += file.additions + file.deletions;
    }
  }
  return lines >= FILE_BY_FILE_MIN_CHANGED_LINES;
}

/** What the panel shows for a file whose patch has not arrived. */
export interface PendingDiffFile {
  readonly file: OrchestrationTurnDiffFile;
  readonly loading: boolean;
  readonly error: string | null;
}

type KeyedFileDiff = FileDiffMetadata & { renderKey?: string };

const pendingByPlaceholder = new WeakMap<FileDiffMetadata, PendingDiffFile>();

/** The render key a file keeps whether loaded or not (collapse state, list keys). */
export function fileIndexedRenderKey(fileDiff: FileDiffMetadata): string | undefined {
  return (fileDiff as KeyedFileDiff).renderKey;
}

/** The placeholder's file, or null for a loaded file. */
export function pendingDiffFileOf(fileDiff: FileDiffMetadata): PendingDiffFile | null {
  return pendingByPlaceholder.get(fileDiff) ?? null;
}

function placeholderType(file: OrchestrationTurnDiffFile): FileDiffMetadata["type"] {
  switch (file.status) {
    case "added":
      return "new";
    case "deleted":
      return "deleted";
    case "renamed":
      return file.additions + file.deletions > 0 ? "rename-changed" : "rename-pure";
    default:
      return "change";
  }
}

function makePlaceholder(file: OrchestrationTurnDiffFile, renderKey: string): KeyedFileDiff {
  const placeholder: KeyedFileDiff = {
    name: file.path,
    type: placeholderType(file),
    hunks: [],
    splitLineCount: 0,
    unifiedLineCount: 0,
    isPartial: true,
    deletionLines: [],
    additionLines: [],
    deletionCharacterCount: 0,
    additionCharacterCount: 0,
    cacheKey: `pending:${renderKey}`,
    renderKey,
  };
  if (file.previousPath !== undefined) placeholder.prevName = file.previousPath;
  return placeholder;
}

const PARSED_CACHE_MAX_CHARS = 16 * 1024 * 1024;
/** Parsed files by their patch key (immutable per commit pair), least recently used first. */
const parsedByPatchKey = new Map<string, { files: KeyedFileDiff[]; chars: number }>();
let parsedChars = 0;

function parsedFiles(patchKey: string, patch: string, renderKey: string): KeyedFileDiff[] {
  const cached = parsedByPatchKey.get(patchKey);
  if (cached) {
    parsedByPatchKey.delete(patchKey);
    parsedByPatchKey.set(patchKey, cached);
    return cached.files;
  }
  const renderable = getRenderablePatch(patch, "diff-panel");
  const files: KeyedFileDiff[] =
    renderable?.kind === "files"
      ? renderable.files.map((file, index) =>
          Object.assign(file, { renderKey: index === 0 ? renderKey : `${renderKey}:${index}` }),
        )
      : [];
  parsedByPatchKey.set(patchKey, { files, chars: patch.length });
  parsedChars += patch.length;
  for (const [key, entry] of parsedByPatchKey) {
    if (parsedChars <= PARSED_CACHE_MAX_CHARS || key === patchKey) break;
    parsedByPatchKey.delete(key);
    parsedChars -= entry.chars;
  }
  return files;
}

function compareFiles(left: FileDiffMetadata, right: FileDiffMetadata): number {
  return resolveDiffFilePath(left).localeCompare(resolveDiffFilePath(right), undefined, {
    numeric: true,
    sensitivity: "base",
  });
}

export interface FileIndexedDiff {
  /** Every file of the diff in the panel's order: loaded ones parsed, the rest placeholders. */
  readonly files: FileDiffMetadata[];
  readonly totals: {
    readonly files: number;
    readonly additions: number;
    readonly deletions: number;
  };
  /** Files whose patch has not arrived (loading or not asked for). */
  readonly pendingCount: number;
  readonly fileCount: number;
  /** Loads these files' patches unless held or on their way. */
  readonly request: (fileDiffs: ReadonlyArray<FileDiffMetadata>) => void;
  readonly requestAll: () => void;
}

function subscribe(listener: () => void) {
  return checkpointDiffFilePatches.subscribe(listener);
}

let storeVersion = 0;
checkpointDiffFilePatches.subscribe(() => {
  storeVersion += 1;
});
const readStoreVersion = () => storeVersion;

/**
 * The diff read file by file, or null when the node sent the whole diff (an
 * older node, or no file index was asked for): the panel then parses `diff`
 * as before.
 */
export function useFileIndexedDiff(
  input: CheckpointDiffInput,
  data: OrchestrationGetTurnDiffResult | null | undefined,
): FileIndexedDiff | null {
  const index: CheckpointDiffFileIndex | null = useMemo(
    () => (data?.fileView?.files ? readCheckpointDiffFileIndex(data) : null),
    [data],
  );
  const version = useSyncExternalStore(subscribe, readStoreVersion, readStoreVersion);

  const placeholders = useMemo(
    () =>
      index?.files.map((file) =>
        makePlaceholder(file, `file:${file.index}:${file.previousPath ?? ""}:${file.path}`),
      ) ?? [],
    [index],
  );

  const view = useMemo(() => {
    if (!index) return null;
    const files: FileDiffMetadata[] = [];
    let pendingCount = 0;
    let additions = 0;
    let deletions = 0;
    index.files.forEach((file, position) => {
      additions += file.additions;
      deletions += file.deletions;
      const placeholder = placeholders[position]!;
      const key = checkpointDiffFilePatches.filePatchKey(input, index, file.index);
      const state = checkpointDiffFilePatches.readFilePatch(key);
      const parsed =
        state.patch !== null ? parsedFiles(key, state.patch, placeholder.renderKey ?? key) : null;
      if (parsed && parsed.length > 0) {
        files.push(...parsed);
        return;
      }
      pendingCount += 1;
      pendingByPlaceholder.set(placeholder, {
        file,
        loading: state.isLoading,
        error:
          state.error ?? (state.patch !== null ? "This file's patch could not be read." : null),
      });
      files.push(placeholder);
    });
    return {
      files: files.toSorted(compareFiles),
      totals: { files: index.files.length, additions, deletions },
      pendingCount,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `version` stands for the store: a file's patch arrived or failed.
  }, [index, placeholders, version, input.environmentId, input.ignoreWhitespace]);

  const request = useCallback(
    (fileDiffs: ReadonlyArray<FileDiffMetadata>) => {
      if (!index) return;
      for (const fileDiff of fileDiffs) {
        const pending = pendingByPlaceholder.get(fileDiff);
        if (pending && !pending.loading) {
          checkpointDiffFilePatches.loadFilePatch(input, index, pending.file.index);
        }
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the input's identity fields; the object is rebuilt per render.
    [index, input.environmentId, input.threadId, input.fromTurnCount, input.toTurnCount],
  );
  const requestAll = useCallback(() => {
    if (!view) return;
    request(view.files.filter((fileDiff) => pendingByPlaceholder.has(fileDiff)));
  }, [request, view]);

  // A small diff behind a file index loads whole: one more request, no placeholders.
  useEffect(() => {
    if (!index) return;
    let chars = 0;
    for (const file of index.files) chars += file.patchChars;
    if (chars < FILE_BY_FILE_LOAD_ALL_BELOW_CHARS) {
      for (const file of index.files) {
        checkpointDiffFilePatches.loadFilePatch(input, index, file.index);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per file index; the input it belongs to comes with it.
  }, [index]);

  return useMemo(
    () =>
      view
        ? {
            files: view.files,
            totals: view.totals,
            pendingCount: view.pendingCount,
            fileCount: view.totals.files,
            request,
            requestAll,
          }
        : null,
    [request, requestAll, view],
  );
}
