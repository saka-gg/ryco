/**
 * Agent Control MCP contracts: the internal provider-session MCP surface (tool
 * names, bounded inputs and results) and the external stdio MCP tool catalog.
 *
 * Only the server speaks these. They live apart from `agentControl.ts`, which
 * every client evaluates at startup for the proposal stream, because a bundler
 * keeps every top-level schema of a module it includes: here they stay out of
 * the client bundles entirely.
 *
 * @module agentControlMcp
 */
import * as Schema from "effect/Schema";
import {
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  RuntimeSessionId,
  ThreadId,
  TrimmedNonEmptyString,
  TurnId,
  rejectExcessProperties,
} from "./baseSchemas.ts";
import {
  AgentTokenMode,
  OrchestrationSessionStatus,
  OptionalProjectKind,
  RuntimeMode,
} from "./orchestration.ts";
import { ProviderOptionSelections } from "./model.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";
import { ServerProviderAvailability, ServerProviderState } from "./server.ts";
import { ThreadEnvMode } from "./settings.ts";
import {
  DeviceAttachPhase,
  DeviceAvailability,
  DeviceBootSource,
  DeviceBundleId,
  DeviceDescriptor,
  DeviceHardwareButton,
  DeviceRuntimeState,
  DeviceUdid,
  DEVICE_SWIPE_DURATION_MAX_MS,
  DEVICE_SWIPE_DURATION_MIN_MS,
} from "./device.ts";
import {
  AGENT_CONTROL_DEVICE_URL_MAX_CHARS,
  AGENT_CONTROL_PERSISTENT_GOAL_MAX_CHARS,
  AgentControlAutomationExecutionTemplate,
  AgentControlAutomationId,
  AgentControlAutomationRun,
  AgentControlAutomationSchedule,
  AgentControlCapability,
  AgentControlCreateThreadsPlan,
  AgentControlDeviceArtifactPath,
  AgentControlDeviceCoordinate,
  AgentControlExternalClientKind,
  AgentControlExternalProjectScope,
  AgentControlExternalTaskId,
  AgentControlIntegrationId,
  AgentControlProjectPreferences,
  AgentControlPrompt,
  AgentControlProposalId,
  AgentControlProposalReceipt,
  AgentControlRequestId,
  AgentControlSendMessageDelivery,
  AgentControlSendMessagePlan,
  AgentControlThreadPreferences,
  AgentControlTitle,
  AgentControlWorkspaceRoot,
} from "./agentControl.ts";

// ── Internal provider-session MCP surface ─────────────────────────────
//
// The server exposes a private, loopback-only MCP endpoint to supported
// provider runtimes. This section defines the tool names and the bounded
// input/result payloads those tools exchange. The credential material that
// authenticates a provider session never appears in these contracts — it
// is issued in-memory per provider runtime and revoked with it.

/** Transport actually installed for one internal provider runtime. */
export const AgentControlInjectionMode = Schema.Literals([
  "codex-http",
  "claude-http",
  "acp-http",
  "acp-stdio-proxy",
  "copilot-http",
  "opencode-http",
]);
export type AgentControlInjectionMode = typeof AgentControlInjectionMode.Type;

/** Code-facing support decision for one provider driver's internal MCP surface. */
export const AgentControlProviderSupport = Schema.Struct({
  supported: Schema.Boolean,
  runtimeScoped: Schema.Boolean,
  http: Schema.Literals(["native", "advertised", "unsupported"]),
  stdio: Schema.Literals(["native", "proxy", "unsupported"]),
  configurationScope: Schema.Literals([
    "runtime-session",
    "process",
    "directory",
    "user",
    "global",
    "unknown",
  ]),
  credentialIsolation: Schema.Literals([
    "scoped-header",
    "scoped-header-or-bootstrap",
    "unsafe",
    "unavailable",
  ]),
  reason: Schema.NullOr(TrimmedNonEmptyString),
});
export type AgentControlProviderSupport = typeof AgentControlProviderSupport.Type;

export const AgentControlProviderAvailability = Schema.Struct({
  ...AgentControlProviderSupport.fields,
  available: Schema.Boolean,
  unavailableReason: Schema.NullOr(TrimmedNonEmptyString),
});
export type AgentControlProviderAvailability = typeof AgentControlProviderAvailability.Type;

/**
 * The complete internal MCP tool catalog. Mutation tools create immutable
 * approval proposals; they never execute their requested action inline.
 */
export const AGENT_CONTROL_MCP_TOOLS = {
  context: "ryco_context",
  capabilities: "ryco_capabilities",
  listProjects: "ryco_list_projects",
  listWorkspaces: "ryco_list_workspaces",
  readWorkspace: "ryco_read_workspace",
  planWorkspace: "ryco_plan_workspace_lifecycle",
  proposeWorkspace: "ryco_propose_workspace_lifecycle",
  listThreads: "ryco_list_threads",
  readThread: "ryco_read_thread",
  readControlRequest: "ryco_read_control_request",
  waitForControlRequest: "ryco_wait_for_control_request",
  createThreads: "ryco_create_threads",
  sendMessage: "ryco_send_message",
  interruptThread: "ryco_interrupt_thread",
  updateThread: "ryco_update_thread",
  settingsSummary: "ryco_settings_summary",
  proposeProjectCreate: "ryco_propose_project_create",
  proposeProjectUpdate: "ryco_propose_project_update",
  proposeProjectRemove: "ryco_propose_project_remove",
  proposeSettingsChange: "ryco_propose_settings_change",
  listAutomations: "ryco_list_automations",
  readAutomation: "ryco_read_automation",
  listAutomationRuns: "ryco_list_automation_runs",
  proposeAutomationCreate: "ryco_propose_automation_create",
  proposeAutomationUpdate: "ryco_propose_automation_update",
  proposeAutomationCancel: "ryco_propose_automation_cancel",
  recentActivity: "ryco_recent_activity",
  orchestrationEvents: "ryco_orchestration_events",
  providerRuntimeEvents: "ryco_provider_runtime_events",
  diagnosticsSummary: "ryco_diagnostics_summary",
  listDevices: "ryco_list_devices",
  readDeviceState: "ryco_read_device_state",
  readDeviceScreenshot: "ryco_read_device_screenshot",
  describeDeviceUi: "ryco_describe_device_ui",
  proposeDeviceBoot: "ryco_propose_device_boot",
  proposeDeviceAttach: "ryco_propose_device_attach",
  proposeDeviceDetach: "ryco_propose_device_detach",
  proposeDeviceInstall: "ryco_propose_device_install",
  proposeDeviceLaunch: "ryco_propose_device_launch",
  proposeDeviceOpenUrl: "ryco_propose_device_open_url",
  proposeDeviceInput: "ryco_propose_device_input",
  proposeDeviceRecording: "ryco_propose_device_recording",
  proposeDeviceShutdown: "ryco_propose_device_shutdown",
} as const;
export type AgentControlMcpToolName =
  (typeof AGENT_CONTROL_MCP_TOOLS)[keyof typeof AGENT_CONTROL_MCP_TOOLS];

export const AGENT_CONTROL_MCP_TOOL_NAMES: ReadonlyArray<AgentControlMcpToolName> =
  Object.values(AGENT_CONTROL_MCP_TOOLS);

// Server-side clamps for list/read tools. Inputs above a max are capped,
// not rejected; absent limits use the defaults.
export const AGENT_CONTROL_MCP_LIST_LIMIT_MAX = 50;
export const AGENT_CONTROL_MCP_LIST_LIMIT_DEFAULT = 20;
export const AGENT_CONTROL_MCP_MESSAGE_LIMIT_MAX = 50;
export const AGENT_CONTROL_MCP_MESSAGE_LIMIT_DEFAULT = 20;
/** Per-message transcript text cap; longer text is truncated and flagged. */
export const AGENT_CONTROL_MCP_MESSAGE_TEXT_MAX_CHARS = 8_000;
/**
 * Aggregate transcript text budget per `ryco_read_thread` page. Newest
 * messages keep their text; older messages beyond the budget are
 * truncated (down to empty) and flagged, so a max-limit page of max-length
 * messages still fits the listener's bounded response size even after the
 * MCP dual text/structured serialization.
 */
export const AGENT_CONTROL_MCP_READ_THREAD_TEXT_BUDGET_CHARS = 80_000;
/** Wait bounds for `ryco_wait_for_control_request` (milliseconds). */
export const AGENT_CONTROL_MCP_WAIT_TIMEOUT_MS_MAX = 50_000;
export const AGENT_CONTROL_MCP_WAIT_TIMEOUT_MS_DEFAULT = 25_000;
export const AGENT_CONTROL_MCP_OPERATIONAL_LIMIT_MAX = 50;
export const AGENT_CONTROL_MCP_OPERATIONAL_LIMIT_DEFAULT = 20;
export const AGENT_CONTROL_MCP_OPERATIONAL_RANGE_MAX_MS = 24 * 60 * 60_000;
export const AGENT_CONTROL_MCP_OPERATIONAL_RETENTION_MS = 7 * 24 * 60 * 60_000;
export const AGENT_CONTROL_MCP_ORCHESTRATION_SCAN_MAX = 500;
/** Per-item preview cap in list/activity responses; a single read returns the full bounded prompt. */
export const AGENT_CONTROL_MCP_AUTOMATION_LIST_PROMPT_MAX_CHARS = 1_000;

/**
 * Opaque pagination cursor. List cursors are minted by the server and are
 * only meaningful to the tool that issued them; thread-history cursors
 * reuse the orchestration history cursor encoding. Bounded so a caller
 * cannot smuggle unbounded payloads through the cursor field.
 */
export const AgentControlMcpCursor = TrimmedNonEmptyString.check(Schema.isMaxLength(1_024));
export type AgentControlMcpCursor = typeof AgentControlMcpCursor.Type;

// ── Tool inputs ───────────────────────────────────────────────────────

export const AgentControlMcpListProjectsInput = Schema.Struct({
  limit: Schema.optional(PositiveInt),
  cursor: Schema.optional(AgentControlMcpCursor),
});
export type AgentControlMcpListProjectsInput = typeof AgentControlMcpListProjectsInput.Type;

export const AgentControlMcpListThreadsInput = Schema.Struct({
  projectId: Schema.optional(ProjectId),
  includeArchived: Schema.optional(Schema.Boolean),
  limit: Schema.optional(PositiveInt),
  cursor: Schema.optional(AgentControlMcpCursor),
});
export type AgentControlMcpListThreadsInput = typeof AgentControlMcpListThreadsInput.Type;

export const AgentControlMcpReadThreadInput = Schema.Struct({
  threadId: ThreadId,
  messageLimit: Schema.optional(PositiveInt),
  /** Page older history; minted by a previous `ryco_read_thread` call. */
  cursor: Schema.optional(AgentControlMcpCursor),
});
export type AgentControlMcpReadThreadInput = typeof AgentControlMcpReadThreadInput.Type;

export const AgentControlMcpReadControlRequestInput = Schema.Struct({
  proposalId: AgentControlProposalId,
});
export type AgentControlMcpReadControlRequestInput =
  typeof AgentControlMcpReadControlRequestInput.Type;

export const AgentControlMcpWaitCondition = Schema.Literals(["decided", "terminal"]);
export type AgentControlMcpWaitCondition = typeof AgentControlMcpWaitCondition.Type;

export const AgentControlMcpWaitForControlRequestInput = Schema.Struct({
  proposalId: AgentControlProposalId,
  /** `decided` (default): any status past pending. `terminal`: a final outcome. */
  waitFor: Schema.optional(AgentControlMcpWaitCondition),
  /** Capped at `AGENT_CONTROL_MCP_WAIT_TIMEOUT_MS_MAX`. */
  timeoutMs: Schema.optional(PositiveInt),
});
export type AgentControlMcpWaitForControlRequestInput =
  typeof AgentControlMcpWaitForControlRequestInput.Type;

export const AgentControlMcpCreateThreadsInput = Schema.Struct({
  requestId: AgentControlRequestId,
  entries: AgentControlCreateThreadsPlan.fields.entries,
}).pipe(rejectExcessProperties);
export type AgentControlMcpCreateThreadsInput = typeof AgentControlMcpCreateThreadsInput.Type;

export const AgentControlMcpSendMessageInput = Schema.Struct({
  requestId: AgentControlRequestId,
  threadId: ThreadId,
  text: AgentControlSendMessagePlan.fields.text,
  delivery: AgentControlSendMessageDelivery,
}).pipe(rejectExcessProperties);
export type AgentControlMcpSendMessageInput = typeof AgentControlMcpSendMessageInput.Type;

export const AgentControlMcpInterruptThreadInput = Schema.Struct({
  requestId: AgentControlRequestId,
  threadId: ThreadId,
  turnId: Schema.optional(TurnId),
}).pipe(rejectExcessProperties);
export type AgentControlMcpInterruptThreadInput = typeof AgentControlMcpInterruptThreadInput.Type;

export const AgentControlMcpUpdateThreadInput = Schema.Struct({
  requestId: AgentControlRequestId,
  threadId: ThreadId,
  ...AgentControlThreadPreferences.fields,
  title: Schema.optional(AgentControlTitle),
  archived: Schema.optional(Schema.Boolean),
  persistentGoal: Schema.optional(
    Schema.NullOr(
      TrimmedNonEmptyString.check(Schema.isMaxLength(AGENT_CONTROL_PERSISTENT_GOAL_MAX_CHARS)),
    ),
  ),
}).pipe(rejectExcessProperties);
export type AgentControlMcpUpdateThreadInput = typeof AgentControlMcpUpdateThreadInput.Type;

export const AgentControlMcpProposeProjectCreateInput = Schema.Struct({
  requestId: AgentControlRequestId,
  projectId: ProjectId,
  title: AgentControlTitle,
  workspaceRoot: AgentControlWorkspaceRoot,
}).pipe(rejectExcessProperties);
export type AgentControlMcpProposeProjectCreateInput =
  typeof AgentControlMcpProposeProjectCreateInput.Type;

export const AgentControlMcpProposeProjectUpdateInput = Schema.Struct({
  ...AgentControlProjectPreferences.fields,
  requestId: AgentControlRequestId,
  projectId: ProjectId,
  expectedUpdatedAt: IsoDateTime,
  title: Schema.optional(AgentControlTitle),
  workspaceRoot: Schema.optional(AgentControlWorkspaceRoot),
}).pipe(rejectExcessProperties);
export type AgentControlMcpProposeProjectUpdateInput =
  typeof AgentControlMcpProposeProjectUpdateInput.Type;

export const AgentControlMcpProposeProjectRemoveInput = Schema.Struct({
  requestId: AgentControlRequestId,
  projectId: ProjectId,
  expectedUpdatedAt: IsoDateTime,
  force: Schema.optional(Schema.Boolean),
}).pipe(rejectExcessProperties);
export type AgentControlMcpProposeProjectRemoveInput =
  typeof AgentControlMcpProposeProjectRemoveInput.Type;

export const AgentControlMcpSettingsChangeRequest = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("legacyTokenStreaming"),
    value: Schema.Boolean,
  }).pipe(rejectExcessProperties),
  Schema.Struct({
    kind: Schema.Literal("providerUpdateChecks"),
    value: Schema.Boolean,
  }).pipe(rejectExcessProperties),
]);
export type AgentControlMcpSettingsChangeRequest = typeof AgentControlMcpSettingsChangeRequest.Type;

export const AgentControlMcpProposeSettingsChangeInput = Schema.Struct({
  requestId: AgentControlRequestId,
  change: AgentControlMcpSettingsChangeRequest,
}).pipe(rejectExcessProperties);
export type AgentControlMcpProposeSettingsChangeInput =
  typeof AgentControlMcpProposeSettingsChangeInput.Type;

export const AgentControlMcpListAutomationsInput = Schema.Struct({
  projectId: Schema.optional(ProjectId),
  includeDisabled: Schema.optional(Schema.Boolean),
  limit: Schema.optional(PositiveInt),
}).pipe(rejectExcessProperties);
export type AgentControlMcpListAutomationsInput = typeof AgentControlMcpListAutomationsInput.Type;

export const AgentControlMcpReadAutomationInput = Schema.Struct({
  automationId: AgentControlAutomationId,
}).pipe(rejectExcessProperties);
export type AgentControlMcpReadAutomationInput = typeof AgentControlMcpReadAutomationInput.Type;

export const AgentControlMcpListAutomationRunsInput = Schema.Struct({
  automationId: AgentControlAutomationId,
  limit: Schema.optional(PositiveInt),
}).pipe(rejectExcessProperties);
export type AgentControlMcpListAutomationRunsInput =
  typeof AgentControlMcpListAutomationRunsInput.Type;

export const AgentControlMcpProposeAutomationCreateInput = Schema.Struct({
  requestId: AgentControlRequestId,
  projectId: ProjectId,
  providerInstanceId: ProviderInstanceId,
  title: AgentControlAutomationExecutionTemplate.fields.title,
  prompt: AgentControlAutomationExecutionTemplate.fields.prompt,
  model: TrimmedNonEmptyString,
  options: ProviderOptionSelections,
  runtimeMode: RuntimeMode,
  tokenMode: Schema.optional(AgentTokenMode),
  envMode: ThreadEnvMode,
  baseRef: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(256))),
  schedule: AgentControlAutomationSchedule,
  enabled: Schema.optional(Schema.Boolean),
}).pipe(rejectExcessProperties);
export type AgentControlMcpProposeAutomationCreateInput =
  typeof AgentControlMcpProposeAutomationCreateInput.Type;

export const AgentControlMcpProposeAutomationUpdateInput = Schema.Struct({
  requestId: AgentControlRequestId,
  automationId: AgentControlAutomationId,
  expectedRevision: PositiveInt,
  title: Schema.optional(AgentControlAutomationExecutionTemplate.fields.title),
  prompt: Schema.optional(AgentControlAutomationExecutionTemplate.fields.prompt),
  providerInstanceId: Schema.optional(ProviderInstanceId),
  model: Schema.optional(TrimmedNonEmptyString),
  options: Schema.optional(ProviderOptionSelections),
  runtimeMode: Schema.optional(RuntimeMode),
  tokenMode: Schema.optional(AgentTokenMode),
  envMode: Schema.optional(ThreadEnvMode),
  baseRef: Schema.optional(Schema.NullOr(TrimmedNonEmptyString.check(Schema.isMaxLength(256)))),
  schedule: Schema.optional(AgentControlAutomationSchedule),
  enabled: Schema.optional(Schema.Boolean),
}).pipe(rejectExcessProperties);
export type AgentControlMcpProposeAutomationUpdateInput =
  typeof AgentControlMcpProposeAutomationUpdateInput.Type;

export const AgentControlMcpProposeAutomationCancelInput = Schema.Struct({
  requestId: AgentControlRequestId,
  automationId: AgentControlAutomationId,
  expectedRevision: PositiveInt,
}).pipe(rejectExcessProperties);
export type AgentControlMcpProposeAutomationCancelInput =
  typeof AgentControlMcpProposeAutomationCancelInput.Type;

export const AgentControlMcpOperationalReadInput = Schema.Struct({
  projectId: Schema.optional(ProjectId),
  threadId: Schema.optional(ThreadId),
  providerInstanceId: Schema.optional(ProviderInstanceId),
  since: Schema.optional(IsoDateTime),
  limit: Schema.optional(PositiveInt),
}).pipe(rejectExcessProperties);
export type AgentControlMcpOperationalReadInput = typeof AgentControlMcpOperationalReadInput.Type;

export const AgentControlMcpDiagnosticsSummaryInput = Schema.Struct({
  projectId: Schema.optional(ProjectId),
  providerInstanceId: Schema.optional(ProviderInstanceId),
}).pipe(rejectExcessProperties);
export type AgentControlMcpDiagnosticsSummaryInput =
  typeof AgentControlMcpDiagnosticsSummaryInput.Type;

export const AgentControlMcpListDevicesInput = Schema.Struct({
  includeShutdown: Schema.optional(Schema.Boolean),
}).pipe(rejectExcessProperties);
export type AgentControlMcpListDevicesInput = typeof AgentControlMcpListDevicesInput.Type;

export const AgentControlMcpReadDeviceStateInput = Schema.Struct({}).pipe(rejectExcessProperties);
export type AgentControlMcpReadDeviceStateInput = typeof AgentControlMcpReadDeviceStateInput.Type;

export const AgentControlMcpReadDeviceContentInput = Schema.Struct({
  udid: DeviceUdid,
}).pipe(rejectExcessProperties);
export type AgentControlMcpReadDeviceContentInput =
  typeof AgentControlMcpReadDeviceContentInput.Type;

const AgentControlMcpDeviceMutationTarget = Schema.Struct({
  requestId: AgentControlRequestId,
  udid: DeviceUdid,
  expectedThreadDeviceVersion: NonNegativeInt,
  expectedAttachedDeviceUdid: Schema.NullOr(DeviceUdid),
  expectedDeviceState: DeviceRuntimeState,
  expectedDeviceBootSource: DeviceBootSource,
  expectedRecording: Schema.Boolean,
});

export const AgentControlMcpProposeDeviceBootInput = Schema.Struct({
  ...AgentControlMcpDeviceMutationTarget.fields,
}).pipe(rejectExcessProperties);
export type AgentControlMcpProposeDeviceBootInput =
  typeof AgentControlMcpProposeDeviceBootInput.Type;

export const AgentControlMcpProposeDeviceAttachInput = Schema.Struct({
  ...AgentControlMcpDeviceMutationTarget.fields,
}).pipe(rejectExcessProperties);
export type AgentControlMcpProposeDeviceAttachInput =
  typeof AgentControlMcpProposeDeviceAttachInput.Type;

export const AgentControlMcpProposeDeviceDetachInput = Schema.Struct({
  ...AgentControlMcpDeviceMutationTarget.fields,
}).pipe(rejectExcessProperties);
export type AgentControlMcpProposeDeviceDetachInput =
  typeof AgentControlMcpProposeDeviceDetachInput.Type;

export const AgentControlMcpProposeDeviceInstallInput = Schema.Struct({
  ...AgentControlMcpDeviceMutationTarget.fields,
  artifactPath: AgentControlDeviceArtifactPath,
}).pipe(rejectExcessProperties);
export type AgentControlMcpProposeDeviceInstallInput =
  typeof AgentControlMcpProposeDeviceInstallInput.Type;

export const AgentControlMcpProposeDeviceLaunchInput = Schema.Struct({
  ...AgentControlMcpDeviceMutationTarget.fields,
  bundleId: DeviceBundleId,
}).pipe(rejectExcessProperties);
export type AgentControlMcpProposeDeviceLaunchInput =
  typeof AgentControlMcpProposeDeviceLaunchInput.Type;

export const AgentControlMcpProposeDeviceOpenUrlInput = Schema.Struct({
  ...AgentControlMcpDeviceMutationTarget.fields,
  url: TrimmedNonEmptyString.check(Schema.isMaxLength(AGENT_CONTROL_DEVICE_URL_MAX_CHARS)),
}).pipe(rejectExcessProperties);
export type AgentControlMcpProposeDeviceOpenUrlInput =
  typeof AgentControlMcpProposeDeviceOpenUrlInput.Type;

export const AgentControlMcpDeviceInputAction = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("tap"),
    x: AgentControlDeviceCoordinate,
    y: AgentControlDeviceCoordinate,
  }).pipe(rejectExcessProperties),
  Schema.Struct({
    kind: Schema.Literal("swipe"),
    fromX: AgentControlDeviceCoordinate,
    fromY: AgentControlDeviceCoordinate,
    toX: AgentControlDeviceCoordinate,
    toY: AgentControlDeviceCoordinate,
    durationMs: Schema.Int.check(
      Schema.isBetween({
        minimum: DEVICE_SWIPE_DURATION_MIN_MS,
        maximum: DEVICE_SWIPE_DURATION_MAX_MS,
      }),
    ),
  }).pipe(rejectExcessProperties),
  Schema.Struct({
    kind: Schema.Literal("press-button"),
    button: DeviceHardwareButton,
  }).pipe(rejectExcessProperties),
]);
export type AgentControlMcpDeviceInputAction = typeof AgentControlMcpDeviceInputAction.Type;

export const AgentControlMcpProposeDeviceInputInput = Schema.Struct({
  ...AgentControlMcpDeviceMutationTarget.fields,
  action: AgentControlMcpDeviceInputAction,
}).pipe(rejectExcessProperties);
export type AgentControlMcpProposeDeviceInputInput =
  typeof AgentControlMcpProposeDeviceInputInput.Type;

export const AgentControlMcpProposeDeviceRecordingInput = Schema.Struct({
  ...AgentControlMcpDeviceMutationTarget.fields,
  action: Schema.Literals(["start", "stop"]),
}).pipe(rejectExcessProperties);
export type AgentControlMcpProposeDeviceRecordingInput =
  typeof AgentControlMcpProposeDeviceRecordingInput.Type;

export const AgentControlMcpProposeDeviceShutdownInput = Schema.Struct({
  ...AgentControlMcpDeviceMutationTarget.fields,
}).pipe(rejectExcessProperties);
export type AgentControlMcpProposeDeviceShutdownInput =
  typeof AgentControlMcpProposeDeviceShutdownInput.Type;

// ── Tool results ──────────────────────────────────────────────────────

export const AgentControlMcpContextResult = Schema.Struct({
  threadId: ThreadId,
  threadTitle: Schema.NullOr(TrimmedNonEmptyString),
  projectId: Schema.NullOr(ProjectId),
  projectTitle: Schema.NullOr(TrimmedNonEmptyString),
  providerInstanceId: ProviderInstanceId,
  runtimeSessionId: RuntimeSessionId,
  capabilities: Schema.Array(AgentControlCapability),
  agentControl: Schema.Struct({
    available: Schema.Literal(true),
    injectionMode: AgentControlInjectionMode,
  }),
  /** True only while this MCP session owns exact active-turn write authority. */
  writeToolsAvailable: Schema.Boolean,
});
export type AgentControlMcpContextResult = typeof AgentControlMcpContextResult.Type;

export const AGENT_CONTROL_MCP_MODELS_PER_INSTANCE_MAX = 50;

export const AgentControlMcpModelSummary = Schema.Struct({
  slug: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
});
export type AgentControlMcpModelSummary = typeof AgentControlMcpModelSummary.Type;

/**
 * Bounded provider-instance availability for `ryco_capabilities`. Keyed by
 * `ProviderInstanceId` — never a static provider name — and deliberately
 * free of auth identity, rate limits, and maintenance internals.
 */
export const AgentControlMcpProviderInstanceSummary = Schema.Struct({
  instanceId: ProviderInstanceId,
  driver: ProviderDriverKind,
  displayName: Schema.NullOr(TrimmedNonEmptyString),
  enabled: Schema.Boolean,
  status: ServerProviderState,
  availability: ServerProviderAvailability,
  models: Schema.Array(AgentControlMcpModelSummary),
  agentControl: AgentControlProviderAvailability,
});
export type AgentControlMcpProviderInstanceSummary =
  typeof AgentControlMcpProviderInstanceSummary.Type;

export const AgentControlMcpCapabilitiesResult = Schema.Struct({
  enabled: Schema.Boolean,
  readOnly: Schema.Boolean,
  tools: Schema.Array(TrimmedNonEmptyString),
  grantedCapabilities: Schema.Array(AgentControlCapability),
  agentControl: Schema.Struct({
    available: Schema.Literal(true),
    injectionMode: AgentControlInjectionMode,
  }),
  providerInstances: Schema.Array(AgentControlMcpProviderInstanceSummary),
});
export type AgentControlMcpCapabilitiesResult = typeof AgentControlMcpCapabilitiesResult.Type;

export const AgentControlMcpListDevicesResult = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  providerInstanceId: ProviderInstanceId,
  devices: Schema.Array(DeviceDescriptor).check(Schema.isMaxLength(256)),
  recordingDeviceUdids: Schema.Array(DeviceUdid).check(Schema.isMaxLength(256)),
  availability: DeviceAvailability,
});
export type AgentControlMcpListDevicesResult = typeof AgentControlMcpListDevicesResult.Type;

export const AgentControlMcpReadDeviceStateResult = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  providerInstanceId: ProviderInstanceId,
  version: NonNegativeInt,
  attachedDeviceUdid: Schema.NullOr(DeviceUdid),
  attachPhase: Schema.NullOr(DeviceAttachPhase),
  attachedDevice: Schema.NullOr(DeviceDescriptor),
  recording: Schema.Boolean,
  agentActive: Schema.Boolean,
  availability: DeviceAvailability,
  redacted: Schema.Literal(true),
});
export type AgentControlMcpReadDeviceStateResult = typeof AgentControlMcpReadDeviceStateResult.Type;

export const AgentControlMcpProjectSummary = Schema.Struct({
  projectId: ProjectId,
  kind: OptionalProjectKind,
  title: TrimmedNonEmptyString,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type AgentControlMcpProjectSummary = typeof AgentControlMcpProjectSummary.Type;

export const AgentControlMcpListProjectsResult = Schema.Struct({
  projects: Schema.Array(AgentControlMcpProjectSummary),
  nextCursor: Schema.NullOr(AgentControlMcpCursor),
});
export type AgentControlMcpListProjectsResult = typeof AgentControlMcpListProjectsResult.Type;

export const AgentControlMcpSettingsSummaryItem = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("legacyTokenStreaming"),
    label: Schema.Literal("Legacy token streaming"),
    value: Schema.Boolean,
    changeSupported: Schema.Boolean,
    unsupportedReason: Schema.NullOr(TrimmedNonEmptyString),
  }),
  Schema.Struct({
    kind: Schema.Literal("providerUpdateChecks"),
    label: Schema.Literal("Provider update checks"),
    value: Schema.Boolean,
    changeSupported: Schema.Boolean,
    unsupportedReason: Schema.NullOr(TrimmedNonEmptyString),
  }),
]);
export type AgentControlMcpSettingsSummaryItem = typeof AgentControlMcpSettingsSummaryItem.Type;

export const AgentControlMcpSettingsSummaryResult = Schema.Struct({
  settings: Schema.Array(AgentControlMcpSettingsSummaryItem),
  redacted: Schema.Literal(true),
  omittedCategories: Schema.Array(
    Schema.Literals([
      "secrets-and-credentials",
      "provider-runtime-configuration",
      "mcp-server-configuration",
      "remote-relay-hosted-authentication",
      "filesystem-and-network-exposure",
      "agent-control-policy",
      "other-non-allowlisted-settings",
    ]),
  ),
});
export type AgentControlMcpSettingsSummaryResult = typeof AgentControlMcpSettingsSummaryResult.Type;

export const AgentControlMcpThreadSummary = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  status: OrchestrationSessionStatus,
  activeTurnId: Schema.NullOr(TurnId),
  providerInstanceId: Schema.NullOr(ProviderInstanceId),
  archived: Schema.Boolean,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type AgentControlMcpThreadSummary = typeof AgentControlMcpThreadSummary.Type;

export const AgentControlMcpListThreadsResult = Schema.Struct({
  threads: Schema.Array(AgentControlMcpThreadSummary),
  nextCursor: Schema.NullOr(AgentControlMcpCursor),
});
export type AgentControlMcpListThreadsResult = typeof AgentControlMcpListThreadsResult.Type;

/**
 * Redacted transcript entry: role, bounded text, and turn attribution
 * only. Attachments surface as metadata counts; activity payloads, raw
 * provider events, and file paths never cross this boundary.
 */
export const AgentControlMcpMessage = Schema.Struct({
  messageId: TrimmedNonEmptyString,
  role: Schema.Literals(["user", "assistant", "system"]),
  text: Schema.String,
  truncated: Schema.Boolean,
  turnId: Schema.NullOr(TurnId),
  attachmentCount: NonNegativeInt,
  createdAt: IsoDateTime,
});
export type AgentControlMcpMessage = typeof AgentControlMcpMessage.Type;

export const AgentControlMcpReadThreadResult = Schema.Struct({
  thread: AgentControlMcpThreadSummary,
  messages: Schema.Array(AgentControlMcpMessage),
  hasMoreBefore: Schema.Boolean,
  /** Cursor for the next-older page; `null` when history is exhausted. */
  nextCursor: Schema.NullOr(AgentControlMcpCursor),
});
export type AgentControlMcpReadThreadResult = typeof AgentControlMcpReadThreadResult.Type;

/**
 * Control-request read/wait payload: the bounded lifecycle receipt plus
 * wait metadata. Never the plan payload or prompt text.
 */
export const AgentControlMcpControlRequestResult = Schema.Struct({
  receipt: AgentControlProposalReceipt,
  /** Only set by the wait tool: `true` when it returned on timeout. */
  timedOut: Schema.optional(Schema.Boolean),
});
export type AgentControlMcpControlRequestResult = typeof AgentControlMcpControlRequestResult.Type;

export const AgentControlMcpMutationResult = Schema.Struct({
  receipt: AgentControlProposalReceipt,
  replayed: Schema.Boolean,
});
export type AgentControlMcpMutationResult = typeof AgentControlMcpMutationResult.Type;

export const AgentControlMcpAutomationSummary = Schema.Struct({
  automationId: AgentControlAutomationId,
  projectId: ProjectId,
  providerInstanceId: ProviderInstanceId,
  execution: AgentControlAutomationExecutionTemplate,
  promptTruncated: Schema.Boolean,
  schedule: AgentControlAutomationSchedule,
  revision: PositiveInt,
  enabled: Schema.Boolean,
  cancelled: Schema.Boolean,
  nextRunAt: Schema.NullOr(IsoDateTime),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
}).pipe(rejectExcessProperties);
export type AgentControlMcpAutomationSummary = typeof AgentControlMcpAutomationSummary.Type;

export const AgentControlMcpListAutomationsResult = Schema.Struct({
  automations: Schema.Array(AgentControlMcpAutomationSummary),
  limits: Schema.Struct({
    maxActivePerProject: PositiveInt,
    minIntervalMs: PositiveInt,
    maxHorizonMs: PositiveInt,
    runHistoryMax: PositiveInt,
  }),
});
export type AgentControlMcpListAutomationsResult = typeof AgentControlMcpListAutomationsResult.Type;

export const AgentControlMcpReadAutomationResult = Schema.Struct({
  automation: AgentControlMcpAutomationSummary,
});
export type AgentControlMcpReadAutomationResult = typeof AgentControlMcpReadAutomationResult.Type;

export const AgentControlMcpListAutomationRunsResult = Schema.Struct({
  runs: Schema.Array(AgentControlAutomationRun),
  historyLimit: PositiveInt,
});
export type AgentControlMcpListAutomationRunsResult =
  typeof AgentControlMcpListAutomationRunsResult.Type;

export const AgentControlMcpOperationalCoverage = Schema.Struct({
  effectiveSince: IsoDateTime,
  retentionStartsAt: IsoDateTime,
  generatedAt: IsoDateTime,
  truncated: Schema.Boolean,
  pageLimit: PositiveInt,
});
export type AgentControlMcpOperationalCoverage = typeof AgentControlMcpOperationalCoverage.Type;

export const AgentControlMcpActivitySummary = Schema.Struct({
  activityId: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
  projectId: ProjectId,
  threadId: ThreadId,
  kind: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  tone: Schema.Literals(["info", "tool", "approval", "error"]),
  turnId: Schema.NullOr(TurnId),
  occurredAt: IsoDateTime,
});
export type AgentControlMcpActivitySummary = typeof AgentControlMcpActivitySummary.Type;

export const AgentControlMcpRecentActivityResult = Schema.Struct({
  activity: Schema.Array(AgentControlMcpActivitySummary),
  automations: Schema.Array(AgentControlMcpAutomationSummary),
  runs: Schema.Array(AgentControlAutomationRun),
  coverage: AgentControlMcpOperationalCoverage,
});
export type AgentControlMcpRecentActivityResult = typeof AgentControlMcpRecentActivityResult.Type;

export const AgentControlMcpOrchestrationEventSummary = Schema.Struct({
  sequence: NonNegativeInt,
  eventId: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
  type: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  aggregateKind: Schema.Literals(["project", "thread", "worktree"]),
  aggregateId: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
  projectId: ProjectId,
  threadId: Schema.NullOr(ThreadId),
  occurredAt: IsoDateTime,
  providerAttributed: Schema.Boolean,
});
export type AgentControlMcpOrchestrationEventSummary =
  typeof AgentControlMcpOrchestrationEventSummary.Type;

export const AgentControlMcpOrchestrationEventsResult = Schema.Struct({
  events: Schema.Array(AgentControlMcpOrchestrationEventSummary),
  coverage: AgentControlMcpOperationalCoverage,
});
export type AgentControlMcpOrchestrationEventsResult =
  typeof AgentControlMcpOrchestrationEventsResult.Type;

export const AgentControlMcpProviderRuntimeEventSummary = Schema.Struct({
  eventId: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
  type: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  projectId: ProjectId,
  threadId: ThreadId,
  providerInstanceId: ProviderInstanceId,
  turnId: Schema.NullOr(TurnId),
  occurredAt: IsoDateTime,
});
export type AgentControlMcpProviderRuntimeEventSummary =
  typeof AgentControlMcpProviderRuntimeEventSummary.Type;

export const AgentControlMcpProviderRuntimeEventsResult = Schema.Struct({
  events: Schema.Array(AgentControlMcpProviderRuntimeEventSummary),
  coverage: AgentControlMcpOperationalCoverage,
});
export type AgentControlMcpProviderRuntimeEventsResult =
  typeof AgentControlMcpProviderRuntimeEventsResult.Type;

export const AgentControlMcpDiagnosticsSummaryResult = Schema.Struct({
  generatedAt: IsoDateTime,
  health: Schema.Literals(["ok", "degraded"]),
  projectId: ProjectId,
  providerInstanceId: ProviderInstanceId,
  provider: Schema.Struct({
    status: ServerProviderState,
    availability: ServerProviderAvailability,
    enabled: Schema.Boolean,
    installed: Schema.Boolean,
  }),
  project: Schema.Struct({
    threadCount: NonNegativeInt,
    activeThreadCount: NonNegativeInt,
    enabledAutomationCount: NonNegativeInt,
    pendingAutomationRunCount: NonNegativeInt,
  }),
  server: Schema.Struct({
    uptimeMs: NonNegativeInt,
    memoryRssBytes: NonNegativeInt,
    heapUsedBytes: NonNegativeInt,
    eventLoopDelayMs: Schema.NullOr(Schema.Number),
  }),
  operational: Schema.Struct({
    failureCount: NonNegativeInt,
    warningCount: NonNegativeInt,
    retainedTraceCount: NonNegativeInt,
    queueOverflowCount: NonNegativeInt,
    providerLogDroppedRecords: NonNegativeInt,
  }),
  redacted: Schema.Literal(true),
  omitted: Schema.Array(
    Schema.Literals([
      "credentials-and-environment",
      "paths-files-and-terminals",
      "commands-transcripts-and-payloads",
      "traces-logs-requests-and-relay",
      "hosted-browser-and-service-worker",
      "other-projects-and-provider-sessions",
    ]),
  ),
});
export type AgentControlMcpDiagnosticsSummaryResult =
  typeof AgentControlMcpDiagnosticsSummaryResult.Type;

// ── External stdio MCP tool catalog ──────────────────────────────────

export const AGENT_CONTROL_EXTERNAL_MCP_TOOLS = {
  overview: "ryco_overview",
  capabilities: "ryco_capabilities",
  listAllowedProjects: "ryco_list_allowed_projects",
  createTask: "ryco_create_task",
  readTask: "ryco_read_task",
  waitForTask: "ryco_wait_for_task",
  listAutomations: "ryco_list_automations",
  readAutomation: "ryco_read_automation",
  listAutomationRuns: "ryco_list_automation_runs",
  proposeAutomationCreate: "ryco_propose_automation_create",
  proposeAutomationUpdate: "ryco_propose_automation_update",
  proposeAutomationCancel: "ryco_propose_automation_cancel",
  recentActivity: "ryco_recent_activity",
  orchestrationEvents: "ryco_orchestration_events",
  providerRuntimeEvents: "ryco_provider_runtime_events",
  diagnosticsSummary: "ryco_diagnostics_summary",
  readControlRequest: "ryco_read_control_request",
  waitForControlRequest: "ryco_wait_for_control_request",
  listThreads: "ryco_list_threads",
  readThread: "ryco_read_thread",
  searchThreads: "ryco_search_threads",
  waitThreads: "ryco_wait_threads",
  inspectThread: "ryco_inspect_thread",
  readThreadDiff: "ryco_read_thread_diff",
  readThreadFile: "ryco_read_thread_file",
  readProject: "ryco_read_project",
  listWorkspaces: "ryco_list_workspaces",
  readWorkspace: "ryco_read_workspace",
  sendMessage: "ryco_send_message",
  interruptThread: "ryco_interrupt_thread",
  updateThread: "ryco_update_thread",
  planWorkspace: "ryco_plan_workspace_lifecycle",
  proposeWorkspace: "ryco_propose_workspace_lifecycle",
} as const;
export type AgentControlExternalMcpToolName =
  (typeof AGENT_CONTROL_EXTERNAL_MCP_TOOLS)[keyof typeof AGENT_CONTROL_EXTERNAL_MCP_TOOLS];
export const AGENT_CONTROL_EXTERNAL_MCP_TOOL_NAMES: ReadonlyArray<AgentControlExternalMcpToolName> =
  Object.values(AGENT_CONTROL_EXTERNAL_MCP_TOOLS);

export const AgentControlExternalCreateTaskInput = Schema.Struct({
  requestId: AgentControlRequestId,
  projectId: ProjectId,
  providerInstanceId: ProviderInstanceId,
  model: TrimmedNonEmptyString,
  /** Explicit even when empty, so retries have one canonical plan. */
  options: ProviderOptionSelections,
  title: Schema.optional(AgentControlTitle),
  prompt: AgentControlPrompt,
  environment: Schema.optional(ThreadEnvMode),
  runtimeMode: Schema.optional(Schema.Literals(["approval-required", "full-access"])),
  tokenMode: Schema.optional(AgentTokenMode),
}).pipe(rejectExcessProperties);
export type AgentControlExternalCreateTaskInput = typeof AgentControlExternalCreateTaskInput.Type;

export const AgentControlExternalTaskIdInput = Schema.Struct({
  taskId: AgentControlExternalTaskId,
});
export type AgentControlExternalTaskIdInput = typeof AgentControlExternalTaskIdInput.Type;

export const AgentControlExternalWaitForTaskInput = Schema.Struct({
  taskId: AgentControlExternalTaskId,
  waitFor: Schema.optional(AgentControlMcpWaitCondition),
  timeoutMs: Schema.optional(PositiveInt),
});
export type AgentControlExternalWaitForTaskInput = typeof AgentControlExternalWaitForTaskInput.Type;

export const AgentControlExternalTask = Schema.Struct({
  taskId: AgentControlExternalTaskId,
  requestId: AgentControlRequestId,
  proposalId: AgentControlProposalId,
  projectId: ProjectId,
  providerInstanceId: ProviderInstanceId,
  environment: ThreadEnvMode,
  runtimeMode: RuntimeMode,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  releasedAt: Schema.NullOr(IsoDateTime),
});
export type AgentControlExternalTask = typeof AgentControlExternalTask.Type;

export const AgentControlExternalTaskResult = Schema.Struct({
  task: AgentControlExternalTask,
  receipt: AgentControlProposalReceipt,
  replayed: Schema.optional(Schema.Boolean),
  timedOut: Schema.optional(Schema.Boolean),
});
export type AgentControlExternalTaskResult = typeof AgentControlExternalTaskResult.Type;

export const AgentControlExternalOverviewResult = Schema.Struct({
  integrationId: AgentControlIntegrationId,
  displayName: TrimmedNonEmptyString,
  clientKind: AgentControlExternalClientKind,
  notice: TrimmedNonEmptyString,
});
export type AgentControlExternalOverviewResult = typeof AgentControlExternalOverviewResult.Type;

export const AgentControlExternalCapabilitiesResult = Schema.Struct({
  tools: Schema.Array(TrimmedNonEmptyString),
  grantedCapabilities: Schema.Array(AgentControlCapability),
  projectScope: AgentControlExternalProjectScope,
  rateLimitPerMinute: PositiveInt,
  activeTaskLimit: PositiveInt,
  activeTaskCount: NonNegativeInt,
  providerInstances: Schema.Array(AgentControlMcpProviderInstanceSummary),
});
export type AgentControlExternalCapabilitiesResult =
  typeof AgentControlExternalCapabilitiesResult.Type;
