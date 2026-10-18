/**
 * Agent Control contracts.
 *
 * Schema-only definitions for the Agent Control control plane: principals,
 * capabilities, immutable action plans, approval proposals, and durable
 * execution operations. Agents never receive ambient write access — every
 * mutation is first captured as an immutable `AgentControlProposal`. Routine private-session
 * actions may be authorized by policy; other actions require user approval. Only the executor moves an accepted
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
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  CommandId,
  MessageId,
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
  ModelSelection,
  AgentTokenMode,
  ProviderInteractionMode,
  ProjectCustomSystemPrompt,
  ProjectScript,
  OrchestrationSessionStatus,
  ProjectMetadataDir,
  RuntimeMode,
} from "./orchestration.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";
import { McpServerName, McpWorkspaceId } from "./mcp.ts";
import { ThreadEnvMode } from "./settings.ts";
import { WorktreeId } from "./worktree.ts";
import {
  DeviceBootSource,
  DeviceBundleId,
  DeviceHardwareButton,
  DeviceRuntimeState,
  DeviceUdid,
  DEVICE_SWIPE_DURATION_MAX_MS,
  DEVICE_SWIPE_DURATION_MIN_MS,
} from "./device.ts";
import { LocalTaskId, LocalTaskTitle } from "./localTasks.ts";

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
/** Audit-safe target thread state captured at submission and used to reject stale approved plans. */
export const AgentControlTargetThreadSnapshot = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  runtimeMode: RuntimeMode,
  envMode: ThreadEnvMode,
  archived: Schema.Boolean,
  activeTurnId: Schema.NullOr(TurnId),
});
export type AgentControlTargetThreadSnapshot = typeof AgentControlTargetThreadSnapshot.Type;

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
  targetSnapshots: Schema.optional(Schema.Array(AgentControlTargetThreadSnapshot)),
});
export type AgentControlProviderSessionPrincipal = typeof AgentControlProviderSessionPrincipal.Type;

/**
 * A separately paired local MCP client. It has no caller thread, so its
 * privilege evidence is the integration's grant ceiling at submission.
 */
export const AgentControlExternalIntegrationPrincipal = Schema.Struct({
  kind: Schema.Literal("external-integration"),
  integrationId: AgentControlIntegrationId,
  label: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(120))),
  /**
   * Immutable execution-policy evidence captured when the proposal is created:
   * the task's own policy for created threads, or the integration's runtime
   * and checkout ceiling for thread control.
   */
  projectId: Schema.optional(ProjectId),
  runtimeMode: Schema.optional(RuntimeMode),
  envMode: Schema.optional(ThreadEnvMode),
  /** Audit-safe target state for thread control, used to reject stale approved plans. */
  targetSnapshots: Schema.optional(Schema.Array(AgentControlTargetThreadSnapshot)),
});
export type AgentControlExternalIntegrationPrincipal =
  typeof AgentControlExternalIntegrationPrincipal.Type;

/** Owner-authored automation only; never accepted from an MCP principal. */
export const AgentControlAutomationOwnerPrincipal = Schema.Struct({
  kind: Schema.Literal("automation-owner"),
  projectId: ProjectId,
  runtimeMode: RuntimeMode,
  envMode: ThreadEnvMode,
});

export const AgentControlPrincipal = Schema.Union([
  AgentControlAutomationOwnerPrincipal,
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
  attachFile: AgentControlCapability.make("files.attach"),
  /** Preview HTML pages in Ryco's headless browser and show them inline in the caller's thread. */
  renderHtml: AgentControlCapability.make("html.render"),
  createThreads: AgentControlCapability.make("threads.create"),
  sendMessage: AgentControlCapability.make("threads.send-message"),
  interruptThread: AgentControlCapability.make("threads.interrupt"),
  updateThread: AgentControlCapability.make("threads.update"),
  createProject: AgentControlCapability.make("projects.create"),
  updateProject: AgentControlCapability.make("projects.update"),
  removeProject: AgentControlCapability.make("projects.remove"),
  manageWorkspaces: AgentControlCapability.make("workspaces.manage"),
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
  /** Read the node's Tasks (the user's to-do list, not delegated runs). */
  readLocalTasks: AgentControlCapability.make("local-tasks.read"),
  /** Create, edit, complete, delete (with approval) Tasks and start their chats. */
  manageLocalTasks: AgentControlCapability.make("local-tasks.manage"),
  externalListProjects: AgentControlCapability.make("external.projects.list"),
  externalCreateTask: AgentControlCapability.make("external.tasks.create"),
  externalReadTask: AgentControlCapability.make("external.tasks.read"),
  externalSharedCheckout: AgentControlCapability.make("external.checkout.shared"),
  externalFullAccess: AgentControlCapability.make("external.runtime.full-access"),
  externalReadAutomations: AgentControlCapability.make("external.automations.read"),
  externalManageAutomations: AgentControlCapability.make("external.automations.manage"),
  externalReadActivity: AgentControlCapability.make("external.activity.read"),
  externalReadDiagnostics: AgentControlCapability.make("external.diagnostics.read"),
  externalReadThreads: AgentControlCapability.make("external.threads.read"),
  externalReadReviews: AgentControlCapability.make("external.reviews.read"),
  externalReadFiles: AgentControlCapability.make("external.files.read"),
  externalReadWorkspaces: AgentControlCapability.make("external.workspaces.read"),
  externalControlThreads: AgentControlCapability.make("external.threads.control"),
  externalManageWorkspaces: AgentControlCapability.make("external.workspaces.manage"),
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
  "workspaceLifecycle",
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
  "deleteLocalTask",
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
  workspaceLifecycle: AGENT_CONTROL_CAPABILITIES.manageWorkspaces,
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
  deleteLocalTask: AGENT_CONTROL_CAPABILITIES.manageLocalTasks,
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

export const AgentControlPrompt = TrimmedNonEmptyString.check(
  Schema.isMaxLength(AGENT_CONTROL_PROMPT_MAX_CHARS),
);
export const AgentControlTitle = TrimmedNonEmptyString.check(
  Schema.isMaxLength(AGENT_CONTROL_TITLE_MAX_CHARS),
);

/** As many artifacts as one message can carry. */
export const AGENT_CONTROL_HANDOFF_ARTIFACTS_MAX = 8;

/**
 * One of the calling thread's artifacts, `messageId:attachmentId` as
 * `ryco_list_artifacts` lists it (`@ryco/shared/threadArtifacts`).
 */
export const AgentControlArtifactId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(512),
  Schema.isPattern(/^.+:[a-z0-9_-]{1,128}$/i),
);
export type AgentControlArtifactId = typeof AgentControlArtifactId.Type;

export const AgentControlCreateThreadEntry = Schema.Struct({
  /** Return only this initial run to the exact originating provider turn. */
  returnToOrigin: Schema.optional(Schema.Boolean),
  /**
   * The caller's own artifacts to hand over: copied into the new thread and
   * attached to its first message. Provider-session callers only.
   */
  artifacts: Schema.optional(
    Schema.Array(AgentControlArtifactId).check(
      Schema.isMaxLength(AGENT_CONTROL_HANDOFF_ARTIFACTS_MAX),
    ),
  ),
  projectId: ProjectId,
  title: AgentControlTitle,
  prompt: AgentControlPrompt,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  tokenMode: Schema.optional(AgentTokenMode),
  /** Isolated worktree vs the project's shared local checkout. */
  envMode: ThreadEnvMode,
  /** Base ref for worktree creation; the project default when absent. */
  baseRef: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(256))),
  /**
   * Starts the thread as this Task's chat: the node records it under the task and
   * attaches the task's files to the first message. Provider-session callers only.
   */
  localTaskId: Schema.optional(LocalTaskId),
}).pipe(rejectExcessProperties);
export type AgentControlCreateThreadEntry = typeof AgentControlCreateThreadEntry.Type;

/** One exact immutable batch — never a generic spawning loop. */
export const AgentControlCreateThreadsPlan = Schema.Struct({
  kind: Schema.Literal("createThreads"),
  entries: Schema.Array(AgentControlCreateThreadEntry).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(AGENT_CONTROL_CREATE_THREADS_MAX_ENTRIES),
  ),
}).pipe(rejectExcessProperties);
export type AgentControlCreateThreadsPlan = typeof AgentControlCreateThreadsPlan.Type;

export const AgentControlSendMessageDelivery = Schema.Literals(["queue", "steer"]);
export type AgentControlSendMessageDelivery = typeof AgentControlSendMessageDelivery.Type;

export const AgentControlSendMessagePlan = Schema.Struct({
  kind: Schema.Literal("sendMessage"),
  threadId: ThreadId,
  text: AgentControlPrompt,
  delivery: AgentControlSendMessageDelivery,
}).pipe(rejectExcessProperties);
export type AgentControlSendMessagePlan = typeof AgentControlSendMessagePlan.Type;

export const AgentControlInterruptThreadPlan = Schema.Struct({
  kind: Schema.Literal("interruptThread"),
  threadId: ThreadId,
  /** When present, only this exact turn may be interrupted. */
  turnId: Schema.optional(TurnId),
}).pipe(rejectExcessProperties);
export type AgentControlInterruptThreadPlan = typeof AgentControlInterruptThreadPlan.Type;

export const AgentControlThreadPreferences = Schema.Struct({
  modelSelection: Schema.optional(ModelSelection),
  runtimeMode: Schema.optional(RuntimeMode),
  interactionMode: Schema.optional(ProviderInteractionMode),
  tokenMode: Schema.optional(AgentTokenMode),
});

export const AgentControlProjectPreferences = Schema.Struct({
  customSystemPrompt: Schema.optional(Schema.NullOr(ProjectCustomSystemPrompt)),
  scripts: Schema.optional(Schema.Array(ProjectScript).check(Schema.isMaxLength(100))),
  preferredRemoteName: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
});
export type AgentControlProjectPreferences = typeof AgentControlProjectPreferences.Type;

export const AgentControlUpdateThreadPlan = Schema.Struct({
  kind: Schema.Literal("updateThread"),
  threadId: ThreadId,
  ...AgentControlThreadPreferences.fields,
  title: Schema.optional(AgentControlTitle),
  archived: Schema.optional(Schema.Boolean),
  /** An explicitly requested persistent goal; `null` clears it. */
  persistentGoal: Schema.optional(
    Schema.NullOr(
      TrimmedNonEmptyString.check(Schema.isMaxLength(AGENT_CONTROL_PERSISTENT_GOAL_MAX_CHARS)),
    ),
  ),
}).pipe(rejectExcessProperties);
export type AgentControlUpdateThreadPlan = typeof AgentControlUpdateThreadPlan.Type;

export const AgentControlWorkspaceRoot = TrimmedNonEmptyString.check(Schema.isMaxLength(4_096));
const AgentControlRepositoryIdentityKey = Schema.NullOr(
  TrimmedNonEmptyString.check(Schema.isMaxLength(2_048)),
);

/** Canonical project state captured when a mutable project proposal is created. */
export const AgentControlProjectState = Schema.Struct({
  ...AgentControlProjectPreferences.fields,
  title: AgentControlTitle,
  workspaceRoot: AgentControlWorkspaceRoot,
  repositoryIdentityKey: AgentControlRepositoryIdentityKey,
  updatedAt: IsoDateTime,
}).pipe(rejectExcessProperties);
export type AgentControlProjectState = typeof AgentControlProjectState.Type;

export const AgentControlProjectTarget = Schema.Struct({
  ...AgentControlProjectPreferences.fields,
  title: AgentControlTitle,
  workspaceRoot: AgentControlWorkspaceRoot,
  repositoryIdentityKey: AgentControlRepositoryIdentityKey,
}).pipe(rejectExcessProperties);
export type AgentControlProjectTarget = typeof AgentControlProjectTarget.Type;

/** Creates only Ryco's project record for an already-existing authorized directory. */
export const AgentControlCreateProjectPlan = Schema.Struct({
  kind: Schema.Literal("createProject"),
  projectId: ProjectId,
  title: AgentControlTitle,
  workspaceRoot: AgentControlWorkspaceRoot,
  projectMetadataDir: ProjectMetadataDir,
  repositoryIdentityKey: AgentControlRepositoryIdentityKey,
}).pipe(rejectExcessProperties);
export type AgentControlCreateProjectPlan = typeof AgentControlCreateProjectPlan.Type;

/** Exact before/after project metadata and preference update. */
export const AgentControlUpdateProjectPlan = Schema.Struct({
  kind: Schema.Literal("updateProject"),
  projectId: ProjectId,
  before: AgentControlProjectState,
  after: AgentControlProjectTarget,
}).pipe(rejectExcessProperties);
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
}).pipe(rejectExcessProperties);
export type AgentControlRemoveProjectPlan = typeof AgentControlRemoveProjectPlan.Type;

/** Audit-safe workspace inventory and immutable lifecycle evidence. */
export const AgentControlWorkspaceState = Schema.Struct({
  workspaceId: TrimmedNonEmptyString,
  projectId: ProjectId,
  registration: Schema.Literals(["registered", "synthetic"]),
  mainWorkspaceId: Schema.NullOr(WorktreeId),
  checkoutIdentity: Schema.NullOr(Schema.String),
  rootIdentity: Schema.NullOr(Schema.String),
  worktreeId: Schema.NullOr(WorktreeId),
  title: Schema.String,
  origin: Schema.String,
  branch: Schema.NullOr(Schema.String),
  path: Schema.String,
  projectRoot: Schema.String,
  projectUpdatedAt: IsoDateTime,
  updatedAt: IsoDateTime,
  archivedAt: Schema.NullOr(IsoDateTime),
  main: Schema.Boolean,
  current: Schema.Boolean,
  checkout: Schema.Literals(["present", "missing", "unavailable"]),
  gitRegistered: Schema.NullOr(Schema.Boolean),
  repository: Schema.NullOr(Schema.String),
  repositoryIdentity: Schema.NullOr(Schema.String),
  head: Schema.NullOr(Schema.String),
  branchHead: Schema.NullOr(Schema.String),
  baseHead: Schema.NullOr(Schema.String),
  dirty: Schema.NullOr(Schema.Boolean),
  unmerged: Schema.NullOr(Schema.Boolean),
  sessions: Schema.Array(
    Schema.Struct({
      threadId: ThreadId,
      updatedAt: IsoDateTime,
      archived: Schema.Boolean,
      active: Schema.Boolean,
    }),
  ).check(Schema.isMaxLength(500)),
  blockers: Schema.Array(Schema.String),
});
export type AgentControlWorkspaceState = typeof AgentControlWorkspaceState.Type;

export const AgentControlWorkspaceLifecycleOptions = Schema.Struct({
  action: Schema.Literals(["archive", "restore", "delete"]),
  checkoutMode: Schema.Literals(["record-only", "remove-checkout", "restore-checkout"]),
  sessions: Schema.Literals(["preserve", "delete"]),
  deleteBranch: Schema.Boolean,
});
export const AgentControlWorkspaceLifecyclePlan = Schema.Struct({
  kind: Schema.Literal("workspaceLifecycle"),
  ...AgentControlWorkspaceLifecycleOptions.fields,
  projectId: ProjectId,
  expected: AgentControlWorkspaceState,
}).pipe(rejectExcessProperties);
export type AgentControlWorkspaceLifecyclePlan = typeof AgentControlWorkspaceLifecyclePlan.Type;

export const AgentControlListWorkspacesInput = Schema.Struct({
  projectId: ProjectId,
  after: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(256))),
  limit: Schema.optional(PositiveInt.check(Schema.isLessThanOrEqualTo(50))),
});
export const AgentControlReadWorkspaceInput = Schema.Struct({
  projectId: ProjectId,
  workspaceId: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
});
export const AgentControlPlanWorkspaceInput = Schema.Struct({
  ...AgentControlReadWorkspaceInput.fields,
  ...AgentControlWorkspaceLifecycleOptions.fields,
});
export const AgentControlProposeWorkspaceInput = Schema.Struct({
  requestId: AgentControlRequestId,
  plan: AgentControlWorkspaceLifecyclePlan,
}).pipe(rejectExcessProperties);

export const AgentControlLegacyTokenStreamingChange = Schema.Struct({
  kind: Schema.Literal("legacyTokenStreaming"),
  before: Schema.Boolean,
  after: Schema.Boolean,
}).pipe(rejectExcessProperties);
export type AgentControlLegacyTokenStreamingChange =
  typeof AgentControlLegacyTokenStreamingChange.Type;

export const AgentControlProviderUpdateChecksChange = Schema.Struct({
  kind: Schema.Literal("providerUpdateChecks"),
  before: Schema.Boolean,
  after: Schema.Boolean,
}).pipe(rejectExcessProperties);
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
}).pipe(rejectExcessProperties);
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
  tokenMode: Schema.optional(AgentTokenMode),
  envMode: ThreadEnvMode,
  baseRef: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(256))),
}).pipe(rejectExcessProperties);
export type AgentControlAutomationExecutionTemplate =
  typeof AgentControlAutomationExecutionTemplate.Type;

export const AgentControlAutomationSchedule = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("once"),
    runAt: IsoDateTime,
  }).pipe(rejectExcessProperties),
  Schema.Struct({
    kind: Schema.Literal("fixed-interval"),
    startsAt: IsoDateTime,
    intervalMs: PositiveInt,
    /** Required finite end: recurring schedules are never unbounded. */
    endsAt: IsoDateTime,
  }).pipe(rejectExcessProperties),
]);
export type AgentControlAutomationSchedule = typeof AgentControlAutomationSchedule.Type;

export const AgentControlAutomationDefinition = Schema.Struct({
  execution: AgentControlAutomationExecutionTemplate,
  schedule: AgentControlAutomationSchedule,
  enabled: Schema.Boolean,
}).pipe(rejectExcessProperties);
export type AgentControlAutomationDefinition = typeof AgentControlAutomationDefinition.Type;

/** Exact persisted definition revision captured in update/cancel plans. */
export const AgentControlAutomationRevisionState = Schema.Struct({
  revision: PositiveInt,
  definition: AgentControlAutomationDefinition,
  cancelled: Schema.Boolean,
  updatedAt: IsoDateTime,
}).pipe(rejectExcessProperties);
export type AgentControlAutomationRevisionState = typeof AgentControlAutomationRevisionState.Type;

export const AgentControlCreateAutomationPlan = Schema.Struct({
  kind: Schema.Literal("createAutomation"),
  automationId: AgentControlAutomationId,
  definition: AgentControlAutomationDefinition,
}).pipe(rejectExcessProperties);
export type AgentControlCreateAutomationPlan = typeof AgentControlCreateAutomationPlan.Type;

export const AgentControlUpdateAutomationPlan = Schema.Struct({
  kind: Schema.Literal("updateAutomation"),
  automationId: AgentControlAutomationId,
  before: AgentControlAutomationRevisionState,
  after: AgentControlAutomationDefinition,
}).pipe(rejectExcessProperties);
export type AgentControlUpdateAutomationPlan = typeof AgentControlUpdateAutomationPlan.Type;

export const AgentControlCancelAutomationPlan = Schema.Struct({
  kind: Schema.Literal("cancelAutomation"),
  automationId: AgentControlAutomationId,
  expected: AgentControlAutomationRevisionState,
}).pipe(rejectExcessProperties);
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
}).pipe(rejectExcessProperties);
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
  Schema.isPattern(
    /^(?!\/)(?!~)(?![A-Za-z]:)(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*\\)[^\0]+\.(?:app|apk)$/u,
  ),
);
export type AgentControlDeviceArtifactPath = typeof AgentControlDeviceArtifactPath.Type;

const AgentControlDeviceExecutionSummary = TrimmedNonEmptyString.check(Schema.isMaxLength(240));
export const AgentControlDeviceCoordinate = Schema.Finite.check(
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
}).pipe(rejectExcessProperties);
export type AgentControlDeviceBootPlan = typeof AgentControlDeviceBootPlan.Type;

export const AgentControlDeviceAttachPlan = Schema.Struct({
  kind: Schema.Literal("deviceAttach"),
  ...AgentControlDevicePlanTarget.fields,
}).pipe(rejectExcessProperties);
export type AgentControlDeviceAttachPlan = typeof AgentControlDeviceAttachPlan.Type;

export const AgentControlDeviceDetachPlan = Schema.Struct({
  kind: Schema.Literal("deviceDetach"),
  ...AgentControlDevicePlanTarget.fields,
}).pipe(rejectExcessProperties);
export type AgentControlDeviceDetachPlan = typeof AgentControlDeviceDetachPlan.Type;

export const AgentControlDeviceInstallPlan = Schema.Struct({
  kind: Schema.Literal("deviceInstall"),
  ...AgentControlDevicePlanTarget.fields,
  artifactPath: AgentControlDeviceArtifactPath,
}).pipe(rejectExcessProperties);
export type AgentControlDeviceInstallPlan = typeof AgentControlDeviceInstallPlan.Type;

/** Launch arguments are deliberately absent: they may contain user secrets. */
export const AgentControlDeviceLaunchPlan = Schema.Struct({
  kind: Schema.Literal("deviceLaunch"),
  ...AgentControlDevicePlanTarget.fields,
  bundleId: DeviceBundleId,
}).pipe(rejectExcessProperties);
export type AgentControlDeviceLaunchPlan = typeof AgentControlDeviceLaunchPlan.Type;

export const AgentControlDeviceOpenUrlPlan = Schema.Struct({
  kind: Schema.Literal("deviceOpenUrl"),
  ...AgentControlDevicePlanTarget.fields,
  url: TrimmedNonEmptyString.check(Schema.isMaxLength(AGENT_CONTROL_DEVICE_URL_MAX_CHARS)),
}).pipe(rejectExcessProperties);
export type AgentControlDeviceOpenUrlPlan = typeof AgentControlDeviceOpenUrlPlan.Type;

export const AgentControlDeviceTapPlan = Schema.Struct({
  kind: Schema.Literal("deviceTap"),
  ...AgentControlDevicePlanTarget.fields,
  x: AgentControlDeviceCoordinate,
  y: AgentControlDeviceCoordinate,
}).pipe(rejectExcessProperties);
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
}).pipe(rejectExcessProperties);
export type AgentControlDeviceSwipePlan = typeof AgentControlDeviceSwipePlan.Type;

export const AgentControlDevicePressButtonPlan = Schema.Struct({
  kind: Schema.Literal("devicePressButton"),
  ...AgentControlDevicePlanTarget.fields,
  button: DeviceHardwareButton,
}).pipe(rejectExcessProperties);
export type AgentControlDevicePressButtonPlan = typeof AgentControlDevicePressButtonPlan.Type;

export const AgentControlDeviceStartRecordingPlan = Schema.Struct({
  kind: Schema.Literal("deviceStartRecording"),
  ...AgentControlDevicePlanTarget.fields,
}).pipe(rejectExcessProperties);
export type AgentControlDeviceStartRecordingPlan = typeof AgentControlDeviceStartRecordingPlan.Type;

export const AgentControlDeviceStopRecordingPlan = Schema.Struct({
  kind: Schema.Literal("deviceStopRecording"),
  ...AgentControlDevicePlanTarget.fields,
}).pipe(rejectExcessProperties);
export type AgentControlDeviceStopRecordingPlan = typeof AgentControlDeviceStopRecordingPlan.Type;

export const AgentControlDeviceShutdownPlan = Schema.Struct({
  kind: Schema.Literal("deviceShutdown"),
  ...AgentControlDevicePlanTarget.fields,
}).pipe(rejectExcessProperties);
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

/**
 * Deletes one of the node's Tasks with its files and its record of started chats
 * (the chats themselves stay). Always approved by the user.
 */
export const AgentControlDeleteLocalTaskPlan = Schema.Struct({
  kind: Schema.Literal("deleteLocalTask"),
  taskId: LocalTaskId,
  /** The revision the user approves deleting; a task edited since fails closed. */
  expectedRevision: NonNegativeInt,
  /** Shown on the approval card. */
  title: LocalTaskTitle,
}).pipe(rejectExcessProperties);
export type AgentControlDeleteLocalTaskPlan = typeof AgentControlDeleteLocalTaskPlan.Type;

export const AgentControlActionPlan = Schema.Union([
  AgentControlCreateThreadsPlan,
  AgentControlSendMessagePlan,
  AgentControlInterruptThreadPlan,
  AgentControlUpdateThreadPlan,
  AgentControlCreateProjectPlan,
  AgentControlUpdateProjectPlan,
  AgentControlRemoveProjectPlan,
  AgentControlWorkspaceLifecyclePlan,
  AgentControlChangeSettingsPlan,
  AgentControlCreateAutomationPlan,
  AgentControlUpdateAutomationPlan,
  AgentControlCancelAutomationPlan,
  AgentControlAutomationRunPlan,
  AgentControlDeviceActionPlan,
  AgentControlDeleteLocalTaskPlan,
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
  workspaceLifecycle: AgentControlRiskTag.make("workspace-lifecycle"),
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
  removesLocalTask: AgentControlRiskTag.make("removes-local-task"),
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
  workspaceLifecycle: Schema.optional(
    Schema.Struct({
      completedSteps: Schema.Array(Schema.String),
    }),
  ),
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
/** Independent of command-dispatch receipts. No provider exactly-once guarantee. */
export const AgentControlCompletionReturn = Schema.Struct({
  revision: NonNegativeInt.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
  childThreadId: ThreadId,
  initialMessageId: MessageId,
  parentThreadId: ThreadId,
  parentTurnId: TurnId,
  childTurnId: Schema.NullOr(TurnId),
  status: Schema.Literals([
    "waiting",
    "ready",
    "dispatching",
    "delivered",
    "blocked",
    "cancelled",
    "failed",
    "uncertain",
  ]),
  detail: Schema.String.check(Schema.isMaxLength(512)),
  updatedAt: IsoDateTime,
});
export type AgentControlCompletionReturn = typeof AgentControlCompletionReturn.Type;

export const AgentControlProposal = Schema.Struct({
  completionReturns: Schema.optional(Schema.Array(AgentControlCompletionReturn)),
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
  automationCentre: "agentControl.automationCentre",
  automationCommand: "agentControl.automationCommand",
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
  completionReturns: Schema.optional(Schema.Array(AgentControlCompletionReturn)),
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
 * Queue snapshot: non-terminal proposals and pending completion returns, plus a bounded
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
}).pipe(rejectExcessProperties);
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
}).pipe(rejectExcessProperties);
export type AgentControlAutomationRun = typeof AgentControlAutomationRun.Type;

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
}).pipe(rejectExcessProperties);
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
}).pipe(rejectExcessProperties);
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
}).pipe(rejectExcessProperties);
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
