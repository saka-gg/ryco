/**
 * Web modules (relative to `apps/web`) and the functions in them the React
 * Compiler skips today, checked by `reactCompilerCoverage.test.ts` against
 * what the compiler reports for every module the web build compiles.
 *
 * The list only shrinks. Fix a new bailout, or opt the function out with a
 * `"use no memo"` that says why (and an `OPTED_OUT` entry); never add an entry
 * here to make a new bailout pass. When a listed function starts to compile,
 * remove it.
 */
export const KNOWN_BAILOUTS: Readonly<Record<string, ReadonlyArray<string>>> = {
  "src/browser/BackgroundBrowserPreview.tsx": ["BackgroundBrowserPreview"],
  "src/browser/BrowserPanel.tsx": ["BrowserPanel"],
  "src/browser/browserState.ts": ["useProjectBrowserTabs"],
  "src/components/ChatMarkdown.tsx": ["RenderedChatMarkdown"],
  "src/components/CommandPalette.tsx": ["CommandPalette"],
  "src/components/CommandPaletteDialog.tsx": ["OpenCommandPaletteDialog"],
  "src/components/DesktopAccountConnect.tsx": ["DesktopAccountConnect"],
  "src/components/DiffImagePreview.tsx": ["useDiffImages"],
  "src/components/PreviewPanel.tsx": ["PreviewPanel"],
  "src/components/PullRequestThreadDialog.tsx": ["PullRequestThreadDialog"],
  "src/components/RootAppShell.tsx": ["EnvironmentConnectionManagerBootstrap"],
  "src/components/ThreadTerminalDrawer.tsx": ["TerminalViewport"],
  "src/components/agent-control/useAgentControlDecisions.ts": ["useAgentControlDecisions"],
  "src/components/agents/agentRoster.tsx": ["AgentMonogramStack"],
  "src/components/auth/PairingRouteSurface.tsx": [
    "HostedPairingRouteSurface",
    "PairingRouteSurface",
  ],
  "src/components/automations/useAutomationCentre.ts": ["useAutomationCentre"],
  "src/components/chat/AttachmentDocumentPreview.tsx": ["TextAttachmentPreview"],
  "src/components/chat/ChatPanes.tsx": ["ChatPanes"],
  "src/components/chat/ContextHandoffInspectionPanel.tsx": ["ContextHandoffInspectionPanel"],
  "src/components/chat/OptionalQuestionCard.tsx": ["OptionalQuestionCard"],
  "src/components/chat/PaneFocus.tsx": ["usePaneEffect"],
  "src/components/chat/PdfAttachmentPreview.tsx": ["PdfAttachmentPreview"],
  "src/components/chat/PromoteChatDialog.tsx": ["PromoteChatDialogBody"],
  "src/components/chat/SourcePickerPanel.tsx": ["BranchSourceList"],
  "src/components/chat/TerminalSnippetActions.tsx": ["TerminalSnippetActions"],
  "src/components/chat/TranscriptSelectionActions.tsx": ["TranscriptSelectionActions"],
  "src/components/chat/WorkChapterRow.tsx": ["LiveElapsed"],
  "src/components/chat/usageLimitBanner.tsx": ["useUsageLimitBannerItem"],
  "src/components/chat/useAttachmentSource.ts": ["useAttachmentSource"],
  "src/components/chat/useChatAttachmentPreviewHandoff.ts": ["useChatAttachmentPreviewHandoff"],
  "src/components/chat/useChatPendingUserInput.ts": ["useChatPendingUserInput"],
  "src/components/chat/useChatProjectScripts.ts": ["useChatProjectScripts"],
  "src/components/chat/useCrownShipBinding.tsx": ["useCrownShipBinding"],
  "src/components/chat/useQuoteSourceHighlight.ts": ["useQuoteSourceHighlight"],
  "src/components/chat/useThreadPlanCatalog.ts": ["useThreadPlanCatalog"],
  "src/components/chat/worktreeLaunch/WorktreeSetupCard.tsx": ["LiveSeconds"],
  "src/components/desktop/SshPasswordPromptDialog.tsx": ["SshPasswordPromptDialog"],
  "src/components/device/SimulatorPanel.tsx": ["SimulatorPanel"],
  "src/components/device/SimulatorTestingDrawer.tsx": ["SimulatorTestingDrawer"],
  "src/components/device/useDeviceScreenshotStream.ts": ["useDeviceScreenshotStream"],
  "src/components/device/useDeviceVideoStream.ts": ["useDeviceVideoStream"],
  "src/components/hostedHub/HostedNativeAuthorizationRoute.tsx": ["HostedNativeAuthorizationRoute"],
  "src/components/hostedHub/HostedNodeEnrollment.tsx": ["HostedNodeEnrollmentFlow"],
  "src/components/hostedHub/HostedNodeRevokeDialog.tsx": ["HostedNodeRevokeDialog"],
  "src/components/hostedHub/PublicAccountFlows.tsx": [
    "ExternalIdentitySignupFlow",
    "PasswordLoginFlow",
    "PasswordResetFlow",
    "PublicSignupFlow",
    "RecoveryCodeFlow",
  ],
  "src/components/onboarding/OnboardingDialog.tsx": ["OnboardingDialog"],
  "src/components/overview/notes/useWorktreeNotes.ts": ["useWorktreeNotes"],
  "src/components/projectExplorer/CommentThread.tsx": ["CommentComposer", "CommentReactionBar"],
  "src/components/projectExplorer/IssuesTab.tsx": ["IssuesTab"],
  "src/components/projectExplorer/PullRequestsTab.tsx": ["PullRequestsTab"],
  "src/components/projectExplorer/WorkItemsTab.tsx": ["WorkItemsTab"],
  "src/components/projectExplorer/WorkflowRunsSection.tsx": ["useWorkflowRerunAction"],
  "src/components/projects/detail/ProjectHero.tsx": ["ProjectImage"],
  "src/components/projects/map/ProjectMap.tsx": ["ProjectMap"],
  "src/components/projects/sections/ProjectDangerSection.tsx": ["ProjectDangerSection"],
  "src/components/projects/sections/ProjectInstructionsSection.tsx": ["ProjectInstructionsSection"],
  "src/components/projects/sections/ProjectLocationSection.tsx": ["ProjectLocationSection"],
  "src/components/projects/sections/ProjectRepositorySection.tsx": ["ProjectRepositorySection"],
  "src/components/pullRequests/agentHandoff.ts": ["usePullRequestAgentHandoff"],
  "src/components/pullRequests/checks/ChecksTab.tsx": ["ChecksTab"],
  "src/components/pullRequests/conversation/TimelineComposer.tsx": ["TimelineComposer"],
  "src/components/pullRequests/list/ListHeader.tsx": ["SearchField"],
  "src/components/pullRequests/rail/useMergeCommands.ts": ["useMergeCommands"],
  "src/components/pullRequests/testing/PullRequestsTestProvider.tsx": ["PullRequestsTestProvider"],
  "src/components/pullRequests/testing/sourceControlRpcMock.ts": ["useFixtureQuery"],
  "src/components/pullRequests/threads/CommentReactions.tsx": ["CommentReactions"],
  "src/components/pullRequests/threads/ReplyComposer.tsx": ["ReplyComposer"],
  "src/components/pullRequests/threads/ReviewThread.tsx": ["ReviewThread"],
  "src/components/routeViews/DraftChatThreadRouteView.tsx": ["DraftChatThreadRouteView"],
  "src/components/settings/AccountSettings.tsx": ["PasskeysSection"],
  "src/components/settings/AcpRegistryAuthentication.tsx": ["AcpRegistryAuthenticationContent"],
  "src/components/settings/AcpRegistrySettings.tsx": ["AcpRegistrySettings"],
  "src/components/settings/AgentControlMcpInstallations.tsx": ["AgentControlMcpInstallations"],
  "src/components/settings/AiFocusSettings.tsx": ["EnvironmentModelControl"],
  "src/components/settings/ChatsFolderSettings.tsx": ["useChatsSettingsSave"],
  "src/components/settings/ComputerBetaSettings.tsx": ["ComputerBetaSettings"],
  "src/components/settings/ComputerUseSettings.tsx": ["ComputerUseSettings"],
  "src/components/settings/ConnectionsSettings.tsx": [
    "AuthorizedClientsHeaderAction",
    "ConnectionsSettings",
  ],
  "src/components/settings/DesktopConversationCacheRow.tsx": ["DesktopConversationCacheRow"],
  "src/components/settings/DesktopKeepAwakeRow.tsx": ["DesktopKeepAwakeRow"],
  "src/components/settings/DeviceIconPicker.tsx": ["DeviceIconPicker"],
  "src/components/settings/DeviceIdentitySettings.tsx": ["DeviceIdentitySettings"],
  "src/components/settings/DiagnosticsSettings.tsx": ["DiagnosticsSettingsContent"],
  "src/components/settings/HubSection.tsx": ["HubSection"],
  "src/components/settings/IntegrationsSettings.tsx": ["ExternalIntegrationsSettings"],
  "src/components/settings/KeybindingsSettings.tsx": ["KeybindingsSettingsPanel"],
  "src/components/settings/McpServersSettings.tsx": ["McpServerDialog", "McpServersSettings"],
  "src/components/settings/NodeSecuritySettings.tsx": ["PrimaryNodeSecuritySettings"],
  "src/components/settings/ProcessDiagnosticsSection.tsx": ["ProcessDiagnosticsSection"],
  "src/components/settings/ProjectPreferenceSettings.tsx": ["ProjectPreferenceEditor"],
  "src/components/settings/ResourceTelemetryDiagnostics.tsx": ["ResourceTelemetryDiagnostics"],
  "src/components/settings/SessionImportPanel.tsx": ["SessionImportPanel"],
  "src/components/settings/StorageSettings.tsx": ["StorageEditor"],
  "src/components/settings/WorktreeRootSettings.tsx": ["WorktreeRootEditor"],
  "src/components/settings/WorktreeSubmoduleSettings.tsx": ["WorktreeSubmoduleEditor"],
  "src/components/settings/lifecycleSuggestionPolicy.ts": ["useLifecycleSuggestionPolicyEditor"],
  "src/components/settings/useDesktopRelaunchGuard.tsx": ["useDesktopRelaunchGuard"],
  "src/components/settings/useSettingsSubsections.ts": ["useSettingsSubsections"],
  "src/components/shell/phone/ContextMenuActionSheetHost.tsx": ["ContextMenuActionSheetHost"],
  "src/components/shell/phone/PhoneHome.tsx": ["PhoneHomeProjectSection"],
  "src/components/shell/phone/PhoneThreadDock.tsx": ["PhoneThreadDock"],
  "src/components/sidebar/ProjectSettingsDialog.tsx": ["ProjectSettingsGeneralSection"],
  "src/components/worktrees/NewWorktreeDialog.tsx": [
    "BranchRefPicker",
    "BranchesTab",
    "NewBranchTab",
    "NewWorktreeDialog",
    "useWorktreeBranchRefs",
  ],
  "src/hooks/useChatSessionActions.ts": ["useChatSessionActions"],
  "src/hooks/useCopyToClipboard.ts": ["useCopyToClipboard"],
  "src/hooks/useLongPress.ts": ["useLongPress"],
  "src/hooks/useThreadActions.ts": ["useThreadActions"],
  "src/hooks/useThreadExportAction.tsx": ["useThreadExportAction"],
  "src/hooks/useThreadRightPanelRouteState.ts": ["useThreadRightPanelRouteState"],
  "src/routes/__root.tsx": ["RootRouteView"],
  "src/rpc/queryClient.ts": ["useMutation", "useQuery", "useSelectMemo"],
  "src/rpc/serverState.ts": ["useLatestAtomSubscription"],
  "src/rpc/useAtlassian.ts": ["useAtlassianQueryBatch"],
  "src/rpc/useGit.ts": ["useGitMutation"],
  "src/rpc/useProject.ts": ["useFilesystemBrowse"],
  "src/rpc/useSourceControl.ts": [
    "useSourceControlMutation",
    "useSourceControlWorkflowRunJobsBatch",
    "useWatchedQuery",
  ],
  "src/rpc/useWorkItems.ts": ["useAsyncMutation"],
};

/**
 * Kept uncompiled when the web build moved from Babel's React Compiler to
 * Oxc's: Babel never compiled these, Oxc can, and their render reads (module
 * state, refs, storage) have not been audited yet. Each removal is its own
 * change with a test of the component's behaviour.
 */
const PARITY =
  "Babel's React Compiler never compiled it; its render reads are not yet audited for purity.";

/**
 * Functions that opt out of the React Compiler with a `"use no memo"`
 * directive, and why. Every directive needs an entry here, and every entry a
 * directive, so an opt-out is always deliberate and reviewed.
 */
export const OPTED_OUT: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  "src/components/ChatView.tsx": {
    ChatView: "The compiler cannot preserve its manual memoization.",
  },
  "src/components/ProjectScriptDialog.tsx": {
    ProjectScriptDialog: PARITY,
  },
  "src/components/chat/MessagesTimeline.tsx": {
    UserMessageBody:
      "Its search highlight cursor counts matches in render order; a cached body replays stale indexes.",
  },
  "src/components/chat/useComposerImageAttachments.ts": {
    useComposerImageAttachments: PARITY,
  },
  "src/components/hostedHub/HostedHubRoot.tsx": {
    HostedAuthenticationSurface: PARITY,
  },
  "src/components/issues/NewIssueDialog.tsx": {
    NewIssueDialog: PARITY,
  },
  "src/components/projects/sections/ProjectWorkspacesSection.tsx": {
    ProjectWorkspacesSection: PARITY,
  },
  "src/components/projects/sections/WorkspaceReview.tsx": {
    WorkspaceReview: PARITY,
  },
  "src/components/pullRequests/files/ReviewSubmitPopover.tsx": {
    ReviewSubmitPopover: PARITY,
  },
  "src/components/pullRequests/rail/MergeThroughPopover.tsx": {
    MergeThroughForm: PARITY,
  },
  "src/components/pullRequests/testing/sourceControlRpcMock.ts": {
    useMockMutation: PARITY,
  },
  "src/components/settings/AddProviderInstanceDialog.tsx": {
    AddProviderInstanceDialog: PARITY,
  },
  "src/components/settings/AppearanceSettings.tsx": {
    AppearanceSettingsPanel:
      "It reads theme and appearance state from module storage during render; compiled, it shows stale values.",
  },
  "src/components/settings/CliProxyHubSettings.tsx": {
    CliProxyHubDialog: PARITY,
  },
  "src/components/sidebar/hooks/useSidebarProjectSettingsDialog.ts": {
    useSidebarProjectSettingsDialog: PARITY,
  },
  "src/components/statistics/limits/useSubscriptionLimits.ts": {
    useSubscriptionLimits: PARITY,
  },
  "src/hooks/useLocalStorage.ts": {
    useLocalStorage: PARITY,
  },
  "src/hooks/useProjectScriptMutations.ts": {
    useProjectScriptMutations: PARITY,
  },
  "src/lib/preloadableLazy.ts": {
    useLazyComponentReady:
      "It reads module state that changes without a re-render (whether a chunk has loaded).",
  },
};
