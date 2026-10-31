import { AgentControlWorkspaces } from "../workspaceLifecycle.ts";
import { computeAgentControlPlanDigest } from "../planDigest.ts";
import {
  AgentControlListWorkspacesInput,
  AgentControlReadWorkspaceInput,
  AgentControlPlanWorkspaceInput,
  AgentControlProposeWorkspaceInput,
} from "@ryco/contracts";
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
  AGENT_CONTROL_MCP_MESSAGE_LIMIT_MAX,
  AGENT_CONTROL_MCP_MODELS_PER_INSTANCE_MAX,
  AGENT_CONTROL_MCP_TOOLS,
  AGENT_CONTROL_MCP_TOOL_NAMES,
  AGENT_CONTROL_MCP_USAGE_LIMITS_MAX,
  AGENT_CONTROL_MCP_WAIT_TIMEOUT_MS_MAX,
  AGENT_CONTROL_CAPABILITIES,
  AGENT_CONTROL_CREATE_THREADS_MAX_CONCURRENT,
  AgentControlMcpCapabilitiesResult,
  AgentControlAutomationId,
  AgentControlProposalId,
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
  AgentControlMcpListProjectsInput,
  AgentControlMcpListProjectsResult,
  AgentControlMcpListThreadsInput,
  AgentControlMcpInterruptThreadInput,
  AgentControlMcpMutationResult,
  AgentControlMcpProposeProjectCreateInput,
  AgentControlMcpProposeProjectRemoveInput,
  AgentControlMcpProposeProjectUpdateInput,
  AgentControlMcpProposeSettingsChangeInput,
  AgentControlMcpPullRequestWatchInput,
  AgentControlMcpReadControlRequestInput,
  AgentControlMcpReadThreadInput,
  AgentControlMcpSendMessageInput,
  AgentControlMcpSettingsSummaryResult,
  AgentControlMcpUpdateThreadInput,
  AgentControlMcpUsageLimitsInput,
  AgentControlMcpUsageLimitsResult,
  AgentControlMcpWaitForControlRequestInput,
  type AgentControlAutomation,
  type AgentControlMcpProviderInstanceSummary,
  type AgentControlProposal,
  type AgentControlActionPlan,
  type AgentControlDeviceActionPlan,
  type AgentControlCapability,
  type CliProxyHubError,
  type OrchestrationProjectShell,
  type ServerProvider,
  type ServerSettings,
  type ServerSettingsError,
} from "@ryco/contracts";
import { projectKindOf } from "@ryco/shared/projectKind";
import { Clock, Effect, Option, Schema } from "effect";

import {
  type ProjectionSnapshotQueryShape,
  readProjectShells,
} from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import type { CliProxyCachedHub } from "../../cliProxy/CliProxyService.ts";
import type { DeviceServiceShape } from "../../device/Services/DeviceService.ts";
import { fitScreenshotToBase64Budget } from "../../screenshotFit.ts";
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
import {
  automationDefinitionAfterUpdateInput,
  automationDefinitionFromCreateInput,
} from "../automationToolInput.ts";
import { agentControlSettingsPlan, agentControlSettingsSummary } from "../settingsControl.ts";
import {
  assertSafeAgentControlDeviceUrl,
  resolveAgentControlDeviceArtifact,
} from "../deviceControl.ts";
import {
  ToolFailure,
  clampLimit,
  failTool,
  listThreadsPage,
  paginate,
  readThreadPage,
} from "./threadReads.ts";
import { readControlRequestReceipt, waitForControlRequestReceipt } from "./proposalReads.ts";
import {
  interruptThreadPlan,
  planWorkspaceLifecycle,
  pullRequestWatchPlan,
  sendMessagePlan,
  updateThreadPlan,
} from "./controlPlans.ts";
import {
  agentControlPromptSummaryForPlan,
  agentControlRiskTagsForPlan,
} from "../proposalPresentation.ts";

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
    Partial<Pick<AgentControlProposalServiceShape, "submit" | "findByRequest">>;
  readonly proposalEvents: Pick<AgentControlProposalEventsShape, "subscribe">;
  readonly projections: ProjectionSnapshotQueryShape;
  readonly getProviders: Effect.Effect<ReadonlyArray<ServerProvider>>;
  readonly validator?: AgentControlActionValidatorShape;
  readonly workspaces?: typeof AgentControlWorkspaces.Service;
  readonly projectPlans?: AgentControlProjectPlansShape;
  readonly automations?: AgentControlAutomationShape;
  readonly diagnostics?: AgentControlDiagnosticsShape;
  readonly deviceService?: DeviceServiceShape;
  readonly workspaceAccess?: WorkspaceAccessPolicyShape;
  readonly getSettings?: Effect.Effect<ServerSettings, ServerSettingsError>;
  /** Enabled CLIProxyAPI hubs as earlier reads cached them (`CliProxyService.cachedQuotas`). */
  readonly getCliProxyHubs?: Effect.Effect<ReadonlyArray<CliProxyCachedHub>, CliProxyHubError>;
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

interface PrivateDeviceContentResult {
  readonly _tag: "PrivateDeviceContentResult";
  readonly content: AgentControlMcpToolResult["content"];
}

const isPrivateDeviceContentResult = (value: unknown): value is PrivateDeviceContentResult =>
  typeof value === "object" &&
  value !== null &&
  "_tag" in value &&
  value._tag === "PrivateDeviceContentResult";

export const modelSelectionSchema = {
  type: "object",
  properties: {
    instanceId: { type: "string", description: "Provider instance ID from ryco_capabilities." },
    model: { type: "string", description: "Exact model slug from that provider instance." },
    options: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          value: { anyOf: [{ type: "string" }, { type: "boolean" }] },
        },
        required: ["id", "value"],
        additionalProperties: false,
      },
    },
  },
  required: ["instanceId", "model"],
  additionalProperties: false,
} as const;
const projectScriptsSchema = {
  type: "array",
  maxItems: 100,
  items: {
    type: "object",
    properties: {
      id: { type: "string" },
      name: { type: "string" },
      command: { type: "string" },
      icon: { type: "string", enum: ["play", "test", "lint", "configure", "build", "debug"] },
      runOnWorktreeCreate: { type: "boolean" },
    },
    required: ["id", "name", "command", "icon", "runOnWorktreeCreate"],
    additionalProperties: false,
  },
} as const;

const cursorSchemaProperty = { type: "string", maxLength: 1_024 } as const;
/**
 * A UI tree as JSON, measured as it travels (escaped inside the result's
 * JSON, in UTF-8), with room left in the 512 KiB response cap
 * (`transportGuard.ts`) for the JSON-RPC envelope.
 */
const AGENT_CONTROL_DEVICE_UI_CONTENT_MAX_BYTES = 400_000;
/**
 * Base64 characters one device image may use in an Agent Control result: the
 * HTML preview's budget, which leaves about 150 KB of the 512 KiB response
 * cap for the JSON, a screen snapshot and the driving guide beside it.
 */
export const AGENT_CONTROL_DEVICE_IMAGE_MAX_BASE64_CHARS = 360_000;
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
    {
      // localTime "HH:MM" on weekdays (0 = Sunday) in an IANA timeZone; the contract checks it.
      type: "object",
      properties: {
        kind: { const: "calendar" },
        timeZone: { type: "string" },
        localTime: { type: "string" },
        weekdays: { type: "array", items: { type: "integer" } },
        startsAt: { type: "string" },
        endsAt: { type: "string" },
      },
      required: ["kind", "timeZone", "localTime", "weekdays", "startsAt", "endsAt"],
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

const pullRequestWatchInputSchema = {
  type: "object",
  properties: {
    requestId: { type: "string", maxLength: 128 },
    threadId: {
      type: "string",
      maxLength: 256,
      description: "The chat to wake; defaults to this one.",
    },
    number: { type: "integer", minimum: 1 },
    url: { type: "string", maxLength: 2048, pattern: "^https?://" },
  },
  required: ["requestId"],
  additionalProperties: false,
} as const;

// Its handler module loads on the first call, off the boot path.
const loadUsageLimits = Effect.promise(() => import("./usageLimits.ts"));

const deviceMutationTargetRequired = [
  "requestId",
  "udid",
  "expectedThreadDeviceVersion",
  "expectedAttachedDeviceUdid",
  "expectedDeviceState",
  "expectedDeviceBootSource",
  "expectedRecording",
] as const;

export const AGENT_CONTROL_MCP_TOOL_DESCRIPTORS: ReadonlyArray<AgentControlMcpToolDescriptor> = [
  {
    name: AGENT_CONTROL_MCP_TOOLS.context,
    description:
      "Identify this session's Ryco thread, project, provider instance, and granted Agent Control capabilities.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: AGENT_CONTROL_MCP_TOOLS.listDevices,
    description:
      "List bounded simulator or emulator availability and inventory for this exact Ryco thread, project, and provider instance.",
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
    description: `Request approval to ${operation} one exact simulator or emulator. This creates a proposal and does not mutate the device inline.`,
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
      "Request approval to install one exact workspace-contained .app or .apk artifact on the attached device. No install occurs inline.",
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
  ...(
    [
      [
        AGENT_CONTROL_MCP_TOOLS.listWorkspaces,
        "List a bounded page of registered workspaces and synthetic session groups in the caller's project, including archived and missing checkouts.",
        AgentControlListWorkspacesInput,
      ],
      [
        AGENT_CONTROL_MCP_TOOLS.readWorkspace,
        "Inspect one stable workspace ID, its sessions, protection and safe Git lifecycle status.",
        AgentControlReadWorkspaceInput,
      ],
      [
        AGENT_CONTROL_MCP_TOOLS.planWorkspace,
        "Read-only preflight. Returns an exact immutable lifecycle plan, digest and blockers. No approval or mutation occurs.",
        AgentControlPlanWorkspaceInput,
      ],
      [
        AGENT_CONTROL_MCP_TOOLS.proposeWorkspace,
        "Request user approval for an exact workspace lifecycle plan. Conversations are never deleted: checkout removal archives them and keeps history and branch; record-only never removes files or branches. Reuse requestId for retries; inspect receipt after partial failure.",
        AgentControlProposeWorkspaceInput,
      ],
    ] as const
  ).map(([name, description, schema]) => ({
    name,
    description,
    // Advertise closed objects so clients see unknown keys as invalid input.
    inputSchema: Schema.toJsonSchemaDocument(schema, { onExcessProperty: "error" }).schema,
  })),
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
      "Read one thread's status header and a bounded, newest-first page of its conversation messages (cursor pages older history). A message cut short carries version and nextOffsetChars: pass them with its messageId as message to read the rest. The first page also lists the thread's queued follow-ups, next first, and why the queue waits.",
    inputSchema: {
      type: "object",
      properties: {
        threadId: { type: "string", maxLength: 256 },
        messageLimit: limitSchemaProperty(AGENT_CONTROL_MCP_MESSAGE_LIMIT_MAX),
        cursor: cursorSchemaProperty,
        message: {
          type: "object",
          description: "Continue one long message instead of reading a page; not with cursor.",
          properties: {
            messageId: { type: "string", maxLength: 256 },
            version: { type: "string", maxLength: 64 },
            offsetChars: { type: "integer", minimum: 0 },
          },
          required: ["messageId", "version", "offsetChars"],
          additionalProperties: false,
        },
      },
      required: ["threadId"],
      additionalProperties: false,
    },
  },
  {
    name: AGENT_CONTROL_MCP_TOOLS.readControlRequest,
    description:
      "Read the dispatch lifecycle receipt of an Agent Control request this session created. A completed request is not a completed child task; optional completionReturns separately reports initial child-run return status and manual recovery guidance.",
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
      "Wait (bounded) until an Agent Control request this session created is decided or reaches a terminal dispatch outcome, then return its receipt. This does not wait for child task completion; inspect completionReturns with ryco_read_control_request.",
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
      "Create a bounded batch of Ryco threads, including isolated worktrees. Routine requests execute asynchronously. Keep requestId stable on retries; wait for the returned receipt to obtain created thread IDs. A completed receipt means dispatch, not task completion. Opt in per entry with returnToOrigin to have Ryco wake this chat with the task's result, or a failure/stop notice, when it reaches a terminal state; results of tasks finishing together arrive in one automatic message, even after a restart or after this chat moved on, with copies of the pages and files the task published attached. Hand this thread's artifacts (ids from ryco_list_artifacts) to a new thread with an entry's artifacts: it gets copies attached to its first message. Set maxConcurrent to run at most that many at once: the first entries start, each later one waits in its thread's follow-up queue and starts, in order, when an earlier one stops working. Confirm creation with ryco_wait_for_control_request, then end your turn instead of polling. Inspect completionReturns with ryco_read_control_request. No self-approval or exactly-once provider delivery is implied.",
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
              modelSelection: modelSelectionSchema,
              runtimeMode: {
                type: "string",
                enum: ["approval-required", "auto-accept-edits", "auto", "full-access"],
              },
              tokenMode: { type: "string", enum: ["off", "balanced", "aggressive"] },
              envMode: { type: "string", enum: ["local", "worktree"] },
              baseRef: { type: "string", maxLength: 256 },
              returnToOrigin: {
                type: "boolean",
                description:
                  "Wake this chat with this task's result or a failure/stop notice; defaults to false.",
              },
              artifacts: {
                type: "array",
                maxItems: 8,
                uniqueItems: true,
                items: { type: "string", minLength: 3, maxLength: 512 },
                description:
                  "Artifact ids of this thread (from ryco_list_artifacts) to hand over: copied into the new thread and attached to its first message. Mention them in the prompt.",
              },
              localTaskId: {
                type: "string",
                maxLength: 128,
                description:
                  "Start the thread as this Task's chat (see ryco_start_local_task_chat): recorded under the task, with the task's files on its first message. Not with artifacts.",
              },
            },
            required: ["projectId", "title", "prompt", "modelSelection", "runtimeMode", "envMode"],
            additionalProperties: false,
          },
        },
        maxConcurrent: {
          type: "integer",
          minimum: 1,
          maximum: AGENT_CONTROL_CREATE_THREADS_MAX_CONCURRENT,
          description:
            "Run at most this many entries at once, in entry order; the others wait, queued in their thread. Defaults to all at once.",
        },
      },
      required: ["requestId", "entries"],
      additionalProperties: false,
    },
  },
  {
    name: AGENT_CONTROL_MCP_TOOLS.sendMessage,
    description:
      "Queue or steer a message to a Ryco thread through the durable operation queue. A queued message joins the thread's follow-up queue, visible and editable in the chat, and is sent when the thread is idle, after follow-ups queued before it; the request completes once it is queued. Use a stable requestId for retries and read or wait for the returned receipt.",
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
      "Interrupt a Ryco thread, optionally only an exact turn, through the durable operation queue.",
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
    name: AGENT_CONTROL_MCP_TOOLS.watchPullRequest,
    description:
      "Use this instead of polling, sleeping or running a watcher: Ryco watches a pull request for a chat (this one by default) every 2 minutes, with no app open, and wakes the chat with an automatic message when a check fails, the required checks pass, someone else comments or reviews, or the branch starts to conflict. Without number or url: the pull request of the chat's workspace (one you just opened is linked first). A number or url may name a pull request of any workspace in this project. Only changes after this call wake you; the result's detail says how it stands now. End your turn after it. A wake is news, not a merge decision. Ryco stops after 8 failed reads, 10 comment-only updates in a row, or a merge or close. Before you hand the work back, call ryco_unwatch_pull_request so the chat can settle. A chat delegated with returnToOrigin cannot watch: report the pull request in your result. Waits up to 25 s for the outcome; if timedOut, use ryco_wait_for_control_request.",
    inputSchema: pullRequestWatchInputSchema,
  },
  {
    name: AGENT_CONTROL_MCP_TOOLS.unwatchPullRequest,
    description:
      "Stop Ryco waking a chat (this one by default) with a pull request's news: the one named by number or url, else the one the chat watches (of several, its own workspace's). Call it before you hand the work back, so the chat can settle. The user's Auto-fix CI keeps running.",
    inputSchema: pullRequestWatchInputSchema,
  },
  {
    name: AGENT_CONTROL_MCP_TOOLS.updateThread,
    description:
      'Update thread title, model and options, interaction mode, token mode, archive state, or persistent goal. goalStatus reports on your own thread\'s goal: "complete" when the whole objective is verified done, "blocked" when the same outside blocker has stopped progress for three goal turns; either ends Ryco\'s automatic goal turns. Archiving and runtime permission changes require approval; other changes execute asynchronously.',
    inputSchema: {
      type: "object",
      properties: {
        requestId: { type: "string", maxLength: 128 },
        threadId: { type: "string", maxLength: 256 },
        title: { type: "string", minLength: 1, maxLength: 200 },
        archived: { type: "boolean" },
        persistentGoal: { anyOf: [{ type: "string", maxLength: 4000 }, { type: "null" }] },
        goalStatus: { type: "string", enum: ["complete", "blocked"] },
        modelSelection: modelSelectionSchema,
        runtimeMode: {
          type: "string",
          enum: ["approval-required", "auto-accept-edits", "auto", "full-access"],
        },
        interactionMode: { type: "string", enum: ["default", "plan", "ask"] },
        tokenMode: { type: "string", enum: ["off", "balanced", "aggressive"] },
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
      "Update project metadata and preferences with an updatedAt revision guard. Title and preferred remote changes execute asynchronously; workspace, scripts and system prompt changes require approval.",
    inputSchema: {
      type: "object",
      properties: {
        customSystemPrompt: { anyOf: [{ type: "string", maxLength: 20000 }, { type: "null" }] },
        scripts: projectScriptsSchema,
        preferredRemoteName: { anyOf: [{ type: "string" }, { type: "null" }] },
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
      "Change an allowlisted non-secret boolean preference through the durable operation queue. Secrets, provider configuration, network access and Agent Control policy cannot be changed by this tool.",
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
      "Request approval for a bounded schedule definition. Approval creates no thread or provider turn; every due run gets a new approval request. A calendar schedule runs at localTime (HH:MM) on weekdays (0 = Sunday) in an IANA timeZone. Each run starts a new thread, or with targetThreadId queues its prompt in that existing thread of the same project (a heartbeat; sent like the thread's other follow-ups, with its current model and modes).",
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
        tokenMode: { type: "string", enum: ["off", "balanced", "aggressive"] },
        envMode: { type: "string", enum: ["local", "worktree"] },
        baseRef: { type: "string", maxLength: 256 },
        targetThreadId: { type: "string", maxLength: 256 },
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
    description:
      "Request approval for an exact revision-guarded schedule replacement. targetThreadId null makes runs start new threads again.",
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
        tokenMode: { type: "string", enum: ["off", "balanced", "aggressive"] },
        envMode: { type: "string", enum: ["local", "worktree"] },
        baseRef: { anyOf: [{ type: "string", maxLength: 256 }, { type: "null" }] },
        targetThreadId: { anyOf: [{ type: "string", maxLength: 256 }, { type: "null" }] },
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
  {
    name: AGENT_CONTROL_MCP_TOOLS.usageLimits,
    description:
      "Read the usage limits Ryco last read for each enabled provider instance and each CLIProxyAPI hub's accounts: per window the percent used, the reset time and the pace. Never asks a provider or a hub. Use it to pick an instance with headroom or to stop before a limit.",
    inputSchema: {
      type: "object",
      properties: { instanceId: { type: "string", maxLength: 256 } },
      additionalProperties: false,
    },
  },
];

const WRITE_TOOL_NAMES = new Set<string>([
  AGENT_CONTROL_MCP_TOOLS.createThreads,
  AGENT_CONTROL_MCP_TOOLS.sendMessage,
  AGENT_CONTROL_MCP_TOOLS.interruptThread,
  AGENT_CONTROL_MCP_TOOLS.updateThread,
  AGENT_CONTROL_MCP_TOOLS.proposeWorkspace,
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
  AGENT_CONTROL_MCP_TOOLS.watchPullRequest,
  AGENT_CONTROL_MCP_TOOLS.unwatchPullRequest,
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
    case AGENT_CONTROL_MCP_TOOLS.proposeWorkspace:
      return AGENT_CONTROL_CAPABILITIES.manageWorkspaces;
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
    case AGENT_CONTROL_MCP_TOOLS.watchPullRequest:
    case AGENT_CONTROL_MCP_TOOLS.unwatchPullRequest:
      return AGENT_CONTROL_CAPABILITIES.watchPullRequests;
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
  if (
    name === AGENT_CONTROL_MCP_TOOLS.diagnosticsSummary ||
    name === AGENT_CONTROL_MCP_TOOLS.usageLimits
  ) {
    return AGENT_CONTROL_CAPABILITIES.readDiagnostics;
  }
  return AGENT_CONTROL_CAPABILITIES.read;
};

// ── Result mapping ────────────────────────────────────────────────────

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
export const proposalVisibleToSession = (
  proposal: AgentControlProposal,
  session: AgentControlSessionRecord,
): boolean =>
  proposal.principal.kind === "provider-session" &&
  proposal.principal.threadId === session.threadId;

/**
 * Submits a validated mutation plan for the caller's exact turn: routine plans execute, the rest
 * wait for the user's approval. Answers with the durable receipt, as every mutation tool does.
 */
export const submitAgentControlMutation = (
  deps: Pick<AgentControlMcpToolDeps, "validator" | "proposals">,
  input: {
    readonly session: AgentControlSessionRecord;
    readonly authority: AgentControlTurnAuthority;
    readonly requestId: Parameters<AgentControlProposalServiceShape["submit"]>[0]["requestId"];
    readonly plan: AgentControlActionPlan;
  },
) =>
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
      authorizeRoutine: true,
      principal,
      requestId: input.requestId,
      plan: input.plan,
      riskTags: agentControlRiskTagsForPlan(input.plan),
      promptSummary: agentControlPromptSummaryForPlan(input.plan),
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
    deps.policy.isEnabled.pipe(
      Effect.map((enabled) =>
        AGENT_CONTROL_MCP_TOOL_DESCRIPTORS.filter((descriptor) => {
          // Providers discover and cache tools before the first turn starts.
          // Discovery is session-scoped; callTool enforces exact-turn authority.
          if (!enabled) return false;
          if (
            DEVICE_CONTROL_TOOL_NAMES.has(descriptor.name) &&
            deps.deviceService?.supported !== true
          ) {
            return false;
          }
          const capability = writeCapabilityForTool(descriptor.name);
          if (capability !== null) {
            return session.grantedCapabilities.includes(capability);
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
      const writeToolsAvailable = yield* hasWriteAuthority(session);
      return Schema.encodeSync(AgentControlMcpCapabilitiesResult)({
        enabled,
        readOnly: !writeToolsAvailable,
        tools: tools.map((tool) => tool.name),
        grantedCapabilities: session.grantedCapabilities,
        agentControl: { available: true, injectionMode: session.injectionMode },
        providerInstances: providers.map(toInstanceSummary),
      });
    });

  const submitMutation = (input: Parameters<typeof submitAgentControlMutation>[1]) =>
    submitAgentControlMutation(deps, input);

  const createThreads = (
    session: AgentControlSessionRecord,
    authority: AgentControlTurnAuthority,
    args: unknown,
  ) =>
    Effect.gen(function* () {
      const input = yield* decodeArgs(AgentControlMcpCreateThreadsInput, args);
      // A chat started as a task's writes to the task (its starts, its project): that needs the
      // task grant as well, however the chat is created.
      if (input.entries.some((entry) => entry.localTaskId !== undefined)) {
        yield* deps.policy
          .authorize({
            principal: {
              kind: "provider-session",
              threadId: session.threadId,
              providerInstanceId: session.providerInstanceId,
              runtimeSessionId: session.runtimeSessionId,
              turnId: authority.turnId,
            },
            grantedCapabilities: session.grantedCapabilities,
            requiredCapability: AGENT_CONTROL_CAPABILITIES.manageLocalTasks,
            operation: `mcp:${AGENT_CONTROL_MCP_TOOLS.createThreads}:local-task`,
          })
          .pipe(Effect.mapError(() => new ToolFailure("Capability denied.")));
      }
      return yield* submitMutation({
        session,
        authority,
        requestId: input.requestId,
        plan: {
          kind: "createThreads",
          entries: input.entries,
          ...(input.maxConcurrent === undefined ? {} : { maxConcurrent: input.maxConcurrent }),
        },
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
        plan: sendMessagePlan(input),
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
        plan: interruptThreadPlan(input),
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
        plan: updateThreadPlan(input),
      });
    });

  /**
   * Routine and quick: the answer waits (bounded) for the outcome, so the agent reads how the pull
   * request stands, or why it cannot be watched, in the same call.
   */
  const pullRequestWatch = (
    session: AgentControlSessionRecord,
    authority: AgentControlTurnAuthority,
    args: unknown,
    watching: boolean,
  ) =>
    Effect.gen(function* () {
      const input = yield* decodeArgs(AgentControlMcpPullRequestWatchInput, args);
      const submitted = yield* submitMutation({
        session,
        authority,
        requestId: input.requestId,
        plan: pullRequestWatchPlan(input, session.threadId, watching),
      });
      const settled = yield* waitForControlRequestReceipt({
        proposals: deps.proposals,
        proposalEvents: deps.proposalEvents,
        proposalId: AgentControlProposalId.make(submitted.receipt.proposalId),
        waitFor: "terminal",
        timeoutMs: undefined,
        visible: (proposal) => proposalVisibleToSession(proposal, session),
      }).pipe(
        // The request stands either way: an unreadable outcome is followed up like a slow one.
        Effect.catch(() => Effect.succeed({ receipt: submitted.receipt, timedOut: true })),
      );
      return {
        receipt: settled.receipt,
        replayed: submitted.replayed,
        timedOut: settled.timedOut ?? false,
      };
    });

  const workspaceTool = (
    session: AgentControlSessionRecord,
    name: string,
    args: unknown,
    authority: AgentControlTurnAuthority | null,
  ) =>
    Effect.gen(function* () {
      const workspaces = deps.workspaces;
      if (!workspaces) return yield* failTool("Workspace lifecycle service unavailable.");
      if (name === AGENT_CONTROL_MCP_TOOLS.listWorkspaces) {
        const input = yield* decodeArgs(AgentControlListWorkspacesInput, args);
        return yield* workspaces.list(input.projectId, session.threadId, input.after, input.limit);
      }
      if (name === AGENT_CONTROL_MCP_TOOLS.readWorkspace) {
        const input = yield* decodeArgs(AgentControlReadWorkspaceInput, args);
        return yield* workspaces.read(input.projectId, input.workspaceId, session.threadId);
      }
      if (name === AGENT_CONTROL_MCP_TOOLS.planWorkspace) {
        const input = yield* decodeArgs(AgentControlPlanWorkspaceInput, args);
        return yield* planWorkspaceLifecycle(workspaces, input, session.threadId);
      }
      if (!authority) return yield* failTool("Exact active-turn authority required.");
      const input = yield* decodeArgs(AgentControlProposeWorkspaceInput, args);
      if (deps.proposals.findByRequest) {
        const existing = yield* deps.proposals
          .findByRequest(
            {
              kind: "provider-session",
              threadId: session.threadId,
              providerInstanceId: session.providerInstanceId,
            },
            input.requestId,
          )
          .pipe(Effect.mapError(() => new ToolFailure("Control request lookup failed.")));
        if (Option.isSome(existing)) {
          if (existing.value.planDigest !== computeAgentControlPlanDigest(input.plan))
            return yield* failTool("Request ID was already used with a different plan.");
          return Schema.encodeSync(AgentControlMcpMutationResult)({
            receipt: toAgentControlProposalReceipt(existing.value),
            replayed: true,
          });
        }
      }
      return yield* submitMutation({
        session,
        authority,
        requestId: input.requestId,
        plan: input.plan,
      });
    }).pipe(
      Effect.mapError((error) =>
        error instanceof ToolFailure
          ? error
          : new ToolFailure(
              "detail" in error
                ? String(error.detail).slice(0, 500)
                : "Workspace lifecycle request failed validation.",
            ),
      ),
    );

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
      return failTool("simulator or emulator device control is unavailable.");
    }
    return Effect.succeed(deps.deviceService);
  };

  const deviceContext = (session: AgentControlSessionRecord) =>
    Effect.gen(function* () {
      const service = yield* requireDevice();
      const scope = yield* sessionScope(session);
      const projects = yield* readProjectShells(deps.projections).pipe(
        Effect.mapError(() => new ToolFailure("Device project scope is unavailable.")),
      );
      const project = projects.find((candidate) => candidate.id === scope.projectId);
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
      const image = {
        type: "image",
        data: screenshot.bytesBase64,
        mimeType: screenshot.mimeType,
      } as AgentControlMcpToolResult["content"][number];
      if (screenshot.bytesBase64.length <= AGENT_CONTROL_DEVICE_IMAGE_MAX_BASE64_CHARS) {
        return {
          _tag: "PrivateDeviceContentResult",
          content: [image],
        } satisfies PrivateDeviceContentResult;
      }
      // A full-resolution simulator PNG often passes the response cap; the
      // listener would replace it with an opaque "Response too large".
      const fitted = yield* devicePromise(
        () =>
          fitScreenshotToBase64Budget(
            screenshot.bytesBase64,
            AGENT_CONTROL_DEVICE_IMAGE_MAX_BASE64_CHARS,
          ),
        "The screenshot is too large to return.",
      );
      return {
        _tag: "PrivateDeviceContentResult",
        content: [
          // The capture's own size beside the fitted one (as device_screenshot
          // reports it): Android input coordinates are capture pixels, so a
          // position read from a scaled image needs scaling back.
          {
            type: "text",
            text: JSON.stringify({
              width: screenshot.width,
              height: screenshot.height,
              scaledToFitTransport: {
                mimeType: fitted.mimeType,
                width: fitted.width,
                height: fitted.height,
              },
            }),
          },
          {
            type: "image",
            data: fitted.data,
            mimeType: fitted.mimeType,
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
      if (
        Buffer.byteLength(JSON.stringify(encoded), "utf8") >
        AGENT_CONTROL_DEVICE_UI_CONTENT_MAX_BYTES
      ) {
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
      const projects = yield* readProjectShells(deps.projections).pipe(
        Effect.mapError(() => new ToolFailure("Device project scope is unavailable.")),
      );
      const project = projects.find((candidate) => candidate.id === scope.projectId);
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
            `Boot simulator or emulator ${input.udid}`,
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
            `Attach simulator or emulator ${input.udid} to this thread`,
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
            `Detach simulator or emulator ${input.udid} from this thread`,
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
            `Install an approved workspace application on simulator or emulator ${input.udid}`,
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
            `Launch installed application ${input.bundleId} on simulator or emulator ${input.udid}`,
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
            `Open an approved URL or deep link on simulator or emulator ${input.udid}`,
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
            `Perform one ${input.action.kind} action on simulator or emulator ${input.udid}`,
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
            `${input.action === "start" ? "Start" : "Stop"} recording simulator or emulator ${input.udid}`,
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
            `Shut down simulator or emulator ${input.udid}`,
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
          definition: automationDefinitionFromCreateInput(input),
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
          after: automationDefinitionAfterUpdateInput(current, input),
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

  const usageLimits = (args: unknown) =>
    Effect.gen(function* () {
      const input = yield* decodeArgs(AgentControlMcpUsageLimitsInput, args);
      const providers = yield* deps.getProviders;
      const hubs = yield* (deps.getCliProxyHubs ?? Effect.succeed([])).pipe(
        Effect.mapError(() => new ToolFailure("Usage limits read failed.")),
      );
      const { agentControlUsageLimits } = yield* loadUsageLimits;
      return Schema.encodeSync(AgentControlMcpUsageLimitsResult)(
        agentControlUsageLimits({
          providers,
          hubs,
          instanceId: input.instanceId,
          nowMs: yield* Clock.currentTimeMillis,
          max: AGENT_CONTROL_MCP_USAGE_LIMITS_MAX,
        }),
      );
    });

  const listProjects = (_session: AgentControlSessionRecord, args: unknown) =>
    Effect.gen(function* () {
      const input = yield* decodeArgs(AgentControlMcpListProjectsInput, args);
      const limit = clampLimit(
        input.limit,
        AGENT_CONTROL_MCP_LIST_LIMIT_DEFAULT,
        AGENT_CONTROL_MCP_LIST_LIMIT_MAX,
      );
      const projects = yield* readProjectShells(deps.projections).pipe(
        Effect.mapError(() => new ToolFailure("Project list read failed.")),
      );
      const page = paginate({
        kind: "projects",
        rows: projects,
        order: (project) => ({ createdAt: project.createdAt, id: project.id }),
        limit,
        cursor: input.cursor,
      });
      if (page === null) return yield* failTool("Invalid cursor.");
      return Schema.encodeSync(AgentControlMcpListProjectsResult)({
        projects: page.items.map((project) => ({
          projectId: project.id,
          kind: projectKindOf(project),
          title: project.title,
          createdAt: project.createdAt,
          updatedAt: project.updatedAt,
        })),
        nextCursor: page.nextCursor,
      });
    });

  const listThreads = (_session: AgentControlSessionRecord, args: unknown) =>
    decodeArgs(AgentControlMcpListThreadsInput, args).pipe(
      Effect.flatMap((input) => listThreadsPage(deps.projections, input)),
    );

  const readThread = (_session: AgentControlSessionRecord, args: unknown) =>
    decodeArgs(AgentControlMcpReadThreadInput, args).pipe(
      Effect.flatMap((input) => readThreadPage(deps.projections, input)),
    );

  const readControlRequest = (session: AgentControlSessionRecord, args: unknown) =>
    decodeArgs(AgentControlMcpReadControlRequestInput, args).pipe(
      Effect.flatMap((input) =>
        readControlRequestReceipt(deps.proposals, input.proposalId, (proposal) =>
          proposalVisibleToSession(proposal, session),
        ),
      ),
    );

  const waitForControlRequest = (session: AgentControlSessionRecord, args: unknown) =>
    decodeArgs(AgentControlMcpWaitForControlRequestInput, args).pipe(
      Effect.flatMap((input) =>
        waitForControlRequestReceipt({
          proposals: deps.proposals,
          proposalEvents: deps.proposalEvents,
          proposalId: input.proposalId,
          waitFor: input.waitFor,
          timeoutMs: input.timeoutMs,
          visible: (proposal) => proposalVisibleToSession(proposal, session),
        }),
      ),
    );

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
        case AGENT_CONTROL_MCP_TOOLS.listWorkspaces:
        case AGENT_CONTROL_MCP_TOOLS.readWorkspace:
        case AGENT_CONTROL_MCP_TOOLS.planWorkspace:
        case AGENT_CONTROL_MCP_TOOLS.proposeWorkspace:
          return workspaceTool(session, name, args, authority);
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
        case AGENT_CONTROL_MCP_TOOLS.usageLimits:
          return usageLimits(args);
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
        case AGENT_CONTROL_MCP_TOOLS.watchPullRequest:
        case AGENT_CONTROL_MCP_TOOLS.unwatchPullRequest:
          return authority
            ? pullRequestWatch(
                session,
                authority,
                args,
                name === AGENT_CONTROL_MCP_TOOLS.watchPullRequest,
              )
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
    descriptors: AGENT_CONTROL_MCP_TOOL_DESCRIPTORS,
    descriptorsFor,
    hasTool: (name) => toolNames.has(name),
    isWriteTool: (name) => WRITE_TOOL_NAMES.has(name),
    callTool,
  };
};

/** Keep capabilities in sync with every optional catalog extension. */
export const withCompleteAgentControlCatalog = (
  base: AgentControlMcpTools,
): AgentControlMcpTools => ({
  ...base,
  callTool: (session, name, args) =>
    base.callTool(session, name, args).pipe(
      Effect.flatMap((result) => {
        if (name !== AGENT_CONTROL_MCP_TOOLS.capabilities || result.isError)
          return Effect.succeed(result);
        const capabilities = Schema.decodeUnknownOption(AgentControlMcpCapabilitiesResult)(
          result.structuredContent,
        );
        if (Option.isNone(capabilities)) return Effect.succeed(result);
        return base.descriptorsFor(session).pipe(
          Effect.map((descriptors) => {
            const value = { ...capabilities.value, tools: descriptors.map((tool) => tool.name) };
            return {
              content: [{ type: "text" as const, text: JSON.stringify(value) }],
              structuredContent: value,
            };
          }),
        );
      }),
    ),
});
