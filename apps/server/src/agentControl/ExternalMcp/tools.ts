import { createHash } from "node:crypto";

import {
  AGENT_CONTROL_AUTOMATION_MAX_ACTIVE_PER_PROJECT,
  AGENT_CONTROL_AUTOMATION_MAX_HORIZON_MS,
  AGENT_CONTROL_AUTOMATION_MIN_INTERVAL_MS,
  AGENT_CONTROL_AUTOMATION_RUN_HISTORY_MAX,
  AGENT_CONTROL_CAPABILITIES,
  AGENT_CONTROL_EXTERNAL_PROPOSAL_TTL_MS,
  AGENT_CONTROL_EXTERNAL_MCP_TOOL_NAMES,
  AGENT_CONTROL_EXTERNAL_MCP_TOOLS,
  AGENT_CONTROL_MCP_MODELS_PER_INSTANCE_MAX,
  AGENT_CONTROL_MCP_AUTOMATION_LIST_PROMPT_MAX_CHARS,
  AgentControlExternalCapabilitiesResult,
  AgentControlExternalCreateTaskInput,
  AgentControlExternalOverviewResult,
  AgentControlExternalTaskIdInput,
  AgentControlExternalWaitForTaskInput,
  AgentControlMcpListProjectsInput,
  AgentControlMcpListProjectsResult,
  AgentControlIntegrationId,
  AgentControlAutomationId,
  AgentControlMcpDiagnosticsSummaryInput,
  AgentControlMcpDiagnosticsSummaryResult,
  AgentControlMcpListAutomationsInput,
  AgentControlMcpListAutomationsResult,
  AgentControlMcpListAutomationRunsInput,
  AgentControlMcpListAutomationRunsResult,
  AgentControlMcpMutationResult,
  AgentControlMcpOperationalReadInput,
  AgentControlMcpOrchestrationEventsResult,
  AgentControlMcpProviderRuntimeEventsResult,
  AgentControlMcpProposeAutomationCancelInput,
  AgentControlMcpProposeAutomationCreateInput,
  AgentControlMcpProposeAutomationUpdateInput,
  AgentControlMcpReadAutomationInput,
  AgentControlMcpReadAutomationResult,
  AgentControlMcpRecentActivityResult,
  AGENT_CONTROL_RISK_TAGS,
  type AgentControlActionPlan,
  type AgentControlAutomation,
  type AgentControlExternalIntegration,
  type AgentControlMcpProviderInstanceSummary,
  type ProjectId,
  type ServerProvider,
} from "@ryco/contracts";
import { Effect, Schema } from "effect";

import type { ProjectionSnapshotQueryShape } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { agentControlSupportForDriver } from "../ProviderInjection.ts";
import type { AgentControlExternalIntegrationServiceShape } from "../Services/AgentControlExternalIntegration.ts";
import type { AgentControlExternalTaskServiceShape } from "../Services/AgentControlExternalTask.ts";
import type { AgentControlActionValidatorShape } from "../Services/AgentControlActionValidator.ts";
import type { AgentControlAutomationShape } from "../Services/AgentControlAutomation.ts";
import type { AgentControlDiagnosticsShape } from "../Services/AgentControlDiagnostics.ts";
import type { AgentControlProposalServiceShape } from "../Services/AgentControlProposalService.ts";
import { toAgentControlProposalReceipt } from "../Services/AgentControlProposalService.ts";

export interface ExternalMcpToolDescriptor {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
}

export interface ExternalMcpToolResult {
  readonly content: ReadonlyArray<{ readonly type: "text"; readonly text: string }>;
  readonly structuredContent?: unknown;
  readonly isError?: boolean;
}

export interface ExternalMcpTools {
  readonly descriptorsFor: (
    integration: AgentControlExternalIntegration,
  ) => ReadonlyArray<ExternalMcpToolDescriptor>;
  readonly hasTool: (name: string) => boolean;
  readonly callTool: (
    integrationId: AgentControlIntegrationId,
    name: string,
    args: unknown,
  ) => Effect.Effect<ExternalMcpToolResult>;
}

const descriptors: ReadonlyArray<ExternalMcpToolDescriptor> = [
  {
    name: AGENT_CONTROL_EXTERNAL_MCP_TOOLS.overview,
    description: "Describe this paired Ryco integration and its approval boundary.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: AGENT_CONTROL_EXTERNAL_MCP_TOOLS.capabilities,
    description: "List granted tools, provider instances, and task limits.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: AGENT_CONTROL_EXTERNAL_MCP_TOOLS.listAllowedProjects,
    description: "List projects this integration is explicitly allowed to target.",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "integer", minimum: 1, maximum: 50 } },
      additionalProperties: false,
    },
  },
  {
    name: AGENT_CONTROL_EXTERNAL_MCP_TOOLS.createTask,
    description: "Create one immutable task proposal. Ryco user approval is always required.",
    inputSchema: {
      type: "object",
      required: ["requestId", "projectId", "providerInstanceId", "model", "options", "prompt"],
      properties: {
        requestId: { type: "string", minLength: 1, maxLength: 128 },
        projectId: { type: "string", minLength: 1 },
        providerInstanceId: { type: "string", minLength: 1 },
        model: { type: "string", minLength: 1 },
        options: { type: "array" },
        title: { type: "string", minLength: 1, maxLength: 200 },
        prompt: { type: "string", minLength: 1, maxLength: 120000 },
        environment: { type: "string", enum: ["worktree", "local"] },
        runtimeMode: { type: "string", enum: ["approval-required", "full-access"] },
        tokenMode: { type: "string", enum: ["off", "balanced", "aggressive"] },
      },
      additionalProperties: false,
    },
  },
  {
    name: AGENT_CONTROL_EXTERNAL_MCP_TOOLS.readTask,
    description: "Read the approval, execution, and terminal state of a task created here.",
    inputSchema: {
      type: "object",
      required: ["taskId"],
      properties: { taskId: { type: "string", minLength: 1, maxLength: 128 } },
      additionalProperties: false,
    },
  },
  {
    name: AGENT_CONTROL_EXTERNAL_MCP_TOOLS.waitForTask,
    description: "Wait boundedly for a task decision or terminal outcome.",
    inputSchema: {
      type: "object",
      required: ["taskId"],
      properties: {
        taskId: { type: "string", minLength: 1, maxLength: 128 },
        waitFor: { type: "string", enum: ["decided", "terminal"] },
        timeoutMs: { type: "integer", minimum: 1, maximum: 50000 },
      },
      additionalProperties: false,
    },
  },
  ...(
    [
      [
        AGENT_CONTROL_EXTERNAL_MCP_TOOLS.listAutomations,
        "List bounded automations in one allowed project.",
        ["projectId"],
      ],
      [
        AGENT_CONTROL_EXTERNAL_MCP_TOOLS.readAutomation,
        "Read one automation in the integration's project scope.",
        ["automationId"],
      ],
      [
        AGENT_CONTROL_EXTERNAL_MCP_TOOLS.listAutomationRuns,
        "List bounded run outcomes for one authorized automation.",
        ["automationId"],
      ],
      [
        AGENT_CONTROL_EXTERNAL_MCP_TOOLS.recentActivity,
        "Read bounded payload-free activity for one allowed project/provider.",
        ["projectId", "providerInstanceId"],
      ],
      [
        AGENT_CONTROL_EXTERNAL_MCP_TOOLS.orchestrationEvents,
        "Read bounded payload-free orchestration event metadata.",
        ["projectId", "providerInstanceId"],
      ],
      [
        AGENT_CONTROL_EXTERNAL_MCP_TOOLS.providerRuntimeEvents,
        "Read bounded payload-free provider runtime event metadata.",
        ["projectId", "providerInstanceId"],
      ],
      [
        AGENT_CONTROL_EXTERNAL_MCP_TOOLS.diagnosticsSummary,
        "Read a redacted count-only health summary.",
        ["projectId", "providerInstanceId"],
      ],
    ] as const
  ).map(([name, description, required]) => ({
    name: name!,
    description: description!,
    inputSchema: {
      type: "object",
      properties: {
        automationId: { type: "string", maxLength: 128 },
        projectId: { type: "string", maxLength: 256 },
        providerInstanceId: { type: "string", maxLength: 256 },
        threadId: { type: "string", maxLength: 256 },
        includeDisabled: { type: "boolean" },
        since: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 50 },
      },
      required,
      additionalProperties: false,
    },
  })),
  ...(
    [
      [
        AGENT_CONTROL_EXTERNAL_MCP_TOOLS.proposeAutomationCreate,
        "Request approval for a bounded schedule definition; every due run needs fresh approval.",
        [
          "requestId",
          "projectId",
          "providerInstanceId",
          "title",
          "prompt",
          "model",
          "options",
          "runtimeMode",
          "envMode",
          "schedule",
        ],
      ],
      [
        AGENT_CONTROL_EXTERNAL_MCP_TOOLS.proposeAutomationUpdate,
        "Request approval for an exact revision-guarded automation update.",
        ["requestId", "automationId", "expectedRevision"],
      ],
      [
        AGENT_CONTROL_EXTERNAL_MCP_TOOLS.proposeAutomationCancel,
        "Request approval to cancel future runs without interrupting accepted work.",
        ["requestId", "automationId", "expectedRevision"],
      ],
    ] as const
  ).map(([name, description, required]) => ({
    name: name!,
    description: description!,
    inputSchema: {
      type: "object",
      properties: {
        requestId: { type: "string", maxLength: 128 },
        automationId: { type: "string", maxLength: 128 },
        expectedRevision: { type: "integer", minimum: 1 },
        projectId: { type: "string", maxLength: 256 },
        providerInstanceId: { type: "string", maxLength: 256 },
        title: { type: "string", maxLength: 200 },
        prompt: { type: "string", maxLength: 12000 },
        model: { type: "string" },
        options: { type: "array" },
        runtimeMode: { type: "string" },
        tokenMode: { type: "string", enum: ["off", "balanced", "aggressive"] },
        envMode: { type: "string", enum: ["local", "worktree"] },
        baseRef: { anyOf: [{ type: "string", maxLength: 256 }, { type: "null" }] },
        schedule: { type: "object" },
        enabled: { type: "boolean" },
      },
      required,
      additionalProperties: false,
    },
  })),
];

const toolCapability = (name: string) => {
  switch (name) {
    case AGENT_CONTROL_EXTERNAL_MCP_TOOLS.listAllowedProjects:
      return AGENT_CONTROL_CAPABILITIES.externalListProjects;
    case AGENT_CONTROL_EXTERNAL_MCP_TOOLS.createTask:
      return AGENT_CONTROL_CAPABILITIES.externalCreateTask;
    case AGENT_CONTROL_EXTERNAL_MCP_TOOLS.readTask:
    case AGENT_CONTROL_EXTERNAL_MCP_TOOLS.waitForTask:
      return AGENT_CONTROL_CAPABILITIES.externalReadTask;
    case AGENT_CONTROL_EXTERNAL_MCP_TOOLS.listAutomations:
    case AGENT_CONTROL_EXTERNAL_MCP_TOOLS.readAutomation:
    case AGENT_CONTROL_EXTERNAL_MCP_TOOLS.listAutomationRuns:
      return AGENT_CONTROL_CAPABILITIES.externalReadAutomations;
    case AGENT_CONTROL_EXTERNAL_MCP_TOOLS.proposeAutomationCreate:
    case AGENT_CONTROL_EXTERNAL_MCP_TOOLS.proposeAutomationUpdate:
    case AGENT_CONTROL_EXTERNAL_MCP_TOOLS.proposeAutomationCancel:
      return AGENT_CONTROL_CAPABILITIES.externalManageAutomations;
    case AGENT_CONTROL_EXTERNAL_MCP_TOOLS.recentActivity:
    case AGENT_CONTROL_EXTERNAL_MCP_TOOLS.orchestrationEvents:
    case AGENT_CONTROL_EXTERNAL_MCP_TOOLS.providerRuntimeEvents:
      return AGENT_CONTROL_CAPABILITIES.externalReadActivity;
    case AGENT_CONTROL_EXTERNAL_MCP_TOOLS.diagnosticsSummary:
      return AGENT_CONTROL_CAPABILITIES.externalReadDiagnostics;
    default:
      return null;
  }
};

const providerSummary = (provider: ServerProvider): AgentControlMcpProviderInstanceSummary => {
  const support = agentControlSupportForDriver(provider.driver);
  const unavailableReason =
    provider.enabled && provider.status === "ready" && provider.availability !== "unavailable"
      ? null
      : "Provider instance is unavailable.";
  return {
    instanceId: provider.instanceId,
    driver: provider.driver,
    displayName: provider.displayName ?? null,
    enabled: provider.enabled,
    status: provider.status,
    availability: provider.availability ?? "available",
    models: provider.models
      .slice(0, AGENT_CONTROL_MCP_MODELS_PER_INSTANCE_MAX)
      .map((model) => ({ slug: model.slug, name: model.name })),
    agentControl: { ...support, available: unavailableReason === null, unavailableReason },
  };
};

export const makeExternalMcpTools = (deps: {
  readonly integrations: AgentControlExternalIntegrationServiceShape;
  readonly tasks: AgentControlExternalTaskServiceShape;
  readonly projections: ProjectionSnapshotQueryShape;
  readonly getProviders: Effect.Effect<ReadonlyArray<ServerProvider>>;
  readonly validator?: AgentControlActionValidatorShape;
  readonly proposals?: Pick<AgentControlProposalServiceShape, "submit">;
  readonly automations?: AgentControlAutomationShape;
  readonly diagnostics?: AgentControlDiagnosticsShape;
}): ExternalMcpTools => {
  const names = new Set<string>(AGENT_CONTROL_EXTERNAL_MCP_TOOL_NAMES);
  const descriptorsFor = (integration: AgentControlExternalIntegration) =>
    descriptors.filter((descriptor) => {
      const capability = toolCapability(descriptor.name);
      return capability === null || integration.capabilities.includes(capability);
    });
  const decode = <S extends Schema.Top>(schema: S, args: unknown) =>
    Schema.decodeUnknownEffect(schema)(args ?? {});

  const toAutomationSummary = (automation: AgentControlAutomation, fullPrompt = false) => {
    const prompt = automation.definition.execution.prompt;
    const promptTruncated =
      !fullPrompt && prompt.length > AGENT_CONTROL_MCP_AUTOMATION_LIST_PROMPT_MAX_CHARS;
    return {
      automationId: automation.automationId,
      projectId: automation.projectId,
      providerInstanceId: automation.providerInstanceId,
      execution: {
        ...automation.definition.execution,
        prompt: promptTruncated
          ? prompt.slice(0, AGENT_CONTROL_MCP_AUTOMATION_LIST_PROMPT_MAX_CHARS)
          : prompt,
      },
      promptTruncated,
      schedule: automation.definition.schedule,
      revision: automation.revision,
      enabled: automation.enabled,
      cancelled: automation.cancelled,
      nextRunAt: automation.nextRunAt,
      createdAt: automation.createdAt,
      updatedAt: automation.updatedAt,
    };
  };

  const allowedProject = (integration: AgentControlExternalIntegration, projectId: ProjectId) =>
    integration.projectScope.kind === "all" ||
    integration.projectScope.projectIds.includes(projectId);

  const findAutomation = (
    integration: AgentControlExternalIntegration,
    automationId: AgentControlAutomation["automationId"],
  ) =>
    Effect.gen(function* () {
      if (deps.automations === undefined) return yield* Effect.fail(new Error("Unavailable"));
      const snapshot = yield* deps.projections.getShellSnapshot();
      for (const project of snapshot.projects) {
        if (!allowedProject(integration, project.id)) continue;
        const found = yield* Effect.option(
          deps.automations.get(automationId, { projectId: project.id }),
        );
        if (found._tag === "Some") return found.value;
      }
      return yield* Effect.fail(new Error("Unavailable"));
    });

  const riskTags = (plan: AgentControlActionPlan) => {
    switch (plan.kind) {
      case "createAutomation":
        return [AGENT_CONTROL_RISK_TAGS.createsAutomation];
      case "updateAutomation":
        return [AGENT_CONTROL_RISK_TAGS.modifiesAutomation];
      case "cancelAutomation":
        return [AGENT_CONTROL_RISK_TAGS.cancelsAutomation];
      default:
        return [];
    }
  };

  const submitAutomation = (
    integration: AgentControlExternalIntegration,
    requestId: Parameters<AgentControlProposalServiceShape["submit"]>[0]["requestId"],
    plan: Extract<
      AgentControlActionPlan,
      { kind: "createAutomation" | "updateAutomation" | "cancelAutomation" }
    >,
  ) =>
    Effect.gen(function* () {
      if (deps.validator === undefined || deps.proposals === undefined) {
        return yield* Effect.fail(new Error("Unavailable"));
      }
      const principal = yield* deps.validator.validateExternalSubmission({ integration, plan });
      const now = new Date();
      const submitted = yield* deps.proposals.submit({
        principal,
        requestId,
        plan,
        riskTags: riskTags(plan),
        promptSummary: `${plan.kind} requires Ryco user approval`,
        now: now.toISOString(),
        expiresAt: new Date(now.getTime() + AGENT_CONTROL_EXTERNAL_PROPOSAL_TTL_MS).toISOString(),
      });
      return Schema.encodeSync(AgentControlMcpMutationResult)({
        receipt: toAgentControlProposalReceipt(submitted.proposal),
        replayed: submitted.replayed,
      });
    });

  const execute = (integrationId: AgentControlIntegrationId, name: string, args: unknown) =>
    Effect.gen(function* () {
      switch (name) {
        case AGENT_CONTROL_EXTERNAL_MCP_TOOLS.overview: {
          const integration = yield* deps.integrations.authorizeTool({ integrationId, tool: name });
          return Schema.encodeSync(AgentControlExternalOverviewResult)({
            integrationId,
            displayName: integration.displayName,
            clientKind: integration.clientKind,
            notice:
              "Every external task waits for explicit approval by a Ryco user before a thread is created.",
          });
        }
        case AGENT_CONTROL_EXTERNAL_MCP_TOOLS.capabilities: {
          const integration = yield* deps.integrations.authorizeTool({ integrationId, tool: name });
          const providers = yield* deps.getProviders;
          return Schema.encodeSync(AgentControlExternalCapabilitiesResult)({
            tools: descriptorsFor(integration).map((descriptor) => descriptor.name),
            grantedCapabilities: integration.capabilities,
            projectScope: integration.projectScope,
            rateLimitPerMinute: integration.rateLimitPerMinute,
            activeTaskLimit: integration.activeTaskLimit,
            activeTaskCount: integration.activeTaskCount,
            providerInstances: providers.map(providerSummary),
          });
        }
        case AGENT_CONTROL_EXTERNAL_MCP_TOOLS.listAllowedProjects: {
          const input = yield* decode(AgentControlMcpListProjectsInput, args);
          const integration = yield* deps.integrations.authorizeTool({
            integrationId,
            tool: name,
            requiredCapability: AGENT_CONTROL_CAPABILITIES.externalListProjects,
          });
          const snapshot = yield* deps.projections.getShellSnapshot();
          const allowed = snapshot.projects.filter(
            (project) =>
              integration.projectScope.kind === "all" ||
              integration.projectScope.projectIds.includes(project.id),
          );
          const limit = Math.min(Math.max(1, input.limit ?? 20), 50);
          return Schema.encodeSync(AgentControlMcpListProjectsResult)({
            projects: allowed.slice(0, limit).map((project) => ({
              projectId: project.id,
              title: project.title,
              createdAt: project.createdAt,
              updatedAt: project.updatedAt,
            })),
            nextCursor: null,
          });
        }
        case AGENT_CONTROL_EXTERNAL_MCP_TOOLS.listAutomations: {
          if (deps.automations === undefined) return yield* Effect.fail(new Error("Unavailable"));
          const input = yield* decode(AgentControlMcpListAutomationsInput, args);
          if (input.projectId === undefined)
            return yield* Effect.fail(new Error("Project required"));
          yield* deps.integrations.authorizeTool({
            integrationId,
            tool: name,
            requiredCapability: AGENT_CONTROL_CAPABILITIES.externalReadAutomations,
            projectId: input.projectId,
          });
          const automations = yield* deps.automations.list({
            projectId: input.projectId,
            includeDisabled: input.includeDisabled ?? false,
            limit: Math.min(input.limit ?? 20, 50),
          });
          return Schema.encodeSync(AgentControlMcpListAutomationsResult)({
            automations: automations.map((automation) => toAutomationSummary(automation)),
            limits: {
              maxActivePerProject: AGENT_CONTROL_AUTOMATION_MAX_ACTIVE_PER_PROJECT,
              minIntervalMs: AGENT_CONTROL_AUTOMATION_MIN_INTERVAL_MS,
              maxHorizonMs: AGENT_CONTROL_AUTOMATION_MAX_HORIZON_MS,
              runHistoryMax: AGENT_CONTROL_AUTOMATION_RUN_HISTORY_MAX,
            },
          });
        }
        case AGENT_CONTROL_EXTERNAL_MCP_TOOLS.readAutomation: {
          const input = yield* decode(AgentControlMcpReadAutomationInput, args);
          const integration = yield* deps.integrations.authorizeTool({
            integrationId,
            tool: name,
            requiredCapability: AGENT_CONTROL_CAPABILITIES.externalReadAutomations,
          });
          const automation = yield* findAutomation(integration, input.automationId);
          return Schema.encodeSync(AgentControlMcpReadAutomationResult)({
            automation: toAutomationSummary(automation, true),
          });
        }
        case AGENT_CONTROL_EXTERNAL_MCP_TOOLS.listAutomationRuns: {
          if (deps.automations === undefined) return yield* Effect.fail(new Error("Unavailable"));
          const input = yield* decode(AgentControlMcpListAutomationRunsInput, args);
          const integration = yield* deps.integrations.authorizeTool({
            integrationId,
            tool: name,
            requiredCapability: AGENT_CONTROL_CAPABILITIES.externalReadAutomations,
          });
          const automation = yield* findAutomation(integration, input.automationId);
          const runs = yield* deps.automations.listRuns(input.automationId, {
            projectId: automation.projectId,
            providerInstanceId: automation.providerInstanceId,
            limit: Math.min(input.limit ?? 20, AGENT_CONTROL_AUTOMATION_RUN_HISTORY_MAX),
          });
          return Schema.encodeSync(AgentControlMcpListAutomationRunsResult)({
            runs,
            historyLimit: AGENT_CONTROL_AUTOMATION_RUN_HISTORY_MAX,
          });
        }
        case AGENT_CONTROL_EXTERNAL_MCP_TOOLS.proposeAutomationCreate: {
          const input = yield* decode(AgentControlMcpProposeAutomationCreateInput, args);
          const integration = yield* deps.integrations.authorizeTool({
            integrationId,
            tool: name,
            requiredCapability: AGENT_CONTROL_CAPABILITIES.externalManageAutomations,
            projectId: input.projectId,
          });
          if (!integration.capabilities.includes(AGENT_CONTROL_CAPABILITIES.externalCreateTask)) {
            return yield* Effect.fail(new Error("Task capability required"));
          }
          const automationId = AgentControlAutomationId.make(
            `automation-${createHash("sha256")
              .update(`${integrationId}:${input.requestId}`)
              .digest("hex")
              .slice(0, 32)}`,
          );
          return yield* submitAutomation(integration, input.requestId, {
            kind: "createAutomation",
            automationId,
            definition: {
              execution: {
                projectId: input.projectId,
                title: input.title,
                prompt: input.prompt,
                modelSelection: {
                  instanceId: input.providerInstanceId,
                  model: input.model,
                  options: input.options,
                },
                runtimeMode: input.runtimeMode,
                ...(input.tokenMode === undefined ? {} : { tokenMode: input.tokenMode }),
                envMode: input.envMode,
                ...(input.baseRef === undefined ? {} : { baseRef: input.baseRef }),
              },
              schedule: input.schedule,
              enabled: input.enabled ?? true,
            },
          });
        }
        case AGENT_CONTROL_EXTERNAL_MCP_TOOLS.proposeAutomationUpdate: {
          const input = yield* decode(AgentControlMcpProposeAutomationUpdateInput, args);
          const integration = yield* deps.integrations.authorizeTool({
            integrationId,
            tool: name,
            requiredCapability: AGENT_CONTROL_CAPABILITIES.externalManageAutomations,
          });
          if (!integration.capabilities.includes(AGENT_CONTROL_CAPABILITIES.externalCreateTask)) {
            return yield* Effect.fail(new Error("Task capability required"));
          }
          const current = yield* findAutomation(integration, input.automationId);
          if (current.revision !== input.expectedRevision) {
            return yield* Effect.fail(new Error("Revision changed"));
          }
          const execution = current.definition.execution;
          const nextOptions = input.options ?? execution.modelSelection.options;
          const nextBaseRef =
            input.baseRef === null ? undefined : (input.baseRef ?? execution.baseRef);
          return yield* submitAutomation(integration, input.requestId, {
            kind: "updateAutomation",
            automationId: current.automationId,
            before: {
              revision: current.revision,
              definition: current.definition,
              cancelled: current.cancelled,
              updatedAt: current.updatedAt,
            },
            after: {
              execution: {
                projectId: execution.projectId,
                title: input.title ?? execution.title,
                prompt: input.prompt ?? execution.prompt,
                modelSelection: {
                  instanceId: input.providerInstanceId ?? execution.modelSelection.instanceId,
                  model: input.model ?? execution.modelSelection.model,
                  ...(nextOptions === undefined ? {} : { options: nextOptions }),
                },
                runtimeMode: input.runtimeMode ?? execution.runtimeMode,
                ...(input.tokenMode !== undefined
                  ? { tokenMode: input.tokenMode }
                  : execution.tokenMode !== undefined
                    ? { tokenMode: execution.tokenMode }
                    : {}),
                envMode: input.envMode ?? execution.envMode,
                ...(nextBaseRef === undefined ? {} : { baseRef: nextBaseRef }),
              },
              schedule: input.schedule ?? current.definition.schedule,
              enabled: input.enabled ?? current.definition.enabled,
            },
          });
        }
        case AGENT_CONTROL_EXTERNAL_MCP_TOOLS.proposeAutomationCancel: {
          const input = yield* decode(AgentControlMcpProposeAutomationCancelInput, args);
          const integration = yield* deps.integrations.authorizeTool({
            integrationId,
            tool: name,
            requiredCapability: AGENT_CONTROL_CAPABILITIES.externalManageAutomations,
          });
          const current = yield* findAutomation(integration, input.automationId);
          if (current.revision !== input.expectedRevision) {
            return yield* Effect.fail(new Error("Revision changed"));
          }
          return yield* submitAutomation(integration, input.requestId, {
            kind: "cancelAutomation",
            automationId: current.automationId,
            expected: {
              revision: current.revision,
              definition: current.definition,
              cancelled: current.cancelled,
              updatedAt: current.updatedAt,
            },
          });
        }
        case AGENT_CONTROL_EXTERNAL_MCP_TOOLS.recentActivity:
        case AGENT_CONTROL_EXTERNAL_MCP_TOOLS.orchestrationEvents:
        case AGENT_CONTROL_EXTERNAL_MCP_TOOLS.providerRuntimeEvents: {
          if (deps.diagnostics === undefined) return yield* Effect.fail(new Error("Unavailable"));
          const input = yield* decode(AgentControlMcpOperationalReadInput, args);
          if (input.projectId === undefined || input.providerInstanceId === undefined) {
            return yield* Effect.fail(new Error("Project and provider required"));
          }
          yield* deps.integrations.authorizeTool({
            integrationId,
            tool: name,
            requiredCapability: AGENT_CONTROL_CAPABILITIES.externalReadActivity,
            projectId: input.projectId,
          });
          const scope = {
            projectId: input.projectId,
            providerInstanceId: input.providerInstanceId,
          };
          if (name === AGENT_CONTROL_EXTERNAL_MCP_TOOLS.recentActivity) {
            return Schema.encodeSync(AgentControlMcpRecentActivityResult)(
              yield* deps.diagnostics.recentActivity(scope, input),
            );
          }
          if (name === AGENT_CONTROL_EXTERNAL_MCP_TOOLS.orchestrationEvents) {
            return Schema.encodeSync(AgentControlMcpOrchestrationEventsResult)(
              yield* deps.diagnostics.orchestrationEvents(scope, input),
            );
          }
          return Schema.encodeSync(AgentControlMcpProviderRuntimeEventsResult)(
            yield* deps.diagnostics.providerRuntimeEvents(scope, input),
          );
        }
        case AGENT_CONTROL_EXTERNAL_MCP_TOOLS.diagnosticsSummary: {
          if (deps.diagnostics === undefined) return yield* Effect.fail(new Error("Unavailable"));
          const input = yield* decode(AgentControlMcpDiagnosticsSummaryInput, args);
          if (input.projectId === undefined || input.providerInstanceId === undefined) {
            return yield* Effect.fail(new Error("Project and provider required"));
          }
          yield* deps.integrations.authorizeTool({
            integrationId,
            tool: name,
            requiredCapability: AGENT_CONTROL_CAPABILITIES.externalReadDiagnostics,
            projectId: input.projectId,
          });
          return Schema.encodeSync(AgentControlMcpDiagnosticsSummaryResult)(
            yield* deps.diagnostics.summary({
              projectId: input.projectId,
              providerInstanceId: input.providerInstanceId,
            }),
          );
        }
        case AGENT_CONTROL_EXTERNAL_MCP_TOOLS.createTask:
          return yield* deps.tasks.create({
            integrationId,
            request: yield* decode(AgentControlExternalCreateTaskInput, args),
          });
        case AGENT_CONTROL_EXTERNAL_MCP_TOOLS.readTask:
          return yield* deps.tasks.read({
            integrationId,
            taskId: (yield* decode(AgentControlExternalTaskIdInput, args)).taskId,
          });
        case AGENT_CONTROL_EXTERNAL_MCP_TOOLS.waitForTask:
          return yield* deps.tasks.wait({
            integrationId,
            request: yield* decode(AgentControlExternalWaitForTaskInput, args),
          });
        default:
          return yield* Effect.fail(new Error("Unknown external MCP tool"));
      }
    });

  const callTool: ExternalMcpTools["callTool"] = (integrationId, name, args) =>
    execute(integrationId, name, args).pipe(
      Effect.map((value) => ({
        content: [{ type: "text" as const, text: JSON.stringify(value) }],
        structuredContent: value,
      })),
      Effect.catch(() =>
        Effect.succeed({
          content: [{ type: "text" as const, text: "External Agent Control request was refused." }],
          isError: true,
        }),
      ),
      Effect.catchDefect(() =>
        Effect.succeed({
          content: [{ type: "text" as const, text: "External Agent Control request failed." }],
          isError: true,
        }),
      ),
    );

  return { descriptorsFor, hasTool: (name) => names.has(name), callTool };
};
