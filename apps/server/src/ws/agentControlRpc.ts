import {
  AGENT_CONTROL_LEGACY_PLAN_KINDS,
  AGENT_CONTROL_WS_METHODS,
  AgentControlProposalStatus,
  AgentControlRpcError,
  AgentControlExternalRpcError,
  type AgentControlPlanViewMode,
  type AgentControlProposal,
  type AgentControlProposalQueue,
  type AgentControlProposalStreamEvent,
} from "@ryco/contracts";
import { Effect, Option, Schema, Stream } from "effect";

import type { AgentControlNodeDirectoryError } from "../agentControl/Errors.ts";
import { isAgentControlClientExecutedKind } from "../agentControl/projectCopyControl.ts";
import type { AgentControlClientExecutionFailure } from "../agentControl/Services/AgentControlExecution.ts";
import {
  toAgentControlProposalReceipt,
  type AgentControlProposalDecisionError,
} from "../agentControl/Services/AgentControlProposalService.ts";
import type { AgentControlExternalIntegrationServiceError } from "../agentControl/Services/AgentControlExternalIntegration.ts";
import type { AgentControlExternalInstallationServiceError } from "../agentControl/Services/AgentControlExternalInstallation.ts";
import { observeRpcEffect, observeRpcStreamEffect } from "../observability/RpcInstrumentation.ts";
import { defineWsHandlers, type WsRpcContext } from "./context.ts";

const isProposalStatus = Schema.is(AgentControlProposalStatus);

const LEGACY_PLAN_KINDS: ReadonlySet<string> = new Set(AGENT_CONTROL_LEGACY_PLAN_KINDS);

/**
 * Whether a proposal reaches a client that asked for `planView`. Clients without
 * `planView: "tolerant"` decode the closed plan union of the build they shipped
 * in: one proposal of a kind they do not know fails their whole stream, and
 * they then clear the environment's approval queue. They only ever see the
 * kinds in `AGENT_CONTROL_LEGACY_PLAN_KINDS`; the others wait for a newer client.
 */
export const isProposalInPlanView = (
  proposal: AgentControlProposal,
  planView: AgentControlPlanViewMode | undefined,
): boolean => planView === "tolerant" || LEGACY_PLAN_KINDS.has(proposal.plan.kind);

/** The queue with the proposals outside `planView` left out; the same queue when none are. */
export const proposalQueueInPlanView = (
  queue: AgentControlProposalQueue,
  planView: AgentControlPlanViewMode | undefined,
): AgentControlProposalQueue => {
  if (planView === "tolerant") return queue;
  const visible = (proposal: AgentControlProposal) => isProposalInPlanView(proposal, planView);
  if (queue.active.every(visible) && queue.recent.every(visible)) return queue;
  return { ...queue, active: queue.active.filter(visible), recent: queue.recent.filter(visible) };
};

/** A stream event as `planView` sees it; null for a proposal event it never sees. */
export const proposalStreamEventInPlanView = (
  event: AgentControlProposalStreamEvent,
  planView: AgentControlPlanViewMode | undefined,
): AgentControlProposalStreamEvent | null => {
  if (event.type === "proposal") {
    return isProposalInPlanView(event.proposal, planView) ? event : null;
  }
  const queue = proposalQueueInPlanView(event.queue, planView);
  return queue === event.queue ? event : { ...event, queue };
};

/**
 * Map internal lifecycle failures onto the bounded RPC error. A decision
 * conflict names the proposal's actual status so the client can render
 * "already approved elsewhere"; nothing else about the resource — plans,
 * prompts, storage details — crosses this boundary.
 */
export const toAgentControlRpcError = (
  error: AgentControlProposalDecisionError | AgentControlClientExecutionFailure,
): AgentControlRpcError => {
  switch (error._tag) {
    case "AgentControlClientExecutionError":
      return new AgentControlRpcError({
        code:
          error.reason === "executor-required" || error.reason === "not-client-executed"
            ? "unsupported"
            : "conflict",
        message: error.detail,
        ...(error.status !== undefined && isProposalStatus(error.status)
          ? { status: error.status }
          : {}),
      });
    case "AgentControlDisabledError":
      return new AgentControlRpcError({
        code: "disabled",
        message: "Agent Control is disabled.",
      });
    case "AgentControlProposalNotFoundError":
      return new AgentControlRpcError({
        code: "not-found",
        message: "Agent Control proposal was not found.",
      });
    case "AgentControlProposalExpiredError":
      return new AgentControlRpcError({
        code: "expired",
        message: "Proposal expired before the decision could apply.",
        status: "expired",
      });
    case "AgentControlInvalidTransitionError":
      return new AgentControlRpcError({
        code: "conflict",
        message: "Decision no longer applies to the proposal's current state.",
        ...(error.entity === "proposal" && isProposalStatus(error.from)
          ? { status: error.from }
          : {}),
      });
    case "AgentControlDuplicateRequestError":
      return new AgentControlRpcError({
        code: "conflict",
        message: "Request id was already used with a different plan.",
      });
    case "AgentControlSettingsChangeUnsupportedError":
      return new AgentControlRpcError({
        code: "unsupported",
        message: error.detail,
      });
    default:
      return new AgentControlRpcError({
        code: "storage",
        message: "Agent Control storage failed.",
      });
  }
};

export const toAgentControlNodeDirectoryRpcError = (
  error: AgentControlNodeDirectoryError,
): AgentControlRpcError =>
  error.reason === "unavailable"
    ? new AgentControlRpcError({
        code: "unsupported",
        message: "This server does not keep a node directory yet.",
      })
    : new AgentControlRpcError({
        code: "storage",
        message: "The node directory could not be stored.",
      });

export const toAgentControlExternalRpcError = (
  error: AgentControlExternalIntegrationServiceError,
): AgentControlExternalRpcError => {
  if (error._tag === "AgentControlDisabledError") {
    return new AgentControlExternalRpcError({
      code: "disabled",
      message: "Agent Control is disabled.",
    });
  }
  if (error._tag === "AgentControlExternalIntegrationError") {
    switch (error.reason) {
      case "topology-unavailable":
        return new AgentControlExternalRpcError({
          code: "topology",
          message:
            "External integrations require a loopback-only Ryco without Hub or remote exposure.",
        });
      case "not-found":
        return new AgentControlExternalRpcError({
          code: "not-found",
          message: "Integration was not found.",
        });
      case "capacity-exhausted":
      case "task-conflict":
        return new AgentControlExternalRpcError({
          code: "conflict",
          message: "Integration update conflicts with active work.",
        });
      default:
        return new AgentControlExternalRpcError({
          code: "invalid",
          message: "Integration request was refused.",
        });
    }
  }
  return new AgentControlExternalRpcError({
    code: "storage",
    message: "Integration storage failed.",
  });
};

export const toAgentControlInstallationRpcError = (
  error: AgentControlExternalInstallationServiceError,
): AgentControlExternalRpcError => {
  if (error._tag === "AgentControlMcpInstallationError") {
    switch (error.reason) {
      case "not-found":
        return new AgentControlExternalRpcError({
          code: "not-found",
          message: "Agent Control installation was not found.",
        });
      case "conflict":
        return new AgentControlExternalRpcError({ code: "conflict", message: error.detail });
      case "unsupported":
        return new AgentControlExternalRpcError({ code: "invalid", message: error.detail });
      default:
        return new AgentControlExternalRpcError({
          code: "invalid",
          message: "Agent Control installation did not complete.",
        });
    }
  }
  if (error._tag === "McpSettingsError") {
    return new AgentControlExternalRpcError({
      code: "invalid",
      message: "The provider MCP configuration could not be updated safely.",
    });
  }
  return new AgentControlExternalRpcError({
    code: "storage",
    message: "Agent Control installation storage failed.",
  });
};

export const makeAgentControlHandlers = (ctx: WsRpcContext) => {
  const {
    agentControlProposals,
    agentControlExternalIntegrations,
    agentControlExternalInstallations,
    agentControlNodeDirectory,
    agentControlExecution,
    currentSessionId,
    ownerEffect,
    ownerStreamEffect,
  } = ctx;

  const withExecution = <A, E>(
    use: (
      execution: Option.Option.Value<typeof agentControlExecution>,
    ) => Effect.Effect<A, E | AgentControlRpcError>,
  ) =>
    Option.match(agentControlExecution, {
      onNone: () =>
        Effect.fail(
          new AgentControlRpcError({
            code: "unsupported",
            message: "This server does not run client-executed requests.",
          }),
        ),
      onSome: use,
    });

  const withService = <A, E>(
    use: (
      service: Option.Option.Value<typeof agentControlProposals>,
    ) => Effect.Effect<A, E | AgentControlRpcError>,
  ) =>
    Option.match(agentControlProposals, {
      onNone: () =>
        Effect.fail(
          new AgentControlRpcError({
            code: "storage",
            message: "Agent Control is unavailable.",
          }),
        ),
      onSome: use,
    });

  const withExternalService = <A, E>(
    use: (
      service: Option.Option.Value<typeof agentControlExternalIntegrations>,
    ) => Effect.Effect<A, E | AgentControlExternalRpcError>,
  ) =>
    Option.match(agentControlExternalIntegrations, {
      onNone: () =>
        Effect.fail(
          new AgentControlExternalRpcError({
            code: "storage",
            message: "External integrations are unavailable.",
          }),
        ),
      onSome: use,
    });

  const withInstallationService = <A, E>(
    use: (
      service: Option.Option.Value<typeof agentControlExternalInstallations>,
    ) => Effect.Effect<A, E | AgentControlExternalRpcError>,
  ) =>
    Option.match(agentControlExternalInstallations, {
      onNone: () =>
        Effect.fail(
          new AgentControlExternalRpcError({
            code: "storage",
            message: "Agent Control installation is unavailable.",
          }),
        ),
      onSome: use,
    });

  return defineWsHandlers({
    // The proposal reads leave out every proposal outside the client's `planView`
    // (`isProposalInPlanView`); clients that decode the tolerant plan view send "tolerant".
    [AGENT_CONTROL_WS_METHODS.listProposals]: (input) =>
      observeRpcEffect(
        AGENT_CONTROL_WS_METHODS.listProposals,
        ownerEffect(
          AGENT_CONTROL_WS_METHODS.listProposals,
          withService((service) =>
            service
              .getQueue({ activeLimit: input.activeLimit, recentLimit: input.recentLimit })
              .pipe(
                Effect.map((queue) => proposalQueueInPlanView(queue, input.planView)),
                Effect.mapError(toAgentControlRpcError),
              ),
          ),
        ),
        { "rpc.aggregate": "agent-control", "rpc.operation": "list" },
      ),
    [AGENT_CONTROL_WS_METHODS.getProposal]: (input) =>
      observeRpcEffect(
        AGENT_CONTROL_WS_METHODS.getProposal,
        ownerEffect(
          AGENT_CONTROL_WS_METHODS.getProposal,
          withService((service) =>
            service.getProposal(input.proposalId).pipe(
              Effect.map((found) => ({
                proposal: Option.getOrNull(
                  Option.filter(found, (proposal) =>
                    isProposalInPlanView(proposal, input.planView),
                  ),
                ),
              })),
              Effect.mapError(toAgentControlRpcError),
            ),
          ),
        ),
        { "rpc.aggregate": "agent-control", "rpc.operation": "get" },
      ),
    [AGENT_CONTROL_WS_METHODS.acceptProposal]: (input) =>
      observeRpcEffect(
        AGENT_CONTROL_WS_METHODS.acceptProposal,
        ownerEffect(
          AGENT_CONTROL_WS_METHODS.acceptProposal,
          withService((service) =>
            service
              .accept({
                proposalId: input.proposalId,
                decidedAt: new Date().toISOString(),
                executeOnClient: input.executeOnClient,
              })
              .pipe(
                Effect.mapError(toAgentControlRpcError),
                // A client-executed kind is bound to this client's executor in the same request
                // (A1): approved, then executing with the binding, or the current state again.
                Effect.flatMap((receipt) => {
                  const executeOnClient = input.executeOnClient;
                  return executeOnClient === undefined ||
                    !isAgentControlClientExecutedKind(receipt.actionKind)
                    ? Effect.succeed(receipt)
                    : withExecution((execution) =>
                        execution
                          .beginClientExecution({
                            proposalId: input.proposalId,
                            executorId: executeOnClient.executorId,
                          })
                          .pipe(
                            Effect.map(toAgentControlProposalReceipt),
                            Effect.mapError(toAgentControlRpcError),
                          ),
                      );
                }),
              ),
          ),
        ),
        { "rpc.aggregate": "agent-control", "rpc.operation": "accept" },
      ),
    [AGENT_CONTROL_WS_METHODS.rejectProposal]: (input) =>
      observeRpcEffect(
        AGENT_CONTROL_WS_METHODS.rejectProposal,
        ownerEffect(
          AGENT_CONTROL_WS_METHODS.rejectProposal,
          withService((service) =>
            service
              .reject({ proposalId: input.proposalId, decidedAt: new Date().toISOString() })
              .pipe(Effect.mapError(toAgentControlRpcError)),
          ),
        ),
        { "rpc.aggregate": "agent-control", "rpc.operation": "reject" },
      ),
    [AGENT_CONTROL_WS_METHODS.subscribeProposals]: (input) =>
      observeRpcStreamEffect(
        AGENT_CONTROL_WS_METHODS.subscribeProposals,
        ownerStreamEffect(
          AGENT_CONTROL_WS_METHODS.subscribeProposals,
          withService((service) =>
            Effect.succeed(
              service.subscribeQueue({}).pipe(
                Stream.map((event) => proposalStreamEventInPlanView(event, input.planView)),
                Stream.filter((event) => event !== null),
                Stream.mapError(toAgentControlRpcError),
              ),
            ),
          ),
        ),
        { "rpc.aggregate": "agent-control" },
      ),
    // Owner clients publish the nodes they hold owner on, keyed by their session: a direct
    // session's id, or a relay channel's scope, which changes with every reconnect (the directory
    // bounds how many publishers it keeps).
    [AGENT_CONTROL_WS_METHODS.publishNodeDirectory]: (input) =>
      observeRpcEffect(
        AGENT_CONTROL_WS_METHODS.publishNodeDirectory,
        ownerEffect(
          AGENT_CONTROL_WS_METHODS.publishNodeDirectory,
          Option.match(agentControlNodeDirectory, {
            onNone: () =>
              Effect.fail(
                new AgentControlRpcError({
                  code: "unsupported",
                  message: "This server does not keep a node directory yet.",
                }),
              ),
            onSome: (directory) =>
              directory
                .publish({ publisherKey: currentSessionId, nodes: input.nodes })
                .pipe(Effect.mapError(toAgentControlNodeDirectoryRpcError)),
          }),
        ),
        { "rpc.aggregate": "agent-control", "rpc.operation": "publish-node-directory" },
      ),
    // The approving client's outcome; only the executor the proposal was accepted with counts.
    [AGENT_CONTROL_WS_METHODS.reportClientExecution]: (input) =>
      observeRpcEffect(
        AGENT_CONTROL_WS_METHODS.reportClientExecution,
        ownerEffect(
          AGENT_CONTROL_WS_METHODS.reportClientExecution,
          withExecution((execution) =>
            execution
              .reportClientExecution(input)
              .pipe(
                Effect.map(toAgentControlProposalReceipt),
                Effect.mapError(toAgentControlRpcError),
              ),
          ),
        ),
        { "rpc.aggregate": "agent-control", "rpc.operation": "report-client-execution" },
      ),
    [AGENT_CONTROL_WS_METHODS.listIntegrations]: () =>
      ownerEffect(
        AGENT_CONTROL_WS_METHODS.listIntegrations,
        withExternalService((service) =>
          service.list().pipe(Effect.mapError(toAgentControlExternalRpcError)),
        ),
      ),
    [AGENT_CONTROL_WS_METHODS.createIntegration]: (input) =>
      ownerEffect(
        AGENT_CONTROL_WS_METHODS.createIntegration,
        withExternalService((service) =>
          service.create(input).pipe(Effect.mapError(toAgentControlExternalRpcError)),
        ),
      ),
    [AGENT_CONTROL_WS_METHODS.updateIntegration]: (input) =>
      ownerEffect(
        AGENT_CONTROL_WS_METHODS.updateIntegration,
        withExternalService((service) =>
          service.update(input).pipe(Effect.mapError(toAgentControlExternalRpcError)),
        ),
      ),
    [AGENT_CONTROL_WS_METHODS.resumeIntegrationPairing]: (input) =>
      ownerEffect(
        AGENT_CONTROL_WS_METHODS.resumeIntegrationPairing,
        withExternalService((service) =>
          service
            .resumePairing(input.integrationId)
            .pipe(Effect.mapError(toAgentControlExternalRpcError)),
        ),
      ),
    [AGENT_CONTROL_WS_METHODS.revokeIntegration]: (input) =>
      ownerEffect(
        AGENT_CONTROL_WS_METHODS.revokeIntegration,
        withExternalService((service) =>
          service.revoke(input.integrationId).pipe(Effect.mapError(toAgentControlExternalRpcError)),
        ),
      ),
    [AGENT_CONTROL_WS_METHODS.deleteIntegration]: (input) =>
      ownerEffect(
        AGENT_CONTROL_WS_METHODS.deleteIntegration,
        withExternalService((service) =>
          service.delete(input.integrationId).pipe(Effect.mapError(toAgentControlExternalRpcError)),
        ),
      ),
    [AGENT_CONTROL_WS_METHODS.listMcpInstallations]: () =>
      ownerEffect(
        AGENT_CONTROL_WS_METHODS.listMcpInstallations,
        withInstallationService((service) =>
          service.list().pipe(Effect.mapError(toAgentControlInstallationRpcError)),
        ),
      ),
    [AGENT_CONTROL_WS_METHODS.connectMcpInstallation]: (input) =>
      ownerEffect(
        AGENT_CONTROL_WS_METHODS.connectMcpInstallation,
        withInstallationService((service) =>
          service.connect(input).pipe(Effect.mapError(toAgentControlInstallationRpcError)),
        ),
      ),
    [AGENT_CONTROL_WS_METHODS.repairMcpInstallation]: (input) =>
      ownerEffect(
        AGENT_CONTROL_WS_METHODS.repairMcpInstallation,
        withInstallationService((service) =>
          service
            .repair(input.installationId)
            .pipe(Effect.mapError(toAgentControlInstallationRpcError)),
        ),
      ),
    [AGENT_CONTROL_WS_METHODS.disconnectMcpInstallation]: (input) =>
      ownerEffect(
        AGENT_CONTROL_WS_METHODS.disconnectMcpInstallation,
        withInstallationService((service) =>
          service
            .disconnect(input.installationId)
            .pipe(Effect.mapError(toAgentControlInstallationRpcError)),
        ),
      ),
  });
};
