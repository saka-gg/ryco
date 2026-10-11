import {
  AgentControlCapability,
  AgentControlExternalProjectScope,
  AgentControlExternalTaskId,
  AgentControlIntegrationId,
  AgentControlProposalId,
} from "@ryco/contracts";
import { Effect, Layer, Schema, Struct } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";

import {
  toPersistenceDecodeError,
  toPersistenceSqlError,
  type AgentControlExternalRepositoryError,
} from "../Errors.ts";
import {
  AgentControlExternalAuditRecord,
  AgentControlExternalRepository,
  type AgentControlExternalRepositoryShape,
  AgentControlExternalSecretHash,
  StoredAgentControlExternalIntegration,
  StoredAgentControlExternalTask,
} from "../Services/AgentControlExternal.ts";

const IntegrationDbRow = StoredAgentControlExternalIntegration.mapFields(
  Struct.assign({
    projectScope: Schema.fromJsonString(AgentControlExternalProjectScope),
    capabilities: Schema.fromJsonString(Schema.Array(AgentControlCapability)),
  }),
);
const TaskDbRow = StoredAgentControlExternalTask;
const AuditDbRow = AgentControlExternalAuditRecord;
const IntegrationIdResult = Schema.Struct({ integrationId: AgentControlIntegrationId });
const TaskIdResult = Schema.Struct({ taskId: AgentControlExternalTaskId });
const ProposalIdResult = Schema.Struct({ proposalId: AgentControlProposalId });

const toError =
  (sqlOperation: string, decodeOperation: string) =>
  (cause: unknown): AgentControlExternalRepositoryError =>
    Schema.isSchemaError(cause)
      ? toPersistenceDecodeError(decodeOperation)(cause)
      : toPersistenceSqlError(sqlOperation)(cause);

const makeAgentControlExternalRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const insertIntegrationRows = SqlSchema.findAll({
    Request: IntegrationDbRow,
    Result: IntegrationIdResult,
    execute: (row) => sql`
      INSERT INTO agent_control_external_integrations (
        integration_id, display_name, client_kind, project_scope_json, capabilities_json,
        rate_limit_per_minute, active_task_limit, active_task_count, expires_at, revoked_at,
        pairing_state, pairing_code_hash, pairing_code_expires_at, paired_at,
        credential_audience, credential_hash, created_at, updated_at, last_used_at
      ) VALUES (
        ${row.integrationId}, ${row.displayName}, ${row.clientKind}, ${row.projectScope},
        ${row.capabilities}, ${row.rateLimitPerMinute}, ${row.activeTaskLimit},
        ${row.activeTaskCount}, ${row.expiresAt}, ${row.revokedAt}, ${row.pairingState},
        ${row.pairingCodeHash}, ${row.pairingCodeExpiresAt}, ${row.pairedAt},
        ${row.credentialAudience}, ${row.credentialHash}, ${row.createdAt}, ${row.updatedAt},
        ${row.lastUsedAt}
      )
      ON CONFLICT DO NOTHING
      RETURNING integration_id AS "integrationId"
    `,
  });

  // SqlSchema needs static template literals, so the repeated projection stays explicit.
  const getIntegrationRow = SqlSchema.findOneOption({
    Request: Schema.Struct({ integrationId: AgentControlIntegrationId }),
    Result: IntegrationDbRow,
    execute: ({ integrationId }) => sql`
      SELECT integration_id AS "integrationId", display_name AS "displayName",
        client_kind AS "clientKind", project_scope_json AS "projectScope",
        capabilities_json AS "capabilities", rate_limit_per_minute AS "rateLimitPerMinute",
        active_task_limit AS "activeTaskLimit", active_task_count AS "activeTaskCount",
        expires_at AS "expiresAt", revoked_at AS "revokedAt", pairing_state AS "pairingState",
        pairing_code_hash AS "pairingCodeHash", pairing_code_expires_at AS "pairingCodeExpiresAt",
        paired_at AS "pairedAt", credential_audience AS "credentialAudience",
        credential_hash AS "credentialHash", created_at AS "createdAt", updated_at AS "updatedAt",
        last_used_at AS "lastUsedAt"
      FROM agent_control_external_integrations WHERE integration_id = ${integrationId} LIMIT 1
    `,
  });

  const listIntegrationRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: IntegrationDbRow,
    execute: () => sql`
      SELECT integration_id AS "integrationId", display_name AS "displayName",
        client_kind AS "clientKind", project_scope_json AS "projectScope",
        capabilities_json AS "capabilities", rate_limit_per_minute AS "rateLimitPerMinute",
        active_task_limit AS "activeTaskLimit", active_task_count AS "activeTaskCount",
        expires_at AS "expiresAt", revoked_at AS "revokedAt", pairing_state AS "pairingState",
        pairing_code_hash AS "pairingCodeHash", pairing_code_expires_at AS "pairingCodeExpiresAt",
        paired_at AS "pairedAt", credential_audience AS "credentialAudience",
        credential_hash AS "credentialHash", created_at AS "createdAt", updated_at AS "updatedAt",
        last_used_at AS "lastUsedAt"
      FROM agent_control_external_integrations ORDER BY created_at ASC, integration_id ASC
    `,
  });

  const findCredentialRow = SqlSchema.findOneOption({
    Request: Schema.Struct({ credentialHash: AgentControlExternalSecretHash }),
    Result: IntegrationDbRow,
    execute: ({ credentialHash }) => sql`
      SELECT integration_id AS "integrationId", display_name AS "displayName",
        client_kind AS "clientKind", project_scope_json AS "projectScope",
        capabilities_json AS "capabilities", rate_limit_per_minute AS "rateLimitPerMinute",
        active_task_limit AS "activeTaskLimit", active_task_count AS "activeTaskCount",
        expires_at AS "expiresAt", revoked_at AS "revokedAt", pairing_state AS "pairingState",
        pairing_code_hash AS "pairingCodeHash", pairing_code_expires_at AS "pairingCodeExpiresAt",
        paired_at AS "pairedAt", credential_audience AS "credentialAudience",
        credential_hash AS "credentialHash", created_at AS "createdAt", updated_at AS "updatedAt",
        last_used_at AS "lastUsedAt"
      FROM agent_control_external_integrations
      WHERE credential_hash = ${credentialHash} AND credential_audience = 'external-mcp'
      LIMIT 1
    `,
  });

  const replaceIntegrationRows = SqlSchema.findAll({
    Request: IntegrationDbRow,
    Result: IntegrationIdResult,
    execute: (row) => sql`
      UPDATE agent_control_external_integrations SET
        display_name = ${row.displayName}, client_kind = ${row.clientKind},
        project_scope_json = ${row.projectScope}, capabilities_json = ${row.capabilities},
        rate_limit_per_minute = ${row.rateLimitPerMinute},
        active_task_limit = ${row.activeTaskLimit}, active_task_count = ${row.activeTaskCount},
        expires_at = ${row.expiresAt}, revoked_at = ${row.revokedAt},
        pairing_state = ${row.pairingState}, pairing_code_hash = ${row.pairingCodeHash},
        pairing_code_expires_at = ${row.pairingCodeExpiresAt}, paired_at = ${row.pairedAt},
        credential_audience = ${row.credentialAudience}, credential_hash = ${row.credentialHash},
        updated_at = ${row.updatedAt}, last_used_at = ${row.lastUsedAt}
      WHERE integration_id = ${row.integrationId}
      RETURNING integration_id AS "integrationId"
    `,
  });

  const exchangeRows = SqlSchema.findAll({
    Request: Schema.Struct({
      integrationId: AgentControlIntegrationId,
      pairingCodeHash: AgentControlExternalSecretHash,
      credentialHash: AgentControlExternalSecretHash,
      now: Schema.String,
    }),
    Result: IntegrationIdResult,
    execute: (input) => sql`
      UPDATE agent_control_external_integrations SET
        pairing_state = 'paired', pairing_code_hash = NULL, pairing_code_expires_at = NULL,
        paired_at = ${input.now}, credential_audience = 'external-mcp',
        credential_hash = ${input.credentialHash}, updated_at = ${input.now}
      WHERE integration_id = ${input.integrationId}
        AND pairing_state = 'pending'
        AND pairing_code_hash = ${input.pairingCodeHash}
        AND pairing_code_expires_at > ${input.now}
        AND revoked_at IS NULL
        AND (expires_at IS NULL OR expires_at > ${input.now})
      RETURNING integration_id AS "integrationId"
    `,
  });

  const insertTaskRows = SqlSchema.findAll({
    Request: TaskDbRow,
    Result: TaskIdResult,
    execute: (row) => sql`
      INSERT INTO agent_control_external_tasks (
        task_id, integration_id, request_id, plan_digest, proposal_id, project_id,
        provider_instance_id, environment, runtime_mode, created_at, updated_at, released_at
      ) VALUES (
        ${row.taskId}, ${row.integrationId}, ${row.requestId}, ${row.planDigest}, ${row.proposalId},
        ${row.projectId}, ${row.providerInstanceId}, ${row.environment}, ${row.runtimeMode},
        ${row.createdAt}, ${row.updatedAt}, ${row.releasedAt}
      ) ON CONFLICT DO NOTHING RETURNING task_id AS "taskId"
    `,
  });

  const getTaskRow = SqlSchema.findOneOption({
    Request: Schema.Struct({ taskId: AgentControlExternalTaskId }),
    Result: TaskDbRow,
    execute: ({ taskId }) => sql`
      SELECT task_id AS "taskId", integration_id AS "integrationId", request_id AS "requestId",
        plan_digest AS "planDigest", proposal_id AS "proposalId", project_id AS "projectId",
        provider_instance_id AS "providerInstanceId", environment, runtime_mode AS "runtimeMode",
        created_at AS "createdAt", updated_at AS "updatedAt", released_at AS "releasedAt"
      FROM agent_control_external_tasks WHERE task_id = ${taskId} LIMIT 1
    `,
  });
  const findTaskByRequestRow = SqlSchema.findOneOption({
    Request: Schema.Struct({
      integrationId: AgentControlIntegrationId,
      requestId: StoredAgentControlExternalTask.fields.requestId,
    }),
    Result: TaskDbRow,
    execute: (input) => sql`
      SELECT task_id AS "taskId", integration_id AS "integrationId", request_id AS "requestId",
        plan_digest AS "planDigest", proposal_id AS "proposalId", project_id AS "projectId",
        provider_instance_id AS "providerInstanceId", environment, runtime_mode AS "runtimeMode",
        created_at AS "createdAt", updated_at AS "updatedAt", released_at AS "releasedAt"
      FROM agent_control_external_tasks
      WHERE integration_id = ${input.integrationId} AND request_id = ${input.requestId} LIMIT 1
    `,
  });
  const findTaskByProposalRow = SqlSchema.findOneOption({
    Request: Schema.Struct({ proposalId: AgentControlProposalId }),
    Result: TaskDbRow,
    execute: ({ proposalId }) => sql`
      SELECT task_id AS "taskId", integration_id AS "integrationId", request_id AS "requestId",
        plan_digest AS "planDigest", proposal_id AS "proposalId", project_id AS "projectId",
        provider_instance_id AS "providerInstanceId", environment, runtime_mode AS "runtimeMode",
        created_at AS "createdAt", updated_at AS "updatedAt", released_at AS "releasedAt"
      FROM agent_control_external_tasks WHERE proposal_id = ${proposalId} LIMIT 1
    `,
  });
  const listUnreleasedTaskRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: TaskDbRow,
    execute: () => sql`
      SELECT task_id AS "taskId", integration_id AS "integrationId", request_id AS "requestId",
        plan_digest AS "planDigest", proposal_id AS "proposalId", project_id AS "projectId",
        provider_instance_id AS "providerInstanceId", environment, runtime_mode AS "runtimeMode",
        created_at AS "createdAt", updated_at AS "updatedAt", released_at AS "releasedAt"
      FROM agent_control_external_tasks WHERE released_at IS NULL ORDER BY created_at ASC
    `,
  });

  const insertAuditRow = SqlSchema.void({
    Request: AuditDbRow,
    execute: (row) => sql`
      INSERT INTO agent_control_external_audit (
        audit_id, integration_id, tool, request_id, project_id, runtime_mode, environment,
        proposal_id, operation_id, thread_id, outcome, created_at
      ) VALUES (
        ${row.auditId}, ${row.integrationId}, ${row.tool}, ${row.requestId}, ${row.projectId},
        ${row.runtimeMode}, ${row.environment}, ${row.proposalId}, ${row.operationId},
        ${row.threadId}, ${row.outcome}, ${row.createdAt}
      )
    `,
  });

  const map = <A, E>(operation: string, effect: Effect.Effect<A, E>) =>
    effect.pipe(Effect.mapError(toError(`${operation}:query`, `${operation}:decode`)));

  const insertIntegration: AgentControlExternalRepositoryShape["insertIntegration"] = (record) =>
    map("ExternalRepository.insertIntegration", insertIntegrationRows(record)).pipe(
      Effect.map((rows) => rows.length === 1),
    );
  const getIntegration: AgentControlExternalRepositoryShape["getIntegration"] = (integrationId) =>
    map("ExternalRepository.getIntegration", getIntegrationRow({ integrationId }));
  const listIntegrations: AgentControlExternalRepositoryShape["listIntegrations"] = () =>
    map("ExternalRepository.listIntegrations", listIntegrationRows(undefined));
  const replaceIntegration: AgentControlExternalRepositoryShape["replaceIntegration"] = (record) =>
    map("ExternalRepository.replaceIntegration", replaceIntegrationRows(record)).pipe(
      Effect.map((rows) => rows.length === 1),
    );
  const deleteIntegration: AgentControlExternalRepositoryShape["deleteIntegration"] = (
    integrationId,
  ) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const rows = yield* sql<{ readonly integrationId: string }>`
            DELETE FROM agent_control_external_integrations
            WHERE integration_id = ${integrationId} AND active_task_count = 0
            RETURNING integration_id AS "integrationId"
          `;
          if (rows.length === 0) return false;
          yield* sql`DELETE FROM agent_control_external_tasks WHERE integration_id = ${integrationId}`;
          yield* sql`DELETE FROM agent_control_external_audit WHERE integration_id = ${integrationId}`;
          return true;
        }),
      )
      .pipe(
        Effect.mapError(
          toError("ExternalRepository.deleteIntegration:transaction", "deleteIntegration"),
        ),
      );
  const findByCredentialHash: AgentControlExternalRepositoryShape["findByCredentialHash"] = (
    credentialHash,
  ) => map("ExternalRepository.findByCredentialHash", findCredentialRow({ credentialHash }));
  const exchangePairing: AgentControlExternalRepositoryShape["exchangePairing"] = (input) =>
    map("ExternalRepository.exchangePairing", exchangeRows(input)).pipe(
      Effect.map((rows) => rows.length === 1),
    );
  const touchLastUsed: AgentControlExternalRepositoryShape["touchLastUsed"] = (input) =>
    map(
      "ExternalRepository.touchLastUsed",
      sql`UPDATE agent_control_external_integrations
          SET last_used_at = ${input.now}, updated_at = ${input.now}
          WHERE integration_id = ${input.integrationId}`,
    ).pipe(Effect.asVoid);
  const reserveCapacity: AgentControlExternalRepositoryShape["reserveCapacity"] = (integrationId) =>
    map(
      "ExternalRepository.reserveCapacity",
      sql<{ readonly integrationId: string }>`
        UPDATE agent_control_external_integrations
        SET active_task_count = active_task_count + 1
        WHERE integration_id = ${integrationId}
          AND active_task_count < active_task_limit
        RETURNING integration_id AS "integrationId"
      `,
    ).pipe(Effect.map((rows) => rows.length === 1));
  const insertTask: AgentControlExternalRepositoryShape["insertTask"] = (task) =>
    map("ExternalRepository.insertTask", insertTaskRows(task)).pipe(
      Effect.map((rows) => rows.length === 1),
    );
  const attachTaskProposal: AgentControlExternalRepositoryShape["attachTaskProposal"] = (input) =>
    map(
      "ExternalRepository.attachTaskProposal",
      sql<{ readonly proposalId: string }>`
        UPDATE agent_control_external_tasks
        SET proposal_id = ${input.proposalId}, updated_at = ${input.updatedAt}
        WHERE task_id = ${input.taskId} AND proposal_id IS NULL
        RETURNING proposal_id AS "proposalId"
      `,
    ).pipe(Effect.map((rows) => rows.length === 1));
  const getTask: AgentControlExternalRepositoryShape["getTask"] = (taskId) =>
    map("ExternalRepository.getTask", getTaskRow({ taskId }));
  const findTaskByRequest: AgentControlExternalRepositoryShape["findTaskByRequest"] = (input) =>
    map("ExternalRepository.findTaskByRequest", findTaskByRequestRow(input));
  const findTaskByProposal: AgentControlExternalRepositoryShape["findTaskByProposal"] = (
    proposalId,
  ) => map("ExternalRepository.findTaskByProposal", findTaskByProposalRow({ proposalId }));
  const listUnreleasedTasks: AgentControlExternalRepositoryShape["listUnreleasedTasks"] = () =>
    map("ExternalRepository.listUnreleasedTasks", listUnreleasedTaskRows(undefined));
  const releaseTask: AgentControlExternalRepositoryShape["releaseTask"] = (input) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const rows = yield* sql<{ readonly taskId: string }>`
          UPDATE agent_control_external_tasks
          SET released_at = ${input.releasedAt}, updated_at = ${input.releasedAt}
          WHERE task_id = ${input.taskId} AND integration_id = ${input.integrationId}
            AND released_at IS NULL
          RETURNING task_id AS "taskId"
        `;
          if (rows.length === 0) return false;
          yield* sql`
          UPDATE agent_control_external_integrations
          SET active_task_count = MAX(0, active_task_count - 1), updated_at = ${input.releasedAt}
          WHERE integration_id = ${input.integrationId}
        `;
          return true;
        }),
      )
      .pipe(Effect.mapError(toError("ExternalRepository.releaseTask:transaction", "releaseTask")));
  const insertAudit: AgentControlExternalRepositoryShape["insertAudit"] = (record) =>
    map("ExternalRepository.insertAudit", insertAuditRow(record));
  const reconcileCapacity: AgentControlExternalRepositoryShape["reconcileCapacity"] = () =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          yield* sql`UPDATE agent_control_external_integrations SET active_task_count = 0`;
          yield* sql`
          UPDATE agent_control_external_integrations
          SET active_task_count = (
            SELECT COUNT(*) FROM agent_control_external_tasks task
            WHERE task.integration_id = agent_control_external_integrations.integration_id
              AND task.released_at IS NULL
          )
        `;
        }),
      )
      .pipe(
        Effect.mapError(
          toError("ExternalRepository.reconcileCapacity:transaction", "reconcileCapacity"),
        ),
      );
  const countAuditSince: AgentControlExternalRepositoryShape["countAuditSince"] = (input) =>
    map(
      "ExternalRepository.countAuditSince",
      sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM agent_control_external_audit
        WHERE integration_id = ${input.integrationId}
          AND created_at >= ${input.since}
          AND outcome = 'request-admitted'
      `,
    ).pipe(Effect.map((rows) => Number(rows[0]?.count ?? 0)));
  const pruneAudit: AgentControlExternalRepositoryShape["pruneAudit"] = (input) =>
    map(
      "ExternalRepository.pruneAudit",
      sql`
        DELETE FROM agent_control_external_audit
        WHERE integration_id = ${input.integrationId}
          AND (
            created_at < ${input.before}
            OR audit_id NOT IN (
              SELECT audit_id FROM agent_control_external_audit
              WHERE integration_id = ${input.integrationId}
              ORDER BY created_at DESC, audit_id DESC LIMIT ${input.keepNewest}
            )
          )
      `,
    ).pipe(Effect.asVoid);

  return {
    insertIntegration,
    getIntegration,
    listIntegrations,
    replaceIntegration,
    deleteIntegration,
    findByCredentialHash,
    exchangePairing,
    touchLastUsed,
    reserveCapacity,
    insertTask,
    attachTaskProposal,
    getTask,
    findTaskByRequest,
    findTaskByProposal,
    listUnreleasedTasks,
    releaseTask,
    reconcileCapacity,
    insertAudit,
    countAuditSince,
    pruneAudit,
  } satisfies AgentControlExternalRepositoryShape;
});

export const AgentControlExternalRepositoryLive = Layer.effect(
  AgentControlExternalRepository,
  makeAgentControlExternalRepository,
);
