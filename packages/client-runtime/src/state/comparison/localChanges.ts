import type { GitApplyIndexPatchInput, GitLocalChangesResult } from "@ryco/contracts";

export interface LocalChangesState {
  data: GitLocalChangesResult | null;
  isLoading: boolean;
  isApplying: boolean;
  error: string | null;
}

/** In-memory review. Transport owns authorization/readiness; uncertain writes are never replayed. */
export function createLocalChangesController(input: {
  cwd: string;
  read: () => Promise<GitLocalChangesResult>;
  apply: (input: GitApplyIndexPatchInput) => Promise<void>;
}) {
  let state: LocalChangesState = { data: null, isLoading: false, isApplying: false, error: null };
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
      if (writing || state.isLoading || !state.data) return;
      const data = state.data;
      const ticket = ++generation;
      pending = null;
      writing = true;
      publish({ ...state, isApplying: true, error: null });
      let failure: string | null = null;
      try {
        await input.apply({ cwd: input.cwd, expectedRevision: data.revision, ...selection });
      } catch (error) {
        failure =
          error instanceof Error ? error.message : "Staging failed. Refresh before retrying.";
      } finally {
        writing = false;
        if (ticket === generation) {
          publish({ ...state, data: null, isApplying: false, error: failure });
          // Success refreshes; failures require explicit review, including uncertain delivery.
          if (!failure) await refresh();
        } else {
          publish({ ...state, isApplying: false });
        }
      }
    },
  };
}
