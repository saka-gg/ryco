import type { GitApplyIndexPatchInput, GitLocalChangesResult } from "@ryco/contracts";

import { hasErrorTag } from "../../rpc/protocol.ts";

export interface LocalChangesState {
  data: GitLocalChangesResult | null;
  isLoading: boolean;
  isApplying: boolean;
  isCommitting: boolean;
  error: string | null;
  /** Why the last staged commit changed nothing; the review stays so it can be retried. */
  commitError: string | null;
}

/** What a staged-only commit of the displayed review sends: the `stagedRevision` it was read at. */
export interface LocalChangesStagedCommit {
  readonly cwd: string;
  readonly expectedRevision: string;
  /** Typed by the user; without it the node generates one. */
  readonly commitMessage?: string;
}

/**
 * A commit whose message could not be generated: it failed before anything was
 * written. The detail is already free of the prompt and patch (server side).
 */
function commitMessageFailure(error: unknown): string | null {
  if (!hasErrorTag(error, "TextGenerationError")) return null;
  const raw = (error as { readonly detail?: unknown }).detail;
  const detail = typeof raw === "string" ? raw.trim().replace(/\.+$/, "") : "";
  return `No commit: the commit message could not be generated${
    detail.length > 0 ? ` (${detail})` : ""
  }. Type a message and commit again.`;
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
    commitError: null,
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
    publish({ ...state, isLoading: true, error: null, commitError: null });
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
   * the review until it is read again, except one `unwritten` recognises as
   * having changed nothing: that keeps the review and reports `commitError`.
   */
  const write = async (
    flag: "isApplying" | "isCommitting",
    fallbackError: string,
    run: (data: GitLocalChangesResult) => Promise<void>,
    unwritten: (error: unknown) => string | null = () => null,
  ): Promise<boolean> => {
    if (writing || state.isLoading || !state.data) return false;
    const data = state.data;
    const ticket = ++generation;
    pending = null;
    writing = true;
    publish({ ...state, [flag]: true, error: null, commitError: null });
    let failure: string | null = null;
    let unchanged: string | null = null;
    try {
      await run(data);
    } catch (error) {
      failure = error instanceof Error ? error.message : fallbackError;
      unchanged = unwritten(error);
    } finally {
      writing = false;
      if (ticket === generation && unchanged !== null) {
        publish({ ...state, [flag]: false, commitError: unchanged });
      } else if (ticket === generation) {
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
     * changes or a revision (older servers). A blank `commitMessage` lets the node
     * generate one; if that fails, the review stays for a typed message.
     */
    commitStaged: (
      commit: (input: LocalChangesStagedCommit) => Promise<void>,
      commitMessage?: string,
    ) => {
      const expectedRevision = state.data?.stagedRevision;
      if (!expectedRevision || state.data?.staged.files.length === 0) return Promise.resolve(false);
      const message = commitMessage?.trim();
      return write(
        "isCommitting",
        "Commit failed. Refresh before retrying.",
        () =>
          commit({
            cwd: input.cwd,
            expectedRevision,
            ...(message ? { commitMessage: message } : {}),
          }),
        commitMessageFailure,
      );
    },
  };
}
