import {
  AgentControlActionKind,
  AgentControlActionPlan,
  AgentControlPrincipal,
  AgentControlProposal,
  AgentControlProposalId,
  AgentControlResultEnvelope,
  AgentControlRiskTag,
} from "@ryco/contracts";
import { Effect, Layer, Schema, Struct } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";

import {
  toPersistenceDecodeError,
  toPersistenceSqlError,
  type AgentControlProposalRepositoryError,
} from "../Errors.ts";
import {
  AgentControlPrincipalScope,
  AgentControlProposalRepository,
  type AgentControlProposalRepositoryShape,
  CompareAndSetAgentControlProposalStatusInput,
  FindAgentControlProposalByRequestInput,
  GetAgentControlProposalInput,
  ListActiveAgentControlProposalsInput,
  ListOverdueAgentControlProposalsInput,
  ListPendingAgentControlProposalsInput,
  ListRecentAgentControlProposalsInput,
} from "../Services/AgentControlProposals.ts";

const AgentControlProposalDbRow = AgentControlProposal.mapFields(
  Struct.assign({
    principal: Schema.fromJsonString(AgentControlPrincipal),
    plan: Schema.fromJsonString(AgentControlActionPlan),
    riskTags: Schema.fromJsonString(Schema.Array(AgentControlRiskTag)),
    result: Schema.NullOr(Schema.fromJsonString(AgentControlResultEnvelope)),
  }),
);

const InsertAgentControlProposalDbInput = Schema.Struct({
  proposal: AgentControlProposalDbRow,
  principalScope: AgentControlPrincipalScope,
  actionKind: AgentControlActionKind,
});

const CompareAndSetAgentControlProposalDbInput =
  CompareAndSetAgentControlProposalStatusInput.mapFields(
    Struct.assign({
      result: Schema.NullOr(Schema.fromJsonString(AgentControlResultEnvelope)),
    }),
  );

const ProposalIdResult = Schema.Struct({ proposalId: AgentControlProposalId });

function toSqlOrDecodeError(sqlOperation: string, decodeOperation: string) {
  return (cause: unknown): AgentControlProposalRepositoryError =>
    Schema.isSchemaError(cause)
      ? toPersistenceDecodeError(decodeOperation)(cause)
      : toPersistenceSqlError(sqlOperation)(cause);
}

const makeAgentControlProposalRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const insertRow = SqlSchema.findAll({
    Request: InsertAgentControlProposalDbInput,
    Result: ProposalIdResult,
    execute: ({ proposal, principalScope, actionKind }) => sql`
      INSERT INTO agent_control_proposals (
        proposal_id,
        request_id,
        principal_scope,
        principal_json,
        action_kind,
        plan_version,
        plan_json,
        plan_digest,
        risk_tags_json,
        prompt_summary,
        status,
        created_at,
        updated_at,
        expires_at,
        decided_at,
        result_json
      ) VALUES (
        ${proposal.proposalId},
        ${proposal.requestId},
        ${principalScope},
        ${proposal.principal},
        ${actionKind},
        ${proposal.planVersion},
        ${proposal.plan},
        ${proposal.planDigest},
        ${proposal.riskTags},
        ${proposal.promptSummary},
        ${proposal.status},
        ${proposal.createdAt},
        ${proposal.updatedAt},
        ${proposal.expiresAt},
        ${proposal.decidedAt},
        ${proposal.result}
      )
      ON CONFLICT DO NOTHING
      RETURNING proposal_id AS "proposalId"
    `,
  });

  const getRow = SqlSchema.findOneOption({
    Request: GetAgentControlProposalInput,
    Result: AgentControlProposalDbRow,
    execute: ({ proposalId }) => sql`
      SELECT
        proposal_id AS "proposalId",
        request_id AS "requestId",
        principal_json AS "principal",
        plan_version AS "planVersion",
        plan_json AS "plan",
        plan_digest AS "planDigest",
        risk_tags_json AS "riskTags",
        prompt_summary AS "promptSummary",
        status,
        created_at AS "createdAt",
        updated_at AS "updatedAt",
        expires_at AS "expiresAt",
        decided_at AS "decidedAt",
        result_json AS "result"
      FROM agent_control_proposals
      WHERE proposal_id = ${proposalId}
      LIMIT 1
    `,
  });

  const findRowByRequest = SqlSchema.findOneOption({
    Request: FindAgentControlProposalByRequestInput,
    Result: AgentControlProposalDbRow,
    execute: ({ principalScope, requestId }) => sql`
      SELECT
        proposal_id AS "proposalId",
        request_id AS "requestId",
        principal_json AS "principal",
        plan_version AS "planVersion",
        plan_json AS "plan",
        plan_digest AS "planDigest",
        risk_tags_json AS "riskTags",
        prompt_summary AS "promptSummary",
        status,
        created_at AS "createdAt",
        updated_at AS "updatedAt",
        expires_at AS "expiresAt",
        decided_at AS "decidedAt",
        result_json AS "result"
      FROM agent_control_proposals
      WHERE principal_scope = ${principalScope}
        AND request_id = ${requestId}
      LIMIT 1
    `,
  });

  const listPendingRows = SqlSchema.findAll({
    Request: ListPendingAgentControlProposalsInput,
    Result: AgentControlProposalDbRow,
    execute: ({ limit }) => sql`
      SELECT
        proposal_id AS "proposalId",
        request_id AS "requestId",
        principal_json AS "principal",
        plan_version AS "planVersion",
        plan_json AS "plan",
        plan_digest AS "planDigest",
        risk_tags_json AS "riskTags",
        prompt_summary AS "promptSummary",
        status,
        created_at AS "createdAt",
        updated_at AS "updatedAt",
        expires_at AS "expiresAt",
        decided_at AS "decidedAt",
        result_json AS "result"
      FROM agent_control_proposals
      WHERE status = 'pending-user-approval'
      ORDER BY created_at ASC, proposal_id ASC
      LIMIT ${limit}
    `,
  });

  const listActiveRows = SqlSchema.findAll({
    Request: ListActiveAgentControlProposalsInput,
    Result: AgentControlProposalDbRow,
    execute: ({ limit }) => sql`
      SELECT
        proposal_id AS "proposalId",
        request_id AS "requestId",
        principal_json AS "principal",
        plan_version AS "planVersion",
        plan_json AS "plan",
        plan_digest AS "planDigest",
        risk_tags_json AS "riskTags",
        prompt_summary AS "promptSummary",
        status,
        created_at AS "createdAt",
        updated_at AS "updatedAt",
        expires_at AS "expiresAt",
        decided_at AS "decidedAt",
        result_json AS "result"
      FROM agent_control_proposals
      WHERE status IN ('pending-user-approval', 'approved', 'executing')
      ORDER BY created_at ASC, proposal_id ASC
      LIMIT ${limit}
    `,
  });

  const listRecentRows = SqlSchema.findAll({
    Request: ListRecentAgentControlProposalsInput,
    Result: AgentControlProposalDbRow,
    execute: ({ limit }) => sql`
      SELECT
        proposal_id AS "proposalId",
        request_id AS "requestId",
        principal_json AS "principal",
        plan_version AS "planVersion",
        plan_json AS "plan",
        plan_digest AS "planDigest",
        risk_tags_json AS "riskTags",
        prompt_summary AS "promptSummary",
        status,
        created_at AS "createdAt",
        updated_at AS "updatedAt",
        expires_at AS "expiresAt",
        decided_at AS "decidedAt",
        result_json AS "result"
      FROM agent_control_proposals
      WHERE status IN ('rejected', 'expired', 'completed', 'failed', 'cancelled')
      ORDER BY updated_at DESC, proposal_id DESC
      LIMIT ${limit}
    `,
  });

  const listOverdueRows = SqlSchema.findAll({
    Request: ListOverdueAgentControlProposalsInput,
    Result: AgentControlProposalDbRow,
    execute: ({ now, limit }) => sql`
      SELECT
        proposal_id AS "proposalId",
        request_id AS "requestId",
        principal_json AS "principal",
        plan_version AS "planVersion",
        plan_json AS "plan",
        plan_digest AS "planDigest",
        risk_tags_json AS "riskTags",
        prompt_summary AS "promptSummary",
        status,
        created_at AS "createdAt",
        updated_at AS "updatedAt",
        expires_at AS "expiresAt",
        decided_at AS "decidedAt",
        result_json AS "result"
      FROM agent_control_proposals
      WHERE status IN ('pending-user-approval', 'approved')
        AND expires_at <= ${now}
      ORDER BY expires_at ASC, proposal_id ASC
      LIMIT ${limit}
    `,
  });

  const compareAndSetRow = SqlSchema.findAll({
    Request: CompareAndSetAgentControlProposalDbInput,
    Result: ProposalIdResult,
    execute: (input) => sql`
      UPDATE agent_control_proposals
      SET status = ${input.nextStatus},
          decided_at = ${input.decidedAt},
          result_json = ${input.result},
          updated_at = ${input.updatedAt}
      WHERE proposal_id = ${input.proposalId}
        AND status = ${input.expectedStatus}
      RETURNING proposal_id AS "proposalId"
    `,
  });

  const insert: AgentControlProposalRepositoryShape["insert"] = (input) =>
    insertRow({
      proposal: input.proposal,
      principalScope: input.principalScope,
      actionKind: input.proposal.plan.kind,
    }).pipe(
      Effect.map((rows) => rows.length === 1),
      Effect.mapError(
        toSqlOrDecodeError(
          "AgentControlProposalRepository.insert:query",
          "AgentControlProposalRepository.insert:encodeRequest",
        ),
      ),
    );

  const getById: AgentControlProposalRepositoryShape["getById"] = (input) =>
    getRow(input).pipe(
      Effect.mapError(
        toSqlOrDecodeError(
          "AgentControlProposalRepository.getById:query",
          "AgentControlProposalRepository.getById:decodeRow",
        ),
      ),
    );

  const findByRequest: AgentControlProposalRepositoryShape["findByRequest"] = (input) =>
    findRowByRequest(input).pipe(
      Effect.mapError(
        toSqlOrDecodeError(
          "AgentControlProposalRepository.findByRequest:query",
          "AgentControlProposalRepository.findByRequest:decodeRow",
        ),
      ),
    );

  const listPending: AgentControlProposalRepositoryShape["listPending"] = (input) =>
    listPendingRows(input).pipe(
      Effect.mapError(
        toSqlOrDecodeError(
          "AgentControlProposalRepository.listPending:query",
          "AgentControlProposalRepository.listPending:decodeRows",
        ),
      ),
    );

  const listActive: AgentControlProposalRepositoryShape["listActive"] = (input) =>
    listActiveRows(input).pipe(
      Effect.mapError(
        toSqlOrDecodeError(
          "AgentControlProposalRepository.listActive:query",
          "AgentControlProposalRepository.listActive:decodeRows",
        ),
      ),
    );

  const listRecent: AgentControlProposalRepositoryShape["listRecent"] = (input) =>
    listRecentRows(input).pipe(
      Effect.mapError(
        toSqlOrDecodeError(
          "AgentControlProposalRepository.listRecent:query",
          "AgentControlProposalRepository.listRecent:decodeRows",
        ),
      ),
    );

  const listOverdue: AgentControlProposalRepositoryShape["listOverdue"] = (input) =>
    listOverdueRows(input).pipe(
      Effect.mapError(
        toSqlOrDecodeError(
          "AgentControlProposalRepository.listOverdue:query",
          "AgentControlProposalRepository.listOverdue:decodeRows",
        ),
      ),
    );

  const compareAndSetStatus: AgentControlProposalRepositoryShape["compareAndSetStatus"] = (input) =>
    compareAndSetRow(input).pipe(
      Effect.map((rows) => rows.length === 1),
      Effect.mapError(
        toSqlOrDecodeError(
          "AgentControlProposalRepository.compareAndSetStatus:query",
          "AgentControlProposalRepository.compareAndSetStatus:encodeRequest",
        ),
      ),
    );

  return {
    insert,
    getById,
    findByRequest,
    listPending,
    listActive,
    listRecent,
    listOverdue,
    compareAndSetStatus,
  } satisfies AgentControlProposalRepositoryShape;
});

export const AgentControlProposalRepositoryLive = Layer.effect(
  AgentControlProposalRepository,
  makeAgentControlProposalRepository,
);
