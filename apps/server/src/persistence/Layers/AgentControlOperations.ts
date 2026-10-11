import {
  AgentControlOperation,
  AgentControlOperationId,
  AgentControlOperationState,
  AgentControlResultEnvelope,
} from "@ryco/contracts";
import { Effect, Layer, Schema, Struct } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";

import {
  toPersistenceDecodeError,
  toPersistenceSqlError,
  type AgentControlOperationRepositoryError,
} from "../Errors.ts";
import {
  AgentControlOperationRepository,
  type AgentControlOperationRepositoryShape,
  CompareAndSetAgentControlOperationInput,
  GetAgentControlOperationByProposalInput,
  GetAgentControlOperationInput,
} from "../Services/AgentControlOperations.ts";

const AgentControlOperationDbRow = AgentControlOperation.mapFields(
  Struct.assign({
    state: Schema.fromJsonString(AgentControlOperationState),
    result: Schema.NullOr(Schema.fromJsonString(AgentControlResultEnvelope)),
  }),
);

const CompareAndSetAgentControlOperationDbInput = CompareAndSetAgentControlOperationInput.mapFields(
  Struct.assign({
    state: Schema.fromJsonString(AgentControlOperationState),
    result: Schema.NullOr(Schema.fromJsonString(AgentControlResultEnvelope)),
  }),
);

const OperationIdResult = Schema.Struct({ operationId: AgentControlOperationId });

function toSqlOrDecodeError(sqlOperation: string, decodeOperation: string) {
  return (cause: unknown): AgentControlOperationRepositoryError =>
    Schema.isSchemaError(cause)
      ? toPersistenceDecodeError(decodeOperation)(cause)
      : toPersistenceSqlError(sqlOperation)(cause);
}

const makeAgentControlOperationRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const insertRow = SqlSchema.findAll({
    Request: AgentControlOperationDbRow,
    Result: OperationIdResult,
    execute: (row) => sql`
      INSERT INTO agent_control_operations (
        operation_id,
        proposal_id,
        action_kind,
        status,
        attempt,
        state_json,
        result_json,
        created_at,
        updated_at
      ) VALUES (
        ${row.operationId},
        ${row.proposalId},
        ${row.actionKind},
        ${row.status},
        ${row.attempt},
        ${row.state},
        ${row.result},
        ${row.createdAt},
        ${row.updatedAt}
      )
      ON CONFLICT DO NOTHING
      RETURNING operation_id AS "operationId"
    `,
  });

  const getRow = SqlSchema.findOneOption({
    Request: GetAgentControlOperationInput,
    Result: AgentControlOperationDbRow,
    execute: ({ operationId }) => sql`
      SELECT
        operation_id AS "operationId",
        proposal_id AS "proposalId",
        action_kind AS "actionKind",
        status,
        attempt,
        state_json AS "state",
        result_json AS "result",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM agent_control_operations
      WHERE operation_id = ${operationId}
      LIMIT 1
    `,
  });

  const getRowByProposalId = SqlSchema.findOneOption({
    Request: GetAgentControlOperationByProposalInput,
    Result: AgentControlOperationDbRow,
    execute: ({ proposalId }) => sql`
      SELECT
        operation_id AS "operationId",
        proposal_id AS "proposalId",
        action_kind AS "actionKind",
        status,
        attempt,
        state_json AS "state",
        result_json AS "result",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM agent_control_operations
      WHERE proposal_id = ${proposalId}
      LIMIT 1
    `,
  });

  const listRecoverableRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: AgentControlOperationDbRow,
    execute: () => sql`
      SELECT
        operation_id AS "operationId",
        proposal_id AS "proposalId",
        action_kind AS "actionKind",
        status,
        attempt,
        state_json AS "state",
        result_json AS "result",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM agent_control_operations
      WHERE status IN ('pending', 'running', 'compensating')
      ORDER BY updated_at ASC, operation_id ASC
    `,
  });

  const compareAndSetRow = SqlSchema.findAll({
    Request: CompareAndSetAgentControlOperationDbInput,
    Result: OperationIdResult,
    execute: (input) => sql`
      UPDATE agent_control_operations
      SET status = ${input.nextStatus},
          attempt = ${input.attempt},
          state_json = ${input.state},
          result_json = ${input.result},
          updated_at = ${input.updatedAt}
      WHERE operation_id = ${input.operationId}
        AND status = ${input.expectedStatus}
      RETURNING operation_id AS "operationId"
    `,
  });

  const insert: AgentControlOperationRepositoryShape["insert"] = (input) =>
    insertRow(input).pipe(
      Effect.map((rows) => rows.length === 1),
      Effect.mapError(
        toSqlOrDecodeError(
          "AgentControlOperationRepository.insert:query",
          "AgentControlOperationRepository.insert:encodeRequest",
        ),
      ),
    );

  const getById: AgentControlOperationRepositoryShape["getById"] = (input) =>
    getRow(input).pipe(
      Effect.mapError(
        toSqlOrDecodeError(
          "AgentControlOperationRepository.getById:query",
          "AgentControlOperationRepository.getById:decodeRow",
        ),
      ),
    );

  const getByProposalId: AgentControlOperationRepositoryShape["getByProposalId"] = (input) =>
    getRowByProposalId(input).pipe(
      Effect.mapError(
        toSqlOrDecodeError(
          "AgentControlOperationRepository.getByProposalId:query",
          "AgentControlOperationRepository.getByProposalId:decodeRow",
        ),
      ),
    );

  const listRecoverable: AgentControlOperationRepositoryShape["listRecoverable"] = () =>
    listRecoverableRows(undefined).pipe(
      Effect.mapError(
        toSqlOrDecodeError(
          "AgentControlOperationRepository.listRecoverable:query",
          "AgentControlOperationRepository.listRecoverable:decodeRows",
        ),
      ),
    );

  const compareAndSet: AgentControlOperationRepositoryShape["compareAndSet"] = (input) =>
    compareAndSetRow(input).pipe(
      Effect.map((rows) => rows.length === 1),
      Effect.mapError(
        toSqlOrDecodeError(
          "AgentControlOperationRepository.compareAndSet:query",
          "AgentControlOperationRepository.compareAndSet:encodeRequest",
        ),
      ),
    );

  return {
    insert,
    getById,
    getByProposalId,
    listRecoverable,
    compareAndSet,
  } satisfies AgentControlOperationRepositoryShape;
});

export const AgentControlOperationRepositoryLive = Layer.effect(
  AgentControlOperationRepository,
  makeAgentControlOperationRepository,
);
