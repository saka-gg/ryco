import { type AtlassianConnectionId, type ProjectId } from "@ryco/contracts";
import * as SqlClient from "effect/sql/SqlClient";
import { Effect, Layer, Option, Schema } from "effect";

import {
  toPersistenceDecodeCauseError,
  toPersistenceSqlError,
  type ProjectAtlassianLinkRepositoryError,
} from "../Errors.ts";
import {
  ProjectAtlassianLinkRecord,
  ProjectAtlassianLinkRepository,
  type ProjectAtlassianLinkRepositoryShape,
} from "../Services/ProjectAtlassianLinks.ts";

interface ProjectAtlassianLinkDbRow {
  readonly projectId: ProjectId;
  readonly jiraConnectionId: AtlassianConnectionId | null;
  readonly bitbucketConnectionId: AtlassianConnectionId | null;
  readonly jiraCloudId: string | null;
  readonly jiraSiteUrl: string | null;
  readonly jiraProjectKeysJson: string;
  readonly bitbucketWorkspace: string | null;
  readonly bitbucketRepoSlug: string | null;
  readonly defaultIssueTypeName: string | null;
  readonly branchNameTemplate: string;
  readonly commitMessageTemplate: string;
  readonly pullRequestTitleTemplate: string;
  readonly smartLinkingEnabled: number;
  readonly autoAttachWorkItems: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

function decodeProjectKeys(
  raw: string,
): Effect.Effect<ReadonlyArray<string>, ProjectAtlassianLinkRepositoryError> {
  return Effect.try({
    try: () => Schema.decodeUnknownSync(Schema.Array(Schema.String))(JSON.parse(raw)),
    catch: toPersistenceDecodeCauseError("ProjectAtlassianLinkRepository.decodeProjectKeys"),
  });
}

function toRecord(
  row: ProjectAtlassianLinkDbRow,
): Effect.Effect<ProjectAtlassianLinkRecord, ProjectAtlassianLinkRepositoryError> {
  return decodeProjectKeys(row.jiraProjectKeysJson).pipe(
    Effect.map((jiraProjectKeys) => ({
      projectId: row.projectId,
      jiraConnectionId: row.jiraConnectionId,
      bitbucketConnectionId: row.bitbucketConnectionId,
      jiraCloudId: row.jiraCloudId,
      jiraSiteUrl: row.jiraSiteUrl,
      jiraProjectKeys: [...jiraProjectKeys],
      bitbucketWorkspace: row.bitbucketWorkspace,
      bitbucketRepoSlug: row.bitbucketRepoSlug,
      defaultIssueTypeName: row.defaultIssueTypeName,
      branchNameTemplate: row.branchNameTemplate,
      commitMessageTemplate: row.commitMessageTemplate,
      pullRequestTitleTemplate: row.pullRequestTitleTemplate,
      smartLinkingEnabled: row.smartLinkingEnabled === 1,
      autoAttachWorkItems: row.autoAttachWorkItems === 1,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    })),
  );
}

const makeProjectAtlassianLinkRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const getByProjectId: ProjectAtlassianLinkRepositoryShape["getByProjectId"] = ({ projectId }) =>
    sql<ProjectAtlassianLinkDbRow>`
      SELECT
        project_id AS "projectId",
        jira_connection_id AS "jiraConnectionId",
        bitbucket_connection_id AS "bitbucketConnectionId",
        jira_cloud_id AS "jiraCloudId",
        jira_site_url AS "jiraSiteUrl",
        jira_project_keys_json AS "jiraProjectKeysJson",
        bitbucket_workspace AS "bitbucketWorkspace",
        bitbucket_repo_slug AS "bitbucketRepoSlug",
        default_issue_type_name AS "defaultIssueTypeName",
        branch_name_template AS "branchNameTemplate",
        commit_message_template AS "commitMessageTemplate",
        pull_request_title_template AS "pullRequestTitleTemplate",
        smart_linking_enabled AS "smartLinkingEnabled",
        auto_attach_work_items AS "autoAttachWorkItems",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM project_atlassian_links
      WHERE project_id = ${projectId}
      LIMIT 1
    `.pipe(
      Effect.mapError(toPersistenceSqlError("ProjectAtlassianLinkRepository.getByProjectId:query")),
      Effect.flatMap((rows) =>
        rows[0] === undefined
          ? Effect.succeed(Option.none())
          : toRecord(rows[0]).pipe(Effect.map(Option.some)),
      ),
    );

  const upsert: ProjectAtlassianLinkRepositoryShape["upsert"] = (row) =>
    sql`
      INSERT INTO project_atlassian_links (
        project_id,
        jira_connection_id,
        bitbucket_connection_id,
        jira_cloud_id,
        jira_site_url,
        jira_project_keys_json,
        bitbucket_workspace,
        bitbucket_repo_slug,
        default_issue_type_name,
        branch_name_template,
        commit_message_template,
        pull_request_title_template,
        smart_linking_enabled,
        auto_attach_work_items,
        created_at,
        updated_at
      )
      VALUES (
        ${row.projectId},
        ${row.jiraConnectionId},
        ${row.bitbucketConnectionId},
        ${row.jiraCloudId},
        ${row.jiraSiteUrl},
        ${JSON.stringify(row.jiraProjectKeys)},
        ${row.bitbucketWorkspace},
        ${row.bitbucketRepoSlug},
        ${row.defaultIssueTypeName},
        ${row.branchNameTemplate},
        ${row.commitMessageTemplate},
        ${row.pullRequestTitleTemplate},
        ${row.smartLinkingEnabled ? 1 : 0},
        ${row.autoAttachWorkItems ? 1 : 0},
        ${row.createdAt},
        ${row.updatedAt}
      )
      ON CONFLICT (project_id)
      DO UPDATE SET
        jira_connection_id = excluded.jira_connection_id,
        bitbucket_connection_id = excluded.bitbucket_connection_id,
        jira_cloud_id = excluded.jira_cloud_id,
        jira_site_url = excluded.jira_site_url,
        jira_project_keys_json = excluded.jira_project_keys_json,
        bitbucket_workspace = excluded.bitbucket_workspace,
        bitbucket_repo_slug = excluded.bitbucket_repo_slug,
        default_issue_type_name = excluded.default_issue_type_name,
        branch_name_template = excluded.branch_name_template,
        commit_message_template = excluded.commit_message_template,
        pull_request_title_template = excluded.pull_request_title_template,
        smart_linking_enabled = excluded.smart_linking_enabled,
        auto_attach_work_items = excluded.auto_attach_work_items,
        updated_at = excluded.updated_at
    `.pipe(
      Effect.asVoid,
      Effect.mapError(toPersistenceSqlError("ProjectAtlassianLinkRepository.upsert:query")),
    );

  const deleteByProjectId: ProjectAtlassianLinkRepositoryShape["deleteByProjectId"] = ({
    projectId,
  }) =>
    sql`
      DELETE FROM project_atlassian_links
      WHERE project_id = ${projectId}
    `.pipe(
      Effect.asVoid,
      Effect.mapError(
        toPersistenceSqlError("ProjectAtlassianLinkRepository.deleteByProjectId:query"),
      ),
    );

  const clearConnectionReferences: ProjectAtlassianLinkRepositoryShape["clearConnectionReferences"] =
    ({ connectionId, updatedAt }) =>
      sql`
        UPDATE project_atlassian_links
        SET
          jira_cloud_id = CASE WHEN jira_connection_id = ${connectionId} THEN NULL ELSE jira_cloud_id END,
          jira_site_url = CASE WHEN jira_connection_id = ${connectionId} THEN NULL ELSE jira_site_url END,
          jira_project_keys_json = CASE WHEN jira_connection_id = ${connectionId} THEN ${JSON.stringify([])} ELSE jira_project_keys_json END,
          default_issue_type_name = CASE WHEN jira_connection_id = ${connectionId} THEN NULL ELSE default_issue_type_name END,
          jira_connection_id = CASE WHEN jira_connection_id = ${connectionId} THEN NULL ELSE jira_connection_id END,
          bitbucket_workspace = CASE WHEN bitbucket_connection_id = ${connectionId} THEN NULL ELSE bitbucket_workspace END,
          bitbucket_repo_slug = CASE WHEN bitbucket_connection_id = ${connectionId} THEN NULL ELSE bitbucket_repo_slug END,
          bitbucket_connection_id = CASE WHEN bitbucket_connection_id = ${connectionId} THEN NULL ELSE bitbucket_connection_id END,
          updated_at = ${updatedAt}
        WHERE jira_connection_id = ${connectionId}
           OR bitbucket_connection_id = ${connectionId}
      `.pipe(
        Effect.asVoid,
        Effect.mapError(
          toPersistenceSqlError("ProjectAtlassianLinkRepository.clearConnectionReferences:query"),
        ),
      );

  return {
    getByProjectId,
    upsert,
    deleteByProjectId,
    clearConnectionReferences,
  } satisfies ProjectAtlassianLinkRepositoryShape;
});

export const ProjectAtlassianLinkRepositoryLive = Layer.effect(
  ProjectAtlassianLinkRepository,
  makeProjectAtlassianLinkRepository,
);
