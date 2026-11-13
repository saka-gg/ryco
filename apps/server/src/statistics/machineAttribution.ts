/**
 * What whole-machine statistics need from Ryco's database to place session files beside its
 * threads: the provider session ids Ryco stored for its threads (resume cursors) and every
 * project's workspace and worktree directories. Loaded on first use by `StatisticsQuery`.
 *
 * @module machineAttribution
 */
import { Effect } from "effect";
import type * as SqlClient from "effect/sql/SqlClient";

export interface StatisticsMachineAttribution {
  readonly rycoSessionIds: {
    readonly claude: readonly string[];
    readonly codex: readonly string[];
  };
  readonly projectRoots: ReadonlyArray<{
    readonly path: string;
    readonly projectId: string;
    readonly deleted?: boolean;
  }>;
}

/**
 * The provider session ids a resume cursor names: a Claude thread's session (`resume`, and the
 * session its plan tasks were read from), a Codex thread's id (`threadId`).
 */
export function providerSessionIdsOfResumeCursor(
  providerName: string,
  resumeCursorJson: string,
): readonly string[] {
  let cursor: unknown;
  try {
    cursor = JSON.parse(resumeCursorJson);
  } catch {
    return [];
  }
  if (typeof cursor !== "object" || cursor === null) return [];
  const record = cursor as Record<string, unknown>;
  const text = (value: unknown) => (typeof value === "string" && value.length > 0 ? [value] : []);
  if (providerName === "codex") return text(record["threadId"]);
  if (providerName !== "claudeAgent") return [];
  const planTasks = record["planTasks"];
  return [
    ...text(record["resume"]),
    ...(typeof planTasks === "object" && planTasks !== null
      ? text((planTasks as Record<string, unknown>)["nativeSessionId"])
      : []),
  ];
}

/** Reads them under one transaction of `reader`. */
export const readMachineAttribution = (reader: SqlClient.SqlClient) =>
  reader.withTransaction(
    Effect.gen(function* () {
      const sessions = yield* reader<{
        readonly providerName: string;
        readonly resumeCursorJson: string;
      }>`
          SELECT provider_name AS "providerName", resume_cursor_json AS "resumeCursorJson"
          FROM provider_session_runtime
          WHERE provider_name IN ('claudeAgent', 'codex') AND resume_cursor_json IS NOT NULL
        `;
      const projects = yield* reader<{
        readonly projectId: string;
        readonly path: string;
        readonly deletedAt: string | null;
      }>`
          SELECT project_id AS "projectId", workspace_root AS "path", deleted_at AS "deletedAt"
          FROM projection_projects
        `;
      const worktrees = yield* reader<{
        readonly projectId: string;
        readonly path: string;
      }>`
          SELECT project_id AS "projectId", worktree_path AS "path"
          FROM projection_worktrees
          WHERE worktree_path IS NOT NULL AND worktree_path <> ''
        `;
      const claude = new Set<string>();
      const codex = new Set<string>();
      for (const row of sessions) {
        const target = row.providerName === "codex" ? codex : claude;
        for (const id of providerSessionIdsOfResumeCursor(row.providerName, row.resumeCursorJson))
          target.add(id);
      }
      const deleted = new Set(
        projects.filter((row) => row.deletedAt !== null).map((row) => row.projectId),
      );
      return {
        rycoSessionIds: { claude: [...claude], codex: [...codex] },
        projectRoots: [
          ...projects.map((row) => ({
            path: row.path,
            projectId: row.projectId,
            ...(row.deletedAt === null ? {} : { deleted: true }),
          })),
          ...worktrees.map((row) => ({
            path: row.path,
            projectId: row.projectId,
            ...(deleted.has(row.projectId) ? { deleted: true } : {}),
          })),
        ].filter((root) => root.path.length > 0),
      } satisfies StatisticsMachineAttribution;
    }),
  );
