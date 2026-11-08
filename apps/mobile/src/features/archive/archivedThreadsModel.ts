import { selectArchivedThreadGroups } from "@ryco/client-runtime/state/threads/archivedThreadGroups";
import type { Project, SidebarThreadOrStub } from "@ryco/client-runtime/state/threads";
import { CHAT_PROJECT_LABEL } from "@ryco/client-runtime/state/composer";
import type { EnvironmentId, ThreadId } from "@ryco/contracts";

export interface ArchivedEnvironment {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  /** Restore needs the node connected, its shell current and mutations allowed. */
  readonly canMutate: boolean;
}

export interface ArchivedThreadRow {
  readonly key: string;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly title: string;
  readonly archivedAt: string;
  readonly nodeLabel: string;
  readonly canRestore: boolean;
}

export interface ArchivedThreadSection {
  readonly key: string;
  /** The project's name, or "No project" for a node's archived chats. */
  readonly title: string;
  readonly nodeLabel: string;
  readonly rows: ReadonlyArray<ArchivedThreadRow>;
}

/**
 * The phone's archive: each project's archived threads (and each node's
 * archived chats), newest archived first, as web's Settings lists them
 * (`selectArchivedThreadGroups`). The search matches a thread's title, its
 * project or its machine; `environmentId` limits it to one machine.
 */
export function buildArchivedThreadSections(input: {
  readonly projects: ReadonlyArray<Project>;
  readonly threads: ReadonlyArray<SidebarThreadOrStub>;
  readonly environments: ReadonlyArray<ArchivedEnvironment>;
  readonly environmentId: EnvironmentId | null;
  readonly query: string;
}): ReadonlyArray<ArchivedThreadSection> {
  const environmentById = new Map(
    input.environments.map((environment) => [environment.environmentId, environment] as const),
  );
  const query = input.query.trim().toLocaleLowerCase();
  const matches = (value: string | null | undefined) =>
    value?.toLocaleLowerCase().includes(query) ?? false;
  const groups = selectArchivedThreadGroups(
    input.projects,
    input.threads,
    input.environmentId ?? undefined,
  );
  const sections: ArchivedThreadSection[] = [];
  for (const group of groups) {
    const environmentId =
      group.kind === "project" ? group.project.environmentId : group.environmentId;
    const environment = environmentById.get(environmentId);
    // A machine this phone no longer lists keeps its archive out of view.
    if (!environment) continue;
    const title = group.kind === "project" ? group.project.name : CHAT_PROJECT_LABEL;
    const groupMatches =
      query.length === 0 ||
      matches(title) ||
      matches(environment.label) ||
      (group.kind === "project" && matches(group.project.cwd));
    const rows = group.threads
      .filter((thread) => groupMatches || matches(thread.title))
      .map((thread): ArchivedThreadRow => ({
        key: `${environmentId}:${thread.id}`,
        environmentId,
        threadId: thread.id,
        title: thread.title || "Untitled task",
        archivedAt: thread.archivedAt ?? thread.createdAt,
        nodeLabel: environment.label,
        canRestore: environment.canMutate,
      }));
    if (rows.length === 0) continue;
    sections.push({ key: group.key, title, nodeLabel: environment.label, rows });
  }
  return sections;
}

/** How many archived threads the listed machines hold. */
export function countArchivedThreads(
  threads: ReadonlyArray<SidebarThreadOrStub>,
  environmentId: EnvironmentId | null,
): number {
  let count = 0;
  for (const thread of threads) {
    if (thread.archivedAt === null) continue;
    if (environmentId !== null && thread.environmentId !== environmentId) continue;
    count += 1;
  }
  return count;
}
