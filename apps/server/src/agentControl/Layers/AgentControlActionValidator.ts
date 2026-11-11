import { AgentControlWorkspaces } from "../workspaceLifecycle.ts";
import type {
  AgentControlActionPlan,
  AgentControlAutomationExecutionTemplate,
  AgentControlDeviceActionPlan,
  AgentControlDeviceControlConsentPlan,
  AgentControlProviderSessionPrincipal,
  AgentControlProposal,
  EnvironmentId,
  ModelSelection,
  OrchestrationShellSnapshot,
  OrchestrationThreadShell,
  RuntimeMode,
  ServerChatsCapability,
  ServerProvider,
} from "@ryco/contracts";
import { AGENT_CONTROL_CAPABILITIES, ThreadId } from "@ryco/contracts";
import {
  automationScopeOfProject,
  isChatProject,
  isChatsAutomationScope,
} from "@ryco/shared/projectKind";
import { Effect, Layer, Option } from "effect";

import { ServerEnvironment } from "../../environment/Services/ServerEnvironment.ts";
import { GitNetwork, type GitNetworkShape } from "../../projectCopy/Services/GitNetwork.ts";
import { NodePaths, type NodePathsShape } from "../../projectCopy/Services/NodePaths.ts";
import {
  AgentControlNodeDirectory,
  type AgentControlNodeDirectoryShape,
} from "../Services/AgentControlNodeDirectory.ts";
import {
  describeProjectDestinationProblem,
  hasParentDirectorySegment,
  isAgentControlProjectCopyPlan,
  type AgentControlProjectCopyPlan,
} from "../projectCopyControl.ts";

import {
  ProjectionSnapshotQuery,
  readProjectShells,
  readScopedShellSnapshot,
} from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { DeviceService, type DeviceServiceShape } from "../../device/Services/DeviceService.ts";
import { runtimeModePrivilegeRank } from "../../orchestration/serverWake.ts";
import type { ProjectionSnapshotQueryShape } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { GitWorkflowService } from "../../git/GitWorkflowService.ts";
import type { GitWorkflowServiceShape } from "../../git/GitWorkflowService.ts";
import { ProviderRegistry } from "../../provider/Services/ProviderRegistry.ts";
import { AgentControlPlanValidationError } from "../Errors.ts";
import {
  AgentControlAutomationService,
  UNATTENDED_OWNER_ONLY,
  WEBHOOK_OWNER_ONLY,
  planAddsWebhookTrigger,
} from "../Services/AgentControlAutomation.ts";
import type { AgentControlAutomationShape } from "../Services/AgentControlAutomation.ts";
import { AgentControlProjectPlans } from "../Services/AgentControlProjectPlans.ts";
import type { AgentControlProjectPlansShape } from "../Services/AgentControlProjectPlans.ts";
import {
  AgentControlExternalIntegrationService,
  type AgentControlExternalIntegrationServiceError,
} from "../Services/AgentControlExternalIntegration.ts";
import {
  AgentControlActionValidator,
  agentControlExternalCeiling,
  agentControlTargetSnapshotOf,
  agentControlTargetSnapshots,
  agentControlThreadEnvMode,
  isAgentControlProviderReady,
  type AgentControlActionValidatorShape,
} from "../Services/AgentControlActionValidator.ts";
import { assertSafeAgentControlDeviceUrl, isAgentControlDevicePlan } from "../deviceControl.ts";
import { resolveThreadArtifacts } from "../artifactHandoff.ts";
import { LocalTaskService, type LocalTaskServiceShape } from "../../tasks/LocalTaskService.ts";
import * as SqlClient from "effect/sql/SqlClient";
import { ServerSettingsService } from "../../serverSettings.ts";
import { hasDelegationLimits } from "../../orchestration/delegationLimits.ts";
import { ChatFolders, describeChatsUnavailable } from "../../project/chatFolders.ts";
import {
  CompletionReturnRepository,
  isPendingCompletionReturn,
} from "../../persistence/Layers/AgentControlCompletionReturns.ts";

const fail = (
  reason: ConstructorParameters<typeof AgentControlPlanValidationError>[0]["reason"],
  detail: string,
) => Effect.fail(new AgentControlPlanValidationError({ reason, detail }));

const handsOverArtifacts = (plan: AgentControlActionPlan) =>
  plan.kind === "createThreads" && plan.entries.some((entry) => (entry.artifacts?.length ?? 0) > 0);

const startsLocalTaskChats = (plan: AgentControlActionPlan) =>
  plan.kind === "createThreads" && plan.entries.some((entry) => entry.localTaskId !== undefined);

const providerForSelection = (
  providers: ReadonlyArray<ServerProvider>,
  selection: ModelSelection,
) => {
  const provider = providers.find((candidate) => candidate.instanceId === selection.instanceId);
  if (!provider || !isAgentControlProviderReady(provider)) {
    return fail(
      "provider-unavailable",
      `Provider instance '${selection.instanceId}' is unavailable.`,
    );
  }
  const model = provider.models.find((candidate) => candidate.slug === selection.model);
  if (!model) {
    return fail(
      "model-unavailable",
      `Model '${selection.model}' is unavailable on instance '${selection.instanceId}'.`,
    );
  }

  const seen = new Set<string>();
  for (const option of selection.options ?? []) {
    if (seen.has(option.id)) {
      return fail("invalid-options", `Model option '${option.id}' is duplicated.`);
    }
    seen.add(option.id);
    const descriptor = model.capabilities?.optionDescriptors?.find(
      (candidate) => candidate.id === option.id,
    );
    if (!descriptor) {
      return fail("invalid-options", `Model option '${option.id}' is unavailable.`);
    }
    if (descriptor.type === "boolean") {
      if (typeof option.value !== "boolean") {
        return fail("invalid-options", `Model option '${option.id}' must be boolean.`);
      }
    } else if (
      typeof option.value !== "string" ||
      !descriptor.options.some((candidate) => candidate.id === option.value)
    ) {
      return fail("invalid-options", `Model option '${option.id}' has an unavailable value.`);
    }
  }
  return Effect.succeed(provider);
};

const targetThreadIds = (plan: AgentControlActionPlan): ReadonlyArray<string> => {
  switch (plan.kind) {
    case "sendMessage":
    case "interruptThread":
    case "updateThread":
    case "deviceControlConsent":
    case "pullRequestWatch":
    case "worktreeHandoff":
      return [plan.threadId];
    case "createAutomation":
    case "updateAutomation":
      // Only a chat the plan checks now (a deleted chat's heartbeat can still be disabled).
      return lifecycleTargetChecked(plan, false)
        ? automationTargetThreadIds(automationDefinitionForPlan(plan).execution)
        : [];
    case "automationRun":
      return automationTargetThreadIds(automationDefinitionForPlan(plan).execution);
    default:
      return isAgentControlDevicePlan(plan) ? [plan.threadId] : [];
  }
};

/** The existing chat an automation's runs go to (a heartbeat), if any. */
const automationTargetThreadIds = (
  execution: AgentControlAutomationExecutionTemplate,
): ReadonlyArray<string> => (execution.target === undefined ? [] : [execution.target.threadId]);

/**
 * Whether a lifecycle plan's heartbeat chat is checked now: on a create, on any update that
 * changes the chat (also a disabled one), and on a proposer's update that leaves it enabled.
 * Every run checks it again.
 */
function lifecycleTargetChecked(
  plan: Extract<AgentControlActionPlan, { kind: "createAutomation" | "updateAutomation" }>,
  owner: boolean,
): boolean {
  if (plan.kind === "createAutomation") return true;
  const chatChanged =
    plan.before.definition.execution.target?.threadId !== plan.after.execution.target?.threadId;
  return chatChanged || (plan.after.enabled && !owner);
}

/** The stricter of two send ceilings: the lower runtime mode, a worktree over a shared checkout. */
const lowerSendCeiling = (
  a: { readonly runtimeMode: RuntimeMode; readonly envMode: "local" | "worktree" },
  b: { readonly runtimeMode: RuntimeMode; readonly envMode: "local" | "worktree" },
): { readonly runtimeMode: RuntimeMode; readonly envMode: "local" | "worktree" } => ({
  runtimeMode:
    runtimeModePrivilegeRank[a.runtimeMode] <= runtimeModePrivilegeRank[b.runtimeMode]
      ? a.runtimeMode
      : b.runtimeMode,
  envMode: a.envMode === "worktree" || b.envMode === "worktree" ? "worktree" : "local",
});

/**
 * A heartbeat's chat: an open chat of the automation's project (in the "No project" scope, any
 * open chat without a project), which a proposer's heartbeat (`asSender`) must also be allowed
 * to message. The owner's own schedules need only the first.
 */
const validateAutomationTarget = (
  execution: AgentControlAutomationExecutionTemplate,
  snapshot: OrchestrationShellSnapshot,
  asSender?: Omit<Parameters<typeof validatePlanAgainstSnapshot>[0], "plan" | "snapshot">,
) =>
  Effect.gen(function* () {
    const target = execution.target;
    if (target === undefined) return;
    const thread = snapshot.threads.find((candidate) => candidate.id === target.threadId);
    const inScope =
      thread !== undefined &&
      (isChatsAutomationScope(execution.projectId)
        ? isChatProject(snapshot.projects.find((project) => project.id === thread.projectId))
        : thread.projectId === execution.projectId);
    if (thread === undefined || thread.archivedAt !== null || !inScope) {
      return yield* fail(
        "thread-unavailable",
        "The automation's chat is archived, deleted or outside the automation's project.",
      );
    }
    if (asSender === undefined) return;
    yield* validatePlanAgainstSnapshot({
      ...asSender,
      plan: {
        kind: "sendMessage",
        threadId: target.threadId,
        text: execution.prompt,
        delivery: "queue",
      },
      snapshot,
    });
  });

const validateDevicePlanScope = (
  plan: AgentControlDeviceActionPlan | AgentControlDeviceControlConsentPlan,
  input: {
    readonly originThreadId: string;
    readonly originProjectId: string;
    readonly originProviderInstanceId: string;
  },
) =>
  Effect.gen(function* () {
    if (
      plan.threadId !== input.originThreadId ||
      plan.projectId !== input.originProjectId ||
      plan.providerInstanceId !== input.originProviderInstanceId
    ) {
      return yield* fail(
        "project-scope",
        "Device control must remain in the exact originating thread, project, and provider instance.",
      );
    }
    if (plan.kind === "deviceOpenUrl") {
      yield* Effect.try({
        try: () => assertSafeAgentControlDeviceUrl(plan.url),
        catch: () =>
          new AgentControlPlanValidationError({
            reason: "invalid-plan",
            detail: "The approved URL does not meet device-control policy.",
          }),
      });
    }
  });

const validateDevicePlanCurrentState = (
  plan: AgentControlDeviceActionPlan,
  input: {
    readonly originThreadId: string;
    readonly originProjectId: string;
    readonly originProviderInstanceId: string;
    readonly currentProjectUpdatedAt: string;
    readonly deviceService: DeviceServiceShape | undefined;
  },
) =>
  Effect.gen(function* () {
    yield* validateDevicePlanScope(plan, input);
    if (plan.expectedProjectUpdatedAt !== input.currentProjectUpdatedAt) {
      return yield* fail("project-stale", "The approved project scope changed.");
    }
    if (input.deviceService === undefined || !input.deviceService.supported) {
      return yield* fail("invalid-plan", "iOS Simulator device control is unavailable.");
    }

    const [threadState, listing] = yield* Effect.tryPromise({
      try: () =>
        Promise.all([
          input.deviceService!.manager.getThreadState(plan.threadId),
          input.deviceService!.manager.list({ includeShutdown: true }),
        ]),
      catch: () =>
        new AgentControlPlanValidationError({
          reason: "thread-unavailable",
          detail: "Current device state is unavailable.",
        }),
    });
    const device = listing.devices.find((candidate) => candidate.udid === plan.udid);
    if (!device) return yield* fail("thread-unavailable", "The approved device is unavailable.");
    if (
      threadState.version !== plan.expectedThreadDeviceVersion ||
      threadState.attachedDeviceUdid !== plan.expectedAttachedDeviceUdid ||
      device.state !== plan.expectedDeviceState ||
      device.bootSource !== plan.expectedDeviceBootSource ||
      input.deviceService.manager.isRecording(plan.udid) !== plan.expectedRecording
    ) {
      return yield* fail("thread-stale", "The approved device or attachment state changed.");
    }
    if (
      input.deviceService.manager
        .attachedThreadIds(plan.udid)
        .some((threadId) => threadId !== plan.threadId)
    ) {
      return yield* fail(
        "thread-stale",
        "The device is deliberately attached to a different thread.",
      );
    }

    // A thread may attach several devices: attaching another opens it beside the rest.
    const attachedHere = input.deviceService.manager.isAttached(plan.threadId, plan.udid);
    if (plan.kind === "deviceAttach") {
      if (device.state !== "booted") {
        return yield* fail("thread-unavailable", "Only a booted device can be attached.");
      }
      return;
    }
    if (plan.kind === "deviceBoot") {
      if (device.state !== "shutdown") {
        return yield* fail("thread-stale", "The approved device is no longer shut down.");
      }
      return;
    }
    if (!attachedHere) {
      return yield* fail(
        "thread-stale",
        "The approved device is no longer attached to the originating thread.",
      );
    }
    if (plan.kind === "deviceDetach") return;
    if (device.state !== "booted") {
      return yield* fail("thread-unavailable", "The attached device is not booted.");
    }
    if (plan.kind === "deviceStartRecording" && plan.expectedRecording) {
      return yield* fail("thread-stale", "The device is already recording.");
    }
    if (plan.kind === "deviceStopRecording" && !plan.expectedRecording) {
      return yield* fail("thread-stale", "The device is not recording.");
    }
  });

const isProjectPlan = (
  plan: AgentControlActionPlan,
): plan is Extract<
  AgentControlActionPlan,
  { kind: "createProject" | "updateProject" | "removeProject" }
> =>
  plan.kind === "createProject" || plan.kind === "updateProject" || plan.kind === "removeProject";

const isThreadControlPlan = (
  plan: AgentControlActionPlan,
): plan is Extract<
  AgentControlActionPlan,
  { kind: "sendMessage" | "interruptThread" | "updateThread" }
> => plan.kind === "sendMessage" || plan.kind === "interruptThread" || plan.kind === "updateThread";

const isAutomationLifecyclePlan = (
  plan: AgentControlActionPlan,
): plan is Extract<
  AgentControlActionPlan,
  { kind: "createAutomation" | "updateAutomation" | "cancelAutomation" }
> =>
  plan.kind === "createAutomation" ||
  plan.kind === "updateAutomation" ||
  plan.kind === "cancelAutomation";

const automationDefinitionForPlan = (
  plan: Extract<
    AgentControlActionPlan,
    { kind: "createAutomation" | "updateAutomation" | "automationRun" }
  >,
) =>
  plan.kind === "createAutomation"
    ? plan.definition
    : plan.kind === "updateAutomation"
      ? plan.after
      : {
          execution: plan.execution,
          schedule: { kind: "once" as const, runAt: plan.scheduledFor },
          enabled: true,
        };

/**
 * A follow-up setup thread follows `createThreads`' rules: never a more privileged runtime mode
 * than the caller's, and isolated in a worktree when the caller is.
 */
const validateFollowUpThread = (
  followUpThread: AgentControlProjectCopyPlan["followUpThread"],
  origin: { readonly runtimeMode: RuntimeMode; readonly envMode: "local" | "worktree" },
) => {
  if (followUpThread === null) return Effect.void;
  if (
    runtimeModePrivilegeRank[followUpThread.runtimeMode] >
    runtimeModePrivilegeRank[origin.runtimeMode]
  )
    return fail(
      "privilege-escalation",
      "The follow-up thread's runtime mode is more privileged than the caller's.",
    );
  if (origin.envMode === "worktree" && followUpThread.envMode !== "worktree")
    return fail(
      "worktree-escalation",
      "A worktree-isolated caller cannot start a follow-up thread in a shared checkout.",
    );
  return Effect.void;
};
/** An agent's plan never lets a schedule run without asking: only its owner may. */
const agentPlanRunsUnattended = (
  plan: Extract<
    AgentControlActionPlan,
    { kind: "createAutomation" | "updateAutomation" | "cancelAutomation" }
  >,
): boolean =>
  (plan.kind === "createAutomation"
    ? plan.definition
    : plan.kind === "updateAutomation"
      ? plan.after
      : null
  )?.runPolicy === "run-without-asking";

const requireThread = (snapshot: OrchestrationShellSnapshot, threadId: string) => {
  const thread = snapshot.threads.find((candidate) => candidate.id === threadId);
  return thread
    ? Effect.succeed(thread)
    : fail("thread-unavailable", "Target thread is unavailable.");
};

const validateBaseRef = (baseRef: string | undefined) => {
  if (baseRef === undefined) return Effect.void;
  if (
    baseRef.startsWith("-") ||
    baseRef.includes("\0") ||
    baseRef.includes("\n") ||
    baseRef.includes("\r")
  ) {
    return fail("invalid-plan", "The requested base ref is invalid.");
  }
  return Effect.void;
};

/**
 * A handoff moves the caller's own chat and never another one. Whether the chat can move (open,
 * in the shared checkout) the executor decides right before it moves it.
 */
const validateWorktreeHandoff = (
  plan: Extract<AgentControlActionPlan, { kind: "worktreeHandoff" }>,
  callerThreadId: string,
) =>
  plan.threadId !== callerThreadId
    ? fail("project-scope", "A chat can move only itself into a worktree.")
    : validateBaseRef(plan.baseRef);

const validatePlanAgainstSnapshot = (input: {
  readonly plan: AgentControlActionPlan;
  /** The calling provider session's thread; absent for external integrations. */
  readonly originThreadId?: string | undefined;
  readonly originProjectId: string;
  readonly originRuntimeMode: RuntimeMode;
  readonly originEnvMode: "local" | "worktree";
  readonly snapshot: OrchestrationShellSnapshot;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly requireBaseRef: (
    cwd: string,
    baseRef: string,
  ) => Effect.Effect<void, AgentControlPlanValidationError>;
}) =>
  Effect.gen(function* () {
    const assertPrivilege = (target: OrchestrationThreadShell) =>
      Effect.gen(function* () {
        if (
          runtimeModePrivilegeRank[target.runtimeMode] >
          runtimeModePrivilegeRank[input.originRuntimeMode]
        ) {
          return yield* fail(
            "privilege-escalation",
            "The target thread has a more privileged runtime mode than the caller.",
          );
        }
        if (
          input.originEnvMode === "worktree" &&
          agentControlThreadEnvMode(target) !== "worktree"
        ) {
          return yield* fail(
            "worktree-escalation",
            "A worktree-isolated caller cannot target a shared local checkout.",
          );
        }
      });

    if (input.plan.kind === "createThreads") {
      for (const entry of input.plan.entries) {
        if (entry.projectId !== input.originProjectId) {
          return yield* fail("project-scope", "The requested project is outside caller scope.");
        }
        // An automation without a project: each run's chat gets its own new folder.
        const chats = isChatsAutomationScope(entry.projectId);
        const project = chats
          ? undefined
          : input.snapshot.projects.find((candidate) => candidate.id === entry.projectId);
        if (!chats && !project) {
          return yield* fail("project-unavailable", "The requested project is unavailable.");
        }
        if (chats && entry.envMode !== "local") {
          return yield* fail(
            "invalid-plan",
            "A chat without a project runs in its own folder and cannot use a worktree.",
          );
        }
        if (
          runtimeModePrivilegeRank[entry.runtimeMode] >
          runtimeModePrivilegeRank[input.originRuntimeMode]
        ) {
          return yield* fail(
            "privilege-escalation",
            "The requested runtime mode is more privileged than the caller.",
          );
        }
        if (input.originEnvMode === "worktree" && entry.envMode !== "worktree") {
          return yield* fail(
            "worktree-escalation",
            "A worktree-isolated caller cannot create a shared local thread.",
          );
        }
        if (entry.envMode === "local" && entry.baseRef !== undefined) {
          return yield* fail("invalid-plan", "A local-checkout thread cannot request a base ref.");
        }
        yield* validateBaseRef(entry.baseRef);
        if (
          project !== undefined &&
          entry.envMode === "worktree" &&
          entry.baseRef !== undefined &&
          entry.baseRef !== "HEAD"
        ) {
          yield* input.requireBaseRef(project.workspaceRoot, entry.baseRef);
        }
        yield* providerForSelection(input.providers, entry.modelSelection);
      }
      return;
    }

    if (
      input.plan.kind !== "sendMessage" &&
      input.plan.kind !== "interruptThread" &&
      input.plan.kind !== "updateThread" &&
      input.plan.kind !== "pullRequestWatch"
    ) {
      return yield* fail("invalid-plan", "This action is not a thread control plan.");
    }

    const target = yield* requireThread(input.snapshot, input.plan.threadId);
    if (target.projectId !== input.originProjectId) {
      return yield* fail("project-scope", "The target thread is outside caller project scope.");
    }
    yield* assertPrivilege(target);

    if (input.plan.kind === "updateThread") {
      if (
        input.plan.title === undefined &&
        input.plan.archived === undefined &&
        input.plan.persistentGoal === undefined &&
        input.plan.goalStatus === undefined &&
        input.plan.modelSelection === undefined &&
        input.plan.runtimeMode === undefined &&
        input.plan.interactionMode === undefined &&
        input.plan.tokenMode === undefined
      ) {
        return yield* fail("invalid-plan", "At least one supported thread update is required.");
      }
      if (input.plan.goalStatus !== undefined) {
        // Only the agent working toward a goal reports on it, and only on a goal it has.
        if (input.originThreadId === undefined || target.id !== input.originThreadId) {
          return yield* fail("project-scope", "Only the calling thread can report on its goal.");
        }
        if (input.plan.persistentGoal !== undefined) {
          return yield* fail("invalid-plan", "Set a goal or report on it, not both at once.");
        }
        if (target.goal == null) {
          return yield* fail("invalid-plan", "This thread has no goal to report on.");
        }
      }
      if (input.plan.modelSelection !== undefined)
        yield* providerForSelection(input.providers, input.plan.modelSelection);
      if (
        input.plan.runtimeMode !== undefined &&
        runtimeModePrivilegeRank[input.plan.runtimeMode] >
          runtimeModePrivilegeRank[input.originRuntimeMode]
      ) {
        return yield* fail(
          "privilege-escalation",
          "The requested runtime mode is more privileged than the caller.",
        );
      }
      if (
        target.archivedAt !== null &&
        input.plan.archived !== false &&
        (input.plan.title !== undefined ||
          input.plan.persistentGoal !== undefined ||
          input.plan.goalStatus !== undefined ||
          input.plan.modelSelection !== undefined ||
          input.plan.runtimeMode !== undefined ||
          input.plan.interactionMode !== undefined ||
          input.plan.tokenMode !== undefined)
      ) {
        return yield* fail("thread-unavailable", "Archived thread metadata cannot be updated.");
      }
      return;
    }

    // Stopping a watch is always allowed: the archive ended it already.
    if (
      target.archivedAt !== null &&
      !(input.plan.kind === "pullRequestWatch" && !input.plan.watching)
    ) {
      return yield* fail("thread-unavailable", "The target thread is archived.");
    }
    // The pull request itself is resolved (and linked, or discovered) by the watch when it runs.
    if (input.plan.kind === "pullRequestWatch") return;

    if (input.plan.kind === "interruptThread") {
      const activeTurnId = target.session?.activeTurnId ?? null;
      if (activeTurnId === null || target.session?.status !== "running") {
        return yield* fail("thread-unavailable", "The target thread has no running turn.");
      }
      if (input.plan.turnId !== undefined && input.plan.turnId !== activeTurnId) {
        return yield* fail("thread-stale", "The requested turn is no longer active.");
      }
      return;
    }

    yield* providerForSelection(input.providers, target.modelSelection);
  });

export const makeAgentControlActionValidatorFromDeps = (deps: {
  readonly projections: ProjectionSnapshotQueryShape;
  readonly getProviders: Effect.Effect<ReadonlyArray<ServerProvider>>;
  readonly listRefs: GitWorkflowServiceShape["listRefs"];
  readonly revalidateExternal?: (
    integrationId: Extract<
      AgentControlProposal["principal"],
      { kind: "external-integration" }
    >["integrationId"],
  ) => Effect.Effect<
    import("@ryco/contracts").AgentControlExternalIntegration,
    AgentControlExternalIntegrationServiceError
  >;
  readonly workspaces?: typeof AgentControlWorkspaces.Service;
  readonly projectPlans?: AgentControlProjectPlansShape;
  readonly automations?: AgentControlAutomationShape;
  readonly deviceService?: DeviceServiceShape;
  readonly localTasks?: Pick<LocalTaskServiceShape, "get">;
  /** `importProject`: the destination folder's verdict on this node. */
  readonly nodePaths?: Pick<NodePathsShape, "judgeProjectDestination">;
  /** Both cross-node kinds: which remote URLs may be cloned. */
  readonly gitNetwork?: Pick<GitNetworkShape, "classifyRemoteUrl" | "sanitizeRemoteUrl">;
  /** `copyProjectToNode`: the other nodes owner clients published. */
  readonly nodeDirectory?: Pick<AgentControlNodeDirectoryShape, "list">;
  readonly thisEnvironmentId?: Effect.Effect<EnvironmentId>;
  /** Whether this node offers chats without a project now; absent: it never does. */
  readonly chats?: Effect.Effect<ServerChatsCapability>;
  /** Whether a chat is a delegated one whose result its delegating chat still waits for. */
  readonly delegatedReturnPending?: (
    threadId: ThreadId,
  ) => Effect.Effect<boolean, AgentControlPlanValidationError>;
  /**
   * Why the person's delegation limits refuse `newTasks` more tasks from this chat, or null.
   * Absent: no limits apply.
   */
  readonly delegationLimitRefusal?: (input: {
    readonly callerThreadId: ThreadId;
    readonly newTasks: number;
  }) => Effect.Effect<string | null, AgentControlPlanValidationError>;
}): AgentControlActionValidatorShape => {
  const validateAutomation = <A, E>(effect: Effect.Effect<A, E>) =>
    effect.pipe(
      Effect.mapError((error) =>
        typeof error === "object" &&
        error !== null &&
        "_tag" in error &&
        error._tag === "AgentControlPlanValidationError"
          ? (error as unknown as AgentControlPlanValidationError)
          : new AgentControlPlanValidationError({
              reason: "automation-unavailable",
              detail: "Automation state is unavailable.",
            }),
      ),
    );
  /** An automation without a project needs the node to offer chats when it is set up. */
  const requireChatsForAutomation = (execution: AgentControlAutomationExecutionTemplate) =>
    Effect.gen(function* () {
      if (!isChatsAutomationScope(execution.projectId)) return;
      const chats = deps.chats === undefined ? undefined : yield* deps.chats;
      if (chats?.available !== true) {
        return yield* fail(
          "project-unavailable",
          describeChatsUnavailable(chats?.unavailableReason),
        );
      }
    });

  // Every live project (plans may create threads in other projects) and the summaries of the
  // threads this validation names: no whole shell snapshot per tool call.
  const loadState = (threadIds: ReadonlyArray<string>) =>
    Effect.all({
      projects: readProjectShells(deps.projections),
      scoped: readScopedShellSnapshot(deps.projections, {
        threadIds: [...new Set(threadIds)].map((threadId) => ThreadId.make(threadId)),
      }),
      providers: deps.getProviders,
    }).pipe(
      Effect.map(({ projects, scoped, providers }) => ({
        snapshot: { ...scoped, projects } satisfies OrchestrationShellSnapshot,
        providers,
      })),
      Effect.mapError(
        () =>
          new AgentControlPlanValidationError({
            reason: "project-unavailable",
            detail: "Current Ryco state is unavailable.",
          }),
      ),
    );

  const requireBaseRef = (cwd: string, baseRef: string) =>
    deps.listRefs({ cwd, query: baseRef, limit: 200 }).pipe(
      Effect.mapError(
        () =>
          new AgentControlPlanValidationError({
            reason: "worktree-preflight",
            detail: "The requested worktree base ref could not be verified.",
          }),
      ),
      Effect.flatMap((result) =>
        result.refs.some((ref) => ref.name === baseRef)
          ? Effect.void
          : fail("worktree-preflight", "The requested worktree base ref is unavailable."),
      ),
    );

  // Every entry's artifacts must still be the source thread's own: checked at submission and
  // again before execution, since a revert can drop them in between.
  const validateHandoffArtifacts = (plan: AgentControlActionPlan, sourceThreadId: ThreadId) =>
    plan.kind !== "createThreads"
      ? Effect.void
      : Effect.forEach(
          plan.entries,
          (entry) =>
            entry.artifacts && entry.artifacts.length > 0
              ? resolveThreadArtifacts(deps.projections, sourceThreadId, entry.artifacts).pipe(
                  Effect.mapError(
                    (error) =>
                      new AgentControlPlanValidationError({
                        reason: "artifact-unavailable",
                        detail: error.detail,
                      }),
                  ),
                )
              : Effect.void,
          { discard: true },
        );

  const readLocalTask = (taskId: string) =>
    deps.localTasks === undefined
      ? fail("task-unavailable", "Tasks are unavailable on this node.")
      : deps.localTasks.get(taskId).pipe(
          Effect.mapError(
            (error) =>
              new AgentControlPlanValidationError({
                reason: "task-unavailable",
                detail: error.reason === "not-found" ? "The task is unavailable." : error.message,
              }),
          ),
        );

  // A task's chat starts in the task's project (one without a project joins the chat's), and
  // never from a completed task: checked at submission and again before execution.
  const validateLocalTaskStarts = (plan: AgentControlActionPlan) =>
    plan.kind !== "createThreads"
      ? Effect.void
      : Effect.forEach(
          plan.entries,
          (entry) =>
            entry.localTaskId === undefined
              ? Effect.void
              : (entry.artifacts?.length ?? 0) > 0
                ? fail(
                    "invalid-plan",
                    "A task's chat carries the task's files; it cannot also hand over artifacts.",
                  )
                : readLocalTask(entry.localTaskId).pipe(
                    Effect.flatMap((task) =>
                      task.state === "done"
                        ? fail("task-stale", "Reopen the task before starting a chat.")
                        : task.projectId !== null && task.projectId !== entry.projectId
                          ? fail("project-scope", "The task belongs to another project.")
                          : Effect.void,
                    ),
                  ),
          { discard: true },
        );

  // The user approves deleting exactly the revision the card showed.
  const validateLocalTaskDelete = (
    plan: Extract<AgentControlActionPlan, { kind: "deleteLocalTask" }>,
  ) =>
    readLocalTask(plan.taskId).pipe(
      Effect.flatMap((task) =>
        task.revision !== plan.expectedRevision
          ? fail("task-stale", "The task changed since the delete was requested; read it again.")
          : Effect.void,
      ),
    );

  // A clone source: https, ssh or scp-style only (plain http is refused), and already stripped of
  // credentials, since the plan is stored and shown to every owner client.
  const validateCloneRemoteUrl = (remoteUrl: string) => {
    const gitNetwork = deps.gitNetwork;
    if (gitNetwork === undefined)
      return fail("invalid-plan", "Repository URLs cannot be checked on this node.");
    return Effect.try({
      try: () => ({
        kind: gitNetwork.classifyRemoteUrl(remoteUrl),
        sanitized: gitNetwork.sanitizeRemoteUrl(remoteUrl),
      }),
      catch: () =>
        new AgentControlPlanValidationError({
          reason: "invalid-plan",
          detail: "Repository URLs cannot be checked on this node.",
        }),
    }).pipe(
      Effect.flatMap(({ kind, sanitized }) =>
        kind === "http"
          ? fail(
              "invalid-plan",
              "Plain http repositories are not cloned; use the https or ssh URL.",
            )
          : kind !== "https" && kind !== "ssh" && kind !== "scp"
            ? fail(
                "invalid-plan",
                "The repository URL must be an https, ssh or scp-style (git@host:owner/repo) remote.",
              )
            : sanitized !== remoteUrl
              ? fail("invalid-plan", "The repository URL must not carry credentials.")
              : Effect.void,
      ),
    );
  };

  const validateImportProject = (
    plan: Extract<AgentControlActionPlan, { kind: "importProject" }>,
    origin: { readonly runtimeMode: RuntimeMode; readonly envMode: "local" | "worktree" },
    snapshot: OrchestrationShellSnapshot,
    providers: ReadonlyArray<ServerProvider>,
  ) =>
    Effect.gen(function* () {
      if (snapshot.projects.some((project) => project.id === plan.projectId)) {
        return yield* fail("project-stale", "The requested project identifier is already in use.");
      }
      yield* validateCloneRemoteUrl(plan.remoteUrl);
      if (deps.nodePaths === undefined) {
        return yield* fail(
          "project-unavailable",
          "Project destinations cannot be checked on this node.",
        );
      }
      // The folder the user approves is the folder the clone lands in: still free, still the
      // same canonical path, still where turns may run.
      const judgement = yield* deps.nodePaths
        .judgeProjectDestination({ path: plan.destinationPath, intent: "create" })
        .pipe(
          Effect.mapError(
            (error) =>
              new AgentControlPlanValidationError({
                reason: "invalid-plan",
                detail: error.message,
              }),
          ),
        );
      if (!judgement.usable) {
        return yield* fail("invalid-plan", describeProjectDestinationProblem(judgement.preview));
      }
      if (judgement.canonicalPath !== plan.destinationPath) {
        return yield* fail(
          "project-stale",
          "The destination folder resolves elsewhere now; propose the import again.",
        );
      }
      yield* validateFollowUpThread(plan.followUpThread, origin);
      if (plan.followUpThread !== null) {
        yield* providerForSelection(providers, plan.followUpThread.modelSelection);
      }
    });

  const validateCopyProjectToNode = (
    plan: Extract<AgentControlActionPlan, { kind: "copyProjectToNode" }>,
    origin: { readonly runtimeMode: RuntimeMode; readonly envMode: "local" | "worktree" },
    snapshot: OrchestrationShellSnapshot,
    phase: "submission" | "execution",
  ) =>
    Effect.gen(function* () {
      if (plan.source.kind === "project") {
        const sourceProjectId = plan.source.projectId;
        const project = snapshot.projects.find((candidate) => candidate.id === sourceProjectId);
        if (!project) {
          return yield* fail("project-unavailable", "The project to copy is unavailable.");
        }
        if (isChatProject(project)) {
          return yield* fail(
            "invalid-plan",
            "A chat cannot be copied to another node; turn it into a project first.",
          );
        }
        if (project.updatedAt !== plan.source.expectedUpdatedAt) {
          return yield* fail(
            "project-stale",
            "The project changed after the copy was requested; request it again.",
          );
        }
      } else {
        yield* validateCloneRemoteUrl(plan.source.remoteUrl);
        if (plan.bringCommits || plan.bringChanges || plan.copySettings) {
          return yield* fail(
            "invalid-plan",
            "Only a project on this node has commits, changes and settings to bring along.",
          );
        }
      }

      const thisEnvironmentId =
        deps.thisEnvironmentId === undefined ? null : yield* deps.thisEnvironmentId;
      const sameNode = `${plan.target.label} is this node; set the repository up here with ryco_propose_project_import instead.`;
      if (plan.target.environmentId === thisEnvironmentId) {
        return yield* fail("invalid-plan", sameNode);
      }
      if (deps.nodeDirectory === undefined) {
        return yield* fail("invalid-plan", "This node keeps no directory of other nodes.");
      }
      const directory = yield* deps.nodeDirectory.list().pipe(
        Effect.mapError(
          (error) =>
            new AgentControlPlanValidationError({
              reason: "invalid-plan",
              detail:
                error.reason === "unavailable"
                  ? "This node keeps no directory of other nodes."
                  : "The node directory could not be read.",
            }),
        ),
      );
      const entry = directory.nodes.find(
        (candidate) => candidate.environmentId === plan.target.environmentId,
      );
      if (entry === undefined) {
        return yield* fail(
          "invalid-plan",
          `${plan.target.label} is not in this node's directory. Open Ryco on a device connected to that node so it can publish its node list.`,
        );
      }
      if (entry.isThisNode) return yield* fail("invalid-plan", sameNode);
      if (entry.projectCopySupport === "no") {
        return yield* fail("invalid-plan", `Update Ryco on ${entry.label} to copy projects there.`);
      }
      // The card shows the label the agent named: it must be the directory's when proposed.
      // A rename before approval does not invalidate the target.
      if (phase === "submission" && entry.label !== plan.target.label) {
        return yield* fail(
          "invalid-plan",
          "The target's label does not match the node directory; list the nodes again.",
        );
      }

      if (plan.destination.kind === "path" && hasParentDirectorySegment(plan.destination.path)) {
        return yield* fail("invalid-plan", "The destination path must not contain '..'.");
      }
      // Its model belongs to the target (null takes the target's default): resolved and shown
      // by the approving client, then checked by the target.
      yield* validateFollowUpThread(plan.followUpThread, origin);
    });

  const validateProjectCopyPlan = (
    plan: AgentControlProjectCopyPlan,
    origin: { readonly runtimeMode: RuntimeMode; readonly envMode: "local" | "worktree" },
    snapshot: OrchestrationShellSnapshot,
    providers: ReadonlyArray<ServerProvider>,
    phase: "submission" | "execution",
  ) =>
    plan.kind === "importProject"
      ? validateImportProject(plan, origin, snapshot, providers)
      : validateCopyProjectToNode(plan, origin, snapshot, phase);
  /**
   * A delegated chat whose result is still awaited never watches a pull request, and no chat
   * makes it watch one: it reports the pull request in its result, and the delegating chat (the
   * one Ryco then wakes) decides whether to watch it. Read from the completion-return ledger.
   */
  const refuseAwaitedDelegation = (plan: AgentControlActionPlan, callerThreadId: ThreadId) =>
    (plan.kind !== "worktreeHandoff" && (plan.kind !== "pullRequestWatch" || !plan.watching)) ||
    deps.delegatedReturnPending === undefined
      ? Effect.void
      : Effect.forEach(
          [...new Set([callerThreadId, plan.threadId])],
          (threadId) =>
            deps.delegatedReturnPending!(threadId).pipe(
              Effect.flatMap((pending) =>
                !pending
                  ? Effect.void
                  : fail(
                      "delegated-return-pending",
                      // Its result returns with this turn, before the moved chat's next one.
                      plan.kind === "worktreeHandoff"
                        ? "This chat was delegated by another chat that waits for its result, so it cannot move into a worktree."
                        : threadId === callerThreadId
                          ? "This chat was delegated by another chat that waits for its result. Report the pull request in your result; the delegating chat decides whether to watch it."
                          : "That chat was delegated by another chat that waits for its result: it reports its pull request, and the delegating chat watches it.",
                    ),
              ),
            ),
          { discard: true },
        );

  /**
   * The opt-in delegation limits: a provider thread's createThreads plan creates delegated tasks.
   * `newTasks` is the batch at submission. Revalidation runs before each create of an executing
   * batch, whose earlier tasks already count, so it passes 0 (depth, and a tree already over its
   * budget); the decider checks each create against the budget.
   */
  const refuseOverDelegationLimits = (
    plan: AgentControlActionPlan,
    callerThreadId: ThreadId,
    newTasks: number,
  ) =>
    plan.kind !== "createThreads" || deps.delegationLimitRefusal === undefined
      ? Effect.void
      : deps
          .delegationLimitRefusal({ callerThreadId, newTasks })
          .pipe(
            Effect.flatMap((refusal) =>
              refusal === null ? Effect.void : fail("delegation-limit", refusal),
            ),
          );

  const validateSubmission: AgentControlActionValidatorShape["validateSubmission"] = (input) =>
    Effect.gen(function* () {
      const { snapshot, providers } = yield* loadState([
        input.session.threadId,
        ...targetThreadIds(input.plan),
      ]);
      const caller = snapshot.threads.find((thread) => thread.id === input.session.threadId);
      if (
        !caller ||
        caller.archivedAt !== null ||
        caller.session?.status !== "running" ||
        caller.session.activeTurnId !== input.authority.turnId ||
        input.authority.sessionId !== input.session.sessionId ||
        input.authority.threadId !== input.session.threadId ||
        caller.session.providerInstanceId !== input.session.providerInstanceId ||
        caller.session.runtimeSessionId !== input.session.runtimeSessionId
      ) {
        return yield* fail("caller-stale", "Exact active-turn write authority is unavailable.");
      }

      const originEnvMode = agentControlThreadEnvMode(caller);
      if (input.plan.kind === "automationRun") {
        return yield* fail("invalid-plan", "Scheduled run proposals are server-owned.");
      }
      if (isAgentControlDevicePlan(input.plan) || input.plan.kind === "deviceControlConsent") {
        // Proposal submission validates immutable scope and bounded input only.
        // Authoritative device state is deliberately read only after approval (a consent's
        // attachment is also checked by ryco_device before it asks).
        if (input.plan.kind === "deviceControlConsent" && deps.deviceService?.supported !== true) {
          return yield* fail(
            "invalid-plan",
            "Simulator or emulator device control is unavailable.",
          );
        }
        yield* validateDevicePlanScope(input.plan, {
          originThreadId: caller.id,
          originProjectId: caller.projectId,
          originProviderInstanceId: input.session.providerInstanceId,
        });
      } else if (isAutomationLifecyclePlan(input.plan)) {
        if (deps.automations === undefined) {
          return yield* fail("automation-unavailable", "Automation control is unavailable.");
        }
        if (agentPlanRunsUnattended(input.plan)) {
          return yield* fail("privilege-escalation", UNATTENDED_OWNER_ONLY);
        }
        if (planAddsWebhookTrigger(input.plan)) {
          return yield* fail("privilege-escalation", WEBHOOK_OWNER_ONLY);
        }
        yield* validateAutomation(deps.automations.validateLifecyclePlan(input.plan));
        // A chat without a project schedules in the node's "No project" scope.
        const callerScope = automationScopeOfProject(
          caller.projectId,
          snapshot.projects.find((project) => project.id === caller.projectId),
        );
        const automation =
          input.plan.kind === "createAutomation"
            ? undefined
            : yield* validateAutomation(
                deps.automations.get(input.plan.automationId, {
                  projectId: callerScope,
                  providerInstanceId: input.session.providerInstanceId,
                }),
              );
        const definition =
          input.plan.kind === "cancelAutomation"
            ? automation!.definition
            : automationDefinitionForPlan(input.plan);
        if (
          definition.execution.projectId !== callerScope ||
          definition.execution.modelSelection.instanceId !== input.session.providerInstanceId
        ) {
          return yield* fail(
            "project-scope",
            "Automation project and provider must match the exact provider session.",
          );
        }
        if (input.plan.kind !== "cancelAutomation") {
          yield* requireChatsForAutomation(definition.execution);
        }
        yield* validatePlanAgainstSnapshot({
          plan: { kind: "createThreads", entries: [definition.execution] },
          originProjectId: callerScope,
          originRuntimeMode: caller.runtimeMode,
          originEnvMode,
          snapshot,
          providers,
          requireBaseRef,
        });
        if (input.plan.kind !== "cancelAutomation" && lifecycleTargetChecked(input.plan, false)) {
          yield* validateAutomationTarget(definition.execution, snapshot, {
            originThreadId: caller.id,
            originProjectId: caller.projectId,
            originRuntimeMode: caller.runtimeMode,
            originEnvMode,
            providers,
            requireBaseRef,
          });
        }
      } else if (input.plan.kind === "worktreeHandoff") {
        yield* validateWorktreeHandoff(input.plan, caller.id);
        yield* refuseAwaitedDelegation(input.plan, caller.id);
      } else if (input.plan.kind === "changeSettings") {
        // Closed schema: only non-secret boolean preferences are supported.
      } else if (input.plan.kind === "deleteLocalTask") {
        // Tasks are the node's own list, not one project's: no project scope applies.
        yield* validateLocalTaskDelete(input.plan);
      } else if (isAgentControlProjectCopyPlan(input.plan)) {
        // A new project here, or any non-chat project of this node copied to another node: no
        // project scope applies, the user approves the exact folder, source and target.
        yield* validateProjectCopyPlan(
          input.plan,
          { runtimeMode: caller.runtimeMode, envMode: originEnvMode },
          snapshot,
          providers,
          "submission",
        );
      } else if (input.plan.kind === "workspaceLifecycle") {
        if (!deps.workspaces || input.plan.projectId !== caller.projectId)
          return yield* fail("project-scope", "Workspace control unavailable in caller scope.");
        yield* deps.workspaces.revalidate(input.plan, caller.id);
      } else if (isProjectPlan(input.plan)) {
        if (deps.projectPlans === undefined) {
          return yield* fail("project-unavailable", "Project proposal validation is unavailable.");
        }
        if (input.plan.kind !== "createProject" && input.plan.projectId !== caller.projectId) {
          return yield* fail("project-scope", "The requested project is outside caller scope.");
        }
        yield* deps.projectPlans.revalidate(input.plan);
      } else {
        yield* validatePlanAgainstSnapshot({
          plan: input.plan,
          originThreadId: caller.id,
          originProjectId: caller.projectId,
          originRuntimeMode: caller.runtimeMode,
          originEnvMode,
          snapshot,
          providers,
          requireBaseRef,
        });
        yield* validateLocalTaskStarts(input.plan);
        yield* validateHandoffArtifacts(input.plan, caller.id);
        yield* refuseAwaitedDelegation(input.plan, caller.id);
        yield* refuseOverDelegationLimits(
          input.plan,
          caller.id,
          input.plan.kind === "createThreads" ? input.plan.entries.length : 0,
        );
      }

      const targetSnapshots: Array<
        NonNullable<AgentControlProviderSessionPrincipal["targetSnapshots"]>[number]
      > = [];
      for (const threadId of targetThreadIds(input.plan)) {
        targetSnapshots.push(
          agentControlTargetSnapshotOf(yield* requireThread(snapshot, threadId)),
        );
      }

      return {
        kind: "provider-session",
        threadId: input.session.threadId,
        providerInstanceId: input.session.providerInstanceId,
        runtimeSessionId: input.session.runtimeSessionId,
        turnId: input.authority.turnId,
        originProjectId: caller.projectId,
        originRuntimeMode: caller.runtimeMode,
        originEnvMode,
        targetSnapshots,
      } satisfies AgentControlProviderSessionPrincipal;
    });

  const validateExternalSubmission: AgentControlActionValidatorShape["validateExternalSubmission"] =
    (input) =>
      Effect.gen(function* () {
        // Checked first, so neither kind ever falls through to another kind's checks.
        if (isAgentControlProjectCopyPlan(input.plan)) {
          return yield* fail(
            "privilege-escalation",
            "External integrations cannot set up or copy projects.",
          );
        }
        if (
          input.plan.kind === "createThreads" &&
          input.plan.entries.some((entry) => entry.returnToOrigin)
        ) {
          return yield* fail(
            "invalid-plan",
            "Completion return requires an originating provider turn; external tasks cannot opt in.",
          );
        }
        if (handsOverArtifacts(input.plan)) {
          return yield* fail(
            "invalid-plan",
            "Artifact handover requires an originating provider thread; external tasks cannot hand over artifacts.",
          );
        }
        if (startsLocalTaskChats(input.plan) || input.plan.kind === "deleteLocalTask") {
          return yield* fail(
            "privilege-escalation",
            "External integrations cannot manage the node's Tasks.",
          );
        }
        if (input.plan.kind === "pullRequestWatch" || input.plan.kind === "worktreeHandoff") {
          return yield* fail(
            "privilege-escalation",
            "External integrations cannot watch pull requests or move chats.",
          );
        }
        if (isAgentControlDevicePlan(input.plan) || input.plan.kind === "deviceControlConsent") {
          return yield* fail(
            "privilege-escalation",
            "External integrations cannot control devices.",
          );
        }
        if (isAutomationLifecyclePlan(input.plan)) {
          if (
            deps.automations === undefined ||
            !input.integration.capabilities.includes(
              AGENT_CONTROL_CAPABILITIES.externalManageAutomations,
            ) ||
            !input.integration.capabilities.includes(AGENT_CONTROL_CAPABILITIES.externalCreateTask)
          ) {
            return yield* fail("privilege-escalation", "External automation authority is absent.");
          }
          if (agentPlanRunsUnattended(input.plan)) {
            return yield* fail("privilege-escalation", UNATTENDED_OWNER_ONLY);
          }
          if (planAddsWebhookTrigger(input.plan)) {
            return yield* fail("privilege-escalation", WEBHOOK_OWNER_ONLY);
          }
          yield* validateAutomation(deps.automations.validateLifecyclePlan(input.plan));
          const definition =
            input.plan.kind === "createAutomation"
              ? input.plan.definition
              : input.plan.kind === "updateAutomation"
                ? input.plan.after
                : input.plan.expected.definition;
          const scopeAllowed =
            !isChatsAutomationScope(definition.execution.projectId) &&
            (input.integration.projectScope.kind === "all" ||
              input.integration.projectScope.projectIds.includes(definition.execution.projectId));
          if (!scopeAllowed) {
            return yield* fail("project-scope", "Automation project is outside integration scope.");
          }
          if (
            (definition.execution.envMode === "local" &&
              !input.integration.capabilities.includes(
                AGENT_CONTROL_CAPABILITIES.externalSharedCheckout,
              )) ||
            (definition.execution.runtimeMode === "full-access" &&
              !input.integration.capabilities.includes(
                AGENT_CONTROL_CAPABILITIES.externalFullAccess,
              ))
          ) {
            return yield* fail("privilege-escalation", "Automation execution scope is denied.");
          }
          const { snapshot, providers } = yield* loadState(
            automationTargetThreadIds(definition.execution),
          );
          yield* validatePlanAgainstSnapshot({
            plan: { kind: "createThreads", entries: [definition.execution] },
            originProjectId: definition.execution.projectId,
            originRuntimeMode: definition.execution.runtimeMode,
            originEnvMode: definition.execution.envMode,
            snapshot,
            providers,
            requireBaseRef,
          });
          if (
            input.plan.kind !== "cancelAutomation" &&
            definition.execution.target !== undefined &&
            lifecycleTargetChecked(input.plan, false)
          ) {
            // Thread control, within the integration's ceiling and the definition's own modes.
            if (
              !input.integration.capabilities.includes(
                AGENT_CONTROL_CAPABILITIES.externalControlThreads,
              )
            ) {
              return yield* fail(
                "privilege-escalation",
                "External thread control authority is absent.",
              );
            }
            const ceiling = lowerSendCeiling(
              agentControlExternalCeiling(input.integration),
              definition.execution,
            );
            yield* validateAutomationTarget(definition.execution, snapshot, {
              originProjectId: definition.execution.projectId,
              originRuntimeMode: ceiling.runtimeMode,
              originEnvMode: ceiling.envMode,
              providers,
              requireBaseRef,
            });
          }
          return {
            kind: "external-integration",
            integrationId: input.integration.integrationId,
            label: input.integration.displayName,
            projectId: definition.execution.projectId,
            runtimeMode: definition.execution.runtimeMode,
            envMode: definition.execution.envMode,
          };
        }
        const scopeAllows = (projectId: string) =>
          input.integration.projectScope.kind === "all" ||
          input.integration.projectScope.projectIds.some((allowed) => allowed === projectId);
        if (isThreadControlPlan(input.plan)) {
          const plan = input.plan;
          if (
            !input.integration.capabilities.includes(
              AGENT_CONTROL_CAPABILITIES.externalControlThreads,
            )
          ) {
            return yield* fail(
              "privilege-escalation",
              "External thread control authority is absent.",
            );
          }
          const { snapshot, providers } = yield* loadState([plan.threadId]);
          const target = snapshot.threads.find((thread) => thread.id === plan.threadId);
          // An out-of-scope target is reported exactly like a missing one.
          if (!target || !scopeAllows(target.projectId)) {
            return yield* fail("thread-unavailable", "Target thread is unavailable.");
          }
          const ceiling = agentControlExternalCeiling(input.integration);
          yield* validatePlanAgainstSnapshot({
            plan,
            originProjectId: target.projectId,
            originRuntimeMode: ceiling.runtimeMode,
            originEnvMode: ceiling.envMode,
            snapshot,
            providers,
            requireBaseRef,
          });
          return {
            kind: "external-integration",
            integrationId: input.integration.integrationId,
            label: input.integration.displayName,
            projectId: target.projectId,
            runtimeMode: ceiling.runtimeMode,
            envMode: ceiling.envMode,
            targetSnapshots: [agentControlTargetSnapshotOf(target)],
          };
        }
        if (input.plan.kind === "workspaceLifecycle") {
          if (
            deps.workspaces === undefined ||
            !input.integration.capabilities.includes(
              AGENT_CONTROL_CAPABILITIES.externalManageWorkspaces,
            )
          ) {
            return yield* fail(
              "privilege-escalation",
              "External workspace lifecycle authority is absent.",
            );
          }
          if (!scopeAllows(input.plan.projectId)) {
            return yield* fail("project-scope", "Workspace control unavailable in caller scope.");
          }
          yield* deps.workspaces.revalidate(input.plan, null);
          return {
            kind: "external-integration",
            integrationId: input.integration.integrationId,
            label: input.integration.displayName,
            projectId: input.plan.projectId,
            runtimeMode: "approval-required",
            envMode: "worktree",
          };
        }
        if (input.plan.kind !== "createThreads" || input.plan.entries.length !== 1) {
          return yield* fail("invalid-plan", "External integrations may request exactly one task.");
        }
        const entry = input.plan.entries[0]!;
        const { snapshot, providers } = yield* loadState([]);
        yield* validatePlanAgainstSnapshot({
          plan: input.plan,
          originProjectId: entry.projectId,
          originRuntimeMode: entry.runtimeMode,
          originEnvMode: entry.envMode,
          snapshot,
          providers,
          requireBaseRef,
        });
        return {
          kind: "external-integration",
          integrationId: input.integration.integrationId,
          label: input.integration.displayName,
          projectId: entry.projectId,
          runtimeMode: entry.runtimeMode,
          envMode: entry.envMode,
        };
      });

  const validateOwnerAutomation: AgentControlActionValidatorShape["validateOwnerAutomation"] = (
    plan,
  ) =>
    Effect.gen(function* () {
      if (deps.automations === undefined)
        return yield* fail("automation-unavailable", "Automation control is unavailable.");
      yield* validateAutomation(deps.automations.validateLifecyclePlan(plan));
      if (plan.kind === "cancelAutomation") return;
      const definition = plan.kind === "createAutomation" ? plan.definition : plan.after;
      yield* requireChatsForAutomation(definition.execution);
      const { snapshot, providers } = yield* loadState(
        automationTargetThreadIds(definition.execution),
      );
      yield* validatePlanAgainstSnapshot({
        plan: { kind: "createThreads", entries: [definition.execution] },
        originProjectId: definition.execution.projectId,
        originRuntimeMode: definition.execution.runtimeMode,
        originEnvMode: definition.execution.envMode,
        snapshot,
        providers,
        requireBaseRef,
      });
      if (lifecycleTargetChecked(plan, true)) {
        yield* validateAutomationTarget(definition.execution, snapshot);
      }
    });

  const revalidateExecution: AgentControlActionValidatorShape["revalidateExecution"] = (
    proposal: AgentControlProposal,
    options,
  ) =>
    Effect.gen(function* () {
      if (
        isAgentControlProjectCopyPlan(proposal.plan) &&
        proposal.principal.kind !== "provider-session"
      ) {
        return yield* fail(
          "privilege-escalation",
          "Only an agent thread on this node can set up or copy projects.",
        );
      }
      if (
        proposal.plan.kind === "createThreads" &&
        proposal.plan.entries.some((entry) => entry.returnToOrigin) &&
        (proposal.principal.kind !== "provider-session" ||
          !proposal.principal.turnId ||
          !proposal.principal.runtimeSessionId)
      ) {
        return yield* fail(
          "invalid-plan",
          "Completion return requires an exact originating provider turn and runtime.",
        );
      }
      const originProjectId =
        proposal.principal.kind === "provider-session"
          ? proposal.principal.originProjectId
          : proposal.principal.projectId;
      const originRuntimeMode =
        proposal.principal.kind === "provider-session"
          ? proposal.principal.originRuntimeMode
          : proposal.principal.runtimeMode;
      const originEnvMode =
        proposal.principal.kind === "provider-session"
          ? proposal.principal.originEnvMode
          : proposal.principal.envMode;
      if (
        originProjectId === undefined ||
        originRuntimeMode === undefined ||
        originEnvMode === undefined
      ) {
        return yield* fail("caller-stale", "Proposal origin evidence is incomplete.");
      }
      const principal = proposal.principal;
      const { snapshot, providers } = yield* loadState([
        ...("threadId" in principal ? [principal.threadId] : []),
        ...targetThreadIds(proposal.plan),
        ...agentControlTargetSnapshots(principal).map((target) => target.threadId),
      ]);
      let externalCeiling: ReturnType<typeof agentControlExternalCeiling> | undefined;
      if (principal.kind === "provider-session") {
        const origin = snapshot.threads.find((thread) => thread.id === principal.threadId);
        if (!origin || origin.projectId !== originProjectId) {
          return yield* fail("caller-stale", "The originating thread is unavailable.");
        }
        yield* validateLocalTaskStarts(proposal.plan);
        yield* validateHandoffArtifacts(proposal.plan, principal.threadId);
        yield* refuseAwaitedDelegation(proposal.plan, principal.threadId);
        yield* refuseOverDelegationLimits(proposal.plan, principal.threadId, 0);
      } else if (
        proposal.plan.kind === "pullRequestWatch" ||
        proposal.plan.kind === "worktreeHandoff"
      ) {
        return yield* fail(
          "privilege-escalation",
          "Only an originating provider thread can watch pull requests or move itself.",
        );
      } else if (startsLocalTaskChats(proposal.plan) || proposal.plan.kind === "deleteLocalTask") {
        return yield* fail(
          "privilege-escalation",
          "Only an originating provider thread can manage the node's Tasks.",
        );
      } else if (proposal.plan.kind === "deviceControlConsent") {
        return yield* fail("privilege-escalation", "External integrations cannot control devices.");
      } else if (handsOverArtifacts(proposal.plan)) {
        return yield* fail(
          "privilege-escalation",
          "Only an originating provider thread can hand over its artifacts.",
        );
      } else if (principal.kind === "external-integration") {
        if (deps.revalidateExternal === undefined) {
          return yield* fail("caller-stale", "The external integration is unavailable.");
        }
        const checked = yield* Effect.exit(deps.revalidateExternal(principal.integrationId));
        if (checked._tag === "Failure") {
          return yield* fail("caller-stale", "The external integration is unavailable.");
        }
        const integration = checked.value;
        externalCeiling = agentControlExternalCeiling(integration);
        const scopeAllowed =
          integration.projectScope.kind === "all" ||
          integration.projectScope.projectIds.includes(originProjectId);
        const externalCapability =
          proposal.plan.kind === "automationRun" || isAutomationLifecyclePlan(proposal.plan)
            ? AGENT_CONTROL_CAPABILITIES.externalManageAutomations
            : isThreadControlPlan(proposal.plan)
              ? AGENT_CONTROL_CAPABILITIES.externalControlThreads
              : proposal.plan.kind === "workspaceLifecycle"
                ? AGENT_CONTROL_CAPABILITIES.externalManageWorkspaces
                : AGENT_CONTROL_CAPABILITIES.externalCreateTask;
        const requiresTaskCapability =
          proposal.plan.kind === "automationRun" || isAutomationLifecyclePlan(proposal.plan);
        // A heartbeat queues into an existing chat: thread control.
        const requiresThreadControl =
          (proposal.plan.kind === "automationRun" ||
            proposal.plan.kind === "createAutomation" ||
            proposal.plan.kind === "updateAutomation") &&
          automationDefinitionForPlan(proposal.plan).execution.target !== undefined;
        if (
          !scopeAllowed ||
          !integration.capabilities.includes(externalCapability) ||
          (requiresTaskCapability &&
            !integration.capabilities.includes(AGENT_CONTROL_CAPABILITIES.externalCreateTask)) ||
          (requiresThreadControl &&
            !integration.capabilities.includes(
              AGENT_CONTROL_CAPABILITIES.externalControlThreads,
            )) ||
          (originEnvMode === "local" &&
            !integration.capabilities.includes(
              AGENT_CONTROL_CAPABILITIES.externalSharedCheckout,
            )) ||
          (originRuntimeMode === "full-access" &&
            !integration.capabilities.includes(AGENT_CONTROL_CAPABILITIES.externalFullAccess))
        ) {
          return yield* fail("caller-stale", "External integration authority changed.");
        }
      }

      if (
        principal.kind === "automation-owner" &&
        !isAutomationLifecyclePlan(proposal.plan) &&
        proposal.plan.kind !== "automationRun"
      ) {
        return yield* fail(
          "privilege-escalation",
          "Owner automation authority only permits automation plans.",
        );
      }

      if (proposal.plan.kind === "changeSettings") {
        if (principal.kind !== "provider-session")
          return yield* fail(
            "privilege-escalation",
            "External integrations cannot change settings.",
          );
        return;
      }
      if (proposal.plan.kind === "deleteLocalTask") {
        yield* validateLocalTaskDelete(proposal.plan);
        return;
      }
      if (isAgentControlProjectCopyPlan(proposal.plan)) {
        // Provider-session only (checked above), against the caller's evidence at submission.
        yield* validateProjectCopyPlan(
          proposal.plan,
          { runtimeMode: originRuntimeMode, envMode: originEnvMode },
          snapshot,
          providers,
          "execution",
        );
        return;
      }
      if (proposal.plan.kind === "worktreeHandoff" && principal.kind === "provider-session") {
        yield* validateWorktreeHandoff(proposal.plan, principal.threadId);
        return;
      }
      if (
        isAgentControlDevicePlan(proposal.plan) ||
        proposal.plan.kind === "deviceControlConsent"
      ) {
        if (principal.kind !== "provider-session") {
          return yield* fail(
            "privilege-escalation",
            "External integrations cannot control devices.",
          );
        }
        const origin = snapshot.threads.find((thread) => thread.id === principal.threadId);
        if (proposal.plan.kind === "deviceControlConsent") {
          // Consent belongs to the exact task (turn) and runtime that asked: approving a
          // card after that task ended grants nothing.
          if (
            !origin ||
            principal.turnId === undefined ||
            principal.runtimeSessionId === undefined ||
            origin.session?.status !== "running" ||
            origin.session.activeTurnId !== principal.turnId ||
            origin.session.runtimeSessionId !== principal.runtimeSessionId ||
            origin.session.providerInstanceId !== principal.providerInstanceId
          ) {
            return yield* fail("caller-stale", "The task that asked has ended.");
          }
          yield* validateDevicePlanScope(proposal.plan, {
            originThreadId: principal.threadId,
            originProjectId,
            originProviderInstanceId: principal.providerInstanceId,
          });
          if (
            deps.deviceService?.supported !== true ||
            deps.deviceService.manager.exclusiveAttachment(
              proposal.plan.threadId,
              proposal.plan.udid,
            ) !== "exclusive"
          ) {
            return yield* fail(
              "thread-stale",
              "The device is no longer attached to this thread only.",
            );
          }
          return;
        }
        const project = snapshot.projects.find((candidate) => candidate.id === originProjectId);
        if (
          !origin ||
          !project ||
          origin.session?.providerInstanceId !== principal.providerInstanceId ||
          proposal.plan.providerInstanceId !== principal.providerInstanceId
        ) {
          return yield* fail("caller-stale", "The originating provider instance changed.");
        }
        yield* validateDevicePlanCurrentState(proposal.plan, {
          originThreadId: principal.threadId,
          originProjectId,
          originProviderInstanceId: principal.providerInstanceId,
          currentProjectUpdatedAt: project.updatedAt,
          deviceService: deps.deviceService,
        });
        return;
      }
      // A heartbeat's chat passes its proposer's send rules (an integration's within its grants).
      const senderCeiling =
        externalCeiling === undefined
          ? { runtimeMode: originRuntimeMode, envMode: originEnvMode }
          : lowerSendCeiling(externalCeiling, {
              runtimeMode: originRuntimeMode,
              envMode: originEnvMode,
            });
      const targetSender =
        principal.kind === "automation-owner"
          ? undefined
          : {
              ...(principal.kind === "provider-session"
                ? { originThreadId: principal.threadId }
                : {}),
              originProjectId,
              originRuntimeMode: senderCeiling.runtimeMode,
              originEnvMode: senderCeiling.envMode,
              providers,
              requireBaseRef,
            };
      // A chat without a project schedules in the node's "No project" scope.
      const automationScope = automationScopeOfProject(
        originProjectId,
        snapshot.projects.find((project) => project.id === originProjectId),
      );
      if (isAutomationLifecyclePlan(proposal.plan)) {
        if (deps.automations === undefined) {
          return yield* fail("automation-unavailable", "Automation control is unavailable.");
        }
        yield* validateAutomation(deps.automations.validateLifecyclePlan(proposal.plan));
        if (proposal.plan.kind === "cancelAutomation") {
          yield* validateAutomation(
            deps.automations.get(proposal.plan.automationId, { projectId: automationScope }),
          );
          return;
        }
        const definition = automationDefinitionForPlan(proposal.plan);
        yield* requireChatsForAutomation(definition.execution);
        yield* validatePlanAgainstSnapshot({
          plan: { kind: "createThreads", entries: [definition.execution] },
          originProjectId: automationScope,
          originRuntimeMode,
          originEnvMode,
          snapshot,
          providers,
          requireBaseRef,
        });
        if (lifecycleTargetChecked(proposal.plan, principal.kind === "automation-owner")) {
          yield* validateAutomationTarget(definition.execution, snapshot, targetSender);
        }
        return;
      }
      if (proposal.plan.kind === "automationRun") {
        if (deps.automations === undefined) {
          return yield* fail("automation-unavailable", "Automation control is unavailable.");
        }
        yield* validateAutomation(deps.automations.validateRun(proposal));
        yield* validatePlanAgainstSnapshot({
          plan: { kind: "createThreads", entries: [proposal.plan.execution] },
          originProjectId: automationScope,
          originRuntimeMode,
          originEnvMode,
          snapshot,
          providers,
          requireBaseRef,
        });
        yield* validateAutomationTarget(proposal.plan.execution, snapshot, targetSender);
        return;
      }
      if (proposal.plan.kind === "workspaceLifecycle") {
        // External integrations have no caller thread, so no workspace is their current one.
        const caller =
          principal.kind === "provider-session"
            ? principal.threadId
            : principal.kind === "external-integration"
              ? null
              : undefined;
        if (caller === undefined || !deps.workspaces || proposal.plan.projectId !== originProjectId)
          return yield* fail("project-scope", "Workspace control unavailable in caller scope.");
        yield* deps.workspaces.revalidate(proposal.plan, caller);
        return;
      }
      if (isProjectPlan(proposal.plan)) {
        if (principal.kind !== "provider-session") {
          return yield* fail("project-scope", "External integrations cannot manage projects.");
        }
        if (proposal.plan.kind !== "createProject" && proposal.plan.projectId !== originProjectId) {
          return yield* fail("project-scope", "The approved project is outside caller scope.");
        }
        if (deps.projectPlans === undefined) {
          return yield* fail("project-unavailable", "Project proposal validation is unavailable.");
        }
        yield* deps.projectPlans.revalidate(proposal.plan);
        return;
      }

      yield* validatePlanAgainstSnapshot({
        plan: proposal.plan,
        originThreadId: principal.kind === "provider-session" ? principal.threadId : undefined,
        originProjectId,
        originRuntimeMode,
        originEnvMode,
        snapshot,
        providers,
        requireBaseRef,
      });

      for (const expected of agentControlTargetSnapshots(principal)) {
        const current = snapshot.threads.find((thread) => thread.id === expected.threadId);
        if (!current) {
          return yield* fail("thread-unavailable", "The approved target thread was deleted.");
        }
        const commonChanged =
          current.projectId !== expected.projectId ||
          current.runtimeMode !== expected.runtimeMode ||
          agentControlThreadEnvMode(current) !== expected.envMode ||
          (current.archivedAt !== null) !== expected.archived;
        const activeTurnChanged =
          options?.allowTurnAdvance !== true &&
          (proposal.plan.kind === "interruptThread" ||
            (proposal.plan.kind === "sendMessage" && proposal.plan.delivery === "steer")) &&
          (current.session?.activeTurnId ?? null) !== expected.activeTurnId;
        if (commonChanged || activeTurnChanged) {
          return yield* fail("thread-stale", "The approved target thread state changed.");
        }
      }
    });

  return {
    validateOwnerAutomation,
    validateSubmission,
    validateExternalSubmission,
    revalidateExecution,
  } satisfies AgentControlActionValidatorShape;
};

const makeAgentControlActionValidator = Effect.gen(function* () {
  const projections = yield* ProjectionSnapshotQuery;
  const providerRegistry = yield* ProviderRegistry;
  const git = yield* GitWorkflowService;
  const externalIntegrations = yield* Effect.serviceOption(AgentControlExternalIntegrationService);
  const projectPlans = yield* AgentControlProjectPlans;
  const workspaces = yield* Effect.serviceOption(AgentControlWorkspaces);
  const automations = yield* Effect.serviceOption(AgentControlAutomationService);
  const deviceService = yield* Effect.serviceOption(DeviceService);
  const localTasks = yield* Effect.serviceOption(LocalTaskService);
  const nodePaths = yield* Effect.serviceOption(NodePaths);
  const gitNetwork = yield* Effect.serviceOption(GitNetwork);
  const nodeDirectory = yield* Effect.serviceOption(AgentControlNodeDirectory);
  const serverEnvironment = yield* Effect.serviceOption(ServerEnvironment);
  const completionReturns = yield* Effect.serviceOption(CompletionReturnRepository);
  const settings = yield* Effect.serviceOption(ServerSettingsService);
  const sql = yield* Effect.serviceOption(SqlClient.SqlClient);
  const chatFolders = yield* Effect.serviceOption(ChatFolders);
  return makeAgentControlActionValidatorFromDeps({
    projections,
    getProviders: providerRegistry.getProviders,
    listRefs: git.listRefs,
    projectPlans,
    ...(Option.isSome(workspaces) ? { workspaces: workspaces.value } : {}),
    ...(Option.isSome(deviceService) ? { deviceService: deviceService.value } : {}),
    ...(Option.isSome(automations) ? { automations: automations.value } : {}),
    ...(Option.isSome(localTasks) ? { localTasks: localTasks.value } : {}),
    ...(Option.isSome(nodePaths) ? { nodePaths: nodePaths.value } : {}),
    ...(Option.isSome(gitNetwork) ? { gitNetwork: gitNetwork.value } : {}),
    ...(Option.isSome(nodeDirectory) ? { nodeDirectory: nodeDirectory.value } : {}),
    ...(Option.isSome(chatFolders) ? { chats: chatFolders.value.capability } : {}),
    ...(Option.isSome(serverEnvironment)
      ? { thisEnvironmentId: serverEnvironment.value.getEnvironmentId }
      : {}),
    ...(Option.isSome(completionReturns)
      ? {
          delegatedReturnPending: (threadId: ThreadId) =>
            completionReturns.value.get(threadId).pipe(
              Effect.map((record) => record !== undefined && isPendingCompletionReturn(record)),
              // Fails closed: a watch never starts on a chat that may owe its result.
              Effect.mapError(
                () =>
                  new AgentControlPlanValidationError({
                    reason: "thread-unavailable",
                    detail: "Could not check whether the chat was delegated. Try again.",
                  }),
              ),
            ),
        }
      : {}),
    ...(Option.isSome(externalIntegrations)
      ? { revalidateExternal: externalIntegrations.value.revalidate }
      : {}),
    ...(Option.isSome(settings) && Option.isSome(sql)
      ? {
          delegationLimitRefusal: (input: {
            readonly callerThreadId: ThreadId;
            readonly newTasks: number;
          }) =>
            Effect.gen(function* () {
              const limits = (yield* settings.value.getSettings).agentControl.delegation;
              if (!hasDelegationLimits(limits)) return null;
              const check = yield* Effect.promise(() => import("../delegationLimitCheck.ts"));
              return yield* check.readDelegationLimitRefusal(sql.value, limits, input);
            }).pipe(
              // Fails closed: unreadable limits or lineage never let a request through.
              Effect.mapError(
                () =>
                  new AgentControlPlanValidationError({
                    reason: "thread-unavailable",
                    detail: "Could not check the delegation limits. Try again.",
                  }),
              ),
            ),
        }
      : {}),
  });
});

export const AgentControlActionValidatorLive = Layer.effect(
  AgentControlActionValidator,
  makeAgentControlActionValidator,
);
