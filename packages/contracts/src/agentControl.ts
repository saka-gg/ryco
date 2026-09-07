/**
 * Agent Control contracts.
 *
 * Schema-only definitions for the Agent Control control plane: principals,
 * capabilities, immutable action plans, approval proposals, and durable
 * execution operations. Agents never receive ambient write access — every
 * mutation is first captured as an immutable `AgentControlProposal` that a
 * user must approve, and only the server-side executor may move an accepted
 * proposal into execution.
 *
 * Extension rules
 * ---------------
 * These schemas are designed for additive extension:
 *
 *   - `AgentControlActionPlan` is a closed union discriminated by `kind`.
 *     New action kinds are added as new union members; previously persisted
 *     plans keep decoding unchanged.
 *   - Capabilities, risk tags, and error codes are open branded slugs (the
 *     same forward-compatibility posture as `ProviderDriverKind`): payloads
 *     persisted by a newer build must decode on this build. Authorization is
 *     the runtime's job and fails closed on capabilities it does not grant.
 *   - Target selection always uses `ProviderInstanceId` + `ModelSelection`.
 *     A static provider-kind targeting API would lose configured provider
 *     instances and is deliberately not part of this contract.
 *
 * @module agentControl
 */
import { Effect, Schema } from "effect";
import {
  CommandId,
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  RuntimeSessionId,
  ThreadId,
  TrimmedNonEmptyString,
  TurnId,
} from "./baseSchemas.ts";
import {
  ModelSelection,
  OrchestrationSessionStatus,
  ProjectMetadataDir,
  RuntimeMode,
} from "./orchestration.ts";
import { ProviderOptionSelections } from "./model.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";
import { McpServerName, McpWorkspaceId } from "./mcp.ts";
import { ServerProviderAvailability, ServerProviderState } from "./server.ts";
import { ThreadEnvMode } from "./settings.ts";
import { WorktreeId } from "./worktree.ts";
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

// ── Identifiers ───────────────────────────────────────────────────────

export const AgentControlProposalId = TrimmedNonEmptyString.pipe(
  Schema.brand("AgentControlProposalId"),
);
export type AgentControlProposalId = typeof AgentControlProposalId.Type;

export const AgentControlOperationId = TrimmedNonEmptyString.pipe(
  Schema.brand("AgentControlOperationId"),
);
export type AgentControlOperationId = typeof AgentControlOperationId.Type;

export const AgentControlIntegrationId = TrimmedNonEmptyString.check(Schema.isMaxLength(128)).pipe(
  Schema.brand("AgentControlIntegrationId"),
);
export type AgentControlIntegrationId = typeof AgentControlIntegrationId.Type;

export const AgentControlExternalTaskId = TrimmedNonEmptyString.check(Schema.isMaxLength(128)).pipe(
  Schema.brand("AgentControlExternalTaskId"),
);
export type AgentControlExternalTaskId = typeof AgentControlExternalTaskId.Type;

export const AgentControlMcpInstallationId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(128),
).pipe(Schema.brand("AgentControlMcpInstallationId"));
export type AgentControlMcpInstallationId = typeof AgentControlMcpInstallationId.Type;

export const AgentControlAutomationId = TrimmedNonEmptyString.check(Schema.isMaxLength(128)).pipe(
  Schema.brand("AgentControlAutomationId"),
);
export type AgentControlAutomationId = typeof AgentControlAutomationId.Type;

export const AgentControlAutomationRunId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(128),
).pipe(Schema.brand("AgentControlAutomationRunId"));
export type AgentControlAutomationRunId = typeof AgentControlAutomationRunId.Type;

/**
 * Caller-chosen idempotency key. Unique within one principal's request-id
 * scope: retrying an identical plan under the same id must return the
 * original proposal, and reusing an id with a different plan must fail.
 */
export const AGENT_CONTROL_REQUEST_ID_MAX_CHARS = 128;
export const AgentControlRequestId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(AGENT_CONTROL_REQUEST_ID_MAX_CHARS),
).pipe(Schema.brand("AgentControlRequestId"));
export type AgentControlRequestId = typeof AgentControlRequestId.Type;

// ── Principals ────────────────────────────────────────────────────────

/**
 * An agent already running inside a Ryco thread. Its credential is
 * per-provider-runtime, in-memory, thread-bound, and revoked on runtime
 * teardown — none of that credential material appears in this contract.
 */
export const AgentControlProviderSessionPrincipal = Schema.Struct({
  kind: Schema.Literal("provider-session"),
  threadId: ThreadId,
  providerInstanceId: ProviderInstanceId,
  /** Runtime epoch of the session that issued the request, when known. */
  runtimeSessionId: Schema.optional(RuntimeSessionId),
  /** The exact running turn the request was bound to, when known. */
  turnId: Schema.optional(TurnId),
  /** Immutable caller privilege/scope evidence captured when the proposal is created. */
  originProjectId: Schema.optional(ProjectId),
  originRuntimeMode: Schema.optional(RuntimeMode),
  originEnvMode: Schema.optional(ThreadEnvMode),
  /** Audit-safe target state used to reject stale approved plans. */
  targetSnapshots: Schema.optional(
    Schema.Array(
      Schema.Struct({
        threadId: ThreadId,
        projectId: ProjectId,
        runtimeMode: RuntimeMode,
        envMode: ThreadEnvMode,
        archived: Schema.Boolean,
        activeTurnId: Schema.NullOr(TurnId),
      }),
    ),
  ),
});
export type AgentControlProviderSessionPrincipal = typeof AgentControlProviderSessionPrincipal.Type;

/**
 * A separately paired local MCP client. Pairing, credential issuance, and
 * scope grants are owned by later PRs; the principal identity is defined
 * here so proposals persist a stable, audit-safe origin from day one.
 */
export const AgentControlExternalIntegrationPrincipal = Schema.Struct({
  kind: Schema.Literal("external-integration"),
  integrationId: AgentControlIntegrationId,
  label: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(120))),
  /** Immutable execution-policy evidence captured when the proposal is created. */
  projectId: Schema.optional(ProjectId),
  runtimeMode: Schema.optional(RuntimeMode),
  envMode: Schema.optional(ThreadEnvMode),
});
export type AgentControlExternalIntegrationPrincipal =
  typeof AgentControlExternalIntegrationPrincipal.Type;

export const AgentControlPrincipal = Schema.Union([
  AgentControlProviderSessionPrincipal,
  AgentControlExternalIntegrationPrincipal,
]);
export type AgentControlPrincipal = typeof AgentControlPrincipal.Type;

// ── Capabilities ──────────────────────────────────────────────────────

const AGENT_CONTROL_SLUG_MAX_CHARS = 64;
const agentControlSlug = TrimmedNonEmptyString.check(
  Schema.isMaxLength(AGENT_CONTROL_SLUG_MAX_CHARS),
  Schema.isPattern(/^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)*$/),
);

/**
 * Open branded capability slug. Grants persisted by a newer build must
 * decode here; the policy layer only ever authorizes capabilities it
 * knows and grants, so unknown slugs fail closed at evaluation time.
 */
export const AgentControlCapability = agentControlSlug.pipe(Schema.brand("AgentControlCapability"));
export type AgentControlCapability = typeof AgentControlCapability.Type;

export const AGENT_CONTROL_CAPABILITIES = {
  read: AgentControlCapability.make("read"),
  createThreads: AgentControlCapability.make("threads.create"),
  sendMessage: AgentControlCapability.make("threads.send-message"),
  interruptThread: AgentControlCapability.make("threads.interrupt"),
  updateThread: AgentControlCapability.make("threads.update"),
  createProject: AgentControlCapability.make("projects.create"),
  updateProject: AgentControlCapability.make("projects.update"),
  removeProject: AgentControlCapability.make("projects.remove"),
  readSettings: AgentControlCapability.make("settings.read"),
  changeSettings: AgentControlCapability.make("settings.change"),
  readAutomations: AgentControlCapability.make("automations.read"),
  manageAutomations: AgentControlCapability.make("automations.manage"),
  readActivity: AgentControlCapability.make("activity.read"),
  readDiagnostics: AgentControlCapability.make("diagnostics.read"),
  readDevices: AgentControlCapability.make("devices.read"),
  readDeviceContent: AgentControlCapability.make("devices.content.read"),
  controlDevices: AgentControlCapability.make("devices.control"),
  controlComputer: AgentControlCapability.make("computer.control"),
  controlBrowser: AgentControlCapability.make("browser.control"),
  externalListProjects: AgentControlCapability.make("external.projects.list"),
  externalCreateTask: AgentControlCapability.make("external.tasks.create"),
  externalReadTask: AgentControlCapability.make("external.tasks.read"),
  externalSharedCheckout: AgentControlCapability.make("external.checkout.shared"),
  externalFullAccess: AgentControlCapability.make("external.runtime.full-access"),
  externalReadAutomations: AgentControlCapability.make("external.automations.read"),
  externalManageAutomations: AgentControlCapability.make("external.automations.manage"),
  externalReadActivity: AgentControlCapability.make("external.activity.read"),
  externalReadDiagnostics: AgentControlCapability.make("external.diagnostics.read"),
} as const;

// ── Action plans ──────────────────────────────────────────────────────

export const AgentControlActionKind = Schema.Literals([
  "createThreads",
  "sendMessage",
  "interruptThread",
  "updateThread",
  "createProject",
  "updateProject",
  "removeProject",
  "changeSettings",
  "createAutomation",
  "updateAutomation",
  "cancelAutomation",
  "automationRun",
  "deviceBoot",
  "deviceAttach",
  "deviceDetach",
  "deviceInstall",
  "deviceLaunch",
  "deviceOpenUrl",
  "deviceTap",
  "deviceSwipe",
  "devicePressButton",
  "deviceStartRecording",
  "deviceStopRecording",
  "deviceShutdown",
]);
export type AgentControlActionKind = typeof AgentControlActionKind.Type;

export const AGENT_CONTROL_DEVICE_ACTION_KINDS = [
  "deviceBoot",
  "deviceAttach",
  "deviceDetach",
  "deviceInstall",
  "deviceLaunch",
  "deviceOpenUrl",
  "deviceTap",
  "deviceSwipe",
  "devicePressButton",
  "deviceStartRecording",
  "deviceStopRecording",
  "deviceShutdown",
] as const satisfies ReadonlyArray<AgentControlActionKind>;
export type AgentControlDeviceActionKind = (typeof AGENT_CONTROL_DEVICE_ACTION_KINDS)[number];

/** Required capability per mutation action kind. */
export const AGENT_CONTROL_ACTION_CAPABILITIES: Record<
  AgentControlActionKind,
  AgentControlCapability
> = {
  createThreads: AGENT_CONTROL_CAPABILITIES.createThreads,
  sendMessage: AGENT_CONTROL_CAPABILITIES.sendMessage,
  interruptThread: AGENT_CONTROL_CAPABILITIES.interruptThread,
  updateThread: AGENT_CONTROL_CAPABILITIES.updateThread,
  createProject: AGENT_CONTROL_CAPABILITIES.createProject,
  updateProject: AGENT_CONTROL_CAPABILITIES.updateProject,
  removeProject: AGENT_CONTROL_CAPABILITIES.removeProject,
  changeSettings: AGENT_CONTROL_CAPABILITIES.changeSettings,
  createAutomation: AGENT_CONTROL_CAPABILITIES.manageAutomations,
  updateAutomation: AGENT_CONTROL_CAPABILITIES.manageAutomations,
  cancelAutomation: AGENT_CONTROL_CAPABILITIES.manageAutomations,
  automationRun: AGENT_CONTROL_CAPABILITIES.manageAutomations,
  deviceBoot: AGENT_CONTROL_CAPABILITIES.controlDevices,
  deviceAttach: AGENT_CONTROL_CAPABILITIES.controlDevices,
  deviceDetach: AGENT_CONTROL_CAPABILITIES.controlDevices,
  deviceInstall: AGENT_CONTROL_CAPABILITIES.controlDevices,
  deviceLaunch: AGENT_CONTROL_CAPABILITIES.controlDevices,
  deviceOpenUrl: AGENT_CONTROL_CAPABILITIES.controlDevices,
  deviceTap: AGENT_CONTROL_CAPABILITIES.controlDevices,
  deviceSwipe: AGENT_CONTROL_CAPABILITIES.controlDevices,
  devicePressButton: AGENT_CONTROL_CAPABILITIES.controlDevices,
  deviceStartRecording: AGENT_CONTROL_CAPABILITIES.controlDevices,
  deviceStopRecording: AGENT_CONTROL_CAPABILITIES.controlDevices,
  deviceShutdown: AGENT_CONTROL_CAPABILITIES.controlDevices,
};

export const AGENT_CONTROL_PLAN_VERSION = 1;
/** Matches `PROVIDER_SEND_TURN_MAX_INPUT_CHARS` — a plan prompt becomes a turn input. */
export const AGENT_CONTROL_PROMPT_MAX_CHARS = 120_000;
export const AGENT_CONTROL_TITLE_MAX_CHARS = 200;
export const AGENT_CONTROL_CREATE_THREADS_MAX_ENTRIES = 10;
export const AGENT_CONTROL_PERSISTENT_GOAL_MAX_CHARS = 4_000;
export const AGENT_CONTROL_AUTOMATION_PROMPT_MAX_CHARS = 12_000;
export const AGENT_CONTROL_AUTOMATION_MIN_INTERVAL_MS = 15 * 60_000;
export const AGENT_CONTROL_AUTOMATION_MAX_ACTIVE_PER_PROJECT = 25;
export const AGENT_CONTROL_AUTOMATION_MAX_HORIZON_MS = 90 * 24 * 60 * 60_000;
export const AGENT_CONTROL_AUTOMATION_RUN_HISTORY_MAX = 50;
export const AGENT_CONTROL_AUTOMATION_PROPOSAL_TTL_MS = 15 * 60_000;
export const AGENT_CONTROL_AUTOMATION_SAFE_FAILURE_MAX_CHARS = 256;
export const AGENT_CONTROL_DEVICE_ARTIFACT_PATH_MAX_CHARS = 1_024;
export const AGENT_CONTROL_DEVICE_URL_MAX_CHARS = 2_048;

const AgentControlPrompt = TrimmedNonEmptyString.check(
  Schema.isMaxLength(AGENT_CONTROL_PROMPT_MAX_CHARS),
);
const AgentControlTitle = TrimmedNonEmptyString.check(
  Schema.isMaxLength(AGENT_CONTROL_TITLE_MAX_CHARS),
);

export const AgentControlCreateThreadEntry = Schema.Struct({
  projectId: ProjectId,
  title: AgentControlTitle,
  prompt: AgentControlPrompt,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  /** Isolated worktree vs the project's shared local checkout. */
  envMode: ThreadEnvMode,
  /** Base ref for worktree creation; the project default when absent. */
  baseRef: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(256))),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type AgentControlCreateThreadEntry = typeof AgentControlCreateThreadEntry.Type;

/** One exact immutable batch — never a generic spawning loop. */
export const AgentControlCreateThreadsPlan = Schema.Struct({
  kind: Schema.Literal("createThreads"),
  entries: Schema.Array(AgentControlCreateThreadEntry).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(AGENT_CONTROL_CREATE_THREADS_MAX_ENTRIES),
  ),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type AgentControlCreateThreadsPlan = typeof AgentControlCreateThreadsPlan.Type;

export const AgentControlSendMessageDelivery = Schema.Literals(["queue", "steer"]);
export type AgentControlSendMessageDelivery = typeof AgentControlSendMessageDelivery.Type;

export const AgentControlSendMessagePlan = Schema.Struct({
  kind: Schema.Literal("sendMessage"),
  threadId: ThreadId,
  text: AgentControlPrompt,
  delivery: AgentControlSendMessageDelivery,
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type AgentControlSendMessagePlan = typeof AgentControlSendMessagePlan.Type;

export const AgentControlInterruptThreadPlan = Schema.Struct({
  kind: Schema.Literal("interruptThread"),
  threadId: ThreadId,
  /** When present, only this exact turn may be interrupted. */
  turnId: Schema.optional(TurnId),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type AgentControlInterruptThreadPlan = typeof AgentControlInterruptThreadPlan.Type;

export const AgentControlUpdateThreadPlan = Schema.Struct({
  kind: Schema.Literal("updateThread"),
  threadId: ThreadId,
  title: Schema.optional(AgentControlTitle),
  archived: Schema.optional(Schema.Boolean),
  /** An explicitly requested persistent goal; `null` clears it. */
  persistentGoal: Schema.optional(
    Schema.NullOr(
      TrimmedNonEmptyString.check(Schema.isMaxLength(AGENT_CONTROL_PERSISTENT_GOAL_MAX_CHARS)),
    ),
  ),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type AgentControlUpdateThreadPlan = typeof AgentControlUpdateThreadPlan.Type;

const AgentControlWorkspaceRoot = TrimmedNonEmptyString.check(Schema.isMaxLength(4_096));
const AgentControlRepositoryIdentityKey = Schema.NullOr(
  TrimmedNonEmptyString.check(Schema.isMaxLength(2_048)),
);

/** Canonical project state captured when a mutable project proposal is created. */
export const AgentControlProjectState = Schema.Struct({
  title: AgentControlTitle,
  workspaceRoot: AgentControlWorkspaceRoot,
  repositoryIdentityKey: AgentControlRepositoryIdentityKey,
  updatedAt: IsoDateTime,
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type AgentControlProjectState = typeof AgentControlProjectState.Type;

export const AgentControlProjectTarget = Schema.Struct({
  title: AgentControlTitle,
  workspaceRoot: AgentControlWorkspaceRoot,
  repositoryIdentityKey: AgentControlRepositoryIdentityKey,
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type AgentControlProjectTarget = typeof AgentControlProjectTarget.Type;

/** Creates only Ryco's project record for an already-existing authorized directory. */
export const AgentControlCreateProjectPlan = Schema.Struct({
  kind: Schema.Literal("createProject"),
  projectId: ProjectId,
  title: AgentControlTitle,
  workspaceRoot: AgentControlWorkspaceRoot,
  projectMetadataDir: ProjectMetadataDir,
  repositoryIdentityKey: AgentControlRepositoryIdentityKey,
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type AgentControlCreateProjectPlan = typeof AgentControlCreateProjectPlan.Type;

/** Exact before/after metadata update; only display name and workspace path are supported. */
export const AgentControlUpdateProjectPlan = Schema.Struct({
  kind: Schema.Literal("updateProject"),
  projectId: ProjectId,
  before: AgentControlProjectState,
  after: AgentControlProjectTarget,
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type AgentControlUpdateProjectPlan = typeof AgentControlUpdateProjectPlan.Type;

/**
 * Unlinks Ryco's project record. `force` may also remove the exact listed
 * Ryco thread records, but never deletes the workspace directory or repository.
 */
export const AgentControlRemoveProjectPlan = Schema.Struct({
  kind: Schema.Literal("removeProject"),
  projectId: ProjectId,
  expected: AgentControlProjectState,
  expectedThreadIds: Schema.Array(ThreadId),
  force: Schema.Boolean,
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type AgentControlRemoveProjectPlan = typeof AgentControlRemoveProjectPlan.Type;

export const AgentControlLegacyTokenStreamingChange = Schema.Struct({
  kind: Schema.Literal("legacyTokenStreaming"),
  before: Schema.Boolean,
  after: Schema.Boolean,
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type AgentControlLegacyTokenStreamingChange =
  typeof AgentControlLegacyTokenStreamingChange.Type;

export const AgentControlProviderUpdateChecksChange = Schema.Struct({
  kind: Schema.Literal("providerUpdateChecks"),
  before: Schema.Boolean,
  after: Schema.Boolean,
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type AgentControlProviderUpdateChecksChange =
  typeof AgentControlProviderUpdateChecksChange.Type;

/** Finite, non-secret settings allowlist. It is intentionally not a key/value patch. */
export const AgentControlSettingsChange = Schema.Union([
  AgentControlLegacyTokenStreamingChange,
  AgentControlProviderUpdateChecksChange,
]);
export type AgentControlSettingsChange = typeof AgentControlSettingsChange.Type;

export const AgentControlChangeSettingsPlan = Schema.Struct({
  kind: Schema.Literal("changeSettings"),
  change: AgentControlSettingsChange,
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type AgentControlChangeSettingsPlan = typeof AgentControlChangeSettingsPlan.Type;

// ── Governed automation plans ─────────────────────────────────────────

/**
 * A deliberately narrow future thread action. It is data only: no command,
 * URL, webhook, browser/device operation, RPC method, or arbitrary code field
 * exists in this schema. Each due occurrence copies this exact template into
 * a fresh `automationRun` proposal that still requires user approval.
 */
export const AgentControlAutomationExecutionTemplate = Schema.Struct({
  projectId: ProjectId,
  title: AgentControlTitle,
  prompt: TrimmedNonEmptyString.check(
    Schema.isMaxLength(AGENT_CONTROL_AUTOMATION_PROMPT_MAX_CHARS),
  ),
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  envMode: ThreadEnvMode,
  baseRef: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(256))),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type AgentControlAutomationExecutionTemplate =
  typeof AgentControlAutomationExecutionTemplate.Type;

export const AgentControlAutomationSchedule = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("once"),
    runAt: IsoDateTime,
  }).annotate({ parseOptions: { onExcessProperty: "error" } }),
  Schema.Struct({
    kind: Schema.Literal("fixed-interval"),
    startsAt: IsoDateTime,
    intervalMs: PositiveInt,
    /** Required finite end: recurring schedules are never unbounded. */
    endsAt: IsoDateTime,
  }).annotate({ parseOptions: { onExcessProperty: "error" } }),
]);
export type AgentControlAutomationSchedule = typeof AgentControlAutomationSchedule.Type;

export const AgentControlAutomationDefinition = Schema.Struct({
  execution: AgentControlAutomationExecutionTemplate,
  schedule: AgentControlAutomationSchedule,
  enabled: Schema.Boolean,
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type AgentControlAutomationDefinition = typeof AgentControlAutomationDefinition.Type;

/** Exact persisted definition revision captured in update/cancel plans. */
export const AgentControlAutomationRevisionState = Schema.Struct({
  revision: PositiveInt,
  definition: AgentControlAutomationDefinition,
  cancelled: Schema.Boolean,
  updatedAt: IsoDateTime,
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type AgentControlAutomationRevisionState = typeof AgentControlAutomationRevisionState.Type;

export const AgentControlCreateAutomationPlan = Schema.Struct({
  kind: Schema.Literal("createAutomation"),
  automationId: AgentControlAutomationId,
  definition: AgentControlAutomationDefinition,
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type AgentControlCreateAutomationPlan = typeof AgentControlCreateAutomationPlan.Type;

export const AgentControlUpdateAutomationPlan = Schema.Struct({
  kind: Schema.Literal("updateAutomation"),
  automationId: AgentControlAutomationId,
  before: AgentControlAutomationRevisionState,
  after: AgentControlAutomationDefinition,
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type AgentControlUpdateAutomationPlan = typeof AgentControlUpdateAutomationPlan.Type;

export const AgentControlCancelAutomationPlan = Schema.Struct({
  kind: Schema.Literal("cancelAutomation"),
  automationId: AgentControlAutomationId,
  expected: AgentControlAutomationRevisionState,
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type AgentControlCancelAutomationPlan = typeof AgentControlCancelAutomationPlan.Type;

/** Server-materialized exact occurrence. No MCP mutation tool accepts this plan. */
export const AgentControlAutomationRunPlan = Schema.Struct({
  kind: Schema.Literal("automationRun"),
  automationId: AgentControlAutomationId,
  runId: AgentControlAutomationRunId,
  automationRevision: PositiveInt,
  scheduledFor: IsoDateTime,
  coalescedOccurrences: NonNegativeInt,
  execution: AgentControlAutomationExecutionTemplate,
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type AgentControlAutomationRunPlan = typeof AgentControlAutomationRunPlan.Type;

// ── Governed iOS Simulator plans ────────────────────────────────────

export const AgentControlDeviceRiskClass = Schema.Literals([
  "device-control",
  "device-lifecycle",
  "open-world",
]);
export type AgentControlDeviceRiskClass = typeof AgentControlDeviceRiskClass.Type;

export const AgentControlDeviceArtifactPath = TrimmedNonEmptyString.check(
  Schema.isMaxLength(AGENT_CONTROL_DEVICE_ARTIFACT_PATH_MAX_CHARS),
  Schema.isPattern(/^(?!\/)(?!~)(?![A-Za-z]:)(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*\\)[^\0]+\.app$/u),
);
export type AgentControlDeviceArtifactPath = typeof AgentControlDeviceArtifactPath.Type;

const AgentControlDeviceExecutionSummary = TrimmedNonEmptyString.check(Schema.isMaxLength(240));
const AgentControlDeviceCoordinate = Schema.Finite.check(
  Schema.isBetween({ minimum: 0, maximum: 20_000 }),
);

/**
 * Exact device and attachment state captured at proposal creation. Device
 * mutations fail closed if any of these values changes before execution.
 */
export const AgentControlDevicePlanTarget = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  expectedProjectUpdatedAt: IsoDateTime,
  providerInstanceId: ProviderInstanceId,
  udid: DeviceUdid,
  expectedThreadDeviceVersion: NonNegativeInt,
  expectedAttachedDeviceUdid: Schema.NullOr(DeviceUdid),
  expectedDeviceState: DeviceRuntimeState,
  expectedDeviceBootSource: DeviceBootSource,
  expectedRecording: Schema.Boolean,
  executionSummary: AgentControlDeviceExecutionSummary,
  riskClass: AgentControlDeviceRiskClass,
});
export type AgentControlDevicePlanTarget = typeof AgentControlDevicePlanTarget.Type;

export const AgentControlDeviceBootPlan = Schema.Struct({
  kind: Schema.Literal("deviceBoot"),
  ...AgentControlDevicePlanTarget.fields,
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type AgentControlDeviceBootPlan = typeof AgentControlDeviceBootPlan.Type;

export const AgentControlDeviceAttachPlan = Schema.Struct({
  kind: Schema.Literal("deviceAttach"),
  ...AgentControlDevicePlanTarget.fields,
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type AgentControlDeviceAttachPlan = typeof AgentControlDeviceAttachPlan.Type;

export const AgentControlDeviceDetachPlan = Schema.Struct({
  kind: Schema.Literal("deviceDetach"),
  ...AgentControlDevicePlanTarget.fields,
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type AgentControlDeviceDetachPlan = typeof AgentControlDeviceDetachPlan.Type;

export const AgentControlDeviceInstallPlan = Schema.Struct({
  kind: Schema.Literal("deviceInstall"),
  ...AgentControlDevicePlanTarget.fields,
  artifactPath: AgentControlDeviceArtifactPath,
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type AgentControlDeviceInstallPlan = typeof AgentControlDeviceInstallPlan.Type;

/** Launch arguments are deliberately absent: they may contain user secrets. */
export const AgentControlDeviceLaunchPlan = Schema.Struct({
  kind: Schema.Literal("deviceLaunch"),
  ...AgentControlDevicePlanTarget.fields,
  bundleId: DeviceBundleId,
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type AgentControlDeviceLaunchPlan = typeof AgentControlDeviceLaunchPlan.Type;

export const AgentControlDeviceOpenUrlPlan = Schema.Struct({
  kind: Schema.Literal("deviceOpenUrl"),
  ...AgentControlDevicePlanTarget.fields,
  url: TrimmedNonEmptyString.check(Schema.isMaxLength(AGENT_CONTROL_DEVICE_URL_MAX_CHARS)),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type AgentControlDeviceOpenUrlPlan = typeof AgentControlDeviceOpenUrlPlan.Type;

export const AgentControlDeviceTapPlan = Schema.Struct({
  kind: Schema.Literal("deviceTap"),
  ...AgentControlDevicePlanTarget.fields,
  x: AgentControlDeviceCoordinate,
  y: AgentControlDeviceCoordinate,
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type AgentControlDeviceTapPlan = typeof AgentControlDeviceTapPlan.Type;

export const AgentControlDeviceSwipePlan = Schema.Struct({
  kind: Schema.Literal("deviceSwipe"),
  ...AgentControlDevicePlanTarget.fields,
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
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type AgentControlDeviceSwipePlan = typeof AgentControlDeviceSwipePlan.Type;

export const AgentControlDevicePressButtonPlan = Schema.Struct({
  kind: Schema.Literal("devicePressButton"),
  ...AgentControlDevicePlanTarget.fields,
  button: DeviceHardwareButton,
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type AgentControlDevicePressButtonPlan = typeof AgentControlDevicePressButtonPlan.Type;

export const AgentControlDeviceStartRecordingPlan = Schema.Struct({
  kind: Schema.Literal("deviceStartRecording"),
  ...AgentControlDevicePlanTarget.fields,
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type AgentControlDeviceStartRecordingPlan = typeof AgentControlDeviceStartRecordingPlan.Type;

export const AgentControlDeviceStopRecordingPlan = Schema.Struct({
  kind: Schema.Literal("deviceStopRecording"),
  ...AgentControlDevicePlanTarget.fields,
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type AgentControlDeviceStopRecordingPlan = typeof AgentControlDeviceStopRecordingPlan.Type;

export const AgentControlDeviceShutdownPlan = Schema.Struct({
  kind: Schema.Literal("deviceShutdown"),
  ...AgentControlDevicePlanTarget.fields,
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type AgentControlDeviceShutdownPlan = typeof AgentControlDeviceShutdownPlan.Type;

export const AgentControlDeviceActionPlan = Schema.Union([
  AgentControlDeviceBootPlan,
  AgentControlDeviceAttachPlan,
  AgentControlDeviceDetachPlan,
  AgentControlDeviceInstallPlan,
  AgentControlDeviceLaunchPlan,
  AgentControlDeviceOpenUrlPlan,
  AgentControlDeviceTapPlan,
  AgentControlDeviceSwipePlan,
  AgentControlDevicePressButtonPlan,
  AgentControlDeviceStartRecordingPlan,
  AgentControlDeviceStopRecordingPlan,
  AgentControlDeviceShutdownPlan,
]);
export type AgentControlDeviceActionPlan = typeof AgentControlDeviceActionPlan.Type;

export const AgentControlActionPlan = Schema.Union([
  AgentControlCreateThreadsPlan,
  AgentControlSendMessagePlan,
  AgentControlInterruptThreadPlan,
  AgentControlUpdateThreadPlan,
  AgentControlCreateProjectPlan,
  AgentControlUpdateProjectPlan,
  AgentControlRemoveProjectPlan,
  AgentControlChangeSettingsPlan,
  AgentControlCreateAutomationPlan,
  AgentControlUpdateAutomationPlan,
  AgentControlCancelAutomationPlan,
  AgentControlAutomationRunPlan,
  AgentControlDeviceActionPlan,
]);
export type AgentControlActionPlan = typeof AgentControlActionPlan.Type;

// ── Digest, risk tags, prompt summary ─────────────────────────────────

/** sha-256 hex over the canonical encoded plan payload. */
export const AgentControlPlanDigest = TrimmedNonEmptyString.check(
  Schema.isPattern(/^[a-f0-9]{64}$/),
);
export type AgentControlPlanDigest = typeof AgentControlPlanDigest.Type;

/** Open branded risk-tag slug; same forward-compat rules as capabilities. */
export const AgentControlRiskTag = agentControlSlug.pipe(Schema.brand("AgentControlRiskTag"));
export type AgentControlRiskTag = typeof AgentControlRiskTag.Type;

export const AGENT_CONTROL_RISK_TAGS = {
  createsThreads: AgentControlRiskTag.make("creates-threads"),
  startsProviderTurn: AgentControlRiskTag.make("starts-provider-turn"),
  interruptsThread: AgentControlRiskTag.make("interrupts-thread"),
  modifiesThreadMetadata: AgentControlRiskTag.make("modifies-thread-metadata"),
  createsProject: AgentControlRiskTag.make("creates-project"),
  modifiesProjectMetadata: AgentControlRiskTag.make("modifies-project-metadata"),
  removesProject: AgentControlRiskTag.make("removes-project"),
  removesThreads: AgentControlRiskTag.make("removes-threads"),
  changesSettings: AgentControlRiskTag.make("changes-settings"),
  sharedLocalCheckout: AgentControlRiskTag.make("shared-local-checkout"),
  elevatedRuntimeMode: AgentControlRiskTag.make("elevated-runtime-mode"),
  createsAutomation: AgentControlRiskTag.make("creates-automation"),
  modifiesAutomation: AgentControlRiskTag.make("modifies-automation"),
  cancelsAutomation: AgentControlRiskTag.make("cancels-automation"),
  scheduledRun: AgentControlRiskTag.make("scheduled-run"),
  deviceMutation: AgentControlRiskTag.make("device-mutation"),
  deviceLifecycle: AgentControlRiskTag.make("device-lifecycle"),
  deviceOpenWorld: AgentControlRiskTag.make("device-open-world"),
} as const;

/**
 * Audit-safe compact summary shown on approval cards and retained in audit
 * rows. Never a full prompt: bounded, and produced server-side.
 */
export const AGENT_CONTROL_PROMPT_SUMMARY_MAX_CHARS = 500;
export const AgentControlPromptSummary = TrimmedNonEmptyString.check(
  Schema.isMaxLength(AGENT_CONTROL_PROMPT_SUMMARY_MAX_CHARS),
);
export type AgentControlPromptSummary = typeof AgentControlPromptSummary.Type;

// ── Result and error envelopes ────────────────────────────────────────

export const AGENT_CONTROL_ERROR_MESSAGE_MAX_CHARS = 2_000;
const AgentControlResultMessage = TrimmedNonEmptyString.check(
  Schema.isMaxLength(AGENT_CONTROL_ERROR_MESSAGE_MAX_CHARS),
);

/** Open branded error-code slug; same forward-compat rules as capabilities. */
export const AgentControlErrorCode = agentControlSlug.pipe(Schema.brand("AgentControlErrorCode"));
export type AgentControlErrorCode = typeof AgentControlErrorCode.Type;

export const AGENT_CONTROL_ERROR_CODES = {
  rejected: AgentControlErrorCode.make("rejected"),
  expired: AgentControlErrorCode.make("expired"),
  cancelled: AgentControlErrorCode.make("cancelled"),
  duplicateRequest: AgentControlErrorCode.make("duplicate-request"),
  revalidationFailed: AgentControlErrorCode.make("revalidation-failed"),
  executionFailed: AgentControlErrorCode.make("execution-failed"),
  featureDisabled: AgentControlErrorCode.make("feature-disabled"),
  capabilityDenied: AgentControlErrorCode.make("capability-denied"),
  deviceUnsupportedPlatform: AgentControlErrorCode.make("device.unsupported-platform"),
  deviceSetupRequired: AgentControlErrorCode.make("device.setup-required"),
  deviceUnavailable: AgentControlErrorCode.make("device.unavailable"),
  deviceBootLimitReached: AgentControlErrorCode.make("device.boot-limit-reached"),
  deviceAttachTimeout: AgentControlErrorCode.make("device.attach-timeout"),
  deviceStaleState: AgentControlErrorCode.make("device.stale-state"),
  deviceInvalidInput: AgentControlErrorCode.make("device.invalid-input"),
  deviceRecordingFailed: AgentControlErrorCode.make("device.recording-failed"),
  deviceOperationFailed: AgentControlErrorCode.make("device.operation-failed"),
} as const;

export const AgentControlErrorEnvelope = Schema.Struct({
  code: AgentControlErrorCode,
  message: AgentControlResultMessage,
  /** Whether a fresh request (with a new request id) could succeed. */
  retryable: Schema.Boolean,
});
export type AgentControlErrorEnvelope = typeof AgentControlErrorEnvelope.Type;

export const AgentControlDispatchedCommandReceipt = Schema.Struct({
  commandId: CommandId,
  commandType: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  sequence: NonNegativeInt,
});
export type AgentControlDispatchedCommandReceipt = typeof AgentControlDispatchedCommandReceipt.Type;

/** Audit-safe device execution evidence; never contains content, URLs, text, or paths. */
export const AgentControlDeviceExecutionMetadata = Schema.Struct({
  actionKind: AgentControlActionKind,
  threadId: ThreadId,
  projectId: ProjectId,
  providerInstanceId: ProviderInstanceId,
  udid: DeviceUdid,
});
export type AgentControlDeviceExecutionMetadata = typeof AgentControlDeviceExecutionMetadata.Type;

export const AgentControlExecutionReceipt = Schema.Struct({
  operationId: AgentControlOperationId,
  commands: Schema.Array(AgentControlDispatchedCommandReceipt),
  affectedThreadIds: Schema.Array(ThreadId),
  affectedProjectIds: Schema.optional(Schema.Array(ProjectId)).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  worktreeIds: Schema.Array(WorktreeId),
  affectedAutomationIds: Schema.optional(Schema.Array(AgentControlAutomationId)).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  automationRunId: Schema.optional(AgentControlAutomationRunId),
  device: Schema.optional(AgentControlDeviceExecutionMetadata),
  delivery: Schema.optional(Schema.Literals(["queued", "steered", "queued-after-steer-fallback"])),
  interrupt: Schema.optional(
    Schema.Struct({
      requestedTurnId: Schema.NullOr(TurnId),
      settledStatus: OrchestrationSessionStatus,
      settledActiveTurnId: Schema.NullOr(TurnId),
    }),
  ),
  compensation: Schema.optional(
    Schema.Struct({
      attempted: Schema.Boolean,
      completed: Schema.Boolean,
    }),
  ),
});
export type AgentControlExecutionReceipt = typeof AgentControlExecutionReceipt.Type;

export const AgentControlCompletedResult = Schema.Struct({
  outcome: Schema.Literal("completed"),
  createdThreadIds: Schema.optional(Schema.Array(ThreadId)),
  createdProjectIds: Schema.optional(Schema.Array(ProjectId)),
  execution: Schema.optional(AgentControlExecutionReceipt),
  detail: Schema.optional(AgentControlResultMessage),
  completedAt: IsoDateTime,
});
export type AgentControlCompletedResult = typeof AgentControlCompletedResult.Type;

export const AgentControlFailedResult = Schema.Struct({
  outcome: Schema.Literal("failed"),
  error: AgentControlErrorEnvelope,
  execution: Schema.optional(AgentControlExecutionReceipt),
  failedAt: IsoDateTime,
});
export type AgentControlFailedResult = typeof AgentControlFailedResult.Type;

/** Terminal receipt readable by the originating MCP client. */
export const AgentControlResultEnvelope = Schema.Union([
  AgentControlCompletedResult,
  AgentControlFailedResult,
]);
export type AgentControlResultEnvelope = typeof AgentControlResultEnvelope.Type;

// ── Proposals ─────────────────────────────────────────────────────────

export const AgentControlProposalStatus = Schema.Literals([
  "pending-user-approval",
  "approved",
  "rejected",
  "expired",
  "executing",
  "completed",
  "failed",
  "cancelled",
]);
export type AgentControlProposalStatus = typeof AgentControlProposalStatus.Type;

export const AGENT_CONTROL_TERMINAL_PROPOSAL_STATUSES: ReadonlyArray<AgentControlProposalStatus> = [
  "rejected",
  "expired",
  "completed",
  "failed",
  "cancelled",
];

/**
 * Immutable approval proposal. Accepting a proposal authorizes only its
 * `planDigest` — the plan payload and digest are written once and never
 * updated; a changed plan requires a new request.
 */
export const AgentControlProposal = Schema.Struct({
  proposalId: AgentControlProposalId,
  requestId: AgentControlRequestId,
  principal: AgentControlPrincipal,
  planVersion: Schema.Literal(AGENT_CONTROL_PLAN_VERSION),
  plan: AgentControlActionPlan,
  planDigest: AgentControlPlanDigest,
  riskTags: Schema.Array(AgentControlRiskTag),
  promptSummary: Schema.NullOr(AgentControlPromptSummary),
  status: AgentControlProposalStatus,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  expiresAt: IsoDateTime,
  decidedAt: Schema.NullOr(IsoDateTime),
  result: Schema.NullOr(AgentControlResultEnvelope),
});
export type AgentControlProposal = typeof AgentControlProposal.Type;

// ── Approval queue and RPC surface ────────────────────────────────────

export const AGENT_CONTROL_WS_METHODS = {
  listProposals: "agentControl.listProposals",
  getProposal: "agentControl.getProposal",
  acceptProposal: "agentControl.acceptProposal",
  rejectProposal: "agentControl.rejectProposal",
  subscribeProposals: "agentControl.subscribeProposals",
  listIntegrations: "agentControl.listIntegrations",
  createIntegration: "agentControl.createIntegration",
  updateIntegration: "agentControl.updateIntegration",
  resumeIntegrationPairing: "agentControl.resumeIntegrationPairing",
  revokeIntegration: "agentControl.revokeIntegration",
  deleteIntegration: "agentControl.deleteIntegration",
  listMcpInstallations: "agentControl.listMcpInstallations",
  connectMcpInstallation: "agentControl.connectMcpInstallation",
  repairMcpInstallation: "agentControl.repairMcpInstallation",
  disconnectMcpInstallation: "agentControl.disconnectMcpInstallation",
} as const;

/** Proposals shown in the live approval queue (everything non-terminal). */
export const AGENT_CONTROL_ACTIVE_PROPOSAL_STATUSES: ReadonlyArray<AgentControlProposalStatus> = [
  "pending-user-approval",
  "approved",
  "executing",
];

export const AGENT_CONTROL_QUEUE_ACTIVE_LIMIT_MAX = 100;
export const AGENT_CONTROL_QUEUE_RECENT_LIMIT_MAX = 100;
export const AGENT_CONTROL_QUEUE_ACTIVE_LIMIT_DEFAULT = 50;
export const AGENT_CONTROL_QUEUE_RECENT_LIMIT_DEFAULT = 20;

/**
 * Stable, bounded lifecycle receipt for one proposal: identifiers, status,
 * digest, risk tags, timing, and the terminal result envelope. This is the
 * shape future MCP read/wait tools return to the originating agent — never
 * the plan payload or prompt text.
 */
export const AgentControlProposalReceipt = Schema.Struct({
  proposalId: AgentControlProposalId,
  requestId: AgentControlRequestId,
  actionKind: AgentControlActionKind,
  planDigest: AgentControlPlanDigest,
  riskTags: Schema.Array(AgentControlRiskTag),
  status: AgentControlProposalStatus,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  expiresAt: IsoDateTime,
  decidedAt: Schema.NullOr(IsoDateTime),
  result: Schema.NullOr(AgentControlResultEnvelope),
});
export type AgentControlProposalReceipt = typeof AgentControlProposalReceipt.Type;

/**
 * Queue snapshot: non-terminal proposals (oldest first) plus a bounded
 * terminal history (newest first). `revision` is the server's per-process
 * monotonic change counter at snapshot time — it orders proposal events
 * within one subscription and is NOT durable across server restarts; every
 * snapshot resets the client's dedupe baseline.
 */
export const AgentControlProposalQueue = Schema.Struct({
  revision: NonNegativeInt,
  active: Schema.Array(AgentControlProposal),
  recent: Schema.Array(AgentControlProposal),
});
export type AgentControlProposalQueue = typeof AgentControlProposalQueue.Type;

export const AgentControlListProposalsInput = Schema.Struct({
  /** Capped server-side at `AGENT_CONTROL_QUEUE_ACTIVE_LIMIT_MAX`. */
  activeLimit: Schema.optional(PositiveInt),
  /** Capped server-side at `AGENT_CONTROL_QUEUE_RECENT_LIMIT_MAX`. */
  recentLimit: Schema.optional(PositiveInt),
});
export type AgentControlListProposalsInput = typeof AgentControlListProposalsInput.Type;

export const AgentControlGetProposalInput = Schema.Struct({
  proposalId: AgentControlProposalId,
});
export type AgentControlGetProposalInput = typeof AgentControlGetProposalInput.Type;

export const AgentControlGetProposalResult = Schema.Struct({
  proposal: Schema.NullOr(AgentControlProposal),
});
export type AgentControlGetProposalResult = typeof AgentControlGetProposalResult.Type;

export const AgentControlDecideProposalInput = Schema.Struct({
  proposalId: AgentControlProposalId,
});
export type AgentControlDecideProposalInput = typeof AgentControlDecideProposalInput.Type;

export const AgentControlProposalStreamSnapshotEvent = Schema.Struct({
  version: Schema.Literal(1),
  type: Schema.Literal("snapshot"),
  queue: AgentControlProposalQueue,
});
export type AgentControlProposalStreamSnapshotEvent =
  typeof AgentControlProposalStreamSnapshotEvent.Type;

/**
 * One proposal creation or transition. The full proposal document is the
 * payload — clients upsert by `proposalId` and never let a proposal move
 * backward through the one-way status progression, so replayed, duplicated,
 * or reordered deliveries are harmless.
 */
export const AgentControlProposalStreamProposalEvent = Schema.Struct({
  version: Schema.Literal(1),
  type: Schema.Literal("proposal"),
  revision: NonNegativeInt,
  proposal: AgentControlProposal,
});
export type AgentControlProposalStreamProposalEvent =
  typeof AgentControlProposalStreamProposalEvent.Type;

export const AgentControlProposalStreamEvent = Schema.Union([
  AgentControlProposalStreamSnapshotEvent,
  AgentControlProposalStreamProposalEvent,
]);
export type AgentControlProposalStreamEvent = typeof AgentControlProposalStreamEvent.Type;

/**
 * Bounded RPC failure for the approval surface. Carries only the decision
 * outcome category and, on decision conflicts, the proposal's actual status
 * — never plan payloads, prompt text, or other resource details.
 */
export const AgentControlRpcErrorCode = Schema.Literals([
  "disabled",
  "not-found",
  "expired",
  "conflict",
  "unsupported",
  "storage",
]);
export type AgentControlRpcErrorCode = typeof AgentControlRpcErrorCode.Type;

export class AgentControlRpcError extends Schema.TaggedError<AgentControlRpcError>()(
  "AgentControlRpcError",
  {
    code: AgentControlRpcErrorCode,
    message: TrimmedNonEmptyString.check(Schema.isMaxLength(AGENT_CONTROL_ERROR_MESSAGE_MAX_CHARS)),
    /** The proposal's actual status when a decision lost to another actor. */
    status: Schema.optional(AgentControlProposalStatus),
  },
) {}

// ── Operations ────────────────────────────────────────────────────────

export const AgentControlOperationStatus = Schema.Literals([
  "pending",
  "running",
  "compensating",
  "completed",
  "failed",
  "cancelled",
]);
export type AgentControlOperationStatus = typeof AgentControlOperationStatus.Type;

export const AGENT_CONTROL_TERMINAL_OPERATION_STATUSES: ReadonlyArray<AgentControlOperationStatus> =
  ["completed", "failed", "cancelled"];

/**
 * Resources an operation has created so far. Persisted so restart recovery
 * can prove operation ownership (e.g. of a preflighted worktree) and either
 * clean up safely or surface a clearly terminal failure.
 */
export const AgentControlOperationResources = Schema.Struct({
  projectIds: Schema.optional(Schema.Array(ProjectId)).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  automationIds: Schema.optional(Schema.Array(AgentControlAutomationId)).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  automationRunId: Schema.optional(AgentControlAutomationRunId),
  threadIds: Schema.Array(ThreadId).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  ownedThreadIds: Schema.Array(ThreadId).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  worktreeIds: Schema.Array(WorktreeId).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  ownedWorktrees: Schema.Array(
    Schema.Struct({
      worktreeId: WorktreeId,
      projectId: ProjectId,
      branch: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
      checkoutPath: TrimmedNonEmptyString,
    }),
  ).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
});
export type AgentControlOperationResources = typeof AgentControlOperationResources.Type;

export const AgentControlOperationState = Schema.Struct({
  completedSteps: Schema.Array(TrimmedNonEmptyString.check(Schema.isMaxLength(128))).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  resources: AgentControlOperationResources.pipe(
    Schema.withDecodingDefault(
      Effect.succeed({
        projectIds: [],
        automationIds: [],
        threadIds: [],
        ownedThreadIds: [],
        worktreeIds: [],
        ownedWorktrees: [],
      }),
    ),
  ),
  commandReceipts: Schema.Array(AgentControlDispatchedCommandReceipt).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  delivery: Schema.optional(Schema.Literals(["queued", "steered", "queued-after-steer-fallback"])),
  interrupt: Schema.optional(
    Schema.Struct({
      requestedTurnId: Schema.NullOr(TurnId),
      settledStatus: OrchestrationSessionStatus,
      settledActiveTurnId: Schema.NullOr(TurnId),
    }),
  ),
  compensation: Schema.optional(
    Schema.Struct({ attempted: Schema.Boolean, completed: Schema.Boolean }),
  ),
  note: Schema.optional(AgentControlResultMessage),
  device: Schema.optional(AgentControlDeviceExecutionMetadata),
});
export type AgentControlOperationState = typeof AgentControlOperationState.Type;

/**
 * Durable execution record for an accepted proposal. Exactly one operation
 * exists per proposal; its monotonic state and resource evidence are what
 * restart recovery replays.
 */
export const AgentControlOperation = Schema.Struct({
  operationId: AgentControlOperationId,
  proposalId: AgentControlProposalId,
  actionKind: AgentControlActionKind,
  status: AgentControlOperationStatus,
  attempt: NonNegativeInt,
  state: AgentControlOperationState,
  result: Schema.NullOr(AgentControlResultEnvelope),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type AgentControlOperation = typeof AgentControlOperation.Type;

// ── Durable automation lifecycle ──────────────────────────────────────

export const AgentControlAutomation = Schema.Struct({
  automationId: AgentControlAutomationId,
  principal: AgentControlPrincipal,
  projectId: ProjectId,
  providerInstanceId: ProviderInstanceId,
  definition: AgentControlAutomationDefinition,
  revision: PositiveInt,
  enabled: Schema.Boolean,
  cancelled: Schema.Boolean,
  cancelledAt: Schema.NullOr(IsoDateTime),
  nextRunAt: Schema.NullOr(IsoDateTime),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type AgentControlAutomation = typeof AgentControlAutomation.Type;

export const AgentControlAutomationRunStatus = Schema.Literals([
  "materializing",
  "pending-approval",
  "approved",
  "executing",
  "completed",
  "failed",
  "rejected",
  "expired",
  "cancelled",
]);
export type AgentControlAutomationRunStatus = typeof AgentControlAutomationRunStatus.Type;

export const AGENT_CONTROL_ACTIVE_AUTOMATION_RUN_STATUSES: ReadonlyArray<AgentControlAutomationRunStatus> =
  ["materializing", "pending-approval", "approved", "executing"];

export const AgentControlAutomationRun = Schema.Struct({
  runId: AgentControlAutomationRunId,
  automationId: AgentControlAutomationId,
  automationRevision: PositiveInt,
  projectId: ProjectId,
  providerInstanceId: ProviderInstanceId,
  scheduledFor: IsoDateTime,
  coalescedOccurrences: NonNegativeInt,
  status: AgentControlAutomationRunStatus,
  proposalId: Schema.NullOr(AgentControlProposalId),
  safeFailureDetail: Schema.NullOr(
    TrimmedNonEmptyString.check(
      Schema.isMaxLength(AGENT_CONTROL_AUTOMATION_SAFE_FAILURE_MAX_CHARS),
    ),
  ),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  completedAt: Schema.NullOr(IsoDateTime),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type AgentControlAutomationRun = typeof AgentControlAutomationRun.Type;

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
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type AgentControlMcpCreateThreadsInput = typeof AgentControlMcpCreateThreadsInput.Type;

export const AgentControlMcpSendMessageInput = Schema.Struct({
  requestId: AgentControlRequestId,
  threadId: ThreadId,
  text: AgentControlSendMessagePlan.fields.text,
  delivery: AgentControlSendMessageDelivery,
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type AgentControlMcpSendMessageInput = typeof AgentControlMcpSendMessageInput.Type;

export const AgentControlMcpInterruptThreadInput = Schema.Struct({
  requestId: AgentControlRequestId,
  threadId: ThreadId,
  turnId: Schema.optional(TurnId),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type AgentControlMcpInterruptThreadInput = typeof AgentControlMcpInterruptThreadInput.Type;

export const AgentControlMcpUpdateThreadInput = Schema.Struct({
  requestId: AgentControlRequestId,
  threadId: ThreadId,
  title: Schema.optional(AgentControlTitle),
  archived: Schema.optional(Schema.Boolean),
  persistentGoal: Schema.optional(
    Schema.NullOr(
      TrimmedNonEmptyString.check(Schema.isMaxLength(AGENT_CONTROL_PERSISTENT_GOAL_MAX_CHARS)),
    ),
  ),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type AgentControlMcpUpdateThreadInput = typeof AgentControlMcpUpdateThreadInput.Type;

export const AgentControlMcpProposeProjectCreateInput = Schema.Struct({
  requestId: AgentControlRequestId,
  projectId: ProjectId,
  title: AgentControlTitle,
  workspaceRoot: AgentControlWorkspaceRoot,
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type AgentControlMcpProposeProjectCreateInput =
  typeof AgentControlMcpProposeProjectCreateInput.Type;

export const AgentControlMcpProposeProjectUpdateInput = Schema.Struct({
  requestId: AgentControlRequestId,
  projectId: ProjectId,
  expectedUpdatedAt: IsoDateTime,
  title: Schema.optional(AgentControlTitle),
  workspaceRoot: Schema.optional(AgentControlWorkspaceRoot),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type AgentControlMcpProposeProjectUpdateInput =
  typeof AgentControlMcpProposeProjectUpdateInput.Type;

export const AgentControlMcpProposeProjectRemoveInput = Schema.Struct({
  requestId: AgentControlRequestId,
  projectId: ProjectId,
  expectedUpdatedAt: IsoDateTime,
  force: Schema.optional(Schema.Boolean),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type AgentControlMcpProposeProjectRemoveInput =
  typeof AgentControlMcpProposeProjectRemoveInput.Type;

export const AgentControlMcpSettingsChangeRequest = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("legacyTokenStreaming"),
    value: Schema.Boolean,
  }).annotate({ parseOptions: { onExcessProperty: "error" } }),
  Schema.Struct({
    kind: Schema.Literal("providerUpdateChecks"),
    value: Schema.Boolean,
  }).annotate({ parseOptions: { onExcessProperty: "error" } }),
]);
export type AgentControlMcpSettingsChangeRequest = typeof AgentControlMcpSettingsChangeRequest.Type;

export const AgentControlMcpProposeSettingsChangeInput = Schema.Struct({
  requestId: AgentControlRequestId,
  change: AgentControlMcpSettingsChangeRequest,
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type AgentControlMcpProposeSettingsChangeInput =
  typeof AgentControlMcpProposeSettingsChangeInput.Type;

export const AgentControlMcpListAutomationsInput = Schema.Struct({
  projectId: Schema.optional(ProjectId),
  includeDisabled: Schema.optional(Schema.Boolean),
  limit: Schema.optional(PositiveInt),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type AgentControlMcpListAutomationsInput = typeof AgentControlMcpListAutomationsInput.Type;

export const AgentControlMcpReadAutomationInput = Schema.Struct({
  automationId: AgentControlAutomationId,
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type AgentControlMcpReadAutomationInput = typeof AgentControlMcpReadAutomationInput.Type;

export const AgentControlMcpListAutomationRunsInput = Schema.Struct({
  automationId: AgentControlAutomationId,
  limit: Schema.optional(PositiveInt),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
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
  envMode: ThreadEnvMode,
  baseRef: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(256))),
  schedule: AgentControlAutomationSchedule,
  enabled: Schema.optional(Schema.Boolean),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
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
  envMode: Schema.optional(ThreadEnvMode),
  baseRef: Schema.optional(Schema.NullOr(TrimmedNonEmptyString.check(Schema.isMaxLength(256)))),
  schedule: Schema.optional(AgentControlAutomationSchedule),
  enabled: Schema.optional(Schema.Boolean),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type AgentControlMcpProposeAutomationUpdateInput =
  typeof AgentControlMcpProposeAutomationUpdateInput.Type;

export const AgentControlMcpProposeAutomationCancelInput = Schema.Struct({
  requestId: AgentControlRequestId,
  automationId: AgentControlAutomationId,
  expectedRevision: PositiveInt,
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type AgentControlMcpProposeAutomationCancelInput =
  typeof AgentControlMcpProposeAutomationCancelInput.Type;

export const AgentControlMcpOperationalReadInput = Schema.Struct({
  projectId: Schema.optional(ProjectId),
  threadId: Schema.optional(ThreadId),
  providerInstanceId: Schema.optional(ProviderInstanceId),
  since: Schema.optional(IsoDateTime),
  limit: Schema.optional(PositiveInt),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type AgentControlMcpOperationalReadInput = typeof AgentControlMcpOperationalReadInput.Type;

export const AgentControlMcpDiagnosticsSummaryInput = Schema.Struct({
  projectId: Schema.optional(ProjectId),
  providerInstanceId: Schema.optional(ProviderInstanceId),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type AgentControlMcpDiagnosticsSummaryInput =
  typeof AgentControlMcpDiagnosticsSummaryInput.Type;

export const AgentControlMcpListDevicesInput = Schema.Struct({
  includeShutdown: Schema.optional(Schema.Boolean),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type AgentControlMcpListDevicesInput = typeof AgentControlMcpListDevicesInput.Type;

export const AgentControlMcpReadDeviceStateInput = Schema.Struct({}).annotate({
  parseOptions: { onExcessProperty: "error" },
});
export type AgentControlMcpReadDeviceStateInput = typeof AgentControlMcpReadDeviceStateInput.Type;

export const AgentControlMcpReadDeviceContentInput = Schema.Struct({
  udid: DeviceUdid,
}).annotate({ parseOptions: { onExcessProperty: "error" } });
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
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type AgentControlMcpProposeDeviceBootInput =
  typeof AgentControlMcpProposeDeviceBootInput.Type;

export const AgentControlMcpProposeDeviceAttachInput = Schema.Struct({
  ...AgentControlMcpDeviceMutationTarget.fields,
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type AgentControlMcpProposeDeviceAttachInput =
  typeof AgentControlMcpProposeDeviceAttachInput.Type;

export const AgentControlMcpProposeDeviceDetachInput = Schema.Struct({
  ...AgentControlMcpDeviceMutationTarget.fields,
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type AgentControlMcpProposeDeviceDetachInput =
  typeof AgentControlMcpProposeDeviceDetachInput.Type;

export const AgentControlMcpProposeDeviceInstallInput = Schema.Struct({
  ...AgentControlMcpDeviceMutationTarget.fields,
  artifactPath: AgentControlDeviceArtifactPath,
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type AgentControlMcpProposeDeviceInstallInput =
  typeof AgentControlMcpProposeDeviceInstallInput.Type;

export const AgentControlMcpProposeDeviceLaunchInput = Schema.Struct({
  ...AgentControlMcpDeviceMutationTarget.fields,
  bundleId: DeviceBundleId,
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type AgentControlMcpProposeDeviceLaunchInput =
  typeof AgentControlMcpProposeDeviceLaunchInput.Type;

export const AgentControlMcpProposeDeviceOpenUrlInput = Schema.Struct({
  ...AgentControlMcpDeviceMutationTarget.fields,
  url: TrimmedNonEmptyString.check(Schema.isMaxLength(AGENT_CONTROL_DEVICE_URL_MAX_CHARS)),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type AgentControlMcpProposeDeviceOpenUrlInput =
  typeof AgentControlMcpProposeDeviceOpenUrlInput.Type;

export const AgentControlMcpDeviceInputAction = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("tap"),
    x: AgentControlDeviceCoordinate,
    y: AgentControlDeviceCoordinate,
  }).annotate({ parseOptions: { onExcessProperty: "error" } }),
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
  }).annotate({ parseOptions: { onExcessProperty: "error" } }),
  Schema.Struct({
    kind: Schema.Literal("press-button"),
    button: DeviceHardwareButton,
  }).annotate({ parseOptions: { onExcessProperty: "error" } }),
]);
export type AgentControlMcpDeviceInputAction = typeof AgentControlMcpDeviceInputAction.Type;

export const AgentControlMcpProposeDeviceInputInput = Schema.Struct({
  ...AgentControlMcpDeviceMutationTarget.fields,
  action: AgentControlMcpDeviceInputAction,
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type AgentControlMcpProposeDeviceInputInput =
  typeof AgentControlMcpProposeDeviceInputInput.Type;

export const AgentControlMcpProposeDeviceRecordingInput = Schema.Struct({
  ...AgentControlMcpDeviceMutationTarget.fields,
  action: Schema.Literals(["start", "stop"]),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type AgentControlMcpProposeDeviceRecordingInput =
  typeof AgentControlMcpProposeDeviceRecordingInput.Type;

export const AgentControlMcpProposeDeviceShutdownInput = Schema.Struct({
  ...AgentControlMcpDeviceMutationTarget.fields,
}).annotate({ parseOptions: { onExcessProperty: "error" } });
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
    changeSupported: Schema.Literal(false),
    unsupportedReason: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    kind: Schema.Literal("providerUpdateChecks"),
    label: Schema.Literal("Provider update checks"),
    value: Schema.Boolean,
    changeSupported: Schema.Literal(false),
    unsupportedReason: TrimmedNonEmptyString,
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
}).annotate({ parseOptions: { onExcessProperty: "error" } });
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

// ── Paired external MCP integrations ─────────────────────────────────

export const AGENT_CONTROL_EXTERNAL_CREDENTIAL_AUDIENCE = "external-mcp" as const;
export const AGENT_CONTROL_EXTERNAL_PAIRING_CODE_TTL_MS = 10 * 60_000;
export const AGENT_CONTROL_EXTERNAL_PROPOSAL_TTL_MS = 15 * 60_000;
export const AGENT_CONTROL_EXTERNAL_RATE_LIMIT_MAX = 600;
export const AGENT_CONTROL_EXTERNAL_ACTIVE_TASK_LIMIT_MAX = 10;

export const AgentControlExternalClientKind = Schema.Literals([
  "codex",
  "claude-code",
  "claude-desktop",
  "generic-mcp",
]);
export type AgentControlExternalClientKind = typeof AgentControlExternalClientKind.Type;

export const AgentControlExternalProjectScope = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("all") }),
  Schema.Struct({
    kind: Schema.Literal("selected"),
    projectIds: Schema.Array(ProjectId).check(Schema.isMaxLength(500)),
  }),
]);
export type AgentControlExternalProjectScope = typeof AgentControlExternalProjectScope.Type;

export const AgentControlExternalPairingState = Schema.Literals(["unpaired", "pending", "paired"]);
export type AgentControlExternalPairingState = typeof AgentControlExternalPairingState.Type;

/** Public integration view. Credential and pairing-code hashes never cross this contract. */
export const AgentControlExternalIntegration = Schema.Struct({
  integrationId: AgentControlIntegrationId,
  displayName: TrimmedNonEmptyString.check(Schema.isMaxLength(120)),
  clientKind: AgentControlExternalClientKind,
  projectScope: AgentControlExternalProjectScope,
  capabilities: Schema.Array(AgentControlCapability).check(Schema.isMaxLength(32)),
  rateLimitPerMinute: PositiveInt.check(
    Schema.isLessThanOrEqualTo(AGENT_CONTROL_EXTERNAL_RATE_LIMIT_MAX),
  ),
  activeTaskLimit: PositiveInt.check(
    Schema.isLessThanOrEqualTo(AGENT_CONTROL_EXTERNAL_ACTIVE_TASK_LIMIT_MAX),
  ),
  activeTaskCount: NonNegativeInt,
  expiresAt: Schema.NullOr(IsoDateTime),
  revokedAt: Schema.NullOr(IsoDateTime),
  pairingState: AgentControlExternalPairingState,
  pairingCodeExpiresAt: Schema.NullOr(IsoDateTime),
  pairedAt: Schema.NullOr(IsoDateTime),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  lastUsedAt: Schema.NullOr(IsoDateTime),
});
export type AgentControlExternalIntegration = typeof AgentControlExternalIntegration.Type;

export const AgentControlExternalTopology = Schema.Struct({
  available: Schema.Boolean,
  reason: Schema.NullOr(TrimmedNonEmptyString.check(Schema.isMaxLength(500))),
});
export type AgentControlExternalTopology = typeof AgentControlExternalTopology.Type;

/** Safe local bridge invocation. It contains paths and an integration id, never a credential. */
export const AgentControlExternalBridgeCommand = Schema.Struct({
  command: TrimmedNonEmptyString,
  args: Schema.Array(Schema.String),
});
export type AgentControlExternalBridgeCommand = typeof AgentControlExternalBridgeCommand.Type;

export const AgentControlExternalSetup = Schema.Struct({
  pairCommand: AgentControlExternalBridgeCommand,
  serveCommand: AgentControlExternalBridgeCommand,
  configuration: TrimmedNonEmptyString.check(Schema.isMaxLength(16_000)),
});
export type AgentControlExternalSetup = typeof AgentControlExternalSetup.Type;

export const AgentControlExternalIntegrationDetail = Schema.Struct({
  integration: AgentControlExternalIntegration,
  setup: AgentControlExternalSetup,
  topology: AgentControlExternalTopology,
});
export type AgentControlExternalIntegrationDetail =
  typeof AgentControlExternalIntegrationDetail.Type;

export const AgentControlExternalIntegrationCreateInput = Schema.Struct({
  displayName: TrimmedNonEmptyString.check(Schema.isMaxLength(120)),
  clientKind: AgentControlExternalClientKind,
  projectScope: AgentControlExternalProjectScope,
  capabilities: Schema.Array(AgentControlCapability).check(Schema.isMaxLength(32)),
  rateLimitPerMinute: PositiveInt.check(
    Schema.isLessThanOrEqualTo(AGENT_CONTROL_EXTERNAL_RATE_LIMIT_MAX),
  ),
  activeTaskLimit: PositiveInt.check(
    Schema.isLessThanOrEqualTo(AGENT_CONTROL_EXTERNAL_ACTIVE_TASK_LIMIT_MAX),
  ),
  expiresAt: Schema.NullOr(IsoDateTime),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type AgentControlExternalIntegrationCreateInput =
  typeof AgentControlExternalIntegrationCreateInput.Type;

export const AgentControlExternalIntegrationUpdateInput = Schema.Struct({
  integrationId: AgentControlIntegrationId,
  displayName: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(120))),
  clientKind: Schema.optional(AgentControlExternalClientKind),
  projectScope: Schema.optional(AgentControlExternalProjectScope),
  capabilities: Schema.optional(Schema.Array(AgentControlCapability).check(Schema.isMaxLength(32))),
  rateLimitPerMinute: Schema.optional(
    PositiveInt.check(Schema.isLessThanOrEqualTo(AGENT_CONTROL_EXTERNAL_RATE_LIMIT_MAX)),
  ),
  activeTaskLimit: Schema.optional(
    PositiveInt.check(Schema.isLessThanOrEqualTo(AGENT_CONTROL_EXTERNAL_ACTIVE_TASK_LIMIT_MAX)),
  ),
  expiresAt: Schema.optional(Schema.NullOr(IsoDateTime)),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type AgentControlExternalIntegrationUpdateInput =
  typeof AgentControlExternalIntegrationUpdateInput.Type;

export const AgentControlExternalIntegrationIdInput = Schema.Struct({
  integrationId: AgentControlIntegrationId,
});
export type AgentControlExternalIntegrationIdInput =
  typeof AgentControlExternalIntegrationIdInput.Type;

export const AgentControlExternalIntegrationListResult = Schema.Struct({
  integrations: Schema.Array(AgentControlExternalIntegrationDetail),
  topology: AgentControlExternalTopology,
});
export type AgentControlExternalIntegrationListResult =
  typeof AgentControlExternalIntegrationListResult.Type;

/** The short-lived code is returned only for a new/resumed pairing ceremony. */
export const AgentControlExternalPairingResult = Schema.Struct({
  detail: AgentControlExternalIntegrationDetail,
  pairingCode: TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
});
export type AgentControlExternalPairingResult = typeof AgentControlExternalPairingResult.Type;

export const AgentControlExternalIntegrationMutationResult = Schema.Struct({
  integration: AgentControlExternalIntegration,
});
export type AgentControlExternalIntegrationMutationResult =
  typeof AgentControlExternalIntegrationMutationResult.Type;

export const AgentControlExternalIntegrationDeleteResult = Schema.Struct({
  deleted: Schema.Boolean,
});
export type AgentControlExternalIntegrationDeleteResult =
  typeof AgentControlExternalIntegrationDeleteResult.Type;

export const AgentControlMcpInstallationState = Schema.Literals([
  "planned",
  "credential-written",
  "provider-written",
  "verifying",
  "connected",
  "repair-needed",
  "disconnecting",
  "disconnected",
  "revoked",
]);
export type AgentControlMcpInstallationState = typeof AgentControlMcpInstallationState.Type;

/** Public durable installation view. Native fingerprints and credentials stay server-side. */
export const AgentControlMcpInstallation = Schema.Struct({
  installationId: AgentControlMcpInstallationId,
  integrationId: AgentControlIntegrationId,
  workspaceId: McpWorkspaceId,
  driver: ProviderDriverKind,
  serverName: McpServerName,
  state: AgentControlMcpInstallationState,
  revision: NonNegativeInt,
  lastError: Schema.NullOr(TrimmedNonEmptyString.check(Schema.isMaxLength(500))),
  ownsNativeConfig: Schema.Boolean,
  preservedUserChanges: Schema.Boolean,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  connectedAt: Schema.NullOr(IsoDateTime),
});
export type AgentControlMcpInstallation = typeof AgentControlMcpInstallation.Type;

export const AgentControlMcpInstallationListResult = Schema.Struct({
  installations: Schema.Array(AgentControlMcpInstallation),
});
export type AgentControlMcpInstallationListResult =
  typeof AgentControlMcpInstallationListResult.Type;

export const AgentControlMcpInstallationConnectInput = Schema.Struct({
  workspaceId: McpWorkspaceId,
  displayName: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(120))),
  projectScope: Schema.optional(AgentControlExternalProjectScope),
  capabilities: Schema.optional(Schema.Array(AgentControlCapability).check(Schema.isMaxLength(32))),
  rateLimitPerMinute: Schema.optional(
    PositiveInt.check(Schema.isLessThanOrEqualTo(AGENT_CONTROL_EXTERNAL_RATE_LIMIT_MAX)),
  ),
  activeTaskLimit: Schema.optional(
    PositiveInt.check(Schema.isLessThanOrEqualTo(AGENT_CONTROL_EXTERNAL_ACTIVE_TASK_LIMIT_MAX)),
  ),
  expiresAt: Schema.optional(Schema.NullOr(IsoDateTime)),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type AgentControlMcpInstallationConnectInput =
  typeof AgentControlMcpInstallationConnectInput.Type;

export const AgentControlMcpInstallationIdInput = Schema.Struct({
  installationId: AgentControlMcpInstallationId,
});
export type AgentControlMcpInstallationIdInput = typeof AgentControlMcpInstallationIdInput.Type;

export const AgentControlMcpInstallationMutationResult = Schema.Struct({
  installation: AgentControlMcpInstallation,
});
export type AgentControlMcpInstallationMutationResult =
  typeof AgentControlMcpInstallationMutationResult.Type;

export const AgentControlExternalRpcErrorCode = Schema.Literals([
  "disabled",
  "topology",
  "not-found",
  "invalid",
  "conflict",
  "storage",
]);
export class AgentControlExternalRpcError extends Schema.TaggedError<AgentControlExternalRpcError>()(
  "AgentControlExternalRpcError",
  {
    code: AgentControlExternalRpcErrorCode,
    message: TrimmedNonEmptyString.check(Schema.isMaxLength(AGENT_CONTROL_ERROR_MESSAGE_MAX_CHARS)),
  },
) {}

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
}).annotate({ parseOptions: { onExcessProperty: "error" } });
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
