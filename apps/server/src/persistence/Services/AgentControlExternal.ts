import {
  AGENT_CONTROL_EXTERNAL_CREDENTIAL_AUDIENCE,
  AgentControlExternalIntegration,
  AgentControlExternalTaskId,
  AgentControlIntegrationId,
  AgentControlPlanDigest,
  AgentControlProposalId,
  AgentControlRequestId,
  IsoDateTime,
  ProjectId,
  ProviderInstanceId,
  RuntimeMode,
  ThreadEnvMode,
  ThreadId,
  TrimmedNonEmptyString,
} from "@ryco/contracts";
import { Context, Schema } from "effect";
import type { Effect, Option } from "effect";

import type { AgentControlExternalRepositoryError } from "../Errors.ts";

export const AgentControlExternalSecretHash = Schema.String.check(
  Schema.isPattern(/^[a-f0-9]{64}$/),
);
export type AgentControlExternalSecretHash = typeof AgentControlExternalSecretHash.Type;

export const StoredAgentControlExternalIntegration = Schema.Struct({
  ...AgentControlExternalIntegration.fields,
  pairingCodeHash: Schema.NullOr(AgentControlExternalSecretHash),
  credentialAudience: Schema.NullOr(Schema.Literal(AGENT_CONTROL_EXTERNAL_CREDENTIAL_AUDIENCE)),
  credentialHash: Schema.NullOr(AgentControlExternalSecretHash),
});
export type StoredAgentControlExternalIntegration =
  typeof StoredAgentControlExternalIntegration.Type;

/** The columns an owner edits; never revocation, pairing, credential or usage state. */
export type AgentControlExternalIntegrationSettings = Pick<
  StoredAgentControlExternalIntegration,
  | "integrationId"
  | "displayName"
  | "clientKind"
  | "projectScope"
  | "capabilities"
  | "rateLimitPerMinute"
  | "activeTaskLimit"
  | "expiresAt"
  | "updatedAt"
>;

export const StoredAgentControlExternalTask = Schema.Struct({
  taskId: AgentControlExternalTaskId,
  integrationId: AgentControlIntegrationId,
  requestId: AgentControlRequestId,
  planDigest: AgentControlPlanDigest,
  proposalId: Schema.NullOr(AgentControlProposalId),
  projectId: ProjectId,
  providerInstanceId: ProviderInstanceId,
  environment: ThreadEnvMode,
  runtimeMode: RuntimeMode,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  releasedAt: Schema.NullOr(IsoDateTime),
});
export type StoredAgentControlExternalTask = typeof StoredAgentControlExternalTask.Type;

export const AgentControlExternalAuditRecord = Schema.Struct({
  auditId: TrimmedNonEmptyString,
  integrationId: AgentControlIntegrationId,
  tool: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  requestId: Schema.NullOr(AgentControlRequestId),
  projectId: Schema.NullOr(ProjectId),
  runtimeMode: Schema.NullOr(RuntimeMode),
  environment: Schema.NullOr(ThreadEnvMode),
  proposalId: Schema.NullOr(AgentControlProposalId),
  operationId: Schema.NullOr(TrimmedNonEmptyString.check(Schema.isMaxLength(128))),
  threadId: Schema.NullOr(ThreadId),
  outcome: TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
  createdAt: IsoDateTime,
});
export type AgentControlExternalAuditRecord = typeof AgentControlExternalAuditRecord.Type;

export interface AgentControlExternalRepositoryShape {
  readonly insertIntegration: (
    integration: StoredAgentControlExternalIntegration,
  ) => Effect.Effect<boolean, AgentControlExternalRepositoryError>;
  readonly getIntegration: (
    integrationId: AgentControlIntegrationId,
  ) => Effect.Effect<
    Option.Option<StoredAgentControlExternalIntegration>,
    AgentControlExternalRepositoryError
  >;
  readonly listIntegrations: () => Effect.Effect<
    ReadonlyArray<StoredAgentControlExternalIntegration>,
    AgentControlExternalRepositoryError
  >;
  // Each mutation of an existing integration writes only its own columns, guarded in SQL, so a
  // stale read can never write back a revocation, a credential, the task counter or last use.
  /** Writes the owner-editable columns, only while the active task count fits the new limit. */
  readonly updateIntegrationSettings: (
    settings: AgentControlExternalIntegrationSettings,
  ) => Effect.Effect<boolean, AgentControlExternalRepositoryError>;
  /** Drops the credential and issues a new pairing code, only while not revoked or expired. */
  readonly restartPairing: (input: {
    readonly integrationId: AgentControlIntegrationId;
    readonly pairingCodeHash: AgentControlExternalSecretHash;
    readonly pairingCodeExpiresAt: IsoDateTime;
    readonly now: IsoDateTime;
  }) => Effect.Effect<boolean, AgentControlExternalRepositoryError>;
  /** Revokes and drops all pairing and credential material, only while not yet revoked. */
  readonly revokeIntegration: (input: {
    readonly integrationId: AgentControlIntegrationId;
    readonly now: IsoDateTime;
  }) => Effect.Effect<boolean, AgentControlExternalRepositoryError>;
  /** Replaces the credential, only while not revoked or expired. */
  readonly rotateCredential: (input: {
    readonly integrationId: AgentControlIntegrationId;
    readonly credentialHash: AgentControlExternalSecretHash;
    readonly now: IsoDateTime;
  }) => Effect.Effect<boolean, AgentControlExternalRepositoryError>;
  readonly deleteIntegration: (
    integrationId: AgentControlIntegrationId,
  ) => Effect.Effect<boolean, AgentControlExternalRepositoryError>;
  readonly findByCredentialHash: (
    credentialHash: AgentControlExternalSecretHash,
  ) => Effect.Effect<
    Option.Option<StoredAgentControlExternalIntegration>,
    AgentControlExternalRepositoryError
  >;
  readonly exchangePairing: (input: {
    readonly integrationId: AgentControlIntegrationId;
    readonly pairingCodeHash: AgentControlExternalSecretHash;
    readonly credentialHash: AgentControlExternalSecretHash;
    readonly now: IsoDateTime;
  }) => Effect.Effect<boolean, AgentControlExternalRepositoryError>;
  readonly touchLastUsed: (input: {
    readonly integrationId: AgentControlIntegrationId;
    readonly now: IsoDateTime;
  }) => Effect.Effect<void, AgentControlExternalRepositoryError>;
  readonly reserveCapacity: (
    integrationId: AgentControlIntegrationId,
  ) => Effect.Effect<boolean, AgentControlExternalRepositoryError>;
  readonly insertTask: (
    task: StoredAgentControlExternalTask,
  ) => Effect.Effect<boolean, AgentControlExternalRepositoryError>;
  readonly attachTaskProposal: (input: {
    readonly taskId: AgentControlExternalTaskId;
    readonly proposalId: AgentControlProposalId;
    readonly updatedAt: IsoDateTime;
  }) => Effect.Effect<boolean, AgentControlExternalRepositoryError>;
  readonly getTask: (
    taskId: AgentControlExternalTaskId,
  ) => Effect.Effect<
    Option.Option<StoredAgentControlExternalTask>,
    AgentControlExternalRepositoryError
  >;
  readonly findTaskByRequest: (input: {
    readonly integrationId: AgentControlIntegrationId;
    readonly requestId: AgentControlRequestId;
  }) => Effect.Effect<
    Option.Option<StoredAgentControlExternalTask>,
    AgentControlExternalRepositoryError
  >;
  readonly findTaskByProposal: (
    proposalId: AgentControlProposalId,
  ) => Effect.Effect<
    Option.Option<StoredAgentControlExternalTask>,
    AgentControlExternalRepositoryError
  >;
  readonly listUnreleasedTasks: () => Effect.Effect<
    ReadonlyArray<StoredAgentControlExternalTask>,
    AgentControlExternalRepositoryError
  >;
  /** Winner-takes-once release plus integration capacity decrement in one transaction. */
  readonly releaseTask: (input: {
    readonly taskId: AgentControlExternalTaskId;
    readonly integrationId: AgentControlIntegrationId;
    readonly releasedAt: IsoDateTime;
  }) => Effect.Effect<boolean, AgentControlExternalRepositoryError>;
  /** Rebuild persisted counters from unreleased task rows after restart. */
  readonly reconcileCapacity: () => Effect.Effect<void, AgentControlExternalRepositoryError>;
  readonly insertAudit: (
    record: AgentControlExternalAuditRecord,
  ) => Effect.Effect<void, AgentControlExternalRepositoryError>;
  readonly countAuditSince: (input: {
    readonly integrationId: AgentControlIntegrationId;
    readonly since: IsoDateTime;
  }) => Effect.Effect<number, AgentControlExternalRepositoryError>;
  readonly pruneAudit: (input: {
    readonly integrationId: AgentControlIntegrationId;
    readonly before: IsoDateTime;
    readonly keepNewest: number;
  }) => Effect.Effect<void, AgentControlExternalRepositoryError>;
}

export class AgentControlExternalRepository extends Context.Service<
  AgentControlExternalRepository,
  AgentControlExternalRepositoryShape
>()("ryco/persistence/Services/AgentControlExternal/AgentControlExternalRepository") {}
