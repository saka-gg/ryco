import { isRoutineAgentControlAction } from "../routineActions.ts";
import {
  AGENT_CONTROL_ERROR_CODES,
  AGENT_CONTROL_PLAN_VERSION,
  AgentControlProposal,
  AgentControlProposalId,
  type AgentControlProposalStatus,
  type IsoDateTime,
} from "@ryco/contracts";
import { Effect, Layer, Option } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { toPersistenceSqlError } from "../../persistence/Errors.ts";
import {
  AGENT_CONTROL_AUDIT_EVENT_KINDS,
  type AgentControlAuditEventKind,
  AgentControlAuditId,
  type AgentControlAuditMetadata,
  AgentControlAuditRepository,
} from "../../persistence/Services/AgentControlAudit.ts";
import {
  type AgentControlPrincipalScope,
  AgentControlProposalRepository,
} from "../../persistence/Services/AgentControlProposals.ts";
import {
  AgentControlDuplicateRequestError,
  AgentControlInvalidTransitionError,
  AgentControlProposalExpiredError,
  AgentControlProposalNotFoundError,
} from "../Errors.ts";
import { agentControlPrincipalScope } from "../principal.ts";
import { computeAgentControlPlanDigest } from "../planDigest.ts";
import { AgentControlPolicy } from "../Services/AgentControlPolicy.ts";
import { AgentControlProposalEvents } from "../Services/AgentControlProposalEvents.ts";
import {
  AgentControlProposalStore,
  type AgentControlProposalStoreShape,
  type AgentControlProposalDecision,
  agentControlFailureResult,
} from "../Services/AgentControlProposalStore.ts";
import { proposalTransitionIssue, type AgentControlTransitionActor } from "../transitions.ts";

const DECISION_AUDIT_EVENT_KINDS: Record<AgentControlProposalDecision, AgentControlAuditEventKind> =
  {
    approved: AGENT_CONTROL_AUDIT_EVENT_KINDS.proposalApproved,
    rejected: AGENT_CONTROL_AUDIT_EVENT_KINDS.proposalRejected,
    cancelled: AGENT_CONTROL_AUDIT_EVENT_KINDS.proposalCancelled,
  };

const DECISION_ERROR_CODES = {
  rejected: AGENT_CONTROL_ERROR_CODES.rejected,
  cancelled: AGENT_CONTROL_ERROR_CODES.cancelled,
} as const;

/**
 * Bounded audit-safe metadata. Exact plans and results remain in the immutable
 * proposal row referenced by proposal id and digest; prompts, titles, paths,
 * credentials, and other unbounded plan content never enter audit rows.
 */
const auditMetadataForProposal = (proposal: AgentControlProposal): AgentControlAuditMetadata => {
  const planMetadata: AgentControlAuditMetadata = (() => {
    switch (proposal.plan.kind) {
      case "createProject":
        return { projectId: proposal.plan.projectId };
      case "updateProject":
        return {
          projectId: proposal.plan.projectId,
          expectedUpdatedAt: proposal.plan.before.updatedAt,
        };
      case "removeProject":
        return {
          projectId: proposal.plan.projectId,
          expectedUpdatedAt: proposal.plan.expected.updatedAt,
          force: String(proposal.plan.force),
          expectedThreadCount: String(proposal.plan.expectedThreadIds.length),
        };
      case "changeSettings":
        return {
          settingKind: proposal.plan.change.kind,
          before: String(proposal.plan.change.before),
          after: String(proposal.plan.change.after),
        };
      case "createAutomation":
        return {
          automationId: proposal.plan.automationId,
          projectId: proposal.plan.definition.execution.projectId,
          providerInstanceId: proposal.plan.definition.execution.modelSelection.instanceId,
          scheduleKind: proposal.plan.definition.schedule.kind,
          scheduleApprovalOnly: "true",
        };
      case "updateAutomation":
        return {
          automationId: proposal.plan.automationId,
          projectId: proposal.plan.after.execution.projectId,
          providerInstanceId: proposal.plan.after.execution.modelSelection.instanceId,
          expectedRevision: String(proposal.plan.before.revision),
          scheduleKind: proposal.plan.after.schedule.kind,
        };
      case "cancelAutomation":
        return {
          automationId: proposal.plan.automationId,
          projectId: proposal.plan.expected.definition.execution.projectId,
          providerInstanceId: proposal.plan.expected.definition.execution.modelSelection.instanceId,
          expectedRevision: String(proposal.plan.expected.revision),
          affectsAcceptedRun: "false",
        };
      case "automationRun":
        return {
          automationId: proposal.plan.automationId,
          automationRunId: proposal.plan.runId,
          projectId: proposal.plan.execution.projectId,
          providerInstanceId: proposal.plan.execution.modelSelection.instanceId,
          automationRevision: String(proposal.plan.automationRevision),
          scheduledFor: proposal.plan.scheduledFor,
          coalescedOccurrences: String(proposal.plan.coalescedOccurrences),
          schedulerOutcome:
            proposal.plan.coalescedOccurrences > 0 ? "missed-intervals-coalesced" : "on-time",
          recoverySafety: "idempotent-occurrence-and-request",
          freshRunApproval: "true",
        };
      case "deviceBoot":
      case "deviceAttach":
      case "deviceDetach":
      case "deviceInstall":
      case "deviceLaunch":
      case "deviceOpenUrl":
      case "deviceTap":
      case "deviceSwipe":
      case "devicePressButton":
      case "deviceStartRecording":
      case "deviceStopRecording":
      case "deviceShutdown":
        return {
          deviceUdid: proposal.plan.udid,
          projectId: proposal.plan.projectId,
          expectedProjectUpdatedAt: proposal.plan.expectedProjectUpdatedAt,
          providerInstanceId: proposal.plan.providerInstanceId,
          deviceThreadId: proposal.plan.threadId,
          expectedThreadDeviceVersion: String(proposal.plan.expectedThreadDeviceVersion),
          expectedDeviceState: proposal.plan.expectedDeviceState,
          expectedRecording: String(proposal.plan.expectedRecording),
          riskClass: proposal.plan.riskClass,
          sensitivePayloadsExcluded: "true",
        };
      default:
        return {};
    }
  })();
  return {
    requestId: proposal.requestId,
    actionKind: proposal.plan.kind,
    planDigest: proposal.planDigest,
    principalKind: proposal.principal.kind,
    expiresAt: proposal.expiresAt,
    ...planMetadata,
    ...(proposal.principal.kind === "provider-session"
      ? {
          threadId: proposal.principal.threadId,
          providerInstanceId: proposal.principal.providerInstanceId,
          ...(proposal.principal.runtimeSessionId === undefined
            ? {}
            : { runtimeSessionId: proposal.principal.runtimeSessionId }),
          ...(proposal.principal.turnId === undefined ? {} : { turnId: proposal.principal.turnId }),
          ...(proposal.principal.originProjectId === undefined
            ? {}
            : { originProjectId: proposal.principal.originProjectId }),
        }
      : {
          integrationId: proposal.principal.integrationId,
          ...(proposal.principal.projectId === undefined
            ? {}
            : { originProjectId: proposal.principal.projectId }),
        }),
  };
};

const makeAgentControlProposalStore = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const policy = yield* AgentControlPolicy;
  const proposals = yield* AgentControlProposalRepository;
  const audit = yield* AgentControlAuditRepository;
  const events = yield* AgentControlProposalEvents;

  /**
   * State changes and their audit rows must land atomically: without the
   * transaction, an audit failure after a committed compare-and-set would
   * leave a durable state change whose caller saw an error and whose audit
   * row can never be repaired (the table is append-only).
   */
  const atomically = <A, E>(operation: string, effect: Effect.Effect<A, E>) =>
    sql
      .withTransaction(effect)
      .pipe(
        Effect.catchTag("SqlError", (cause) =>
          Effect.fail(toPersistenceSqlError(operation)(cause)),
        ),
      );

  const appendAudit = (input: {
    readonly proposal: AgentControlProposal;
    readonly principalScope: AgentControlPrincipalScope;
    readonly eventKind: AgentControlAuditEventKind;
    readonly createdAt: IsoDateTime;
    readonly extraMetadata?: AgentControlAuditMetadata;
  }) =>
    audit.insert({
      auditId: AgentControlAuditId.make(crypto.randomUUID()),
      proposalId: input.proposal.proposalId,
      eventKind: input.eventKind,
      principalScope: input.principalScope,
      promptSummary: input.proposal.promptSummary,
      metadata: {
        ...auditMetadataForProposal(input.proposal),
        ...input.extraMetadata,
      },
      createdAt: input.createdAt,
    });

  const getOrNotFound = (proposalId: AgentControlProposalId) =>
    proposals.getById({ proposalId }).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(new AgentControlProposalNotFoundError({ proposalId })),
          onSome: Effect.succeed,
        }),
      ),
    );

  /**
   * Winner-takes-once transition: validate against the legal table, then
   * compare-and-set. A lost race re-reads and reports the actual state.
   */
  const transitionTo = (input: {
    readonly current: AgentControlProposal;
    readonly nextStatus: AgentControlProposalStatus;
    readonly actor: AgentControlTransitionActor;
    readonly decidedAt: IsoDateTime | null;
    readonly result: AgentControlProposal["result"];
    readonly eventKind: AgentControlAuditEventKind;
    readonly updatedAt: IsoDateTime;
  }) =>
    Effect.gen(function* () {
      const issue = proposalTransitionIssue({
        from: input.current.status,
        to: input.nextStatus,
        actor: input.actor,
      });
      if (issue !== null) {
        return yield* new AgentControlInvalidTransitionError({
          entity: "proposal",
          from: input.current.status,
          to: input.nextStatus,
          actor: input.actor,
          detail: issue,
        });
      }

      const updated: AgentControlProposal = {
        ...input.current,
        status: input.nextStatus,
        decidedAt: input.decidedAt,
        result: input.result,
        updatedAt: input.updatedAt,
      };
      const won = yield* atomically(
        "AgentControlProposalStore.transitionTo:transaction",
        Effect.gen(function* () {
          const won = yield* proposals.compareAndSetStatus({
            proposalId: input.current.proposalId,
            expectedStatus: input.current.status,
            nextStatus: input.nextStatus,
            decidedAt: input.decidedAt,
            result: input.result,
            updatedAt: input.updatedAt,
          });
          if (won) {
            yield* appendAudit({
              proposal: updated,
              principalScope: agentControlPrincipalScope(updated.principal),
              eventKind: input.eventKind,
              createdAt: input.updatedAt,
              ...(input.result === null
                ? {}
                : {
                    extraMetadata:
                      input.result.outcome === "completed"
                        ? {
                            outcome: input.result.outcome,
                            ...(input.result.execution === undefined
                              ? {}
                              : { operationId: input.result.execution.operationId }),
                          }
                        : {
                            outcome: input.result.outcome,
                            errorCode: input.result.error.code,
                            failureDetail: input.result.error.message.slice(0, 256),
                            ...(input.result.execution === undefined
                              ? {}
                              : { operationId: input.result.execution.operationId }),
                          },
                  }),
            });
          }
          return won;
        }),
      );
      if (!won) {
        const actual = yield* getOrNotFound(input.current.proposalId);
        return yield* new AgentControlInvalidTransitionError({
          entity: "proposal",
          from: actual.status,
          to: input.nextStatus,
          actor: input.actor,
          detail: `lost transition race; proposal is now ${actual.status}`,
        });
      }
      // Publish only after the transaction committed: a rolled-back state
      // change must never reach subscribers.
      yield* events.publish(updated);
      return updated;
    });

  /**
   * Expire one overdue proposal. `null` when a concurrent decision won the
   * race — the winner's state stands and there is nothing to expire.
   */
  const expireProposal = (proposal: AgentControlProposal, now: IsoDateTime) =>
    transitionTo({
      current: proposal,
      nextStatus: "expired",
      actor: "system",
      decidedAt: proposal.decidedAt,
      result: agentControlFailureResult({
        error: {
          code: AGENT_CONTROL_ERROR_CODES.expired,
          message: `Proposal expired at ${proposal.expiresAt}`,
          retryable: true,
        },
        failedAt: now,
      }),
      eventKind: AGENT_CONTROL_AUDIT_EVENT_KINDS.proposalExpired,
      updatedAt: now,
    }).pipe(
      Effect.catchTag("AgentControlInvalidTransitionError", () =>
        Effect.succeed<AgentControlProposal | null>(null),
      ),
    );

  /**
   * Expiry enforcement shared by decision and execution paths. Only states
   * that can legally expire (pending-user-approval, approved) are expired
   * in place and refused; an already-expired proposal is refused as
   * expired; every other state falls through so ordinary transition
   * validation reports the real conflict (e.g. "completed", not "expired").
   */
  const failIfExpired = (proposal: AgentControlProposal, now: IsoDateTime) =>
    Effect.gen(function* () {
      if (proposal.status === "expired") {
        return yield* new AgentControlProposalExpiredError({
          proposalId: proposal.proposalId,
          expiresAt: proposal.expiresAt,
        });
      }
      const canExpire =
        proposalTransitionIssue({ from: proposal.status, to: "expired", actor: "system" }) === null;
      if (!canExpire || now < proposal.expiresAt) {
        return;
      }
      yield* expireProposal(proposal, now);
      return yield* new AgentControlProposalExpiredError({
        proposalId: proposal.proposalId,
        expiresAt: proposal.expiresAt,
      });
    });

  const submit: AgentControlProposalStoreShape["submit"] = (input) =>
    Effect.gen(function* () {
      yield* policy.requireEnabled("AgentControlProposalStore.submit");

      const routine =
        input.authorizeRoutine === true && isRoutineAgentControlAction(input.principal, input.plan);
      const planDigest = computeAgentControlPlanDigest(input.plan);
      const principalScope = agentControlPrincipalScope(input.principal);
      const proposal: AgentControlProposal = {
        proposalId: AgentControlProposalId.make(crypto.randomUUID()),
        requestId: input.requestId,
        principal: input.principal,
        planVersion: AGENT_CONTROL_PLAN_VERSION,
        plan: input.plan,
        planDigest,
        riskTags: input.riskTags,
        promptSummary: input.promptSummary,
        status: routine ? "approved" : "pending-user-approval",
        createdAt: input.now,
        updatedAt: input.now,
        expiresAt: input.expiresAt,
        decidedAt: routine ? input.now : null,
        result: null,
      };

      const inserted = yield* atomically(
        "AgentControlProposalStore.submit:transaction",
        Effect.gen(function* () {
          const inserted = yield* proposals.insert({ proposal, principalScope });
          if (inserted) {
            yield* appendAudit({
              proposal,
              principalScope,
              extraMetadata: {
                authorization: routine ? "private-session-routine" : "user-approval-required",
              },
              eventKind: AGENT_CONTROL_AUDIT_EVENT_KINDS.proposalCreated,
              createdAt: input.now,
            });
          }
          return inserted;
        }),
      );
      if (inserted) {
        // After commit, mirroring transitionTo. An identical-request replay
        // below deliberately does not publish: no state changed.
        yield* events.publish(proposal);
        return { proposal, replayed: false };
      }

      const existing = yield* proposals.findByRequest({
        principalScope,
        requestId: input.requestId,
      });
      if (Option.isNone(existing)) {
        // The insert conflicted on something other than the request key
        // (a proposal-id collision). Surface it as a duplicate rather than
        // pretending a row exists.
        return yield* new AgentControlDuplicateRequestError({
          requestId: input.requestId,
          existingProposalId: null,
          requestedPlanDigest: planDigest,
          existingPlanDigest: null,
        });
      }
      if (existing.value.planDigest === planDigest) {
        return { proposal: existing.value, replayed: true };
      }

      yield* appendAudit({
        proposal: existing.value,
        principalScope,
        eventKind: AGENT_CONTROL_AUDIT_EVENT_KINDS.duplicateRequestRejected,
        createdAt: input.now,
        extraMetadata: { requestedPlanDigest: planDigest },
      });
      return yield* new AgentControlDuplicateRequestError({
        requestId: input.requestId,
        existingProposalId: existing.value.proposalId,
        requestedPlanDigest: planDigest,
        existingPlanDigest: existing.value.planDigest,
      });
    });

  const getById: AgentControlProposalStoreShape["getById"] = (proposalId) =>
    proposals.getById({ proposalId });

  const listPending: AgentControlProposalStoreShape["listPending"] = (input) =>
    proposals.listPending({ limit: input.limit });

  const listActive: AgentControlProposalStoreShape["listActive"] = (input) =>
    proposals.listActive({ limit: input.limit });

  const listRecent: AgentControlProposalStoreShape["listRecent"] = (input) =>
    proposals.listRecent({ limit: input.limit });

  const expireOverdue: AgentControlProposalStoreShape["expireOverdue"] = (input) =>
    Effect.gen(function* () {
      const overdue = yield* proposals.listOverdue({ now: input.now, limit: input.limit });
      const expired: AgentControlProposal[] = [];
      for (const proposal of overdue) {
        const result = yield* expireProposal(proposal, input.now);
        if (result !== null) {
          expired.push(result);
        }
      }
      return expired;
    });

  const decide: AgentControlProposalStoreShape["decide"] = (input) =>
    Effect.gen(function* () {
      yield* policy.requireEnabled("AgentControlProposalStore.decide");
      const current = yield* getOrNotFound(input.proposalId);
      yield* failIfExpired(current, input.decidedAt);

      const result =
        input.decision === "approved"
          ? null
          : agentControlFailureResult({
              error: {
                code: DECISION_ERROR_CODES[input.decision],
                message: `Proposal was ${input.decision}`,
                retryable: false,
              },
              failedAt: input.decidedAt,
            });
      return yield* transitionTo({
        current,
        nextStatus: input.decision,
        actor: input.actor,
        decidedAt: input.decidedAt,
        result,
        eventKind: DECISION_AUDIT_EVENT_KINDS[input.decision],
        updatedAt: input.decidedAt,
      });
    });

  const beginExecution: AgentControlProposalStoreShape["beginExecution"] = (input) =>
    Effect.gen(function* () {
      yield* policy.requireEnabled("AgentControlProposalStore.beginExecution");
      const current = yield* getOrNotFound(input.proposalId);
      yield* failIfExpired(current, input.now);

      return yield* transitionTo({
        current,
        nextStatus: "executing",
        actor: input.actor,
        decidedAt: current.decidedAt,
        result: null,
        eventKind: AGENT_CONTROL_AUDIT_EVENT_KINDS.proposalExecuting,
        updatedAt: input.now,
      });
    });

  const settleExecution: AgentControlProposalStoreShape["settleExecution"] = (input) =>
    Effect.gen(function* () {
      const current = yield* getOrNotFound(input.proposalId);
      const completed = input.result.outcome === "completed";
      return yield* transitionTo({
        current,
        nextStatus: completed ? "completed" : "failed",
        actor: "executor",
        decidedAt: current.decidedAt,
        result: input.result,
        eventKind: completed
          ? AGENT_CONTROL_AUDIT_EVENT_KINDS.proposalCompleted
          : AGENT_CONTROL_AUDIT_EVENT_KINDS.proposalFailed,
        updatedAt: input.now,
      });
    });

  return {
    submit,
    getById,
    listPending,
    listActive,
    listRecent,
    expireOverdue,
    decide,
    beginExecution,
    settleExecution,
  } satisfies AgentControlProposalStoreShape;
});

export const AgentControlProposalStoreLive = Layer.effect(
  AgentControlProposalStore,
  makeAgentControlProposalStore,
);
