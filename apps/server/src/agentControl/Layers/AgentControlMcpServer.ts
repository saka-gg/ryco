import { withComputerBetaTools } from "../Mcp/computerBetaTools.ts";
import { AgentControlWorkspaces } from "../workspaceLifecycle.ts";
import { WorkspaceFileSystem } from "../../workspace/Services/WorkspaceFileSystem.ts";
import { CheckpointDiffQuery } from "../../checkpointing/Services/CheckpointDiffQuery.ts";
import { withInspectionTools } from "../Mcp/inspectionTools.ts";
import { withDelegationTools } from "../Mcp/delegationTools.ts";
import { makeDelegatedTaskControl } from "../delegatedTaskControl.ts";
import { CompletionReturnRepository } from "../../persistence/Layers/AgentControlCompletionReturns.ts";
import { AgentControlProposalRepository } from "../../persistence/Services/AgentControlProposals.ts";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { TerminalManager } from "../../terminal/Services/Manager.ts";
/**
 * AgentControlMcpServer - Lifecycle owner of the private Agent Control
 * MCP listener.
 *
 * Starts the loopback listener when `agentControl.enabled` is on, tears
 * it down (revoking every lease) when the setting turns off or the server
 * shuts down, and publishes the bound endpoint exclusively into the
 * session registry. Listener startup failure is contained: the server
 * keeps running, no endpoint is published, and provider adapters start
 * their runtimes without Agent Control rather than advertising tools that
 * do not exist.
 *
 * This layer deliberately produces no service — nothing outside the
 * registry may learn the endpoint, and no browser/client-visible state is
 * derived from it.
 *
 * @module AgentControlMcpServer
 */
import { Effect, Exit, Layer, Option, Scope, Stream } from "effect";
import { ServerConfig } from "../../config.ts";
import { withComputerUseTools } from "../Mcp/computerTools.ts";
import { withAssistantAttachmentTools } from "../Mcp/attachmentTools.ts";
import { withHtmlRenderTools } from "../Mcp/htmlRenderTools.ts";
import { makeTurnAttachmentDelivery } from "../Mcp/turnAttachmentDelivery.ts";
import { HtmlRender } from "../../htmlRender/HtmlRender.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import * as Semaphore from "effect/Semaphore";

import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { DeviceService } from "../../device/Services/DeviceService.ts";
import { ProviderRegistry } from "../../provider/Services/ProviderRegistry.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { WorkspaceAccessPolicy } from "../../workspace/Services/WorkspaceAccessPolicy.ts";
import { makeAgentControlMcpListener } from "../Mcp/listener.ts";
import { makeAgentControlMcpTools, withCompleteAgentControlCatalog } from "../Mcp/tools.ts";
import { AgentControlPolicy } from "../Services/AgentControlPolicy.ts";
import { AgentControlActionValidator } from "../Services/AgentControlActionValidator.ts";
import { AgentControlAutomationService } from "../Services/AgentControlAutomation.ts";
import { AgentControlDiagnosticsService } from "../Services/AgentControlDiagnostics.ts";
import { AgentControlProposalEvents } from "../Services/AgentControlProposalEvents.ts";
import { AgentControlProposalService } from "../Services/AgentControlProposalService.ts";
import { AgentControlProjectPlans } from "../Services/AgentControlProjectPlans.ts";
import {
  AgentControlSessionRegistry,
  type AgentControlLeaseRevocationReason,
} from "../Services/AgentControlSessionRegistry.ts";

const makeAgentControlMcpServer = Effect.gen(function* () {
  const registry = yield* AgentControlSessionRegistry;
  const policy = yield* AgentControlPolicy;
  const validator = yield* Effect.serviceOption(AgentControlActionValidator);
  const proposals = yield* AgentControlProposalService;
  const proposalEvents = yield* AgentControlProposalEvents;
  const projections = yield* ProjectionSnapshotQuery;
  const workspaces = yield* Effect.serviceOption(AgentControlWorkspaces);
  const projectPlans = yield* Effect.serviceOption(AgentControlProjectPlans);
  const automations = yield* Effect.serviceOption(AgentControlAutomationService);
  const diagnostics = yield* Effect.serviceOption(AgentControlDiagnosticsService);
  const providerRegistry = yield* ProviderRegistry;
  const serverSettings = yield* ServerSettingsService;
  const deviceService = yield* Effect.serviceOption(DeviceService);
  const workspaceAccess = yield* Effect.serviceOption(WorkspaceAccessPolicy);
  const config = yield* Effect.serviceOption(ServerConfig);
  const engine = yield* Effect.serviceOption(OrchestrationEngineService);
  const htmlRender = yield* Effect.serviceOption(HtmlRender);

  const files = yield* Effect.serviceOption(WorkspaceFileSystem);
  const diffs = yield* Effect.serviceOption(CheckpointDiffQuery);
  const terminals = yield* Effect.serviceOption(TerminalManager);
  const completionReturns = yield* Effect.serviceOption(CompletionReturnRepository);
  const proposalRepository = yield* Effect.serviceOption(AgentControlProposalRepository);
  const sql = yield* Effect.serviceOption(SqlClient.SqlClient);
  const toolDeps = {
    policy,
    proposals,
    proposalEvents,
    projections,
    ...(Option.isSome(workspaces) ? { workspaces: workspaces.value } : {}),
    ...(Option.isSome(deviceService) ? { deviceService: deviceService.value } : {}),
    ...(Option.isSome(workspaceAccess) ? { workspaceAccess: workspaceAccess.value } : {}),
    ...(Option.isSome(automations) ? { automations: automations.value } : {}),
    ...(Option.isSome(diagnostics) ? { diagnostics: diagnostics.value } : {}),
    getSettings: serverSettings.getSettings,
    getProviders: providerRegistry.getProviders,
    ...(Option.isSome(validator) ? { validator: validator.value } : {}),
    ...(Option.isSome(projectPlans) ? { projectPlans: projectPlans.value } : {}),
    getTurnAuthority: registry.getTurnAuthority,
  };
  const inspectionTools = withInspectionTools(makeAgentControlMcpTools(toolDeps), {
    ...toolDeps,
    ...(Option.isSome(files) ? { files: files.value } : {}),
    ...(Option.isSome(diffs) ? { diffs: diffs.value } : {}),
    ...(Option.isSome(terminals) ? { terminals: terminals.value } : {}),
  });
  // Stateless ledger reads and CAS writes: no second delivery worker is forked here.
  const baseTools =
    Option.isSome(completionReturns) && Option.isSome(proposalRepository) && Option.isSome(sql)
      ? withDelegationTools(inspectionTools, {
          policy,
          registry,
          control: makeDelegatedTaskControl({
            repository: completionReturns.value,
            proposals: proposalRepository.value,
            events: proposalEvents,
            projections,
            sql: sql.value,
          }),
        })
      : inspectionTools;
  // Tools that show an attachment in the caller's turn share one delivery, so
  // file attachments and HTML renders draw on one serialized per-turn budget.
  const deliveryDeps =
    Option.isSome(config) && Option.isSome(workspaceAccess) && Option.isSome(engine)
      ? {
          attachmentsDir: config.value.attachmentsDir,
          registry,
          policy,
          projections,
          workspaceAccess: workspaceAccess.value,
          engine: engine.value,
        }
      : undefined;
  const delivery = deliveryDeps ? yield* makeTurnAttachmentDelivery(deliveryDeps) : undefined;
  const fileTools =
    deliveryDeps && delivery
      ? yield* withAssistantAttachmentTools(baseTools, { ...deliveryDeps, delivery })
      : baseTools;
  const htmlTools =
    deliveryDeps && delivery && Option.isSome(htmlRender)
      ? yield* withHtmlRenderTools(fileTools, {
          ...deliveryDeps,
          delivery,
          htmlRender: htmlRender.value,
        })
      : fileTools;
  const legacyComputerTools = withComputerUseTools(htmlTools, {
    ...(Option.isSome(config) && config.value.computerUseBridge
      ? { config: config.value.computerUseBridge }
      : {}),
    policy,
    registry,
  });
  const beta =
    Option.isSome(config) && config.value.computerUseBridge?.native
      ? withComputerBetaTools(legacyComputerTools, {
          config: config.value.computerUseBridge,
          stateDir: config.value.stateDir,
          registry,
          policy,
          projections,
        })
      : undefined;
  if (beta) yield* Effect.addFinalizer(() => Effect.promise(() => beta.dispose()));
  const tools = withCompleteAgentControlCatalog(beta?.tools ?? legacyComputerTools);

  // Start/stop transitions are serialized so a rapid settings flip cannot
  // interleave a start with a teardown. `shuttingDown` latches inside the
  // semaphore during the shutdown finalizer: scope finalizers run LIFO, so
  // the settings watcher fiber (forked before the finalizer registration)
  // is still alive when shutdown runs and a buffered settings event could
  // otherwise restart the listener after the final teardown.
  const transitions = yield* Semaphore.make(1);
  let listenerScope: Scope.Closeable | null = null;
  let shuttingDown = false;

  const startListener = Effect.gen(function* () {
    if (shuttingDown || listenerScope !== null) return;
    const scope = yield* Scope.make("sequential");
    const started = yield* makeAgentControlMcpListener({ registry, tools }).pipe(
      Scope.provide(scope),
      Effect.exit,
    );
    if (Exit.isFailure(started)) {
      yield* Scope.close(scope, Exit.void);
      // Contained failure: no endpoint, no injection, no false claims.
      yield* Effect.logWarning("Agent Control MCP listener failed to start", {
        cause: started.cause,
      });
      return;
    }
    listenerScope = scope;
    yield* registry.publishEndpoint({ url: started.value.url });
    yield* Effect.logInfo("Agent Control MCP listener started", { port: started.value.port });
  });

  const stopListener = (reason: AgentControlLeaseRevocationReason) =>
    Effect.gen(function* () {
      if (listenerScope === null) return;
      const scope = listenerScope;
      listenerScope = null;
      yield* registry.clearEndpoint;
      yield* registry.revokeAll(reason);
      yield* Scope.close(scope, Exit.void);
      yield* Effect.logInfo("Agent Control MCP listener stopped", { reason });
    });

  const converge = (enabled: boolean, reason: AgentControlLeaseRevocationReason) =>
    transitions.withPermits(1)(enabled ? startListener : stopListener(reason));

  const initiallyEnabled = yield* serverSettings.getSettings.pipe(
    Effect.map((settings) => settings.agentControl.enabled),
    Effect.catch(() => Effect.succeed(false)),
  );
  yield* converge(initiallyEnabled, "feature-disabled");

  yield* serverSettings.streamChanges.pipe(
    Stream.runForEach((settings) =>
      converge(settings.agentControl.enabled, "feature-disabled").pipe(
        Effect.catchCause((cause) =>
          Effect.logError("Agent Control MCP listener reconcile failed", cause),
        ),
      ),
    ),
    Effect.forkScoped,
  );

  yield* Effect.addFinalizer(() =>
    transitions
      .withPermits(1)(
        Effect.gen(function* () {
          shuttingDown = true;
          yield* stopListener("server-shutdown");
        }),
      )
      .pipe(Effect.ignore),
  );
});

export const AgentControlMcpServerLive = Layer.effectDiscard(makeAgentControlMcpServer);
