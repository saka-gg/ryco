export { createLocalChangesController, type LocalChangesState } from "./localChanges.ts";
import {
  GitComparisonSelection,
  type GitComparisonSource,
  type GitReadComparisonResult,
} from "@ryco/contracts";
import { Option, Schema } from "effect";
import type { KVService } from "../../platform/index.ts";

export function comparisonStorageKey(environmentId: string, repositoryPath: string): string {
  return `ryco:comparison:v1:${JSON.stringify([environmentId, repositoryPath])}`;
}
/** Task06 readers must use the returned OID for the requested side, never a symbolic ref. */
export function comparisonFileKey(
  environmentId: string,
  source: GitComparisonSource,
  side: "base" | "head",
  filePath: string,
): string {
  return JSON.stringify([
    environmentId,
    source.repositoryPath,
    source.worktreePath,
    source.revision,
    side,
    side === "base" ? source.baseOid : source.headOid,
    filePath,
  ]);
}
export interface ComparisonState {
  readonly selection: GitComparisonSelection | null;
  readonly data: GitReadComparisonResult | null;
  readonly isLoading: boolean;
  readonly error: string | null;
  readonly refMoved: boolean;
}
const initial: ComparisonState = {
  selection: null,
  data: null,
  isLoading: false,
  error: null,
  refMoved: false,
};

/** One observed comparison. No persistent patches, timers, or platform-specific lifecycle decisions. */
export function createComparisonController(input: {
  storage: KVService;
  storageKey: string;
  read: (selection: GitComparisonSelection) => Promise<GitReadComparisonResult>;
}) {
  let state = initial;
  let generation = 0;
  let disposed = false;
  let inFlight: Promise<void> | null = null;
  let writes = Promise.resolve();
  const listeners = new Set<() => void>();
  const publish = (next: ComparisonState) => {
    state = next;
    for (const listener of listeners) listener();
  };
  const refresh = (): Promise<void> => {
    if (disposed || !state.selection) return Promise.resolve();
    if (inFlight) return inFlight;
    const ticket = ++generation;
    const selection = state.selection;
    const previousOid = state.data?.source.refOid;
    // Retain the labeled immutable snapshot while refreshing so unchanged file renderers survive.
    publish({ ...state, error: null, isLoading: true, refMoved: false });
    const request = Promise.resolve()
      .then(() => input.read(selection))
      .then(
        (data) => {
          if (!disposed && ticket === generation)
            publish({
              selection,
              data,
              error: null,
              isLoading: false,
              refMoved: previousOid !== undefined && previousOid !== data.source.refOid,
            });
        },
        (error: unknown) => {
          if (!disposed && ticket === generation)
            publish({
              selection,
              data: null,
              isLoading: false,
              refMoved: false,
              error:
                error instanceof Error
                  ? error.message
                  : "Comparison unavailable. Refresh or choose another reference.",
            });
        },
      )
      .finally(() => {
        if (inFlight === request) inFlight = null;
      });
    inFlight = request;
    return request;
  };
  const setSelection = (selection: GitComparisonSelection | null, persist = true) => {
    if (disposed) return;
    if (selection && Option.isNone(Schema.decodeUnknownOption(GitComparisonSelection)(selection))) {
      publish({
        ...state,
        error: "Enter a branch, tag, or commit ID (no revision expressions or options).",
      });
      return;
    }
    generation++;
    inFlight = null;
    publish({ ...initial, selection });
    if (persist) {
      writes = writes
        .then(() => input.storage.setItem(input.storageKey, JSON.stringify(selection)))
        .catch(() => {
          if (!disposed) publish({ ...state, error: "Could not save comparison preference." });
        });
    }
    void refresh();
  };
  return {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    setSelection,
    refresh,
    /** Invalidates transport-generation results without creating/recovering a connection. */
    invalidate: (clearData = true) => {
      generation++;
      inFlight = null;
      publish({ ...state, data: clearData ? null : state.data, isLoading: false });
    },
    hydrate: async () => {
      const ticket = generation;
      try {
        const value = await input.storage.getItem(input.storageKey);
        if (disposed || ticket !== generation || value === null) return;
        const selection = Schema.decodeUnknownOption(GitComparisonSelection)(JSON.parse(value));
        if (Option.isSome(selection)) setSelection(selection.value, false);
      } catch {
        /* Invalid/unavailable local preferences do not prevent checkpoint review. */
      }
    },
    dispose: () => {
      disposed = true;
      generation++;
      listeners.clear();
    },
  };
}
