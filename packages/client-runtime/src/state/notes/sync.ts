import type { EnvironmentId, NotesApi, NotesSnapshot, ProjectId } from "@ryco/contracts";

import { createSingleFlightReader, type SingleFlightReader } from "../singleFlightReader.ts";
import { projectNotesKey, selectProjectNotesState, useNotesStore } from "./store.ts";

export const NOTES_READ_ERROR = "Notes are unavailable. Check your connection, then refresh.";

export interface ProjectNotesSync {
  /** The project's key in `useNotesStore`. */
  readonly key: string;
  /** Re-reads the project's notes; concurrent calls share one read. */
  readonly refresh: () => Promise<void>;
  /**
   * Publishes a command's reply. It is newer than any read still in flight,
   * so that read is discarded.
   */
  readonly applySnapshot: (snapshot: NotesSnapshot) => void;
  /** Idempotent. The last release stops the sync and drops the project's notes (not their own ids). */
  readonly release: () => void;
}

/**
 * Platform signals that should re-read a project's notes (e.g. the window
 * regaining focus); returns its unsubscribe.
 */
export type NotesRefreshTriggers = (refresh: () => void) => () => void;

interface RetainedNotes {
  count: number;
  api: NotesApi;
  reader: SingleFlightReader;
  teardownScheduled: boolean;
  /** Installed once per retained project, however many surfaces share it. */
  stopTriggers: (() => void) | null;
}

const retained = new Map<string, RetainedNotes>();

function startReader(key: string, api: NotesApi, projectId: ProjectId): SingleFlightReader {
  return createSingleFlightReader({
    read: () => api.list({ projectId }),
    onValue: (snapshot) => useNotesStore.getState().applySnapshot(key, snapshot),
    onError: () => useNotesStore.getState().setError(key, NOTES_READ_ERROR),
  });
}

/**
 * Keeps one project's notes in `useNotesStore` while retained. Every surface
 * showing the project (split panes, the card and its flyout) shares one
 * reader, which reads when it starts; retaining with a new `api` (a
 * reconnect) swaps the reader for all of them and reads again. The last
 * release stops at the end of the task, so an effect re-running hands the
 * sync over instead of dropping the notes. `triggers` (the first retainer's)
 * re-read the project once per signal, not once per surface.
 */
export function retainProjectNotes(
  api: NotesApi,
  environmentId: EnvironmentId,
  projectId: ProjectId,
  triggers?: NotesRefreshTriggers,
): ProjectNotesSync {
  const key = projectNotesKey(environmentId, projectId);
  let entry = retained.get(key);
  // A new reader reads at once; joining a running one shares its notes.
  const fresh = !entry || entry.api !== api;
  if (!entry) {
    entry = {
      count: 0,
      api,
      reader: startReader(key, api, projectId),
      teardownScheduled: false,
      stopTriggers: null,
    };
    retained.set(key, entry);
  } else if (entry.api !== api) {
    entry.reader.stop();
    entry.api = api;
    entry.reader = startReader(key, api, projectId);
  }
  entry.count += 1;
  const held = entry;

  const refresh = () => {
    const store = useNotesStore.getState();
    if (selectProjectNotesState(store, key).status !== "ready") store.setLoading(key);
    return held.reader.refresh();
  };
  if (triggers && held.stopTriggers === null) held.stopTriggers = triggers(() => void refresh());
  let released = false;
  if (fresh) void refresh();
  return {
    key,
    refresh: () => (released ? Promise.resolve() : refresh()),
    applySnapshot: (snapshot) => {
      if (released) return;
      held.reader.invalidate();
      useNotesStore.getState().applySnapshot(key, snapshot);
    },
    release: () => {
      if (released) return;
      released = true;
      held.count -= 1;
      if (held.count > 0 || held.teardownScheduled) return;
      held.teardownScheduled = true;
      void Promise.resolve().then(() => {
        held.teardownScheduled = false;
        if (held.count > 0 || retained.get(key) !== held) return;
        retained.delete(key);
        held.reader.stop();
        held.stopTriggers?.();
        useNotesStore.getState().clear(key);
      });
    },
  };
}

/** Test-only: whether a project's notes sync is currently held. */
export function isProjectNotesRetained(
  environmentId: EnvironmentId,
  projectId: ProjectId,
): boolean {
  return retained.has(projectNotesKey(environmentId, projectId));
}
