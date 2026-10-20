import {
  type EnvironmentId,
  type EditorId,
  type ProjectId,
  type ProjectScript,
  type ResolvedKeybindingsConfig,
} from "@ryco/contracts";
import { memo, useMemo } from "react";
import { ListChecksIcon, PanelRightIcon } from "lucide-react";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import ProjectScriptsControl, { type NewProjectScriptInput } from "../ProjectScriptsControl";
import { Toggle } from "../ui/toggle";
import { OpenInPicker } from "./OpenInPicker";
import { usePrimaryEnvironmentId } from "../../environments/primary";
import { HostedThreadConnectionBadge } from "../hostedHub/HostedConnectionControls";
import { ChatHeaderBar, type ChatHeaderBarProps } from "./ChatHeaderBar";
import type { ChatHeaderBreadcrumbProjectIcon } from "./ChatHeaderBreadcrumb";
import type { ChatProjectTarget } from "./ChatProjectActions";
import { HEADER_CHROME_ICON_BUTTON_CLASS_NAME } from "./headerChrome";
import type { LinkedWorktreeItem } from "../worktrees/LinkedWorktreeItemDialog";
import { usePerfMark, useDevPropDiff } from "../../perf/tabSwitchInstrumentation";
import { formatLiveAgentCount, LiveAgentCountBadge } from "../LiveAgentCountBadge";
import { preloadWorkspacePanelForIntent } from "../../workspacePanelPreload";

interface ChatHeaderProps {
  activeThreadEnvironmentId: EnvironmentId;
  activeThreadTitle: string;
  activeProjectName: string | undefined;
  /**
   * The project's identity for the breadcrumb's artwork. Primitives, not one
   * object, so the memoized header does not re-render on every parent pass.
   */
  activeProjectId?: ProjectId | null;
  activeProjectCwd?: string | null;
  activeProjectAvatarContentHash?: string | null;
  isGitRepo: boolean;
  /** The "No project" chat this thread lives in, if any (chat actions replace Git chrome). */
  chatProject?: ChatProjectTarget | null;
  openInCwd: string | null;
  activeProjectScripts: ProjectScript[] | undefined;
  preferredScriptId: string | null;
  keybindings: ResolvedKeybindingsConfig;
  availableEditors: ReadonlyArray<EditorId>;
  // New, optional props for the breadcrumb. When omitted the header still
  // renders correctly with degraded info (no worktree segment, no
  // source-control counts).
  worktreeIssueNumber?: number | null;
  worktreePrNumber?: number | null;
  worktreeIssueState?: "open" | "closed" | null;
  worktreePrState?: "open" | "closed" | "merged" | null;
  worktreePrIsDraft?: boolean | null;
  worktreePullRequests?: ChatHeaderBarProps["worktreePullRequests"];
  worktreePrUrl?: string | null;
  worktreePullRequestsToggle?: ChatHeaderBarProps["worktreePullRequestsToggle"];
  worktreePullRequestBadgeRef?: ChatHeaderBarProps["worktreePullRequestBadgeRef"];
  worktreeWorkItemProvider?: "jira" | null;
  worktreeWorkItemKey?: string | null;
  worktreeWorkItemState?: "open" | "in_progress" | "done" | "closed" | "unknown" | null;
  worktreeWorkItemStateName?: string | null;
  onSelectProject?: () => void;
  onOpenLinkedWorktreeItem?: (item: LinkedWorktreeItem) => void;
  workspacePanelOpen: boolean;
  /** Running/pending + waiting agents; pass zero while the roster is visible. */
  liveAgentCount: number;
  onToggleWorkspacePanel: () => void;
  overviewSidebarOpen: boolean;
  onToggleOverviewSidebar: (open?: boolean) => void;
  onRunProjectScript: (script: ProjectScript) => void;
  onAddProjectScript: (input: NewProjectScriptInput) => Promise<void>;
  onUpdateProjectScript: (scriptId: string, input: NewProjectScriptInput) => Promise<void>;
  onDeleteProjectScript: (scriptId: string) => Promise<void>;
}

/**
 * "Open in" needs a folder on this machine. The project's name is no proxy: an
 * unsent chat draft is already labelled "No project" but has no folder yet.
 */
export function shouldShowOpenInPicker(input: {
  readonly openInCwd: string | null;
  readonly activeThreadEnvironmentId: EnvironmentId;
  readonly primaryEnvironmentId: EnvironmentId | null;
}): boolean {
  return (
    input.openInCwd !== null &&
    input.primaryEnvironmentId !== null &&
    input.activeThreadEnvironmentId === input.primaryEnvironmentId
  );
}

export const ChatHeader = memo(function ChatHeader({
  worktreePullRequestBadgeRef,
  ...props
}: ChatHeaderProps) {
  usePerfMark("ChatHeader");
  useDevPropDiff(props as unknown as Record<string, unknown>, "ChatHeader");
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const showOpenInPicker = shouldShowOpenInPicker({
    openInCwd: props.openInCwd,
    activeThreadEnvironmentId: props.activeThreadEnvironmentId,
    primaryEnvironmentId,
  });

  const { activeThreadEnvironmentId, activeProjectId, activeProjectCwd } = props;
  const activeProjectAvatarContentHash = props.activeProjectAvatarContentHash ?? null;
  const projectIcon = useMemo<ChatHeaderBreadcrumbProjectIcon | null>(
    () =>
      activeProjectId && activeProjectCwd
        ? {
            environmentId: activeThreadEnvironmentId,
            cwd: activeProjectCwd,
            projectId: activeProjectId,
            customAvatarContentHash: activeProjectAvatarContentHash,
          }
        : null,
    [activeProjectAvatarContentHash, activeProjectCwd, activeProjectId, activeThreadEnvironmentId],
  );

  const inlineActions = (
    <>
      {/* The open thread's own node and connection, whichever node the
          hosted selection is on. In the header's flow, so it can never overlap
          the other header controls; renders nothing outside hosted-hub
          sessions. */}
      <HostedThreadConnectionBadge environmentId={props.activeThreadEnvironmentId} />
      <Tooltip>
        <TooltipTrigger
          render={
            <Toggle
              pressed={props.overviewSidebarOpen}
              onPressedChange={props.onToggleOverviewSidebar}
              aria-label="Toggle overview panel"
              className={HEADER_CHROME_ICON_BUTTON_CLASS_NAME}
              size="sm"
            >
              <ListChecksIcon className="size-4" />
            </Toggle>
          }
        />
        <TooltipPopup side="bottom">Toggle overview panel</TooltipPopup>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          render={
            <Toggle
              pressed={props.workspacePanelOpen}
              onPressedChange={props.onToggleWorkspacePanel}
              onPointerEnter={preloadWorkspacePanelForIntent}
              onFocus={preloadWorkspacePanelForIntent}
              aria-label={
                props.liveAgentCount > 0
                  ? `Toggle workspace panel, ${formatLiveAgentCount(props.liveAgentCount)}`
                  : "Toggle workspace panel"
              }
              className={HEADER_CHROME_ICON_BUTTON_CLASS_NAME}
              size="sm"
            >
              <span className="relative inline-flex">
                <PanelRightIcon className="size-4" />
                <LiveAgentCountBadge
                  count={props.liveAgentCount}
                  className="-top-2 -right-2.5 h-3.5 min-w-3.5 px-0.5 text-[8px]"
                />
              </span>
            </Toggle>
          }
        />
        <TooltipPopup side="bottom">
          {props.liveAgentCount > 0
            ? `Workspace · ${formatLiveAgentCount(props.liveAgentCount)}`
            : "Toggle workspace panel"}
        </TooltipPopup>
      </Tooltip>
      {props.activeProjectScripts ? (
        <ProjectScriptsControl
          scripts={props.activeProjectScripts}
          keybindings={props.keybindings}
          preferredScriptId={props.preferredScriptId}
          onRunScript={props.onRunProjectScript}
          onAddScript={props.onAddProjectScript}
          onUpdateScript={props.onUpdateProjectScript}
          onDeleteScript={props.onDeleteProjectScript}
        />
      ) : null}
      {showOpenInPicker ? (
        <OpenInPicker
          keybindings={props.keybindings}
          availableEditors={props.availableEditors}
          openInCwd={props.openInCwd}
        />
      ) : null}
    </>
  );

  return (
    <div className="flex min-w-0 flex-1 items-center gap-2 py-3">
      <ChatHeaderBar
        projectName={props.activeProjectName}
        projectIcon={projectIcon}
        isGitRepo={props.isGitRepo}
        chatProject={props.chatProject ?? null}
        worktreeIssueNumber={props.worktreeIssueNumber}
        worktreeIssueState={props.worktreeIssueState}
        worktreePrNumber={props.worktreePrNumber}
        worktreePrState={props.worktreePrState}
        worktreePrIsDraft={props.worktreePrIsDraft}
        worktreePrUrl={props.worktreePrUrl}
        worktreePullRequests={props.worktreePullRequests}
        worktreePullRequestsToggle={props.worktreePullRequestsToggle}
        worktreePullRequestBadgeRef={worktreePullRequestBadgeRef}
        worktreeWorkItemProvider={props.worktreeWorkItemProvider}
        worktreeWorkItemKey={props.worktreeWorkItemKey}
        worktreeWorkItemState={props.worktreeWorkItemState}
        worktreeWorkItemStateName={props.worktreeWorkItemStateName}
        sessionTitle={props.activeThreadTitle}
        {...(props.onSelectProject ? { onSelectProject: props.onSelectProject } : {})}
        {...(props.onOpenLinkedWorktreeItem
          ? { onOpenLinkedWorktreeItem: props.onOpenLinkedWorktreeItem }
          : {})}
        inlineActions={inlineActions}
      />
    </div>
  );
});
