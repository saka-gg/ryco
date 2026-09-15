import {
  type EnvironmentId,
  type EditorId,
  type ProjectScript,
  type ResolvedKeybindingsConfig,
} from "@ryco/contracts";
import { memo } from "react";
import { ListChecksIcon, PanelRightIcon } from "lucide-react";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import ProjectScriptsControl, { type NewProjectScriptInput } from "../ProjectScriptsControl";
import { Toggle } from "../ui/toggle";
import { OpenInPicker } from "./OpenInPicker";
import { usePrimaryEnvironmentId } from "../../environments/primary";
import { HostedNodeMenu } from "../hostedHub/HostedConnectionControls";
import { ChatHeaderBar } from "./ChatHeaderBar";
import type { WorktreeOriginLike } from "./ChatHeaderBreadcrumb.logic";
import { HEADER_CHROME_ICON_BUTTON_CLASS_NAME } from "./headerChrome";
import type { LinkedWorktreeItem } from "../worktrees/LinkedWorktreeItemDialog";
import { usePerfMark, useDevPropDiff } from "../../perf/tabSwitchInstrumentation";
import { formatLiveAgentCount, LiveAgentCountBadge } from "../LiveAgentCountBadge";

interface ChatHeaderProps {
  activeThreadEnvironmentId: EnvironmentId;
  activeThreadTitle: string;
  activeProjectName: string | undefined;
  isGitRepo: boolean;
  openInCwd: string | null;
  activeProjectScripts: ProjectScript[] | undefined;
  preferredScriptId: string | null;
  keybindings: ResolvedKeybindingsConfig;
  availableEditors: ReadonlyArray<EditorId>;
  // New, optional props for the breadcrumb. When omitted the header still
  // renders correctly with degraded info (no worktree segment, no
  // source-control counts).
  worktreeBranch?: string | null;
  worktreeTitle?: string | null;
  worktreeOrigin?: WorktreeOriginLike;
  worktreeIssueNumber?: number | null;
  worktreePrNumber?: number | null;
  worktreeIssueState?: "open" | "closed" | null;
  worktreePrState?: "open" | "closed" | "merged" | null;
  worktreePrIsDraft?: boolean | null;
  worktreeWorkItemProvider?: "jira" | null;
  worktreeWorkItemKey?: string | null;
  worktreeWorkItemState?: "open" | "in_progress" | "done" | "closed" | "unknown" | null;
  worktreeWorkItemStateName?: string | null;
  onSelectProject?: () => void;
  onSelectWorktree?: () => void;
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

export function shouldShowOpenInPicker(input: {
  readonly activeProjectName: string | undefined;
  readonly activeThreadEnvironmentId: EnvironmentId;
  readonly primaryEnvironmentId: EnvironmentId | null;
}): boolean {
  return (
    Boolean(input.activeProjectName) &&
    input.primaryEnvironmentId !== null &&
    input.activeThreadEnvironmentId === input.primaryEnvironmentId
  );
}

export const ChatHeader = memo(function ChatHeader(props: ChatHeaderProps) {
  usePerfMark("ChatHeader");
  useDevPropDiff(props as unknown as Record<string, unknown>, "ChatHeader");
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const showOpenInPicker = shouldShowOpenInPicker({
    activeProjectName: props.activeProjectName,
    activeThreadEnvironmentId: props.activeThreadEnvironmentId,
    primaryEnvironmentId,
  });

  const inlineActions = (
    <>
      {/* Hosted connection control, relocated from the fixed overlay into the
          workspace header so it can never overlap the other header controls.
          Renders nothing outside hosted-hub sessions. */}
      <HostedNodeMenu />
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
        isGitRepo={props.isGitRepo}
        worktreeBranch={props.worktreeBranch}
        worktreeTitle={props.worktreeTitle}
        worktreeOrigin={props.worktreeOrigin}
        worktreeIssueNumber={props.worktreeIssueNumber}
        worktreeIssueState={props.worktreeIssueState}
        worktreePrNumber={props.worktreePrNumber}
        worktreePrState={props.worktreePrState}
        worktreePrIsDraft={props.worktreePrIsDraft}
        worktreeWorkItemProvider={props.worktreeWorkItemProvider}
        worktreeWorkItemKey={props.worktreeWorkItemKey}
        worktreeWorkItemState={props.worktreeWorkItemState}
        worktreeWorkItemStateName={props.worktreeWorkItemStateName}
        sessionTitle={props.activeThreadTitle}
        {...(props.onSelectProject ? { onSelectProject: props.onSelectProject } : {})}
        {...(props.onSelectWorktree ? { onSelectWorktree: props.onSelectWorktree } : {})}
        {...(props.onOpenLinkedWorktreeItem
          ? { onOpenLinkedWorktreeItem: props.onOpenLinkedWorktreeItem }
          : {})}
        inlineActions={inlineActions}
      />
    </div>
  );
});
