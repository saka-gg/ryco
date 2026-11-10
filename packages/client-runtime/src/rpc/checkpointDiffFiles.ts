import type { EnvironmentApi, EnvironmentId } from "@ryco/contracts";
import type {
  OrchestrationGetTurnDiffResult,
  OrchestrationTurnDiffFile,
} from "@ryco/contracts/orchestration";
import { readGitPatchFiles } from "@ryco/shared/gitPatchFiles";
import * as Atom from "effect/reactivity/Atom";

import { appAtomRegistry } from "./atomRegistry.ts";
import type { CheckpointDiffInput } from "./checkpointDiffStore.ts";

// Its own subpath export, not the `@ryco/client-runtime/rpc` barrel: only the
// screens that read a diff file by file load it (and the patch splitter).

/**
 * A turn diff read file by file (D6): the file list first, then each file's
 * patch when it is opened. Patches are kept by the checkpoint commit pair, so
 * they never go stale: a revert or a new turn yields another pair.
 */
export interface CheckpointDiffFileIndex {
  /** The commit pair the node read; null when an older node sent the whole diff. */
  readonly commits: { readonly fromCommitOid: string; readonly toCommitOid: string } | null;
  readonly files: ReadonlyArray<OrchestrationTurnDiffFile>;
  /** An older node's whole diff, split here: every patch is already held. */
  readonly localPatches: ReadonlyArray<string> | null;
}

const EMPTY_INDEX: CheckpointDiffFileIndex = Object.freeze({
  commits: null,
  files: [],
  localPatches: [],
});

/** The file list of a `fileIndex` read, from a node that answers one or from the whole diff. */
export function readCheckpointDiffFileIndex(
  result: OrchestrationGetTurnDiffResult,
): CheckpointDiffFileIndex {
  const view = result.fileView;
  if (view?.files) {
    return {
      commits: { fromCommitOid: view.fromCommitOid, toCommitOid: view.toCommitOid },
      files: view.files,
      localPatches: null,
    };
  }
  if (result.diff.length === 0) return EMPTY_INDEX;
  const files = readGitPatchFiles(result.diff);
  return {
    commits: null,
    files: files.map((file, index) => ({
      index,
      path: file.path,
      ...(file.previousPath !== null ? { previousPath: file.previousPath } : {}),
      status: file.status,
      ...(file.binary ? { binary: true } : {}),
      additions: file.additions,
      deletions: file.deletions,
      patchChars: file.patch.length,
    })),
    localPatches: files.map((file) => file.patch),
  };
}

export interface CheckpointDiffFilePatchState {
  readonly patch: string | null;
  readonly error: string | null;
  readonly isLoading: boolean;
}

const IDLE: CheckpointDiffFilePatchState = Object.freeze({
  patch: null,
  error: null,
  isLoading: false,
});

/** Files asked for in one request at most (the contract's bound). */
const MAX_FILES_PER_REQUEST = 64;
const CHANGED_DIFF = "This diff changed. Reopen it to read the current files.";

type DiffApi = Pick<EnvironmentApi["orchestration"], "getFullThreadDiff" | "getTurnDiff">;

export interface CheckpointDiffFilePatchesOptions {
  readonly resolveOrchestrationApi: (environmentId: EnvironmentId) => DiffApi;
  /** Patch characters kept across every file; the least recently loaded go first. */
  readonly maxRetainedChars: number;
}

export function createCheckpointDiffFilePatches(options: CheckpointDiffFilePatchesOptions) {
  const patchAtom = Atom.family((_key: string) =>
    Atom.make<CheckpointDiffFilePatchState>(IDLE).pipe(Atom.keepAlive),
  );
  /** Loaded patches, insertion-ordered by load: the first is the oldest. */
  const retained = new Map<string, number>();
  let retainedChars = 0;
  /** Requests waiting for this tick, by diff (range and commit pair). */
  const pending = new Map<
    string,
    { input: CheckpointDiffInput; index: CheckpointDiffFileIndex; files: Map<number, string> }
  >();
  let flushScheduled = false;

  const set = (key: string, state: CheckpointDiffFilePatchState) =>
    appAtomRegistry.set(patchAtom(key), state);
  const get = (key: string) => appAtomRegistry.get(patchAtom(key));

  const retain = (key: string, patch: string) => {
    set(key, { patch, error: null, isLoading: false });
    retained.delete(key);
    retained.set(key, patch.length);
    retainedChars += patch.length;
    for (const [oldest, chars] of retained) {
      if (retainedChars <= options.maxRetainedChars || oldest === key) break;
      retained.delete(oldest);
      retainedChars -= chars;
      set(oldest, IDLE);
    }
  };

  /** Where a file's patch lives: by commit pair when the node named it, else by the read. */
  const keyOf = (input: CheckpointDiffInput, index: CheckpointDiffFileIndex, file: number) =>
    JSON.stringify(
      index.commits
        ? [
            input.environmentId,
            index.commits.fromCommitOid,
            index.commits.toCommitOid,
            input.ignoreWhitespace,
            file,
          ]
        : [
            input.environmentId,
            input.threadId,
            input.fromTurnCount,
            input.toTurnCount,
            input.ignoreWhitespace,
            "whole",
            file,
          ],
    );

  async function request(
    input: CheckpointDiffInput,
    index: CheckpointDiffFileIndex,
    files: ReadonlyArray<[number, string]>,
  ) {
    try {
      if (!input.environmentId || !input.threadId || input.toTurnCount === null)
        throw new Error("Checkpoint diff is unavailable.");
      const api = options.resolveOrchestrationApi(input.environmentId);
      const fileView = { kind: "files" as const, indices: files.map(([file]) => file) };
      const result =
        input.fromTurnCount === 0
          ? await api.getFullThreadDiff({
              threadId: input.threadId,
              toTurnCount: input.toTurnCount,
              ignoreWhitespace: input.ignoreWhitespace,
              fileView,
            })
          : await api.getTurnDiff({
              threadId: input.threadId,
              fromTurnCount: input.fromTurnCount ?? 0,
              toTurnCount: input.toTurnCount,
              ignoreWhitespace: input.ignoreWhitespace,
              fileView,
            });
      const view = result.fileView;
      if (
        !view?.patches ||
        view.fromCommitOid !== index.commits?.fromCommitOid ||
        view.toCommitOid !== index.commits?.toCommitOid
      )
        throw new Error(CHANGED_DIFF);
      const byIndex = new Map(view.patches.map((entry) => [entry.index, entry.patch]));
      for (const [file, key] of files) {
        const patch = byIndex.get(file);
        if (patch === undefined) set(key, { patch: null, error: CHANGED_DIFF, isLoading: false });
        else retain(key, patch);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to load the file's diff.";
      for (const [, key] of files) set(key, { patch: null, error: message, isLoading: false });
    }
  }

  function flush() {
    flushScheduled = false;
    const batches = [...pending.values()];
    pending.clear();
    for (const batch of batches) {
      const files = [...batch.files];
      for (let start = 0; start < files.length; start += MAX_FILES_PER_REQUEST) {
        void request(batch.input, batch.index, files.slice(start, start + MAX_FILES_PER_REQUEST));
      }
    }
  }

  /**
   * Loads one file's patch unless it is held or on its way. Files asked for in
   * the same tick travel in one request.
   */
  function loadFilePatch(
    input: CheckpointDiffInput,
    index: CheckpointDiffFileIndex,
    file: number,
  ): string {
    const key = keyOf(input, index, file);
    const current = get(key);
    if (current.patch !== null || current.isLoading) return key;
    const local = index.localPatches?.[file];
    if (local !== undefined) {
      retain(key, local);
      return key;
    }
    if (index.commits === null) return key;
    set(key, { patch: null, error: null, isLoading: true });
    const batchKey = JSON.stringify([
      input.environmentId,
      input.threadId,
      input.fromTurnCount,
      input.toTurnCount,
      input.ignoreWhitespace,
      index.commits.fromCommitOid,
      index.commits.toCommitOid,
    ]);
    let batch = pending.get(batchKey);
    if (!batch) {
      batch = { input, index, files: new Map() };
      pending.set(batchKey, batch);
    }
    batch.files.set(file, key);
    if (!flushScheduled) {
      flushScheduled = true;
      void Promise.resolve().then(flush);
    }
    return key;
  }

  return {
    filePatchAtom: (key: string) => patchAtom(key) as Atom.Atom<CheckpointDiffFilePatchState>,
    filePatchKey: keyOf,
    loadFilePatch,
    /** Drops every held patch (tests, sign-out). */
    clear: () => {
      for (const key of retained.keys()) set(key, IDLE);
      retained.clear();
      retainedChars = 0;
      pending.clear();
    },
  };
}
