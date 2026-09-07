import { LazyBrowserPanel } from "../browser/LazyBrowserPanel";
import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { scopedThreadKey, scopeProjectRef, scopeThreadRef } from "@ryco/client-runtime/scoped";
import { type ScopedThreadRef, type ThreadId } from "@ryco/contracts";
import { projectScriptCwd, projectScriptRuntimeEnv } from "@ryco/shared/projectScripts";
import {
  ArrowLeftIcon,
  BotIcon,
  FileTextIcon,
  FolderIcon,
  GlobeIcon,
  GitCompareIcon,
  Maximize2Icon,
  MessageSquarePlusIcon,
  MessageSquareTextIcon,
  Minimize2Icon,
  PlusIcon,
  SmartphoneIcon,
  TerminalIcon,
  XIcon,
  type LucideIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type KeyboardEvent } from "react";

import {
  APP_SIDEBAR_CHROME_INSET_TRANSITION_CLASS,
  COLLAPSED_APP_SIDEBAR_CHROME_INSET_CLASS,
} from "../appChrome";
import { isElectron } from "../env";
import {
  getRightPanelMode,
  parseRightPanelRouteSearch,
  type RightPanelMode,
} from "../rightPanelRouteSearch";
import {
  buildOpenAgentSearch,
  buildOpenAgentsSearch,
  buildOpenFilesSearch,
  buildOpenReviewSearch,
  buildOpenSimulatorSearch,
  buildOpenBrowserSearch,
  buildOpenTerminalSearch,
  buildOpenWorkspaceSearch,
  stripWorkspacePanelSearchParams,
} from "../workspaceRouteSearch";
import {
  derivePhase,
  deriveThreadAgentPanelModel,
  deriveThreadSubagents,
  findThreadSubagent,
  type ThreadSubagentStatus,
  type ThreadSubagentView,
} from "../threadWorkspaceViewModel";
import { AgentsPanel } from "./AgentsPanel";
import { formatLiveAgentCount, LiveAgentCountBadge } from "./LiveAgentCountBadge";
import { buildTabs, type WorkspaceTab } from "../threadWorkspaceTabs";
import { readEnvironmentApi } from "../environmentApi";
import { shortcutLabelForCommand } from "../keybindings";
import type { TerminalContextSelection } from "../lib/terminalContext";
import { useServerKeybindings } from "../rpc/serverState";
import { useStore } from "../store";
import { createProjectSelectorByRef, createThreadSelectorByRef } from "../storeSelectors";
import { selectThreadTerminalState, useTerminalStateStore } from "../terminalStateStore";
import { buildThreadRouteParams, resolveThreadRouteRef } from "../threadRoutes";
import { DraftId, useComposerDraftStore } from "../composerDraftStore";
import { useComposerHandleContext } from "../composerHandleContext";
import { cn, randomUUID } from "~/lib/utils";
import type { Thread } from "../types";
import {
  resolveSidebarStatusTextClassName,
  resolveSidebarStatusTextStyle,
} from "./sidebar/sidebarStatusText";
import { SubagentAvatar } from "./sidebar/SubagentAvatar";
import { Button } from "./ui/button";
import { ScrollArea } from "./ui/scroll-area";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import ChatMarkdown from "./ChatMarkdown";
import type { DiffPanelMode } from "./DiffPanelShell";
import DiffPanel from "./DiffPanel";
import PreviewPanel from "./PreviewPanel";
import ThreadTerminalDrawer from "./ThreadTerminalDrawer";
import SimulatorPanel from "./device/SimulatorPanel";

function statusBucket(status: ThreadSubagentStatus): "idle" | "in_progress" | "review" | "done" {
  if (status === "running") return "in_progress";
  if (status === "failed") return "review";
  if (status === "finished") return "done";
  return "idle";
}

function statusLabel(status: ThreadSubagentStatus): string {
  if (status === "running") return "Working";
  if (status === "failed") return "Needs review";
  if (status === "finished") return "Finished";
  if (status === "interrupted") return "Stopped";
  return "Idle";
}

function workspaceTabDomKey(key: string | null | undefined): string {
  return encodeURIComponent(key ?? "none").replace(/%/g, "_");
}

function workspaceTabId(key: string | null | undefined): string {
  return `thread-workspace-tab-${workspaceTabDomKey(key)}`;
}

function workspaceTabPanelId(key: string | null | undefined): string {
  return `thread-workspace-panel-${workspaceTabDomKey(key)}`;
}

function TabIcon(props: { tab: WorkspaceTab; active: boolean }) {
  const className = cn(
    "size-3.5 shrink-0",
    props.active ? "text-foreground" : "text-muted-foreground",
  );
  if (props.tab.mode === "agent") {
    return (
      <SubagentAvatar
        name={props.tab.avatarKey ?? props.tab.agentKey}
        className={cn("size-3.5 shrink-0", !props.active && "opacity-70")}
      />
    );
  }
  if (props.tab.key === "review") {
    return <GitCompareIcon className={className} />;
  }
  if (props.tab.key === "terminal") {
    return <TerminalIcon className={className} />;
  }
  if (props.tab.key === "browser") return <GlobeIcon className={className} />;
  if (props.tab.key === "simulator") {
    return <SmartphoneIcon className={className} />;
  }
  if (props.tab.key === "agents") {
    return <BotIcon className={className} />;
  }
  return <FileTextIcon className={className} />;
}

function AgentStatusName(props: { agent: Pick<ThreadSubagentView, "name" | "status"> }) {
  const bucket = statusBucket(props.agent.status);
  return (
    <span
      className={resolveSidebarStatusTextClassName(bucket, "truncate")}
      style={resolveSidebarStatusTextStyle(props.agent.name, { durationSeconds: 2.2 })}
    >
      {props.agent.name}
    </span>
  );
}

export function AgentThreadPanel(props: {
  subagent: ThreadSubagentView | null;
  agentKey: string | null;
}) {
  if (!props.subagent) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center p-6 text-center">
        <div className="max-w-72">
          <div className="mx-auto flex size-10 items-center justify-center rounded-md border border-border/70 bg-card/60 text-muted-foreground">
            <MessageSquareTextIcon className="size-4" />
          </div>
          <p className="mt-3 text-sm font-medium text-foreground">Subagent unavailable</p>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            This tab points to a subagent that is no longer present in the current thread activity.
          </p>
          {props.agentKey ? (
            <p className="mt-2 truncate font-mono text-[11px] text-muted-foreground/60">
              {props.agentKey}
            </p>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      <div className="border-b border-border/60 px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <SubagentAvatar
            name={props.subagent.avatarKey ?? props.subagent.key}
            className="size-4"
          />
          <p className="min-w-0 flex-1 text-sm font-medium">
            <AgentStatusName agent={props.subagent} />
          </p>
          {props.subagent.role ? (
            <span className="max-w-36 shrink-0 truncate rounded-sm border border-border/60 bg-background/40 px-1.5 py-px text-[10px] font-medium text-muted-foreground">
              {props.subagent.role}
            </span>
          ) : null}
          <span className="shrink-0 rounded-md border border-border/70 px-1.5 py-0.5 text-[10px] text-muted-foreground">
            {statusLabel(props.subagent.status)}
          </span>
        </div>
        {props.subagent.detail ? (
          <p className="mt-2 line-clamp-2 text-xs leading-relaxed text-muted-foreground">
            {props.subagent.detail}
          </p>
        ) : null}
        {props.subagent.model ||
        props.subagent.tool ||
        props.subagent.providerThreadIds.length > 0 ? (
          <div className="mt-2 flex min-w-0 flex-wrap items-center gap-1.5">
            {props.subagent.model ? (
              <span className="rounded-md border border-border/60 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                {props.subagent.model}
                {props.subagent.effort ? ` · ${props.subagent.effort}` : ""}
              </span>
            ) : null}
            {props.subagent.tool ? (
              <span className="rounded-md border border-border/60 px-1.5 py-0.5 text-[10px] text-muted-foreground">
                {props.subagent.tool}
              </span>
            ) : null}
            {props.subagent.providerThreadIds.slice(0, 2).map((threadId) => (
              <span
                key={threadId}
                className="max-w-40 truncate rounded-md border border-border/60 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground/70"
              >
                {threadId}
              </span>
            ))}
          </div>
        ) : null}
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-3 p-4">
          {props.subagent.messages.length > 0
            ? props.subagent.messages.map((message) => (
                <div key={message.id} className="rounded-md border border-border/60 bg-card/40 p-3">
                  <div className="mb-2 flex min-w-0 items-center justify-between gap-2">
                    <p className="truncate text-xs font-medium text-foreground">Subagent</p>
                    {message.providerThreadId ? (
                      <span className="truncate font-mono text-[10px] text-muted-foreground/55">
                        {message.providerThreadId}
                      </span>
                    ) : null}
                  </div>
                  <ChatMarkdown text={message.text} cwd={undefined} isStreaming={false} />
                </div>
              ))
            : null}
          {props.subagent.entries.length > 0 ? (
            props.subagent.entries.map((entry) => (
              <div key={entry.id} className="rounded-md border border-border/60 bg-card/40 p-3">
                <div className="flex min-w-0 items-center gap-2">
                  <span
                    className={cn(
                      "size-2 shrink-0 rounded-full",
                      entry.tone === "error"
                        ? "bg-destructive"
                        : props.subagent?.status === "running"
                          ? "bg-sky-400"
                          : props.subagent?.status === "interrupted"
                            ? "bg-muted-foreground/60"
                            : "bg-emerald-400",
                    )}
                  />
                  <p className="min-w-0 truncate text-xs font-medium text-foreground">
                    {entry.toolTitle ?? entry.label}
                  </p>
                </div>
                {entry.detail ? (
                  <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                    {entry.detail}
                  </p>
                ) : null}
                {entry.output && entry.output !== entry.detail ? (
                  <div className="mt-3 rounded-md border border-border/50 bg-background/60 p-2">
                    <ChatMarkdown text={entry.output} cwd={undefined} isStreaming={false} />
                  </div>
                ) : null}
              </div>
            ))
          ) : props.subagent.messages.length === 0 ? (
            <div className="flex min-h-48 flex-col items-center justify-center rounded-md border border-dashed border-border/70 bg-card/20 p-6 text-center">
              <MessageSquareTextIcon className="size-5 text-muted-foreground/60" />
              <p className="mt-3 text-sm font-medium text-foreground">No transcript captured yet</p>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                The subagent is visible from lifecycle events. Detailed messages will appear here
                when the provider exposes them.
              </p>
            </div>
          ) : null}
        </div>
      </ScrollArea>
    </div>
  );
}

function TerminalUnavailableState(props: { title: string; description: string }) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center p-6 text-center">
      <div className="max-w-72">
        <div className="mx-auto flex size-10 items-center justify-center rounded-md border border-border/70 bg-card/60 text-muted-foreground">
          <TerminalIcon className="size-4" />
        </div>
        <p className="mt-3 text-sm font-medium text-foreground">{props.title}</p>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{props.description}</p>
      </div>
    </div>
  );
}

function useWorkspaceProjectContext() {
  const params = useParams({ strict: false }) as Record<string, string | undefined>;
  const routeThreadRef = resolveThreadRouteRef(params);
  const draftId = params.draftId ? DraftId.make(params.draftId) : null;
  const draftSession = useComposerDraftStore((store) =>
    draftId ? store.getDraftSession(draftId) : null,
  );
  const threadRef = useMemo<ScopedThreadRef | null>(() => {
    if (routeThreadRef) {
      return routeThreadRef;
    }
    if (!draftSession) {
      return null;
    }
    return scopeThreadRef(draftSession.environmentId, draftSession.threadId);
  }, [draftSession, routeThreadRef]);
  const serverThread = useStore(useMemo(() => createThreadSelectorByRef(threadRef), [threadRef]));
  const draftThread = useComposerDraftStore((store) =>
    threadRef ? store.getDraftThreadByRef(threadRef) : null,
  );
  const projectRef = serverThread
    ? scopeProjectRef(serverThread.environmentId, serverThread.projectId)
    : draftThread
      ? scopeProjectRef(draftThread.environmentId, draftThread.projectId)
      : null;
  const project = useStore(useMemo(() => createProjectSelectorByRef(projectRef), [projectRef]));
  return { threadRef, serverThread, draftThread, project };
}

function WorkspaceBrowserPanel() {
  const { threadRef, serverThread, draftThread, project } = useWorkspaceProjectContext();
  return (
    <LazyBrowserPanel
      environmentId={threadRef?.environmentId ?? null}
      cwd={serverThread?.worktreePath ?? draftThread?.worktreePath ?? project?.cwd ?? null}
    />
  );
}

/**
 * The workspace terminal tab. On the phone tier this renders inside the
 * full-screen work surface: xterm fills the surface, the drawer toolbar grows
 * to the 44px touch floor via the `phone:` variant, and the surface sheet pads
 * by the published keyboard inset so the toolbar never sits under the software
 * keyboard. Deep touch/IME terminal ergonomics are explicitly deferred
 * follow-up work (see the focused mobile workspace design, non-goals).
 */
function WorkspaceTerminalPanel() {
  const { threadRef, serverThread, draftThread, project } = useWorkspaceProjectContext();
  const terminalState = useTerminalStateStore((state) =>
    selectThreadTerminalState(state.terminalStateByThreadKey, threadRef),
  );
  const terminalLaunchContext = useTerminalStateStore((state) =>
    threadRef ? (state.terminalLaunchContextByThreadKey[scopedThreadKey(threadRef)] ?? null) : null,
  );
  const storeSetTerminalOpen = useTerminalStateStore((state) => state.setTerminalOpen);
  const storeSetTerminalHeight = useTerminalStateStore((state) => state.setTerminalHeight);
  const storeSplitTerminal = useTerminalStateStore((state) => state.splitTerminal);
  const storeNewTerminal = useTerminalStateStore((state) => state.newTerminal);
  const storeSetActiveTerminal = useTerminalStateStore((state) => state.setActiveTerminal);
  const storeCloseTerminal = useTerminalStateStore((state) => state.closeTerminal);
  const keybindings = useServerKeybindings();
  const composerHandleRef = useComposerHandleContext();
  const [focusRequestId, setFocusRequestId] = useState(0);
  const worktreePath = serverThread?.worktreePath ?? draftThread?.worktreePath ?? null;
  const effectiveWorktreePath = terminalLaunchContext?.worktreePath ?? worktreePath;
  const cwd = useMemo(
    () =>
      terminalLaunchContext?.cwd ??
      (project
        ? projectScriptCwd({
            project: { cwd: project.cwd },
            worktreePath: effectiveWorktreePath,
          })
        : null),
    [effectiveWorktreePath, project, terminalLaunchContext?.cwd],
  );
  const runtimeEnv = useMemo(
    () =>
      project
        ? projectScriptRuntimeEnv({
            project: { cwd: project.cwd },
            worktreePath: effectiveWorktreePath,
          })
        : {},
    [effectiveWorktreePath, project],
  );
  const terminalShortcutLabelOptions = useMemo(
    () => ({
      context: {
        terminalFocus: true,
        terminalOpen: true,
      },
    }),
    [],
  );
  const splitShortcutLabel = useMemo(
    () => shortcutLabelForCommand(keybindings, "terminal.split", terminalShortcutLabelOptions),
    [keybindings, terminalShortcutLabelOptions],
  );
  const newShortcutLabel = useMemo(
    () => shortcutLabelForCommand(keybindings, "terminal.new", terminalShortcutLabelOptions),
    [keybindings, terminalShortcutLabelOptions],
  );
  const closeShortcutLabel = useMemo(
    () => shortcutLabelForCommand(keybindings, "terminal.close", terminalShortcutLabelOptions),
    [keybindings, terminalShortcutLabelOptions],
  );

  useEffect(() => {
    if (!threadRef || !terminalState.terminalOpen) {
      return;
    }
    storeSetTerminalOpen(threadRef, false);
  }, [storeSetTerminalOpen, terminalState.terminalOpen, threadRef]);

  const bumpFocusRequestId = useCallback(() => {
    setFocusRequestId((value) => value + 1);
  }, []);

  const splitTerminal = useCallback(() => {
    if (!threadRef) return;
    storeSplitTerminal(threadRef, `terminal-${randomUUID()}`);
    storeSetTerminalOpen(threadRef, false);
    bumpFocusRequestId();
  }, [bumpFocusRequestId, storeSetTerminalOpen, storeSplitTerminal, threadRef]);

  const createNewTerminal = useCallback(() => {
    if (!threadRef) return;
    storeNewTerminal(threadRef, `terminal-${randomUUID()}`);
    storeSetTerminalOpen(threadRef, false);
    bumpFocusRequestId();
  }, [bumpFocusRequestId, storeNewTerminal, storeSetTerminalOpen, threadRef]);

  const activateTerminal = useCallback(
    (terminalId: string) => {
      if (!threadRef) return;
      storeSetActiveTerminal(threadRef, terminalId);
      bumpFocusRequestId();
    },
    [bumpFocusRequestId, storeSetActiveTerminal, threadRef],
  );

  const setTerminalHeight = useCallback(
    (height: number) => {
      if (!threadRef) return;
      storeSetTerminalHeight(threadRef, height);
    },
    [storeSetTerminalHeight, threadRef],
  );

  const closeTerminal = useCallback(
    (terminalId: string) => {
      if (!threadRef) return;
      const api = readEnvironmentApi(threadRef.environmentId);
      if (!api) return;
      const isFinalTerminal = terminalState.terminalIds.length <= 1;
      const fallbackExitWrite = () =>
        api.terminal
          .write({ threadId: threadRef.threadId, terminalId, data: "exit\n" })
          .catch(() => undefined);

      if ("close" in api.terminal && typeof api.terminal.close === "function") {
        void (async () => {
          if (isFinalTerminal) {
            await api.terminal
              .clear({ threadId: threadRef.threadId, terminalId })
              .catch(() => undefined);
          }
          await api.terminal.close({
            threadId: threadRef.threadId,
            terminalId,
            deleteHistory: true,
          });
        })().catch(() => fallbackExitWrite());
      } else {
        void fallbackExitWrite();
      }

      storeCloseTerminal(threadRef, terminalId);
      storeSetTerminalOpen(threadRef, false);
      bumpFocusRequestId();
    },
    [
      bumpFocusRequestId,
      storeCloseTerminal,
      storeSetTerminalOpen,
      terminalState.terminalIds.length,
      threadRef,
    ],
  );

  const addTerminalContext = useCallback(
    (selection: TerminalContextSelection) => {
      composerHandleRef?.current?.addTerminalContext(selection);
    },
    [composerHandleRef],
  );

  if (!threadRef) {
    return (
      <TerminalUnavailableState
        title="Terminal unavailable"
        description="No active thread is available for this workspace terminal."
      />
    );
  }

  if (!project || !cwd) {
    return (
      <TerminalUnavailableState
        title="Terminal unavailable"
        description="This thread does not have a resolved project directory."
      />
    );
  }

  return (
    <ThreadTerminalDrawer
      threadRef={threadRef}
      threadId={threadRef.threadId as ThreadId}
      cwd={cwd}
      worktreePath={effectiveWorktreePath}
      runtimeEnv={runtimeEnv}
      layout="panel"
      visible
      height={terminalState.terminalHeight}
      terminalIds={terminalState.terminalIds}
      runningTerminalIds={terminalState.runningTerminalIds}
      activeTerminalId={terminalState.activeTerminalId}
      terminalGroups={terminalState.terminalGroups}
      activeTerminalGroupId={terminalState.activeTerminalGroupId}
      focusRequestId={focusRequestId}
      onSplitTerminal={splitTerminal}
      onNewTerminal={createNewTerminal}
      splitShortcutLabel={splitShortcutLabel ?? undefined}
      newShortcutLabel={newShortcutLabel ?? undefined}
      closeShortcutLabel={closeShortcutLabel ?? undefined}
      keybindings={keybindings}
      onActiveTerminalChange={activateTerminal}
      onCloseTerminal={closeTerminal}
      onHeightChange={setTerminalHeight}
      onAddTerminalContext={addTerminalContext}
    />
  );
}

function LauncherCard(props: {
  label: string;
  description: string;
  icon: LucideIcon;
  shortcutLabel?: string | null;
  disabled?: boolean;
  compact?: boolean;
  badgeCount?: number;
  onClick?: () => void;
}) {
  const Icon = props.icon;
  return (
    <button
      type="button"
      disabled={props.disabled}
      onClick={props.onClick}
      data-slot="workspace-launcher-card"
      className={cn(
        "group flex w-full flex-col items-center justify-center rounded-lg border border-border/50 bg-card/35 text-center transition-colors",
        props.compact
          ? "min-h-0 px-1 py-1 @sm/workspace-launcher:px-4 @sm/workspace-launcher:py-3"
          : "min-h-32 px-5 py-6",
        props.disabled
          ? "cursor-not-allowed opacity-45"
          : "hover:border-border hover:bg-card/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
      )}
    >
      <span className="relative inline-flex">
        <Icon
          className={cn(
            "text-muted-foreground transition-colors",
            props.compact ? "size-4 @sm/workspace-launcher:size-6" : "size-6",
            !props.disabled && "group-hover:text-foreground",
          )}
        />
        <LiveAgentCountBadge
          count={props.badgeCount ?? 0}
          className="-top-2 -right-3 h-4 min-w-4 px-1 text-[9px]"
        />
      </span>
      {(props.badgeCount ?? 0) > 0 ? (
        <span className="sr-only">{formatLiveAgentCount(props.badgeCount ?? 0)}</span>
      ) : null}
      <span
        className={cn(
          "font-semibold text-foreground",
          props.compact
            ? "mt-1 text-xs @sm/workspace-launcher:mt-3 @sm/workspace-launcher:text-base"
            : "mt-4 text-base",
        )}
      >
        {props.label}
      </span>
      <span
        className={cn(
          "text-muted-foreground",
          props.compact ? "mt-0.5 hidden text-xs @sm/workspace-launcher:block" : "mt-1 text-sm",
        )}
      >
        {props.description}
      </span>
      {props.shortcutLabel ? (
        <span
          className={cn(
            "rounded-md bg-muted px-1.5 py-0.5 font-medium text-[11px] text-muted-foreground",
            props.compact ? "mt-2 hidden @sm/workspace-launcher:inline-flex" : "mt-3",
          )}
        >
          {props.shortcutLabel}
        </span>
      ) : null}
    </button>
  );
}

function WorkspaceLauncher(props: {
  tabs: ReadonlyArray<WorkspaceTab>;
  activeThread: Thread | null | undefined;
  onSelectTab: (tab: WorkspaceTab) => void;
  /** The frozen phone tier has no Agents workspace (AGENTS.md). */
  showAgents: boolean;
  showSimulator: boolean;
  isPhoneSurface: boolean;
  liveAgentCount: number;
}) {
  const keybindings = useServerKeybindings();
  const filesTab: WorkspaceTab = { key: "files", label: "Files", mode: "files" };
  const reviewTab: WorkspaceTab = { key: "review", label: "Review", mode: "review" };
  const terminalTab: WorkspaceTab = { key: "terminal", label: "Terminal", mode: "terminal" };
  const simulatorTab: WorkspaceTab = {
    key: "simulator",
    label: "Simulator",
    mode: "simulator",
  };
  const agentsTab: WorkspaceTab = { key: "agents", label: "Agents", mode: "agents" };
  const filesShortcutLabel = useMemo(
    () => shortcutLabelForCommand(keybindings, "workspace.files"),
    [keybindings],
  );
  const reviewShortcutLabel = useMemo(
    () => shortcutLabelForCommand(keybindings, "workspace.review"),
    [keybindings],
  );
  const terminalShortcutLabel = useMemo(
    () => shortcutLabelForCommand(keybindings, "workspace.terminal"),
    [keybindings],
  );
  const simulatorShortcutLabel = useMemo(
    () => shortcutLabelForCommand(keybindings, "workspace.simulator"),
    [keybindings],
  );
  const agentTabs = props.tabs.filter((tab) => tab.mode === "agent");
  const compact = !props.isPhoneSurface;

  const launcherCards = (
    <>
      <LauncherCard
        label="Files"
        description="Browse project files"
        icon={FolderIcon}
        shortcutLabel={filesShortcutLabel}
        compact={compact}
        onClick={() => props.onSelectTab(filesTab)}
      />
      <LauncherCard
        label="Side chat"
        description="Start a side conversation"
        icon={MessageSquarePlusIcon}
        compact={compact}
        disabled
      />
      <LauncherCard
        label="Browser"
        description="Preview sites and local servers"
        icon={GlobeIcon}
        compact={compact}
        disabled={props.isPhoneSurface}
        onClick={() => props.onSelectTab({ key: "browser", label: "Browser", mode: "browser" })}
      />
      <LauncherCard
        label="Review"
        description="View code changes"
        icon={GitCompareIcon}
        shortcutLabel={reviewShortcutLabel}
        compact={compact}
        onClick={() => props.onSelectTab(reviewTab)}
      />
      <LauncherCard
        label="Terminal"
        description="Start an interactive shell"
        icon={TerminalIcon}
        shortcutLabel={terminalShortcutLabel}
        compact={compact}
        onClick={() => props.onSelectTab(terminalTab)}
      />
      {props.showSimulator ? (
        <LauncherCard
          label="Simulator"
          description="Run and control an iOS app"
          icon={SmartphoneIcon}
          shortcutLabel={simulatorShortcutLabel}
          compact={compact}
          onClick={() => props.onSelectTab(simulatorTab)}
        />
      ) : null}
      {props.showAgents ? (
        <LauncherCard
          label="Agents"
          description="Watch subagents and workflows run"
          icon={BotIcon}
          badgeCount={props.liveAgentCount}
          compact={compact}
          onClick={() => props.onSelectTab(agentsTab)}
        />
      ) : null}
    </>
  );

  const agentTabList =
    agentTabs.length > 0 ? (
      <div className="mx-auto w-full max-w-lg space-y-2 pt-1">
        {agentTabs.map((tab) => (
          <button
            key={tab.key}
            type="button"
            className="flex w-full min-w-0 items-center gap-3 rounded-lg border border-border/50 bg-card/35 px-4 py-3 text-left transition-colors hover:border-border hover:bg-card/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => props.onSelectTab(tab)}
          >
            <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-border/50 bg-background/50 text-muted-foreground">
              <SubagentAvatar name={tab.avatarKey ?? tab.agentKey} className="size-5" />
            </span>
            <span className="min-w-0 flex-1">
              <span
                className={cn(
                  "block truncate text-sm font-medium",
                  resolveSidebarStatusTextClassName(statusBucket(tab.status)),
                )}
                style={resolveSidebarStatusTextStyle(tab.label, { durationSeconds: 2.2 })}
              >
                {tab.label}
              </span>
              <span className="mt-0.5 block text-xs text-muted-foreground">
                {statusLabel(tab.status)}
              </span>
            </span>
          </button>
        ))}
      </div>
    ) : null;

  return (
    <ScrollArea className="h-full">
      {props.isPhoneSurface ? (
        /* Auto margins center the card stack, but collapse when it is taller
           than the pane so phone scrolling always starts at the first card. */
        <div className="flex min-h-full p-5 sm:p-6">
          <div className="m-auto w-full max-w-lg space-y-4">
            {launcherCards}
            {agentTabList}
          </div>
        </div>
      ) : (
        <div
          className="flex h-full min-h-0 flex-col gap-3 p-4 sm:p-5"
          data-slot="workspace-launcher"
        >
          <div className="@container/workspace-launcher flex min-h-0 flex-1 items-center justify-center">
            <div
              className="grid aspect-square grid-cols-3 grid-rows-3 gap-2 @sm/workspace-launcher:gap-3"
              data-slot="workspace-launcher-grid"
              style={{ inlineSize: "min(100cqw, 100cqh, 32rem)" }}
            >
              {launcherCards}
            </div>
          </div>
          {agentTabList}
        </div>
      )}
    </ScrollArea>
  );
}

export default function ThreadWorkspacePanel(props: {
  mode: DiffPanelMode;
  panelMode: RightPanelMode | null;
  openedPanelModes: ReadonlyArray<RightPanelMode>;
  openedAgentKeys: ReadonlyArray<string>;
  onClosePanelTab: (input: { mode: RightPanelMode; agentKey?: string }) => void;
  /** Inline presentation only: the panel has taken over the whole workspace. */
  maximized?: boolean;
  /**
   * Toggles the maximized layout. Absent wherever maximizing makes no sense —
   * the phone work surface and the narrow-viewport sheet are already
   * full-bleed — and the control is hidden in that case.
   */
  onToggleMaximized?: (() => void) | undefined;
  /**
   * The tab bar owns the workspace's top-left chrome corner (maximized with
   * the app sidebar collapsed), so it reserves room for the window controls
   * and the floating show-sidebar control.
   */
  reserveChromeInset?: boolean;
}) {
  const { onClosePanelTab, onToggleMaximized } = props;
  const maximized = props.maximized ?? false;
  // Full-screen phone work surface: the bar swaps to a surface bar (back
  // affordance to the thread instead of the desktop close X) and every tab
  // control meets the >=44px phone touch-target floor.
  const isPhoneSurface = props.mode === "phone";
  const navigate = useNavigate();
  const params = useParams({ strict: false }) as Record<string, string | undefined>;
  const search = useSearch({
    strict: false,
    select: (value) => parseRightPanelRouteSearch(value),
  });
  const routeThreadRef = resolveThreadRouteRef(params);
  const workspaceDraftId = params.draftId ? DraftId.make(params.draftId) : null;
  const workspaceDraftSession = useComposerDraftStore((store) =>
    workspaceDraftId ? store.getDraftSession(workspaceDraftId) : null,
  );
  const workspaceThreadRef = useMemo(
    () =>
      routeThreadRef ??
      (workspaceDraftSession
        ? scopeThreadRef(workspaceDraftSession.environmentId, workspaceDraftSession.threadId)
        : null),
    [routeThreadRef, workspaceDraftSession],
  );
  const activeThread = useStore(
    useMemo(() => createThreadSelectorByRef(workspaceThreadRef), [workspaceThreadRef]),
  );
  const agentSessionLive =
    derivePhase(activeThread?.session ?? null) !== "disconnected" &&
    activeThread?.session?.orchestrationStatus !== "stopped" &&
    activeThread?.session?.orchestrationStatus !== "interrupted" &&
    activeThread?.session?.orchestrationStatus !== "error";
  const subagents = useMemo(
    () =>
      deriveThreadSubagents(activeThread?.activities ?? [], {
        sessionLive: agentSessionLive,
        parentTurnState: activeThread?.latestTurn?.state ?? null,
      }),
    [activeThread?.activities, activeThread?.latestTurn?.state, agentSessionLive],
  );
  const agentKey =
    (search.workspaceTab === "agent" || search.workspaceTab === "agents") &&
    search.workspaceAgentKey
      ? search.workspaceAgentKey
      : null;
  const activeAgent = useMemo(() => findThreadSubagent(subagents, agentKey), [agentKey, subagents]);
  const requestedMode = getRightPanelMode(search) ?? props.panelMode;
  const activeMode = !isPhoneSurface && requestedMode === "agent" ? "agents" : requestedMode;
  // Shared by the Agents workspace tab and the launcher badge; pure fold,
  // memoized by activity-list identity.
  const agentPanelModel = useMemo(
    () =>
      deriveThreadAgentPanelModel({
        activities: activeThread?.activities ?? [],
        transcriptSubagents: subagents,
        sessionLive: agentSessionLive,
      }),
    [activeThread?.activities, agentSessionLive, subagents],
  );
  const openedPanelModes = useMemo(() => {
    if (
      activeMode === "files" ||
      activeMode === "review" ||
      activeMode === "terminal" ||
      activeMode === "simulator" ||
      activeMode === "browser" ||
      activeMode === "agents"
    ) {
      return props.openedPanelModes.includes(activeMode)
        ? props.openedPanelModes
        : [...props.openedPanelModes, activeMode];
    }
    return props.openedPanelModes;
  }, [activeMode, props.openedPanelModes]);
  const tabs = useMemo(() => {
    const built = buildTabs({
      subagents,
      activeAgentKey: agentKey,
      openedAgentKeys: props.openedAgentKeys,
      openedPanelModes,
      groupAgents: !isPhoneSurface,
    });
    // The web phone tier is frozen; native mobile owns future phone surfaces.
    return isPhoneSurface
      ? built.filter(
          (tab) => tab.mode !== "agents" && tab.mode !== "simulator" && tab.mode !== "browser",
        )
      : built;
  }, [agentKey, isPhoneSurface, openedPanelModes, props.openedAgentKeys, subagents]);
  // A phone agents deep link falls back to the launcher with the agents tab
  // filtered out — no tab is active then, so aria-labelledby never points
  // at a tab id that is not in the DOM.
  const activeTabKey =
    activeMode === "agent"
      ? agentKey
      : isPhoneSurface && (activeMode === "agents" || activeMode === "browser")
        ? null
        : activeMode;

  const navigateSearch = useCallback(
    (buildSearch: (previous: Record<string, unknown>) => Record<string, unknown>) => {
      if (params.draftId) {
        void navigate({
          to: "/draft/$draftId",
          params: { draftId: DraftId.make(params.draftId) },
          replace: true,
          search: buildSearch,
        });
        return;
      }
      if (!routeThreadRef) {
        return;
      }
      void navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(routeThreadRef),
        replace: true,
        search: buildSearch,
      });
    },
    [navigate, params.draftId, routeThreadRef],
  );

  useEffect(() => {
    if (!isPhoneSurface && requestedMode === "agent" && agentKey) {
      navigateSearch((previous) => buildOpenAgentsSearch(previous, agentKey));
    }
  }, [isPhoneSurface, requestedMode, agentKey, navigateSearch]);

  const selectTab = useCallback(
    (tab: WorkspaceTab) => {
      if (tab.mode === "review") {
        navigateSearch((previous) => buildOpenReviewSearch(previous));
        return;
      }
      if (tab.mode === "files") {
        navigateSearch((previous) => buildOpenFilesSearch(previous));
        return;
      }
      if (tab.mode === "terminal") {
        navigateSearch((previous) => buildOpenTerminalSearch(previous));
        return;
      }
      if (tab.mode === "browser") {
        navigateSearch((previous) => buildOpenBrowserSearch(previous));
        return;
      }
      if (tab.mode === "simulator") {
        navigateSearch((previous) => buildOpenSimulatorSearch(previous));
        return;
      }
      if (tab.mode === "agents") {
        navigateSearch((previous) => buildOpenAgentsSearch(previous));
        return;
      }
      if (tab.mode === "agent") {
        navigateSearch((previous) => buildOpenAgentSearch(previous, tab.agentKey));
      }
    },
    [navigateSearch],
  );
  const openLauncher = useCallback(() => {
    navigateSearch((previous) => buildOpenWorkspaceSearch(previous));
  }, [navigateSearch]);
  const openRuntimeAgent = useCallback(
    (runtimeAgentId: string) => {
      const agentKey = runtimeAgentId.startsWith("subagent:")
        ? runtimeAgentId
        : `subagent:${runtimeAgentId}`;
      navigateSearch((previous) =>
        isPhoneSurface
          ? buildOpenAgentSearch(previous, agentKey)
          : buildOpenAgentsSearch(previous, agentKey),
      );
    },
    [isPhoneSurface, navigateSearch],
  );
  const closeTab = useCallback(
    (tab: WorkspaceTab) => {
      onClosePanelTab({
        mode: tab.mode,
        ...(tab.mode === "agent" ? { agentKey: tab.agentKey } : {}),
      });
    },
    [onClosePanelTab],
  );
  const onTabKeyDown = useCallback(
    (tab: WorkspaceTab, event: KeyboardEvent<HTMLButtonElement>) => {
      const currentIndex = tabs.findIndex((candidate) => candidate.key === tab.key);
      if (currentIndex < 0) {
        return;
      }
      const selectAt = (index: number) => {
        const nextTab = tabs[(index + tabs.length) % tabs.length];
        if (nextTab) {
          selectTab(nextTab);
        }
      };

      switch (event.key) {
        case "ArrowRight":
        case "ArrowDown":
          event.preventDefault();
          selectAt(currentIndex + 1);
          return;
        case "ArrowLeft":
        case "ArrowUp":
          event.preventDefault();
          selectAt(currentIndex - 1);
          return;
        case "Home":
          event.preventDefault();
          selectAt(0);
          return;
        case "End":
          event.preventDefault();
          selectAt(tabs.length - 1);
          return;
      }
    },
    [selectTab, tabs],
  );

  const closePanel = useCallback(() => {
    navigateSearch((previous) => ({
      ...stripWorkspacePanelSearchParams(previous),
      diff: undefined,
      diffTurnId: undefined,
      diffFilePath: undefined,
      preview: undefined,
      workspaceOpen: undefined,
      workspaceTab: undefined,
      workspaceAgentKey: undefined,
    }));
  }, [navigateSearch]);

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col bg-background w-full">
      <div
        className={cn(
          "flex shrink-0 items-center gap-1 border-b border-border bg-card/40 px-2",
          isPhoneSurface ? "h-14" : "h-12",
          !isPhoneSurface && APP_SIDEBAR_CHROME_INSET_TRANSITION_CLASS,
          props.reserveChromeInset && COLLAPSED_APP_SIDEBAR_CHROME_INSET_CLASS,
          // Maximizing collapses the chat header to zero width, leaving this
          // bar as the frameless desktop window's only top-level chrome. It
          // has to carry the title-bar duties the header would have: a drag
          // surface (global CSS exempts the buttons inside it) and clearance
          // for the window controls the overlay platforms draw on the right.
          maximized &&
            isElectron &&
            "drag-region wco:pr-[calc(100vw-env(titlebar-area-width)-env(titlebar-area-x)+1em)]",
        )}
      >
        {isPhoneSurface ? (
          <Button
            size="icon"
            variant="ghost"
            aria-label="Back to thread"
            className="shrink-0"
            onClick={closePanel}
          >
            <ArrowLeftIcon />
          </Button>
        ) : null}
        <div
          className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto"
          role="tablist"
          aria-label="Workspace tabs"
        >
          {tabs.map((tab) => {
            const active = activeTabKey === tab.key;
            return (
              <div
                key={tab.key}
                className={cn(
                  "flex min-w-0 shrink-0 items-center rounded-md text-sm transition-colors",
                  isPhoneSurface ? "h-11" : "h-8",
                  active
                    ? "bg-muted text-foreground"
                    : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
                )}
              >
                <button
                  type="button"
                  id={workspaceTabId(tab.key)}
                  role="tab"
                  aria-selected={active}
                  aria-controls={workspaceTabPanelId(tab.key)}
                  tabIndex={active ? 0 : -1}
                  className={cn(
                    "flex h-full min-w-0 items-center gap-1.5",
                    isPhoneSurface ? "pl-3 pr-1.5" : "pl-2.5 pr-1",
                  )}
                  onClick={() => selectTab(tab)}
                  onKeyDown={(event) => onTabKeyDown(tab, event)}
                >
                  <TabIcon tab={tab} active={active} />
                  <span
                    className={cn(
                      "max-w-32 truncate",
                      tab.mode === "agent" &&
                        resolveSidebarStatusTextClassName(statusBucket(tab.status)),
                    )}
                    style={
                      tab.mode === "agent"
                        ? resolveSidebarStatusTextStyle(tab.label, { durationSeconds: 2.2 })
                        : undefined
                    }
                  >
                    {tab.label}
                  </span>
                </button>
                <button
                  type="button"
                  className={cn(
                    "mr-1 flex size-5 shrink-0 items-center justify-center rounded-md text-muted-foreground/60 transition-colors hover:bg-background/60 hover:text-foreground",
                    // Phone: expand the tap target to the 44px floor without
                    // growing the visible glyph (step-7 coarse-target
                    // pattern). The centered target deliberately overlaps the
                    // tail of its own label and the next tab's leading
                    // padding — same geometry as the terminal tab close; the
                    // rest of the 44px-tall tab remains a much larger select
                    // target and a mis-tapped close is recoverable from the
                    // launcher.
                    isPhoneSurface &&
                      "relative after:absolute after:top-1/2 after:left-1/2 after:size-11 after:-translate-x-1/2 after:-translate-y-1/2",
                  )}
                  aria-label={`Close ${tab.label} tab`}
                  onClick={() => closeTab(tab)}
                >
                  <XIcon className="size-3" />
                </button>
              </div>
            );
          })}
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  className={cn(
                    "flex shrink-0 items-center justify-center rounded-md text-muted-foreground/70 transition-colors hover:bg-muted/60 hover:text-foreground",
                    isPhoneSurface ? "size-11" : "size-6",
                    !activeMode && "bg-muted text-foreground",
                  )}
                  aria-label="Workspace launcher"
                  aria-pressed={!activeMode}
                  onClick={openLauncher}
                />
              }
            >
              <PlusIcon className="size-3.5" />
            </TooltipTrigger>
            <TooltipPopup side="bottom">Workspace launcher</TooltipPopup>
          </Tooltip>
        </div>
        {isPhoneSurface ? null : (
          <>
            {onToggleMaximized ? (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      className="shrink-0 text-muted-foreground/70 hover:text-foreground"
                      onClick={onToggleMaximized}
                      aria-pressed={maximized}
                      aria-label={
                        maximized ? "Restore workspace panel" : "Maximize workspace panel"
                      }
                    >
                      {maximized ? (
                        <Minimize2Icon className="size-3.5" />
                      ) : (
                        <Maximize2Icon className="size-3.5" />
                      )}
                    </Button>
                  }
                />
                <TooltipPopup side="bottom">
                  {maximized ? "Restore workspace panel" : "Maximize workspace panel"}
                </TooltipPopup>
              </Tooltip>
            ) : null}
            <Button
              size="icon-xs"
              variant="ghost"
              className="shrink-0 text-muted-foreground/70 hover:text-foreground"
              onClick={closePanel}
              aria-label="Close workspace panel"
            >
              <XIcon className="size-3.5" />
            </Button>
          </>
        )}
      </div>
      <div
        className="flex min-h-0 flex-1 flex-col overflow-hidden"
        id={workspaceTabPanelId(activeTabKey)}
        role="tabpanel"
        aria-labelledby={activeTabKey ? workspaceTabId(activeTabKey) : undefined}
      >
        {activeMode === "review" ? (
          <DiffPanel mode={props.mode} />
        ) : activeMode === "files" ? (
          <PreviewPanel mode={props.mode} />
        ) : activeMode === "terminal" ? (
          <WorkspaceTerminalPanel />
        ) : activeMode === "browser" && !isPhoneSurface ? (
          <WorkspaceBrowserPanel />
        ) : activeMode === "simulator" && !isPhoneSurface ? (
          <SimulatorPanel
            environmentId={workspaceThreadRef?.environmentId ?? null}
            threadId={workspaceThreadRef?.threadId ?? null}
          />
        ) : activeMode === "agents" && !isPhoneSurface ? (
          // The Agents workspace stays off the frozen phone tier; a phone
          // route that lands here falls back to the launcher.
          <AgentsPanel
            model={agentPanelModel}
            environmentId={workspaceThreadRef?.environmentId ?? null}
            threadId={workspaceThreadRef ? (workspaceThreadRef.threadId as ThreadId) : null}
            onOpenAgent={openRuntimeAgent}
            subagents={subagents}
            selectedAgentId={agentKey}
            onBack={() => navigateSearch((previous) => buildOpenAgentsSearch(previous))}
          />
        ) : activeMode === "agent" ? (
          <AgentThreadPanel subagent={activeAgent} agentKey={agentKey} />
        ) : (
          <WorkspaceLauncher
            tabs={tabs}
            activeThread={activeThread}
            onSelectTab={selectTab}
            showAgents={!isPhoneSurface}
            showSimulator={
              !isPhoneSurface &&
              Boolean(
                workspaceThreadRef && readEnvironmentApi(workspaceThreadRef.environmentId)?.device,
              )
            }
            isPhoneSurface={isPhoneSurface}
            liveAgentCount={agentPanelModel.liveCount}
          />
        )}
      </div>
    </div>
  );
}
