import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { Effect, Layer, Option, Schema, Struct } from "effect";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  FindProjectionWorktreeByPathInput,
  GetProjectionWorktreeInput,
  ListProjectionWorktreesByProjectInput,
  MarkProjectionWorktreeArchivedInput,
  MarkProjectionWorktreeRestoredInput,
  ProjectionWorktree,
  ProjectionWorktreeRepository,
  type ProjectionWorktreeRepositoryShape,
  SetProjectionWorktreeManualPositionInput,
  UpdateProjectionWorktreeMetaInput,
} from "../Services/ProjectionWorktrees.ts";
import { WorktreeId, WorktreePullRequestLink } from "@ryco/contracts";
import { readWorktreePullRequestLinks } from "@ryco/shared/worktreePullRequests";

const ProjectionWorktreeDbRowSchema = ProjectionWorktree.mapFields(
  Struct.assign({
    prIsDraft: Schema.NullOr(Schema.Number),
    // NULL on rows written before links: derived from the flat `pr_*` columns.
    pullRequests: Schema.NullOr(Schema.fromJsonString(Schema.Array(WorktreePullRequestLink))),
  }),
);

function toProjectionWorktree(
  row: Schema.Schema.Type<typeof ProjectionWorktreeDbRowSchema>,
): ProjectionWorktree {
  const prIsDraft = row.prIsDraft === null ? null : row.prIsDraft === 1;
  return {
    worktreeId: row.worktreeId,
    projectId: row.projectId,
    title: row.title,
    branch: row.branch,
    worktreePath: row.worktreePath,
    origin: row.origin,
    prNumber: row.prNumber,
    issueNumber: row.issueNumber,
    prTitle: row.prTitle,
    issueTitle: row.issueTitle,
    prState: row.prState,
    prIsDraft,
    prTerminalAt: row.prTerminalAt ?? null,
    pullRequests:
      row.pullRequests ??
      readWorktreePullRequestLinks({
        ...row,
        prIsDraft,
        pullRequests: undefined,
      }),
    issueState: row.issueState,
    workItemProvider: row.workItemProvider,
    workItemKey: row.workItemKey,
    workItemTitle: row.workItemTitle,
    workItemState: row.workItemState,
    workItemStateName: row.workItemStateName,
    workItemUrl: row.workItemUrl,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    archivedAt: row.archivedAt,
    checkoutRemovedAt: row.checkoutRemovedAt ?? null,
    checkoutRemovalReason: row.checkoutRemovalReason ?? null,
    manualPosition: row.manualPosition,
  };
}

const makeProjectionWorktreeRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  /** The workspace carries pull request `number`: current, earlier, or not yet migrated. */
  const linkedPullRequestMatch = (number: number) => sql`
    pr_number = ${number}
    OR EXISTS (
      SELECT 1 FROM json_each(COALESCE(pull_requests_json, '[]')) AS link
      WHERE json_extract(link.value, '$.number') = ${number}
        AND json_extract(link.value, '$.dismissedAt') IS NULL
    )
  `;

  /**
   * The workspace's checkout is pull request `number`: a link that describes
   * the checkout itself (its origin, one created or discovered on its branch,
   * or a manual link whose head is the workspace branch), not a related pull
   * request linked by hand. The flat `pr_number` only speaks for rows that
   * predate links; it now mirrors the current link, which may be a manual one.
   */
  const checkoutPullRequestMatch = (number: number) => sql`
    (pull_requests_json IS NULL AND pr_number = ${number})
    OR EXISTS (
      SELECT 1 FROM json_each(pull_requests_json) AS link
      WHERE json_extract(link.value, '$.number') = ${number}
        AND json_extract(link.value, '$.dismissedAt') IS NULL
        AND (
          json_extract(link.value, '$.source') <> 'manual'
          OR json_extract(link.value, '$.headRefName') = branch
        )
    )
  `;

  const upsertProjectionWorktreeRow = SqlSchema.void({
    Request: ProjectionWorktree,
    execute: (row) =>
      sql`
        INSERT INTO projection_worktrees (
          worktree_id,
          project_id,
          title,
          branch,
          worktree_path,
          origin,
          pr_number,
          issue_number,
          pr_title,
          issue_title,
          pr_state,
          pr_is_draft,
          pr_terminal_at,
          issue_state,
          work_item_provider,
          work_item_key,
          work_item_title,
          work_item_state,
          work_item_state_name,
          work_item_url,
          created_at,
          updated_at,
          archived_at,
          checkout_removed_at,
          checkout_removal_reason,
          manual_position,
          pull_requests_json
        )
        VALUES (
          ${row.worktreeId},
          ${row.projectId},
          ${row.title ?? null},
          ${row.branch},
          ${row.worktreePath},
          ${row.origin},
          ${row.prNumber},
          ${row.issueNumber},
          ${row.prTitle},
          ${row.issueTitle},
          ${row.prState},
          ${row.prIsDraft === null ? null : row.prIsDraft ? 1 : 0},
          ${row.prTerminalAt ?? null},
          ${row.issueState},
          ${row.workItemProvider ?? null},
          ${row.workItemKey ?? null},
          ${row.workItemTitle ?? null},
          ${row.workItemState ?? null},
          ${row.workItemStateName ?? null},
          ${row.workItemUrl ?? null},
          ${row.createdAt},
          ${row.updatedAt},
          ${row.archivedAt},
          ${row.checkoutRemovedAt ?? null},
          ${row.checkoutRemovalReason ?? null},
          ${row.manualPosition},
          ${JSON.stringify(row.pullRequests ?? readWorktreePullRequestLinks(row))}
        )
        ON CONFLICT (worktree_id)
        DO UPDATE SET
          project_id = excluded.project_id,
          title = excluded.title,
          branch = excluded.branch,
          worktree_path = excluded.worktree_path,
          origin = excluded.origin,
          pr_number = excluded.pr_number,
          issue_number = excluded.issue_number,
          pr_title = excluded.pr_title,
          issue_title = excluded.issue_title,
          pr_state = excluded.pr_state,
          pr_is_draft = excluded.pr_is_draft,
          pr_terminal_at = excluded.pr_terminal_at,
          issue_state = excluded.issue_state,
          work_item_provider = excluded.work_item_provider,
          work_item_key = excluded.work_item_key,
          work_item_title = excluded.work_item_title,
          work_item_state = excluded.work_item_state,
          work_item_state_name = excluded.work_item_state_name,
          work_item_url = excluded.work_item_url,
          updated_at = excluded.updated_at,
          archived_at = excluded.archived_at,
          checkout_removed_at = excluded.checkout_removed_at,
          checkout_removal_reason = excluded.checkout_removal_reason,
          manual_position = excluded.manual_position,
          pull_requests_json = excluded.pull_requests_json
      `,
  });

  const getProjectionWorktreeRow = SqlSchema.findOneOption({
    Request: GetProjectionWorktreeInput,
    Result: ProjectionWorktreeDbRowSchema,
    execute: ({ worktreeId }) =>
      sql`
        SELECT
          worktree_id AS "worktreeId",
          project_id AS "projectId",
          title,
          branch,
          worktree_path AS "worktreePath",
          origin,
          pr_number AS "prNumber",
          issue_number AS "issueNumber",
          pr_title AS "prTitle",
          issue_title AS "issueTitle",
          pr_state AS "prState",
          pr_is_draft AS "prIsDraft",
          pr_terminal_at AS "prTerminalAt",
          issue_state AS "issueState",
          work_item_provider AS "workItemProvider",
          work_item_key AS "workItemKey",
          work_item_title AS "workItemTitle",
          work_item_state AS "workItemState",
          work_item_state_name AS "workItemStateName",
          work_item_url AS "workItemUrl",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          archived_at AS "archivedAt",
          checkout_removed_at AS "checkoutRemovedAt",
          checkout_removal_reason AS "checkoutRemovalReason",
          manual_position AS "manualPosition",
          pull_requests_json AS "pullRequests"
        FROM projection_worktrees
        WHERE worktree_id = ${worktreeId}
      `,
  });

  const findActiveProjectionWorktreeRowByPath = SqlSchema.findOneOption({
    Request: FindProjectionWorktreeByPathInput,
    Result: ProjectionWorktreeDbRowSchema,
    execute: ({ worktreePath }) =>
      sql`
        SELECT
          worktree_id AS "worktreeId",
          project_id AS "projectId",
          title,
          branch,
          worktree_path AS "worktreePath",
          origin,
          pr_number AS "prNumber",
          issue_number AS "issueNumber",
          pr_title AS "prTitle",
          issue_title AS "issueTitle",
          pr_state AS "prState",
          pr_is_draft AS "prIsDraft",
          pr_terminal_at AS "prTerminalAt",
          issue_state AS "issueState",
          work_item_provider AS "workItemProvider",
          work_item_key AS "workItemKey",
          work_item_title AS "workItemTitle",
          work_item_state AS "workItemState",
          work_item_state_name AS "workItemStateName",
          work_item_url AS "workItemUrl",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          archived_at AS "archivedAt",
          checkout_removed_at AS "checkoutRemovedAt",
          checkout_removal_reason AS "checkoutRemovalReason",
          manual_position AS "manualPosition",
          pull_requests_json AS "pullRequests"
        FROM projection_worktrees
        WHERE worktree_path = ${worktreePath}
          AND archived_at IS NULL
          AND checkout_removed_at IS NULL
        ORDER BY updated_at DESC
        LIMIT 1
      `,
  });

  const listProjectionWorktreeRows = SqlSchema.findAll({
    Request: ListProjectionWorktreesByProjectInput,
    Result: ProjectionWorktreeDbRowSchema,
    execute: ({ projectId }) =>
      sql`
        SELECT
          worktree_id AS "worktreeId",
          project_id AS "projectId",
          title,
          branch,
          worktree_path AS "worktreePath",
          origin,
          pr_number AS "prNumber",
          issue_number AS "issueNumber",
          pr_title AS "prTitle",
          issue_title AS "issueTitle",
          pr_state AS "prState",
          pr_is_draft AS "prIsDraft",
          pr_terminal_at AS "prTerminalAt",
          issue_state AS "issueState",
          work_item_provider AS "workItemProvider",
          work_item_key AS "workItemKey",
          work_item_title AS "workItemTitle",
          work_item_state AS "workItemState",
          work_item_state_name AS "workItemStateName",
          work_item_url AS "workItemUrl",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          archived_at AS "archivedAt",
          checkout_removed_at AS "checkoutRemovedAt",
          checkout_removal_reason AS "checkoutRemovalReason",
          manual_position AS "manualPosition",
          pull_requests_json AS "pullRequests"
        FROM projection_worktrees
        WHERE project_id = ${projectId}
        ORDER BY
          CASE WHEN origin = 'main' THEN 0 ELSE 1 END ASC,
          manual_position ASC,
          created_at ASC,
          worktree_id ASC
      `,
  });

  const markProjectionWorktreeArchived = SqlSchema.void({
    Request: MarkProjectionWorktreeArchivedInput,
    execute: ({ worktreeId, archivedAt }) =>
      sql`
        UPDATE projection_worktrees
        SET archived_at = ${archivedAt}, updated_at = ${archivedAt}
        WHERE worktree_id = ${worktreeId}
      `,
  });

  const markProjectionWorktreeRestored = SqlSchema.void({
    Request: MarkProjectionWorktreeRestoredInput,
    execute: ({ worktreeId, restoredAt }) =>
      sql`
        UPDATE projection_worktrees
        SET archived_at = NULL, updated_at = ${restoredAt}
        WHERE worktree_id = ${worktreeId}
      `,
  });

  const deleteProjectionWorktreeRow = SqlSchema.void({
    Request: GetProjectionWorktreeInput,
    execute: ({ worktreeId }) =>
      sql`
        DELETE FROM projection_worktrees
        WHERE worktree_id = ${worktreeId}
      `,
  });

  const updateProjectionWorktreeMeta = SqlSchema.void({
    Request: UpdateProjectionWorktreeMetaInput,
    execute: ({ worktreeId, title, updatedAt }) =>
      sql`
        UPDATE projection_worktrees
        SET title = ${title}, updated_at = ${updatedAt}
        WHERE worktree_id = ${worktreeId}
      `,
  });

  const setProjectionWorktreeManualPosition = SqlSchema.void({
    Request: SetProjectionWorktreeManualPositionInput,
    execute: ({ worktreeId, position }) =>
      sql`
        UPDATE projection_worktrees
        SET manual_position = ${position}
        WHERE worktree_id = ${worktreeId}
      `,
  });

  const findByOrigin: ProjectionWorktreeRepositoryShape["findByOrigin"] = (input) =>
    Effect.gen(function* () {
      const rows =
        input.kind === "pr"
          ? yield* sql<{ readonly worktreeId: string }>`
              SELECT worktree_id AS "worktreeId"
              FROM projection_worktrees
              WHERE project_id = ${input.projectId}
                AND origin = 'pr'
                AND (${checkoutPullRequestMatch(input.number)})
                AND archived_at IS NULL
              ORDER BY manual_position ASC, created_at ASC
              LIMIT 1
            `
          : yield* sql<{ readonly worktreeId: string }>`
              SELECT worktree_id AS "worktreeId"
              FROM projection_worktrees
              WHERE project_id = ${input.projectId}
                AND origin = 'issue'
                AND issue_number = ${input.number}
                AND archived_at IS NULL
              ORDER BY manual_position ASC, created_at ASC
              LIMIT 1
            `;
      return rows[0]?.worktreeId !== undefined ? WorktreeId.make(rows[0].worktreeId) : null;
    }).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionWorktreeRepository.findByOrigin:query")),
    );

  const findActiveByLinkedNumber: ProjectionWorktreeRepositoryShape["findActiveByLinkedNumber"] = (
    input,
  ) =>
    Effect.gen(function* () {
      const rows =
        input.kind === "pr"
          ? yield* sql<{ readonly worktreeId: string }>`
              SELECT worktree_id AS "worktreeId"
              FROM projection_worktrees
              WHERE project_id = ${input.projectId}
                AND (${linkedPullRequestMatch(input.number)})
                AND archived_at IS NULL
            `
          : yield* sql<{ readonly worktreeId: string }>`
              SELECT worktree_id AS "worktreeId"
              FROM projection_worktrees
              WHERE project_id = ${input.projectId}
                AND issue_number = ${input.number}
                AND archived_at IS NULL
            `;
      return rows.map((row) => WorktreeId.make(row.worktreeId));
    }).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionWorktreeRepository.findActiveByLinkedNumber:query"),
      ),
    );

  const findByWorkItem: ProjectionWorktreeRepositoryShape["findByWorkItem"] = (input) =>
    Effect.gen(function* () {
      const rows = yield* sql<{ readonly worktreeId: string }>`
        SELECT worktree_id AS "worktreeId"
        FROM projection_worktrees
        WHERE project_id = ${input.projectId}
          AND work_item_provider = ${input.provider}
          AND work_item_key = ${input.key}
          AND archived_at IS NULL
        ORDER BY manual_position ASC, created_at ASC
        LIMIT 1
      `;
      return rows[0]?.worktreeId !== undefined ? WorktreeId.make(rows[0].worktreeId) : null;
    }).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionWorktreeRepository.findByWorkItem:query")),
    );

  const findActiveByWorktreePath: ProjectionWorktreeRepositoryShape["findActiveByWorktreePath"] = (
    input,
  ) =>
    findActiveProjectionWorktreeRowByPath(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionWorktreeRepository.findActiveByWorktreePath:query"),
      ),
      Effect.map(Option.map(toProjectionWorktree)),
    );

  const upsert: ProjectionWorktreeRepositoryShape["upsert"] = (row) =>
    upsertProjectionWorktreeRow(row).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionWorktreeRepository.upsert:query")),
    );

  const getById: ProjectionWorktreeRepositoryShape["getById"] = (input) =>
    getProjectionWorktreeRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionWorktreeRepository.getById:query")),
      Effect.map(Option.map(toProjectionWorktree)),
    );

  const listByProjectId: ProjectionWorktreeRepositoryShape["listByProjectId"] = (input) =>
    listProjectionWorktreeRows(input).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionWorktreeRepository.listByProjectId:query")),
      Effect.map((rows) => rows.map(toProjectionWorktree)),
    );

  const markArchived: ProjectionWorktreeRepositoryShape["markArchived"] = (input) =>
    markProjectionWorktreeArchived(input).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionWorktreeRepository.markArchived:query")),
    );

  const markRestored: ProjectionWorktreeRepositoryShape["markRestored"] = (input) =>
    markProjectionWorktreeRestored(input).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionWorktreeRepository.markRestored:query")),
    );

  const deleteById: ProjectionWorktreeRepositoryShape["deleteById"] = (input) =>
    deleteProjectionWorktreeRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionWorktreeRepository.deleteById:query")),
    );

  const updateMeta: ProjectionWorktreeRepositoryShape["updateMeta"] = (input) =>
    updateProjectionWorktreeMeta(input).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionWorktreeRepository.updateMeta:query")),
    );

  const setManualPosition: ProjectionWorktreeRepositoryShape["setManualPosition"] = (input) =>
    setProjectionWorktreeManualPosition(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionWorktreeRepository.setManualPosition:query"),
      ),
    );

  return {
    upsert,
    getById,
    listByProjectId,
    findByOrigin,
    findActiveByLinkedNumber,
    findByWorkItem,
    findActiveByWorktreePath,
    markArchived,
    markRestored,
    updateMeta,
    deleteById,
    setManualPosition,
  } satisfies ProjectionWorktreeRepositoryShape;
});

export const ProjectionWorktreeRepositoryLive = Layer.effect(
  ProjectionWorktreeRepository,
  makeProjectionWorktreeRepository,
);
