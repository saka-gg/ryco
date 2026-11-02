import { AgentControlWorkspaces } from "../workspaceLifecycle.ts";
import { WorkspaceFileSystem } from "../../workspace/Services/WorkspaceFileSystem.ts";
import { CheckpointDiffQuery } from "../../checkpointing/Services/CheckpointDiffQuery.ts";
import { withInspectionTools } from "../Mcp/inspectionTools.ts";
import { withArtifactTools } from "../Mcp/artifactTools.ts";
import { withDelegationTools } from "../Mcp/delegationTools.ts";
import { withLocalTaskTools } from "../Mcp/localTaskTools.ts";
import { withLazyAgentControlTools } from "../Mcp/lazyTools.ts";
import { PullRequestWatchService } from "../../sourceControl/PullRequestWatchService.ts";
import { toMcpFollowUpQueue } from "../Mcp/threadTranscript.ts";
import { findThreadInArray } from "../../orchestration/threadIndex.ts";
import { extractThreadReferences } from "@ryco/shared/threadMentions";
import { AGENT_CONTROL_DEVICE_TOOL } from "../../providerTools/deviceToolGateway.ts";
import { LocalTaskService } from "../../tasks/LocalTaskService.ts";
import { makeDelegatedTaskControl } from "../delegatedTaskControl.ts";
import {
  CompletionReturnRepository,
  isPendingCompletionReturn,
} from "../../persistence/Layers/AgentControlCompletionReturns.ts";
import { CommandWatchService } from "../../commandWatch/CommandWatchService.ts";
import { AgentControlProposalRepository } from "../../persistence/Services/AgentControlProposals.ts";
import * as SqlClient from "effect/sql/SqlClient";
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
import {
  AGENT_CONTROL_CAPABILITIES,
  AGENT_CONTROL_COMMAND_WATCH_MCP_TOOLS,
  AGENT_CONTROL_LINK_PULL_REQUEST_TOOL,
  AGENT_CONTROL_MCP_WAIT_TIMEOUT_MS_MAX,
  AGENT_CONTROL_QUEUE_MCP_TOOLS,
  AGENT_CONTROL_WORKTREE_MCP_TOOLS,
  AGENT_CONTROL_SECRET_REQUEST_MCP_TOOL,
} from "@ryco/contracts";
import { threadWakeSource, waitUntil } from "../eventDrivenWait.ts";
import { Effect, Exit, Layer, Option, Scope, Stream } from "effect";
import { ServerConfig } from "../../config.ts";
import { CliProxyService } from "../../cliProxy/CliProxyService.ts";
import { withComputerUseTools } from "../Mcp/computerTools.ts";
import { withAssistantAttachmentTools } from "../Mcp/attachmentTools.ts";
import { withHtmlRenderTools } from "../Mcp/htmlRenderTools.ts";
import { makeTurnAttachmentDelivery } from "../Mcp/turnAttachmentDelivery.ts";
import { HtmlRender } from "../../htmlRender/HtmlRender.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import * as Semaphore from "effect/Semaphore";

import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { GitWorkflowService } from "../../git/GitWorkflowService.ts";
import { waitForControlRequestReceipt } from "../Mcp/proposalReads.ts";
import { DeviceService } from "../../device/Services/DeviceService.ts";
import { ProviderRegistry } from "../../provider/Services/ProviderRegistry.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { WorkspaceAccessPolicy } from "../../workspace/Services/WorkspaceAccessPolicy.ts";
import { makeAgentControlMcpListener } from "../Mcp/listener.ts";
import {
  AGENT_CONTROL_DEVICE_IMAGE_MAX_BASE64_CHARS,
  makeAgentControlMcpTools,
  proposalVisibleToSession,
  replayedAgentControlMutation,
  submitAgentControlMutation,
  withCompleteAgentControlCatalog,
} from "../Mcp/tools.ts";
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
import { trackStartupPhase } from "../../startupStallMonitor.ts";

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
  // Required: `ryco_wait_threads` wakes on its events (without them it would only re-check every 5 s).
  const engine = yield* OrchestrationEngineService;
  const htmlRender = yield* Effect.serviceOption(HtmlRender);

  const files = yield* Effect.serviceOption(WorkspaceFileSystem);
  const diffs = yield* Effect.serviceOption(CheckpointDiffQuery);
  const terminals = yield* Effect.serviceOption(TerminalManager);
  const completionReturns = yield* Effect.serviceOption(CompletionReturnRepository);
  const proposalRepository = yield* Effect.serviceOption(AgentControlProposalRepository);
  const sql = yield* Effect.serviceOption(SqlClient.SqlClient);
  const localTasks = yield* Effect.serviceOption(LocalTaskService);
  const cliProxy = yield* Effect.serviceOption(CliProxyService);
  const commandWatches = yield* Effect.serviceOption(CommandWatchService);
  const pullRequestWatch = yield* Effect.serviceOption(PullRequestWatchService);
  const git = yield* Effect.serviceOption(GitWorkflowService);
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
    ...(Option.isSome(cliProxy) ? { getCliProxyHubs: cliProxy.value.cachedQuotas } : {}),
    getProviders: providerRegistry.getProviders,
    ...(Option.isSome(validator) ? { validator: validator.value } : {}),
    ...(Option.isSome(projectPlans) ? { projectPlans: projectPlans.value } : {}),
    getTurnAuthority: registry.getTurnAuthority,
  };
  const inspectionTools = withInspectionTools(makeAgentControlMcpTools(toolDeps), {
    ...toolDeps,
    domainEvents: engine,
    ...(Option.isSome(files) ? { files: files.value } : {}),
    ...(Option.isSome(diffs) ? { diffs: diffs.value } : {}),
    ...(Option.isSome(terminals) ? { terminals: terminals.value } : {}),
  });
  const artifactTools = withArtifactTools(inspectionTools, { policy, projections });
  // Stateless ledger reads and CAS writes: no second delivery worker is forked here.
  const baseTools =
    Option.isSome(completionReturns) && Option.isSome(proposalRepository) && Option.isSome(sql)
      ? withDelegationTools(artifactTools, {
          policy,
          registry,
          control: makeDelegatedTaskControl({
            repository: completionReturns.value,
            proposals: proposalRepository.value,
            events: proposalEvents,
            projections,
            sql: sql.value,
            engine,
          }),
        })
      : artifactTools;
  // Tools that show an attachment in the caller's turn share one delivery, so
  // file attachments and HTML renders draw on one serialized per-turn budget.
  const deliveryDeps =
    Option.isSome(config) && Option.isSome(workspaceAccess)
      ? {
          attachmentsDir: config.value.attachmentsDir,
          registry,
          policy,
          projections,
          workspaceAccess: workspaceAccess.value,
          engine,
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
    projections,
    ...(Option.isSome(workspaceAccess) ? { workspaceAccess: workspaceAccess.value } : {}),
  });
  // The native Computer stack (CUA backend, UI tree, browser tools) is only
  // loaded when Desktop hands over a native bridge; other servers never
  // evaluate it.
  const beta =
    Option.isSome(config) && config.value.computerUseBridge?.native
      ? (yield* Effect.promise(() => import("../Mcp/computerBetaTools.ts"))).withComputerBetaTools(
          legacyComputerTools,
          {
            config: config.value.computerUseBridge,
            stateDir: config.value.stateDir,
            registry,
            policy,
            projections,
          },
        )
      : undefined;
  if (beta) yield* Effect.addFinalizer(() => Effect.promise(() => beta.dispose()));
  const computerTools = beta?.tools ?? legacyComputerTools;
  const taskTools = Option.isSome(localTasks)
    ? withLocalTaskTools(computerTools, {
        policy,
        registry,
        proposals,
        ...(Option.isSome(validator) ? { validator: validator.value } : {}),
        tasks: localTasks.value,
        projections,
        ...(Option.isSome(workspaceAccess) ? { workspaceAccess: workspaceAccess.value } : {}),
        ...(Option.isSome(config) ? { taskFilesDir: config.value.taskFilesDir } : {}),
      })
    : computerTools;
  // A thread's follow-up queue for agents: list it, change their own entries. The module loads
  // the first time a session lists or calls tools, never at boot.
  const queueTools = withLazyAgentControlTools(taskTools, {
    names: Object.values(AGENT_CONTROL_QUEUE_MCP_TOOLS),
    writeNames: [
      AGENT_CONTROL_QUEUE_MCP_TOOLS.queueEdit,
      AGENT_CONTROL_QUEUE_MCP_TOOLS.queueRemove,
    ],
    mayUse: (session) => session.grantedCapabilities.includes(AGENT_CONTROL_CAPABILITIES.read),
    load: () =>
      import("../Mcp/queueTools.ts").then((module) =>
        module.withQueueTools(taskTools, {
          policy,
          registry,
          projections,
          engine,
          helpers: { findThreadInArray, toMcpFollowUpQueue, extractThreadReferences },
        }),
      ),
  });
  // An agent links the pull requests it opens to its chat's workspace. Loads on first use.
  const pullRequestTools = Option.isSome(pullRequestWatch)
    ? withLazyAgentControlTools(queueTools, {
        names: [AGENT_CONTROL_LINK_PULL_REQUEST_TOOL],
        writeNames: [AGENT_CONTROL_LINK_PULL_REQUEST_TOOL],
        mayUse: (session) =>
          session.grantedCapabilities.includes(AGENT_CONTROL_CAPABILITIES.watchPullRequests),
        load: () =>
          import("../Mcp/pullRequestLinkTools.ts").then((module) =>
            module.withPullRequestLinkTools(queueTools, {
              policy,
              registry,
              pullRequestWatch: pullRequestWatch.value,
            }),
          ),
      })
    : queueTools;
  // Routine device input under per-task consent, where devices exist. Its
  // module (consent index, driving guide) loads the first time a session that
  // may drive devices lists or calls tools, never at boot.
  const deviceTools =
    Option.isSome(deviceService) && deviceService.value.supported
      ? withLazyAgentControlTools(pullRequestTools, {
          names: [AGENT_CONTROL_DEVICE_TOOL],
          writeNames: [AGENT_CONTROL_DEVICE_TOOL],
          mayUse: (session) =>
            session.grantedCapabilities.includes(AGENT_CONTROL_CAPABILITIES.controlDevices),
          load: () =>
            import("../Mcp/deviceRoutineTools.ts").then((module) =>
              module.withDeviceRoutineTools(pullRequestTools, {
                policy,
                registry,
                proposals,
                submitMutation: (input) =>
                  submitAgentControlMutation(
                    {
                      proposals,
                      ...(Option.isSome(validator) ? { validator: validator.value } : {}),
                    },
                    input,
                  ),
                projections,
                deviceService: deviceService.value,
                maxImageBase64Chars: AGENT_CONTROL_DEVICE_IMAGE_MAX_BASE64_CHARS,
              }),
            ),
        })
      : pullRequestTools;
  // Command watches on the caller's own chat. Their module loads the first time a session that
  // may watch commands lists or calls tools, never at boot.
  const watchTools = Option.isSome(commandWatches)
    ? withLazyAgentControlTools(deviceTools, {
        names: Object.values(AGENT_CONTROL_COMMAND_WATCH_MCP_TOOLS),
        writeNames: [
          AGENT_CONTROL_COMMAND_WATCH_MCP_TOOLS.watch,
          AGENT_CONTROL_COMMAND_WATCH_MCP_TOOLS.unwatch,
        ],
        mayUse: (session) =>
          session.grantedCapabilities.includes(AGENT_CONTROL_CAPABILITIES.watchCommands),
        load: () =>
          import("../Mcp/commandWatchTools.ts").then((module) =>
            module.withCommandWatchTools(deviceTools, {
              policy,
              registry,
              projections,
              watches: commandWatches.value,
              completionReturns: Option.getOrUndefined(completionReturns),
              isPendingCompletionReturn,
            }),
          ),
      })
    : deviceTools;
  // An agent's move of its own chat into a new worktree. Its module loads the first time a
  // session that may manage workspaces lists or calls tools, never at boot.
  const handoffTools = withLazyAgentControlTools(watchTools, {
    names: Object.values(AGENT_CONTROL_WORKTREE_MCP_TOOLS),
    writeNames: [AGENT_CONTROL_WORKTREE_MCP_TOOLS.handoff],
    mayUse: (session) =>
      session.grantedCapabilities.includes(AGENT_CONTROL_CAPABILITIES.manageWorkspaces),
    load: () =>
      import("../Mcp/worktreeHandoffTools.ts").then((module) =>
        module.withWorktreeHandoffTools(watchTools, {
          policy,
          registry,
          projections,
          submitMutation: (input) =>
            submitAgentControlMutation(
              { proposals, ...(Option.isSome(validator) ? { validator: validator.value } : {}) },
              input,
            ),
          waitForTerminal: (session, proposalId) =>
            waitForControlRequestReceipt({
              proposals,
              proposalEvents,
              proposalId,
              waitFor: "terminal",
              timeoutMs: AGENT_CONTROL_MCP_WAIT_TIMEOUT_MS_MAX,
              visible: (proposal) => proposalVisibleToSession(proposal, session),
            }),
          replay: (session, requestId, plan) =>
            replayedAgentControlMutation(proposals, session, requestId, plan),
          ...(Option.isSome(git)
            ? { checkoutBranch: (cwd) => git.value.localStatus({ cwd }) }
            : {}),
        }),
      ),
  });
  // `ryco_request_secret`: a private card for a secret the agent needs, written into a
  // Git-ignored dotenv file of its own checkout. Its module (and the dotenv writer) loads the
  // first time a session that may ask lists or calls tools, never at boot.
  const secretTools = withLazyAgentControlTools(handoffTools, {
    names: [AGENT_CONTROL_SECRET_REQUEST_MCP_TOOL],
    writeNames: [AGENT_CONTROL_SECRET_REQUEST_MCP_TOOL],
    mayUse: (session) =>
      session.grantedCapabilities.includes(AGENT_CONTROL_CAPABILITIES.requestSecrets),
    load: () =>
      import("../Mcp/secretRequestTools.ts").then((module) =>
        module.withSecretRequestTools(handoffTools, {
          policy,
          registry,
          engine,
          projections,
          ...(Option.isSome(workspaceAccess) ? { workspaceAccess: workspaceAccess.value } : {}),
          helpers: { findThreadInArray, waitUntil, threadWakeSource },
        }),
      ),
  });
  const tools = withCompleteAgentControlCatalog(secretTools);

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
  yield* trackStartupPhase(
    "agent-control.listener.start",
    converge(initiallyEnabled, "feature-disabled"),
  );

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
