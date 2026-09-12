import {
  ResourceTelemetrySnapshot,
  ResourceTelemetryHistoryInput,
  ResourceTelemetryHistory,
} from "./resourceTelemetry.ts";
import { Schema } from "effect";
import * as Rpc from "effect/unstable/rpc/Rpc";
import * as RpcGroup from "effect/unstable/rpc/RpcGroup";

import { OpenError, OpenInEditorInput } from "./editor.ts";
import {
  AGENT_CONTROL_WS_METHODS,
  AgentControlDecideProposalInput,
  AgentControlGetProposalInput,
  AgentControlGetProposalResult,
  AgentControlListProposalsInput,
  AgentControlProposalQueue,
  AgentControlProposalReceipt,
  AgentControlProposalStreamEvent,
  AgentControlRpcError,
  AgentControlExternalIntegrationCreateInput,
  AgentControlExternalIntegrationDeleteResult,
  AgentControlExternalIntegrationIdInput,
  AgentControlExternalIntegrationListResult,
  AgentControlExternalIntegrationMutationResult,
  AgentControlExternalIntegrationUpdateInput,
  AgentControlExternalPairingResult,
  AgentControlExternalRpcError,
  AgentControlMcpInstallationConnectInput,
  AgentControlMcpInstallationIdInput,
  AgentControlMcpInstallationListResult,
  AgentControlMcpInstallationMutationResult,
} from "./agentControl.ts";
import { AuthAccessStreamEvent, AuthRpcError } from "./auth.ts";
import {
  DiagnosticsError,
  DiagnosticsSnapshot,
  DiagnosticsSignalProcessInput,
  DiagnosticsSignalProcessResult,
} from "./diagnostics.ts";
import { StatisticsSnapshot } from "./statistics.ts";
import { UsageReadError, UsageSummary, UsageSummaryRequest } from "./usage.ts";
import { AdvertisedEndpoint } from "./remoteAccess.ts";
import {
  AtlassianConnectionError,
  AtlassianConnectionSummary,
  AtlassianDisconnectInput,
  AtlassianGetProjectLinkInput,
  AtlassianListResourcesInput,
  AtlassianProjectLink,
  AtlassianRefreshInput,
  AtlassianResourceSummary,
  AtlassianSaveManualBitbucketTokenInput,
  AtlassianSaveManualJiraTokenInput,
  AtlassianSaveProjectLinkInput,
  AtlassianStartOAuthInput,
  AtlassianStartOAuthResult,
} from "./atlassian.ts";
import { ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import {
  DEVICE_WS_METHODS,
  DeviceAppRequest,
  DeviceAppResponse,
  DeviceEvent,
  DeviceInputRequest,
  DeviceInputResponse,
  DeviceLifecycleRequest,
  DeviceLifecycleResponse,
  DeviceReadRequest,
  DeviceReadResponse,
  DeviceRecordingRequest,
  DeviceRecordingResponse,
  DeviceRpcError,
} from "./device.ts";
import {
  FilesystemBrowseInput,
  FilesystemBrowseResult,
  FilesystemBrowseError,
} from "./filesystem.ts";
import {
  GitActionProgressEvent,
  VcsSwitchRefInput,
  VcsSwitchRefResult,
  GitCommandError,
  VcsCreateRefInput,
  VcsCreateRefResult,
  VcsCreateWorktreeInput,
  VcsCreateWorktreeResult,
  VcsInitInput,
  VcsListRefsInput,
  VcsListRefsResult,
  GitManagerServiceError,
  GitPreparePullRequestThreadInput,
  GitPreparePullRequestThreadResult,
  VcsPullInput,
  GitPullRequestRefInput,
  VcsPullResult,
  VcsRemoveWorktreeInput,
  GitResolvePullRequestResult,
  GitRunStackedActionInput,
  VcsStatusInput,
  VcsStatusResult,
  VcsStatusStreamEvent,
  TextGenerationError,
} from "./git.ts";
import { KeybindingsConfigError } from "./keybindings.ts";
import {
  McpListServersInput,
  McpListServersResult,
  McpListWorkspacesResult,
  McpOauthLoginInput,
  McpOauthLoginResult,
  McpServerEnabledInput,
  McpServerRemoveInput,
  McpServerUpsertInput,
  McpServersReloadInput,
  McpSettingsError,
} from "./mcp.ts";
import {
  OpinionatedPluginCheckInput,
  OpinionatedPluginError,
  OpinionatedPluginInstallInput,
  OpinionatedPluginInstallResult,
  OpinionatedPluginListResult,
  OpinionatedPluginStatusResult,
} from "./opinionatedPlugins.ts";
import {
  ClientOrchestrationCommand,
  CONTEXT_HANDOFF_WS_METHODS,
  ContextHandoffExportChunk,
  ContextHandoffExportChunkInput,
  ContextHandoffInspectionEntriesInput,
  ContextHandoffInspectionEntriesPage,
  ContextHandoffInspectionError,
  ContextHandoffInspectionSummary,
  ContextHandoffInspectionSummaryInput,
  ContextHandoffRawPayloadChunk,
  ContextHandoffRawPayloadChunkInput,
  FileAttachmentCreateUploadUrlError,
  ChatAttachmentReadChunkInput,
  ChatAttachmentReadChunkResult,
  ChatAttachmentReadError,
  FileAttachmentCreateUploadUrlInput,
  FileAttachmentCreateUploadUrlResult,
  ORCHESTRATION_WS_METHODS,
  OrchestrationDispatchCommandError,
  OrchestrationGetTaskOutputError,
  OrchestrationGetWorkflowScriptError,
  OrchestrationStopBackgroundTaskError,
  OrchestrationGetFullThreadDiffError,
  OrchestrationGetFullThreadDiffInput,
  OrchestrationGetSnapshotError,
  OrchestrationSearchThreadMessagesInput,
  OrchestrationThreadHistoryError,
  OrchestrationGetTurnDiffError,
  OrchestrationGetTurnDiffInput,
  OrchestrationReplayEventsError,
  OrchestrationReplayEventsInput,
  OrchestrationReplayEventsPageInput,
  OrchestrationRpcSchemas,
} from "./orchestration.ts";
import { ProviderInstanceId } from "./providerInstance.ts";
import {
  ProjectListEntriesError,
  ProjectListEntriesInput,
  ProjectListEntriesResult,
  ProjectReadFileBinaryError,
  ProjectReadIconInput,
  ProjectReadIconResult,
  ProjectReadIconError,
  ProjectReadFileBinaryInput,
  ProjectReadFileBinaryResult,
  ProjectReadFileError,
  ProjectReadFileInput,
  ProjectReadFileResult,
  ProjectSearchEntriesError,
  ProjectSearchEntriesInput,
  ProjectSearchEntriesResult,
  ProjectStageFileReferenceError,
  ProjectStageFileReferenceInput,
  ProjectStageFileReferenceResult,
  ProjectWriteFileError,
  ProjectWriteFileInput,
  ProjectWriteFileResult,
} from "./project.ts";
import {
  TerminalClearInput,
  TerminalCloseInput,
  TerminalError,
  TerminalEvent,
  TerminalOpenInput,
  TerminalResizeInput,
  TerminalRestartInput,
  TerminalSessionSnapshot,
  TerminalSubscriptionResyncError,
  TerminalWriteInput,
} from "./terminal.ts";
import {
  ServerConfigStreamEvent,
  ServerConfig,
  ServerLocalDiagnosticsMetrics,
  ServerProviderUpdateError,
  ServerProviderUpdateInput,
  ServerLifecycleStreamEvent,
  ServerProviderUpdatedPayload,
  ServerUpsertKeybindingInput,
  ServerUpsertKeybindingResult,
  KeybindingsReplaceCustomInput,
  KeybindingsReplaceCustomResult,
} from "./server.ts";
import { ServerSettings, ServerSettingsError, ServerSettingsPatch } from "./settings.ts";
import {
  ThreadPriorityEnsureCurrentInput,
  ThreadPriorityEnsureCurrentResult,
  ThreadPriorityRpcError,
} from "./threadPriority.ts";
import {
  SourceControlGetChangeRequestFilesViewedInput,
  SourceControlChangeRequestFilesViewed,
  SourceControlSetChangeRequestFileViewedInput,
  SourceControlSetChangeRequestFileViewedResult,
  SourceControlCloneRepositoryInput,
  SourceControlCloneRepositoryResult,
  SourceControlDiscoveryResult,
  SourceControlPublishRepositoryInput,
  SourceControlPublishRepositoryResult,
  SourceControlRepositoryError,
  SourceControlRepositoryInfo,
  SourceControlRepositoryLookupInput,
  SourceControlRepositorySearchInput,
  SourceControlRepositorySearchResult,
  ChangeRequest,
  SourceControlChangeRequestDetail,
  SourceControlIssueDetail,
  SourceControlIssueSummary,
  SourceControlProviderError,
  SourceControlAssigneeCandidate,
  SourceControlAddChangeRequestCommentInput,
  SourceControlAddChangeRequestCommentResult,
  SourceControlAddChangeRequestCommentReactionResult,
  SourceControlAddCommentReactionInput,
  SourceControlAddIssueCommentInput,
  SourceControlAddIssueCommentResult,
  SourceControlAddIssueCommentReactionResult,
  SourceControlCreateIssueInput,
  SourceControlLabel,
  SourceControlMergeChangeRequestInput,
  SourceControlMergeChangeRequestResult,
  SourceControlWorkflowJobLogInput,
  SourceControlWorkflowJobLogResult,
  SourceControlWorkflowRerunInput,
  SourceControlWorkflowRerunResult,
  SourceControlWorkflowRunJobsInput,
  SourceControlWorkflowRunJobsResult,
  SourceControlWorkflowRunListInput,
  SourceControlWorkflowRunListResult,
} from "./sourceControl.ts";
import { VcsError } from "./vcs.ts";
import {
  WorkItemAddCommentInput,
  WorkItemEditCommentInput,
  WorkItemDetail,
  WorkItemGetInput,
  WorkItemListInput,
  WorkItemListProjectsInput,
  WorkItemListTransitionsInput,
  WorkItemProject,
  WorkItemProviderKind,
  WorkItemProviderError,
  WorkItemSearchInput,
  WorkItemSummary,
  WorkItemTransition,
  WorkItemTransitionInput,
  WorkItemUpdateInput,
} from "./workItems.ts";
import {
  CreateWorktreeIntent,
  StatusBucket,
  WorktreeCheckoutLocation,
  WorktreeId,
} from "./worktree.ts";

export const WS_METHODS = {
  // Project registry methods
  projectsList: "projects.list",
  projectsAdd: "projects.add",
  projectsRemove: "projects.remove",
  projectsListEntries: "projects.listEntries",
  projectsSearchEntries: "projects.searchEntries",
  projectsReadFile: "projects.readFile",
  projectsReadIcon: "projects.readIcon",
  projectsReadFileBinary: "projects.readFileBinary",
  projectsWriteFile: "projects.writeFile",
  projectsStageFileReference: "projects.stageFileReference",

  // Chat attachment methods
  chatAttachmentsCreateFileUpload: "chatAttachments.createFileUpload",
  chatAttachmentsReadChunk: "chatAttachments.readChunk",

  // Shell methods
  shellOpenInEditor: "shell.openInEditor",

  // Filesystem methods
  filesystemBrowse: "filesystem.browse",

  // VCS methods
  vcsPull: "vcs.pull",
  vcsRefreshStatus: "vcs.refreshStatus",
  vcsListRefs: "vcs.listRefs",
  vcsCreateWorktree: "vcs.createWorktree",
  vcsRemoveWorktree: "vcs.removeWorktree",
  vcsCreateRef: "vcs.createRef",
  vcsSwitchRef: "vcs.switchRef",
  vcsInit: "vcs.init",

  // Git workflow methods
  gitRunStackedAction: "git.runStackedAction",
  gitResolvePullRequest: "git.resolvePullRequest",
  gitPreparePullRequestThread: "git.preparePullRequestThread",
  gitCreateWorktreeForProject: "git.createWorktreeForProject",
  gitFindWorktreeForOrigin: "git.findWorktreeForOrigin",
  gitArchiveWorktree: "git.archiveWorktree",
  gitRestoreWorktree: "git.restoreWorktree",
  gitDeleteWorktree: "git.deleteWorktree",

  // Sidebar hierarchy methods
  threadsSetManualBucket: "threads.setManualBucket",
  threadsSetManualPosition: "threads.setManualPosition",
  worktreesSetManualPosition: "worktrees.setManualPosition",
  projectsInitializeGit: "projects.initializeGit",

  // Thread search methods
  searchThreadMessages: "threads.searchMessages",
  threadPriorityEnsureCurrent: "threadPriority.ensureCurrent",

  // Terminal methods
  terminalOpen: "terminal.open",
  terminalWrite: "terminal.write",
  terminalResize: "terminal.resize",
  terminalClear: "terminal.clear",
  terminalRestart: "terminal.restart",
  terminalClose: "terminal.close",

  // Server meta
  serverGetConfig: "server.getConfig",
  serverGetAdvertisedEndpoints: "server.getAdvertisedEndpoints",
  serverGetDiagnosticsMetrics: "server.getDiagnosticsMetrics",
  serverRefreshProviders: "server.refreshProviders",
  serverUpdateProvider: "server.updateProvider",
  serverUpsertKeybinding: "server.upsertKeybinding",
  keybindingsReplaceCustom: "keybindings.replaceCustom",
  serverGetSettings: "server.getSettings",
  serverUpdateSettings: "server.updateSettings",
  serverDiscoverSourceControl: "server.discoverSourceControl",
  serverListOpinionatedPlugins: "server.listOpinionatedPlugins",
  serverCheckOpinionatedPlugins: "server.checkOpinionatedPlugins",
  serverInstallOpinionatedPlugin: "server.installOpinionatedPlugin",
  serverGetDiagnosticsSnapshot: "server.getDiagnosticsSnapshot",
  serverGetResourceTelemetryHistory: "server.getResourceTelemetryHistory",
  serverRetryResourceTelemetry: "server.retryResourceTelemetry",
  serverSignalDiagnosticProcess: "server.signalDiagnosticProcess",
  serverGetStatistics: "server.getStatistics",
  serverGetUsageSummary: "server.getUsageSummary",

  // MCP settings methods
  mcpListWorkspaces: "mcp.listWorkspaces",
  mcpListServers: "mcp.listServers",
  mcpUpsertServer: "mcp.upsertServer",
  mcpSetServerEnabled: "mcp.setServerEnabled",
  mcpRemoveServer: "mcp.removeServer",
  mcpReloadServers: "mcp.reloadServers",
  mcpStartOauthLogin: "mcp.startOauthLogin",

  // Source control methods
  sourceControlLookupRepository: "sourceControl.lookupRepository",
  sourceControlSearchRepositories: "sourceControl.searchRepositories",
  sourceControlCloneRepository: "sourceControl.cloneRepository",
  sourceControlPublishRepository: "sourceControl.publishRepository",
  sourceControlListIssues: "sourceControl.listIssues",
  sourceControlGetIssue: "sourceControl.getIssue",
  sourceControlSearchIssues: "sourceControl.searchIssues",
  sourceControlListChangeRequests: "sourceControl.listChangeRequests",
  sourceControlSearchChangeRequests: "sourceControl.searchChangeRequests",
  sourceControlGetChangeRequestDetail: "sourceControl.getChangeRequestDetail",
  sourceControlGetChangeRequestFilesViewed: "sourceControl.getChangeRequestFilesViewed",
  sourceControlSetChangeRequestFileViewed: "sourceControl.setChangeRequestFileViewed",
  sourceControlGetChangeRequestDiff: "sourceControl.getChangeRequestDiff",
  sourceControlMergeChangeRequest: "sourceControl.mergeChangeRequest",
  sourceControlCreateIssue: "sourceControl.createIssue",
  sourceControlAddIssueComment: "sourceControl.addIssueComment",
  sourceControlAddIssueCommentReaction: "sourceControl.addIssueCommentReaction",
  sourceControlAddChangeRequestComment: "sourceControl.addChangeRequestComment",
  sourceControlAddChangeRequestCommentReaction: "sourceControl.addChangeRequestCommentReaction",
  sourceControlListIssueLabels: "sourceControl.listIssueLabels",
  sourceControlListIssueAssignees: "sourceControl.listIssueAssignees",
  sourceControlListWorkflowRuns: "sourceControl.listWorkflowRuns",
  sourceControlGetWorkflowRunJobs: "sourceControl.getWorkflowRunJobs",
  sourceControlGetWorkflowJobLog: "sourceControl.getWorkflowJobLog",
  sourceControlRerunWorkflow: "sourceControl.rerunWorkflow",

  // Text generation methods
  textGenerationGenerateIssueContent: "textGeneration.generateIssueContent",
  textGenerationGenerateBranchName: "textGeneration.generateBranchName",

  // Atlassian connection methods
  atlassianListConnections: "atlassian.listConnections",
  atlassianStartOAuth: "atlassian.startOAuth",
  atlassianDisconnect: "atlassian.disconnect",
  atlassianRefresh: "atlassian.refresh",
  atlassianListResources: "atlassian.listResources",
  atlassianGetProjectLink: "atlassian.getProjectLink",
  atlassianSaveProjectLink: "atlassian.saveProjectLink",
  atlassianSaveManualBitbucketToken: "atlassian.saveManualBitbucketToken",
  atlassianSaveManualJiraToken: "atlassian.saveManualJiraToken",

  // Work item methods
  workItemsListProjects: "workItems.listProjects",
  workItemsList: "workItems.list",
  workItemsSearch: "workItems.search",
  workItemsGet: "workItems.get",
  workItemsAddComment: "workItems.addComment",
  workItemsEditComment: "workItems.editComment",
  workItemsUpdate: "workItems.update",
  workItemsListTransitions: "workItems.listTransitions",
  workItemsTransition: "workItems.transition",

  // Streaming subscriptions
  subscribeVcsStatus: "subscribeVcsStatus",
  subscribeTerminalEvents: "subscribeTerminalEvents",
  subscribeServerConfig: "subscribeServerConfig",
  subscribeServerLifecycle: "subscribeServerLifecycle",
  subscribeAuthAccess: "subscribeAuthAccess",
} as const;

export const GitCreateWorktreeForProjectInput = Schema.Struct({
  fetchOrigin: Schema.optional(Schema.Boolean),
  projectId: ProjectId,
  intent: CreateWorktreeIntent,
  // "projectMetadata" preserves the legacy project-local checkout location.
  // New worktrees should use the default app-managed location.
  worktreeLocation: Schema.optional(WorktreeCheckoutLocation),
});
export type GitCreateWorktreeForProjectInput = typeof GitCreateWorktreeForProjectInput.Type;

export const GitCreateWorktreeForProjectOutput = Schema.Struct({
  worktreeId: WorktreeId,
  sessionId: ThreadId,
});
export type GitCreateWorktreeForProjectOutput = typeof GitCreateWorktreeForProjectOutput.Type;

export const SourceControlCreateIssueWithWorktreeResult = Schema.Struct({
  issue: SourceControlIssueSummary,
  worktree: Schema.optional(GitCreateWorktreeForProjectOutput),
  worktreeError: Schema.optional(Schema.String),
});
export type SourceControlCreateIssueWithWorktreeResult =
  typeof SourceControlCreateIssueWithWorktreeResult.Type;

export const TextGenerationIssueContentMode = Schema.Literals(["polish", "title"]);
export type TextGenerationIssueContentMode = typeof TextGenerationIssueContentMode.Type;

export const TextGenerationIssueContentInput = Schema.Struct({
  cwd: Schema.String,
  mode: TextGenerationIssueContentMode,
  rough: Schema.optional(Schema.String),
  body: Schema.optional(Schema.String),
  currentTitle: Schema.optional(Schema.String),
  customInstructions: Schema.optional(Schema.String),
});
export type TextGenerationIssueContentInput = typeof TextGenerationIssueContentInput.Type;

export const TextGenerationIssueContentResult = Schema.Struct({
  title: Schema.optional(Schema.String),
  body: Schema.optional(Schema.String),
});
export type TextGenerationIssueContentResult = typeof TextGenerationIssueContentResult.Type;

export const TextGenerationBranchNameInput = Schema.Struct({
  cwd: Schema.String,
  message: Schema.String,
});
export type TextGenerationBranchNameInput = typeof TextGenerationBranchNameInput.Type;

export const TextGenerationBranchNameResult = Schema.Struct({
  branch: Schema.String,
});
export type TextGenerationBranchNameResult = typeof TextGenerationBranchNameResult.Type;

export const GitFindWorktreeForOriginInput = Schema.Union([
  Schema.Struct({
    projectId: ProjectId,
    kind: Schema.Literals(["pr", "issue"]),
    number: Schema.Number,
  }),
  Schema.Struct({
    projectId: ProjectId,
    kind: Schema.Literal("workItem"),
    provider: WorkItemProviderKind,
    key: TrimmedNonEmptyString,
  }),
]);
export type GitFindWorktreeForOriginInput = typeof GitFindWorktreeForOriginInput.Type;

export const GitFindWorktreeForOriginOutput = Schema.NullOr(WorktreeId);
export type GitFindWorktreeForOriginOutput = typeof GitFindWorktreeForOriginOutput.Type;

export const GitArchiveWorktreeInput = Schema.Struct({
  worktreeId: WorktreeId,
  deleteBranch: Schema.Boolean,
});
export type GitArchiveWorktreeInput = typeof GitArchiveWorktreeInput.Type;

export const GitRestoreWorktreeInput = Schema.Struct({
  worktreeId: WorktreeId,
});
export type GitRestoreWorktreeInput = typeof GitRestoreWorktreeInput.Type;

export const GitDeleteWorktreeInput = Schema.Struct({
  worktreeId: WorktreeId,
  deleteBranch: Schema.Boolean,
  force: Schema.optional(Schema.Boolean),
});
export type GitDeleteWorktreeInput = typeof GitDeleteWorktreeInput.Type;

export const ThreadsSetManualBucketInput = Schema.Struct({
  threadId: ThreadId,
  bucket: Schema.NullOr(StatusBucket),
});
export type ThreadsSetManualBucketInput = typeof ThreadsSetManualBucketInput.Type;

export const ThreadsSetManualPositionInput = Schema.Struct({
  threadId: ThreadId,
  position: Schema.Number,
});
export type ThreadsSetManualPositionInput = typeof ThreadsSetManualPositionInput.Type;

export const WorktreesSetManualPositionInput = Schema.Struct({
  worktreeId: WorktreeId,
  position: Schema.Number,
});
export type WorktreesSetManualPositionInput = typeof WorktreesSetManualPositionInput.Type;

export const ProjectsInitializeGitInput = Schema.Struct({
  projectId: ProjectId,
});
export type ProjectsInitializeGitInput = typeof ProjectsInitializeGitInput.Type;

export const SearchThreadMessagesInput = Schema.Struct({
  query: Schema.String,
  projectId: Schema.optional(ProjectId),
  limit: Schema.optional(Schema.Number),
});
export type SearchThreadMessagesInput = typeof SearchThreadMessagesInput.Type;

export const SearchThreadMessageResult = Schema.Struct({
  threadId: ThreadId,
  messageId: Schema.String,
  snippet: Schema.String,
  timestamp: Schema.String,
});
export type SearchThreadMessageResult = typeof SearchThreadMessageResult.Type;

export const SearchThreadMessagesResult = Schema.Struct({
  results: Schema.Array(SearchThreadMessageResult),
});
export type SearchThreadMessagesResult = typeof SearchThreadMessagesResult.Type;

export const EmptyRpcResult = Schema.Struct({});
export type EmptyRpcResult = typeof EmptyRpcResult.Type;

export const WsServerUpsertKeybindingRpc = Rpc.make(WS_METHODS.serverUpsertKeybinding, {
  payload: ServerUpsertKeybindingInput,
  success: ServerUpsertKeybindingResult,
  error: Schema.Union([KeybindingsConfigError, AuthRpcError]),
});

export const WsKeybindingsReplaceCustomRpc = Rpc.make(WS_METHODS.keybindingsReplaceCustom, {
  payload: KeybindingsReplaceCustomInput,
  success: KeybindingsReplaceCustomResult,
  error: Schema.Union([KeybindingsConfigError, AuthRpcError]),
});

export const WsServerGetConfigRpc = Rpc.make(WS_METHODS.serverGetConfig, {
  payload: Schema.Struct({}),
  success: ServerConfig,
  error: Schema.Union([KeybindingsConfigError, ServerSettingsError]),
});

export const WsServerGetAdvertisedEndpointsRpc = Rpc.make(WS_METHODS.serverGetAdvertisedEndpoints, {
  payload: Schema.Struct({}),
  success: Schema.Array(AdvertisedEndpoint),
  error: AuthRpcError,
});

export const WsServerGetDiagnosticsMetricsRpc = Rpc.make(WS_METHODS.serverGetDiagnosticsMetrics, {
  payload: Schema.Struct({}),
  success: ServerLocalDiagnosticsMetrics,
  error: AuthRpcError,
});

export const WsServerRefreshProvidersRpc = Rpc.make(WS_METHODS.serverRefreshProviders, {
  payload: Schema.Struct({
    /**
     * When supplied, only refresh this specific provider instance. When
     * omitted, refresh all configured instances — the legacy `refresh()`
     * behaviour retained for transports that still dispatch untargeted
     * refreshes.
     */
    instanceId: Schema.optional(ProviderInstanceId),
  }),
  success: ServerProviderUpdatedPayload,
  error: AuthRpcError,
});

export const WsServerUpdateProviderRpc = Rpc.make(WS_METHODS.serverUpdateProvider, {
  payload: ServerProviderUpdateInput,
  success: ServerProviderUpdatedPayload,
  error: Schema.Union([ServerProviderUpdateError, AuthRpcError]),
});

export const WsServerGetSettingsRpc = Rpc.make(WS_METHODS.serverGetSettings, {
  payload: Schema.Struct({}),
  success: ServerSettings,
  error: ServerSettingsError,
});

export const WsServerUpdateSettingsRpc = Rpc.make(WS_METHODS.serverUpdateSettings, {
  payload: Schema.Struct({ patch: ServerSettingsPatch }),
  success: ServerSettings,
  error: Schema.Union([ServerSettingsError, AuthRpcError]),
});

export const WsServerGetDiagnosticsSnapshotRpc = Rpc.make(WS_METHODS.serverGetDiagnosticsSnapshot, {
  payload: Schema.Struct({}),
  success: DiagnosticsSnapshot,
  error: Schema.Union([DiagnosticsError, AuthRpcError]),
});

export const WsServerGetResourceTelemetryHistoryRpc = Rpc.make(
  WS_METHODS.serverGetResourceTelemetryHistory,
  {
    payload: ResourceTelemetryHistoryInput,
    success: ResourceTelemetryHistory,
    error: Schema.Union([DiagnosticsError, AuthRpcError]),
  },
);

export const WsServerRetryResourceTelemetryRpc = Rpc.make(WS_METHODS.serverRetryResourceTelemetry, {
  payload: Schema.Struct({}),
  success: ResourceTelemetrySnapshot,
  error: Schema.Union([DiagnosticsError, AuthRpcError]),
});

export const WsServerSignalDiagnosticProcessRpc = Rpc.make(
  WS_METHODS.serverSignalDiagnosticProcess,
  {
    payload: DiagnosticsSignalProcessInput,
    success: DiagnosticsSignalProcessResult,
    error: Schema.Union([DiagnosticsError, AuthRpcError]),
  },
);

export const WsServerGetStatisticsRpc = Rpc.make(WS_METHODS.serverGetStatistics, {
  payload: Schema.Struct({}),
  success: StatisticsSnapshot,
  error: AuthRpcError,
});

export const WsServerGetUsageSummaryRpc = Rpc.make(WS_METHODS.serverGetUsageSummary, {
  payload: UsageSummaryRequest,
  success: UsageSummary,
  error: Schema.Union([UsageReadError, AuthRpcError]),
});

export const WsServerDiscoverSourceControlRpc = Rpc.make(WS_METHODS.serverDiscoverSourceControl, {
  payload: Schema.Struct({}),
  success: SourceControlDiscoveryResult,
  error: AuthRpcError,
});

export const WsServerListOpinionatedPluginsRpc = Rpc.make(WS_METHODS.serverListOpinionatedPlugins, {
  payload: Schema.Struct({}),
  success: OpinionatedPluginListResult,
  error: Schema.Union([OpinionatedPluginError, AuthRpcError]),
});

export const WsServerCheckOpinionatedPluginsRpc = Rpc.make(
  WS_METHODS.serverCheckOpinionatedPlugins,
  {
    payload: OpinionatedPluginCheckInput,
    success: OpinionatedPluginStatusResult,
    error: Schema.Union([OpinionatedPluginError, AuthRpcError]),
  },
);

export const WsServerInstallOpinionatedPluginRpc = Rpc.make(
  WS_METHODS.serverInstallOpinionatedPlugin,
  {
    payload: OpinionatedPluginInstallInput,
    success: OpinionatedPluginInstallResult,
    error: Schema.Union([OpinionatedPluginError, AuthRpcError]),
  },
);

export const WsMcpListWorkspacesRpc = Rpc.make(WS_METHODS.mcpListWorkspaces, {
  payload: Schema.Struct({}),
  success: McpListWorkspacesResult,
  error: Schema.Union([McpSettingsError, AuthRpcError]),
});

export const WsMcpListServersRpc = Rpc.make(WS_METHODS.mcpListServers, {
  payload: McpListServersInput,
  success: McpListServersResult,
  error: Schema.Union([McpSettingsError, AuthRpcError]),
});

export const WsMcpUpsertServerRpc = Rpc.make(WS_METHODS.mcpUpsertServer, {
  payload: McpServerUpsertInput,
  success: McpListServersResult,
  error: Schema.Union([McpSettingsError, AuthRpcError]),
});

export const WsMcpSetServerEnabledRpc = Rpc.make(WS_METHODS.mcpSetServerEnabled, {
  payload: McpServerEnabledInput,
  success: McpListServersResult,
  error: Schema.Union([McpSettingsError, AuthRpcError]),
});

export const WsMcpRemoveServerRpc = Rpc.make(WS_METHODS.mcpRemoveServer, {
  payload: McpServerRemoveInput,
  success: McpListServersResult,
  error: Schema.Union([McpSettingsError, AuthRpcError]),
});

export const WsMcpReloadServersRpc = Rpc.make(WS_METHODS.mcpReloadServers, {
  payload: McpServersReloadInput,
  success: McpListServersResult,
  error: Schema.Union([McpSettingsError, AuthRpcError]),
});

export const WsMcpStartOauthLoginRpc = Rpc.make(WS_METHODS.mcpStartOauthLogin, {
  payload: McpOauthLoginInput,
  success: McpOauthLoginResult,
  error: Schema.Union([McpSettingsError, AuthRpcError]),
});

export const WsSourceControlLookupRepositoryRpc = Rpc.make(
  WS_METHODS.sourceControlLookupRepository,
  {
    payload: SourceControlRepositoryLookupInput,
    success: SourceControlRepositoryInfo,
    error: Schema.Union([SourceControlRepositoryError, AuthRpcError]),
  },
);

export const WsSourceControlSearchRepositoriesRpc = Rpc.make(
  WS_METHODS.sourceControlSearchRepositories,
  {
    payload: SourceControlRepositorySearchInput,
    success: SourceControlRepositorySearchResult,
    error: Schema.Union([SourceControlRepositoryError, AuthRpcError]),
  },
);

export const WsSourceControlCloneRepositoryRpc = Rpc.make(WS_METHODS.sourceControlCloneRepository, {
  payload: SourceControlCloneRepositoryInput,
  success: SourceControlCloneRepositoryResult,
  error: Schema.Union([SourceControlRepositoryError, AuthRpcError]),
});

export const WsSourceControlPublishRepositoryRpc = Rpc.make(
  WS_METHODS.sourceControlPublishRepository,
  {
    payload: SourceControlPublishRepositoryInput,
    success: SourceControlPublishRepositoryResult,
    error: Schema.Union([SourceControlRepositoryError, AuthRpcError]),
  },
);

export const WsSourceControlListIssuesRpc = Rpc.make(WS_METHODS.sourceControlListIssues, {
  payload: Schema.Struct({
    cwd: Schema.String,
    state: Schema.Literals(["open", "closed", "all"]),
    limit: Schema.optional(Schema.Number),
  }),
  success: Schema.Array(SourceControlIssueSummary),
  error: Schema.Union([SourceControlProviderError, AuthRpcError]),
});

export const WsSourceControlGetIssueRpc = Rpc.make(WS_METHODS.sourceControlGetIssue, {
  payload: Schema.Struct({
    cwd: Schema.String,
    reference: Schema.String,
    fullContent: Schema.optional(Schema.Boolean),
  }),
  success: SourceControlIssueDetail,
  error: Schema.Union([SourceControlProviderError, AuthRpcError]),
});

export const WsSourceControlSearchIssuesRpc = Rpc.make(WS_METHODS.sourceControlSearchIssues, {
  payload: Schema.Struct({
    cwd: Schema.String,
    query: Schema.String,
    limit: Schema.optional(Schema.Number),
  }),
  success: Schema.Array(SourceControlIssueSummary),
  error: Schema.Union([SourceControlProviderError, AuthRpcError]),
});

export const WsSourceControlListChangeRequestsRpc = Rpc.make(
  WS_METHODS.sourceControlListChangeRequests,
  {
    payload: Schema.Struct({
      cwd: Schema.String,
      state: Schema.Literals(["open", "closed", "merged", "all"]),
      limit: Schema.optional(Schema.Number),
      query: Schema.optional(Schema.String),
    }),
    success: Schema.Array(ChangeRequest),
    error: Schema.Union([SourceControlProviderError, AuthRpcError]),
  },
);

export const WsSourceControlSearchChangeRequestsRpc = Rpc.make(
  WS_METHODS.sourceControlSearchChangeRequests,
  {
    payload: Schema.Struct({
      cwd: Schema.String,
      query: Schema.String,
      limit: Schema.optional(Schema.Number),
    }),
    success: Schema.Array(ChangeRequest),
    error: Schema.Union([SourceControlProviderError, AuthRpcError]),
  },
);

export const WsSourceControlGetChangeRequestDetailRpc = Rpc.make(
  WS_METHODS.sourceControlGetChangeRequestDetail,
  {
    payload: Schema.Struct({
      cwd: Schema.String,
      reference: Schema.String,
      fullContent: Schema.optional(Schema.Boolean),
    }),
    success: SourceControlChangeRequestDetail,
    error: Schema.Union([SourceControlProviderError, AuthRpcError]),
  },
);

export const WsSourceControlGetChangeRequestFilesViewedRpc = Rpc.make(
  WS_METHODS.sourceControlGetChangeRequestFilesViewed,
  {
    payload: SourceControlGetChangeRequestFilesViewedInput,
    success: SourceControlChangeRequestFilesViewed,
    error: Schema.Union([SourceControlProviderError, AuthRpcError]),
  },
);
export const WsSourceControlSetChangeRequestFileViewedRpc = Rpc.make(
  WS_METHODS.sourceControlSetChangeRequestFileViewed,
  {
    payload: SourceControlSetChangeRequestFileViewedInput,
    success: SourceControlSetChangeRequestFileViewedResult,
    error: Schema.Union([SourceControlProviderError, AuthRpcError]),
  },
);

export const WsSourceControlGetChangeRequestDiffRpc = Rpc.make(
  WS_METHODS.sourceControlGetChangeRequestDiff,
  {
    payload: Schema.Struct({
      cwd: Schema.String,
      reference: Schema.String,
      expectedHeadSha: Schema.optional(TrimmedNonEmptyString),
    }),
    success: Schema.String,
    error: Schema.Union([SourceControlProviderError, AuthRpcError]),
  },
);

export const WsSourceControlMergeChangeRequestRpc = Rpc.make(
  WS_METHODS.sourceControlMergeChangeRequest,
  {
    payload: SourceControlMergeChangeRequestInput,
    success: SourceControlMergeChangeRequestResult,
    error: Schema.Union([SourceControlProviderError, AuthRpcError]),
  },
);

export const WsSourceControlCreateIssueRpc = Rpc.make(WS_METHODS.sourceControlCreateIssue, {
  payload: SourceControlCreateIssueInput,
  success: SourceControlCreateIssueWithWorktreeResult,
  error: Schema.Union([SourceControlProviderError, AuthRpcError, GitManagerServiceError]),
});

export const WsSourceControlAddIssueCommentRpc = Rpc.make(WS_METHODS.sourceControlAddIssueComment, {
  payload: SourceControlAddIssueCommentInput,
  success: SourceControlAddIssueCommentResult,
  error: Schema.Union([SourceControlProviderError, AuthRpcError]),
});

export const WsSourceControlAddIssueCommentReactionRpc = Rpc.make(
  WS_METHODS.sourceControlAddIssueCommentReaction,
  {
    payload: SourceControlAddCommentReactionInput,
    success: SourceControlAddIssueCommentReactionResult,
    error: Schema.Union([SourceControlProviderError, AuthRpcError]),
  },
);

export const WsSourceControlAddChangeRequestCommentRpc = Rpc.make(
  WS_METHODS.sourceControlAddChangeRequestComment,
  {
    payload: SourceControlAddChangeRequestCommentInput,
    success: SourceControlAddChangeRequestCommentResult,
    error: Schema.Union([SourceControlProviderError, AuthRpcError]),
  },
);

export const WsSourceControlAddChangeRequestCommentReactionRpc = Rpc.make(
  WS_METHODS.sourceControlAddChangeRequestCommentReaction,
  {
    payload: SourceControlAddCommentReactionInput,
    success: SourceControlAddChangeRequestCommentReactionResult,
    error: Schema.Union([SourceControlProviderError, AuthRpcError]),
  },
);

export const WsSourceControlListIssueLabelsRpc = Rpc.make(WS_METHODS.sourceControlListIssueLabels, {
  payload: Schema.Struct({ cwd: Schema.String }),
  success: Schema.Array(SourceControlLabel),
  error: Schema.Union([SourceControlProviderError, AuthRpcError]),
});

export const WsSourceControlListIssueAssigneesRpc = Rpc.make(
  WS_METHODS.sourceControlListIssueAssignees,
  {
    payload: Schema.Struct({ cwd: Schema.String }),
    success: Schema.Array(SourceControlAssigneeCandidate),
    error: Schema.Union([SourceControlProviderError, AuthRpcError]),
  },
);

export const WsSourceControlListWorkflowRunsRpc = Rpc.make(
  WS_METHODS.sourceControlListWorkflowRuns,
  {
    payload: SourceControlWorkflowRunListInput,
    success: SourceControlWorkflowRunListResult,
    error: Schema.Union([SourceControlProviderError, AuthRpcError]),
  },
);

export const WsSourceControlGetWorkflowRunJobsRpc = Rpc.make(
  WS_METHODS.sourceControlGetWorkflowRunJobs,
  {
    payload: SourceControlWorkflowRunJobsInput,
    success: SourceControlWorkflowRunJobsResult,
    error: Schema.Union([SourceControlProviderError, AuthRpcError]),
  },
);

export const WsSourceControlGetWorkflowJobLogRpc = Rpc.make(
  WS_METHODS.sourceControlGetWorkflowJobLog,
  {
    payload: SourceControlWorkflowJobLogInput,
    success: SourceControlWorkflowJobLogResult,
    error: Schema.Union([SourceControlProviderError, AuthRpcError]),
  },
);

export const WsSourceControlRerunWorkflowRpc = Rpc.make(WS_METHODS.sourceControlRerunWorkflow, {
  payload: SourceControlWorkflowRerunInput,
  success: SourceControlWorkflowRerunResult,
  error: Schema.Union([SourceControlProviderError, AuthRpcError]),
});

export const WsTextGenerationGenerateIssueContentRpc = Rpc.make(
  WS_METHODS.textGenerationGenerateIssueContent,
  {
    payload: TextGenerationIssueContentInput,
    success: TextGenerationIssueContentResult,
    error: Schema.Union([AuthRpcError, TextGenerationError]),
  },
);

export const WsTextGenerationGenerateBranchNameRpc = Rpc.make(
  WS_METHODS.textGenerationGenerateBranchName,
  {
    payload: TextGenerationBranchNameInput,
    success: TextGenerationBranchNameResult,
    error: Schema.Union([AuthRpcError, TextGenerationError]),
  },
);

export const WsAtlassianListConnectionsRpc = Rpc.make(WS_METHODS.atlassianListConnections, {
  payload: Schema.Struct({}),
  success: Schema.Array(AtlassianConnectionSummary),
  error: Schema.Union([AtlassianConnectionError, AuthRpcError]),
});

export const WsAtlassianStartOAuthRpc = Rpc.make(WS_METHODS.atlassianStartOAuth, {
  payload: AtlassianStartOAuthInput,
  success: AtlassianStartOAuthResult,
  error: Schema.Union([AtlassianConnectionError, AuthRpcError]),
});

export const WsAtlassianDisconnectRpc = Rpc.make(WS_METHODS.atlassianDisconnect, {
  payload: AtlassianDisconnectInput,
  success: EmptyRpcResult,
  error: Schema.Union([AtlassianConnectionError, AuthRpcError]),
});

export const WsAtlassianRefreshRpc = Rpc.make(WS_METHODS.atlassianRefresh, {
  payload: AtlassianRefreshInput,
  success: AtlassianConnectionSummary,
  error: Schema.Union([AtlassianConnectionError, AuthRpcError]),
});

export const WsAtlassianListResourcesRpc = Rpc.make(WS_METHODS.atlassianListResources, {
  payload: AtlassianListResourcesInput,
  success: Schema.Array(AtlassianResourceSummary),
  error: Schema.Union([AtlassianConnectionError, AuthRpcError]),
});

export const WsAtlassianGetProjectLinkRpc = Rpc.make(WS_METHODS.atlassianGetProjectLink, {
  payload: AtlassianGetProjectLinkInput,
  success: Schema.NullOr(AtlassianProjectLink),
  error: Schema.Union([AtlassianConnectionError, AuthRpcError]),
});

export const WsAtlassianSaveProjectLinkRpc = Rpc.make(WS_METHODS.atlassianSaveProjectLink, {
  payload: AtlassianSaveProjectLinkInput,
  success: AtlassianProjectLink,
  error: Schema.Union([AtlassianConnectionError, AuthRpcError]),
});

export const WsAtlassianSaveManualBitbucketTokenRpc = Rpc.make(
  WS_METHODS.atlassianSaveManualBitbucketToken,
  {
    payload: AtlassianSaveManualBitbucketTokenInput,
    success: AtlassianConnectionSummary,
    error: Schema.Union([AtlassianConnectionError, AuthRpcError]),
  },
);

export const WsAtlassianSaveManualJiraTokenRpc = Rpc.make(WS_METHODS.atlassianSaveManualJiraToken, {
  payload: AtlassianSaveManualJiraTokenInput,
  success: AtlassianConnectionSummary,
  error: Schema.Union([AtlassianConnectionError, AuthRpcError]),
});

export const WsWorkItemsListRpc = Rpc.make(WS_METHODS.workItemsList, {
  payload: WorkItemListInput,
  success: Schema.Array(WorkItemSummary),
  error: WorkItemProviderError,
});

export const WsWorkItemsListProjectsRpc = Rpc.make(WS_METHODS.workItemsListProjects, {
  payload: WorkItemListProjectsInput,
  success: Schema.Array(WorkItemProject),
  error: WorkItemProviderError,
});

export const WsWorkItemsSearchRpc = Rpc.make(WS_METHODS.workItemsSearch, {
  payload: WorkItemSearchInput,
  success: Schema.Array(WorkItemSummary),
  error: WorkItemProviderError,
});

export const WsWorkItemsGetRpc = Rpc.make(WS_METHODS.workItemsGet, {
  payload: WorkItemGetInput,
  success: WorkItemDetail,
  error: WorkItemProviderError,
});

export const WsWorkItemsAddCommentRpc = Rpc.make(WS_METHODS.workItemsAddComment, {
  payload: WorkItemAddCommentInput,
  success: WorkItemDetail,
  error: Schema.Union([WorkItemProviderError, AuthRpcError]),
});

export const WsWorkItemsEditCommentRpc = Rpc.make(WS_METHODS.workItemsEditComment, {
  payload: WorkItemEditCommentInput,
  success: WorkItemDetail,
  error: Schema.Union([WorkItemProviderError, AuthRpcError]),
});

export const WsWorkItemsUpdateRpc = Rpc.make(WS_METHODS.workItemsUpdate, {
  payload: WorkItemUpdateInput,
  success: WorkItemDetail,
  error: Schema.Union([WorkItemProviderError, AuthRpcError]),
});

export const WsWorkItemsListTransitionsRpc = Rpc.make(WS_METHODS.workItemsListTransitions, {
  payload: WorkItemListTransitionsInput,
  success: Schema.Array(WorkItemTransition),
  error: WorkItemProviderError,
});

export const WsWorkItemsTransitionRpc = Rpc.make(WS_METHODS.workItemsTransition, {
  payload: WorkItemTransitionInput,
  success: WorkItemDetail,
  error: Schema.Union([WorkItemProviderError, AuthRpcError]),
});

export const WsProjectsSearchEntriesRpc = Rpc.make(WS_METHODS.projectsSearchEntries, {
  payload: ProjectSearchEntriesInput,
  success: ProjectSearchEntriesResult,
  error: Schema.Union([ProjectSearchEntriesError, AuthRpcError]),
});

export const WsProjectsListEntriesRpc = Rpc.make(WS_METHODS.projectsListEntries, {
  payload: ProjectListEntriesInput,
  success: ProjectListEntriesResult,
  error: Schema.Union([ProjectListEntriesError, AuthRpcError]),
});

export const WsProjectsReadFileRpc = Rpc.make(WS_METHODS.projectsReadFile, {
  payload: ProjectReadFileInput,
  success: ProjectReadFileResult,
  error: Schema.Union([ProjectReadFileError, AuthRpcError]),
});

export const WsProjectsReadIconRpc = Rpc.make(WS_METHODS.projectsReadIcon, {
  payload: ProjectReadIconInput,
  success: ProjectReadIconResult,
  error: Schema.Union([ProjectReadIconError, AuthRpcError]),
});

export const WsProjectsReadFileBinaryRpc = Rpc.make(WS_METHODS.projectsReadFileBinary, {
  payload: ProjectReadFileBinaryInput,
  success: ProjectReadFileBinaryResult,
  error: Schema.Union([ProjectReadFileBinaryError, AuthRpcError]),
});

export const WsProjectsWriteFileRpc = Rpc.make(WS_METHODS.projectsWriteFile, {
  payload: ProjectWriteFileInput,
  success: ProjectWriteFileResult,
  error: Schema.Union([ProjectWriteFileError, AuthRpcError]),
});

export const WsProjectsStageFileReferenceRpc = Rpc.make(WS_METHODS.projectsStageFileReference, {
  payload: ProjectStageFileReferenceInput,
  success: ProjectStageFileReferenceResult,
  error: Schema.Union([ProjectStageFileReferenceError, AuthRpcError]),
});

export const WsChatAttachmentsCreateFileUploadRpc = Rpc.make(
  WS_METHODS.chatAttachmentsCreateFileUpload,
  {
    payload: FileAttachmentCreateUploadUrlInput,
    success: FileAttachmentCreateUploadUrlResult,
    error: Schema.Union([FileAttachmentCreateUploadUrlError, AuthRpcError]),
  },
);

export const WsChatAttachmentsReadChunkRpc = Rpc.make(WS_METHODS.chatAttachmentsReadChunk, {
  payload: ChatAttachmentReadChunkInput,
  success: ChatAttachmentReadChunkResult,
  error: Schema.Union([ChatAttachmentReadError, AuthRpcError]),
});

export const WsShellOpenInEditorRpc = Rpc.make(WS_METHODS.shellOpenInEditor, {
  payload: OpenInEditorInput,
  error: Schema.Union([OpenError, AuthRpcError]),
});

export const WsFilesystemBrowseRpc = Rpc.make(WS_METHODS.filesystemBrowse, {
  payload: FilesystemBrowseInput,
  success: FilesystemBrowseResult,
  error: Schema.Union([FilesystemBrowseError, AuthRpcError]),
});

export const WsDeviceReadRpc = Rpc.make(DEVICE_WS_METHODS.read, {
  payload: DeviceReadRequest,
  success: DeviceReadResponse,
  error: Schema.Union([DeviceRpcError, AuthRpcError]),
});

export const WsDeviceLifecycleRpc = Rpc.make(DEVICE_WS_METHODS.lifecycle, {
  payload: DeviceLifecycleRequest,
  success: DeviceLifecycleResponse,
  error: Schema.Union([DeviceRpcError, AuthRpcError]),
});

export const WsDeviceInputRpc = Rpc.make(DEVICE_WS_METHODS.input, {
  payload: DeviceInputRequest,
  success: DeviceInputResponse,
  error: Schema.Union([DeviceRpcError, AuthRpcError]),
});

export const WsDeviceAppRpc = Rpc.make(DEVICE_WS_METHODS.app, {
  payload: DeviceAppRequest,
  success: DeviceAppResponse,
  error: Schema.Union([DeviceRpcError, AuthRpcError]),
});

export const WsDeviceRecordingRpc = Rpc.make(DEVICE_WS_METHODS.recording, {
  payload: DeviceRecordingRequest,
  success: DeviceRecordingResponse,
  error: Schema.Union([DeviceRpcError, AuthRpcError]),
});

export const WsSubscribeDeviceEventsRpc = Rpc.make(DEVICE_WS_METHODS.subscribeEvents, {
  payload: Schema.Struct({}),
  success: DeviceEvent,
  error: Schema.Union([DeviceRpcError, AuthRpcError]),
  stream: true,
});

export const WsSubscribeVcsStatusRpc = Rpc.make(WS_METHODS.subscribeVcsStatus, {
  payload: VcsStatusInput,
  success: VcsStatusStreamEvent,
  error: Schema.Union([GitManagerServiceError, AuthRpcError]),
  stream: true,
});

export const WsVcsPullRpc = Rpc.make(WS_METHODS.vcsPull, {
  payload: VcsPullInput,
  success: VcsPullResult,
  error: Schema.Union([GitCommandError, AuthRpcError]),
});

export const WsVcsRefreshStatusRpc = Rpc.make(WS_METHODS.vcsRefreshStatus, {
  payload: VcsStatusInput,
  success: VcsStatusResult,
  error: Schema.Union([GitManagerServiceError, AuthRpcError]),
});

export const WsGitRunStackedActionRpc = Rpc.make(WS_METHODS.gitRunStackedAction, {
  payload: GitRunStackedActionInput,
  success: GitActionProgressEvent,
  error: Schema.Union([GitManagerServiceError, AuthRpcError]),
  stream: true,
});

export const WsGitResolvePullRequestRpc = Rpc.make(WS_METHODS.gitResolvePullRequest, {
  payload: GitPullRequestRefInput,
  success: GitResolvePullRequestResult,
  error: Schema.Union([GitManagerServiceError, AuthRpcError]),
});

export const WsGitPreparePullRequestThreadRpc = Rpc.make(WS_METHODS.gitPreparePullRequestThread, {
  payload: GitPreparePullRequestThreadInput,
  success: GitPreparePullRequestThreadResult,
  error: Schema.Union([GitManagerServiceError, AuthRpcError]),
});

export const WsGitCreateWorktreeForProjectRpc = Rpc.make(WS_METHODS.gitCreateWorktreeForProject, {
  payload: GitCreateWorktreeForProjectInput,
  success: GitCreateWorktreeForProjectOutput,
  error: Schema.Union([GitManagerServiceError, AuthRpcError]),
});

export const WsGitFindWorktreeForOriginRpc = Rpc.make(WS_METHODS.gitFindWorktreeForOrigin, {
  payload: GitFindWorktreeForOriginInput,
  success: GitFindWorktreeForOriginOutput,
  error: Schema.Union([GitManagerServiceError, AuthRpcError]),
});

export const WsGitArchiveWorktreeRpc = Rpc.make(WS_METHODS.gitArchiveWorktree, {
  payload: GitArchiveWorktreeInput,
  success: EmptyRpcResult,
  error: Schema.Union([GitManagerServiceError, AuthRpcError]),
});

export const WsGitRestoreWorktreeRpc = Rpc.make(WS_METHODS.gitRestoreWorktree, {
  payload: GitRestoreWorktreeInput,
  success: EmptyRpcResult,
  error: Schema.Union([GitManagerServiceError, AuthRpcError]),
});

export const WsGitDeleteWorktreeRpc = Rpc.make(WS_METHODS.gitDeleteWorktree, {
  payload: GitDeleteWorktreeInput,
  success: EmptyRpcResult,
  error: Schema.Union([GitManagerServiceError, AuthRpcError]),
});

export const WsThreadsSetManualBucketRpc = Rpc.make(WS_METHODS.threadsSetManualBucket, {
  payload: ThreadsSetManualBucketInput,
  success: EmptyRpcResult,
  error: Schema.Union([GitManagerServiceError, AuthRpcError]),
});

export const WsThreadsSetManualPositionRpc = Rpc.make(WS_METHODS.threadsSetManualPosition, {
  payload: ThreadsSetManualPositionInput,
  success: EmptyRpcResult,
  error: Schema.Union([GitManagerServiceError, AuthRpcError]),
});

export const WsSearchThreadMessagesRpc = Rpc.make(WS_METHODS.searchThreadMessages, {
  payload: SearchThreadMessagesInput,
  success: SearchThreadMessagesResult,
  error: Schema.Union([AuthRpcError]),
});

export const WsThreadPriorityEnsureCurrentRpc = Rpc.make(WS_METHODS.threadPriorityEnsureCurrent, {
  payload: ThreadPriorityEnsureCurrentInput,
  success: ThreadPriorityEnsureCurrentResult,
  error: Schema.Union([ThreadPriorityRpcError, AuthRpcError]),
});

export const WsWorktreesSetManualPositionRpc = Rpc.make(WS_METHODS.worktreesSetManualPosition, {
  payload: WorktreesSetManualPositionInput,
  success: EmptyRpcResult,
  error: Schema.Union([GitManagerServiceError, AuthRpcError]),
});

export const WsProjectsInitializeGitRpc = Rpc.make(WS_METHODS.projectsInitializeGit, {
  payload: ProjectsInitializeGitInput,
  success: EmptyRpcResult,
  error: Schema.Union([GitManagerServiceError, AuthRpcError]),
});

export const WsVcsListRefsRpc = Rpc.make(WS_METHODS.vcsListRefs, {
  payload: VcsListRefsInput,
  success: VcsListRefsResult,
  error: Schema.Union([GitCommandError, AuthRpcError]),
});

export const WsVcsCreateWorktreeRpc = Rpc.make(WS_METHODS.vcsCreateWorktree, {
  payload: VcsCreateWorktreeInput,
  success: VcsCreateWorktreeResult,
  error: Schema.Union([GitCommandError, AuthRpcError]),
});

export const WsVcsRemoveWorktreeRpc = Rpc.make(WS_METHODS.vcsRemoveWorktree, {
  payload: VcsRemoveWorktreeInput,
  error: Schema.Union([GitCommandError, AuthRpcError]),
});

export const WsVcsCreateRefRpc = Rpc.make(WS_METHODS.vcsCreateRef, {
  payload: VcsCreateRefInput,
  success: VcsCreateRefResult,
  error: Schema.Union([GitCommandError, AuthRpcError]),
});

export const WsVcsSwitchRefRpc = Rpc.make(WS_METHODS.vcsSwitchRef, {
  payload: VcsSwitchRefInput,
  success: VcsSwitchRefResult,
  error: Schema.Union([GitCommandError, AuthRpcError]),
});

export const WsVcsInitRpc = Rpc.make(WS_METHODS.vcsInit, {
  payload: VcsInitInput,
  error: Schema.Union([VcsError, AuthRpcError]),
});

export const WsTerminalOpenRpc = Rpc.make(WS_METHODS.terminalOpen, {
  payload: TerminalOpenInput,
  success: TerminalSessionSnapshot,
  error: Schema.Union([TerminalError, AuthRpcError]),
});

export const WsTerminalWriteRpc = Rpc.make(WS_METHODS.terminalWrite, {
  payload: TerminalWriteInput,
  error: Schema.Union([TerminalError, AuthRpcError]),
});

export const WsTerminalResizeRpc = Rpc.make(WS_METHODS.terminalResize, {
  payload: TerminalResizeInput,
  error: Schema.Union([TerminalError, AuthRpcError]),
});

export const WsTerminalClearRpc = Rpc.make(WS_METHODS.terminalClear, {
  payload: TerminalClearInput,
  error: Schema.Union([TerminalError, AuthRpcError]),
});

export const WsTerminalRestartRpc = Rpc.make(WS_METHODS.terminalRestart, {
  payload: TerminalRestartInput,
  success: TerminalSessionSnapshot,
  error: Schema.Union([TerminalError, AuthRpcError]),
});

export const WsTerminalCloseRpc = Rpc.make(WS_METHODS.terminalClose, {
  payload: TerminalCloseInput,
  error: Schema.Union([TerminalError, AuthRpcError]),
});

export const WsOrchestrationDispatchCommandRpc = Rpc.make(
  ORCHESTRATION_WS_METHODS.dispatchCommand,
  {
    payload: ClientOrchestrationCommand,
    success: OrchestrationRpcSchemas.dispatchCommand.output,
    error: Schema.Union([OrchestrationDispatchCommandError, AuthRpcError]),
  },
);

export const WsOrchestrationGetWorkflowScriptRpc = Rpc.make(
  ORCHESTRATION_WS_METHODS.getWorkflowScript,
  {
    payload: OrchestrationRpcSchemas.getWorkflowScript.input,
    success: OrchestrationRpcSchemas.getWorkflowScript.output,
    error: Schema.Union([OrchestrationGetWorkflowScriptError, AuthRpcError]),
  },
);

export const WsOrchestrationGetTaskOutputRpc = Rpc.make(ORCHESTRATION_WS_METHODS.getTaskOutput, {
  payload: OrchestrationRpcSchemas.getTaskOutput.input,
  success: OrchestrationRpcSchemas.getTaskOutput.output,
  error: Schema.Union([OrchestrationGetTaskOutputError, AuthRpcError]),
});

export const WsOrchestrationStopBackgroundTaskRpc = Rpc.make(
  ORCHESTRATION_WS_METHODS.stopBackgroundTask,
  {
    payload: OrchestrationRpcSchemas.stopBackgroundTask.input,
    success: OrchestrationRpcSchemas.stopBackgroundTask.output,
    error: Schema.Union([OrchestrationStopBackgroundTaskError, AuthRpcError]),
  },
);

export const WsOrchestrationGetTurnDiffRpc = Rpc.make(ORCHESTRATION_WS_METHODS.getTurnDiff, {
  payload: OrchestrationGetTurnDiffInput,
  success: OrchestrationRpcSchemas.getTurnDiff.output,
  error: OrchestrationGetTurnDiffError,
});

export const WsOrchestrationGetFullThreadDiffRpc = Rpc.make(
  ORCHESTRATION_WS_METHODS.getFullThreadDiff,
  {
    payload: OrchestrationGetFullThreadDiffInput,
    success: OrchestrationRpcSchemas.getFullThreadDiff.output,
    error: OrchestrationGetFullThreadDiffError,
  },
);

export const WsOrchestrationSearchThreadMessagesRpc = Rpc.make(
  ORCHESTRATION_WS_METHODS.searchThreadMessages,
  {
    payload: OrchestrationSearchThreadMessagesInput,
    success: OrchestrationRpcSchemas.searchThreadMessages.output,
    error: OrchestrationGetSnapshotError,
  },
);

export const WsOrchestrationGetThreadWindowRpc = Rpc.make(
  ORCHESTRATION_WS_METHODS.getThreadWindow,
  {
    payload: OrchestrationRpcSchemas.getThreadWindow.input,
    success: OrchestrationRpcSchemas.getThreadWindow.output,
    error: Schema.Union([OrchestrationThreadHistoryError, OrchestrationGetSnapshotError]),
  },
);

export const WsOrchestrationGetThreadHistoryPageRpc = Rpc.make(
  ORCHESTRATION_WS_METHODS.getThreadHistoryPage,
  {
    payload: OrchestrationRpcSchemas.getThreadHistoryPage.input,
    success: OrchestrationRpcSchemas.getThreadHistoryPage.output,
    error: Schema.Union([OrchestrationThreadHistoryError, OrchestrationGetSnapshotError]),
  },
);

export const WsOrchestrationReplayEventsRpc = Rpc.make(ORCHESTRATION_WS_METHODS.replayEvents, {
  payload: OrchestrationReplayEventsInput,
  success: OrchestrationRpcSchemas.replayEvents.output,
  error: OrchestrationReplayEventsError,
});

export const WsOrchestrationReplayEventsPageRpc = Rpc.make(
  ORCHESTRATION_WS_METHODS.replayEventsPage,
  {
    payload: OrchestrationReplayEventsPageInput,
    success: OrchestrationRpcSchemas.replayEventsPage.output,
    error: OrchestrationReplayEventsError,
  },
);

export const WsOrchestrationSubscribeShellRpc = Rpc.make(ORCHESTRATION_WS_METHODS.subscribeShell, {
  payload: OrchestrationRpcSchemas.subscribeShell.input,
  success: OrchestrationRpcSchemas.subscribeShell.output,
  error: OrchestrationGetSnapshotError,
  stream: true,
});

export const WsOrchestrationSubscribeThreadRpc = Rpc.make(
  ORCHESTRATION_WS_METHODS.subscribeThread,
  {
    payload: OrchestrationRpcSchemas.subscribeThread.input,
    success: OrchestrationRpcSchemas.subscribeThread.output,
    error: OrchestrationGetSnapshotError,
    stream: true,
  },
);

export const WsOrchestrationSubscribeThreadWindowRpc = Rpc.make(
  ORCHESTRATION_WS_METHODS.subscribeThreadWindow,
  {
    payload: OrchestrationRpcSchemas.subscribeThreadWindow.input,
    success: OrchestrationRpcSchemas.subscribeThreadWindow.output,
    error: Schema.Union([OrchestrationThreadHistoryError, OrchestrationGetSnapshotError]),
    stream: true,
  },
);

export const WsContextHandoffGetInspectionSummaryRpc = Rpc.make(
  CONTEXT_HANDOFF_WS_METHODS.getInspectionSummary,
  {
    payload: ContextHandoffInspectionSummaryInput,
    success: ContextHandoffInspectionSummary,
    error: Schema.Union([ContextHandoffInspectionError, AuthRpcError]),
  },
);

export const WsContextHandoffListInspectionEntriesRpc = Rpc.make(
  CONTEXT_HANDOFF_WS_METHODS.listInspectionEntries,
  {
    payload: ContextHandoffInspectionEntriesInput,
    success: ContextHandoffInspectionEntriesPage,
    error: Schema.Union([ContextHandoffInspectionError, AuthRpcError]),
  },
);

export const WsContextHandoffReadRawPayloadChunkRpc = Rpc.make(
  CONTEXT_HANDOFF_WS_METHODS.readRawPayloadChunk,
  {
    payload: ContextHandoffRawPayloadChunkInput,
    success: ContextHandoffRawPayloadChunk,
    error: Schema.Union([ContextHandoffInspectionError, AuthRpcError]),
  },
);

export const WsContextHandoffReadExportChunkRpc = Rpc.make(
  CONTEXT_HANDOFF_WS_METHODS.readExportChunk,
  {
    payload: ContextHandoffExportChunkInput,
    success: ContextHandoffExportChunk,
    error: Schema.Union([ContextHandoffInspectionError, AuthRpcError]),
  },
);

export const WsSubscribeTerminalEventsRpc = Rpc.make(WS_METHODS.subscribeTerminalEvents, {
  payload: Schema.Struct({}),
  success: TerminalEvent,
  error: Schema.Union([AuthRpcError, TerminalSubscriptionResyncError]),
  stream: true,
});

export const WsSubscribeServerConfigRpc = Rpc.make(WS_METHODS.subscribeServerConfig, {
  payload: Schema.Struct({}),
  success: ServerConfigStreamEvent,
  error: Schema.Union([KeybindingsConfigError, ServerSettingsError]),
  stream: true,
});

export const WsSubscribeServerLifecycleRpc = Rpc.make(WS_METHODS.subscribeServerLifecycle, {
  payload: Schema.Struct({}),
  success: ServerLifecycleStreamEvent,
  stream: true,
});

export const WsSubscribeAuthAccessRpc = Rpc.make(WS_METHODS.subscribeAuthAccess, {
  payload: Schema.Struct({}),
  success: AuthAccessStreamEvent,
  error: AuthRpcError,
  stream: true,
});

/**
 * Simulator RPCs stay in a bounded subgroup so handler-service inference does
 * not have to expand the entire application group for every device method.
 * The public WsRpcGroup below merges this subgroup and remains the one wire API.
 */
export const WsDeviceRpcGroup = RpcGroup.make(
  WsDeviceReadRpc,
  WsDeviceLifecycleRpc,
  WsDeviceInputRpc,
  WsDeviceAppRpc,
  WsDeviceRecordingRpc,
  WsSubscribeDeviceEventsRpc,
);

export const WsAgentControlListProposalsRpc = Rpc.make(AGENT_CONTROL_WS_METHODS.listProposals, {
  payload: AgentControlListProposalsInput,
  success: AgentControlProposalQueue,
  error: Schema.Union([AgentControlRpcError, AuthRpcError]),
});

export const WsAgentControlGetProposalRpc = Rpc.make(AGENT_CONTROL_WS_METHODS.getProposal, {
  payload: AgentControlGetProposalInput,
  success: AgentControlGetProposalResult,
  error: Schema.Union([AgentControlRpcError, AuthRpcError]),
});

export const WsAgentControlAcceptProposalRpc = Rpc.make(AGENT_CONTROL_WS_METHODS.acceptProposal, {
  payload: AgentControlDecideProposalInput,
  success: AgentControlProposalReceipt,
  error: Schema.Union([AgentControlRpcError, AuthRpcError]),
});

export const WsAgentControlRejectProposalRpc = Rpc.make(AGENT_CONTROL_WS_METHODS.rejectProposal, {
  payload: AgentControlDecideProposalInput,
  success: AgentControlProposalReceipt,
  error: Schema.Union([AgentControlRpcError, AuthRpcError]),
});

export const WsAgentControlSubscribeProposalsRpc = Rpc.make(
  AGENT_CONTROL_WS_METHODS.subscribeProposals,
  {
    payload: Schema.Struct({}),
    success: AgentControlProposalStreamEvent,
    error: Schema.Union([AgentControlRpcError, AuthRpcError]),
    stream: true,
  },
);

export const WsAgentControlListIntegrationsRpc = Rpc.make(
  AGENT_CONTROL_WS_METHODS.listIntegrations,
  {
    payload: Schema.Struct({}),
    success: AgentControlExternalIntegrationListResult,
    error: Schema.Union([AgentControlExternalRpcError, AuthRpcError]),
  },
);

export const WsAgentControlCreateIntegrationRpc = Rpc.make(
  AGENT_CONTROL_WS_METHODS.createIntegration,
  {
    payload: AgentControlExternalIntegrationCreateInput,
    success: AgentControlExternalPairingResult,
    error: Schema.Union([AgentControlExternalRpcError, AuthRpcError]),
  },
);

export const WsAgentControlUpdateIntegrationRpc = Rpc.make(
  AGENT_CONTROL_WS_METHODS.updateIntegration,
  {
    payload: AgentControlExternalIntegrationUpdateInput,
    success: AgentControlExternalIntegrationMutationResult,
    error: Schema.Union([AgentControlExternalRpcError, AuthRpcError]),
  },
);

export const WsAgentControlResumeIntegrationPairingRpc = Rpc.make(
  AGENT_CONTROL_WS_METHODS.resumeIntegrationPairing,
  {
    payload: AgentControlExternalIntegrationIdInput,
    success: AgentControlExternalPairingResult,
    error: Schema.Union([AgentControlExternalRpcError, AuthRpcError]),
  },
);

export const WsAgentControlRevokeIntegrationRpc = Rpc.make(
  AGENT_CONTROL_WS_METHODS.revokeIntegration,
  {
    payload: AgentControlExternalIntegrationIdInput,
    success: AgentControlExternalIntegrationMutationResult,
    error: Schema.Union([AgentControlExternalRpcError, AuthRpcError]),
  },
);

export const WsAgentControlDeleteIntegrationRpc = Rpc.make(
  AGENT_CONTROL_WS_METHODS.deleteIntegration,
  {
    payload: AgentControlExternalIntegrationIdInput,
    success: AgentControlExternalIntegrationDeleteResult,
    error: Schema.Union([AgentControlExternalRpcError, AuthRpcError]),
  },
);

export const WsAgentControlListMcpInstallationsRpc = Rpc.make(
  AGENT_CONTROL_WS_METHODS.listMcpInstallations,
  {
    payload: Schema.Struct({}),
    success: AgentControlMcpInstallationListResult,
    error: Schema.Union([AgentControlExternalRpcError, AuthRpcError]),
  },
);

export const WsAgentControlConnectMcpInstallationRpc = Rpc.make(
  AGENT_CONTROL_WS_METHODS.connectMcpInstallation,
  {
    payload: AgentControlMcpInstallationConnectInput,
    success: AgentControlMcpInstallationMutationResult,
    error: Schema.Union([AgentControlExternalRpcError, AuthRpcError]),
  },
);

export const WsAgentControlRepairMcpInstallationRpc = Rpc.make(
  AGENT_CONTROL_WS_METHODS.repairMcpInstallation,
  {
    payload: AgentControlMcpInstallationIdInput,
    success: AgentControlMcpInstallationMutationResult,
    error: Schema.Union([AgentControlExternalRpcError, AuthRpcError]),
  },
);

export const WsAgentControlDisconnectMcpInstallationRpc = Rpc.make(
  AGENT_CONTROL_WS_METHODS.disconnectMcpInstallation,
  {
    payload: AgentControlMcpInstallationIdInput,
    success: AgentControlMcpInstallationMutationResult,
    error: Schema.Union([AgentControlExternalRpcError, AuthRpcError]),
  },
);

/** Keep declaration emit bounded as shared settings and RPC schemas grow. */
export const WsRpcGroup: RpcGroup.RpcGroup<
  | typeof WsServerGetConfigRpc
  | typeof WsServerGetAdvertisedEndpointsRpc
  | typeof WsServerGetDiagnosticsMetricsRpc
  | typeof WsServerGetStatisticsRpc
  | typeof WsServerGetUsageSummaryRpc
  | typeof WsServerRefreshProvidersRpc
  | typeof WsServerUpdateProviderRpc
  | typeof WsServerUpsertKeybindingRpc
  | typeof WsKeybindingsReplaceCustomRpc
  | typeof WsServerGetSettingsRpc
  | typeof WsServerUpdateSettingsRpc
  | typeof WsServerGetDiagnosticsSnapshotRpc
  | typeof WsServerSignalDiagnosticProcessRpc
  | typeof WsServerGetResourceTelemetryHistoryRpc
  | typeof WsServerRetryResourceTelemetryRpc
  | typeof WsServerDiscoverSourceControlRpc
  | typeof WsServerListOpinionatedPluginsRpc
  | typeof WsServerCheckOpinionatedPluginsRpc
  | typeof WsServerInstallOpinionatedPluginRpc
  | typeof WsMcpListWorkspacesRpc
  | typeof WsMcpListServersRpc
  | typeof WsMcpUpsertServerRpc
  | typeof WsMcpSetServerEnabledRpc
  | typeof WsMcpRemoveServerRpc
  | typeof WsMcpReloadServersRpc
  | typeof WsMcpStartOauthLoginRpc
  | typeof WsSourceControlLookupRepositoryRpc
  | typeof WsSourceControlSearchRepositoriesRpc
  | typeof WsSourceControlCloneRepositoryRpc
  | typeof WsSourceControlPublishRepositoryRpc
  | typeof WsSourceControlListIssuesRpc
  | typeof WsSourceControlGetIssueRpc
  | typeof WsSourceControlSearchIssuesRpc
  | typeof WsSourceControlListChangeRequestsRpc
  | typeof WsSourceControlSearchChangeRequestsRpc
  | typeof WsSourceControlGetChangeRequestDetailRpc
  | typeof WsSourceControlGetChangeRequestFilesViewedRpc
  | typeof WsSourceControlSetChangeRequestFileViewedRpc
  | typeof WsSourceControlGetChangeRequestDiffRpc
  | typeof WsSourceControlMergeChangeRequestRpc
  | typeof WsSourceControlCreateIssueRpc
  | typeof WsSourceControlAddIssueCommentRpc
  | typeof WsSourceControlAddIssueCommentReactionRpc
  | typeof WsSourceControlAddChangeRequestCommentRpc
  | typeof WsSourceControlAddChangeRequestCommentReactionRpc
  | typeof WsSourceControlListIssueLabelsRpc
  | typeof WsSourceControlListIssueAssigneesRpc
  | typeof WsSourceControlListWorkflowRunsRpc
  | typeof WsSourceControlGetWorkflowRunJobsRpc
  | typeof WsSourceControlGetWorkflowJobLogRpc
  | typeof WsSourceControlRerunWorkflowRpc
  | typeof WsTextGenerationGenerateIssueContentRpc
  | typeof WsTextGenerationGenerateBranchNameRpc
  | typeof WsAtlassianListConnectionsRpc
  | typeof WsAtlassianStartOAuthRpc
  | typeof WsAtlassianDisconnectRpc
  | typeof WsAtlassianRefreshRpc
  | typeof WsAtlassianListResourcesRpc
  | typeof WsAtlassianGetProjectLinkRpc
  | typeof WsAtlassianSaveProjectLinkRpc
  | typeof WsAtlassianSaveManualBitbucketTokenRpc
  | typeof WsAtlassianSaveManualJiraTokenRpc
  | typeof WsWorkItemsListProjectsRpc
  | typeof WsWorkItemsListRpc
  | typeof WsWorkItemsSearchRpc
  | typeof WsWorkItemsGetRpc
  | typeof WsWorkItemsAddCommentRpc
  | typeof WsWorkItemsEditCommentRpc
  | typeof WsWorkItemsUpdateRpc
  | typeof WsWorkItemsListTransitionsRpc
  | typeof WsWorkItemsTransitionRpc
  | typeof WsProjectsListEntriesRpc
  | typeof WsProjectsSearchEntriesRpc
  | typeof WsProjectsReadFileRpc
  | typeof WsProjectsReadIconRpc
  | typeof WsProjectsReadFileBinaryRpc
  | typeof WsProjectsWriteFileRpc
  | typeof WsProjectsStageFileReferenceRpc
  | typeof WsChatAttachmentsCreateFileUploadRpc
  | typeof WsChatAttachmentsReadChunkRpc
  | typeof WsShellOpenInEditorRpc
  | typeof WsFilesystemBrowseRpc
  | typeof WsSubscribeVcsStatusRpc
  | typeof WsVcsPullRpc
  | typeof WsVcsRefreshStatusRpc
  | typeof WsGitRunStackedActionRpc
  | typeof WsGitResolvePullRequestRpc
  | typeof WsGitPreparePullRequestThreadRpc
  | typeof WsGitCreateWorktreeForProjectRpc
  | typeof WsGitFindWorktreeForOriginRpc
  | typeof WsGitArchiveWorktreeRpc
  | typeof WsGitRestoreWorktreeRpc
  | typeof WsGitDeleteWorktreeRpc
  | typeof WsThreadsSetManualBucketRpc
  | typeof WsThreadsSetManualPositionRpc
  | typeof WsSearchThreadMessagesRpc
  | typeof WsThreadPriorityEnsureCurrentRpc
  | typeof WsWorktreesSetManualPositionRpc
  | typeof WsProjectsInitializeGitRpc
  | typeof WsVcsListRefsRpc
  | typeof WsVcsCreateWorktreeRpc
  | typeof WsVcsRemoveWorktreeRpc
  | typeof WsVcsCreateRefRpc
  | typeof WsVcsSwitchRefRpc
  | typeof WsVcsInitRpc
  | typeof WsTerminalOpenRpc
  | typeof WsTerminalWriteRpc
  | typeof WsTerminalResizeRpc
  | typeof WsTerminalClearRpc
  | typeof WsTerminalRestartRpc
  | typeof WsTerminalCloseRpc
  | typeof WsSubscribeTerminalEventsRpc
  | typeof WsSubscribeServerConfigRpc
  | typeof WsSubscribeServerLifecycleRpc
  | typeof WsSubscribeAuthAccessRpc
  | typeof WsAgentControlListProposalsRpc
  | typeof WsAgentControlGetProposalRpc
  | typeof WsAgentControlAcceptProposalRpc
  | typeof WsAgentControlRejectProposalRpc
  | typeof WsAgentControlSubscribeProposalsRpc
  | typeof WsAgentControlListIntegrationsRpc
  | typeof WsAgentControlCreateIntegrationRpc
  | typeof WsAgentControlUpdateIntegrationRpc
  | typeof WsAgentControlResumeIntegrationPairingRpc
  | typeof WsAgentControlRevokeIntegrationRpc
  | typeof WsAgentControlDeleteIntegrationRpc
  | typeof WsAgentControlListMcpInstallationsRpc
  | typeof WsAgentControlConnectMcpInstallationRpc
  | typeof WsAgentControlRepairMcpInstallationRpc
  | typeof WsAgentControlDisconnectMcpInstallationRpc
  | typeof WsOrchestrationDispatchCommandRpc
  | typeof WsOrchestrationGetWorkflowScriptRpc
  | typeof WsOrchestrationGetTaskOutputRpc
  | typeof WsOrchestrationStopBackgroundTaskRpc
  | typeof WsOrchestrationGetTurnDiffRpc
  | typeof WsOrchestrationGetFullThreadDiffRpc
  | typeof WsOrchestrationSearchThreadMessagesRpc
  | typeof WsOrchestrationGetThreadWindowRpc
  | typeof WsOrchestrationGetThreadHistoryPageRpc
  | typeof WsOrchestrationReplayEventsRpc
  | typeof WsOrchestrationReplayEventsPageRpc
  | typeof WsOrchestrationSubscribeShellRpc
  | typeof WsOrchestrationSubscribeThreadRpc
  | typeof WsOrchestrationSubscribeThreadWindowRpc
  | typeof WsContextHandoffGetInspectionSummaryRpc
  | typeof WsContextHandoffListInspectionEntriesRpc
  | typeof WsContextHandoffReadRawPayloadChunkRpc
  | typeof WsContextHandoffReadExportChunkRpc
> = RpcGroup.make(
  WsServerGetConfigRpc,
  WsServerGetAdvertisedEndpointsRpc,
  WsServerGetDiagnosticsMetricsRpc,
  WsServerGetStatisticsRpc,
  WsServerGetUsageSummaryRpc,
  WsServerRefreshProvidersRpc,
  WsServerUpdateProviderRpc,
  WsServerUpsertKeybindingRpc,
  WsKeybindingsReplaceCustomRpc,
  WsServerGetSettingsRpc,
  WsServerUpdateSettingsRpc,
  WsServerGetDiagnosticsSnapshotRpc,
  WsServerSignalDiagnosticProcessRpc,
  WsServerGetResourceTelemetryHistoryRpc,
  WsServerRetryResourceTelemetryRpc,
  WsServerDiscoverSourceControlRpc,
  WsServerListOpinionatedPluginsRpc,
  WsServerCheckOpinionatedPluginsRpc,
  WsServerInstallOpinionatedPluginRpc,
  WsMcpListWorkspacesRpc,
  WsMcpListServersRpc,
  WsMcpUpsertServerRpc,
  WsMcpSetServerEnabledRpc,
  WsMcpRemoveServerRpc,
  WsMcpReloadServersRpc,
  WsMcpStartOauthLoginRpc,
  WsSourceControlLookupRepositoryRpc,
  WsSourceControlSearchRepositoriesRpc,
  WsSourceControlCloneRepositoryRpc,
  WsSourceControlPublishRepositoryRpc,
  WsSourceControlListIssuesRpc,
  WsSourceControlGetIssueRpc,
  WsSourceControlSearchIssuesRpc,
  WsSourceControlListChangeRequestsRpc,
  WsSourceControlSearchChangeRequestsRpc,
  WsSourceControlGetChangeRequestDetailRpc,
  WsSourceControlGetChangeRequestFilesViewedRpc,
  WsSourceControlSetChangeRequestFileViewedRpc,
  WsSourceControlGetChangeRequestDiffRpc,
  WsSourceControlMergeChangeRequestRpc,
  WsSourceControlCreateIssueRpc,
  WsSourceControlAddIssueCommentRpc,
  WsSourceControlAddIssueCommentReactionRpc,
  WsSourceControlAddChangeRequestCommentRpc,
  WsSourceControlAddChangeRequestCommentReactionRpc,
  WsSourceControlListIssueLabelsRpc,
  WsSourceControlListIssueAssigneesRpc,
  WsSourceControlListWorkflowRunsRpc,
  WsSourceControlGetWorkflowRunJobsRpc,
  WsSourceControlGetWorkflowJobLogRpc,
  WsSourceControlRerunWorkflowRpc,
  WsTextGenerationGenerateIssueContentRpc,
  WsTextGenerationGenerateBranchNameRpc,
  WsAtlassianListConnectionsRpc,
  WsAtlassianStartOAuthRpc,
  WsAtlassianDisconnectRpc,
  WsAtlassianRefreshRpc,
  WsAtlassianListResourcesRpc,
  WsAtlassianGetProjectLinkRpc,
  WsAtlassianSaveProjectLinkRpc,
  WsAtlassianSaveManualBitbucketTokenRpc,
  WsAtlassianSaveManualJiraTokenRpc,
  WsWorkItemsListProjectsRpc,
  WsWorkItemsListRpc,
  WsWorkItemsSearchRpc,
  WsWorkItemsGetRpc,
  WsWorkItemsAddCommentRpc,
  WsWorkItemsEditCommentRpc,
  WsWorkItemsUpdateRpc,
  WsWorkItemsListTransitionsRpc,
  WsWorkItemsTransitionRpc,
  WsProjectsListEntriesRpc,
  WsProjectsSearchEntriesRpc,
  WsProjectsReadFileRpc,
  WsProjectsReadIconRpc,
  WsProjectsReadFileBinaryRpc,
  WsProjectsWriteFileRpc,
  WsProjectsStageFileReferenceRpc,
  WsChatAttachmentsCreateFileUploadRpc,
  WsChatAttachmentsReadChunkRpc,
  WsShellOpenInEditorRpc,
  WsFilesystemBrowseRpc,
  WsSubscribeVcsStatusRpc,
  WsVcsPullRpc,
  WsVcsRefreshStatusRpc,
  WsGitRunStackedActionRpc,
  WsGitResolvePullRequestRpc,
  WsGitPreparePullRequestThreadRpc,
  WsGitCreateWorktreeForProjectRpc,
  WsGitFindWorktreeForOriginRpc,
  WsGitArchiveWorktreeRpc,
  WsGitRestoreWorktreeRpc,
  WsGitDeleteWorktreeRpc,
  WsThreadsSetManualBucketRpc,
  WsThreadsSetManualPositionRpc,
  WsSearchThreadMessagesRpc,
  WsThreadPriorityEnsureCurrentRpc,
  WsWorktreesSetManualPositionRpc,
  WsProjectsInitializeGitRpc,
  WsVcsListRefsRpc,
  WsVcsCreateWorktreeRpc,
  WsVcsRemoveWorktreeRpc,
  WsVcsCreateRefRpc,
  WsVcsSwitchRefRpc,
  WsVcsInitRpc,
  WsTerminalOpenRpc,
  WsTerminalWriteRpc,
  WsTerminalResizeRpc,
  WsTerminalClearRpc,
  WsTerminalRestartRpc,
  WsTerminalCloseRpc,
  WsSubscribeTerminalEventsRpc,
  WsSubscribeServerConfigRpc,
  WsSubscribeServerLifecycleRpc,
  WsSubscribeAuthAccessRpc,
  WsAgentControlListProposalsRpc,
  WsAgentControlGetProposalRpc,
  WsAgentControlAcceptProposalRpc,
  WsAgentControlRejectProposalRpc,
  WsAgentControlSubscribeProposalsRpc,
  WsAgentControlListIntegrationsRpc,
  WsAgentControlCreateIntegrationRpc,
  WsAgentControlUpdateIntegrationRpc,
  WsAgentControlResumeIntegrationPairingRpc,
  WsAgentControlRevokeIntegrationRpc,
  WsAgentControlDeleteIntegrationRpc,
  WsAgentControlListMcpInstallationsRpc,
  WsAgentControlConnectMcpInstallationRpc,
  WsAgentControlRepairMcpInstallationRpc,
  WsAgentControlDisconnectMcpInstallationRpc,
  WsOrchestrationDispatchCommandRpc,
  WsOrchestrationGetWorkflowScriptRpc,
  WsOrchestrationGetTaskOutputRpc,
  WsOrchestrationStopBackgroundTaskRpc,
  WsOrchestrationGetTurnDiffRpc,
  WsOrchestrationGetFullThreadDiffRpc,
  WsOrchestrationSearchThreadMessagesRpc,
  WsOrchestrationGetThreadWindowRpc,
  WsOrchestrationGetThreadHistoryPageRpc,
  WsOrchestrationReplayEventsRpc,
  WsOrchestrationReplayEventsPageRpc,
  WsOrchestrationSubscribeShellRpc,
  WsOrchestrationSubscribeThreadRpc,
  WsOrchestrationSubscribeThreadWindowRpc,
  WsContextHandoffGetInspectionSummaryRpc,
  WsContextHandoffListInspectionEntriesRpc,
  WsContextHandoffReadRawPayloadChunkRpc,
  WsContextHandoffReadExportChunkRpc,
);

/**
 * Hosted relay channels carry both groups through one lifecycle-owned encrypted
 * channel. Direct clients keep the device group on its own low-priority socket
 * so video-adjacent work cannot contend with chat RPC. The explicit annotation
 * keeps the merged RPC union within the compiler's serializable type limit.
 */
export const WsHostedRpcGroup: RpcGroup.RpcGroup<
  RpcGroup.Rpcs<typeof WsRpcGroup> | RpcGroup.Rpcs<typeof WsDeviceRpcGroup>
> = WsRpcGroup.merge(WsDeviceRpcGroup);
