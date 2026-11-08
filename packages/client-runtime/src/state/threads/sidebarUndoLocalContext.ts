import type { ProjectId, ScopedThreadRef } from "@ryco/contracts";

import { sidebarUndoThreadRevision, type SidebarUndoLocalContext } from "./sidebarUndo.ts";
import type { Project, SidebarThreadOrStub } from "./types.ts";

/** The thread store as a client binds it (its own store module, which tests replace). */
export interface SidebarUndoStoreBinding<State> {
  readonly getState: () => State;
  readonly subscribe: (listener: () => void) => () => void;
  readonly selectThread: (
    state: State,
    target: ScopedThreadRef,
  ) => SidebarThreadOrStub | null | undefined;
  readonly selectProject: (
    state: State,
    ref: {
      readonly environmentId: ScopedThreadRef["environmentId"];
      readonly projectId: ProjectId;
    },
  ) => Project | null | undefined;
}

/**
 * Reads the local ordering state an unpin's Undo guards, for every client: the
 * thread's cached ordering fields and its project. No connection is needed; an
 * archived stub has a revision of its own (`sidebarUndoThreadRevision`).
 */
export function createSidebarUndoLocalContextReader<State>(
  store: SidebarUndoStoreBinding<State>,
): (target: ScopedThreadRef) => SidebarUndoLocalContext | null {
  return (target) => {
    const state = store.getState();
    const thread = store.selectThread(state, target);
    const project = thread
      ? store.selectProject(state, {
          environmentId: target.environmentId,
          projectId: thread.projectId,
        })
      : null;
    if (!thread || !project) return null;
    return {
      threadRevision: sidebarUndoThreadRevision(thread),
      parentRevision: project,
      threadTitle: thread.title,
      subscribe: store.subscribe,
    };
  };
}
