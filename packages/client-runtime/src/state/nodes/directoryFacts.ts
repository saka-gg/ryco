// FILE: directoryFacts.ts
// Purpose: What a client publishes of each node beyond the catalog, read from
//          the shared threads store: the node's repository projects once its
//          shell snapshot arrived, and a subscription that fires only when the
//          store's projects change. The web and the phone publishers share it.
// Layer: Client runtime, no platform code.

import type { EnvironmentId } from "@ryco/contracts";
import { isChatProject } from "@ryco/shared/projectKind";

import {
  selectEnvironmentState,
  selectProjectsAcrossEnvironments,
  selectProjectsForEnvironment,
  type AppState,
} from "../threads/store.ts";
import type { NodeDirectoryNodeFacts } from "./directoryPublisher.ts";

/**
 * The node's code directory (read by the caller from its path hints) and its
 * repository projects, as far as this client knows them: projects are known
 * once the node's shell snapshot arrived (live or cached). Chats and projects
 * without a repository identity are never published.
 */
export function readNodeDirectoryFacts(
  state: AppState,
  environmentId: EnvironmentId,
  defaultProjectDirectory: string | null,
): NodeDirectoryNodeFacts {
  const projects = selectEnvironmentState(state, environmentId).bootstrapComplete
    ? selectProjectsForEnvironment(state, environmentId).flatMap((project) => {
        const key = project.repositoryIdentity?.canonicalKey;
        return isChatProject(project) || !key
          ? []
          : [{ repositoryCanonicalKey: key, path: project.cwd }];
      })
    : null;
  return { defaultProjectDirectory, projects };
}

/** The threads store as the publisher follows it. */
export interface NodeDirectoryProjectStore {
  readonly getState: () => AppState;
  readonly subscribe: (listener: (state: AppState) => void) => () => void;
}

/** Calls `listener` only when the store's projects change, not on every store update. */
export function subscribeNodeDirectoryProjects(
  store: NodeDirectoryProjectStore,
  listener: () => void,
): () => void {
  let projects = selectProjectsAcrossEnvironments(store.getState());
  return store.subscribe((state) => {
    const next = selectProjectsAcrossEnvironments(state);
    if (next === projects) return;
    projects = next;
    listener();
  });
}
