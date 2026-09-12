import type {
  AgentControlActionPlan,
  AgentControlDeviceActionPlan,
  AgentControlProviderSessionPrincipal,
  AgentControlProposal,
  ModelSelection,
  OrchestrationShellSnapshot,
  OrchestrationThreadShell,
  RuntimeMode,
  ServerProvider,
} from "@ryco/contracts";
import { AGENT_CONTROL_CAPABILITIES } from "@ryco/contracts";
import { Effect, Layer, Option } from "effect";

import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { DeviceService, type DeviceServiceShape } from "../../device/Services/DeviceService.ts";
import type { ProjectionSnapshotQueryShape } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { GitWorkflowService } from "../../git/GitWorkflowService.ts";
import type { GitWorkflowServiceShape } from "../../git/GitWorkflowService.ts";
import { ProviderRegistry } from "../../provider/Services/ProviderRegistry.ts";
import { AgentControlPlanValidationError } from "../Errors.ts";
import { AgentControlAutomationService } from "../Services/AgentControlAutomation.ts";
import type { AgentControlAutomationShape } from "../Services/AgentControlAutomation.ts";
import { AgentControlProjectPlans } from "../Services/AgentControlProjectPlans.ts";
import type { AgentControlProjectPlansShape } from "../Services/AgentControlProjectPlans.ts";
import {
  AgentControlExternalIntegrationService,
  type AgentControlExternalIntegrationServiceError,
} from "../Services/AgentControlExternalIntegration.ts";
import {
  AgentControlActionValidator,
  agentControlThreadEnvMode,
  isAgentControlProviderReady,
  type AgentControlActionValidatorShape,
} from "../Services/AgentControlActionValidator.ts";
import { assertSafeAgentControlDeviceUrl, isAgentControlDevicePlan } from "../deviceControl.ts";

const fail = (
  reason: ConstructorParameters<typeof AgentControlPlanValidationError>[0]["reason"],
  detail: string,
) => Effect.fail(new AgentControlPlanValidationError({ reason, detail }));

const runtimeRank: Record<RuntimeMode, number> = {
  "approval-required": 0,
  "auto-accept-edits": 1,
  auto: 2,
  "full-access": 3,
};

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
      return [plan.threadId];
    default:
      return isAgentControlDevicePlan(plan) ? [plan.threadId] : [];
  }
};

const validateDevicePlanScope = (
  plan: AgentControlDeviceActionPlan,
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

    if (plan.kind === "deviceAttach") {
      if (threadState.attachedDeviceUdid !== null && threadState.attachedDeviceUdid !== plan.udid) {
        return yield* fail(
          "thread-stale",
          "The thread already has a different deliberate device attachment.",
        );
      }
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
    if (threadState.attachedDeviceUdid !== plan.udid) {
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

const validatePlanAgainstSnapshot = (input: {
  readonly plan: AgentControlActionPlan;
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
        if (runtimeRank[target.runtimeMode] > runtimeRank[input.originRuntimeMode]) {
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
        const project = input.snapshot.projects.find(
          (candidate) => candidate.id === entry.projectId,
        );
        if (!project) {
          return yield* fail("project-unavailable", "The requested project is unavailable.");
        }
        if (runtimeRank[entry.runtimeMode] > runtimeRank[input.originRuntimeMode]) {
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
      input.plan.kind !== "updateThread"
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
        input.plan.modelSelection === undefined &&
        input.plan.runtimeMode === undefined &&
        input.plan.interactionMode === undefined &&
        input.plan.tokenMode === undefined
      ) {
        return yield* fail("invalid-plan", "At least one supported thread update is required.");
      }
      if (input.plan.modelSelection !== undefined)
        yield* providerForSelection(input.providers, input.plan.modelSelection);
      if (
        input.plan.runtimeMode !== undefined &&
        runtimeRank[input.plan.runtimeMode] > runtimeRank[input.originRuntimeMode]
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
          input.plan.modelSelection !== undefined ||
          input.plan.runtimeMode !== undefined ||
          input.plan.interactionMode !== undefined ||
          input.plan.tokenMode !== undefined)
      ) {
        return yield* fail("thread-unavailable", "Archived thread metadata cannot be updated.");
      }
      return;
    }

    if (target.archivedAt !== null) {
      return yield* fail("thread-unavailable", "The target thread is archived.");
    }

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
  readonly projectPlans?: AgentControlProjectPlansShape;
  readonly automations?: AgentControlAutomationShape;
  readonly deviceService?: DeviceServiceShape;
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
  const loadState = Effect.all({
    snapshot: deps.projections.getShellSnapshot(),
    providers: deps.getProviders,
  }).pipe(
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

  const validateSubmission: AgentControlActionValidatorShape["validateSubmission"] = (input) =>
    Effect.gen(function* () {
      const { snapshot, providers } = yield* loadState;
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
      if (isAgentControlDevicePlan(input.plan)) {
        // Proposal submission validates immutable scope and bounded input only.
        // Authoritative device state is deliberately read only after approval.
        yield* validateDevicePlanScope(input.plan, {
          originThreadId: caller.id,
          originProjectId: caller.projectId,
          originProviderInstanceId: input.session.providerInstanceId,
        });
      } else if (isAutomationLifecyclePlan(input.plan)) {
        if (deps.automations === undefined) {
          return yield* fail("automation-unavailable", "Automation control is unavailable.");
        }
        yield* validateAutomation(deps.automations.validateLifecyclePlan(input.plan));
        const automation =
          input.plan.kind === "createAutomation"
            ? undefined
            : yield* validateAutomation(
                deps.automations.get(input.plan.automationId, {
                  projectId: caller.projectId,
                  providerInstanceId: input.session.providerInstanceId,
                }),
              );
        const definition =
          input.plan.kind === "cancelAutomation"
            ? automation!.definition
            : automationDefinitionForPlan(input.plan);
        if (
          definition.execution.projectId !== caller.projectId ||
          definition.execution.modelSelection.instanceId !== input.session.providerInstanceId
        ) {
          return yield* fail(
            "project-scope",
            "Automation project and provider must match the exact provider session.",
          );
        }
        yield* validatePlanAgainstSnapshot({
          plan: { kind: "createThreads", entries: [definition.execution] },
          originProjectId: caller.projectId,
          originRuntimeMode: caller.runtimeMode,
          originEnvMode,
          snapshot,
          providers,
          requireBaseRef,
        });
      } else if (input.plan.kind === "changeSettings") {
        // Closed schema: only non-secret boolean preferences are supported.
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
          originProjectId: caller.projectId,
          originRuntimeMode: caller.runtimeMode,
          originEnvMode,
          snapshot,
          providers,
          requireBaseRef,
        });
      }

      const targetSnapshots: Array<
        NonNullable<AgentControlProviderSessionPrincipal["targetSnapshots"]>[number]
      > = [];
      for (const threadId of targetThreadIds(input.plan)) {
        const target = yield* requireThread(snapshot, threadId);
        targetSnapshots.push({
          threadId: target.id,
          projectId: target.projectId,
          runtimeMode: target.runtimeMode,
          envMode: agentControlThreadEnvMode(target),
          archived: target.archivedAt !== null,
          activeTurnId: target.session?.activeTurnId ?? null,
        });
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
        if (isAgentControlDevicePlan(input.plan)) {
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
          yield* validateAutomation(deps.automations.validateLifecyclePlan(input.plan));
          const definition =
            input.plan.kind === "createAutomation"
              ? input.plan.definition
              : input.plan.kind === "updateAutomation"
                ? input.plan.after
                : input.plan.expected.definition;
          const scopeAllowed =
            input.integration.projectScope.kind === "all" ||
            input.integration.projectScope.projectIds.includes(definition.execution.projectId);
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
          const { snapshot, providers } = yield* loadState;
          yield* validatePlanAgainstSnapshot({
            plan: { kind: "createThreads", entries: [definition.execution] },
            originProjectId: definition.execution.projectId,
            originRuntimeMode: definition.execution.runtimeMode,
            originEnvMode: definition.execution.envMode,
            snapshot,
            providers,
            requireBaseRef,
          });
          return {
            kind: "external-integration",
            integrationId: input.integration.integrationId,
            label: input.integration.displayName,
            projectId: definition.execution.projectId,
            runtimeMode: definition.execution.runtimeMode,
            envMode: definition.execution.envMode,
          };
        }
        if (input.plan.kind !== "createThreads" || input.plan.entries.length !== 1) {
          return yield* fail("invalid-plan", "External integrations may request exactly one task.");
        }
        const entry = input.plan.entries[0]!;
        const { snapshot, providers } = yield* loadState;
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

  const revalidateExecution: AgentControlActionValidatorShape["revalidateExecution"] = (
    proposal: AgentControlProposal,
    options,
  ) =>
    Effect.gen(function* () {
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
      const { snapshot, providers } = yield* loadState;
      if (principal.kind === "provider-session") {
        const origin = snapshot.threads.find((thread) => thread.id === principal.threadId);
        if (!origin || origin.projectId !== originProjectId) {
          return yield* fail("caller-stale", "The originating thread is unavailable.");
        }
      } else {
        if (deps.revalidateExternal === undefined) {
          return yield* fail("caller-stale", "The external integration is unavailable.");
        }
        const checked = yield* Effect.exit(deps.revalidateExternal(principal.integrationId));
        if (checked._tag === "Failure") {
          return yield* fail("caller-stale", "The external integration is unavailable.");
        }
        const integration = checked.value;
        const scopeAllowed =
          integration.projectScope.kind === "all" ||
          integration.projectScope.projectIds.includes(originProjectId);
        const externalCapability =
          proposal.plan.kind === "automationRun"
            ? AGENT_CONTROL_CAPABILITIES.externalManageAutomations
            : isAutomationLifecyclePlan(proposal.plan)
              ? AGENT_CONTROL_CAPABILITIES.externalManageAutomations
              : AGENT_CONTROL_CAPABILITIES.externalCreateTask;
        const requiresTaskCapability =
          proposal.plan.kind === "automationRun" || isAutomationLifecyclePlan(proposal.plan);
        if (
          !scopeAllowed ||
          !integration.capabilities.includes(externalCapability) ||
          (requiresTaskCapability &&
            !integration.capabilities.includes(AGENT_CONTROL_CAPABILITIES.externalCreateTask)) ||
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

      if (proposal.plan.kind === "changeSettings") {
        if (principal.kind !== "provider-session")
          return yield* fail(
            "privilege-escalation",
            "External integrations cannot change settings.",
          );
        return;
      }
      if (isAgentControlDevicePlan(proposal.plan)) {
        if (principal.kind !== "provider-session") {
          return yield* fail(
            "privilege-escalation",
            "External integrations cannot control devices.",
          );
        }
        const origin = snapshot.threads.find((thread) => thread.id === principal.threadId);
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
      if (isAutomationLifecyclePlan(proposal.plan)) {
        if (deps.automations === undefined) {
          return yield* fail("automation-unavailable", "Automation control is unavailable.");
        }
        yield* validateAutomation(deps.automations.validateLifecyclePlan(proposal.plan));
        const definition =
          proposal.plan.kind === "cancelAutomation"
            ? (yield* validateAutomation(
                deps.automations.get(proposal.plan.automationId, {
                  projectId: originProjectId,
                }),
              )).definition
            : automationDefinitionForPlan(proposal.plan);
        yield* validatePlanAgainstSnapshot({
          plan: { kind: "createThreads", entries: [definition.execution] },
          originProjectId,
          originRuntimeMode,
          originEnvMode,
          snapshot,
          providers,
          requireBaseRef,
        });
        return;
      }
      if (proposal.plan.kind === "automationRun") {
        if (deps.automations === undefined) {
          return yield* fail("automation-unavailable", "Automation control is unavailable.");
        }
        yield* validateAutomation(deps.automations.validateRun(proposal));
        yield* validatePlanAgainstSnapshot({
          plan: { kind: "createThreads", entries: [proposal.plan.execution] },
          originProjectId,
          originRuntimeMode,
          originEnvMode,
          snapshot,
          providers,
          requireBaseRef,
        });
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
        originProjectId,
        originRuntimeMode,
        originEnvMode,
        snapshot,
        providers,
        requireBaseRef,
      });

      for (const expected of principal.kind === "provider-session"
        ? (principal.targetSnapshots ?? [])
        : []) {
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
  const automations = yield* Effect.serviceOption(AgentControlAutomationService);
  const deviceService = yield* Effect.serviceOption(DeviceService);
  return makeAgentControlActionValidatorFromDeps({
    projections,
    getProviders: providerRegistry.getProviders,
    listRefs: git.listRefs,
    projectPlans,
    ...(Option.isSome(deviceService) ? { deviceService: deviceService.value } : {}),
    ...(Option.isSome(automations) ? { automations: automations.value } : {}),
    ...(Option.isSome(externalIntegrations)
      ? { revalidateExternal: externalIntegrations.value.revalidate }
      : {}),
  });
});

export const AgentControlActionValidatorLive = Layer.effect(
  AgentControlActionValidator,
  makeAgentControlActionValidator,
);
