import type {
  AgentControlAutomation,
  AgentControlAutomationId,
  AgentControlAutomationRun,
  AgentControlAutomationRunId,
  AgentControlAutomationRunStatus,
  AgentControlProposalId,
  IsoDateTime,
  ProjectId,
  ProviderInstanceId,
} from "@ryco/contracts";
import { Context } from "effect";
import type { Effect, Option } from "effect";

import type { AgentControlAutomationRepositoryError } from "../Errors.ts";

export interface ClaimedAgentControlAutomationRun {
  readonly automation: AgentControlAutomation;
  readonly run: AgentControlAutomationRun;
}

export interface AgentControlAutomationRepositoryShape {
  readonly activeProposalIds: () => Effect.Effect<
    ReadonlyArray<AgentControlProposalId>,
    AgentControlAutomationRepositoryError
  >;
  readonly quarantineRecord: (input: {
    readonly kind: "proposal" | "run";
    readonly id: string;
    readonly projectId: ProjectId;
  }) => Effect.Effect<void, AgentControlAutomationRepositoryError>;
  readonly listProjectRuns: (
    projectId: ProjectId,
  ) => Effect.Effect<
    ReadonlyArray<AgentControlAutomationRun>,
    AgentControlAutomationRepositoryError
  >;
  readonly centreMetadata: (projectId: ProjectId) => Effect.Effect<
    {
      readonly unavailableRecords: number;
      readonly runs: ReadonlyArray<{
        readonly runId: string;
        readonly readUpdatedAt: string | null;
        readonly retryOfRunId: string | null;
      }>;
    },
    AgentControlAutomationRepositoryError
  >;
  readonly markRead: (input: {
    readonly runId: AgentControlAutomationRunId;
    readonly expectedUpdatedAt: string;
    readonly unread: boolean;
  }) => Effect.Effect<boolean, AgentControlAutomationRepositoryError>;
  readonly retryRun: (input: {
    readonly runId: AgentControlAutomationRunId;
    readonly source: AgentControlAutomationRun;
    readonly now: IsoDateTime;
  }) => Effect.Effect<boolean, AgentControlAutomationRepositoryError>;

  readonly insertAutomation: (
    automation: AgentControlAutomation,
  ) => Effect.Effect<boolean, AgentControlAutomationRepositoryError>;
  readonly getAutomation: (
    automationId: AgentControlAutomationId,
  ) => Effect.Effect<Option.Option<AgentControlAutomation>, AgentControlAutomationRepositoryError>;
  readonly listAutomations: (input: {
    readonly projectId: ProjectId;
    readonly providerInstanceId?: ProviderInstanceId;
    readonly includeDisabled: boolean;
    readonly limit: number;
  }) => Effect.Effect<ReadonlyArray<AgentControlAutomation>, AgentControlAutomationRepositoryError>;
  readonly countActiveAutomations: (
    projectId: ProjectId,
  ) => Effect.Effect<number, AgentControlAutomationRepositoryError>;
  readonly replaceAutomation: (input: {
    readonly automation: AgentControlAutomation;
    readonly expectedRevision: number;
    readonly expectedCancelled: boolean;
  }) => Effect.Effect<boolean, AgentControlAutomationRepositoryError>;
  readonly claimDue: (input: {
    readonly now: IsoDateTime;
    readonly limit: number;
  }) => Effect.Effect<
    ReadonlyArray<ClaimedAgentControlAutomationRun>,
    AgentControlAutomationRepositoryError
  >;
  readonly attachProposal: (input: {
    readonly runId: AgentControlAutomationRunId;
    readonly proposalId: AgentControlProposalId;
    readonly updatedAt: IsoDateTime;
  }) => Effect.Effect<boolean, AgentControlAutomationRepositoryError>;
  readonly getRun: (
    runId: AgentControlAutomationRunId,
  ) => Effect.Effect<
    Option.Option<AgentControlAutomationRun>,
    AgentControlAutomationRepositoryError
  >;
  readonly findRunByProposal: (
    proposalId: AgentControlProposalId,
  ) => Effect.Effect<
    Option.Option<AgentControlAutomationRun>,
    AgentControlAutomationRepositoryError
  >;
  readonly listRuns: (input: {
    readonly automationId: AgentControlAutomationId;
    readonly limit: number;
  }) => Effect.Effect<
    ReadonlyArray<AgentControlAutomationRun>,
    AgentControlAutomationRepositoryError
  >;
  readonly listRecoverableRuns: (input: {
    readonly limit: number;
  }) => Effect.Effect<
    ReadonlyArray<AgentControlAutomationRun>,
    AgentControlAutomationRepositoryError
  >;
  readonly transitionRun: (input: {
    readonly runId: AgentControlAutomationRunId;
    readonly expectedStatuses: ReadonlyArray<AgentControlAutomationRunStatus>;
    readonly status: AgentControlAutomationRunStatus;
    readonly proposalId: AgentControlProposalId | null;
    readonly safeFailureDetail: string | null;
    readonly updatedAt: IsoDateTime;
    readonly completedAt: IsoDateTime | null;
  }) => Effect.Effect<boolean, AgentControlAutomationRepositoryError>;
  readonly pruneRuns: (input: {
    readonly automationId: AgentControlAutomationId;
    readonly keepNewest: number;
  }) => Effect.Effect<void, AgentControlAutomationRepositoryError>;
}

export class AgentControlAutomationRepository extends Context.Service<
  AgentControlAutomationRepository,
  AgentControlAutomationRepositoryShape
>()("ryco/persistence/Services/AgentControlAutomations/AgentControlAutomationRepository") {}
