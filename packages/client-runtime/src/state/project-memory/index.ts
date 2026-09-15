import type {
  EnvironmentId,
  ProjectId,
  ProjectMemoryApi,
  ProjectMemoryEntry,
  ProjectMemoryMutateInput,
  ProjectMemoryPage,
  ProjectMemoryRecallPreview,
  ProjectMemoryReference,
} from "@ryco/contracts";
import { PROJECT_MEMORY_RECALL_CAP } from "@ryco/contracts";
import { projectMemoryNeedsReview } from "@ryco/shared/projectMemory";

export interface ProjectMemoryConnection {
  readonly api: ProjectMemoryApi;
  /** Supplied by the existing connection owner; changes on reconnect or authorization changes. */
  readonly generation: number;
  readonly ready: boolean;
  /** Content-free identities supplied by the existing lifecycle owners. */
  readonly lifetime?: readonly unknown[];
}
export interface ProjectMemoryState {
  readonly page: ProjectMemoryPage | null;
  readonly busy: boolean;
  readonly error: string | null;
  readonly references: ReadonlyArray<ProjectMemoryReference>;
  readonly preview: ProjectMemoryRecallPreview | null;
  readonly query: string;
  readonly offset: number;
}
const sameLifetime = (a: ProjectMemoryConnection, b: ProjectMemoryConnection) =>
  a.generation === b.generation &&
  a.api === b.api &&
  (a.lifetime?.length ?? 0) === (b.lifetime?.length ?? 0) &&
  (a.lifetime ?? []).every((part, index) => Object.is(part, b.lifetime?.[index]));
/** Capture an existing owner's lifetime without creating a lifecycle or authority. */
export function captureProjectMemoryConnection(read: () => ProjectMemoryConnection | null) {
  const initial = read();
  return () => {
    const current = read();
    return current
      ? { ...current, ready: current.ready && initial !== null && sameLifetime(initial, current) }
      : null;
  };
}
const initialState = (): ProjectMemoryState => ({
  page: null,
  busy: false,
  error: null,
  references: [],
  preview: null,
  query: "",
  offset: 0,
});

/** Transient, explicitly scoped state. No storage, timers, connection ownership or platform imports. */
export function createProjectMemoryController(options: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly readConnection: () => ProjectMemoryConnection | null;
}) {
  let state = initialState();
  let epoch = 0;
  let previewConnection: ProjectMemoryConnection | null = null;
  let disposed = false;
  const listeners = new Set<() => void>();
  const publish = (patch: Partial<ProjectMemoryState>) => {
    if (disposed) return;
    state = { ...state, ...patch };
    listeners.forEach((listener) => listener());
  };
  const invalidate = () => {
    previewConnection = null;
    epoch++;
    publish(initialState());
  };
  const run = async <T>(
    use: (api: ProjectMemoryApi) => Promise<T>,
    commit: (result: T) => void,
  ): Promise<T | null> => {
    if (disposed || state.busy) return null;
    const connection = options.readConnection();
    if (!connection?.ready) {
      invalidate();
      publish({ error: "Reconnect to this node before using project memory." });
      return null;
    }
    const operationEpoch = ++epoch;
    const isCurrent = () => {
      const latest = options.readConnection();
      return (
        !disposed && operationEpoch === epoch && latest?.ready && sameLifetime(latest, connection)
      );
    };
    publish({ busy: true, error: null });
    try {
      const result = await use(connection.api);
      if (!isCurrent()) {
        if (operationEpoch === epoch) invalidate();
        return null;
      }
      commit(result);
      return result;
    } catch {
      if (isCurrent())
        publish({
          error: "Project memory request failed. Refresh and review before retrying.",
          preview: null,
          references: [],
        });
      else if (operationEpoch === epoch) invalidate();
      return null;
    } finally {
      if (operationEpoch === epoch) publish({ busy: false });
    }
  };
  const refresh = async (query = state.query, offset = state.offset) => {
    publish({ preview: null, references: [] });
    return run(
      (api) => api.list({ projectId: options.projectId, query, offset }),
      (page) => publish({ page, query, offset }),
    );
  };
  const mutate = async (mutation: ProjectMemoryMutateInput["mutation"]) => {
    if (!state.page) return false;
    const expectedRevision = state.page.revision;
    publish({ preview: null, references: [] });
    const result = await run(
      (api) => api.mutate({ projectId: options.projectId, expectedRevision, mutation }),
      () => publish({ page: null }),
    );
    if (!result) return false;
    await refresh(state.query, 0);
    return true;
  };
  return {
    environmentId: options.environmentId,
    projectId: options.projectId,
    getSnapshot: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    invalidate,
    dispose: () => {
      invalidate();
      disposed = true;
      listeners.clear();
    },
    refresh,
    mutate,
    toggleRecall: (entry: ProjectMemoryEntry) => {
      if (
        state.busy ||
        !state.page?.enabled ||
        entry.projectId !== options.projectId ||
        projectMemoryNeedsReview(entry, Date.parse(state.page.asOf))
      )
        return;
      const included = state.references.some((ref) => ref.id === entry.id);
      if (!included && state.references.length >= PROJECT_MEMORY_RECALL_CAP) {
        publish({ error: "Select at most eight memories." });
        return;
      }
      publish({
        references: included
          ? state.references.filter((ref) => ref.id !== entry.id)
          : [...state.references, { id: entry.id, revision: entry.revision }],
        preview: null,
        error: null,
      });
    },
    previewRecall: () =>
      run(
        (api) => api.preview({ projectId: options.projectId, references: state.references }),
        (preview) => {
          previewConnection = options.readConnection();
          publish({ preview });
        },
      ),
    /** Queue content-free refs only. Server MUST validate again at actual provider dispatch. */
    reviewedRecall: (): {
      projectId: ProjectId;
      references: ReadonlyArray<ProjectMemoryReference>;
    } | null => {
      const connection = options.readConnection();
      if (
        !connection?.ready ||
        !previewConnection ||
        !sameLifetime(connection, previewConnection) ||
        state.busy ||
        !state.preview ||
        !state.references.length
      )
        return null;
      return {
        projectId: options.projectId,
        references: state.references.map((ref) => ({ id: ref.id, revision: ref.revision })),
      };
    },
    export: () =>
      run(
        (api) => api.export({ projectId: options.projectId }),
        () => {},
      ),
  };
}
export type ProjectMemoryController = ReturnType<typeof createProjectMemoryController>;
