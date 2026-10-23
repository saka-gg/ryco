import type { GitApplyIndexPatchInput, GitLocalChangesResult } from "@ryco/contracts";

export interface LocalChangesState {
  data: GitLocalChangesResult | null;
  isLoading: boolean;
  isApplying: boolean;
  isCommitting: boolean;
  error: string | null;
}

/** What a staged-only commit of the displayed review sends: the `stagedRevision` it was read at. */
export interface LocalChangesStagedCommit {
  readonly cwd: string;
  readonly expectedRevision: string;
}

/** In-memory review. Transport owns authorization/readiness; uncertain writes are never replayed. */
export function createLocalChangesController(input: {
  cwd: string;
  read: () => Promise<GitLocalChangesResult>;
  apply: (input: GitApplyIndexPatchInput) => Promise<void>;
}) {
  let state: LocalChangesState = {
    data: null,
    isLoading: false,
    isApplying: false,
    isCommitting: false,
    error: null,
  };
  let generation = 0;
  let pending: Promise<void> | null = null;
  let writing = false;
  const listeners = new Set<() => void>();
  const publish = (next: LocalChangesState) => {
    state = next;
    for (const listener of listeners) listener();
  };
  const invalidate = (clearData = true) => {
    generation++;
    pending = null;
    publish({ ...state, data: clearData ? null : state.data, isLoading: false });
  };
  const refresh = (): Promise<void> => {
    if (writing) return Promise.resolve();
    if (pending) return pending;
    const ticket = ++generation;
    publish({ ...state, isLoading: true, error: null });
    const request = Promise.resolve()
      .then(input.read)
      .then(
        (data) => {
          if (ticket === generation) publish({ ...state, data, isLoading: false });
        },
        (error: unknown) => {
          if (ticket === generation)
            publish({
              ...state,
              data: null,
              isLoading: false,
              error:
                error instanceof Error
                  ? error.message
                  : "Local changes unavailable. Refresh to retry.",
            });
        },
      )
      .finally(() => {
        if (pending === request) pending = null;
      });
    pending = request;
    return request;
  };
  /**
   * One write at a time, bound to the displayed snapshot. Resolves true once it
   * succeeded. Success refreshes; failures, including uncertain delivery, clear
   * the review until it is read again.
   */
  const write = async (
    flag: "isApplying" | "isCommitting",
    fallbackError: string,
    run: (data: GitLocalChangesResult) => Promise<void>,
  ): Promise<boolean> => {
    if (writing || state.isLoading || !state.data) return false;
    const data = state.data;
    const ticket = ++generation;
    pending = null;
    writing = true;
    publish({ ...state, [flag]: true, error: null });
    let failure: string | null = null;
    try {
      await run(data);
    } catch (error) {
      failure = error instanceof Error ? error.message : fallbackError;
    } finally {
      writing = false;
      if (ticket === generation) {
        publish({ ...state, data: null, [flag]: false, error: failure });
        if (!failure) await refresh();
      } else {
        publish({ ...state, [flag]: false });
      }
    }
    return failure === null;
  };
  return {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    invalidate,
    refresh,
    apply: async (selection: Pick<GitApplyIndexPatchInput, "scope" | "fileId" | "hunkIndex">) => {
      await write("isApplying", "Staging failed. Refresh before retrying.", (data) =>
        input.apply({ cwd: input.cwd, expectedRevision: data.revision, ...selection }),
      );
    },
    /**
     * Commits exactly the displayed staged changes through `commit`, bound to
     * their `stagedRevision`. Resolves true once committed; a no-op without staged
     * changes or a revision (older servers).
     */
    commitStaged: (commit: (input: LocalChangesStagedCommit) => Promise<void>) => {
      const expectedRevision = state.data?.stagedRevision;
      if (!expectedRevision || state.data?.staged.files.length === 0) return Promise.resolve(false);
      return write("isCommitting", "Commit failed. Refresh before retrying.", () =>
        commit({ cwd: input.cwd, expectedRevision }),
      );
    },
  };
}
