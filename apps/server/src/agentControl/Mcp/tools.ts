/**
 * Read and proposal-backed mutation catalog for the internal Agent Control MCP endpoint.
 *
 * Every tool is capability-checked against the caller's session grants and
 * scoped by the server-authoritative policy; results are bounded, redacted
 * projections — titles, identifiers, statuses, and bounded transcript text.
 * Workspace paths, provider configuration, secrets, raw activity payloads,
 * and full diagnostics never cross this boundary. Mutation tools only
 * persist immutable approval proposals; execution belongs to the durable
 * server-side executor.
 *
 * @module agentControl/Mcp/tools
 */
import { createHash } from "node:crypto";

import {
  AGENT_CONTROL_AUTOMATION_MAX_ACTIVE_PER_PROJECT,
  AGENT_CONTROL_AUTOMATION_MAX_HORIZON_MS,
  AGENT_CONTROL_AUTOMATION_MIN_INTERVAL_MS,
  AGENT_CONTROL_AUTOMATION_RUN_HISTORY_MAX,
  AGENT_CONTROL_MCP_LIST_LIMIT_DEFAULT,
  AGENT_CONTROL_MCP_LIST_LIMIT_MAX,
  AGENT_CONTROL_MCP_AUTOMATION_LIST_PROMPT_MAX_CHARS,
  AGENT_CONTROL_MCP_MESSAGE_LIMIT_DEFAULT,
  AGENT_CONTROL_MCP_MESSAGE_LIMIT_MAX,
  AGENT_CONTROL_MCP_MESSAGE_TEXT_MAX_CHARS,
  AGENT_CONTROL_MCP_MODELS_PER_INSTANCE_MAX,
  AGENT_CONTROL_MCP_READ_THREAD_TEXT_BUDGET_CHARS,
  AGENT_CONTROL_MCP_TOOLS,
  AGENT_CONTROL_MCP_TOOL_NAMES,
  AGENT_CONTROL_MCP_WAIT_TIMEOUT_MS_DEFAULT,
  AGENT_CONTROL_MCP_WAIT_TIMEOUT_MS_MAX,
  AGENT_CONTROL_CAPABILITIES,
  AGENT_CONTROL_RISK_TAGS,
  AGENT_CONTROL_TERMINAL_PROPOSAL_STATUSES,
  AgentControlMcpCapabilitiesResult,
  AgentControlAutomationId,
  AgentControlMcpDiagnosticsSummaryInput,
  AgentControlMcpDiagnosticsSummaryResult,
  AgentControlMcpListDevicesInput,
  AgentControlMcpListDevicesResult,
  AgentControlMcpListAutomationsInput,
  AgentControlMcpListAutomationsResult,
  AgentControlMcpListAutomationRunsInput,
  AgentControlMcpListAutomationRunsResult,
  AgentControlMcpOperationalReadInput,
  AgentControlMcpOrchestrationEventsResult,
  AgentControlMcpProviderRuntimeEventsResult,
  AgentControlMcpProposeAutomationCancelInput,
  AgentControlMcpProposeAutomationCreateInput,
  AgentControlMcpProposeAutomationUpdateInput,
  AgentControlMcpProposeDeviceAttachInput,
  AgentControlMcpProposeDeviceBootInput,
  AgentControlMcpProposeDeviceDetachInput,
  AgentControlMcpProposeDeviceInputInput,
  AgentControlMcpProposeDeviceInstallInput,
  AgentControlMcpProposeDeviceLaunchInput,
  AgentControlMcpProposeDeviceOpenUrlInput,
  AgentControlMcpProposeDeviceRecordingInput,
  AgentControlMcpProposeDeviceShutdownInput,
  AgentControlMcpReadDeviceContentInput,
  AgentControlMcpReadDeviceStateInput,
  AgentControlMcpReadDeviceStateResult,
  AgentControlMcpReadAutomationInput,
  AgentControlMcpReadAutomationResult,
  AgentControlMcpRecentActivityResult,
  AgentControlMcpCreateThreadsInput,
  AgentControlMcpContextResult,
  AgentControlMcpControlRequestResult,
  AgentControlMcpListProjectsInput,
  AgentControlMcpListProjectsResult,
  AgentControlMcpListThreadsInput,
  AgentControlMcpListThreadsResult,
  AgentControlMcpInterruptThreadInput,
  AgentControlMcpMutationResult,
  AgentControlMcpProposeProjectCreateInput,
  AgentControlMcpProposeProjectRemoveInput,
  AgentControlMcpProposeProjectUpdateInput,
  AgentControlMcpProposeSettingsChangeInput,
  AgentControlMcpReadControlRequestInput,
  AgentControlMcpReadThreadInput,
  AgentControlMcpReadThreadResult,
  AgentControlMcpSendMessageInput,
  AgentControlMcpSettingsSummaryResult,
  AgentControlMcpUpdateThreadInput,
  AgentControlMcpWaitForControlRequestInput,
  OrchestrationThreadHistoryCursor,
  type AgentControlMcpMessage,
  type AgentControlAutomation,
  type AgentControlMcpProviderInstanceSummary,
  type AgentControlMcpThreadSummary,
  type AgentControlProposal,
  type AgentControlProposalStatus,
  type AgentControlActionPlan,
  type AgentControlDeviceActionPlan,
  type AgentControlCapability,
  type OrchestrationMessage,
  type OrchestrationProjectShell,
  type OrchestrationThreadHistoryPageInfo,
  type OrchestrationThreadShell,
  type ServerProvider,
  type ServerSettings,
  type ServerSettingsError,
} from "@ryco/contracts";
import { Duration, Effect, Option, Schema, Stream } from "effect";

import type { ProjectionSnapshotQueryShape } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import type { DeviceServiceShape } from "../../device/Services/DeviceService.ts";
import type { WorkspaceAccessPolicyShape } from "../../workspace/Services/WorkspaceAccessPolicy.ts";
import type { AgentControlPolicyShape } from "../Services/AgentControlPolicy.ts";
import type { AgentControlActionValidatorShape } from "../Services/AgentControlActionValidator.ts";
import type { AgentControlAutomationShape } from "../Services/AgentControlAutomation.ts";
import type { AgentControlDiagnosticsShape } from "../Services/AgentControlDiagnostics.ts";
import type { AgentControlProposalEventsShape } from "../Services/AgentControlProposalEvents.ts";
import type { AgentControlProposalServiceShape } from "../Services/AgentControlProposalService.ts";
import type { AgentControlProjectPlansShape } from "../Services/AgentControlProjectPlans.ts";
import { toAgentControlProposalReceipt } from "../Services/AgentControlProposalService.ts";
import type {
  AgentControlSessionRecord,
  AgentControlTurnAuthority,
} from "../Services/AgentControlSessionRegistry.ts";
import { agentControlSupportForDriver } from "../ProviderInjection.ts";
import { agentControlSettingsPlan, agentControlSettingsSummary } from "../settingsControl.ts";
import {
  assertSafeAgentControlDeviceUrl,
  resolveAgentControlDeviceArtifact,
} from "../deviceControl.ts";

export interface AgentControlMcpToolDescriptor {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

export interface AgentControlMcpToolResult {
  readonly content: ReadonlyArray<
    | { readonly type: "text"; readonly text: string }
    | {
        readonly type: "image";
        readonly data: string;
        readonly mimeType: "image/png" | "image/jpeg";
        /** Type-only compatibility with existing text-result consumers; absent on the wire. */
        readonly text: string;
      }
  >;
  readonly structuredContent?: unknown;
  readonly isError?: boolean;
}

export interface AgentControlMcpToolDeps {
  readonly policy: AgentControlPolicyShape;
  readonly proposals: Pick<AgentControlProposalServiceShape, "getProposal"> &
    Partial<Pick<AgentControlProposalServiceShape, "submit">>;
  readonly proposalEvents: Pick<AgentControlProposalEventsShape, "subscribe">;
  readonly projections: ProjectionSnapshotQueryShape;
  readonly getProviders: Effect.Effect<ReadonlyArray<ServerProvider>>;
  readonly validator?: AgentControlActionValidatorShape;
  readonly projectPlans?: AgentControlProjectPlansShape;
  readonly automations?: AgentControlAutomationShape;
  readonly diagnostics?: AgentControlDiagnosticsShape;
  readonly deviceService?: DeviceServiceShape;
  readonly workspaceAccess?: WorkspaceAccessPolicyShape;
  readonly getSettings?: Effect.Effect<ServerSettings, ServerSettingsError>;
  readonly getTurnAuthority?: (
    sessionId: string,
  ) => Effect.Effect<Option.Option<AgentControlTurnAuthority>>;
}

export interface AgentControlMcpTools {
  readonly descriptors: ReadonlyArray<AgentControlMcpToolDescriptor>;
  readonly descriptorsFor: (
    session: AgentControlSessionRecord,
  ) => Effect.Effect<ReadonlyArray<AgentControlMcpToolDescriptor>>;
  readonly hasTool: (name: string) => boolean;
  readonly isWriteTool: (name: string) => boolean;
  readonly callTool: (
    session: AgentControlSessionRecord,
    name: string,
    args: unknown,
  ) => Effect.Effect<AgentControlMcpToolResult>;
}

/** Bounded, presentation-safe tool failure. Never carries internals. */
class ToolFailure {
  readonly _tag = "ToolFailure";
  readonly reason: string;
  constructor(reason: string) {
    this.reason = reason;
  }
}

interface PrivateDeviceContentResult {
  readonly _tag: "PrivateDeviceContentResult";
  readonly content: AgentControlMcpToolResult["content"];
}

const isPrivateDeviceContentResult = (value: unknown): value is PrivateDeviceContentResult =>
  typeof value === "object" &&
  value !== null &&
  "_tag" in value &&
  value._tag === "PrivateDeviceContentResult";

const failTool = (reason: string) => Effect.fail(new ToolFailure(reason));

const cursorSchemaProperty = { type: "string", maxLength: 1_024 } as const;
const AGENT_CONTROL_DEVICE_UI_CONTENT_MAX_CHARS = 512 * 1_024;
const limitSchemaProperty = (maximum: number) =>
  ({ type: "integer", minimum: 1, maximum }) as const;
const automationScheduleSchema = {
  oneOf: [
    {
      type: "object",
      properties: { kind: { const: "once" }, runAt: { type: "string" } },
      required: ["kind", "runAt"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        kind: { const: "fixed-interval" },
        startsAt: { type: "string" },
        intervalMs: { type: "integer", minimum: AGENT_CONTROL_AUTOMATION_MIN_INTERVAL_MS },
        endsAt: { type: "string" },
      },
      required: ["kind", "startsAt", "intervalMs", "endsAt"],
      additionalProperties: false,
    },
  ],
} as const;

const deviceMutationTargetProperties = {
  requestId: { type: "string", maxLength: 128 },
  udid: { type: "string", maxLength: 128 },
  expectedThreadDeviceVersion: { type: "integer", minimum: 0 },
  expectedAttachedDeviceUdid: {
    oneOf: [{ type: "string", maxLength: 128 }, { type: "null" }],
  },
  expectedDeviceState: {
    type: "string",
    enum: ["shutdown", "booting", "booted", "shutting-down"],
  },
  expectedDeviceBootSource: { type: "string", enum: ["ryco", "user"] },
  expectedRecording: { type: "boolean" },
} as const;

const deviceMutationTargetRequired = [
  "requestId",
  "udid",
  "expectedThreadDeviceVersion",
  "expectedAttachedDeviceUdid",
  "expectedDeviceState",
  "expectedDeviceBootSource",
  "expectedRecording",
] as const;

const TOOL_DESCRIPTORS: ReadonlyArray<AgentControlMcpToolDescriptor> = [
  {
    name: AGENT_CONTROL_MCP_TOOLS.context,
    description:
      "Identify this session's Ryco thread, project, provider instance, and granted Agent Control capabilities.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: AGENT_CONTROL_MCP_TOOLS.listDevices,
    description:
      "List bounded iOS Simulator availability and inventory for this exact Ryco thread, project, and provider instance.",
    inputSchema: {
      type: "object",
      properties: { includeShutdown: { type: "boolean" } },
      additionalProperties: false,
    },
  },
  {
    name: AGENT_CONTROL_MCP_TOOLS.readDeviceState,
    description:
      "Read redacted attachment and lifecycle state for this exact Ryco thread; device content is excluded.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: AGENT_CONTROL_MCP_TOOLS.readDeviceScreenshot,
    description:
      "Read one ephemeral screenshot from the device currently attached to this exact thread. The image is never persisted or audited.",
    inputSchema: {
      type: "object",
      properties: { udid: { type: "string", maxLength: 128 } },
      required: ["udid"],
      additionalProperties: false,
    },
  },
  {
    name: AGENT_CONTROL_MCP_TOOLS.describeDeviceUi,
    description:
      "Read one bounded ephemeral accessibility tree from the device currently attached to this exact thread. Content is never persisted or audited.",
    inputSchema: {
      type: "object",
      properties: { udid: { type: "string", maxLength: 128 } },
      required: ["udid"],
      additionalProperties: false,
    },
  },
  ...[
    [AGENT_CONTROL_MCP_TOOLS.proposeDeviceBoot, "boot"],
    [AGENT_CONTROL_MCP_TOOLS.proposeDeviceAttach, "attach"],
    [AGENT_CONTROL_MCP_TOOLS.proposeDeviceDetach, "detach"],
    [AGENT_CONTROL_MCP_TOOLS.proposeDeviceShutdown, "shut down"],
  ].map(([name, operation]) => ({
    name: name!,
    description: `Request approval to ${operation} one exact iOS Simulator. This creates a proposal and does not mutate the device inline.`,
    inputSchema: {
      type: "object",
      properties: deviceMutationTargetProperties,
      required: deviceMutationTargetRequired,
      additionalProperties: false,
    },
  })),
  {
    name: AGENT_CONTROL_MCP_TOOLS.proposeDeviceInstall,
    description:
      "Request approval to install one exact workspace-contained .app artifact on the attached Simulator. No install occurs inline.",
    inputSchema: {
      type: "object",
      properties: {
        ...deviceMutationTargetProperties,
        artifactPath: { type: "string", minLength: 1, maxLength: 1024 },
      },
      required: [...deviceMutationTargetRequired, "artifactPath"],
      additionalProperties: false,
    },
  },
  {
    name: AGENT_CONTROL_MCP_TOOLS.proposeDeviceLaunch,
    description:
      "Request approval to launch one exact installed bundle without launch arguments on the attached Simulator. No launch occurs inline.",
    inputSchema: {
      type: "object",
      properties: {
        ...deviceMutationTargetProperties,
        bundleId: { type: "string", minLength: 1, maxLength: 256 },
      },
      required: [...deviceMutationTargetRequired, "bundleId"],
      additionalProperties: false,
    },
  },
  {
    name: AGENT_CONTROL_MCP_TOOLS.proposeDeviceOpenUrl,
    description:
      "Request high-risk approval to open one exact safe URL or deep link on the attached Simulator. No URL is opened inline.",
    inputSchema: {
      type: "object",
      properties: {
        ...deviceMutationTargetProperties,
        url: { type: "string", minLength: 1, maxLength: 2048 },
      },
      required: [...deviceMutationTargetRequired, "url"],
      additionalProperties: false,
    },
  },
  {
    name: AGENT_CONTROL_MCP_TOOLS.proposeDeviceInput,
    description:
      "Request approval for one exact bounded coordinate tap, swipe, or hardware-button action. Text typing and UI-label targeting are intentionally unavailable.",
    inputSchema: {
      type: "object",
      properties: {
        ...deviceMutationTargetProperties,
        action: {
          oneOf: [
            {
              type: "object",
              properties: {
                kind: { const: "tap" },
                x: { type: "number", minimum: 0, maximum: 20000 },
                y: { type: "number", minimum: 0, maximum: 20000 },
              },
              required: ["kind", "x", "y"],
              additionalProperties: false,
            },
            {
              type: "object",
              properties: {
                kind: { const: "swipe" },
                fromX: { type: "number", minimum: 0, maximum: 20000 },
                fromY: { type: "number", minimum: 0, maximum: 20000 },
                toX: { type: "number", minimum: 0, maximum: 20000 },
                toY: { type: "number", minimum: 0, maximum: 20000 },
                durationMs: { type: "integer", minimum: 0, maximum: 10000 },
              },
              required: ["kind", "fromX", "fromY", "toX", "toY", "durationMs"],
              additionalProperties: false,
            },
            {
              type: "object",
              properties: {
                kind: { const: "press-button" },
                button: {
                  type: "string",
                  enum: ["home", "lock", "volume-up", "volume-down", "rotate"],
                },
              },
              required: ["kind", "button"],
              additionalProperties: false,
            },
          ],
        },
      },
      required: [...deviceMutationTargetRequired, "action"],
      additionalProperties: false,
    },
  },
  {
    name: AGENT_CONTROL_MCP_TOOLS.proposeDeviceRecording,
    description:
      "Request approval to start or stop Simulator recording. Recording paths never enter proposal, audit, or tool output.",
    inputSchema: {
      type: "object",
      properties: {
        ...deviceMutationTargetProperties,
        action: { type: "string", enum: ["start", "stop"] },
      },
      required: [...deviceMutationTargetRequired, "action"],
      additionalProperties: false,
    },
  },
  {
    name: AGENT_CONTROL_MCP_TOOLS.capabilities,
    description:
      "List the currently authorized Agent Control tool catalog and configured Ryco provider instances with exact model availability.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: AGENT_CONTROL_MCP_TOOLS.listProjects,
    description: "List Ryco projects (bounded page; cursor-based).",
    inputSchema: {
      type: "object",
      properties: {
        limit: limitSchemaProperty(AGENT_CONTROL_MCP_LIST_LIMIT_MAX),
        cursor: cursorSchemaProperty,
      },
      additionalProperties: false,
    },
  },
  {
    name: AGENT_CONTROL_MCP_TOOLS.listThreads,
    description:
      "List Ryco threads with status, optionally filtered by project (bounded page; cursor-based; archived threads excluded unless requested).",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", maxLength: 256 },
        includeArchived: { type: "boolean" },
        limit: limitSchemaProperty(AGENT_CONTROL_MCP_LIST_LIMIT_MAX),
        cursor: cursorSchemaProperty,
      },
      additionalProperties: false,
    },
  },
  {
    name: AGENT_CONTROL_MCP_TOOLS.readThread,
    description:
      "Read one thread's status header and a bounded, newest-first page of its conversation messages (cursor pages older history).",
    inputSchema: {
      type: "object",
      properties: {
        threadId: { type: "string", maxLength: 256 },
        messageLimit: limitSchemaProperty(AGENT_CONTROL_MCP_MESSAGE_LIMIT_MAX),
        cursor: cursorSchemaProperty,
      },
      required: ["threadId"],
      additionalProperties: false,
    },
  },
  {
    name: AGENT_CONTROL_MCP_TOOLS.readControlRequest,
    description:
      "Read the lifecycle receipt of an Agent Control request this session created (status, decision, terminal result).",
    inputSchema: {
      type: "object",
      properties: { proposalId: { type: "string", maxLength: 256 } },
      required: ["proposalId"],
      additionalProperties: false,
    },
  },
  {
    name: AGENT_CONTROL_MCP_TOOLS.waitForControlRequest,
    description:
      "Wait (bounded) until an Agent Control request this session created is decided or reaches a terminal outcome, then return its receipt.",
    inputSchema: {
      type: "object",
      properties: {
        proposalId: { type: "string", maxLength: 256 },
        waitFor: { type: "string", enum: ["decided", "terminal"] },
        timeoutMs: limitSchemaProperty(AGENT_CONTROL_MCP_WAIT_TIMEOUT_MS_MAX),
      },
      required: ["proposalId"],
      additionalProperties: false,
    },
  },
  {
    name: AGENT_CONTROL_MCP_TOOLS.createThreads,
    description:
      "Request user approval for one exact bounded batch of Ryco threads. This creates a proposal and does not create threads immediately.",
    inputSchema: {
      type: "object",
      properties: {
        requestId: { type: "string", maxLength: 128 },
        entries: {
          type: "array",
          minItems: 1,
          maxItems: 10,
          items: {
            type: "object",
            properties: {
              projectId: { type: "string", maxLength: 256 },
              title: { type: "string", minLength: 1, maxLength: 200 },
              prompt: { type: "string", minLength: 1, maxLength: 120000 },
              modelSelection: { type: "object" },
              runtimeMode: {
                type: "string",
                enum: ["approval-required", "auto-accept-edits", "auto", "full-access"],
              },
              envMode: { type: "string", enum: ["local", "worktree"] },
              baseRef: { type: "string", maxLength: 256 },
            },
            required: ["projectId", "title", "prompt", "modelSelection", "runtimeMode", "envMode"],
            additionalProperties: false,
          },
        },
      },
      required: ["requestId", "entries"],
      additionalProperties: false,
    },
  },
  {
    name: AGENT_CONTROL_MCP_TOOLS.sendMessage,
    description:
      "Request user approval to queue or steer one exact message to a Ryco thread. This does not send immediately.",
    inputSchema: {
      type: "object",
      properties: {
        requestId: { type: "string", maxLength: 128 },
        threadId: { type: "string", maxLength: 256 },
        text: { type: "string", minLength: 1, maxLength: 120000 },
        delivery: { type: "string", enum: ["queue", "steer"] },
      },
      required: ["requestId", "threadId", "text", "delivery"],
      additionalProperties: false,
    },
  },
  {
    name: AGENT_CONTROL_MCP_TOOLS.interruptThread,
    description:
      "Request user approval to interrupt one Ryco thread (optionally only an exact turn). This does not interrupt immediately.",
    inputSchema: {
      type: "object",
      properties: {
        requestId: { type: "string", maxLength: 128 },
        threadId: { type: "string", maxLength: 256 },
        turnId: { type: "string", maxLength: 256 },
      },
      required: ["requestId", "threadId"],
      additionalProperties: false,
    },
  },
  {
    name: AGENT_CONTROL_MCP_TOOLS.updateThread,
    description:
      "Request user approval to change only a thread title, archive state, or explicitly supplied persistent goal.",
    inputSchema: {
      type: "object",
      properties: {
        requestId: { type: "string", maxLength: 128 },
        threadId: { type: "string", maxLength: 256 },
        title: { type: "string", minLength: 1, maxLength: 200 },
        archived: { type: "boolean" },
        persistentGoal: { anyOf: [{ type: "string", maxLength: 4000 }, { type: "null" }] },
      },
      required: ["requestId", "threadId"],
      additionalProperties: false,
    },
  },
  {
    name: AGENT_CONTROL_MCP_TOOLS.settingsSummary,
    description:
      "Read the redacted Agent Control settings allowlist and whether authoritative settings approval is currently supported. Secrets and control-plane configuration are omitted.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: AGENT_CONTROL_MCP_TOOLS.proposeProjectCreate,
    description:
      "Request user approval to link an existing authorized directory as one exact Ryco project. This does not create a project or directory immediately.",
    inputSchema: {
      type: "object",
      properties: {
        requestId: { type: "string", maxLength: 128 },
        projectId: { type: "string", minLength: 1, maxLength: 256 },
        title: { type: "string", minLength: 1, maxLength: 200 },
        workspaceRoot: { type: "string", minLength: 1, maxLength: 4096 },
      },
      required: ["requestId", "projectId", "title", "workspaceRoot"],
      additionalProperties: false,
    },
  },
  {
    name: AGENT_CONTROL_MCP_TOOLS.proposeProjectUpdate,
    description:
      "Request user approval for an exact project display-name and/or existing authorized workspace-path change, guarded by the project's updatedAt revision.",
    inputSchema: {
      type: "object",
      properties: {
        requestId: { type: "string", maxLength: 128 },
        projectId: { type: "string", minLength: 1, maxLength: 256 },
        expectedUpdatedAt: { type: "string", minLength: 1 },
        title: { type: "string", minLength: 1, maxLength: 200 },
        workspaceRoot: { type: "string", minLength: 1, maxLength: 4096 },
      },
      required: ["requestId", "projectId", "expectedUpdatedAt"],
      additionalProperties: false,
    },
  },
  {
    name: AGENT_CONTROL_MCP_TOOLS.proposeProjectRemove,
    description:
      "Request user approval to unlink one exact Ryco project record. Force also removes only the listed Ryco thread records; workspace files are never deleted.",
    inputSchema: {
      type: "object",
      properties: {
        requestId: { type: "string", maxLength: 128 },
        projectId: { type: "string", minLength: 1, maxLength: 256 },
        expectedUpdatedAt: { type: "string", minLength: 1 },
        force: { type: "boolean" },
      },
      required: ["requestId", "projectId", "expectedUpdatedAt"],
      additionalProperties: false,
    },
  },
  {
    name: AGENT_CONTROL_MCP_TOOLS.proposeSettingsChange,
    description:
      "Request an exact allowlisted non-secret settings change. This fails closed until Ryco can enforce fresh owner reauthentication at approval and execution.",
    inputSchema: {
      type: "object",
      properties: {
        requestId: { type: "string", maxLength: 128 },
        change: {
          oneOf: [
            {
              type: "object",
              properties: {
                kind: { const: "legacyTokenStreaming" },
                value: { type: "boolean" },
              },
              required: ["kind", "value"],
              additionalProperties: false,
            },
            {
              type: "object",
              properties: {
                kind: { const: "providerUpdateChecks" },
                value: { type: "boolean" },
              },
              required: ["kind", "value"],
              additionalProperties: false,
            },
          ],
        },
      },
      required: ["requestId", "change"],
      additionalProperties: false,
    },
  },
  {
    name: AGENT_CONTROL_MCP_TOOLS.listAutomations,
    description: "List bounded schedule definitions in this exact project/provider scope.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", maxLength: 256 },
        includeDisabled: { type: "boolean" },
        limit: limitSchemaProperty(AGENT_CONTROL_MCP_LIST_LIMIT_MAX),
      },
      additionalProperties: false,
    },
  },
  {
    name: AGENT_CONTROL_MCP_TOOLS.readAutomation,
    description: "Read one schedule definition in this exact project/provider scope.",
    inputSchema: {
      type: "object",
      properties: { automationId: { type: "string", maxLength: 128 } },
      required: ["automationId"],
      additionalProperties: false,
    },
  },
  {
    name: AGENT_CONTROL_MCP_TOOLS.listAutomationRuns,
    description: "List bounded run outcomes for one authorized automation.",
    inputSchema: {
      type: "object",
      properties: {
        automationId: { type: "string", maxLength: 128 },
        limit: limitSchemaProperty(AGENT_CONTROL_AUTOMATION_RUN_HISTORY_MAX),
      },
      required: ["automationId"],
      additionalProperties: false,
    },
  },
  {
    name: AGENT_CONTROL_MCP_TOOLS.proposeAutomationCreate,
    description:
      "Request approval for a bounded schedule definition. Approval creates no thread or provider turn; every due run gets a new approval request.",
    inputSchema: {
      type: "object",
      properties: {
        requestId: { type: "string", maxLength: 128 },
        projectId: { type: "string", maxLength: 256 },
        providerInstanceId: { type: "string", maxLength: 256 },
        title: { type: "string", maxLength: 200 },
        prompt: { type: "string", maxLength: 12000 },
        model: { type: "string" },
        options: { type: "array" },
        runtimeMode: { type: "string" },
        envMode: { type: "string", enum: ["local", "worktree"] },
        baseRef: { type: "string", maxLength: 256 },
        schedule: automationScheduleSchema,
        enabled: { type: "boolean" },
      },
      required: [
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
      additionalProperties: false,
    },
  },
  {
    name: AGENT_CONTROL_MCP_TOOLS.proposeAutomationUpdate,
    description: "Request approval for an exact revision-guarded schedule replacement.",
    inputSchema: {
      type: "object",
      properties: {
        requestId: { type: "string", maxLength: 128 },
        automationId: { type: "string", maxLength: 128 },
        expectedRevision: { type: "integer", minimum: 1 },
        title: { type: "string", maxLength: 200 },
        prompt: { type: "string", maxLength: 12000 },
        providerInstanceId: { type: "string", maxLength: 256 },
        model: { type: "string" },
        options: { type: "array" },
        runtimeMode: { type: "string" },
        envMode: { type: "string", enum: ["local", "worktree"] },
        baseRef: { anyOf: [{ type: "string", maxLength: 256 }, { type: "null" }] },
        schedule: automationScheduleSchema,
        enabled: { type: "boolean" },
      },
      required: ["requestId", "automationId", "expectedRevision"],
      additionalProperties: false,
    },
  },
  {
    name: AGENT_CONTROL_MCP_TOOLS.proposeAutomationCancel,
    description:
      "Request approval to cancel future occurrences. Already accepted/executing runs are not interrupted.",
    inputSchema: {
      type: "object",
      properties: {
        requestId: { type: "string", maxLength: 128 },
        automationId: { type: "string", maxLength: 128 },
        expectedRevision: { type: "integer", minimum: 1 },
      },
      required: ["requestId", "automationId", "expectedRevision"],
      additionalProperties: false,
    },
  },
  ...[
    [
      AGENT_CONTROL_MCP_TOOLS.recentActivity,
      "Read bounded, payload-free project/thread activity and automation outcomes.",
    ],
    [
      AGENT_CONTROL_MCP_TOOLS.orchestrationEvents,
      "Read bounded, payload-free orchestration event metadata.",
    ],
    [
      AGENT_CONTROL_MCP_TOOLS.providerRuntimeEvents,
      "Read bounded, payload-free provider runtime event metadata.",
    ],
  ].map(([name, description]) => ({
    name: name!,
    description: description!,
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", maxLength: 256 },
        threadId: { type: "string", maxLength: 256 },
        providerInstanceId: { type: "string", maxLength: 256 },
        since: { type: "string" },
        limit: limitSchemaProperty(AGENT_CONTROL_MCP_LIST_LIMIT_MAX),
      },
      additionalProperties: false,
    },
  })),
  {
    name: AGENT_CONTROL_MCP_TOOLS.diagnosticsSummary,
    description:
      "Read a redacted health summary with counts only; paths, terminals, logs, traces, requests, and payloads are omitted.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", maxLength: 256 },
        providerInstanceId: { type: "string", maxLength: 256 },
      },
      additionalProperties: false,
    },
  },
];

const WRITE_TOOL_NAMES = new Set<string>([
  AGENT_CONTROL_MCP_TOOLS.createThreads,
  AGENT_CONTROL_MCP_TOOLS.sendMessage,
  AGENT_CONTROL_MCP_TOOLS.interruptThread,
  AGENT_CONTROL_MCP_TOOLS.updateThread,
  AGENT_CONTROL_MCP_TOOLS.proposeProjectCreate,
  AGENT_CONTROL_MCP_TOOLS.proposeProjectUpdate,
  AGENT_CONTROL_MCP_TOOLS.proposeProjectRemove,
  AGENT_CONTROL_MCP_TOOLS.proposeSettingsChange,
  AGENT_CONTROL_MCP_TOOLS.proposeAutomationCreate,
  AGENT_CONTROL_MCP_TOOLS.proposeAutomationUpdate,
  AGENT_CONTROL_MCP_TOOLS.proposeAutomationCancel,
  AGENT_CONTROL_MCP_TOOLS.proposeDeviceBoot,
  AGENT_CONTROL_MCP_TOOLS.proposeDeviceAttach,
  AGENT_CONTROL_MCP_TOOLS.proposeDeviceDetach,
  AGENT_CONTROL_MCP_TOOLS.proposeDeviceInstall,
  AGENT_CONTROL_MCP_TOOLS.proposeDeviceLaunch,
  AGENT_CONTROL_MCP_TOOLS.proposeDeviceOpenUrl,
  AGENT_CONTROL_MCP_TOOLS.proposeDeviceInput,
  AGENT_CONTROL_MCP_TOOLS.proposeDeviceRecording,
  AGENT_CONTROL_MCP_TOOLS.proposeDeviceShutdown,
]);

const DEVICE_CONTROL_TOOL_NAMES = new Set<string>([
  AGENT_CONTROL_MCP_TOOLS.listDevices,
  AGENT_CONTROL_MCP_TOOLS.readDeviceState,
  AGENT_CONTROL_MCP_TOOLS.readDeviceScreenshot,
  AGENT_CONTROL_MCP_TOOLS.describeDeviceUi,
  AGENT_CONTROL_MCP_TOOLS.proposeDeviceBoot,
  AGENT_CONTROL_MCP_TOOLS.proposeDeviceAttach,
  AGENT_CONTROL_MCP_TOOLS.proposeDeviceDetach,
  AGENT_CONTROL_MCP_TOOLS.proposeDeviceInstall,
  AGENT_CONTROL_MCP_TOOLS.proposeDeviceLaunch,
  AGENT_CONTROL_MCP_TOOLS.proposeDeviceOpenUrl,
  AGENT_CONTROL_MCP_TOOLS.proposeDeviceInput,
  AGENT_CONTROL_MCP_TOOLS.proposeDeviceRecording,
  AGENT_CONTROL_MCP_TOOLS.proposeDeviceShutdown,
]);

const writeCapabilityForTool = (name: string): AgentControlCapability | null => {
  switch (name) {
    case AGENT_CONTROL_MCP_TOOLS.createThreads:
      return AGENT_CONTROL_CAPABILITIES.createThreads;
    case AGENT_CONTROL_MCP_TOOLS.sendMessage:
      return AGENT_CONTROL_CAPABILITIES.sendMessage;
    case AGENT_CONTROL_MCP_TOOLS.interruptThread:
      return AGENT_CONTROL_CAPABILITIES.interruptThread;
    case AGENT_CONTROL_MCP_TOOLS.updateThread:
      return AGENT_CONTROL_CAPABILITIES.updateThread;
    case AGENT_CONTROL_MCP_TOOLS.proposeProjectCreate:
      return AGENT_CONTROL_CAPABILITIES.createProject;
    case AGENT_CONTROL_MCP_TOOLS.proposeProjectUpdate:
      return AGENT_CONTROL_CAPABILITIES.updateProject;
    case AGENT_CONTROL_MCP_TOOLS.proposeProjectRemove:
      return AGENT_CONTROL_CAPABILITIES.removeProject;
    case AGENT_CONTROL_MCP_TOOLS.proposeSettingsChange:
      return AGENT_CONTROL_CAPABILITIES.changeSettings;
    case AGENT_CONTROL_MCP_TOOLS.proposeAutomationCreate:
    case AGENT_CONTROL_MCP_TOOLS.proposeAutomationUpdate:
    case AGENT_CONTROL_MCP_TOOLS.proposeAutomationCancel:
      return AGENT_CONTROL_CAPABILITIES.manageAutomations;
    case AGENT_CONTROL_MCP_TOOLS.proposeDeviceBoot:
    case AGENT_CONTROL_MCP_TOOLS.proposeDeviceAttach:
    case AGENT_CONTROL_MCP_TOOLS.proposeDeviceDetach:
    case AGENT_CONTROL_MCP_TOOLS.proposeDeviceInstall:
    case AGENT_CONTROL_MCP_TOOLS.proposeDeviceLaunch:
    case AGENT_CONTROL_MCP_TOOLS.proposeDeviceOpenUrl:
    case AGENT_CONTROL_MCP_TOOLS.proposeDeviceInput:
    case AGENT_CONTROL_MCP_TOOLS.proposeDeviceRecording:
    case AGENT_CONTROL_MCP_TOOLS.proposeDeviceShutdown:
      return AGENT_CONTROL_CAPABILITIES.controlDevices;
    default:
      return null;
  }
};

const readCapabilityForTool = (name: string): AgentControlCapability => {
  if (
    name === AGENT_CONTROL_MCP_TOOLS.readDeviceScreenshot ||
    name === AGENT_CONTROL_MCP_TOOLS.describeDeviceUi
  )
    return AGENT_CONTROL_CAPABILITIES.readDeviceContent;
  if (
    name === AGENT_CONTROL_MCP_TOOLS.listDevices ||
    name === AGENT_CONTROL_MCP_TOOLS.readDeviceState
  )
    return AGENT_CONTROL_CAPABILITIES.readDevices;
  if (name === AGENT_CONTROL_MCP_TOOLS.settingsSummary)
    return AGENT_CONTROL_CAPABILITIES.readSettings;
  if (
    name === AGENT_CONTROL_MCP_TOOLS.listAutomations ||
    name === AGENT_CONTROL_MCP_TOOLS.readAutomation ||
    name === AGENT_CONTROL_MCP_TOOLS.listAutomationRuns
  )
    return AGENT_CONTROL_CAPABILITIES.readAutomations;
  if (
    name === AGENT_CONTROL_MCP_TOOLS.recentActivity ||
    name === AGENT_CONTROL_MCP_TOOLS.orchestrationEvents ||
    name === AGENT_CONTROL_MCP_TOOLS.providerRuntimeEvents
  )
    return AGENT_CONTROL_CAPABILITIES.readActivity;
  if (name === AGENT_CONTROL_MCP_TOOLS.diagnosticsSummary) {
    return AGENT_CONTROL_CAPABILITIES.readDiagnostics;
  }
  return AGENT_CONTROL_CAPABILITIES.read;
};

const clampLimit = (value: number | undefined, fallback: number, max: number): number =>
  Math.min(value ?? fallback, max);

// ── List cursors ──────────────────────────────────────────────────────
//
// Opaque `acp1.<base64url json>` cursors over the stable
// `(createdAt, id)` ascending ordering of the shell snapshot.

interface ListCursorOrder {
  readonly createdAt: string;
  readonly id: string;
}

const LIST_CURSOR_PREFIX = "acp1.";

const encodeListCursor = (kind: "projects" | "threads", after: ListCursorOrder): string =>
  `${LIST_CURSOR_PREFIX}${Buffer.from(JSON.stringify({ v: 1, kind, after }), "utf8").toString("base64url")}`;

const decodeListCursor = (kind: "projects" | "threads", cursor: string): ListCursorOrder | null => {
  if (!cursor.startsWith(LIST_CURSOR_PREFIX)) return null;
  try {
    const decoded: unknown = JSON.parse(
      Buffer.from(cursor.slice(LIST_CURSOR_PREFIX.length), "base64url").toString("utf8"),
    );
    if (typeof decoded !== "object" || decoded === null) return null;
    const record = decoded as Record<string, unknown>;
    const after = record.after as Record<string, unknown> | undefined;
    if (
      record.v !== 1 ||
      record.kind !== kind ||
      typeof after?.createdAt !== "string" ||
      typeof after?.id !== "string"
    ) {
      return null;
    }
    return { createdAt: after.createdAt, id: after.id };
  } catch {
    return null;
  }
};

const compareOrder = (a: ListCursorOrder, b: ListCursorOrder): number =>
  a.createdAt < b.createdAt
    ? -1
    : a.createdAt > b.createdAt
      ? 1
      : a.id < b.id
        ? -1
        : a.id > b.id
          ? 1
          : 0;

interface ListPage<T> {
  readonly items: ReadonlyArray<T>;
  readonly nextCursor: string | null;
}

const paginate = <T>(input: {
  readonly kind: "projects" | "threads";
  readonly rows: ReadonlyArray<T>;
  readonly order: (row: T) => ListCursorOrder;
  readonly limit: number;
  readonly cursor: string | undefined;
}): ListPage<T> | null => {
  let after: ListCursorOrder | null = null;
  if (input.cursor !== undefined) {
    after = decodeListCursor(input.kind, input.cursor);
    if (after === null) return null;
  }
  const sorted = input.rows.toSorted((a, b) => compareOrder(input.order(a), input.order(b)));
  const startFrom = after;
  const filtered =
    startFrom === null
      ? sorted
      : sorted.filter((row) => compareOrder(input.order(row), startFrom) > 0);
  const items = filtered.slice(0, input.limit);
  const last = items.at(-1);
  const nextCursor =
    filtered.length > input.limit && last !== undefined
      ? encodeListCursor(input.kind, input.order(last))
      : null;
  return { items, nextCursor };
};

// ── Result mapping ────────────────────────────────────────────────────

const toThreadSummary = (shell: OrchestrationThreadShell): AgentControlMcpThreadSummary => ({
  threadId: shell.id,
  projectId: shell.projectId,
  title: shell.title,
  status: shell.session?.status ?? "idle",
  activeTurnId: shell.session?.activeTurnId ?? null,
  providerInstanceId: shell.session?.providerInstanceId ?? null,
  archived: shell.archivedAt !== null,
  createdAt: shell.createdAt,
  updatedAt: shell.updatedAt,
});

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

const toMcpMessage = (message: OrchestrationMessage): AgentControlMcpMessage => {
  const truncated = message.text.length > AGENT_CONTROL_MCP_MESSAGE_TEXT_MAX_CHARS;
  return {
    messageId: message.id,
    role: message.role,
    text: truncated
      ? message.text.slice(0, AGENT_CONTROL_MCP_MESSAGE_TEXT_MAX_CHARS)
      : message.text,
    truncated,
    turnId: message.turnId,
    attachmentCount: message.attachments?.length ?? 0,
    createdAt: message.createdAt,
  };
};

/**
 * Enforce the aggregate transcript budget over an ascending-order page.
 * Newest messages keep their text; once the budget is exhausted walking
 * backwards, older messages are truncated (possibly to empty) and
 * flagged. The message set itself is untouched, so history cursors stay
 * exact, and the bounded page can never blow the listener's response cap.
 */
const applyTranscriptTextBudget = (
  messages: ReadonlyArray<AgentControlMcpMessage>,
): ReadonlyArray<AgentControlMcpMessage> => {
  let remaining = AGENT_CONTROL_MCP_READ_THREAD_TEXT_BUDGET_CHARS;
  const bounded = [...messages];
  for (let index = bounded.length - 1; index >= 0; index -= 1) {
    const message = bounded[index]!;
    if (message.text.length <= remaining) {
      remaining -= message.text.length;
      continue;
    }
    bounded[index] = { ...message, text: message.text.slice(0, remaining), truncated: true };
    remaining = 0;
  }
  return bounded;
};

const toInstanceSummary = (provider: ServerProvider): AgentControlMcpProviderInstanceSummary => {
  const support = agentControlSupportForDriver(provider.driver);
  const unavailableReason = !support.supported
    ? support.reason
    : !provider.enabled
      ? "Provider instance is disabled."
      : provider.availability === "unavailable" || provider.status === "error"
        ? "Provider instance is unavailable."
        : null;
  return {
    instanceId: provider.instanceId,
    driver: provider.driver,
    displayName: provider.displayName ?? null,
    enabled: provider.enabled,
    status: provider.status,
    availability: provider.availability ?? "available",
    agentControl: {
      ...support,
      available: unavailableReason === null,
      unavailableReason,
    },
    models: provider.models
      .slice(0, AGENT_CONTROL_MCP_MODELS_PER_INSTANCE_MAX)
      .map((model) => ({ slug: model.slug, name: model.name })),
  };
};

/**
 * A proposal is visible to a provider-session caller iff it was created by
 * a provider-session principal of the same thread. Everything else reads
 * as not-found — absence and authorization failure stay indistinguishable.
 */
const proposalVisibleToSession = (
  proposal: AgentControlProposal,
  session: AgentControlSessionRecord,
): boolean =>
  proposal.principal.kind === "provider-session" &&
  proposal.principal.threadId === session.threadId;

const waitConditionMet = (
  status: AgentControlProposalStatus,
  waitFor: "decided" | "terminal",
): boolean =>
  waitFor === "terminal"
    ? AGENT_CONTROL_TERMINAL_PROPOSAL_STATUSES.includes(status)
    : status !== "pending-user-approval";

// ── Factory ───────────────────────────────────────────────────────────

export const makeAgentControlMcpTools = (deps: AgentControlMcpToolDeps): AgentControlMcpTools => {
  const toolNames = new Set<string>(AGENT_CONTROL_MCP_TOOL_NAMES);
  const hasWriteAuthority = (session: AgentControlSessionRecord) =>
    Effect.all({
      enabled: deps.policy.isEnabled,
      authority: deps.getTurnAuthority?.(session.sessionId) ?? Effect.succeed(Option.none()),
    }).pipe(
      Effect.map(
        ({ enabled, authority }) =>
          enabled &&
          Option.exists(
            authority,
            (current) =>
              current.sessionId === session.sessionId && current.threadId === session.threadId,
          ),
      ),
    );

  const descriptorsFor = (session: AgentControlSessionRecord) =>
    hasWriteAuthority(session).pipe(
      Effect.map((canWrite) =>
        TOOL_DESCRIPTORS.filter((descriptor) => {
          if (
            DEVICE_CONTROL_TOOL_NAMES.has(descriptor.name) &&
            deps.deviceService?.supported !== true
          ) {
            return false;
          }
          const capability = writeCapabilityForTool(descriptor.name);
          if (capability !== null) {
            return canWrite && session.grantedCapabilities.includes(capability);
          }
          return session.grantedCapabilities.includes(readCapabilityForTool(descriptor.name));
        }),
      ),
    );

  const decodeArgs = <S extends Schema.Top>(schema: S, args: unknown) =>
    Schema.decodeUnknownEffect(schema)(args ?? {}).pipe(
      Effect.mapError(() => new ToolFailure("Invalid tool arguments.")),
    ) as Effect.Effect<S["Type"], ToolFailure>;

  const authorizeRead = (session: AgentControlSessionRecord, toolName: string) =>
    deps.policy
      .authorize({
        principal: {
          kind: "provider-session",
          threadId: session.threadId,
          providerInstanceId: session.providerInstanceId,
          runtimeSessionId: session.runtimeSessionId,
        },
        grantedCapabilities: session.grantedCapabilities,
        requiredCapability: readCapabilityForTool(toolName),
        operation: `mcp:${toolName}`,
      })
      .pipe(
        Effect.mapError((error) =>
          error._tag === "AgentControlDisabledError"
            ? new ToolFailure("Agent Control is disabled.")
            : new ToolFailure("Capability denied."),
        ),
      );

  const readProposalForSession = (
    session: AgentControlSessionRecord,
    proposalId: AgentControlProposal["proposalId"],
  ) =>
    deps.proposals.getProposal(proposalId).pipe(
      Effect.mapError((error) =>
        error._tag === "AgentControlDisabledError"
          ? new ToolFailure("Agent Control is disabled.")
          : new ToolFailure("Control request read failed."),
      ),
      Effect.flatMap((proposal) =>
        Option.isSome(proposal) && proposalVisibleToSession(proposal.value, session)
          ? Effect.succeed(proposal.value)
          : failTool("Control request not found."),
      ),
    );

  const context = (session: AgentControlSessionRecord) =>
    Effect.gen(function* () {
      const writeToolsAvailable = yield* hasWriteAuthority(session);
      const threadShell = yield* deps.projections
        .getThreadShellById(session.threadId)
        .pipe(Effect.mapError(() => new ToolFailure("Context read failed.")));
      const projectShell = yield* Option.match(threadShell, {
        onNone: () => Effect.succeed(Option.none<OrchestrationProjectShell>()),
        onSome: (shell) =>
          deps.projections
            .getProjectShellById(shell.projectId)
            .pipe(Effect.mapError(() => new ToolFailure("Context read failed."))),
      });
      return Schema.encodeSync(AgentControlMcpContextResult)({
        threadId: session.threadId,
        threadTitle: Option.match(threadShell, {
          onNone: () => null,
          onSome: (shell) => shell.title,
        }),
        projectId: Option.match(threadShell, {
          onNone: () => null,
          onSome: (shell) => shell.projectId,
        }),
        projectTitle: Option.match(projectShell, {
          onNone: () => null,
          onSome: (shell) => shell.title,
        }),
        providerInstanceId: session.providerInstanceId,
        runtimeSessionId: session.runtimeSessionId,
        capabilities: session.grantedCapabilities,
        agentControl: { available: true, injectionMode: session.injectionMode },
        writeToolsAvailable,
      });
    });

  const capabilities = (session: AgentControlSessionRecord) =>
    Effect.gen(function* () {
      const enabled = yield* deps.policy.isEnabled;
      const providers = yield* deps.getProviders;
      const tools = yield* descriptorsFor(session);
      const writeToolsAvailable = tools.some((tool) => WRITE_TOOL_NAMES.has(tool.name));
      return Schema.encodeSync(AgentControlMcpCapabilitiesResult)({
        enabled,
        readOnly: !writeToolsAvailable,
        tools: tools.map((tool) => tool.name),
        grantedCapabilities: session.grantedCapabilities,
        agentControl: { available: true, injectionMode: session.injectionMode },
        providerInstances: providers.map(toInstanceSummary),
      });
    });

  const riskTagsForPlan = (plan: AgentControlActionPlan) => {
    switch (plan.kind) {
      case "createThreads": {
        const tags = [
          AGENT_CONTROL_RISK_TAGS.createsThreads,
          AGENT_CONTROL_RISK_TAGS.startsProviderTurn,
        ];
        if (plan.entries.some((entry) => entry.envMode === "local")) {
          tags.push(AGENT_CONTROL_RISK_TAGS.sharedLocalCheckout);
        }
        if (plan.entries.some((entry) => entry.runtimeMode === "full-access")) {
          tags.push(AGENT_CONTROL_RISK_TAGS.elevatedRuntimeMode);
        }
        return tags;
      }
      case "sendMessage":
        return [AGENT_CONTROL_RISK_TAGS.startsProviderTurn];
      case "interruptThread":
        return [AGENT_CONTROL_RISK_TAGS.interruptsThread];
      case "updateThread":
        return [AGENT_CONTROL_RISK_TAGS.modifiesThreadMetadata];
      case "createProject":
        return [AGENT_CONTROL_RISK_TAGS.createsProject];
      case "updateProject":
        return [AGENT_CONTROL_RISK_TAGS.modifiesProjectMetadata];
      case "removeProject":
        return [
          AGENT_CONTROL_RISK_TAGS.removesProject,
          ...(plan.expectedThreadIds.length > 0 ? [AGENT_CONTROL_RISK_TAGS.removesThreads] : []),
        ];
      case "changeSettings":
        return [AGENT_CONTROL_RISK_TAGS.changesSettings];
      case "createAutomation":
        return [AGENT_CONTROL_RISK_TAGS.createsAutomation];
      case "updateAutomation":
        return [AGENT_CONTROL_RISK_TAGS.modifiesAutomation];
      case "cancelAutomation":
        return [AGENT_CONTROL_RISK_TAGS.cancelsAutomation];
      case "automationRun":
        return [
          AGENT_CONTROL_RISK_TAGS.scheduledRun,
          AGENT_CONTROL_RISK_TAGS.createsThreads,
          AGENT_CONTROL_RISK_TAGS.startsProviderTurn,
        ];
      case "deviceOpenUrl":
        return [AGENT_CONTROL_RISK_TAGS.deviceMutation, AGENT_CONTROL_RISK_TAGS.deviceOpenWorld];
      case "deviceBoot":
      case "deviceAttach":
      case "deviceDetach":
      case "deviceStartRecording":
      case "deviceStopRecording":
      case "deviceShutdown":
        return [AGENT_CONTROL_RISK_TAGS.deviceMutation, AGENT_CONTROL_RISK_TAGS.deviceLifecycle];
      case "deviceInstall":
      case "deviceLaunch":
      case "deviceTap":
      case "deviceSwipe":
      case "devicePressButton":
        return [AGENT_CONTROL_RISK_TAGS.deviceMutation];
    }
  };

  const promptSummaryForPlan = (plan: AgentControlActionPlan) => {
    switch (plan.kind) {
      case "createThreads":
        return `Create ${plan.entries.length} thread${plan.entries.length === 1 ? "" : "s"}`;
      case "sendMessage":
        return `Send a message to thread ${plan.threadId}`;
      case "interruptThread":
        return `Interrupt thread ${plan.threadId}`;
      case "updateThread":
        return `Update thread ${plan.threadId}`;
      case "createProject":
        return `Create project ${plan.title}`;
      case "updateProject":
        return `Update project ${plan.projectId}`;
      case "removeProject":
        return `Unlink project ${plan.expected.title}; workspace files will be retained`;
      case "changeSettings":
        return `Change ${plan.change.kind}`;
      case "createAutomation":
        return `Create automation ${plan.automationId}; each run requires separate approval`;
      case "updateAutomation":
        return `Update automation ${plan.automationId} from revision ${plan.before.revision}`;
      case "cancelAutomation":
        return `Cancel future runs for automation ${plan.automationId}`;
      case "automationRun":
        return `Approve scheduled run ${plan.runId}`;
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
        return plan.executionSummary;
    }
  };

  const submitMutation = (input: {
    readonly session: AgentControlSessionRecord;
    readonly authority: AgentControlTurnAuthority;
    readonly requestId: Parameters<AgentControlProposalServiceShape["submit"]>[0]["requestId"];
    readonly plan: AgentControlActionPlan;
  }) =>
    Effect.gen(function* () {
      if (deps.validator === undefined || deps.proposals.submit === undefined) {
        return yield* failTool("Control request creation is unavailable.");
      }
      const principal = yield* deps.validator.validateSubmission({
        session: input.session,
        authority: input.authority,
        plan: input.plan,
      });
      const now = new Date();
      const submitted = yield* deps.proposals.submit({
        principal,
        requestId: input.requestId,
        plan: input.plan,
        riskTags: riskTagsForPlan(input.plan),
        promptSummary: promptSummaryForPlan(input.plan),
        now: now.toISOString(),
        expiresAt: new Date(now.getTime() + 15 * 60_000).toISOString(),
      });
      return Schema.encodeSync(AgentControlMcpMutationResult)({
        receipt: toAgentControlProposalReceipt(submitted.proposal),
        replayed: submitted.replayed,
      });
    }).pipe(
      Effect.mapError((error) => {
        switch (error._tag) {
          case "AgentControlDuplicateRequestError":
            return new ToolFailure("Request ID was already used with a different plan.");
          case "AgentControlDisabledError":
            return new ToolFailure("Agent Control is disabled.");
          case "AgentControlPlanValidationError":
            return new ToolFailure(error.detail.slice(0, 500));
          default:
            return new ToolFailure("Control request creation failed.");
        }
      }),
    );

  const createThreads = (
    session: AgentControlSessionRecord,
    authority: AgentControlTurnAuthority,
    args: unknown,
  ) =>
    Effect.gen(function* () {
      const input = yield* decodeArgs(AgentControlMcpCreateThreadsInput, args);
      return yield* submitMutation({
        session,
        authority,
        requestId: input.requestId,
        plan: { kind: "createThreads", entries: input.entries },
      });
    });

  const sendMessage = (
    session: AgentControlSessionRecord,
    authority: AgentControlTurnAuthority,
    args: unknown,
  ) =>
    Effect.gen(function* () {
      const input = yield* decodeArgs(AgentControlMcpSendMessageInput, args);
      return yield* submitMutation({
        session,
        authority,
        requestId: input.requestId,
        plan: {
          kind: "sendMessage",
          threadId: input.threadId,
          text: input.text,
          delivery: input.delivery,
        },
      });
    });

  const interruptThread = (
    session: AgentControlSessionRecord,
    authority: AgentControlTurnAuthority,
    args: unknown,
  ) =>
    Effect.gen(function* () {
      const input = yield* decodeArgs(AgentControlMcpInterruptThreadInput, args);
      return yield* submitMutation({
        session,
        authority,
        requestId: input.requestId,
        plan: {
          kind: "interruptThread",
          threadId: input.threadId,
          ...(input.turnId === undefined ? {} : { turnId: input.turnId }),
        },
      });
    });

  const updateThread = (
    session: AgentControlSessionRecord,
    authority: AgentControlTurnAuthority,
    args: unknown,
  ) =>
    Effect.gen(function* () {
      const input = yield* decodeArgs(AgentControlMcpUpdateThreadInput, args);
      return yield* submitMutation({
        session,
        authority,
        requestId: input.requestId,
        plan: {
          kind: "updateThread",
          threadId: input.threadId,
          ...(input.title === undefined ? {} : { title: input.title }),
          ...(input.archived === undefined ? {} : { archived: input.archived }),
          ...(input.persistentGoal === undefined ? {} : { persistentGoal: input.persistentGoal }),
        },
      });
    });

  const prepareProjectPlan = <A>(
    prepare: (
      plans: AgentControlProjectPlansShape,
    ) => Effect.Effect<A, { readonly detail: string }>,
  ) =>
    deps.projectPlans === undefined
      ? failTool("Project proposal creation is unavailable.")
      : prepare(deps.projectPlans).pipe(
          Effect.mapError((error) => new ToolFailure(error.detail.slice(0, 500))),
        );

  const proposeProjectCreate = (
    session: AgentControlSessionRecord,
    authority: AgentControlTurnAuthority,
    args: unknown,
  ) =>
    Effect.gen(function* () {
      const input = yield* decodeArgs(AgentControlMcpProposeProjectCreateInput, args);
      const plan = yield* prepareProjectPlan((plans) => plans.prepareCreate(input));
      return yield* submitMutation({
        session,
        authority,
        requestId: input.requestId,
        plan,
      });
    });

  const proposeProjectUpdate = (
    session: AgentControlSessionRecord,
    authority: AgentControlTurnAuthority,
    args: unknown,
  ) =>
    Effect.gen(function* () {
      const input = yield* decodeArgs(AgentControlMcpProposeProjectUpdateInput, args);
      const plan = yield* prepareProjectPlan((plans) => plans.prepareUpdate(input));
      return yield* submitMutation({
        session,
        authority,
        requestId: input.requestId,
        plan,
      });
    });

  const proposeProjectRemove = (
    session: AgentControlSessionRecord,
    authority: AgentControlTurnAuthority,
    args: unknown,
  ) =>
    Effect.gen(function* () {
      const input = yield* decodeArgs(AgentControlMcpProposeProjectRemoveInput, args);
      const plan = yield* prepareProjectPlan((plans) => plans.prepareRemove(input));
      return yield* submitMutation({
        session,
        authority,
        requestId: input.requestId,
        plan,
      });
    });

  const settingsSummary = () =>
    Effect.gen(function* () {
      if (deps.getSettings === undefined) {
        return yield* failTool("Settings summary is unavailable.");
      }
      const settings = yield* deps.getSettings.pipe(
        Effect.mapError(() => new ToolFailure("Settings summary is unavailable.")),
      );
      return Schema.encodeSync(AgentControlMcpSettingsSummaryResult)(
        agentControlSettingsSummary(settings),
      );
    });

  const proposeSettingsChange = (
    session: AgentControlSessionRecord,
    authority: AgentControlTurnAuthority,
    args: unknown,
  ) =>
    Effect.gen(function* () {
      const input = yield* decodeArgs(AgentControlMcpProposeSettingsChangeInput, args);
      if (deps.getSettings === undefined) {
        return yield* failTool("Settings proposal creation is unavailable.");
      }
      const settings = yield* deps.getSettings.pipe(
        Effect.mapError(() => new ToolFailure("Settings proposal creation is unavailable.")),
      );
      return yield* submitMutation({
        session,
        authority,
        requestId: input.requestId,
        plan: agentControlSettingsPlan(settings, input.change),
      });
    });

  const sessionScope = (session: AgentControlSessionRecord) =>
    deps.projections.getThreadShellById(session.threadId).pipe(
      Effect.mapError(() => new ToolFailure("Project scope is unavailable.")),
      Effect.flatMap((thread) =>
        Option.isSome(thread) &&
        thread.value.session?.providerInstanceId === session.providerInstanceId &&
        thread.value.session.runtimeSessionId === session.runtimeSessionId
          ? Effect.succeed({
              thread: thread.value,
              projectId: thread.value.projectId,
              providerInstanceId: session.providerInstanceId,
            })
          : failTool("Project scope is unavailable."),
      ),
    );

  const requireDevice = () => {
    if (deps.deviceService === undefined || !deps.deviceService.supported) {
      return failTool("iOS Simulator device control is unavailable.");
    }
    return Effect.succeed(deps.deviceService);
  };

  const deviceContext = (session: AgentControlSessionRecord) =>
    Effect.gen(function* () {
      const service = yield* requireDevice();
      const scope = yield* sessionScope(session);
      const snapshot = yield* deps.projections
        .getShellSnapshot()
        .pipe(Effect.mapError(() => new ToolFailure("Device project scope is unavailable.")));
      const project = snapshot.projects.find((candidate) => candidate.id === scope.projectId);
      if (!project) return yield* failTool("Device project scope is unavailable.");
      return { service, scope, project };
    });

  const devicePromise = <A>(run: () => Promise<A>, failure: string) =>
    Effect.tryPromise({
      try: run,
      catch: () => new ToolFailure(failure),
    });

  const listDevices = (session: AgentControlSessionRecord, args: unknown) =>
    Effect.gen(function* () {
      const input = yield* decodeArgs(AgentControlMcpListDevicesInput, args);
      const { service, scope } = yield* deviceContext(session);
      const result = yield* devicePromise(
        () =>
          service.manager.list(
            input.includeShutdown === undefined ? {} : { includeShutdown: input.includeShutdown },
          ),
        "Device inventory read failed.",
      );
      return Schema.encodeSync(AgentControlMcpListDevicesResult)({
        threadId: session.threadId,
        projectId: scope.projectId,
        providerInstanceId: scope.providerInstanceId,
        devices: result.devices,
        recordingDeviceUdids: result.devices
          .filter((device) => service.manager.isRecording(device.udid))
          .map((device) => device.udid),
        availability: result.availability,
      });
    });

  const readDeviceState = (session: AgentControlSessionRecord, args: unknown) =>
    Effect.gen(function* () {
      yield* decodeArgs(AgentControlMcpReadDeviceStateInput, args);
      const { service, scope } = yield* deviceContext(session);
      const state = yield* devicePromise(
        () => service.manager.getThreadState(session.threadId),
        "Device state read failed.",
      );
      const attachedDevice =
        state.devices.find((device) => device.udid === state.attachedDeviceUdid) ?? null;
      return Schema.encodeSync(AgentControlMcpReadDeviceStateResult)({
        threadId: session.threadId,
        projectId: scope.projectId,
        providerInstanceId: scope.providerInstanceId,
        version: state.version,
        attachedDeviceUdid: state.attachedDeviceUdid,
        attachPhase: state.attachPhase ?? null,
        attachedDevice,
        recording:
          state.attachedDeviceUdid === null
            ? false
            : service.manager.isRecording(state.attachedDeviceUdid),
        agentActive: state.agentActive,
        availability: state.availability,
        redacted: true,
      });
    });

  const requireAttachedDeviceContent = (session: AgentControlSessionRecord, args: unknown) =>
    Effect.gen(function* () {
      const input = yield* decodeArgs(AgentControlMcpReadDeviceContentInput, args);
      const { service } = yield* deviceContext(session);
      const state = yield* devicePromise(
        () => service.manager.getThreadState(session.threadId),
        "Device content read failed.",
      );
      if (state.attachedDeviceUdid !== input.udid) {
        return yield* failTool("Device content is limited to this thread's current attachment.");
      }
      return { service, udid: input.udid };
    });

  const readDeviceScreenshot = (session: AgentControlSessionRecord, args: unknown) =>
    Effect.gen(function* () {
      const { service, udid } = yield* requireAttachedDeviceContent(session, args);
      const screenshot = yield* devicePromise(
        () => service.manager.screenshot(udid, { save: false }),
        "Device screenshot read failed.",
      );
      return {
        _tag: "PrivateDeviceContentResult",
        content: [
          {
            type: "image",
            data: screenshot.bytesBase64,
            mimeType: "image/png",
          } as AgentControlMcpToolResult["content"][number],
        ],
      } satisfies PrivateDeviceContentResult;
    });

  const describeDeviceUi = (session: AgentControlSessionRecord, args: unknown) =>
    Effect.gen(function* () {
      const { service, udid } = yield* requireAttachedDeviceContent(session, args);
      const tree = yield* devicePromise(
        () => service.manager.describeUi(udid),
        "Device UI read failed.",
      );
      const encoded = JSON.stringify(tree);
      if (encoded.length > AGENT_CONTROL_DEVICE_UI_CONTENT_MAX_CHARS) {
        return yield* failTool("Device UI content exceeds the internal read limit.");
      }
      return {
        _tag: "PrivateDeviceContentResult",
        content: [{ type: "text", text: encoded }],
      } satisfies PrivateDeviceContentResult;
    });

  const prepareDeviceTarget = (
    session: AgentControlSessionRecord,
    input: {
      readonly udid: AgentControlDeviceActionPlan["udid"];
      readonly expectedThreadDeviceVersion: number;
      readonly expectedAttachedDeviceUdid: AgentControlDeviceActionPlan["expectedAttachedDeviceUdid"];
      readonly expectedDeviceState: AgentControlDeviceActionPlan["expectedDeviceState"];
      readonly expectedDeviceBootSource: AgentControlDeviceActionPlan["expectedDeviceBootSource"];
      readonly expectedRecording: boolean;
    },
    executionSummary: string,
    riskClass: AgentControlDeviceActionPlan["riskClass"],
  ) =>
    Effect.gen(function* () {
      yield* requireDevice();
      const scope = yield* sessionScope(session);
      const snapshot = yield* deps.projections
        .getShellSnapshot()
        .pipe(Effect.mapError(() => new ToolFailure("Device project scope is unavailable.")));
      const project = snapshot.projects.find((candidate) => candidate.id === scope.projectId);
      if (!project) return yield* failTool("Device project scope is unavailable.");
      return {
        project,
        target: {
          threadId: session.threadId,
          projectId: scope.projectId,
          expectedProjectUpdatedAt: project.updatedAt,
          providerInstanceId: scope.providerInstanceId,
          udid: input.udid,
          expectedThreadDeviceVersion: input.expectedThreadDeviceVersion,
          expectedAttachedDeviceUdid: input.expectedAttachedDeviceUdid,
          expectedDeviceState: input.expectedDeviceState,
          expectedDeviceBootSource: input.expectedDeviceBootSource,
          expectedRecording: input.expectedRecording,
          executionSummary,
          riskClass,
        },
      };
    });

  const proposeDeviceMutation = (
    session: AgentControlSessionRecord,
    authority: AgentControlTurnAuthority,
    name: string,
    args: unknown,
  ) =>
    Effect.gen(function* () {
      let requestId: Parameters<AgentControlProposalServiceShape["submit"]>[0]["requestId"];
      let plan: AgentControlDeviceActionPlan;
      switch (name) {
        case AGENT_CONTROL_MCP_TOOLS.proposeDeviceBoot: {
          const input = yield* decodeArgs(AgentControlMcpProposeDeviceBootInput, args);
          requestId = input.requestId;
          const prepared = yield* prepareDeviceTarget(
            session,
            input,
            `Boot iOS Simulator ${input.udid}`,
            "device-lifecycle",
          );
          plan = { kind: "deviceBoot", ...prepared.target };
          break;
        }
        case AGENT_CONTROL_MCP_TOOLS.proposeDeviceAttach: {
          const input = yield* decodeArgs(AgentControlMcpProposeDeviceAttachInput, args);
          requestId = input.requestId;
          const prepared = yield* prepareDeviceTarget(
            session,
            input,
            `Attach iOS Simulator ${input.udid} to this thread`,
            "device-lifecycle",
          );
          plan = { kind: "deviceAttach", ...prepared.target };
          break;
        }
        case AGENT_CONTROL_MCP_TOOLS.proposeDeviceDetach: {
          const input = yield* decodeArgs(AgentControlMcpProposeDeviceDetachInput, args);
          requestId = input.requestId;
          const prepared = yield* prepareDeviceTarget(
            session,
            input,
            `Detach iOS Simulator ${input.udid} from this thread`,
            "device-lifecycle",
          );
          plan = { kind: "deviceDetach", ...prepared.target };
          break;
        }
        case AGENT_CONTROL_MCP_TOOLS.proposeDeviceInstall: {
          const input = yield* decodeArgs(AgentControlMcpProposeDeviceInstallInput, args);
          requestId = input.requestId;
          const prepared = yield* prepareDeviceTarget(
            session,
            input,
            `Install an approved workspace application on iOS Simulator ${input.udid}`,
            "device-control",
          );
          if (deps.workspaceAccess === undefined) {
            return yield* failTool("Workspace artifact validation is unavailable.");
          }
          yield* resolveAgentControlDeviceArtifact({
            workspaceRoot: prepared.project.workspaceRoot,
            artifactPath: input.artifactPath,
            workspaceAccess: deps.workspaceAccess,
          }).pipe(Effect.mapError(() => new ToolFailure("Application artifact is unavailable.")));
          plan = { kind: "deviceInstall", ...prepared.target, artifactPath: input.artifactPath };
          break;
        }
        case AGENT_CONTROL_MCP_TOOLS.proposeDeviceLaunch: {
          const input = yield* decodeArgs(AgentControlMcpProposeDeviceLaunchInput, args);
          requestId = input.requestId;
          const prepared = yield* prepareDeviceTarget(
            session,
            input,
            `Launch installed application ${input.bundleId} on iOS Simulator ${input.udid}`,
            "device-control",
          );
          plan = { kind: "deviceLaunch", ...prepared.target, bundleId: input.bundleId };
          break;
        }
        case AGENT_CONTROL_MCP_TOOLS.proposeDeviceOpenUrl: {
          const input = yield* decodeArgs(AgentControlMcpProposeDeviceOpenUrlInput, args);
          requestId = input.requestId;
          yield* Effect.try({
            try: () => assertSafeAgentControlDeviceUrl(input.url),
            catch: () => new ToolFailure("URL does not meet device-control policy."),
          });
          const prepared = yield* prepareDeviceTarget(
            session,
            input,
            `Open an approved URL or deep link on iOS Simulator ${input.udid}`,
            "open-world",
          );
          plan = { kind: "deviceOpenUrl", ...prepared.target, url: input.url };
          break;
        }
        case AGENT_CONTROL_MCP_TOOLS.proposeDeviceInput: {
          const input = yield* decodeArgs(AgentControlMcpProposeDeviceInputInput, args);
          requestId = input.requestId;
          const prepared = yield* prepareDeviceTarget(
            session,
            input,
            `Perform one ${input.action.kind} action on iOS Simulator ${input.udid}`,
            "device-control",
          );
          switch (input.action.kind) {
            case "tap":
              plan = {
                kind: "deviceTap",
                ...prepared.target,
                x: input.action.x,
                y: input.action.y,
              };
              break;
            case "swipe":
              plan = {
                kind: "deviceSwipe",
                ...prepared.target,
                fromX: input.action.fromX,
                fromY: input.action.fromY,
                toX: input.action.toX,
                toY: input.action.toY,
                durationMs: input.action.durationMs,
              };
              break;
            case "press-button":
              plan = {
                kind: "devicePressButton",
                ...prepared.target,
                button: input.action.button,
              };
              break;
          }
          break;
        }
        case AGENT_CONTROL_MCP_TOOLS.proposeDeviceRecording: {
          const input = yield* decodeArgs(AgentControlMcpProposeDeviceRecordingInput, args);
          requestId = input.requestId;
          const prepared = yield* prepareDeviceTarget(
            session,
            input,
            `${input.action === "start" ? "Start" : "Stop"} recording iOS Simulator ${input.udid}`,
            "device-lifecycle",
          );
          plan = {
            kind: input.action === "start" ? "deviceStartRecording" : "deviceStopRecording",
            ...prepared.target,
          };
          break;
        }
        case AGENT_CONTROL_MCP_TOOLS.proposeDeviceShutdown: {
          const input = yield* decodeArgs(AgentControlMcpProposeDeviceShutdownInput, args);
          requestId = input.requestId;
          const prepared = yield* prepareDeviceTarget(
            session,
            input,
            `Shut down iOS Simulator ${input.udid}`,
            "device-lifecycle",
          );
          plan = { kind: "deviceShutdown", ...prepared.target };
          break;
        }
        default:
          return yield* failTool("Unknown device control tool.");
      }
      return yield* submitMutation({ session, authority, requestId, plan });
    });

  const automationFailure = () => new ToolFailure("Automation request failed.");

  const listAutomations = (session: AgentControlSessionRecord, args: unknown) =>
    Effect.gen(function* () {
      if (deps.automations === undefined)
        return yield* failTool("Automation reads are unavailable.");
      const input = yield* decodeArgs(AgentControlMcpListAutomationsInput, args);
      const scope = yield* sessionScope(session);
      if (input.projectId !== undefined && input.projectId !== scope.projectId) {
        return yield* failTool("Project scope denied.");
      }
      const automations = yield* deps.automations
        .list({
          ...scope,
          includeDisabled: input.includeDisabled ?? false,
          limit: clampLimit(
            input.limit,
            AGENT_CONTROL_MCP_LIST_LIMIT_DEFAULT,
            AGENT_CONTROL_MCP_LIST_LIMIT_MAX,
          ),
        })
        .pipe(Effect.mapError(automationFailure));
      return Schema.encodeSync(AgentControlMcpListAutomationsResult)({
        automations: automations.map((automation) => toAutomationSummary(automation)),
        limits: {
          maxActivePerProject: AGENT_CONTROL_AUTOMATION_MAX_ACTIVE_PER_PROJECT,
          minIntervalMs: AGENT_CONTROL_AUTOMATION_MIN_INTERVAL_MS,
          maxHorizonMs: AGENT_CONTROL_AUTOMATION_MAX_HORIZON_MS,
          runHistoryMax: AGENT_CONTROL_AUTOMATION_RUN_HISTORY_MAX,
        },
      });
    });

  const readAutomation = (session: AgentControlSessionRecord, args: unknown) =>
    Effect.gen(function* () {
      if (deps.automations === undefined)
        return yield* failTool("Automation reads are unavailable.");
      const input = yield* decodeArgs(AgentControlMcpReadAutomationInput, args);
      const scope = yield* sessionScope(session);
      const automation = yield* deps.automations
        .get(input.automationId, scope)
        .pipe(Effect.mapError(automationFailure));
      return Schema.encodeSync(AgentControlMcpReadAutomationResult)({
        automation: toAutomationSummary(automation, true),
      });
    });

  const listAutomationRuns = (session: AgentControlSessionRecord, args: unknown) =>
    Effect.gen(function* () {
      if (deps.automations === undefined)
        return yield* failTool("Automation reads are unavailable.");
      const input = yield* decodeArgs(AgentControlMcpListAutomationRunsInput, args);
      const scope = yield* sessionScope(session);
      const limit = clampLimit(
        input.limit,
        AGENT_CONTROL_MCP_LIST_LIMIT_DEFAULT,
        AGENT_CONTROL_AUTOMATION_RUN_HISTORY_MAX,
      );
      const runs = yield* deps.automations
        .listRuns(input.automationId, { ...scope, limit })
        .pipe(Effect.mapError(automationFailure));
      return Schema.encodeSync(AgentControlMcpListAutomationRunsResult)({
        runs,
        historyLimit: AGENT_CONTROL_AUTOMATION_RUN_HISTORY_MAX,
      });
    });

  const proposeAutomationCreate = (
    session: AgentControlSessionRecord,
    authority: AgentControlTurnAuthority,
    args: unknown,
  ) =>
    Effect.gen(function* () {
      const input = yield* decodeArgs(AgentControlMcpProposeAutomationCreateInput, args);
      const automationId = AgentControlAutomationId.make(
        `automation-${createHash("sha256")
          .update(`${session.threadId}:${input.requestId}`)
          .digest("hex")
          .slice(0, 32)}`,
      );
      return yield* submitMutation({
        session,
        authority,
        requestId: input.requestId,
        plan: {
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
              envMode: input.envMode,
              ...(input.baseRef === undefined ? {} : { baseRef: input.baseRef }),
            },
            schedule: input.schedule,
            enabled: input.enabled ?? true,
          },
        },
      });
    });

  const proposeAutomationUpdate = (
    session: AgentControlSessionRecord,
    authority: AgentControlTurnAuthority,
    args: unknown,
  ) =>
    Effect.gen(function* () {
      if (deps.automations === undefined) {
        return yield* failTool("Automation proposal creation is unavailable.");
      }
      const input = yield* decodeArgs(AgentControlMcpProposeAutomationUpdateInput, args);
      const scope = yield* sessionScope(session);
      const current = yield* deps.automations
        .get(input.automationId, scope)
        .pipe(Effect.mapError(automationFailure));
      if (current.revision !== input.expectedRevision) {
        return yield* failTool("Automation revision changed.");
      }
      const currentExecution = current.definition.execution;
      const nextBaseRef =
        input.baseRef === null ? undefined : (input.baseRef ?? currentExecution.baseRef);
      const nextOptions = input.options ?? currentExecution.modelSelection.options;
      return yield* submitMutation({
        session,
        authority,
        requestId: input.requestId,
        plan: {
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
              projectId: currentExecution.projectId,
              title: input.title ?? currentExecution.title,
              prompt: input.prompt ?? currentExecution.prompt,
              modelSelection: {
                instanceId: input.providerInstanceId ?? currentExecution.modelSelection.instanceId,
                model: input.model ?? currentExecution.modelSelection.model,
                ...(nextOptions === undefined ? {} : { options: nextOptions }),
              },
              runtimeMode: input.runtimeMode ?? currentExecution.runtimeMode,
              envMode: input.envMode ?? currentExecution.envMode,
              ...(nextBaseRef === undefined ? {} : { baseRef: nextBaseRef }),
            },
            schedule: input.schedule ?? current.definition.schedule,
            enabled: input.enabled ?? current.definition.enabled,
          },
        },
      });
    });

  const proposeAutomationCancel = (
    session: AgentControlSessionRecord,
    authority: AgentControlTurnAuthority,
    args: unknown,
  ) =>
    Effect.gen(function* () {
      if (deps.automations === undefined) {
        return yield* failTool("Automation proposal creation is unavailable.");
      }
      const input = yield* decodeArgs(AgentControlMcpProposeAutomationCancelInput, args);
      const scope = yield* sessionScope(session);
      const current = yield* deps.automations
        .get(input.automationId, scope)
        .pipe(Effect.mapError(automationFailure));
      if (current.revision !== input.expectedRevision) {
        return yield* failTool("Automation revision changed.");
      }
      return yield* submitMutation({
        session,
        authority,
        requestId: input.requestId,
        plan: {
          kind: "cancelAutomation",
          automationId: current.automationId,
          expected: {
            revision: current.revision,
            definition: current.definition,
            cancelled: current.cancelled,
            updatedAt: current.updatedAt,
          },
        },
      });
    });

  const operationalInput = (session: AgentControlSessionRecord, args: unknown) =>
    Effect.gen(function* () {
      if (deps.diagnostics === undefined)
        return yield* failTool("Operational reads are unavailable.");
      const input = yield* decodeArgs(AgentControlMcpOperationalReadInput, args);
      const scope = yield* sessionScope(session);
      return { diagnostics: deps.diagnostics, input, scope };
    });

  const recentActivity = (session: AgentControlSessionRecord, args: unknown) =>
    operationalInput(session, args).pipe(
      Effect.flatMap(({ diagnostics, input, scope }) => diagnostics.recentActivity(scope, input)),
      Effect.map(Schema.encodeSync(AgentControlMcpRecentActivityResult)),
      Effect.mapError(() => new ToolFailure("Operational read failed.")),
    );

  const orchestrationEvents = (session: AgentControlSessionRecord, args: unknown) =>
    operationalInput(session, args).pipe(
      Effect.flatMap(({ diagnostics, input, scope }) =>
        diagnostics.orchestrationEvents(scope, input),
      ),
      Effect.map(Schema.encodeSync(AgentControlMcpOrchestrationEventsResult)),
      Effect.mapError(() => new ToolFailure("Operational read failed.")),
    );

  const providerRuntimeEvents = (session: AgentControlSessionRecord, args: unknown) =>
    operationalInput(session, args).pipe(
      Effect.flatMap(({ diagnostics, input, scope }) =>
        diagnostics.providerRuntimeEvents(scope, input),
      ),
      Effect.map(Schema.encodeSync(AgentControlMcpProviderRuntimeEventsResult)),
      Effect.mapError(() => new ToolFailure("Operational read failed.")),
    );

  const diagnosticsSummary = (session: AgentControlSessionRecord, args: unknown) =>
    Effect.gen(function* () {
      if (deps.diagnostics === undefined) return yield* failTool("Diagnostics are unavailable.");
      const input = yield* decodeArgs(AgentControlMcpDiagnosticsSummaryInput, args);
      const scope = yield* sessionScope(session);
      if (
        (input.projectId !== undefined && input.projectId !== scope.projectId) ||
        (input.providerInstanceId !== undefined &&
          input.providerInstanceId !== scope.providerInstanceId)
      )
        return yield* failTool("Diagnostics scope denied.");
      const result = yield* deps.diagnostics
        .summary(scope)
        .pipe(Effect.mapError(() => new ToolFailure("Diagnostics read failed.")));
      return Schema.encodeSync(AgentControlMcpDiagnosticsSummaryResult)(result);
    });

  const listProjects = (_session: AgentControlSessionRecord, args: unknown) =>
    Effect.gen(function* () {
      const input = yield* decodeArgs(AgentControlMcpListProjectsInput, args);
      const limit = clampLimit(
        input.limit,
        AGENT_CONTROL_MCP_LIST_LIMIT_DEFAULT,
        AGENT_CONTROL_MCP_LIST_LIMIT_MAX,
      );
      const snapshot = yield* deps.projections
        .getShellSnapshot()
        .pipe(Effect.mapError(() => new ToolFailure("Project list read failed.")));
      const page = paginate({
        kind: "projects",
        rows: snapshot.projects,
        order: (project) => ({ createdAt: project.createdAt, id: project.id }),
        limit,
        cursor: input.cursor,
      });
      if (page === null) return yield* failTool("Invalid cursor.");
      return Schema.encodeSync(AgentControlMcpListProjectsResult)({
        projects: page.items.map((project) => ({
          projectId: project.id,
          title: project.title,
          createdAt: project.createdAt,
          updatedAt: project.updatedAt,
        })),
        nextCursor: page.nextCursor,
      });
    });

  const listThreads = (_session: AgentControlSessionRecord, args: unknown) =>
    Effect.gen(function* () {
      const input = yield* decodeArgs(AgentControlMcpListThreadsInput, args);
      const limit = clampLimit(
        input.limit,
        AGENT_CONTROL_MCP_LIST_LIMIT_DEFAULT,
        AGENT_CONTROL_MCP_LIST_LIMIT_MAX,
      );
      const snapshot = yield* deps.projections
        .getShellSnapshot()
        .pipe(Effect.mapError(() => new ToolFailure("Thread list read failed.")));
      const rows = snapshot.threads.filter(
        (thread) =>
          (input.projectId === undefined || thread.projectId === input.projectId) &&
          (input.includeArchived === true || thread.archivedAt === null),
      );
      const page = paginate({
        kind: "threads",
        rows,
        order: (thread) => ({ createdAt: thread.createdAt, id: thread.id }),
        limit,
        cursor: input.cursor,
      });
      if (page === null) return yield* failTool("Invalid cursor.");
      return Schema.encodeSync(AgentControlMcpListThreadsResult)({
        threads: page.items.map(toThreadSummary),
        nextCursor: page.nextCursor,
      });
    });

  const readThread = (_session: AgentControlSessionRecord, args: unknown) =>
    Effect.gen(function* () {
      const input = yield* decodeArgs(AgentControlMcpReadThreadInput, args);
      const limit = clampLimit(
        input.messageLimit,
        AGENT_CONTROL_MCP_MESSAGE_LIMIT_DEFAULT,
        AGENT_CONTROL_MCP_MESSAGE_LIMIT_MAX,
      );
      const shell = yield* deps.projections
        .getThreadShellById(input.threadId)
        .pipe(Effect.mapError(() => new ToolFailure("Thread read failed.")));
      if (Option.isNone(shell)) return yield* failTool("Thread not found.");

      const getThreadWindow = deps.projections.getThreadWindow;
      const getThreadHistoryPage = deps.projections.getThreadHistoryPage;
      if (getThreadWindow === undefined || getThreadHistoryPage === undefined) {
        return yield* failTool("Thread history is unavailable.");
      }

      const mapHistoryError = (error: { readonly _tag: string; readonly reason?: string }) =>
        error._tag === "OrchestrationThreadHistoryError"
          ? error.reason === "thread-not-found"
            ? new ToolFailure("Thread not found.")
            : new ToolFailure("Invalid or stale cursor.")
          : new ToolFailure("Thread read failed.");

      let messages: ReadonlyArray<OrchestrationMessage>;
      let pageInfo: OrchestrationThreadHistoryPageInfo;
      if (input.cursor === undefined) {
        const window = yield* getThreadWindow({
          threadId: input.threadId,
          limits: { messages: limit, proposedPlans: 1, activities: 1, checkpoints: 1 },
        }).pipe(Effect.mapError(mapHistoryError));
        messages = window.thread.messages;
        pageInfo = window.history.messages;
      } else {
        const cursor = Schema.decodeUnknownOption(OrchestrationThreadHistoryCursor)(input.cursor);
        if (Option.isNone(cursor)) return yield* failTool("Invalid or stale cursor.");
        const historyPage = yield* getThreadHistoryPage({
          threadId: input.threadId,
          collection: "messages",
          mode: { kind: "before", cursor: cursor.value },
          limit,
        }).pipe(Effect.mapError(mapHistoryError));
        if (historyPage.collection !== "messages") {
          return yield* failTool("Thread read failed.");
        }
        messages = historyPage.items;
        pageInfo = historyPage.page;
      }

      return Schema.encodeSync(AgentControlMcpReadThreadResult)({
        thread: toThreadSummary(shell.value),
        messages: applyTranscriptTextBudget(messages.map(toMcpMessage)),
        hasMoreBefore: pageInfo.hasMoreBefore,
        nextCursor: pageInfo.hasMoreBefore ? pageInfo.oldestCursor : null,
      });
    });

  const readControlRequest = (session: AgentControlSessionRecord, args: unknown) =>
    Effect.gen(function* () {
      const input = yield* decodeArgs(AgentControlMcpReadControlRequestInput, args);
      const proposal = yield* readProposalForSession(session, input.proposalId);
      return Schema.encodeSync(AgentControlMcpControlRequestResult)({
        receipt: toAgentControlProposalReceipt(proposal),
      });
    });

  const waitForControlRequest = (session: AgentControlSessionRecord, args: unknown) =>
    Effect.gen(function* () {
      const input = yield* decodeArgs(AgentControlMcpWaitForControlRequestInput, args);
      const waitFor = input.waitFor ?? "decided";
      const timeoutMs = clampLimit(
        input.timeoutMs,
        AGENT_CONTROL_MCP_WAIT_TIMEOUT_MS_DEFAULT,
        AGENT_CONTROL_MCP_WAIT_TIMEOUT_MS_MAX,
      );

      return yield* Effect.scoped(
        Effect.gen(function* () {
          // Subscribe before the initial read so no transition between the
          // read and the stream start can be missed.
          const subscription = yield* deps.proposalEvents.subscribe;
          const current = yield* readProposalForSession(session, input.proposalId);
          if (waitConditionMet(current.status, waitFor)) {
            return Schema.encodeSync(AgentControlMcpControlRequestResult)({
              receipt: toAgentControlProposalReceipt(current),
              timedOut: false,
            });
          }

          const matched = yield* Stream.fromSubscription(subscription).pipe(
            Stream.filter(
              (event) =>
                event.proposal.proposalId === input.proposalId &&
                proposalVisibleToSession(event.proposal, session) &&
                waitConditionMet(event.proposal.status, waitFor),
            ),
            Stream.runHead,
            Effect.timeoutOption(Duration.millis(timeoutMs)),
            Effect.map(Option.flatten),
          );

          if (Option.isSome(matched)) {
            return Schema.encodeSync(AgentControlMcpControlRequestResult)({
              receipt: toAgentControlProposalReceipt(matched.value.proposal),
              timedOut: false,
            });
          }

          // Timed out (or the feed shut down): return the freshest state —
          // the read sweeps expiry first, so an overdue proposal converges.
          const latest = yield* readProposalForSession(session, input.proposalId);
          return Schema.encodeSync(AgentControlMcpControlRequestResult)({
            receipt: toAgentControlProposalReceipt(latest),
            timedOut: !waitConditionMet(latest.status, waitFor),
          });
        }),
      );
    });

  const callTool: AgentControlMcpTools["callTool"] = (session, name, args) => {
    const handler = (
      authority: AgentControlTurnAuthority | null,
    ): Effect.Effect<unknown, ToolFailure> => {
      switch (name) {
        case AGENT_CONTROL_MCP_TOOLS.context:
          return context(session);
        case AGENT_CONTROL_MCP_TOOLS.capabilities:
          return capabilities(session);
        case AGENT_CONTROL_MCP_TOOLS.listDevices:
          return listDevices(session, args);
        case AGENT_CONTROL_MCP_TOOLS.readDeviceState:
          return readDeviceState(session, args);
        case AGENT_CONTROL_MCP_TOOLS.readDeviceScreenshot:
          return readDeviceScreenshot(session, args);
        case AGENT_CONTROL_MCP_TOOLS.describeDeviceUi:
          return describeDeviceUi(session, args);
        case AGENT_CONTROL_MCP_TOOLS.listProjects:
          return listProjects(session, args);
        case AGENT_CONTROL_MCP_TOOLS.listThreads:
          return listThreads(session, args);
        case AGENT_CONTROL_MCP_TOOLS.readThread:
          return readThread(session, args);
        case AGENT_CONTROL_MCP_TOOLS.readControlRequest:
          return readControlRequest(session, args);
        case AGENT_CONTROL_MCP_TOOLS.waitForControlRequest:
          return waitForControlRequest(session, args);
        case AGENT_CONTROL_MCP_TOOLS.listAutomations:
          return listAutomations(session, args);
        case AGENT_CONTROL_MCP_TOOLS.readAutomation:
          return readAutomation(session, args);
        case AGENT_CONTROL_MCP_TOOLS.listAutomationRuns:
          return listAutomationRuns(session, args);
        case AGENT_CONTROL_MCP_TOOLS.recentActivity:
          return recentActivity(session, args);
        case AGENT_CONTROL_MCP_TOOLS.orchestrationEvents:
          return orchestrationEvents(session, args);
        case AGENT_CONTROL_MCP_TOOLS.providerRuntimeEvents:
          return providerRuntimeEvents(session, args);
        case AGENT_CONTROL_MCP_TOOLS.diagnosticsSummary:
          return diagnosticsSummary(session, args);
        case AGENT_CONTROL_MCP_TOOLS.createThreads:
          return authority
            ? createThreads(session, authority, args)
            : failTool("Exact active-turn write authority is unavailable.");
        case AGENT_CONTROL_MCP_TOOLS.sendMessage:
          return authority
            ? sendMessage(session, authority, args)
            : failTool("Exact active-turn write authority is unavailable.");
        case AGENT_CONTROL_MCP_TOOLS.interruptThread:
          return authority
            ? interruptThread(session, authority, args)
            : failTool("Exact active-turn write authority is unavailable.");
        case AGENT_CONTROL_MCP_TOOLS.updateThread:
          return authority
            ? updateThread(session, authority, args)
            : failTool("Exact active-turn write authority is unavailable.");
        case AGENT_CONTROL_MCP_TOOLS.settingsSummary:
          return settingsSummary();
        case AGENT_CONTROL_MCP_TOOLS.proposeProjectCreate:
          return authority
            ? proposeProjectCreate(session, authority, args)
            : failTool("Exact active-turn write authority is unavailable.");
        case AGENT_CONTROL_MCP_TOOLS.proposeProjectUpdate:
          return authority
            ? proposeProjectUpdate(session, authority, args)
            : failTool("Exact active-turn write authority is unavailable.");
        case AGENT_CONTROL_MCP_TOOLS.proposeProjectRemove:
          return authority
            ? proposeProjectRemove(session, authority, args)
            : failTool("Exact active-turn write authority is unavailable.");
        case AGENT_CONTROL_MCP_TOOLS.proposeSettingsChange:
          return authority
            ? proposeSettingsChange(session, authority, args)
            : failTool("Exact active-turn write authority is unavailable.");
        case AGENT_CONTROL_MCP_TOOLS.proposeAutomationCreate:
          return authority
            ? proposeAutomationCreate(session, authority, args)
            : failTool("Exact active-turn write authority is unavailable.");
        case AGENT_CONTROL_MCP_TOOLS.proposeAutomationUpdate:
          return authority
            ? proposeAutomationUpdate(session, authority, args)
            : failTool("Exact active-turn write authority is unavailable.");
        case AGENT_CONTROL_MCP_TOOLS.proposeAutomationCancel:
          return authority
            ? proposeAutomationCancel(session, authority, args)
            : failTool("Exact active-turn write authority is unavailable.");
        case AGENT_CONTROL_MCP_TOOLS.proposeDeviceBoot:
        case AGENT_CONTROL_MCP_TOOLS.proposeDeviceAttach:
        case AGENT_CONTROL_MCP_TOOLS.proposeDeviceDetach:
        case AGENT_CONTROL_MCP_TOOLS.proposeDeviceInstall:
        case AGENT_CONTROL_MCP_TOOLS.proposeDeviceLaunch:
        case AGENT_CONTROL_MCP_TOOLS.proposeDeviceOpenUrl:
        case AGENT_CONTROL_MCP_TOOLS.proposeDeviceInput:
        case AGENT_CONTROL_MCP_TOOLS.proposeDeviceRecording:
        case AGENT_CONTROL_MCP_TOOLS.proposeDeviceShutdown:
          return authority
            ? proposeDeviceMutation(session, authority, name, args)
            : failTool("Exact active-turn write authority is unavailable.");
        default:
          return failTool("Unknown tool.");
      }
    };

    const authorize = WRITE_TOOL_NAMES.has(name)
      ? Effect.gen(function* () {
          const authority = yield* (
            deps.getTurnAuthority?.(session.sessionId) ?? Effect.succeed(Option.none())
          );
          if (Option.isNone(authority)) {
            return yield* failTool("Exact active-turn write authority is unavailable.");
          }
          const requiredCapability = writeCapabilityForTool(name);
          if (requiredCapability === null) return yield* failTool("Unknown tool.");
          yield* deps.policy
            .authorize({
              principal: {
                kind: "provider-session",
                threadId: session.threadId,
                providerInstanceId: session.providerInstanceId,
                runtimeSessionId: session.runtimeSessionId,
                turnId: authority.value.turnId,
              },
              grantedCapabilities: session.grantedCapabilities,
              requiredCapability,
              operation: `mcp:${name}`,
            })
            .pipe(
              Effect.mapError((error) =>
                error._tag === "AgentControlDisabledError"
                  ? new ToolFailure("Agent Control is disabled.")
                  : new ToolFailure("Capability denied."),
              ),
            );
          return authority.value;
        })
      : authorizeRead(session, name).pipe(Effect.as(null));

    return authorize.pipe(
      Effect.flatMap(handler),
      Effect.map((result): AgentControlMcpToolResult =>
        isPrivateDeviceContentResult(result)
          ? { content: result.content }
          : {
              content: [{ type: "text", text: JSON.stringify(result) }],
              structuredContent: result,
            },
      ),
      Effect.catch((failure) =>
        Effect.succeed<AgentControlMcpToolResult>({
          content: [{ type: "text", text: failure.reason }],
          isError: true,
        }),
      ),
      Effect.catchDefect(() =>
        Effect.succeed<AgentControlMcpToolResult>({
          content: [{ type: "text", text: "Tool execution failed." }],
          isError: true,
        }),
      ),
    );
  };

  return {
    descriptors: TOOL_DESCRIPTORS,
    descriptorsFor,
    hasTool: (name) => toolNames.has(name),
    isWriteTool: (name) => WRITE_TOOL_NAMES.has(name),
    callTool,
  };
};
