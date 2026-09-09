/** Project IDs can collide across nodes; both halves of the reference must match. */
export function selectArchivedSettingsGroups<
  P extends { readonly id: string; readonly environmentId: string },
  T extends {
    readonly id: string;
    readonly projectId: string;
    readonly environmentId: string;
    readonly archivedAt: string | null;
    readonly createdAt: string;
  },
>(projects: readonly P[], threads: readonly T[], environmentId?: string) {
  return projects
    .filter((project) => environmentId === undefined || project.environmentId === environmentId)
    .map((project) => ({
      project,
      threads: threads
        .filter(
          (thread) =>
            thread.environmentId === project.environmentId &&
            thread.projectId === project.id &&
            thread.archivedAt !== null,
        )
        .toSorted(
          (left, right) =>
            (right.archivedAt ?? right.createdAt).localeCompare(
              left.archivedAt ?? left.createdAt,
            ) || right.id.localeCompare(left.id),
        ),
    }))
    .filter((group) => group.threads.length > 0);
}
