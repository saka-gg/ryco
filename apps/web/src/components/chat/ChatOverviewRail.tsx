import type {
  ChangeRequest,
  EditorId,
  ProjectScript,
  RepositoryIdentity,
  ResolvedKeybindingsConfig,
} from "@ryco/contracts";
import {
  BotIcon,
  ExternalLinkIcon,
  FolderIcon,
  GitCompareIcon,
  GlobeIcon,
  ListTodoIcon,
  ServerIcon,
  TerminalSquareIcon,
  WorkflowIcon,
} from "lucide-react";
import { Fragment, memo, useMemo, type ReactNode } from "react";

import { shortcutLabelForCommand } from "~/keybindings";
import { cn } from "~/lib/utils";

import type { ActivePlanState, LatestProposedPlanState } from "../../session-logic";
import type { ThreadSubagentView } from "../../threadWorkspaceViewModel";
import ProjectScriptsControl, { type NewProjectScriptInput } from "../ProjectScriptsControl";
import {
  OverviewRail,
  OverviewRailButton,
  OverviewRailPopover,
  OverviewRailSeparator,
} from "../overview/OverviewRail";
import {
  resolveOverviewRailAgents,
  resolveOverviewRailChanges,
  resolveOverviewRailChecks,
  resolveOverviewRailPlan,
  type OverviewRailEnvironment,
} from "../overview/overviewRail.logic";
import {
  ChangesContent,
  ChecksContent,
  DiffStat,
  KeyValueRow,
  OverviewRefreshButton,
  PlanExplanation,
  PlanSteps,
  ProposedPlanDisclosure,
  PullRequestContent,
  SubagentRows,
} from "../overview/overviewSections";
import { resolveChangeRequestStateBadgeVariant } from "../sourceControl/stateBadgeVariants";
import { useRepositoryRemote } from "../sourceControl/useRepositoryRemote";
import { Button } from "../ui/button";
import { OpenInPicker } from "./OpenInPicker";
import { useChatOverviewModel, type ChatOverviewModelInput } from "./useChatOverviewModel";

export interface ChatOverviewRailProps extends ChatOverviewModelInput {
  activePlan: ActivePlanState | null;
  sidebarProposedPlan: LatestProposedPlanState | null;
  threadSubagents: ReadonlyArray<ThreadSubagentView>;
  markdownCwd: string | undefined;
  workspaceRoot: string | undefined;
  /** Rail-appearance Git actions, reconciled against the branch's change request. */
  sourceControlActions: (detectedChangeRequest: ChangeRequest | null) => ReactNode;
  /** Rail-appearance branch picker. */
  branchControl: ReactNode;
  repositoryIdentity: RepositoryIdentity | null | undefined;
  environment: OverviewRailEnvironment | null;
  /** Explicit expansion — the overview's "open" state, including plan auto-open. */
  pinned: boolean;
  onPinnedChange: (pinned: boolean) => void;
  onFocusReturnFallback: () => void;
  onOpenReview: () => void;
  onOpenSubagent: (subagent: ThreadSubagentView) => void;
  onOpenAgents: () => void;
  /** `null` without an active project (files need one). */
  onOpenFiles: (() => void) | null;
  filesActive: boolean;
  onOpenBrowser: () => void;
  browserActive: boolean;
  onToggleTerminal: () => void;
  terminalAvailable: boolean;
  terminalOpen: boolean;
  terminalCount: number;
  keybindings: ResolvedKeybindingsConfig;
  projectScripts: ProjectScript[] | undefined;
  preferredScriptId: string | null;
  onRunProjectScript: (script: ProjectScript) => void;
  onAddProjectScript: (input: NewProjectScriptInput) => Promise<void>;
  onUpdateProjectScript: (scriptId: string, input: NewProjectScriptInput) => Promise<void>;
  onDeleteProjectScript: (scriptId: string) => Promise<void>;
  /** Editors open local paths only; `false` hides the item for remote threads. */
  showOpenInEditor: boolean;
  availableEditors: ReadonlyArray<EditorId>;
  openInCwd: string | null;
}

/**
 * The desktop overview: repository, branch, changes, Git actions, CI, pull
 * request, plan, agents, and environment, followed by the workspace tools —
 * each an icon on a rail at the conversation's right edge, with details in a
 * focused popover or the item's existing menu. It floats over the transcript
 * between the header and the composer, so neither layout ever shifts.
 */
export const ChatOverviewRail = memo(function ChatOverviewRail(props: ChatOverviewRailProps) {
  const model = useChatOverviewModel(props);
  const repository = useRepositoryRemote({
    identity: props.repositoryIdentity,
    provider: model.sourceControlProvider,
  });
  const filesShortcutLabel = useMemo(
    () => shortcutLabelForCommand(props.keybindings, "workspace.files"),
    [props.keybindings],
  );
  const terminalShortcutLabel = useMemo(
    () => shortcutLabelForCommand(props.keybindings, "terminal.toggle"),
    [props.keybindings],
  );

  const changes = resolveOverviewRailChanges(model.changes);
  const pullRequest = model.pullRequest;
  const checks = pullRequest ? resolveOverviewRailChecks(pullRequest) : null;
  const plan = resolveOverviewRailPlan({
    activePlan: props.activePlan,
    hasProposedPlan: Boolean(props.sidebarProposedPlan?.planMarkdown),
  });
  const agents = resolveOverviewRailAgents(props.threadSubagents);
  const gitActions = props.sourceControlActions(model.detectedChangeRequest);
  const showChanges = changes.fileCount > 0 || model.changes !== undefined;

  const sourceItems: ReactNode[] = [];
  if (repository.displayName) {
    sourceItems.push(
      <OverviewRailButton
        key="repository"
        icon={<repository.Icon />}
        label={repository.displayName}
        value={repository.webUrl ? <ExternalLinkIcon className="size-3" /> : undefined}
        aria-label={
          repository.webUrl
            ? `${repository.displayName}, ${repository.openLabel}`
            : repository.displayName
        }
        aria-disabled={repository.webUrl ? undefined : true}
        onClick={repository.webUrl ? repository.open : undefined}
      />,
    );
  }
  if (props.branchControl) {
    sourceItems.push(<Fragment key="branch">{props.branchControl}</Fragment>);
  }
  if (showChanges) {
    sourceItems.push(
      <OverviewRailPopover
        key="changes"
        title="Changes"
        actions={
          <Button type="button" size="xs" variant="ghost" onClick={props.onOpenReview}>
            Review
          </Button>
        }
        trigger={
          <OverviewRailButton
            icon={<GitCompareIcon />}
            label="Changes"
            value={
              changes.fileCount > 0 ? (
                <DiffStat
                  additions={changes.insertions}
                  deletions={changes.deletions}
                  className="text-[11px]"
                />
              ) : (
                "None"
              )
            }
            tone={changes.tone}
          />
        }
      >
        <ChangesContent
          changes={model.changes}
          overviewItems={model.overviewItems}
          onOpenReview={props.onOpenReview}
          pullRequestNumber={pullRequest?.number}
        />
      </OverviewRailPopover>,
    );
  }
  if (gitActions) {
    sourceItems.push(<Fragment key="git">{gitActions}</Fragment>);
  }
  if (pullRequest && checks) {
    sourceItems.push(
      <OverviewRailPopover
        key="checks"
        title={
          pullRequest.number != null
            ? `Checks · PR #${pullRequest.number}`
            : model.changes?.refName
              ? `Checks · ${model.changes.refName}`
              : "Checks"
        }
        actions={
          <OverviewRefreshButton
            onRefresh={model.onRefreshPullRequest}
            isRefreshing={model.isRefreshingPullRequest}
            hasError={Boolean(pullRequest.checksError)}
          />
        }
        trigger={
          <OverviewRailButton
            icon={<WorkflowIcon />}
            label="Checks"
            value={checks.value}
            tone={checks.tone}
          />
        }
      >
        <ChecksContent pullRequest={pullRequest} />
      </OverviewRailPopover>,
    );
  }
  if (pullRequest && pullRequest.number != null) {
    const variant = resolveChangeRequestStateBadgeVariant(
      pullRequest.state ?? "",
      pullRequest.isDraft,
    );
    const stateLabel = pullRequest.hasMergeConflicts ? "Conflict" : variant.label;
    sourceItems.push(
      <OverviewRailPopover
        key="pull-request"
        title={
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="shrink-0">#{pullRequest.number}</span>
            {variant.label ? (
              <span className={cn("shrink-0 font-medium", variant.textClassName)}>
                {variant.label}
              </span>
            ) : null}
          </span>
        }
        actions={
          pullRequest.url ? (
            <Button
              size="icon-xs"
              variant="ghost"
              className="text-muted-foreground hover:text-foreground"
              render={<a href={pullRequest.url} target="_blank" rel="noreferrer" />}
              aria-label={`Open pull request #${pullRequest.number} in a new tab`}
            >
              <ExternalLinkIcon className="size-3.5" />
            </Button>
          ) : null
        }
        trigger={
          <OverviewRailButton
            icon={<variant.Icon className={variant.textClassName} />}
            label={pullRequest.title ?? `#${pullRequest.number}`}
            value={`#${pullRequest.number}`}
            tone={pullRequest.hasMergeConflicts ? "error" : null}
            aria-label={[
              `Pull request #${pullRequest.number}`,
              stateLabel,
              pullRequest.title ?? null,
            ]
              .filter(Boolean)
              .join(", ")}
          />
        }
      >
        <PullRequestContent pullRequest={pullRequest} showChecks={false} showReviews />
      </OverviewRailPopover>,
    );
  }

  const sessionItems: ReactNode[] = [];
  if (plan) {
    sessionItems.push(
      <OverviewRailPopover
        key="plan"
        title="Plan"
        className="w-[23rem]"
        trigger={
          <OverviewRailButton
            icon={<ListTodoIcon />}
            label="Plan"
            value={plan.value}
            tone={plan.tone}
          />
        }
      >
        <PlanExplanation activePlan={props.activePlan} />
        <PlanSteps activePlan={props.activePlan} />
        <ProposedPlanDisclosure
          activeProposedPlan={props.sidebarProposedPlan}
          environmentId={props.environmentId}
          markdownCwd={props.markdownCwd}
          workspaceRoot={props.workspaceRoot}
        />
      </OverviewRailPopover>,
    );
  }
  if (agents) {
    sessionItems.push(
      <OverviewRailPopover
        key="agents"
        title="Agents"
        actions={
          <Button type="button" size="xs" variant="ghost" onClick={props.onOpenAgents}>
            Open panel
          </Button>
        }
        trigger={
          <OverviewRailButton
            icon={<BotIcon />}
            label="Agents"
            value={agents.value}
            tone={agents.tone}
          />
        }
      >
        <SubagentRows subagents={props.threadSubagents} onOpenSubagent={props.onOpenSubagent} />
      </OverviewRailPopover>,
    );
  }
  if (props.environment) {
    const environment = props.environment;
    sessionItems.push(
      <OverviewRailPopover
        key="environment"
        title="Environment"
        trigger={
          <OverviewRailButton
            icon={<ServerIcon />}
            label={environment.label}
            value={environment.status}
            tone={environment.tone}
            aria-label={`Environment ${environment.label}, ${environment.status}`}
          />
        }
      >
        <KeyValueRow label="Target" value={environment.label} monoValue={false} />
        <KeyValueRow label="Status" value={environment.status} monoValue={false} />
      </OverviewRailPopover>,
    );
  }

  const toolItems: ReactNode[] = [];
  if (props.onOpenFiles) {
    toolItems.push(
      <OverviewRailButton
        key="files"
        icon={<FolderIcon />}
        label="Files"
        value={filesShortcutLabel ?? undefined}
        active={props.filesActive}
        onClick={props.onOpenFiles}
      />,
    );
  }
  toolItems.push(
    <OverviewRailButton
      key="terminal"
      icon={<TerminalSquareIcon />}
      label="Terminal"
      value={
        props.terminalCount >= 2
          ? `${props.terminalCount} open`
          : (terminalShortcutLabel ?? undefined)
      }
      active={props.terminalOpen}
      aria-pressed={props.terminalOpen}
      disabled={!props.terminalAvailable}
      title={
        props.terminalAvailable
          ? undefined
          : "Terminal is unavailable until this thread has an active project."
      }
      onClick={props.onToggleTerminal}
    />,
    <OverviewRailButton
      key="browser"
      icon={<GlobeIcon />}
      label="Browser"
      active={props.browserActive}
      onClick={props.onOpenBrowser}
    />,
  );
  if (props.projectScripts) {
    toolItems.push(
      <ProjectScriptsControl
        key="scripts"
        scripts={props.projectScripts}
        keybindings={props.keybindings}
        preferredScriptId={props.preferredScriptId}
        onRunScript={props.onRunProjectScript}
        onAddScript={props.onAddProjectScript}
        onUpdateScript={props.onUpdateProjectScript}
        onDeleteScript={props.onDeleteProjectScript}
      />,
    );
  }
  if (props.showOpenInEditor) {
    toolItems.push(
      <OpenInPicker
        key="editor"
        keybindings={props.keybindings}
        availableEditors={props.availableEditors}
        openInCwd={props.openInCwd}
      />,
    );
  }

  const groups = [
    { key: "source", items: sourceItems },
    { key: "session", items: sessionItems },
    { key: "tools", items: toolItems },
  ].filter((group) => group.items.length > 0);

  return (
    // Spans the band between the floating header and the composer so a tall
    // rail scrolls inside it instead of running under the composer.
    <div
      className="pointer-events-none absolute top-[calc(var(--chat-header-clearance,0px)+0.75rem)] right-3 bottom-[calc(var(--chat-composer-clearance,0px)+0.75rem)] z-30 flex flex-col items-end"
      data-testid="chat-overview-rail"
    >
      <OverviewRail
        label="Overview"
        pinned={props.pinned}
        onPinnedChange={props.onPinnedChange}
        onFocusReturnFallback={props.onFocusReturnFallback}
        className="pointer-events-auto"
      >
        {groups.map((group, index) => (
          <RailGroup key={group.key} separated={index > 0}>
            {group.items}
          </RailGroup>
        ))}
      </OverviewRail>
    </div>
  );
});

function RailGroup({ separated, children }: { separated: boolean; children: ReactNode }) {
  return (
    <>
      {separated ? <OverviewRailSeparator /> : null}
      {children}
    </>
  );
}
