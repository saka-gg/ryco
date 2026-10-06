import {
  CopyIcon,
  ExternalLinkIcon,
  FileDiffIcon,
  FolderGit2Icon,
  GitCommitHorizontalIcon,
  GitBranchIcon,
  GitPullRequestClosedIcon,
  GitPullRequestDraftIcon,
  GitPullRequestIcon,
  KeyboardIcon,
  ListChecksIcon,
  MessageSquareTextIcon,
  MoreHorizontalIcon,
  PanelLeftIcon,
  PanelsTopLeftIcon,
  PencilIcon,
  SparklesIcon,
} from "lucide-react";
import { canSubmitChangeRequestReview } from "@ryco/shared/sourceControl";
import { useLayoutEffect, useMemo, useState } from "react";

import { usePageLeadingInsetClass } from "../../hooks/usePageLeadingInsetClass";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { openExternalLink } from "../../lib/openExternalLink";
import { cn } from "../../lib/utils";
import { useUpdateChangeRequestMutation } from "../../rpc/useSourceControl";
import { PAGE_BAR_CLASS } from "../../appChrome";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { RollingText, type RollDirection } from "../chat/RollingText";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuShortcut, MenuTrigger } from "../ui/menu";
import { SlidingTabs, type SlidingTab } from "../ui/sliding-tabs";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { usePullRequestAgentHandoff } from "./agentHandoff";
import { FilesBarTools } from "./files/FilesBarTools";
import { ReviewButton } from "./files/ReviewButton";
import { KeyHint } from "./primitives";
import {
  usePullRequestHostName,
  usePullRequestSelection,
  usePullRequestsPage,
} from "./PullRequestsPageContext";
import { READER_TAB_SELECTOR_ATTRIBUTE } from "./pullRequestsFocus";
import { usePullRequestReaderStore, usePullRequestsLayoutStore } from "./pullRequestsLayoutStore";
import type { PullRequestsTab } from "./pullRequestsSearch";
import { usePullRequestsShortcut } from "./pullRequestsShortcuts";
import { NextActionButton } from "./rail/NextActionButton";
import { StackChip } from "./rail/StackChip";

export const PULL_REQUESTS_BAR_CLASS = PAGE_BAR_CLASS;

/** Inside a workspace panel the bar sits under the panel's tabs: no window chrome. */
const WORKSPACE_PULL_REQUEST_BAR_CLASS =
  "flex h-11 shrink-0 items-center gap-1.5 border-b border-border/70 pl-1.5";

/** Leading inset for whichever bar owns the window's top-left corner. */
export const usePullRequestsLeadingInsetClass = usePageLeadingInsetClass;

/**
 * Below this reader width the secondary actions (✧ agent menu, external link)
 * fold into the overflow menu. Facts — the title, the stack position and the
 * next action — never leave the bar; the title truncates instead (spec §1).
 */
const BAR_FOLD_SECONDARY_MAX_READER = 900;

/**
 * A workspace panel narrower than this keeps its bar to the tabs and actions:
 * the stack position and the next action stay on Conversation's facts, and
 * "Open in Pull requests" moves into the overflow menu.
 */
const WORKSPACE_BAR_FOLD_FACTS_MAX_READER = 520;

const ICON_BUTTON_CLASS =
  "inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-hidden transition-colors duration-(--app-motion-duration-chip) hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50";

/** The list toggle (`\`): the docked list when hidden, else the drawer. */
export function ListToggleButton() {
  const { layout } = usePullRequestsPage();
  return (
    <BarIconButton label="Pull requests" shortcut="\" onClick={layout.toggleList}>
      <PanelLeftIcon className="size-3.5" />
    </BarIconButton>
  );
}

function BarIconButton(props: {
  readonly label: string;
  readonly shortcut?: string | undefined;
  readonly onClick?: (() => void) | undefined;
  readonly children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={props.label}
            onClick={props.onClick}
            className={ICON_BUTTON_CLASS}
          >
            {props.children}
          </button>
        }
      />
      <TooltipPopup side="bottom" sideOffset={4}>
        <span className="inline-flex items-center gap-1.5">
          {props.label}
          {props.shortcut ? <KeyHint>{props.shortcut}</KeyHint> : null}
        </span>
      </TooltipPopup>
    </Tooltip>
  );
}

/**
 * The reader's single 52px bar: list toggle, tabs, the condensed title (off
 * Conversation, or once the masthead scrolls away), the rail's essentials when
 * the rail is not on screen, Files tools, then review / agent / external /
 * overflow actions.
 */
export function PullRequestBar(props: {
  /** `idPrefix` for the tabs; the reader's panels use the matching ids. */
  readonly tabsId?: string | undefined;
  /** Tabs whose panels are mounted (they get `aria-controls`). */
  readonly visitedTabs?: ReadonlyArray<PullRequestsTab> | undefined;
  /**
   * A stack-layer push mounted this bar: roll the condensed title from the
   * layer that was left (spec motion #3), in the direction of travel.
   */
  readonly titleRollFrom?: TitleRollFrom | null | undefined;
}) {
  const { layout, nav, readerKey, model, surface } = usePullRequestsPage();
  const selection = usePullRequestSelection();
  const tab = nav.tab;
  const onPage = surface.kind === "page";
  const foldFacts = !onPage && layout.readerWidth < WORKSPACE_BAR_FOLD_FACTS_MAX_READER;
  const openOnPage = surface.kind === "workspace" ? surface.openOnPage : null;
  const detail = selection.detail.data;
  const summary = selection.summary;
  const title = detail?.title ?? summary?.title ?? `#${selection.number}`;
  const url = detail?.url ?? summary?.url ?? null;
  const mastheadHidden = usePullRequestReaderStore((state) =>
    readerKey ? (state.mastheadHidden[readerKey] ?? false) : false,
  );
  const showTitle = tab !== "conversation" || mastheadHidden;
  // Narrow readers fold the agent menu and the external link into the
  // overflow menu; the title only truncates (it is `flex-1 min-w-0`).
  const foldSecondary = layout.readerWidth < BAR_FOLD_SECONDARY_MAX_READER;
  const dense = layout.barCompact;
  const agent = useAgentPromptItems();
  const hostName = usePullRequestHostName();
  const owner = onPage && layout.leadingRegion === "reader";
  const insetClass = usePullRequestsLeadingInsetClass(owner, "pl-3");
  const setShortcutsOpen = usePullRequestsLayoutStore((state) => state.setShortcutsOpen);
  const rolled = useRolledTitle(selection.number, title, props.titleRollFrom ?? null);

  const counts = useMemo(() => {
    const timeline = selection.activity.data?.timeline;
    const conversation = timeline
      ? timeline.filter((item) => item.kind === "comment" || item.kind === "review").length
      : summary?.commentsCount;
    return {
      conversation,
      files: detail?.changedFiles ?? detail?.files?.length,
      commits: detail?.commits?.length,
    };
  }, [
    detail?.changedFiles,
    detail?.commits?.length,
    detail?.files?.length,
    selection.activity.data,
    summary?.commentsCount,
  ]);

  const visitedTabs = props.visitedTabs;
  const tabs = useMemo<SlidingTab[]>(() => {
    const hasPanel = (id: PullRequestsTab) => id === tab || (visitedTabs?.includes(id) ?? false);
    // On a narrow reader the inactive tabs show only their glyph (CSS,
    // `.pr-bar-tabs`), so the name lives in the accessible name and tooltip.
    const tabFor = (
      id: PullRequestsTab,
      label: string,
      Icon: typeof MessageSquareTextIcon,
      count: number | undefined,
    ): SlidingTab => ({
      id,
      label,
      icon: <Icon className="size-3.5" />,
      ariaLabel: label,
      title: count === undefined ? label : `${label} · ${count}`,
      count: dense ? undefined : count,
      hasPanel: hasPanel(id),
    });
    return [
      tabFor("conversation", "Conversation", MessageSquareTextIcon, counts.conversation),
      tabFor("files", "Files", FileDiffIcon, counts.files),
      tabFor("checks", "Checks", ListChecksIcon, undefined),
      tabFor("commits", "Commits", GitCommitHorizontalIcon, counts.commits),
    ];
  }, [counts, dense, tab, visitedTabs]);

  usePullRequestsShortcut("1", () => nav.setTab("conversation"));
  usePullRequestsShortcut("2", () => nav.setTab("files"));
  usePullRequestsShortcut("3", () => nav.setTab("checks"));
  usePullRequestsShortcut("4", () => nav.setTab("commits"));
  usePullRequestsShortcut("o", () => {
    if (!url) return false;
    openExternalLink(url, "Unable to open pull request");
  });

  return (
    <header
      {...{ [READER_TAB_SELECTOR_ATTRIBUTE]: "" }}
      className={cn(
        onPage ? cn(PULL_REQUESTS_BAR_CLASS, insetClass) : WORKSPACE_PULL_REQUEST_BAR_CLASS,
        onPage ? "pr-3" : "pr-2",
      )}
    >
      {onPage && !layout.listVisible ? <ListToggleButton /> : null}
      <SlidingTabs
        aria-label="Pull request sections"
        variant="underline"
        tabs={tabs}
        activeId={tab}
        idPrefix={props.tabsId}
        onSelect={(id) => nav.setTab(id as PullRequestsTab)}
        className="pr-bar-tabs h-full shrink-0"
      />
      <div
        className="pr-bar-title flex min-w-0 flex-1 items-baseline gap-1.5 overflow-hidden pl-2"
        data-visible={showTitle}
        aria-hidden={!showTitle}
        // The title truncates on narrow readers; hovering shows it whole.
        title={showTitle ? `#${selection.number} ${title}` : undefined}
      >
        <RollingText
          text={rolled.number}
          direction={rolled.direction}
          className="shrink-0 text-xs text-muted-foreground tabular-nums"
        />
        <RollingText
          text={rolled.title}
          direction={rolled.direction}
          className="pr-bar-title-text min-w-0 text-[13px] font-medium"
          itemClassName="block truncate"
        />
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        {tab !== "conversation" && !foldFacts ? (
          <>
            <StackChip />
            <NextActionButton size="sm" />
          </>
        ) : null}
        {tab === "files" && model.capabilities.diff ? <FilesBarTools /> : null}
        {canSubmitChangeRequestReview(model.capabilities) ? <ReviewButton /> : null}
        {foldSecondary || !agent.supported ? null : <AgentMenu agent={agent} />}
        {url && !foldSecondary ? (
          <BarIconButton
            label={`Open on ${hostName}`}
            shortcut="O"
            onClick={() => openExternalLink(url, "Unable to open pull request")}
          >
            <ExternalLinkIcon className="size-3.5" />
          </BarIconButton>
        ) : null}
        {openOnPage && !foldFacts ? (
          <BarIconButton label="Open in Pull requests" onClick={openOnPage}>
            <PanelsTopLeftIcon className="size-3.5" />
          </BarIconButton>
        ) : null}
        <OverflowMenu
          onShowShortcuts={onPage ? () => setShortcutsOpen(true) : null}
          foldedOpenOnPage={foldFacts ? openOnPage : null}
          foldedAgent={foldSecondary ? agent : null}
          foldedExternalUrl={foldSecondary ? url : null}
          hostName={hostName}
        />
      </div>
    </header>
  );
}

interface TitleRollFrom {
  readonly number: number;
  readonly title: string;
  readonly direction: RollDirection;
}

/**
 * The condensed title's text. A bar mounted by a stack-layer push starts from
 * the layer that was left and switches before the first paint, so RollingText
 * rolls the new title in (in the direction of travel); otherwise it simply
 * shows the title.
 */
function useRolledTitle(
  number: number,
  title: string,
  rollFrom: TitleRollFrom | null,
): { readonly number: string; readonly title: string; readonly direction: RollDirection } {
  const [startFrom, setStartFrom] = useState(rollFrom);
  useLayoutEffect(() => {
    // RollingText rolls on a change it has rendered, so the left layer's title
    // commits once and is swapped before paint: a deliberate second pass.
    // oxlint-disable-next-line react/set-state-in-effect -- see above
    if (startFrom !== null) setStartFrom(null);
  }, [startFrom]);
  return {
    number: `#${startFrom?.number ?? number}`,
    title: startFrom?.title ?? title,
    direction: rollFrom?.direction ?? 1,
  };
}

interface AgentPromptItem {
  readonly kind: "ask" | "summarize" | "review";
  readonly label: string;
  readonly prompt: string;
  readonly shortcut?: string;
}

/** The ✧ menu's hand-offs, shared by the standalone menu and the folded overflow. */
function useAgentPromptItems(): {
  /** The host can check the change request out (hand-offs exist at all). */
  readonly supported: boolean;
  readonly available: boolean;
  readonly unavailableReason: string | undefined;
  readonly items: ReadonlyArray<AgentPromptItem>;
  readonly start: (item: AgentPromptItem) => void;
} {
  const handoff = usePullRequestAgentHandoff();
  const selection = usePullRequestSelection();
  const title = selection.detail.data?.title ?? selection.summary?.title ?? `#${selection.number}`;
  const items = useMemo<ReadonlyArray<AgentPromptItem>>(
    () => [
      {
        kind: "ask",
        label: "Ask about this pull request",
        prompt: `About pull request #${selection.number} (${title}): `,
        shortcut: "A",
      },
      {
        kind: "summarize",
        label: "Summarize",
        prompt: `Summarize pull request #${selection.number} (${title}) for a reviewer.`,
      },
      {
        kind: "review",
        label: "Review with an agent",
        prompt: `Review pull request #${selection.number} (${title}). Point out bugs and risky changes with file and line references.`,
      },
    ],
    [selection.number, title],
  );
  const start = (item: AgentPromptItem) =>
    void handoff.start({ kind: item.kind, prompt: item.prompt });
  usePullRequestsShortcut(
    "a",
    () => {
      const ask = items[0];
      if (!handoff.available || !ask) return false;
      start(ask);
    },
    { enabled: handoff.available },
  );
  return {
    supported: handoff.supported,
    available: handoff.available,
    unavailableReason: handoff.unavailableReason,
    items,
    start,
  };
}

function AgentMenu(props: { readonly agent: ReturnType<typeof useAgentPromptItems> }) {
  const { agent } = props;
  return (
    <Menu>
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              render={
                <button
                  type="button"
                  aria-label="Ask an agent"
                  className={ICON_BUTTON_CLASS}
                  disabled={!agent.available}
                >
                  <SparklesIcon className="size-3.5" />
                </button>
              }
            />
          }
        />
        <TooltipPopup side="bottom" sideOffset={4}>
          {agent.available ? "Ask an agent" : (agent.unavailableReason ?? "Agents are unavailable")}
        </TooltipPopup>
      </Tooltip>
      <MenuPopup align="end" className="min-w-56">
        {agent.items.map((item) => (
          <MenuItem key={item.kind} onClick={() => agent.start(item)}>
            {item.label}
            {item.shortcut ? <MenuShortcut>{item.shortcut}</MenuShortcut> : null}
          </MenuItem>
        ))}
      </MenuPopup>
    </Menu>
  );
}

function OverflowMenu(props: {
  /** Null where the shortcuts dialog is not mounted (the workspace panel). */
  readonly onShowShortcuts: (() => void) | null;
  /** A narrow workspace panel folds its "Open in Pull requests" in here. */
  readonly foldedOpenOnPage: (() => void) | null;
  /** Narrow bars fold the agent menu and the external link in here. */
  readonly foldedAgent: ReturnType<typeof useAgentPromptItems> | null;
  readonly foldedExternalUrl: string | null;
  readonly hostName: string;
}) {
  const { nav, readerKey, model } = usePullRequestsPage();
  const selection = usePullRequestSelection();
  const detail = selection.detail.data;
  const viewer = selection.activity.data?.viewer ?? null;
  const lifecycle = model.capabilities.lifecycle;
  // Viewer permissions come from the activity read; the host must apply the action too.
  const viewerCanUpdate = viewer?.canUpdate ?? false;
  const canEditTitle = viewerCanUpdate && lifecycle.has("edit");
  const canSetDraft = viewerCanUpdate && lifecycle.has("set-draft");
  const canClose = viewerCanUpdate && lifecycle.has("close");
  const canReopen = viewerCanUpdate && lifecycle.has("reopen");
  const handoff = usePullRequestAgentHandoff();
  const update = useUpdateChangeRequestMutation(selection.mutationTarget);
  const requestTitleEdit = usePullRequestReaderStore((state) => state.requestTitleEdit);
  const [confirmClose, setConfirmClose] = useState(false);
  const { copyToClipboard } = useCopyToClipboard<string>({
    onCopy: (what) =>
      toastManager.add(
        stackedThreadToast({ type: "success", title: `Copied ${what}`, timeout: 1600 }),
      ),
  });
  const url = detail?.url ?? selection.summary?.url ?? null;
  const headRefName = detail?.headRefName ?? selection.summary?.headRefName ?? null;
  const state = detail?.state ?? selection.summary?.state ?? "open";
  const isDraft = detail?.isDraft ?? selection.summary?.isDraft ?? false;

  const run = async (action: Parameters<typeof update.mutateAsync>[0], failure: string) => {
    try {
      await update.mutateAsync(action);
    } catch (error) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: failure,
          description: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  };

  const editTitle = () => {
    if (!readerKey || !canEditTitle) return false;
    nav.setTab("conversation");
    requestTitleEdit(readerKey);
  };
  usePullRequestsShortcut("e", () => editTitle(), { enabled: canEditTitle });
  const showLifecycle =
    canEditTitle ||
    (state === "open" && (canSetDraft || canClose)) ||
    (state === "closed" && canReopen);

  return (
    <>
      <Menu>
        <MenuTrigger
          render={
            <button type="button" aria-label="More actions" className={ICON_BUTTON_CLASS}>
              <MoreHorizontalIcon className="size-3.5" />
            </button>
          }
        />
        <MenuPopup align="end" className="min-w-60">
          {props.foldedOpenOnPage ? (
            <>
              <MenuItem onClick={props.foldedOpenOnPage}>
                <PanelsTopLeftIcon aria-hidden />
                Open in Pull requests
              </MenuItem>
              <MenuSeparator />
            </>
          ) : null}
          {props.foldedAgent && props.foldedAgent.available ? (
            <>
              {props.foldedAgent.items.map((item) => (
                <MenuItem key={item.kind} onClick={() => props.foldedAgent?.start(item)}>
                  <SparklesIcon aria-hidden />
                  {item.label}
                  {item.shortcut ? <MenuShortcut>{item.shortcut}</MenuShortcut> : null}
                </MenuItem>
              ))}
              <MenuSeparator />
            </>
          ) : null}
          {props.foldedExternalUrl ? (
            <MenuItem
              onClick={() =>
                props.foldedExternalUrl &&
                openExternalLink(props.foldedExternalUrl, "Unable to open pull request")
              }
            >
              <ExternalLinkIcon aria-hidden />
              Open on {props.hostName}
              <MenuShortcut>O</MenuShortcut>
            </MenuItem>
          ) : null}
          {url ? (
            <MenuItem onClick={() => copyToClipboard(url, "link")}>
              <CopyIcon aria-hidden />
              Copy link
            </MenuItem>
          ) : null}
          {headRefName ? (
            <MenuItem onClick={() => copyToClipboard(headRefName, "branch name")}>
              <GitBranchIcon aria-hidden />
              Copy branch name
            </MenuItem>
          ) : null}
          {handoff.supported ? (
            <MenuItem
              disabled={!handoff.available}
              onClick={() => void handoff.openWorktreeThread()}
            >
              <FolderGit2Icon aria-hidden />
              Check out in a worktree
            </MenuItem>
          ) : null}
          {showLifecycle ? (
            <>
              <MenuSeparator />
              {canEditTitle ? (
                <MenuItem onClick={() => editTitle()}>
                  <PencilIcon aria-hidden />
                  Edit title
                  <MenuShortcut>E</MenuShortcut>
                </MenuItem>
              ) : null}
              {state === "open" && canSetDraft ? (
                <MenuItem
                  disabled={update.isPending}
                  onClick={() =>
                    void run(
                      { kind: "set-draft", draft: !isDraft },
                      isDraft ? "Could not mark ready for review" : "Could not convert to draft",
                    )
                  }
                >
                  {isDraft ? (
                    <GitPullRequestIcon aria-hidden />
                  ) : (
                    <GitPullRequestDraftIcon aria-hidden />
                  )}
                  {isDraft ? "Mark ready for review" : "Convert to draft"}
                </MenuItem>
              ) : null}
              {state === "open" && canClose ? (
                <MenuItem variant="destructive" onClick={() => setConfirmClose(true)}>
                  <GitPullRequestClosedIcon aria-hidden />
                  Close pull request
                </MenuItem>
              ) : state === "closed" && canReopen ? (
                <MenuItem
                  disabled={update.isPending}
                  onClick={() => void run({ kind: "reopen" }, "Could not reopen the pull request")}
                >
                  <GitPullRequestIcon aria-hidden />
                  Reopen pull request
                </MenuItem>
              ) : null}
            </>
          ) : null}
          {props.onShowShortcuts ? (
            <>
              <MenuSeparator />
              <MenuItem onClick={props.onShowShortcuts}>
                <KeyboardIcon aria-hidden />
                Keyboard shortcuts
                <MenuShortcut>?</MenuShortcut>
              </MenuItem>
            </>
          ) : null}
        </MenuPopup>
      </Menu>
      <AlertDialog
        open={confirmClose}
        onOpenChange={(open) => !update.isPending && setConfirmClose(open)}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Close #{selection.number} without merging?</AlertDialogTitle>
            <AlertDialogDescription>
              The pull request stays on the host and can be reopened later. Its branch is kept.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />} disabled={update.isPending}>
              Cancel
            </AlertDialogClose>
            <Button
              variant="destructive"
              disabled={update.isPending}
              onClick={async () => {
                await run({ kind: "close" }, "Could not close the pull request");
                setConfirmClose(false);
              }}
            >
              Close pull request
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}
