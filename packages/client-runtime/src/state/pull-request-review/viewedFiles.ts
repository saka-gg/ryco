import type {
  SourceControlChangeRequestFilesViewed,
  SourceControlSetChangeRequestFileViewedInput,
  SourceControlSetChangeRequestFileViewedResult,
} from "@ryco/contracts";

export type PullRequestReviewData = SourceControlChangeRequestFilesViewed;
export type ViewedFileState = PullRequestReviewData["files"][number]["state"];

export interface PullRequestReviewSnapshot {
  readonly data: PullRequestReviewData | null;
  readonly error: string | null;
  readonly pendingPaths: ReadonlySet<string>;
  readonly isLoading: boolean;
}

export interface PullRequestReviewCallbacks {
  readonly read: () => Promise<PullRequestReviewData>;
  readonly write: (
    input: Pick<
      SourceControlSetChangeRequestFileViewedInput,
      "path" | "viewed" | "expectedHeadSha"
    >,
  ) => Promise<SourceControlSetChangeRequestFileViewedResult>;
}

/** One controller belongs to one PR and authenticated environment. Dispose it on replacement. */
export function createPullRequestReviewController(callbacks: PullRequestReviewCallbacks) {
  let snapshot: PullRequestReviewSnapshot = {
    data: null,
    error: null,
    pendingPaths: new Set(),
    isLoading: false,
  };
  const listeners = new Set<() => void>();
  const revisions = new Map<string, number>();
  let readGeneration = 0;
  let disposed = false;

  const publish = (next: PullRequestReviewSnapshot) => {
    if (disposed) return;
    snapshot = next;
    for (const listener of listeners) listener();
  };
  const bump = (path: string) => revisions.set(path, (revisions.get(path) ?? 0) + 1);
  const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
  const updateFile = (path: string, state: ViewedFileState) =>
    snapshot.data && {
      ...snapshot.data,
      files: snapshot.data.files.map((file) => (file.path === path ? { ...file, state } : file)),
    };

  const refresh = async () => {
    if (disposed) return;
    const generation = ++readGeneration;
    const startedRevisions = new Map(revisions);
    const startedPending = snapshot.pendingPaths;
    publish({ ...snapshot, isLoading: true, error: null });
    try {
      const result = await callbacks.read();
      if (disposed || generation !== readGeneration) return;
      const current = snapshot.data;
      // A read overlapping a write can contain the old state, even if the write
      // finished before the response arrived. Preserve only affected file states.
      const currentFiles = new Map(current?.files.map((file) => [file.path, file]));
      const data = {
        ...result,
        files: result.files.map((file) => {
          const changed =
            startedPending.has(file.path) ||
            snapshot.pendingPaths.has(file.path) ||
            startedRevisions.get(file.path) !== revisions.get(file.path);
          return current?.headSha === result.headSha && changed
            ? (currentFiles.get(file.path) ?? file)
            : file;
        }),
      };
      publish({ ...snapshot, data, isLoading: false });
    } catch (error) {
      if (disposed || generation !== readGeneration) return;
      publish({ ...snapshot, error: message(error), isLoading: false });
    }
  };

  const setViewed = async (path: string, viewed: boolean) => {
    const data = snapshot.data;
    const previous = data?.files.find((file) => file.path === path);
    if (
      disposed ||
      !data?.headSha ||
      data.capability.storage === "unsupported" ||
      !previous ||
      snapshot.pendingPaths.has(path)
    )
      return;
    const headSha = data.headSha;
    bump(path);
    publish({
      ...snapshot,
      data: updateFile(path, viewed ? "viewed" : "unviewed"),
      pendingPaths: new Set([...snapshot.pendingPaths, path]),
      error: null,
    });
    try {
      const result = await callbacks.write({ path, viewed, expectedHeadSha: headSha });
      if (disposed) return;
      if (result.path !== path) throw new Error("Viewed-state response did not match the file.");
      if (result.headSha !== headSha) {
        throw new Error(
          "The pull request changed while saving viewed state. Refresh and try again.",
        );
      }
      bump(path);
      publish({
        ...snapshot,
        data:
          snapshot.data?.headSha === result.headSha
            ? updateFile(path, result.state)
            : snapshot.data,
        pendingPaths: new Set([...snapshot.pendingPaths].filter((pending) => pending !== path)),
      });
    } catch (error) {
      if (disposed) return;
      bump(path);
      publish({
        ...snapshot,
        data: snapshot.data?.headSha === headSha ? updateFile(path, previous.state) : snapshot.data,
        pendingPaths: new Set([...snapshot.pendingPaths].filter((pending) => pending !== path)),
        error: message(error),
      });
    }
  };

  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      if (!disposed) listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    refresh,
    setViewed,
    dispose: () => {
      disposed = true;
      listeners.clear();
    },
  };
}
