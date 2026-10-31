import type { EffectiveProjectPreferences } from "./settings.ts";
import type { DesktopWindowMaterial } from "./windowMaterial.ts";
import type {
  DesktopNotificationBadge,
  DesktopThreadNotification,
  DesktopThreadNotificationResult,
} from "./desktopNotifications.ts";
import type {
  LifecycleSuggestions,
  TrashListResult,
  WorkspaceChangesSummaryInput,
  WorkspaceChangesSummaryResult,
  WorkspaceDiskUsageInput,
  WorkspaceDiskUsageResult,
  WorkspaceLifecycleApplyInput,
  WorkspaceLifecycleListInputType,
  WorkspaceLifecyclePreview,
  WorkspaceLifecycleRequest,
  WorkspaceLifecycleResult,
  WorkspaceLifecycleSummary,
} from "./workspaceLifecycle.ts";
import type {
  CodexResetCreditAccount,
  CodexResetCreditInput,
  CodexResetCreditOutcome,
} from "./codexResetCredits.ts";
import type {
  ComputerGetAuditHistoryInput,
  ComputerGetAuditHistoryResult,
} from "./computerAudit.ts";
import type {
  ComputerBetaPreferences,
  ComputerBetaState,
  ComputerBetaUpdate,
  ComputerTurnIntent,
} from "./computerBeta.ts";
import type {
  DesktopAppSnapCapture,
  DesktopAppSnapErrorEvent,
  DesktopAppSnapPermissionKind,
  DesktopAppSnapShortcut,
  DesktopAppSnapWindowEntry,
} from "./computerPermissions.ts";
import type {
  DesktopWindowCapturePendingEntry,
  DesktopWindowCaptureShortcutResult,
  DesktopWindowCaptureState,
} from "./windowCapture.ts";
import type {
  GitReadLineBlameInput,
  GitReadLineBlameResult,
  GitReadImageBlobInput,
  GitReadImageBlobResult,
  GitLocalChangesInput,
  GitLocalChangesResult,
  GitApplyIndexPatchInput,
  GitReadComparisonInput,
  GitReadComparisonResult,
} from "./git.ts";
import type { AutomationCentreApi } from "./automationCentre.ts";
import type { NotesApi } from "./notes.ts";
import type {
  AcpRegistrySearchInput,
  AcpRegistrySearchResult,
  AcpRegistryInstallInput,
  AcpRegistryInstallation,
} from "./acpRegistry.ts";
import type {
  AcpRegistryAuthInput,
  AcpRegistryAuthenticateInput,
  AcpRegistryAuthMethod,
  AcpRegistryAuthenticationResult,
} from "./rpc.ts";
import type {
  ChatAttachmentReadChunkInput,
  ChatAttachmentReadChunkResult,
} from "./orchestration.ts";
import type {
  ResourceTelemetrySnapshot,
  ResourceTelemetryHistoryInput,
  ResourceTelemetryHistory,
} from "./resourceTelemetry.ts";
import type {
  ProjectBrowserState,
  ProjectBrowserCommand,
  ProjectBrowserSurface,
  ProjectBrowserPickResult,
  DiscoveredProjectSite,
} from "./projectBrowser.ts";
import type {
  GitArchiveWorktreeInput,
  GitCreateWorktreeForProjectInput,
  GitCreateWorktreeForProjectOutput,
  GitDeleteWorktreeInput,
  GitFindWorktreeForOriginInput,
  GitFindWorktreeForOriginOutput,
  GitRestoreWorktreeInput,
  ProjectsInitializeGitInput,
  ThreadsSetManualBucketInput,
  ThreadsSetManualPositionInput,
  WorktreesSetManualPositionInput,
  EmptyRpcResult,
} from "./rpc.ts";
import type { ExternalIdentitySummary } from "./hostedIdentity.ts";
import type { RelayEffectiveRole } from "./relay.ts";
import type { ThreadForkInput, ThreadForkResult } from "./threadFork.ts";
import type {
  ThreadLocalServerList,
  ThreadStopLocalServerInput,
  ThreadStopLocalServerResult,
  ThreadSubscribeLocalServersInput,
} from "./threadLocalServers.ts";
import type {
  ComputerUseState,
  ComputerUsePolicy,
  ComputerUsePairing,
  ComputerBrowser,
} from "./computerUse.ts";
import type {
  VcsSwitchRefInput,
  VcsSwitchRefResult,
  VcsCreateRefInput,
  GitPreparePullRequestThreadInput,
  GitPreparePullRequestThreadResult,
  GitPullRequestRefInput,
  VcsCreateWorktreeInput,
  VcsCreateWorktreeResult,
  VcsInitInput,
  VcsListRefsInput,
  VcsListRefsResult,
  VcsPrefetchWorktreeBaseInput,
  VcsPullInput,
  VcsPullResult,
  VcsRemoveWorktreeInput,
  GitResolvePullRequestResult,
  GitRunStackedActionInput,
  GitRunStackedActionResult,
  GitActionProgressEvent,
  GitCancelStackedActionInput,
  GitCancelStackedActionResult,
  VcsStatusInput,
  VcsStatusResult,
  VcsCreateRefResult,
} from "./git.ts";
import type {
  WorktreeSetupCancelInput,
  WorktreeSetupCancelResult,
  WorktreeSetupSnapshot,
  WorktreeSetupSubscribeInput,
} from "./worktreeSetup.ts";
import type {
  AgentControlDecideProposalInput,
  AgentControlGetProposalInput,
  AgentControlGetProposalResult,
  AgentControlListProposalsInput,
  AgentControlProposalQueue,
  AgentControlProposalReceipt,
  AgentControlProposalStreamEvent,
  AgentControlExternalIntegrationCreateInput,
  AgentControlExternalIntegrationDeleteResult,
  AgentControlExternalIntegrationIdInput,
  AgentControlExternalIntegrationListResult,
  AgentControlExternalIntegrationMutationResult,
  AgentControlExternalIntegrationUpdateInput,
  AgentControlExternalPairingResult,
  AgentControlMcpInstallationConnectInput,
  AgentControlMcpInstallationIdInput,
  AgentControlMcpInstallationListResult,
  AgentControlMcpInstallationMutationResult,
} from "./agentControl.ts";
import type { FilesystemBrowseInput, FilesystemBrowseResult } from "./filesystem.ts";
import type {
  McpListServersInput,
  McpListServersResult,
  McpListWorkspacesResult,
  McpOauthLoginInput,
  McpOauthLoginResult,
  McpServerEnabledInput,
  McpServerRemoveInput,
  McpServerUpsertInput,
  McpServersReloadInput,
} from "./mcp.ts";
import type {
  OpinionatedPluginCheckInput,
  OpinionatedPluginInstallInput,
  OpinionatedPluginInstallResult,
  OpinionatedPluginListResult,
  OpinionatedPluginStatusResult,
} from "./opinionatedPlugins.ts";
import type {
  ProjectListEntriesInput,
  ProjectListEntriesResult,
  ProjectReadIconInput,
  ProjectReadIconResult,
  ProjectReadFileBinaryInput,
  ProjectReadFileBinaryResult,
  ProjectReadFileChunkInput,
  ProjectReadFileChunkResult,
  ProjectFileChangeEvent,
  ProjectWatchFileInput,
  ProjectReadFileInput,
  ProjectReadFileResult,
  ProjectStageFileReferenceInput,
  ProjectStageFileReferenceResult,
  ProjectSearchContentInput,
  ProjectSearchContentResult,
  ProjectSearchEntriesInput,
  ProjectSearchEntriesResult,
  ProjectWriteFileInput,
  ProjectWriteFileResult,
  ProjectsDeleteChatFolderInput,
  ProjectsDeleteChatFolderResult,
  ProjectsPromoteChatInput,
  ProjectsPromoteChatPreviewInput,
  ProjectsPromoteChatPreviewResult,
  ProjectsPromoteChatResult,
} from "./project.ts";
import type { ProviderInstanceId } from "./providerInstance.ts";
import type {
  ServerConfig,
  ServerLocalDiagnosticsMetrics,
  ServerProviderUpdateInput,
  ServerProviderUpdatedPayload,
  ServerUpsertKeybindingResult,
  KeybindingsReplaceCustomInput,
  KeybindingsReplaceCustomResult,
} from "./server.ts";
import type {
  TerminalClearInput,
  TerminalCloseInput,
  TerminalEvent,
  TerminalOpenInput,
  TerminalResizeInput,
  TerminalRestartInput,
  TerminalSessionSnapshot,
  TerminalWriteInput,
} from "./terminal.ts";
import type { ServerUpsertKeybindingInput } from "./server.ts";
import type {
  ClientOrchestrationCommand,
  ContextHandoffExportChunk,
  ContextHandoffExportChunkInput,
  ContextHandoffInspectionEntriesInput,
  ContextHandoffInspectionEntriesPage,
  ContextHandoffInspectionSummary,
  ContextHandoffInspectionSummaryInput,
  ContextHandoffRawPayloadChunk,
  ContextHandoffRawPayloadChunkInput,
  OrchestrationGetFullThreadDiffInput,
  OrchestrationGetFullThreadDiffResult,
  OrchestrationGetActivityPayloadInput,
  OrchestrationGetActivityPayloadResult,
  OrchestrationGetThreadHistoryPageInput,
  OrchestrationGetThreadWindowInput,
  OrchestrationGetThreadShellsInput,
  OrchestrationGetThreadShellsResult,
  OrchestrationThreadHistoryPage,
  OrchestrationThreadWindowSnapshot,
  OrchestrationThreadWindowStreamItem,
  OrchestrationSearchThreadMessagesInput,
  OrchestrationSearchThreadMessagesResult,
  OrchestrationGetTurnDiffInput,
  OrchestrationGetTurnDiffResult,
  OrchestrationGetTaskOutputInput,
  OrchestrationGetTaskOutputResult,
  OrchestrationGetWorkflowScriptInput,
  OrchestrationGetWorkflowScriptResult,
  OrchestrationStopBackgroundTaskInput,
  OrchestrationMessageBackgroundTaskInput,
  OrchestrationMessageBackgroundTaskResult,
  OrchestrationStopBackgroundTaskResult,
  OrchestrationReplayEventsInput,
  OrchestrationReplayEventsPageInput,
  OrchestrationReplayEventsPageResult,
  OrchestrationReplayEventsResult,
  OrchestrationShellSubscriptionItem,
  OrchestrationSubscribeThreadInput,
  OrchestrationThreadStreamItem,
} from "./orchestration.ts";
import type { EnvironmentId, ProjectId, ThreadId } from "./baseSchemas.ts";
import type {
  DiagnosticsSnapshot,
  DiagnosticsSignalProcessInput,
  DiagnosticsSignalProcessResult,
} from "./diagnostics.ts";
import type { StatisticsSnapshot } from "./statistics.ts";
import type { UsageSummary, UsageSummaryRequest } from "./usage.ts";
import type {
  AuthBearerBootstrapResult,
  AuthSessionState,
  AuthWebSocketTokenResult,
} from "./auth.ts";
import type { AdvertisedEndpoint } from "./remoteAccess.ts";
import { EditorId } from "./editor.ts";
import type { ExecutionEnvironmentDescriptor, ScopedThreadRef } from "./environment.ts";
import type { ClientSettings, ServerSettings, ServerSettingsPatch } from "./settings.ts";
import type {
  DeviceAttachInput,
  DeviceBootInput,
  DeviceBootResult,
  DeviceDescribeUiInput,
  DeviceDescribeUiResult,
  DeviceDetachInput,
  DeviceEvent,
  DeviceInstallAppInput,
  DeviceInstallAppResult,
  DeviceKeyEventInput,
  DeviceLaunchAppInput,
  DeviceLaunchAppResult,
  DeviceListInput,
  DeviceListResult,
  DeviceOpenUrlInput,
  DeviceTestingInput,
  DevicePressButtonInput,
  DeviceScreenshotInput,
  DeviceScreenshotResult,
  DeviceScrollToElementInput,
  DeviceScrollToElementResult,
  DeviceShutdownInput,
  DeviceStartRecordingInput,
  DeviceStartRecordingResult,
  DeviceStopRecordingInput,
  DeviceStopRecordingResult,
  DeviceSwipeInput,
  DeviceTapInput,
  DeviceThreadInput,
  DeviceTypeTextInput,
  ThreadDeviceState,
} from "./device.ts";
import type {
  SourceControlCloneRepositoryInput,
  SourceControlCloneRepositoryResult,
  SourceControlDiscoveryResult,
  SourceControlPublishRepositoryInput,
  SourceControlPublishRepositoryResult,
  SourceControlRepositoryInfo,
  SourceControlRepositoryLookupInput,
  SourceControlRepositorySearchInput,
  SourceControlRepositorySearchResult,
} from "./sourceControl.ts";
import type {
  SourceControlSetPullRequestWatchInput,
  SourceControlSetPullRequestWatchResult,
} from "./pullRequestWatchRpc.ts";
import type {
  ChangeRequestTemplateListInput,
  ChangeRequestTemplateListResult,
} from "./changeRequestReview.ts";

export interface ContextMenuItem<T extends string = string> {
  id: T;
  label: string;
  destructive?: boolean;
  disabled?: boolean;
  children?: readonly ContextMenuItem<T>[];
}

export type DesktopUpdateStatus =
  | "disabled"
  | "idle"
  | "checking"
  | "up-to-date"
  | "available"
  | "downloading"
  | "downloaded"
  | "error";

export type DesktopTheme = "light" | "dark" | "system";
export type DesktopUpdateChannel = "latest" | "nightly";
export type DesktopAppStageLabel = "Beta" | "Dev" | "Nightly";

export interface DesktopAppBranding {
  baseName: string;
  stageLabel: DesktopAppStageLabel;
  displayName: string;
}

/**
 * An update another device asked this desktop app to install (Update everything on a
 * remote client). The app downloads it, then counts down to its relaunch so someone at
 * this machine can postpone it.
 */
export interface DesktopRemoteInstallState {
  requestId: string;
  targetVersion: string;
  phase: "downloading" | "countdown" | "installing" | "postponed" | "failed";
  /** `countdown` only: when the app relaunches unless it is postponed. */
  restartAt: string | null;
  message: string | null;
}

export interface DesktopUpdateState {
  enabled: boolean;
  status: DesktopUpdateStatus;
  channel: DesktopUpdateChannel;
  currentVersion: string;
  availableVersion: string | null;
  downloadedVersion: string | null;
  downloadPercent: number | null;
  checkedAt: string | null;
  message: string | null;
  errorContext: "check" | "download" | "install" | null;
  canRetry: boolean;
  /** Absent or `null` unless another device asked this app to update. */
  remoteInstall?: DesktopRemoteInstallState | null;
}

export interface DesktopUpdateActionResult {
  accepted: boolean;
  completed: boolean;
  state: DesktopUpdateState;
}

export interface DesktopUpdateCheckResult {
  checked: boolean;
  state: DesktopUpdateState;
}

export interface DesktopEnvironmentBootstrap {
  label: string;
  httpBaseUrl: string | null;
  wsBaseUrl: string | null;
  bootstrapToken?: string;
}

export interface DesktopSshEnvironmentTarget {
  alias: string;
  hostname: string;
  username: string | null;
  port: number | null;
}

export type DesktopSshHostSource = "ssh-config" | "known-hosts";

export interface DesktopDiscoveredSshHost extends DesktopSshEnvironmentTarget {
  source: DesktopSshHostSource;
}

export interface DesktopSshEnvironmentBootstrap {
  target: DesktopSshEnvironmentTarget;
  httpBaseUrl: string;
  wsBaseUrl: string;
  pairingToken: string | null;
  remotePort?: number;
  remoteServerKind?: "external" | "managed";
}

export interface DesktopSshPasswordPromptRequest {
  requestId: string;
  destination: string;
  username: string | null;
  prompt: string;
  expiresAt: string;
}

/**
 * A saved environment whose direct access was issued over a trusted Hub relay
 * channel (Hub-linked direct access), rather than by a pasted pairing link.
 */
export interface SavedEnvironmentHubLink {
  /** The node's Hub environment id: a different id from the direct one. */
  hubEnvironmentId: string;
  /** When the direct credential was last issued; it is renewed through the Hub. */
  linkedAt: string;
  /**
   * The node identity key (Ed25519, base64url) the grant named: each direct
   * address must prove it before the bearer goes there. A link saved before
   * the proof existed has none, so it is never used and is renewed instead.
   */
  nodeIdentityPublicKey?: string;
}

export interface PersistedSavedEnvironmentRecord {
  environmentId: EnvironmentId;
  label: string;
  wsBaseUrl: string;
  httpBaseUrl: string;
  createdAt: string;
  lastConnectedAt: string | null;
  desktopSsh?: DesktopSshEnvironmentTarget;
  hubLink?: SavedEnvironmentHubLink;
  /**
   * When the user switched the machine off (ISO time). A switched-off machine
   * stays saved with its credential but never connects until switched on.
   * Absent means on, so an app that predates the field keeps it on.
   */
  disabledAt?: string;
}

export type DesktopServerExposureMode = "local-only" | "network-accessible";

/**
 * What the running backend serves. The `pending*` fields describe a change
 * saved for the next launch, which only a relaunch applies.
 */
export interface DesktopServerExposureState {
  mode: DesktopServerExposureMode;
  endpointUrl: string | null;
  advertisedHost: string | null;
  tailscaleServeEnabled: boolean;
  tailscaleServePort: number;
  /**
   * The network access mode the next launch binds, while it differs from
   * `mode`: a change deferred until running turns finish, or one the network
   * could not serve when Ryco started. Absent when nothing is pending.
   */
  pendingMode?: DesktopServerExposureMode;
  /** What the next launch serves through Tailscale, while it differs from what runs. */
  pendingTailscaleServe?: { readonly enabled: boolean; readonly port: number };
}

export interface PickFolderOptions {
  initialPath?: string | null;
}

export interface DesktopHubLaunchConfig {
  /**
   * The operator (or account setup) explicitly turned the connector on. When
   * false and not turned off, a configured Hub still runs its connector in
   * standby for a node with no Hub identity yet.
   */
  readonly enabled: boolean;
  readonly origin: string | null;
  readonly nodeName: string | null;
  readonly allowFileSecretStore: boolean;
  /** Whether this host can use the hardened permissioned-file fallback. */
  readonly fileSecretStoreFallbackSupported: boolean;
  /**
   * Whether Desktop main can run native Ryco account setup on this host. When
   * false the node enrols through the Hub's device-code ceremony instead.
   */
  readonly hostedIdentitySupported: boolean;
  /**
   * The saved launch configuration differs from what the running backend
   * serves, so it applies only after a relaunch. Absent means false.
   */
  readonly restartRequired?: boolean;
}

/** What `setHubLaunchConfig` did with a change. */
export interface DesktopHubLaunchConfigResult {
  /**
   * Desktop is relaunching to apply it. False when the change was only saved
   * for a later launch, or when the running backend already serves it.
   */
  readonly relaunching: boolean;
}

/**
 * When Desktop main holds this machine awake: never, while other devices can reach it, or while
 * they can reach it or agents work on its own backend. Always on AC power only; the display may
 * still sleep.
 */
export type DesktopKeepAwakeMode = "off" | "reachable" | "reachable-or-working";

/** Whether Desktop main is holding this machine awake, and why. */
export interface DesktopKeepAwakeState {
  /** The operator's preference. "reachable-or-working" by default. */
  readonly mode: DesktopKeepAwakeMode;
  /** Other devices can reach this node through the Hub, the network, or Tailscale. */
  readonly reachable: boolean;
  /** The local backend reports agent work (and for 2 minutes after it ends). */
  readonly agentWorking: boolean;
  readonly onBattery: boolean;
  /** Ryco currently holds the system awake. Only ever true on AC power. */
  readonly active: boolean;
}

/** Secret-free projection of Desktop main's native Hub identity workflow. */
export interface DesktopHostedIdentityState {
  readonly status: "signed-out" | "ready" | "unavailable";
  /** Present only after a current Hub has returned strict external-identity policy and metadata. */
  readonly github?: {
    readonly linkAvailable: boolean;
    readonly identity: ExternalIdentitySummary | null;
  };
}

export interface DesktopHostedIdentityActionResult {
  readonly outcome:
    | "committed"
    | "cancelled"
    | "step-up-required"
    | "last-primary-credential"
    | "unavailable";
  readonly state: DesktopHostedIdentityState;
}

export type DesktopWorkspaceNativeTrustState =
  | "not-required"
  | "unknown"
  | "unverified"
  | "verified"
  | "account-trusted"
  | "identity-conflict";

export interface DesktopWorkspaceMachineProjection {
  readonly environmentId: EnvironmentId;
  readonly nodeId: string | null;
  readonly label: string;
  readonly online: boolean;
  readonly nativeTrust: DesktopWorkspaceNativeTrustState;
  readonly connectionState: "disconnected" | "connecting" | "connected" | "error";
  /** Hub metadata can be renamed while the device is offline; this grants no runtime access. */
  readonly canRename?: boolean;
  readonly canReadMetadata: boolean;
  readonly canConnect: boolean;
  readonly canMutate: boolean;
  readonly effectiveRole: RelayEffectiveRole | null;
  /** As the Hub directory states it; absent when it does not (unknown, not unsupported). */
  readonly threadSettlementSupported?: boolean;
  readonly accessReasons: ReadonlyArray<string>;
}

/** Metadata-only snapshot transported across the isolated Desktop preload. */
export interface DesktopWorkspaceMetadataProjection {
  readonly schemaVersion: 1;
  readonly environmentId: EnvironmentId;
  readonly capturedAt: number;
  readonly projects: ReadonlyArray<unknown>;
  readonly worktrees: ReadonlyArray<unknown>;
  readonly threads: ReadonlyArray<unknown>;
}

export interface DesktopWorkspaceStateProjection {
  readonly status: "signed-out" | "ready" | "unavailable";
  readonly accountId: string | null;
  readonly localEnvironmentId: EnvironmentId | null;
  readonly machines: ReadonlyArray<DesktopWorkspaceMachineProjection>;
  readonly snapshots: ReadonlyArray<DesktopWorkspaceMetadataProjection>;
  readonly queuedEnvironmentIds: ReadonlyArray<EnvironmentId>;
  readonly activeConnectionCount: number;
  /**
   * This installation's Hub account enrollment. `ready` is what makes remote
   * machines without a locally verified pin account-trusted; `securing` covers
   * the first enrollment and automatic retries after a transient failure.
   */
  readonly accountE2ee?: "ready" | "securing" | "unavailable" | "revoked";
}

/** The state without its snapshot bodies, which can reach megabytes. */
export type DesktopWorkspaceStateSummary = Omit<DesktopWorkspaceStateProjection, "snapshots">;

/**
 * A state pushed to the renderer. `snapshots` is absent when they are the same
 * as in the previous push, so the renderer keeps the ones it holds.
 */
export type DesktopWorkspaceStatePush = DesktopWorkspaceStateSummary &
  Partial<Pick<DesktopWorkspaceStateProjection, "snapshots">>;

/**
 * Display-only content of one thread (its recent messages) as it crosses the
 * isolated Desktop preload. Main validates what it is handed and what it
 * stores; the renderer validates what it reads back.
 */
export interface DesktopThreadContentProjection {
  readonly messages: ReadonlyArray<unknown>;
}

/** Thread content by thread id, least recently visited first. */
export type DesktopThreadContentProjectionMap = Readonly<
  Record<string, DesktopThreadContentProjection>
>;

export type DesktopWorkspaceScopeProjection =
  | { readonly type: "interactive" }
  | { readonly type: "thread-detail"; readonly threadId: ThreadId }
  | { readonly type: "vcs-status"; readonly cwd: string }
  | { readonly type: "provider-status"; readonly instanceId?: string };

export interface DesktopWorkspaceConnectionCommand {
  readonly action: "connect" | "release";
  readonly environmentId: EnvironmentId;
  readonly delayMs: number;
}

/** Opaque main-owned relay transport. Payloads are authorized RPC bytes, never credentials. */
export type DesktopWorkspaceTransportEvent =
  | { readonly type: "open"; readonly transportId: string }
  | {
      readonly type: "message";
      readonly transportId: string;
      readonly data: Uint8Array;
    }
  | { readonly type: "error"; readonly transportId: string }
  | {
      readonly type: "close";
      readonly transportId: string;
      readonly code: number;
      readonly reason: string;
      /** Secret-free recovery policy supplied by the authenticated relay. */
      readonly retryable?: boolean;
      readonly retryAfterMs?: number;
    };

/**
 * Outcome of activating a prepared workspace transport. A failed activation is
 * an expected outcome (relay unavailable, handle expired) and is reported as a
 * value: Electron logs every rejected IPC invocation with a stack, which turned
 * reconnect storms into log storms. The transport's own `close` event carries
 * the secret-free recovery policy.
 */
export type DesktopWorkspaceTransportActivation =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "invalid-transport" | "unavailable" };

export type DesktopNativeE2eePreparation =
  | { readonly kind: "web-eligible" }
  | { readonly kind: "strict-unavailable" }
  | {
      readonly kind: "native";
      readonly attemptHandle: string;
      readonly credentials: {
        readonly tier: "native";
        readonly accountId: string;
        readonly identityPublicKey: Uint8Array;
        readonly agreementPublicKey: Uint8Array;
        readonly prekeyTranscript: Uint8Array;
        readonly prekeySignature: Uint8Array;
      };
      readonly verifiedPin: {
        readonly identityFingerprint: Uint8Array;
        readonly continuityId: string;
      };
      readonly acceptedPolicyGeneration: number;
    };

export interface DesktopNativeE2eeHandshakeStartInput {
  readonly statement: Uint8Array;
  readonly channel: {
    readonly hubOrigin: string;
    readonly channelId: string;
    readonly relayProtocolMajor: number;
    readonly relayProtocolMinor: number;
    readonly channelOpenCapability: string;
    readonly channelOpenEffectiveRole: string;
  };
  readonly selectedSuite: number;
  readonly offeredSuites: readonly number[];
  readonly intendedCapability: string;
  readonly intendedRole: string;
  readonly now: number;
}

export type DesktopNativeE2eeHandshakeStartResult =
  | {
      readonly kind: "hello";
      readonly handle: string;
      readonly result: {
        readonly kind: "hello";
        readonly record: Uint8Array;
        readonly contextBlock: Uint8Array;
        readonly contextCommitment: Uint8Array;
        readonly prologue: Uint8Array;
        readonly deadlineAt: number;
      };
    }
  | {
      readonly kind: "fatal";
      readonly result: {
        readonly kind: "fatal";
        readonly row: string;
        readonly reason: string;
      };
    };

export type DesktopNativeE2eeHandshakeFinishResult =
  | {
      readonly kind: "established";
      readonly sessionBindingHash: Uint8Array;
      readonly secrets: {
        readonly epochSecretC2N: Uint8Array;
        readonly epochSecretN2C: Uint8Array;
        readonly exporterSecret: Uint8Array;
        readonly serverConfirmationKey: Uint8Array;
      };
      readonly suite: number;
      readonly contextBlock: Uint8Array;
      readonly serverAcceptTbs: Uint8Array;
      readonly confirmationTranscript: Uint8Array;
      readonly webEphemeralPublicKey?: Uint8Array;
    }
  | {
      readonly kind: "fatal";
      readonly row: string;
      readonly reason: string;
    };

export type DesktopHubOriginRejection =
  | "empty"
  | "too_long"
  | "not_a_url"
  | "insecure_scheme"
  | "has_credentials"
  | "has_path"
  | "invalid";

export type DesktopHubOriginValidation =
  | { readonly ok: true; readonly origin: string; readonly normalized: boolean }
  | {
      readonly ok: false;
      readonly reason: DesktopHubOriginRejection;
      readonly suggestion?: string;
    };

export type DesktopQuitShortcutMode = "press-twice" | "hold" | "immediately";

/** Where the desktop app's `ryco` terminal command stands (`desktopCliCommand.ts`). */
export interface DesktopCliCommandState {
  /** macOS and Linux, installed app only. */
  readonly supported: boolean;
  /** `ryco`, or `ryco-nightly` for Ryco Nightly. */
  readonly commandName: string;
  /** The link on a PATH folder this app made, if any. */
  readonly installedPath: string | null;
  /** A new terminal runs this app's launcher for `commandName`. */
  readonly onPath: boolean;
  /** Another command of that name a new terminal runs first. */
  readonly shadowedBy?: string;
  /** The launcher itself, which runs without a PATH entry. */
  readonly launcherPath: string | null;
}

/** Ryco and Ryco Nightly, as each app sees the other (`nightlyHandoff.ts`). */
export interface DesktopNightlyState {
  /** Which app this is. */
  readonly flavor: "stable" | "nightly";
  /** The other app is installed where this one looks for it (macOS Applications folders). */
  readonly otherAppInstalled: boolean;
  /** Ryco: Ryco Nightly's node is running now, so it cannot take a copy until it quits. */
  readonly nightlyRunning: boolean;
  /** Ryco Nightly: how the last copy of Ryco's data went; null when none was asked for. */
  readonly lastImport: {
    readonly completedAt: string;
    readonly ok: boolean;
    readonly error?: string;
  } | null;
  /** Where both apps are downloaded. */
  readonly releasesUrl: string;
}

/**
 * What a chat that quitting would stop is doing. Only `working` chats can be continued after a
 * restart: chats waiting for a person are never continued.
 */
export type DesktopQuitRunningChatStatus = "working" | "approval" | "input" | "connecting";

/** A chat on this desktop's own backend that quitting Ryco would stop. */
export interface DesktopQuitRunningChat {
  readonly threadId: string;
  readonly title: string;
  readonly status: DesktopQuitRunningChatStatus;
}

/**
 * The renderer's answer to "which chats would quitting stop?". `unknown` while this desktop's
 * environment is not known or has no live snapshot (cached or held-over rows show nothing running).
 */
export type DesktopQuitRunningChatsReport =
  | { readonly status: "unknown" }
  | {
      readonly status: "known";
      /** Every running chat on this desktop's backend; `chats` lists at most 8 of them. */
      readonly runningCount: number;
      /** Running chats that are `working`, the only ones a restart can continue. */
      readonly resumableCount: number;
      /** Most recently started first. */
      readonly chats: ReadonlyArray<DesktopQuitRunningChat>;
      /** Running chats on other nodes; quitting does not stop them. */
      readonly otherNodesRunningCount: number;
      /** The node's `continueThreadsAfterRestart`, `null` while its settings are not loaded. */
      readonly continueThreadsAfterRestart: boolean | null;
    };

/** Answers Desktop main's questions before a quit. One per window; the last registration wins. */
export interface DesktopQuitGuardResponder {
  readonly runningChats: () => DesktopQuitRunningChatsReport;
  /** Persist the node's `continueThreadsAfterRestart`; resolves once the node saved it. */
  readonly setContinueAfterRestart: (enabled: boolean) => Promise<void>;
}

export interface DesktopThreadExportInput {
  readonly filename: string;
  readonly contents: string;
}

export type DesktopThreadExportResult = { readonly status: "saved" | "cancelled" };

/** The desktop menu action of Edit > Paste as Text; the app answers it with `pasteAsText`. */
export const DESKTOP_PASTE_AS_TEXT_MENU_ACTION = "paste-as-text";

/** The desktop menu actions of a window's trackpad swipes; the app steps its own history for them. */
export const DESKTOP_NAVIGATE_BACK_MENU_ACTION = "navigate-back";
export const DESKTOP_NAVIGATE_FORWARD_MENU_ACTION = "navigate-forward";

export interface DesktopBridge {
  saveThreadExport?: (input: DesktopThreadExportInput) => Promise<DesktopThreadExportResult>;
  /** Install the `ryco` command for terminals. Absent in desktop builds that predate it. */
  cliCommand?: {
    getState(): Promise<DesktopCliCommandState>;
    install(): Promise<DesktopCliCommandState>;
    uninstall(): Promise<DesktopCliCommandState>;
  };
  /** Try Ryco Nightly from Ryco, and switch back. Absent in desktop builds that predate it. */
  nightly?: {
    getState(): Promise<DesktopNightlyState>;
    /** Ryco only. With `copyData`, Ryco Nightly takes a copy of Ryco's data when it starts. */
    open(input: { readonly copyData: boolean }): Promise<void>;
    /** Ryco Nightly only. Opens Ryco; nothing is copied back. */
    switchBack(): Promise<void>;
  };
  quitShortcut?: {
    getMode(): Promise<DesktopQuitShortcutMode>;
    setMode(mode: DesktopQuitShortcutMode): Promise<void>;
    onFeedback(listener: (state: "press-twice" | "hold" | null) => void): () => void;
  };
  /**
   * Lets Desktop main ask this window, before a quit, which chats quitting would stop. Absent on
   * hosts that predate the quit confirmation. Returns the unregister function.
   */
  quitGuard?: {
    register(responder: DesktopQuitGuardResponder): () => void;
  };
  browser?: {
    getState(): Promise<ProjectBrowserState>;
    open(input: { url: string; project: string }): Promise<string>;
    command(input: ProjectBrowserCommand): Promise<void>;
    surface(input: ProjectBrowserSurface): Promise<void>;
    capture(tab: string): Promise<string>;
    /**
     * Lets the user pick one element on a docked tab; settles when an element is picked or the pick
     * ends. Optional: a desktop shell without it offers no picker.
     */
    pick?(tab: string): Promise<ProjectBrowserPickResult>;
    discover(cwd?: string): Promise<readonly DiscoveredProjectSite[]>;
    onFocusAddress(listener: (tab: string) => void): () => void;
    onState(listener: (state: ProjectBrowserState) => void): () => void;
  };
  computerBeta?: {
    getHistory(input?: ComputerGetAuditHistoryInput): Promise<ComputerGetAuditHistoryResult>;
    getState(): Promise<ComputerBetaState>;
    checkPermissions(): Promise<ComputerBetaState>;
    setup(): Promise<ComputerBetaState>;
    setPreferences(preferences: ComputerBetaPreferences): Promise<ComputerBetaState>;
    prepare(threadId: string, explicit: boolean): Promise<ComputerTurnIntent | null>;
    setPreview(threadId: string, visible: boolean): Promise<void>;
    stopTask(threadId: string): Promise<void>;
    onUpdate(listener: (update: ComputerBetaUpdate) => void): () => void;
  };
  computerUse?: {
    getState(): Promise<ComputerUseState>;
    checkPermissions(): Promise<ComputerUseState>;
    refresh(query?: string): Promise<ComputerUseState>;
    setPolicy(policy: ComputerUsePolicy): Promise<ComputerUseState>;
    requestPermission(kind: "accessibility" | "screenRecording"): Promise<void>;
    pairBrowser(browser: ComputerBrowser): Promise<ComputerUsePairing>;
    showExtension(): Promise<string>;
    openBrowserSetup(browser: ComputerBrowser): Promise<void>;
    stop(): Promise<void>;
    onState(listener: (state: ComputerUseState) => void): () => void;
  };
  /**
   * Window capture into the composer. Only the macOS desktop app exposes it;
   * web, hosted and other desktop platforms leave it undefined.
   */
  windowCapture?: {
    /** Current state after a preflight grant check; never raises a macOS prompt. */
    getState(): Promise<DesktopWindowCaptureState>;
    /**
     * Guides the user through the given grants (the picker asks for Screen
     * Recording alone), or through those the current setup needs.
     */
    setup(
      permissions?: readonly DesktopAppSnapPermissionKind[],
    ): Promise<DesktopWindowCaptureState>;
    /**
     * Saves and arms the global shortcut; null turns it off. One that macOS,
     * another app or typing uses is reported and not saved.
     */
    setShortcut(
      shortcut: DesktopAppSnapShortcut | null,
    ): Promise<DesktopWindowCaptureShortcutResult>;
    listWindows(): Promise<readonly DesktopAppSnapWindowEntry[]>;
    /** The capture stays pending in the desktop app until it is acknowledged. */
    captureWindow(windowId: number): Promise<DesktopAppSnapCapture>;
    /** Captures not yet acknowledged (e.g. taken while no composer was open), without bytes. */
    listPendingCaptures(): Promise<readonly DesktopWindowCapturePendingEntry[]>;
    /** One pending capture with its bytes; null once it was acknowledged. */
    readPendingCapture(captureId: string): Promise<DesktopAppSnapCapture | null>;
    acknowledgeCapture(captureId: string): Promise<void>;
    onState(listener: (state: DesktopWindowCaptureState) => void): () => void;
    /** A capture the global shortcut took; it is pending until acknowledged. */
    onCaptured(listener: (capture: DesktopAppSnapCapture) => void): () => void;
    onError(listener: (error: DesktopAppSnapErrorEvent) => void): () => void;
  };
  getAppBranding: () => DesktopAppBranding | null;
  getLocalEnvironmentBootstrap: () => DesktopEnvironmentBootstrap | null;
  /** Installation-owned non-secret shortcut document, independent of every backend. */
  appKeybindings?: {
    read: () => Promise<string | null>;
    write: (document: string) => Promise<void>;
    onChanged: (listener: () => void) => () => void;
  };
  getClientSettings: () => Promise<ClientSettings | null>;
  setClientSettings: (settings: ClientSettings) => Promise<void>;
  getSavedEnvironmentRegistry: () => Promise<readonly PersistedSavedEnvironmentRecord[]>;
  setSavedEnvironmentRegistry: (
    records: readonly PersistedSavedEnvironmentRecord[],
  ) => Promise<void>;
  getSavedEnvironmentSecret: (environmentId: EnvironmentId) => Promise<string | null>;
  setSavedEnvironmentSecret: (environmentId: EnvironmentId, secret: string) => Promise<boolean>;
  removeSavedEnvironmentSecret: (environmentId: EnvironmentId) => Promise<void>;
  discoverSshHosts: () => Promise<readonly DesktopDiscoveredSshHost[]>;
  ensureSshEnvironment: (
    target: DesktopSshEnvironmentTarget,
    options?: { issuePairingToken?: boolean },
  ) => Promise<DesktopSshEnvironmentBootstrap>;
  disconnectSshEnvironment: (target: DesktopSshEnvironmentTarget) => Promise<void>;
  fetchSshEnvironmentDescriptor: (httpBaseUrl: string) => Promise<ExecutionEnvironmentDescriptor>;
  bootstrapSshBearerSession: (
    httpBaseUrl: string,
    credential: string,
  ) => Promise<AuthBearerBootstrapResult>;
  fetchSshSessionState: (httpBaseUrl: string, bearerToken: string) => Promise<AuthSessionState>;
  issueSshWebSocketToken: (
    httpBaseUrl: string,
    bearerToken: string,
  ) => Promise<AuthWebSocketTokenResult>;
  onSshPasswordPrompt: (listener: (request: DesktopSshPasswordPromptRequest) => void) => () => void;
  resolveSshPasswordPrompt: (requestId: string, password: string | null) => Promise<void>;
  getServerExposureState: () => Promise<DesktopServerExposureState>;
  /**
   * Network access and Tailscale Serve apply by relaunching Desktop. With
   * `deferRelaunch`, the change is only saved: the running backend keeps what
   * it serves, the returned state still describes it (with the saved change as
   * `pending*`), and the change applies on the next launch, which the caller
   * schedules. Requesting what the backend already serves withdraws a saved
   * change and never relaunches.
   */
  setServerExposureMode: (
    mode: DesktopServerExposureMode,
    options?: { readonly deferRelaunch?: boolean },
  ) => Promise<DesktopServerExposureState>;
  setTailscaleServeEnabled: (input: {
    readonly enabled: boolean;
    readonly port?: number;
    readonly deferRelaunch?: boolean;
  }) => Promise<DesktopServerExposureState>;
  getHubLaunchConfig: () => Promise<DesktopHubLaunchConfig>;
  /** Keep this desktop awake while it is plugged in and reachable or working. Applies live. */
  getKeepAwakeState?: () => Promise<DesktopKeepAwakeState>;
  setKeepAwakeMode?: (mode: DesktopKeepAwakeMode) => Promise<DesktopKeepAwakeState>;
  /** Relaunch the Desktop shell without changing persisted launch configuration. */
  restartApp?: () => Promise<void>;
  /** Native account setup is available only in Desktop builds that support hardware-backed keys. */
  getHostedIdentityState?: () => Promise<DesktopHostedIdentityState>;
  connectHostedIdentity?: () => Promise<DesktopHostedIdentityState>;
  disconnectHostedIdentity?: () => Promise<DesktopHostedIdentityState>;
  connectHostedGitHub?: (input?: {
    readonly totpCode?: string;
  }) => Promise<DesktopHostedIdentityActionResult>;
  disconnectHostedGitHub?: (input?: {
    readonly totpCode?: string;
  }) => Promise<DesktopHostedIdentityActionResult>;
  cancelHostedGitHubConnection?: () => Promise<void>;
  /**
   * Secret-free native workspace client projection and scoped operations. Only
   * the state read carries snapshot bodies; the replies to commands are
   * summaries, and changed snapshots arrive through `onDesktopWorkspaceState`.
   */
  getDesktopWorkspaceState?: () => Promise<DesktopWorkspaceStateProjection>;
  renameDesktopWorkspaceDevice?: (input: {
    readonly environmentId: EnvironmentId;
    readonly label: string;
  }) => Promise<DesktopWorkspaceStateSummary>;
  refreshDesktopWorkspaceCatalog?: () => Promise<DesktopWorkspaceStateSummary>;
  publishDesktopWorkspaceSnapshot?: (
    snapshot: DesktopWorkspaceMetadataProjection,
  ) => Promise<DesktopWorkspaceStateSummary>;
  retainDesktopWorkspaceScope?: (input: {
    readonly environmentId: EnvironmentId;
    readonly scope: DesktopWorkspaceScopeProjection;
  }) => Promise<{
    readonly leaseId: string;
    readonly state: DesktopWorkspaceStateSummary;
  }>;
  renewDesktopWorkspaceScope?: (leaseId: string) => Promise<DesktopWorkspaceStateSummary>;
  releaseDesktopWorkspaceScope?: (leaseId: string) => Promise<DesktopWorkspaceStateSummary>;
  setDesktopWorkspaceBackgrounded?: (
    backgrounded: boolean,
  ) => Promise<DesktopWorkspaceStateSummary>;
  purgeDesktopWorkspaceCache?: (
    environmentId?: EnvironmentId,
  ) => Promise<DesktopWorkspaceStateSummary>;
  beginDesktopWorkspaceVerification?: (input: {
    readonly nodeId: string;
    readonly environmentId: EnvironmentId;
  }) => Promise<{ readonly handle: string }>;
  cancelDesktopWorkspaceVerification?: (handle: string) => Promise<void>;
  verifyDesktopWorkspaceApproval?: (input: {
    readonly nodeId: string;
    readonly environmentId: EnvironmentId;
    readonly payload: string;
  }) => Promise<DesktopWorkspaceStateSummary>;
  /**
   * The Desktop-local cache of recent conversation text. Main keeps it
   * encrypted and bounded; the renderer hands it display content and reads it
   * back to paint a cold start. Publishing is fire-and-forget.
   */
  publishDesktopThreadContent?: (
    environmentId: EnvironmentId,
    content: DesktopThreadContentProjectionMap,
  ) => void;
  getDesktopThreadContent?: (
    environmentId: EnvironmentId,
  ) => Promise<DesktopThreadContentProjectionMap>;
  getDesktopThreadContentCacheEnabled?: () => Promise<boolean>;
  /** Turning the cache off deletes what it holds. Resolves to the setting now in effect. */
  setDesktopThreadContentCacheEnabled?: (enabled: boolean) => Promise<boolean>;
  onDesktopWorkspaceState?: (listener: (state: DesktopWorkspaceStatePush) => void) => () => void;
  onDesktopWorkspaceConnectionCommand?: (
    listener: (command: DesktopWorkspaceConnectionCommand) => void,
  ) => () => void;
  prepareDesktopWorkspaceTransport?: (
    environmentId: EnvironmentId,
  ) => Promise<{ readonly transportId: string }>;
  activateDesktopWorkspaceTransport?: (
    transportId: string,
  ) => Promise<DesktopWorkspaceTransportActivation>;
  sendDesktopWorkspaceTransport?: (transportId: string, data: Uint8Array) => void;
  closeDesktopWorkspaceTransport?: (transportId: string) => void;
  reportDesktopWorkspaceConnection?: (input: {
    readonly environmentId: EnvironmentId;
    readonly connected: boolean;
  }) => Promise<void>;
  onDesktopWorkspaceTransportEvent?: (
    listener: (event: DesktopWorkspaceTransportEvent) => void,
  ) => () => void;
  /**
   * Persist hub launch configuration and relaunch to apply it.
   *
   * The connector is built during server startup, so a change cannot take effect
   * in the running process — the same reason network access and Tailscale Serve
   * relaunch. Callers must confirm with the operator first.
   *
   * `applyOnNextLaunch` is accepted only with `enabled: true` and nothing else,
   * and only while the running backend runs its connector in standby: it
   * records that enrollment started here without restarting a backend that
   * already serves it.
   *
   * `deferRelaunch` saves any other change without relaunching; it applies on
   * the next launch, which the caller schedules. `restartRequired` reports it
   * meanwhile.
   *
   * A change the running backend already serves, such as reverting a deferred
   * change, is saved without a relaunch; the result says which happened.
   */
  setHubLaunchConfig: (input: {
    readonly enabled?: boolean;
    readonly origin?: string | null;
    readonly nodeName?: string | null;
    readonly allowFileSecretStore?: boolean;
    readonly applyOnNextLaunch?: boolean;
    readonly deferRelaunch?: boolean;
  }) => Promise<DesktopHubLaunchConfigResult>;
  /** Validate a typed Hub address without persisting it. */
  validateHubOrigin: (raw: string) => Promise<DesktopHubOriginValidation>;
  getAdvertisedEndpoints: () => Promise<readonly AdvertisedEndpoint[]>;
  getPathForFile?: (file: File) => string;
  pickFolder: (options?: PickFolderOptions) => Promise<string | null>;
  confirm: (message: string) => Promise<boolean>;
  setTheme: (theme: DesktopTheme) => Promise<void>;
  /**
   * Whether this window can let the desktop show through it (macOS vibrancy).
   * Absent on hosts that predate the capability.
   */
  readonly windowTranslucencySupported?: boolean;
  /**
   * Apply a window material. Resolves whether it took effect as asked: `false` for a
   * translucent request means the window server refused the custom blur and the
   * window fell back to the system vibrancy material.
   */
  setWindowMaterial?: (input: DesktopWindowMaterial) => Promise<boolean>;
  showContextMenu: <T extends string>(
    items: readonly ContextMenuItem<T>[],
    position?: { x: number; y: number },
  ) => Promise<T | null>;
  openExternal: (url: string) => Promise<boolean>;
  onMenuAction: (listener: (action: string) => void) => () => void;
  /**
   * Pastes the clipboard as plain text into the calling window's focused element. The Edit
   * menu's Paste as Text sends `DESKTOP_PASTE_AS_TEXT_MENU_ACTION`, and the app calls this once
   * it is ready for the paste. Absent in desktop builds that predate it.
   */
  pasteAsText?: () => Promise<void>;
  /** The machine woke from sleep or the screen was unlocked; live sockets may be dead. */
  onSystemResume?: (listener: () => void) => () => void;
  getUpdateState: () => Promise<DesktopUpdateState>;
  checkForUpdate: () => Promise<DesktopUpdateCheckResult>;
  downloadUpdate: () => Promise<DesktopUpdateActionResult>;
  installUpdate: () => Promise<DesktopUpdateActionResult>;
  onUpdateState: (listener: (state: DesktopUpdateState) => void) => () => void;
  /** Answer a remote install's countdown: relaunch now, or postpone it (the download stays). */
  respondToRemoteInstall: (action: "now" | "postpone") => Promise<DesktopUpdateState>;
  /**
   * Shows a thread alert as an OS notification, one per thread. Answers
   * `window-focused` instead while the window is in front. Absent in desktop
   * builds that predate it.
   */
  notifyThread?: (
    notification: DesktopThreadNotification,
  ) => Promise<DesktopThreadNotificationResult>;
  /** A thread notification was clicked: main revealed the window, the renderer opens the thread. */
  onThreadNotificationActivated?: (listener: (thread: ScopedThreadRef) => void) => () => void;
  /** Shows the count badge on the dock or taskbar; main clears it while a window has focus. */
  setNotificationBadge?: (badge: DesktopNotificationBadge) => Promise<void>;
  /** Main cleared the badge (a window got focus, or the app is quitting). */
  onNotificationBadgeCleared?: (listener: () => void) => () => void;
}

/**
 * APIs bound to the local app shell, not to any particular backend environment.
 *
 * These capabilities describe the desktop/browser host that the user is
 * currently running: dialogs, editor/external-link opening, context menus, and
 * app-level settings/config access. They must not be used as a proxy for
 * "whatever environment the user is targeting", because in a multi-environment
 * world the local shell and a selected backend environment are distinct
 * concepts.
 */
export interface LocalApi {
  dialogs: {
    pickFolder: (options?: PickFolderOptions) => Promise<string | null>;
    confirm: (message: string) => Promise<boolean>;
  };
  shell: {
    openInEditor: (cwd: string, editor: EditorId) => Promise<void>;
    openExternal: (url: string) => Promise<void>;
    getPathForFile?: (file: File) => Promise<string | null>;
  };
  contextMenu: {
    show: <T extends string>(
      items: readonly ContextMenuItem<T>[],
      position?: { x: number; y: number },
    ) => Promise<T | null>;
  };
  persistence: {
    getClientSettings: () => Promise<ClientSettings | null>;
    setClientSettings: (settings: ClientSettings) => Promise<void>;
    getSavedEnvironmentRegistry: () => Promise<readonly PersistedSavedEnvironmentRecord[]>;
    setSavedEnvironmentRegistry: (
      records: readonly PersistedSavedEnvironmentRecord[],
    ) => Promise<void>;
    getSavedEnvironmentSecret: (environmentId: EnvironmentId) => Promise<string | null>;
    setSavedEnvironmentSecret: (environmentId: EnvironmentId, secret: string) => Promise<boolean>;
    removeSavedEnvironmentSecret: (environmentId: EnvironmentId) => Promise<void>;
  };
  server: {
    getConfig: () => Promise<ServerConfig>;
    getAdvertisedEndpoints: () => Promise<readonly AdvertisedEndpoint[]>;
    getDiagnosticsMetrics: () => Promise<ServerLocalDiagnosticsMetrics>;
    getStatistics: () => Promise<StatisticsSnapshot>;
    getUsageSummary: (input: UsageSummaryRequest) => Promise<UsageSummary>;
    /**
     * Refresh provider snapshots. When `input.instanceId` is supplied only that
     * configured instance is probed; otherwise every configured instance is
     * refreshed (legacy untargeted refresh).
     */
    readCodexResetCredits?: (input: {
      instanceId: ProviderInstanceId;
    }) => Promise<CodexResetCreditAccount>;
    consumeCodexResetCredit?: (
      input: CodexResetCreditInput,
    ) => Promise<{ outcome: CodexResetCreditOutcome }>;
    readCliProxyHubs?: (
      input: import("./cliProxy.ts").CliProxyReadHubsInput,
    ) => Promise<import("./cliProxy.ts").CliProxyReadHubsResult>;
    testCliProxyHub?: (
      input: import("./cliProxy.ts").CliProxyTestHubInput,
    ) => Promise<import("./cliProxy.ts").CliProxyTestHubResult>;
    refreshProviders: (input?: {
      readonly instanceId?: ProviderInstanceId;
    }) => Promise<ServerProviderUpdatedPayload>;
    searchAcpRegistry?: (
      input: typeof AcpRegistrySearchInput.Type,
    ) => Promise<typeof AcpRegistrySearchResult.Type>;
    installAcpRegistry?: (input: AcpRegistryInstallInput) => Promise<AcpRegistryInstallation>;
    getAcpRegistryAuthMethods?: (
      input: AcpRegistryAuthInput,
    ) => Promise<readonly AcpRegistryAuthMethod[]>;
    authenticateAcpRegistry?: (
      input: AcpRegistryAuthenticateInput,
    ) => Promise<AcpRegistryAuthenticationResult>;
    updateProvider: (input: ServerProviderUpdateInput) => Promise<ServerProviderUpdatedPayload>;
    listLocalTasks?: (
      input: import("./localTasks.ts").LocalTaskListInput,
    ) => Promise<import("./localTasks.ts").LocalTaskListResult>;
    getLocalTask?: (input: { taskId: string }) => Promise<import("./localTasks.ts").LocalTask>;
    createLocalTask?: (
      input: import("./localTasks.ts").LocalTaskCreateInput,
    ) => Promise<import("./localTasks.ts").LocalTask>;
    updateLocalTask?: (
      input: import("./localTasks.ts").LocalTaskUpdateInput,
    ) => Promise<import("./localTasks.ts").LocalTask>;
    deleteLocalTask?: (
      input: import("./localTasks.ts").LocalTaskDeleteInput,
    ) => Promise<{ readonly deleted: true }>;
    delegateLocalTask?: (
      input: import("./localTasks.ts").LocalTaskDelegateInput,
    ) => Promise<import("./localTasks.ts").LocalTask>;
    createLocalTaskFileUpload?: (
      input: import("./localTasks.ts").LocalTaskFileUploadInput,
    ) => Promise<import("./orchestration.ts").FileAttachmentCreateUploadUrlResult>;
    addLocalTaskFile?: (
      input: import("./localTasks.ts").LocalTaskAddFileInput,
    ) => Promise<import("./localTasks.ts").LocalTask>;
    removeLocalTaskFile?: (
      input: import("./localTasks.ts").LocalTaskRemoveFileInput,
    ) => Promise<import("./localTasks.ts").LocalTask>;
    /** Each task that changes on the node from now on; returns the unsubscribe. */
    subscribeLocalTaskChanges?: (
      listener: (change: import("./localTasks.ts").LocalTaskChange) => void,
    ) => () => void;
    getDailyRecap?: (
      input: import("./dailyRecap.ts").DailyRecapRequest,
    ) => Promise<import("./dailyRecap.ts").DailyRecapSnapshot>;
    upsertKeybinding: (input: ServerUpsertKeybindingInput) => Promise<ServerUpsertKeybindingResult>;
    getSettings: () => Promise<ServerSettings>;
    getProjectPreferences?: (input: {
      readonly projectId?: ProjectId;
    }) => Promise<EffectiveProjectPreferences>;
    updateSettings: (patch: ServerSettingsPatch) => Promise<ServerSettings>;
    getDiagnosticsSnapshot: () => Promise<DiagnosticsSnapshot>;
    getResourceTelemetryHistory?: (
      input: ResourceTelemetryHistoryInput,
    ) => Promise<ResourceTelemetryHistory>;
    retryResourceTelemetry?: () => Promise<ResourceTelemetrySnapshot>;
    signalDiagnosticProcess?: (
      input: DiagnosticsSignalProcessInput,
    ) => Promise<DiagnosticsSignalProcessResult>;
    /** `cached` accepts the server's recent result; an explicit refresh omits it. */
    discoverSourceControl: (input?: {
      readonly cached?: boolean;
    }) => Promise<SourceControlDiscoveryResult>;
    listOpinionatedPlugins: () => Promise<OpinionatedPluginListResult>;
    checkOpinionatedPlugins: (
      input?: OpinionatedPluginCheckInput,
    ) => Promise<OpinionatedPluginStatusResult>;
    installOpinionatedPlugin: (
      input: OpinionatedPluginInstallInput,
    ) => Promise<OpinionatedPluginInstallResult>;
  };
  keybindings: {
    replaceCustom: (
      input: KeybindingsReplaceCustomInput,
    ) => Promise<KeybindingsReplaceCustomResult>;
  };
  mcp?: {
    listWorkspaces: () => Promise<McpListWorkspacesResult>;
    listServers: (input: McpListServersInput) => Promise<McpListServersResult>;
    upsertServer: (input: McpServerUpsertInput) => Promise<McpListServersResult>;
    setServerEnabled: (input: McpServerEnabledInput) => Promise<McpListServersResult>;
    removeServer: (input: McpServerRemoveInput) => Promise<McpListServersResult>;
    reloadServers: (input: McpServersReloadInput) => Promise<McpListServersResult>;
    startOauthLogin: (input: McpOauthLoginInput) => Promise<McpOauthLoginResult>;
  };
}

/**
 * Where a recoverable Git action stands, for the caller's notice. `started` says whether this
 * run can outlive its connection: the caller asked for it and the node supports it.
 * `reconnecting`: the connection dropped and the client waits to attach to the action again.
 * `reattached`: it follows the action again.
 */
export type GitActionRecoveryState =
  | { readonly kind: "started"; readonly recoverable: boolean }
  | { readonly kind: "reconnecting" }
  | { readonly kind: "reattached" };

export interface GitRunStackedActionOptions {
  readonly onProgress?: (event: GitActionProgressEvent) => void;
  /**
   * Keep the action running on the node when this connection drops, if the node supports it:
   * the client attaches to it again instead of failing. Off by default. Closing or reloading
   * the client then no longer stops the action, so only a caller that offers Stop
   * (`cancelStackedAction`) asks for it.
   */
  readonly recoverable?: boolean;
  readonly onRecoveryState?: (state: GitActionRecoveryState) => void;
}

/**
 * APIs bound to a specific backend environment connection.
 *
 * These operations must always be routed with explicit environment context.
 * They represent remote stateful capabilities such as orchestration, terminal,
 * project, VCS, and provider operations. In multi-environment mode, each environment gets
 * its own instance of this surface, and callers should resolve it by
 * `environmentId` rather than reaching through the local desktop bridge.
 */
export interface EnvironmentApi {
  attachments?: {
    readChunk: (input: ChatAttachmentReadChunkInput) => Promise<ChatAttachmentReadChunkResult>;
  };
  /** Node-scoped provider/settings operations, resolved by environment. */
  server?: {
    getConfig?: () => Promise<ServerConfig>;
    readCodexResetCredits?: (input: {
      instanceId: ProviderInstanceId;
    }) => Promise<CodexResetCreditAccount>;
    consumeCodexResetCredit?: (
      input: CodexResetCreditInput,
    ) => Promise<{ outcome: CodexResetCreditOutcome }>;
    readCliProxyHubs?: (
      input: import("./cliProxy.ts").CliProxyReadHubsInput,
    ) => Promise<import("./cliProxy.ts").CliProxyReadHubsResult>;
    testCliProxyHub?: (
      input: import("./cliProxy.ts").CliProxyTestHubInput,
    ) => Promise<import("./cliProxy.ts").CliProxyTestHubResult>;
    refreshProviders: (input?: {
      readonly instanceId?: ProviderInstanceId;
    }) => Promise<ServerProviderUpdatedPayload>;
    searchAcpRegistry?: (
      input: typeof AcpRegistrySearchInput.Type,
    ) => Promise<typeof AcpRegistrySearchResult.Type>;
    installAcpRegistry?: (input: AcpRegistryInstallInput) => Promise<AcpRegistryInstallation>;
    getAcpRegistryAuthMethods?: (
      input: AcpRegistryAuthInput,
    ) => Promise<readonly AcpRegistryAuthMethod[]>;
    authenticateAcpRegistry?: (
      input: AcpRegistryAuthenticateInput,
    ) => Promise<AcpRegistryAuthenticationResult>;
    updateProvider: (input: ServerProviderUpdateInput) => Promise<ServerProviderUpdatedPayload>;
    listLocalTasks?: (
      input: import("./localTasks.ts").LocalTaskListInput,
    ) => Promise<import("./localTasks.ts").LocalTaskListResult>;
    getLocalTask?: (input: { taskId: string }) => Promise<import("./localTasks.ts").LocalTask>;
    createLocalTask?: (
      input: import("./localTasks.ts").LocalTaskCreateInput,
    ) => Promise<import("./localTasks.ts").LocalTask>;
    updateLocalTask?: (
      input: import("./localTasks.ts").LocalTaskUpdateInput,
    ) => Promise<import("./localTasks.ts").LocalTask>;
    deleteLocalTask?: (
      input: import("./localTasks.ts").LocalTaskDeleteInput,
    ) => Promise<{ readonly deleted: true }>;
    delegateLocalTask?: (
      input: import("./localTasks.ts").LocalTaskDelegateInput,
    ) => Promise<import("./localTasks.ts").LocalTask>;
    createLocalTaskFileUpload?: (
      input: import("./localTasks.ts").LocalTaskFileUploadInput,
    ) => Promise<import("./orchestration.ts").FileAttachmentCreateUploadUrlResult>;
    addLocalTaskFile?: (
      input: import("./localTasks.ts").LocalTaskAddFileInput,
    ) => Promise<import("./localTasks.ts").LocalTask>;
    removeLocalTaskFile?: (
      input: import("./localTasks.ts").LocalTaskRemoveFileInput,
    ) => Promise<import("./localTasks.ts").LocalTask>;
    /** Each task that changes on the node from now on; returns the unsubscribe. */
    subscribeLocalTaskChanges?: (
      listener: (change: import("./localTasks.ts").LocalTaskChange) => void,
    ) => () => void;
    getDailyRecap?: (
      input: import("./dailyRecap.ts").DailyRecapRequest,
    ) => Promise<import("./dailyRecap.ts").DailyRecapSnapshot>;
    /** Absent on transports without it; call only when the server advertises the capability. */
    prewarmProviderSession?: (
      input: import("./provider.ts").ProviderSessionPrewarmInput,
    ) => Promise<import("./provider.ts").ProviderSessionPrewarmResult>;
    /** Absent on transports without it; call only when the server advertises the capability. */
    readProjectProviderCommands?: (
      input: import("./provider.ts").ProviderProjectCommandsInput,
    ) => Promise<import("./server.ts").ProviderProjectCommands>;
    getSettings: () => Promise<ServerSettings>;
    getProjectPreferences?: (input: {
      readonly projectId?: ProjectId;
    }) => Promise<EffectiveProjectPreferences>;
    updateSettings: (patch: ServerSettingsPatch) => Promise<ServerSettings>;
    upsertKeybinding: (input: ServerUpsertKeybindingInput) => Promise<ServerUpsertKeybindingResult>;
    getDiagnosticsSnapshot: () => Promise<DiagnosticsSnapshot>;
    getResourceTelemetryHistory?: (
      input: ResourceTelemetryHistoryInput,
    ) => Promise<ResourceTelemetryHistory>;
    retryResourceTelemetry?: () => Promise<ResourceTelemetrySnapshot>;
    signalDiagnosticProcess?: (
      input: DiagnosticsSignalProcessInput,
    ) => Promise<DiagnosticsSignalProcessResult>;
    /** `cached` accepts the server's recent result; an explicit refresh omits it. */
    discoverSourceControl: (input?: {
      readonly cached?: boolean;
    }) => Promise<SourceControlDiscoveryResult>;
    listOpinionatedPlugins: () => Promise<OpinionatedPluginListResult>;
    checkOpinionatedPlugins: (
      input?: OpinionatedPluginCheckInput,
    ) => Promise<OpinionatedPluginStatusResult>;
    installOpinionatedPlugin: (
      input: OpinionatedPluginInstallInput,
    ) => Promise<OpinionatedPluginInstallResult>;
  };
  keybindings?: {
    replaceCustom: (
      input: KeybindingsReplaceCustomInput,
    ) => Promise<KeybindingsReplaceCustomResult>;
  };
  device?: {
    list: (input?: DeviceListInput) => Promise<DeviceListResult>;
    getThreadState: (input: DeviceThreadInput) => Promise<ThreadDeviceState>;
    screenshot: (input: DeviceScreenshotInput) => Promise<DeviceScreenshotResult>;
    describeUi: (input: DeviceDescribeUiInput) => Promise<DeviceDescribeUiResult>;
    boot: (input: DeviceBootInput) => Promise<DeviceBootResult>;
    shutdown: (input: DeviceShutdownInput) => Promise<void>;
    attach: (input: DeviceAttachInput) => Promise<ThreadDeviceState>;
    detach: (input: DeviceDetachInput) => Promise<ThreadDeviceState>;
    tap: (input: DeviceTapInput) => Promise<void>;
    swipe: (input: DeviceSwipeInput) => Promise<void>;
    typeText: (input: DeviceTypeTextInput) => Promise<void>;
    keyEvent: (input: DeviceKeyEventInput) => Promise<void>;
    pressButton: (input: DevicePressButtonInput) => Promise<void>;
    scrollToElement: (input: DeviceScrollToElementInput) => Promise<DeviceScrollToElementResult>;
    installApp: (input: DeviceInstallAppInput) => Promise<DeviceInstallAppResult>;
    launchApp: (input: DeviceLaunchAppInput) => Promise<DeviceLaunchAppResult>;
    openUrl: (input: DeviceOpenUrlInput) => Promise<void>;
    testing: (input: DeviceTestingInput) => Promise<void>;
    startRecording: (input: DeviceStartRecordingInput) => Promise<DeviceStartRecordingResult>;
    stopRecording: (input: DeviceStopRecordingInput) => Promise<DeviceStopRecordingResult>;
    onEvent: (callback: (event: DeviceEvent) => void) => () => void;
  };
  terminal: {
    open: (input: typeof TerminalOpenInput.Encoded) => Promise<TerminalSessionSnapshot>;
    write: (input: typeof TerminalWriteInput.Encoded) => Promise<void>;
    resize: (input: typeof TerminalResizeInput.Encoded) => Promise<void>;
    clear: (input: typeof TerminalClearInput.Encoded) => Promise<void>;
    restart: (input: typeof TerminalRestartInput.Encoded) => Promise<TerminalSessionSnapshot>;
    close: (input: typeof TerminalCloseInput.Encoded) => Promise<void>;
    onEvent: (callback: (event: TerminalEvent) => void) => () => void;
  };
  projects: {
    listEntries: (input: ProjectListEntriesInput) => Promise<ProjectListEntriesResult>;
    readFile: (input: ProjectReadFileInput) => Promise<ProjectReadFileResult>;
    readIcon: (input: ProjectReadIconInput) => Promise<ProjectReadIconResult>;
    readFileBinary: (input: ProjectReadFileBinaryInput) => Promise<ProjectReadFileBinaryResult>;
    /**
     * PDFs and raster images in bounded chunks (`projects.readFileChunk`). Optional so
     * test fakes need not supply it; clients call it only when the node's config
     * advertises `projectReadFileChunk`.
     */
    readFileChunk?: (input: ProjectReadFileChunkInput) => Promise<ProjectReadFileChunkResult>;
    /**
     * Notices when one file changes on disk (`projects.subscribeFileChanges`), never its
     * content. Optional so test fakes need not supply it; clients call it only when the node's
     * config advertises `projectFileWatch`. `onError`: the stream stopped for good, after
     * `classifyFailure` saw the failure.
     */
    subscribeFileChanges?: (
      input: ProjectWatchFileInput,
      callback: (event: ProjectFileChangeEvent) => void,
      options?: {
        onError?: () => void;
        classifyFailure?: (error: unknown) => "unsupported" | "response-too-large" | "failed";
      },
    ) => () => void;
    searchEntries: (input: ProjectSearchEntriesInput) => Promise<ProjectSearchEntriesResult>;
    /**
     * Only for nodes that advertise `projectContentSearch`. Aborting `signal` withdraws the
     * request, and the node stops searching.
     */
    searchContent: (
      input: ProjectSearchContentInput,
      options?: { readonly signal?: AbortSignal | undefined },
    ) => Promise<ProjectSearchContentResult>;
    writeFile: (input: ProjectWriteFileInput) => Promise<ProjectWriteFileResult>;
    stageFileReference: (
      input: ProjectStageFileReferenceInput,
    ) => Promise<ProjectStageFileReferenceResult>;
    initializeGit?: (input: ProjectsInitializeGitInput) => Promise<EmptyRpcResult>;
    promoteChatPreview?: (
      input: ProjectsPromoteChatPreviewInput,
    ) => Promise<ProjectsPromoteChatPreviewResult>;
    promoteChat?: (input: ProjectsPromoteChatInput) => Promise<ProjectsPromoteChatResult>;
    deleteChatFolder?: (
      input: ProjectsDeleteChatFolderInput,
    ) => Promise<ProjectsDeleteChatFolderResult>;
  };
  filesystem: {
    browse: (input: FilesystemBrowseInput) => Promise<FilesystemBrowseResult>;
  };
  sourceControl: {
    lookupRepository: (
      input: SourceControlRepositoryLookupInput,
    ) => Promise<SourceControlRepositoryInfo>;
    searchRepositories: (
      input: SourceControlRepositorySearchInput,
    ) => Promise<SourceControlRepositorySearchResult>;
    cloneRepository: (
      input: SourceControlCloneRepositoryInput,
    ) => Promise<SourceControlCloneRepositoryResult>;
    publishRepository: (
      input: SourceControlPublishRepositoryInput,
    ) => Promise<SourceControlPublishRepositoryResult>;
    /**
     * Auto-fix CI and the pull request watch of a thread. Every RPC-backed API has it;
     * optional so hand-built test doubles may leave it out (callers treat absence as offline).
     */
    setPullRequestWatch?: (
      input: SourceControlSetPullRequestWatchInput,
    ) => Promise<SourceControlSetPullRequestWatchResult>;
    /** Optional: older shapes and test doubles lack it; gate on `changeRequestTemplates`. */
    listChangeRequestTemplates?: (
      input: ChangeRequestTemplateListInput,
    ) => Promise<ChangeRequestTemplateListResult>;
  };
  vcs: {
    readLineBlame: (input: GitReadLineBlameInput) => Promise<GitReadLineBlameResult>;
    readImageBlob: (input: GitReadImageBlobInput) => Promise<GitReadImageBlobResult>;
    readLocalChanges: (input: GitLocalChangesInput) => Promise<GitLocalChangesResult>;
    applyIndexPatch: (input: GitApplyIndexPatchInput) => Promise<void>;
    readComparison: (input: GitReadComparisonInput) => Promise<GitReadComparisonResult>;
    listRefs: (input: VcsListRefsInput) => Promise<VcsListRefsResult>;
    /** Absent on clients built without it; older servers answer "Unknown request tag". */
    prefetchWorktreeBase?: (input: VcsPrefetchWorktreeBaseInput) => Promise<void>;
    /**
     * Live progress of the worktree a first send prepares. Absent on clients
     * built without it; older servers end the stream at once (`onError`).
     */
    onWorktreeSetup?: (
      input: WorktreeSetupSubscribeInput,
      callback: (snapshot: WorktreeSetupSnapshot) => void,
      options?: {
        onError?: () => void;
      },
    ) => () => void;
    /** Stops a worktree setup before its turn starts. */
    cancelWorktreeSetup?: (input: WorktreeSetupCancelInput) => Promise<WorktreeSetupCancelResult>;
    createWorktree: (input: VcsCreateWorktreeInput) => Promise<VcsCreateWorktreeResult>;
    removeWorktree: (input: VcsRemoveWorktreeInput) => Promise<void>;
    createRef: (input: VcsCreateRefInput) => Promise<VcsCreateRefResult>;
    switchRef: (input: VcsSwitchRefInput) => Promise<VcsSwitchRefResult>;
    init: (input: VcsInitInput) => Promise<void>;
    pull: (input: VcsPullInput) => Promise<VcsPullResult>;
    refreshStatus: (input: VcsStatusInput) => Promise<VcsStatusResult>;
    onStatus: (
      input: VcsStatusInput,
      callback: (status: VcsStatusResult) => void,
      options?: {
        onResubscribe?: () => void;
      },
    ) => () => void;
  };
  git: {
    runStackedAction: (
      input: GitRunStackedActionInput,
      options?: GitRunStackedActionOptions,
    ) => Promise<GitRunStackedActionResult>;
    /**
     * Stops a running recoverable action. `cancelled: false` when no running action of this
     * client has the id. Absent on clients that predate recoverable actions.
     */
    cancelStackedAction?: (
      input: GitCancelStackedActionInput,
    ) => Promise<GitCancelStackedActionResult>;
    resolvePullRequest: (input: GitPullRequestRefInput) => Promise<GitResolvePullRequestResult>;
    preparePullRequestThread: (
      input: GitPreparePullRequestThreadInput,
    ) => Promise<GitPreparePullRequestThreadResult>;
    createWorktreeForProject?: (
      input: GitCreateWorktreeForProjectInput,
    ) => Promise<GitCreateWorktreeForProjectOutput>;
    findWorktreeForOrigin?: (
      input: GitFindWorktreeForOriginInput,
    ) => Promise<GitFindWorktreeForOriginOutput>;
    archiveWorktree?: (input: GitArchiveWorktreeInput) => Promise<EmptyRpcResult>;
    restoreWorktree?: (input: GitRestoreWorktreeInput) => Promise<EmptyRpcResult>;
    deleteWorktree?: (input: GitDeleteWorktreeInput) => Promise<EmptyRpcResult>;
  };
  /** One server-side lifecycle authority; absent on servers that predate it. */
  lifecycle?: {
    listWorkspaces: (
      input: WorkspaceLifecycleListInputType,
    ) => Promise<ReadonlyArray<WorkspaceLifecycleSummary>>;
    previewWorkspace: (input: WorkspaceLifecycleRequest) => Promise<WorkspaceLifecyclePreview>;
    applyWorkspace: (input: WorkspaceLifecycleApplyInput) => Promise<WorkspaceLifecycleResult>;
    suggestions: (input: Record<string, never>) => Promise<LifecycleSuggestions>;
    listTrash: (input: Record<string, never>) => Promise<TrashListResult>;
    /** Optional so clients can feature-detect against older environments. */
    diskUsage?: (input: WorkspaceDiskUsageInput) => Promise<WorkspaceDiskUsageResult>;
    /** Optional so clients can feature-detect against older environments. */
    summarizeChanges?: (
      input: WorkspaceChangesSummaryInput,
    ) => Promise<WorkspaceChangesSummaryResult>;
  };
  worktrees?: {
    setManualPosition: (input: WorktreesSetManualPositionInput) => Promise<EmptyRpcResult>;
  };
  threads?: {
    setManualBucket: (input: ThreadsSetManualBucketInput) => Promise<EmptyRpcResult>;
    setManualPosition: (input: ThreadsSetManualPositionInput) => Promise<EmptyRpcResult>;
    /** Optional so clients can feature-detect against older environments. */
    fork?: (input: ThreadForkInput) => Promise<ThreadForkResult>;
    /**
     * The servers a thread started (`threads.subscribeLocalServers`), current list first. Clients
     * call it only when the node's config advertises `threadLocalServers`; `watchThreadLocalServers`
     * shares one subscription per thread. `onError`: the stream stopped for good.
     */
    subscribeLocalServers?: (
      input: ThreadSubscribeLocalServersInput,
      callback: (list: ThreadLocalServerList) => void,
      options?: { onError?: () => void },
    ) => () => void;
    /** Only for nodes that advertise `threadLocalServerStop`. */
    stopLocalServer?: (input: ThreadStopLocalServerInput) => Promise<ThreadStopLocalServerResult>;
  };
  orchestration: {
    dispatchCommand: (command: ClientOrchestrationCommand) => Promise<{ sequence: number }>;
    /** Optional so clients can feature-detect against older environments. */
    getWorkflowScript?: (
      input: OrchestrationGetWorkflowScriptInput,
    ) => Promise<OrchestrationGetWorkflowScriptResult>;
    /** Optional so clients can feature-detect against older environments. */
    getTaskOutput?: (
      input: OrchestrationGetTaskOutputInput,
    ) => Promise<OrchestrationGetTaskOutputResult>;
    /** Optional so clients can feature-detect against older environments. */
    stopBackgroundTask?: (
      input: OrchestrationStopBackgroundTaskInput,
    ) => Promise<OrchestrationStopBackgroundTaskResult>;
    /** Optional so clients can feature-detect against older environments. */
    messageBackgroundTask?: (
      input: OrchestrationMessageBackgroundTaskInput,
    ) => Promise<OrchestrationMessageBackgroundTaskResult>;
    getTurnDiff: (input: OrchestrationGetTurnDiffInput) => Promise<OrchestrationGetTurnDiffResult>;
    getFullThreadDiff: (
      input: OrchestrationGetFullThreadDiffInput,
    ) => Promise<OrchestrationGetFullThreadDiffResult>;
    searchThreadMessages: (
      input: OrchestrationSearchThreadMessagesInput,
    ) => Promise<OrchestrationSearchThreadMessagesResult>;
    /** Optional so clients can feature-detect against older environments. */
    getThreadWindow?: (
      input: OrchestrationGetThreadWindowInput,
    ) => Promise<OrchestrationThreadWindowSnapshot>;
    /** Optional so clients can feature-detect against older environments. */
    getThreadShells?: (
      input: OrchestrationGetThreadShellsInput,
    ) => Promise<OrchestrationGetThreadShellsResult>;
    /** Optional so clients can feature-detect against older environments. */
    getThreadHistoryPage?: (
      input: OrchestrationGetThreadHistoryPageInput,
    ) => Promise<OrchestrationThreadHistoryPage>;
    /** Optional so clients can feature-detect against older environments. */
    getActivityPayload?: (
      input: OrchestrationGetActivityPayloadInput,
    ) => Promise<OrchestrationGetActivityPayloadResult>;
    replayEvents?: (
      input: OrchestrationReplayEventsInput,
    ) => Promise<OrchestrationReplayEventsResult>;
    replayEventsPage?: (
      input: OrchestrationReplayEventsPageInput,
    ) => Promise<OrchestrationReplayEventsPageResult>;
    subscribeShell: (
      callback: (event: OrchestrationShellSubscriptionItem) => void,
      options?: {
        onResubscribe?: () => void;
      },
    ) => () => void;
    subscribeThread: (
      input: OrchestrationSubscribeThreadInput,
      callback: (event: OrchestrationThreadStreamItem) => void,
      options?: {
        onResubscribe?: () => void;
      },
    ) => () => void;
    /** Optional so clients can feature-detect against older environments. */
    subscribeThreadWindow?: (
      input: OrchestrationGetThreadWindowInput,
      callback: (event: OrchestrationThreadWindowStreamItem) => void,
      options?: {
        onResubscribe?: () => void;
        onError?: () => void;
      },
    ) => () => void;
  };
  contextHandoff: {
    getInspectionSummary: (
      input: ContextHandoffInspectionSummaryInput,
    ) => Promise<ContextHandoffInspectionSummary>;
    listInspectionEntries: (
      input: ContextHandoffInspectionEntriesInput,
    ) => Promise<ContextHandoffInspectionEntriesPage>;
    readRawPayloadChunk: (
      input: ContextHandoffRawPayloadChunkInput,
    ) => Promise<ContextHandoffRawPayloadChunk>;
    readExportChunk: (input: ContextHandoffExportChunkInput) => Promise<ContextHandoffExportChunk>;
  };
  /** Provider-native MCP configuration for this environment. */
  mcp?: {
    listWorkspaces: () => Promise<McpListWorkspacesResult>;
    listServers: (input: McpListServersInput) => Promise<McpListServersResult>;
    upsertServer: (input: McpServerUpsertInput) => Promise<McpListServersResult>;
    setServerEnabled: (input: McpServerEnabledInput) => Promise<McpListServersResult>;
    removeServer: (input: McpServerRemoveInput) => Promise<McpListServersResult>;
    reloadServers: (input: McpServersReloadInput) => Promise<McpListServersResult>;
    startOauthLogin: (input: McpOauthLoginInput) => Promise<McpOauthLoginResult>;
  };
  /**
   * Agent Control approval surface. Optional as a whole so clients can
   * feature-detect against environments predating Agent Control.
   */
  automationCentre?: AutomationCentreApi;
  /** Server-owned worktree notes. Optional so clients can feature-detect older environments. */
  notes?: NotesApi;
  agentControl?: {
    listProposals: (input: AgentControlListProposalsInput) => Promise<AgentControlProposalQueue>;
    getProposal: (input: AgentControlGetProposalInput) => Promise<AgentControlGetProposalResult>;
    acceptProposal: (
      input: AgentControlDecideProposalInput,
    ) => Promise<AgentControlProposalReceipt>;
    rejectProposal: (
      input: AgentControlDecideProposalInput,
    ) => Promise<AgentControlProposalReceipt>;
    subscribeProposals: (
      callback: (event: AgentControlProposalStreamEvent) => void,
      options?: {
        onResubscribe?: () => void;
        onError?: () => void;
      },
    ) => () => void;
    listIntegrations: () => Promise<AgentControlExternalIntegrationListResult>;
    createIntegration: (
      input: AgentControlExternalIntegrationCreateInput,
    ) => Promise<AgentControlExternalPairingResult>;
    updateIntegration: (
      input: AgentControlExternalIntegrationUpdateInput,
    ) => Promise<AgentControlExternalIntegrationMutationResult>;
    resumeIntegrationPairing: (
      input: AgentControlExternalIntegrationIdInput,
    ) => Promise<AgentControlExternalPairingResult>;
    revokeIntegration: (
      input: AgentControlExternalIntegrationIdInput,
    ) => Promise<AgentControlExternalIntegrationMutationResult>;
    deleteIntegration: (
      input: AgentControlExternalIntegrationIdInput,
    ) => Promise<AgentControlExternalIntegrationDeleteResult>;
    listMcpInstallations: () => Promise<AgentControlMcpInstallationListResult>;
    connectMcpInstallation: (
      input: AgentControlMcpInstallationConnectInput,
    ) => Promise<AgentControlMcpInstallationMutationResult>;
    repairMcpInstallation: (
      input: AgentControlMcpInstallationIdInput,
    ) => Promise<AgentControlMcpInstallationMutationResult>;
    disconnectMcpInstallation: (
      input: AgentControlMcpInstallationIdInput,
    ) => Promise<AgentControlMcpInstallationMutationResult>;
  };
}
