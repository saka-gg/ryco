import { resolveSnoozePresets } from "@ryco/shared/threadSnooze";
import { scopeThreadRef } from "@ryco/client-runtime/scoped";
import {
  CheckIcon,
  ClockIcon,
  GitBranchIcon,
  GitForkIcon,
  LoaderCircleIcon,
  MoreHorizontalIcon,
  ShieldAlertIcon,
  Undo2Icon,
} from "lucide-react";
import { useMemo, useRef, useState } from "react";

import { readEnvironmentApi } from "../../environmentApi";
import { useSettings } from "../../hooks/useSettings";
import { useGitStatus } from "../../lib/gitStatusState";
import { cn, newCommandId } from "../../lib/utils";
import { resolveSourceControlRefreshDelay } from "../../rpc/sourceControlRefreshPolicy";
import { useSourceControlChangeRequestDetail } from "../../rpc/useSourceControl";
import { sidebarUndo } from "../../sidebarUndo";
import { resolveChangeRequestPresentation } from "../../sourceControlPresentation";
import { formatElapsedClockLabel } from "../../timestampFormat";
import { useUiStateStore } from "../../uiStateStore";
import { DeviceIcon } from "../DeviceIcon";
import { isCompletionUnseen } from "../Sidebar.logic";
import type { useThreadMenuActions } from "../sidebar/hooks/useThreadMenuActions";
import { useIsIntersectingViewport } from "../sidebar/hooks/useHasIntersectedViewport";
import {
  ContextMenu,
  ContextMenuPopup,
  ContextMenuTrigger,
  Menu,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "../ui/menu";
import { toastManager } from "../ui/toast";
import { Tooltip, type TooltipCreateHandle, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { InboxPullRequestBadges } from "./InboxPullRequestBadges";
import { resolveInboxPullRequest, resolveInboxPullRequests } from "./inboxPullRequests";
import { InboxProjectIcon, type InboxRowPreviewPayload } from "./InboxRowPreview";
import {
  formatInboxAge,
  inboxGlyphLabel,
  type InboxStateLine,
  resolveInboxGlyph,
  resolveInboxStateLine,
} from "./inboxRowPresentation";
import type { InboxSidebarRow } from "./inboxSidebarModel";
import { InboxStatusGlyph } from "./InboxStatusGlyph";
import {
  INBOX_ROW_LEAVING_EVENT,
  readInboxMotionDurationMs,
  useInboxClock,
  useInboxEnterAnimation,
} from "./useInboxListMotion";

export type InboxThreadActions = Pick<
  ReturnType<typeof useThreadMenuActions>,
  "listThreadMenuActions" | "performThreadMenuAction"
>;
export type InboxPreviewHandle = ReturnType<typeof TooltipCreateHandle<InboxRowPreviewPayload>>;

const LINE_TONE: Record<InboxStateLine["kind"], string> = {
  attention: "font-medium text-warning-foreground",
  error: "text-destructive-foreground",
  status: "text-muted-foreground",
  workspace: "text-muted-foreground",
};

const LINE_IN: Keyframe[] = [
  { opacity: 0, transform: "translateY(6px)" },
  { opacity: 1, transform: "none" },
];
const LINE_IN_OPTIONS: KeyframeAnimationOptions = {
  duration: 360,
  easing: "cubic-bezier(0.22, 1, 0.36, 1)",
};

/** Keyed by its content kind, so a state change rolls the new line in. */
function StateLine(props: { readonly line: InboxStateLine; readonly row: InboxSidebarRow }) {
  const ref = useInboxEnterAnimation<HTMLSpanElement>(LINE_IN, LINE_IN_OPTIONS);
  if (props.line.kind !== "workspace") {
    return (
      <span ref={ref} className={cn("min-w-0 flex-1 truncate", LINE_TONE[props.line.kind])}>
        {props.line.text}
      </span>
    );
  }
  const WorkspaceIcon = props.row.isWorktree ? GitForkIcon : GitBranchIcon;
  const workspace = props.row.branchLabel ?? props.row.workspaceLabel;
  return (
    <span
      ref={ref}
      aria-label={`${props.row.isWorktree ? "Worktree" : "Original directory"}: ${workspace}`}
      className="flex min-w-0 flex-1 items-center gap-1"
    >
      <WorkspaceIcon aria-hidden className="size-[11px] shrink-0 opacity-70" />
      <span className="truncate">{workspace}</span>
    </span>
  );
}

function RunningClock(props: { readonly since: string }) {
  const now = useInboxClock();
  return <>{formatElapsedClockLabel(props.since, now)}</>;
}

const snoozeUntilLabel = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" });

/**
 * Glyph row. Line 1: status glyph · title. Line 2: the project icon sits under
 * the glyph, then the state line, the change request and the time. Settled and
 * snoozed rows collapse to one line led by the project icon.
 */
export function InboxThreadRow(props: {
  readonly threadActions?: InboxThreadActions | undefined;
  readonly row: InboxSidebarRow;
  readonly active: boolean;
  readonly motionEnabled: boolean;
  readonly previewHandle: InboxPreviewHandle;
  readonly onOpen: () => void;
  readonly onSetSettlement: (row: InboxSidebarRow, settled: boolean) => Promise<boolean>;
}) {
  const { row } = props;
  const [menuOpen, setMenuOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [settling, setSettling] = useState(false);
  const shellRef = useRef<HTMLDivElement>(null);
  const [setVisibilityNode, isIntersecting] = useIsIntersectingViewport();
  const sourceControlEnabled = row.sourceControlEnabled && (props.active || isIntersecting);
  const gitStatus = useGitStatus(
    { environmentId: row.environmentId, cwd: row.branchLabel ? row.gitCwd : null },
    { enabled: sourceControlEnabled },
  );
  const currentPr = resolveInboxPullRequest(row, gitStatus.data);
  const refreshMode = useSettings((settings) => settings.sourceControlRefreshMode);
  const detail = useSourceControlChangeRequestDetail(
    {
      environmentId: row.environmentId,
      cwd: row.gitCwd,
      reference: currentPr ? String(currentPr.number) : null,
      enabled: sourceControlEnabled,
    },
    (data) =>
      resolveSourceControlRefreshDelay({
        mode: refreshMode,
        phase:
          data?.state === "open" || data?.stack?.entries.some((entry) => entry.state === "open")
            ? "active"
            : "settled",
      }),
  );
  const pullRequests = resolveInboxPullRequests(currentPr, detail.data);
  const changeRequestShortName = resolveChangeRequestPresentation(
    gitStatus.data?.sourceControlProvider,
  ).shortName;
  const lastVisitedAt = useUiStateStore((state) => state.threadLastVisitedAtById[row.key]);
  const resting = row.settled || row.snoozedUntil !== null;
  const unseen =
    row.state === "idle" &&
    !resting &&
    !props.active &&
    isCompletionUnseen(row.latestTurnCompletedAt, lastVisitedAt);
  const glyph = settling ? "completed" : resolveInboxGlyph(row, unseen);
  const glyphLabel = inboxGlyphLabel(row, unseen);
  const line = resolveInboxStateLine(row);
  const timestamp = row.settled
    ? (row.effectiveSettlementTimestamp ?? row.updatedAt)
    : row.updatedAt;
  const previewPayload = useMemo<InboxRowPreviewPayload>(
    () => ({ row, unseen, timestamp, pullRequests, changeRequestShortName }),
    [row, unseen, timestamp, pullRequests, changeRequestShortName],
  );

  const actionLabel = row.settled ? "Move to Active" : "Settle";
  const actionEnabled = row.settlementActionEnabled && !pending;
  const actionTitle = actionEnabled
    ? actionLabel
    : (row.settlementDisabledReason ?? "Settlement is temporarily unavailable.");
  const handleSettlement = async () => {
    if (!actionEnabled) return;
    const shell = shellRef.current;
    const duration = props.motionEnabled && !row.settled ? readInboxMotionDurationMs() : 0;
    // Pinned threads stay in Pinned once settled; only leaving rows collapse.
    const leaves = !row.pinned;
    let collapse: Animation | null = null;
    setPending(true);
    if (shell && duration > 0) {
      setSettling(true);
      shell.dispatchEvent(new Event(INBOX_ROW_LEAVING_EVENT, { bubbles: true }));
      if (leaves) {
        shell.style.overflow = "hidden";
        collapse = shell.animate(
          [
            { height: `${shell.offsetHeight}px`, opacity: 1, transform: "none" },
            { height: "0px", opacity: 0, transform: "translateX(-10px)" },
          ],
          {
            duration: duration * 1.3,
            delay: duration * 1.2,
            easing: "cubic-bezier(0.22, 1, 0.36, 1)",
            fill: "forwards",
          },
        );
      }
    }
    const restore = () => {
      collapse?.cancel();
      if (shell) shell.style.overflow = "";
      setSettling(false);
    };
    try {
      const ok = await props.onSetSettlement(row, !row.settled);
      if (!ok) restore();
      // A thread the server keeps in place must not stay collapsed.
      else if (collapse) window.setTimeout(() => shell?.isConnected && restore(), 5_000);
      else setSettling(false);
    } finally {
      setPending(false);
    }
  };
  const snoozePresets = useMemo(
    () => (menuOpen ? resolveSnoozePresets(new Date()) : []),
    [menuOpen],
  );
  const handleSnooze = async (snoozedUntil: string | null) => {
    if (pending || !(snoozedUntil ? row.canSnooze : row.canUnsnooze)) return;
    setPending(true);
    try {
      const api = readEnvironmentApi(row.environmentId);
      if (!api) throw new Error("The owning machine is not connected.");
      await sidebarUndo.dispatch(
        { environmentId: row.environmentId, threadId: row.threadId },
        snoozedUntil
          ? {
              type: "thread.snooze",
              commandId: newCommandId(),
              threadId: row.threadId,
              snoozedUntil,
            }
          : { type: "thread.unsnooze", commandId: newCommandId(), threadId: row.threadId },
      );
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not update snooze",
        description: error instanceof Error ? error.message : "The request failed.",
      });
    } finally {
      setPending(false);
    }
  };
  const handleMenuOpenChange = (open: boolean) => {
    setMenuOpen(open);
    if (open) props.previewHandle.close();
  };
  const menuItems = (
    <>
      {props.threadActions?.listThreadMenuActions(row.key).map((item) => (
        <MenuItem
          key={item.id}
          variant={item.destructive ? "destructive" : "default"}
          disabled={!row.mutationEnabled && ["rename", "archive", "close"].includes(item.id)}
          onClick={() =>
            void props.threadActions?.performThreadMenuAction(
              scopeThreadRef(row.environmentId, row.threadId),
              item.id,
            )
          }
        >
          {item.label}
        </MenuItem>
      ))}
      <MenuSeparator />
      {row.snoozedUntil ? (
        <MenuItem disabled={!row.canUnsnooze || pending} onClick={() => void handleSnooze(null)}>
          Unsnooze
        </MenuItem>
      ) : (
        <MenuSub>
          <MenuSubTrigger disabled={!row.canSnooze || pending}>Snooze</MenuSubTrigger>
          <MenuSubPopup>
            {snoozePresets.map((preset) => (
              <MenuItem key={preset.id} onClick={() => void handleSnooze(preset.snoozedUntil)}>
                {preset.label}
                <span className="ml-auto pl-4 text-xs text-muted-foreground">
                  {snoozeUntilLabel(preset.snoozedUntil)}
                </span>
              </MenuItem>
            ))}
          </MenuSubPopup>
        </MenuSub>
      )}
      <MenuItem disabled={!actionEnabled} onClick={() => void handleSettlement()}>
        {actionLabel}
      </MenuItem>
    </>
  );

  const trustWarning = row.trustLabel === "Not verified" || row.trustLabel === "Identity conflict";
  const navigationButton = (
    <button
      ref={setVisibilityNode}
      type="button"
      aria-current={props.active ? "page" : undefined}
      className={cn(
        "relative grid w-full min-w-0 grid-cols-[1.375rem_minmax(0,1fr)_auto] rounded-lg px-2 text-left outline-hidden ring-ring focus-visible:ring-2 aria-[current=page]:bg-sidebar-accent",
        resting ? "items-center py-1" : "py-1.5",
      )}
      data-testid="inbox-thread-row"
      onClick={props.onOpen}
    >
      <span className="flex h-[18px] items-center">
        {resting ? (
          <InboxProjectIcon row={row} />
        ) : (
          <InboxStatusGlyph key={glyph} kind={glyph} label={glyphLabel} />
        )}
      </span>
      <span
        className={cn(
          "inbox-row-title relative min-w-0 truncate font-medium transition-[padding-right,color] duration-(--app-motion-duration-pop) ease-(--app-motion-spring-gentle) motion-reduce:transition-none",
          // Size before leading: tailwind-merge drops a leading that precedes a size.
          resting
            ? "text-xs leading-[18px] text-muted-foreground group-hover/inbox-row:pr-3 group-focus-within/inbox-row:pr-3"
            : "text-[13px] leading-[18px] group-hover/inbox-row:pr-11 group-focus-within/inbox-row:pr-11",
          !resting &&
            (unseen
              ? "font-semibold text-sidebar-foreground"
              : settling
                ? "text-muted-foreground"
                : props.active
                  ? "text-sidebar-foreground"
                  : "text-sidebar-foreground/85 group-hover/inbox-row:text-sidebar-foreground"),
        )}
      >
        {row.title}
      </span>
      {resting ? (
        <span className="flex min-w-0 items-center gap-1 pl-2 text-[11px] tabular-nums text-muted-foreground/70 transition-opacity duration-(--app-motion-duration-chip) motion-reduce:transition-none group-hover/inbox-row:opacity-0 group-focus-within/inbox-row:opacity-0">
          {row.showProject ? (
            <span className="max-w-20 truncate text-muted-foreground/60">{row.projectLabel}</span>
          ) : null}
          {row.snoozedUntil ? (
            <>
              <ClockIcon aria-label="Snoozed until" className="size-3" />
              {snoozeUntilLabel(row.snoozedUntil)}
            </>
          ) : (
            formatInboxAge(timestamp)
          )}
        </span>
      ) : (
        <span className="col-span-3 grid min-w-0 grid-cols-[1.375rem_minmax(0,1fr)] items-center pt-px text-[11.5px] leading-4 text-muted-foreground">
          <span className="flex items-center">
            <InboxProjectIcon row={row} />
          </span>
          <span className="flex min-w-0 items-center gap-1.5">
            {row.showProject ? (
              <span className="max-w-[45%] shrink-0 truncate font-medium text-sidebar-foreground/70">
                {row.projectLabel}
              </span>
            ) : null}
            {row.showMachine ? (
              <DeviceIcon
                environmentId={row.environmentId}
                label={row.machineLabel}
                className="size-3 shrink-0 text-muted-foreground/70"
              />
            ) : null}
            {trustWarning ? (
              <ShieldAlertIcon
                aria-label={row.trustLabel ?? undefined}
                className={cn(
                  "size-3 shrink-0",
                  row.trustLabel === "Identity conflict"
                    ? "text-destructive-foreground"
                    : "text-warning-foreground",
                )}
              />
            ) : null}
            <StateLine
              key={line.kind === "workspace" ? "workspace" : `${line.kind}:${line.text}`}
              line={line}
              row={row}
            />
            <InboxPullRequestBadges
              {...pullRequests}
              currentNumber={currentPr?.number ?? null}
              shortName={changeRequestShortName}
              variant="inline"
            />
            <span className="shrink-0 tabular-nums text-muted-foreground/70">
              {row.runningSince ? (
                <RunningClock since={row.runningSince} />
              ) : (
                formatInboxAge(timestamp)
              )}
            </span>
          </span>
        </span>
      )}
    </button>
  );

  const revealAction =
    "opacity-0 translate-x-1.5 scale-90 transition-[opacity,translate,scale,background-color,color] duration-(--app-motion-duration-pop) ease-(--app-motion-spring-snappy) motion-reduce:transition-none group-hover/inbox-row:translate-x-0 group-hover/inbox-row:scale-100 group-hover/inbox-row:opacity-100 group-focus-within/inbox-row:translate-x-0 group-focus-within/inbox-row:scale-100 group-focus-within/inbox-row:opacity-100 focus-visible:opacity-100 motion-reduce:translate-x-0 motion-reduce:scale-100";
  return (
    <ContextMenu onOpenChange={handleMenuOpenChange}>
      <ContextMenuTrigger
        ref={shellRef}
        render={<div />}
        className={cn(
          "group/inbox-row relative [content-visibility:auto]",
          resting
            ? "[contain-intrinsic-block-size:auto_1.75rem]"
            : "[contain-intrinsic-block-size:auto_3.25rem]",
        )}
        data-testid="inbox-thread-row-shell"
        // INBOX_ROW_KEY_ATTRIBUTE: the list motion hook tracks rows by this key.
        data-inbox-row-key={row.key}
        data-settling={settling ? "" : undefined}
      >
        <TooltipTrigger
          handle={props.previewHandle}
          payload={previewPayload}
          closeDelay={80}
          delay={300}
          render={navigationButton}
        />
        <div className="absolute right-1.5 top-1 z-10 flex items-center">
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  aria-disabled={!actionEnabled}
                  aria-label={`${actionLabel} ${row.title}`}
                  className={cn(
                    "inbox-settle-action flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring aria-disabled:cursor-not-allowed aria-disabled:text-muted-foreground/40 aria-disabled:hover:bg-transparent",
                    revealAction,
                  )}
                  onClick={() => void handleSettlement()}
                  type="button"
                />
              }
            >
              {pending ? (
                <LoaderCircleIcon aria-hidden className="size-3.5 animate-spin" />
              ) : row.settled ? (
                <Undo2Icon aria-hidden className="size-3.5" />
              ) : (
                <CheckIcon aria-hidden className="size-3.5" />
              )}
            </TooltipTrigger>
            <TooltipPopup side="top">{actionTitle}</TooltipPopup>
          </Tooltip>
          <Menu onOpenChange={handleMenuOpenChange}>
            <MenuTrigger
              aria-label={`Thread actions for ${row.title}`}
              className={cn(
                "flex size-6 items-center justify-center rounded-md text-muted-foreground delay-40 hover:bg-sidebar-accent hover:text-sidebar-foreground data-popup-open:translate-x-0 data-popup-open:scale-100 data-popup-open:opacity-100",
                revealAction,
              )}
            >
              <MoreHorizontalIcon className="size-3.5" />
            </MenuTrigger>
            <MenuPopup align="start">{menuItems}</MenuPopup>
          </Menu>
        </div>
      </ContextMenuTrigger>
      <ContextMenuPopup>{menuItems}</ContextMenuPopup>
    </ContextMenu>
  );
}
