import type { EnvironmentId, NotesSnapshot, ProjectId } from "@ryco/contracts";
import { create } from "zustand";

import { scopedProjectKey, scopeProjectRef } from "../../scoped.ts";

export type ProjectNotesStatus = "idle" | "loading" | "ready" | "error";

export interface ProjectNotesState {
  /** The node's last answer; kept through a failed refresh. */
  readonly snapshot: NotesSnapshot | null;
  readonly status: ProjectNotesStatus;
  readonly error: string | null;
  /** Notes this client created or pinned, so its own changes never announce as "saved elsewhere". */
  readonly ownNoteIds: ReadonlySet<string>;
}

export const EMPTY_PROJECT_NOTES_STATE: ProjectNotesState = {
  snapshot: null,
  status: "idle",
  error: null,
  ownNoteIds: new Set(),
};

export interface NotesStoreState {
  readonly byKey: Readonly<Record<string, ProjectNotesState>>;
  readonly setLoading: (key: string) => void;
  readonly applySnapshot: (key: string, snapshot: NotesSnapshot) => void;
  readonly setError: (key: string, error: string) => void;
  readonly markOwn: (key: string, noteId: string) => void;
  readonly clear: (key: string) => void;
}

/** The store key of one project's notes on one environment. */
export function projectNotesKey(environmentId: EnvironmentId, projectId: ProjectId): string {
  return scopedProjectKey(scopeProjectRef(environmentId, projectId));
}

function patch(
  state: NotesStoreState,
  key: string,
  update: (current: ProjectNotesState) => ProjectNotesState,
): Partial<NotesStoreState> | NotesStoreState {
  const current = state.byKey[key] ?? EMPTY_PROJECT_NOTES_STATE;
  const next = update(current);
  return next === current ? state : { byKey: { ...state.byKey, [key]: next } };
}

/**
 * Worktree notes, keyed by environment + project. Memory only: note bodies
 * are node-owned content and never reach persistent client storage. The
 * writers are the project's retained sync (`retainProjectNotes`) and the
 * command replies it applies.
 */
export const useNotesStore = create<NotesStoreState>((set) => ({
  byKey: {},
  setLoading: (key) =>
    set((state) =>
      patch(state, key, (current) =>
        current.status === "loading" ? current : { ...current, status: "loading" },
      ),
    ),
  applySnapshot: (key, snapshot) =>
    set((state) =>
      patch(state, key, (current) => ({ ...current, snapshot, status: "ready", error: null })),
    ),
  setError: (key, error) =>
    set((state) => patch(state, key, (current) => ({ ...current, status: "error", error }))),
  markOwn: (key, noteId) =>
    set((state) =>
      patch(state, key, (current) =>
        current.ownNoteIds.has(noteId)
          ? current
          : { ...current, ownNoteIds: new Set([...current.ownNoteIds, noteId]) },
      ),
    ),
  clear: (key) =>
    set((state) => {
      const current = state.byKey[key];
      if (!current) return state;
      const byKey = { ...state.byKey };
      // Note ids are not content: remembering this client's own keeps a
      // save resent after a reconnect from announcing as saved elsewhere.
      if (current.ownNoteIds.size > 0)
        byKey[key] = { ...EMPTY_PROJECT_NOTES_STATE, ownNoteIds: current.ownNoteIds };
      else delete byKey[key];
      return { byKey };
    }),
}));

export function selectProjectNotesState(
  state: Pick<NotesStoreState, "byKey">,
  key: string,
): ProjectNotesState {
  return state.byKey[key] ?? EMPTY_PROJECT_NOTES_STATE;
}
