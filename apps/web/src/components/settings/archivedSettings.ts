import { projectPlaceLabel } from "@ryco/client-runtime/state/composer";
import type { TrashedThreadSummary } from "@ryco/contracts";
import { isChatProject, projectKindOf, type ProjectKindCarrier } from "@ryco/shared/projectKind";

interface ArchivedSettingsProject extends ProjectKindCarrier {
  readonly id: string;
  readonly environmentId: string;
}

interface ArchivedSettingsThread {
  readonly id: string;
  readonly projectId: string;
  readonly environmentId: string;
  readonly archivedAt: string | null;
  readonly createdAt: string;
}

/**
 * One section of the archive: a project's archived threads, or a node's
 * archived "No project" chats. A chat's project is its folder, not something
 * to name, so every chat of a node shares one "No project" section instead of
 * one section per chat titled like the chat.
 */
export type ArchivedSettingsGroup<
  P extends ArchivedSettingsProject,
  T extends ArchivedSettingsThread,
> =
  | {
      readonly kind: "project";
      readonly key: string;
      readonly project: P;
      readonly threads: ReadonlyArray<T>;
    }
  | {
      readonly kind: "no-project";
      readonly key: string;
      readonly environmentId: P["environmentId"];
      readonly threads: ReadonlyArray<T>;
    };

/** Project IDs can collide across nodes; both halves of the reference must match. */
const projectKey = (environmentId: string, projectId: string) => `${environmentId}:${projectId}`;

const newestArchivedFirst = (left: ArchivedSettingsThread, right: ArchivedSettingsThread) =>
  (right.archivedAt ?? right.createdAt).localeCompare(left.archivedAt ?? left.createdAt) ||
  right.id.localeCompare(left.id);

/**
 * The archive's sections, newest archived first within each: projects in
 * their usual order, then each node's "No project" chats (where the sidebar
 * lists chats too). `environmentId` limits the archive to one node.
 */
export function selectArchivedSettingsGroups<
  P extends ArchivedSettingsProject,
  T extends ArchivedSettingsThread,
>(
  projects: readonly P[],
  threads: readonly T[],
  environmentId?: string,
): Array<ArchivedSettingsGroup<P, T>> {
  const archivedByProject = new Map<string, T[]>();
  for (const thread of threads) {
    if (thread.archivedAt === null) continue;
    if (environmentId !== undefined && thread.environmentId !== environmentId) continue;
    const key = projectKey(thread.environmentId, thread.projectId);
    const bucket = archivedByProject.get(key);
    if (bucket) bucket.push(thread);
    else archivedByProject.set(key, [thread]);
  }

  const projectGroups: Array<ArchivedSettingsGroup<P, T>> = [];
  const chatThreadsByEnvironment = new Map<P["environmentId"], T[]>();
  for (const project of projects) {
    if (environmentId !== undefined && project.environmentId !== environmentId) continue;
    const archived = archivedByProject.get(projectKey(project.environmentId, project.id));
    if (!archived) continue;
    if (isChatProject(project)) {
      const chats = chatThreadsByEnvironment.get(project.environmentId);
      if (chats) chats.push(...archived);
      else chatThreadsByEnvironment.set(project.environmentId, [...archived]);
      continue;
    }
    projectGroups.push({
      kind: "project",
      key: `project:${projectKey(project.environmentId, project.id)}`,
      project,
      threads: archived.toSorted(newestArchivedFirst),
    });
  }

  const chatGroups = Array.from(
    chatThreadsByEnvironment,
    ([chatEnvironmentId, chatThreads]): ArchivedSettingsGroup<P, T> => ({
      kind: "no-project",
      key: `no-project:${chatEnvironmentId}`,
      environmentId: chatEnvironmentId,
      threads: chatThreads.toSorted(newestArchivedFirst),
    }),
  );
  return [...projectGroups, ...chatGroups];
}

/** Where a trashed conversation lives, as Settings → Archive → Trash lists it. */
export interface TrashedThreadPlace {
  /** "No project" for a chat, else its project's title ("Removed project" once that is gone). */
  readonly label: string;
  /**
   * A chat's folder, offered for deletion alongside the conversation. Null for a regular project,
   * and for a chat whose folder this client does not know (its project is no longer listed).
   */
  readonly chatFolder: string | null;
}

/**
 * The node's own `projectKind` says whether a trashed conversation is a chat, even once its
 * project has left the client's store. Nodes that predate it send none; the store answers then.
 */
export function describeTrashedThreadPlace(
  thread: Pick<TrashedThreadSummary, "projectKind" | "projectTitle">,
  storeProject: (ProjectKindCarrier & { readonly cwd: string }) | null | undefined,
): TrashedThreadPlace {
  const kind = { kind: thread.projectKind ?? projectKindOf(storeProject) };
  return {
    label: projectPlaceLabel(kind, thread.projectTitle ?? "Removed project"),
    chatFolder: isChatProject(kind) ? (storeProject?.cwd ?? null) : null,
  };
}
