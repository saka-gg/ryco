import {
  AGENT_CONTROL_WS_METHODS,
  AgentControlProposalStatus,
  AgentControlRpcError,
  AgentControlExternalRpcError,
} from "@ryco/contracts";
import { Effect, Option, Schema, Stream } from "effect";

import type { AgentControlNodeDirectoryError } from "../agentControl/Errors.ts";
import type { AgentControlProposalDecisionError } from "../agentControl/Services/AgentControlProposalService.ts";
import type { AgentControlExternalIntegrationServiceError } from "../agentControl/Services/AgentControlExternalIntegration.ts";
import type { AgentControlExternalInstallationServiceError } from "../agentControl/Services/AgentControlExternalInstallation.ts";
import { observeRpcEffect, observeRpcStreamEffect } from "../observability/RpcInstrumentation.ts";
import { defineWsHandlers, type WsRpcContext } from "./context.ts";

const isProposalStatus = Schema.is(AgentControlProposalStatus);

/**
 * Map internal lifecycle failures onto the bounded RPC error. A decision
 * conflict names the proposal's actual status so the client can render
 * "already approved elsewhere"; nothing else about the resource — plans,
 * prompts, storage details — crosses this boundary.
 */
export const toAgentControlRpcError = (
  error: AgentControlProposalDecisionError,
): AgentControlRpcError => {
  switch (error._tag) {
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
        ...(isProposalStatus(error.from) ? { status: error.from } : {}),
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
    currentSessionId,
    ownerEffect,
    ownerStreamEffect,
  } = ctx;

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
    // The proposal reads take `planView` (clients that decode the tolerant plan view send
    // "tolerant"). Nothing is left out for clients without it yet: the validator still refuses
    // every kind outside `AGENT_CONTROL_LEGACY_PLAN_KINDS`, so no such proposal exists.
    [AGENT_CONTROL_WS_METHODS.listProposals]: (input) =>
      observeRpcEffect(
        AGENT_CONTROL_WS_METHODS.listProposals,
        ownerEffect(
          AGENT_CONTROL_WS_METHODS.listProposals,
          withService((service) =>
            service
              .getQueue({ activeLimit: input.activeLimit, recentLimit: input.recentLimit })
              .pipe(Effect.mapError(toAgentControlRpcError)),
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
              Effect.map((proposal) => ({ proposal: Option.getOrNull(proposal) })),
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
              .pipe(Effect.mapError(toAgentControlRpcError)),
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
    [AGENT_CONTROL_WS_METHODS.subscribeProposals]: (_input) =>
      observeRpcStreamEffect(
        AGENT_CONTROL_WS_METHODS.subscribeProposals,
        ownerStreamEffect(
          AGENT_CONTROL_WS_METHODS.subscribeProposals,
          withService((service) =>
            Effect.succeed(
              service.subscribeQueue({}).pipe(Stream.mapError(toAgentControlRpcError)),
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
    // Refused until client-executed proposals are implemented; the node does not advertise
    // `projectCopy` yet, so no client accepts one.
    [AGENT_CONTROL_WS_METHODS.reportClientExecution]: () =>
      ownerEffect(
        AGENT_CONTROL_WS_METHODS.reportClientExecution,
        Effect.fail(
          new AgentControlRpcError({
            code: "unsupported",
            message: "This server does not run client-executed requests yet.",
          }),
        ),
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
