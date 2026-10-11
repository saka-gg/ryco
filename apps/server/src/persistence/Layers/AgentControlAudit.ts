import { Effect, Layer, Schema, Struct } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";

import {
  toPersistenceDecodeError,
  toPersistenceSqlError,
  type AgentControlAuditRepositoryError,
} from "../Errors.ts";
import {
  AgentControlAuditMetadata,
  AgentControlAuditRecord,
  AgentControlAuditRepository,
  type AgentControlAuditRepositoryShape,
  ListAgentControlAuditByProposalInput,
} from "../Services/AgentControlAudit.ts";

const AgentControlAuditDbRow = AgentControlAuditRecord.mapFields(
  Struct.assign({
    metadata: Schema.fromJsonString(AgentControlAuditMetadata),
  }),
);

function toSqlOrDecodeError(sqlOperation: string, decodeOperation: string) {
  return (cause: unknown): AgentControlAuditRepositoryError =>
    Schema.isSchemaError(cause)
      ? toPersistenceDecodeError(decodeOperation)(cause)
      : toPersistenceSqlError(sqlOperation)(cause);
}

const makeAgentControlAuditRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const insertRow = SqlSchema.void({
    Request: AgentControlAuditDbRow,
    execute: (row) => sql`
      INSERT INTO agent_control_audit (
        audit_id,
        proposal_id,
        event_kind,
        principal_scope,
        prompt_summary,
        metadata_json,
        created_at
      ) VALUES (
        ${row.auditId},
        ${row.proposalId},
        ${row.eventKind},
        ${row.principalScope},
        ${row.promptSummary},
        ${row.metadata},
        ${row.createdAt}
      )
    `,
  });

  const listRowsByProposalId = SqlSchema.findAll({
    Request: ListAgentControlAuditByProposalInput,
    Result: AgentControlAuditDbRow,
    execute: ({ proposalId }) => sql`
      SELECT
        audit_id AS "auditId",
        proposal_id AS "proposalId",
        event_kind AS "eventKind",
        principal_scope AS "principalScope",
        prompt_summary AS "promptSummary",
        metadata_json AS "metadata",
        created_at AS "createdAt"
      FROM agent_control_audit
      WHERE proposal_id = ${proposalId}
      ORDER BY created_at ASC, audit_id ASC
    `,
  });

  const insert: AgentControlAuditRepositoryShape["insert"] = (record) =>
    insertRow(record).pipe(
      Effect.mapError(
        toSqlOrDecodeError(
          "AgentControlAuditRepository.insert:query",
          "AgentControlAuditRepository.insert:encodeRequest",
        ),
      ),
    );

  const listByProposalId: AgentControlAuditRepositoryShape["listByProposalId"] = (input) =>
    listRowsByProposalId(input).pipe(
      Effect.mapError(
        toSqlOrDecodeError(
          "AgentControlAuditRepository.listByProposalId:query",
          "AgentControlAuditRepository.listByProposalId:decodeRows",
        ),
      ),
    );

  return {
    insert,
    listByProposalId,
  } satisfies AgentControlAuditRepositoryShape;
});

export const AgentControlAuditRepositoryLive = Layer.effect(
  AgentControlAuditRepository,
  makeAgentControlAuditRepository,
);
