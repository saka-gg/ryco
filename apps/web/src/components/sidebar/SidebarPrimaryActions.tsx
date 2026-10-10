import { AGENT_CONTROL_WS_METHODS, type EnvironmentId, WS_METHODS } from "@ryco/contracts";
import { Link, useLocation } from "@tanstack/react-router";
import { CalendarClockIcon, FoldersIcon, GitPullRequestIcon, PlusIcon } from "lucide-react";
import { type CSSProperties, memo, type ReactElement, type ReactNode, useEffect } from "react";

import { usePresentationTier } from "../../hooks/usePresentationTier";
import { useHostedRpcCapability } from "../../hostedHub/capabilities";
import { cn } from "../../lib/utils";
import { PROJECTS_ROUTE_PATH } from "../../projectsRoute";
import { PULL_REQUESTS_ROUTE_PATH } from "../../pullRequestsRoute";
import { type SidebarMode, useUiStateStore } from "../../uiStateStore";

import { openAutomationsDialog } from "../automations/automationsDialogStore";
import { useWaitingAutomationRuns } from "../automations/useWaitingAutomationRuns";
import type { InboxSidebarEnvironment } from "../inboxSidebar/inboxSidebarModel";
import { Kbd } from "../ui/kbd";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  SIDEBAR_FOLDED_HEADER_HEIGHT_PX,
  sidebarRestHeaderHeight,
  useSidebarFoldStore,
} from "./sidebarFold";
import { SidebarOmnifield } from "./SidebarOmnifield";

const DESTINATION_CLASS_NAME =
  "sidebar-fold-item sidebar-fold-destination flex cursor-pointer items-center rounded-lg text-left text-xs outline-hidden ring-ring hover:bg-sidebar-accent hover:text-foreground focus-visible:ring-2";

export interface SidebarPrimaryActionsProps {
  readonly mode: SidebarMode;
  readonly newThreadShortcutLabel: string | null;
  readonly newThreadDisabled: boolean;
  readonly onNewThread: () => void;
  readonly searchShortcutLabel: string | null;
  readonly environments: ReadonlyArray<InboxSidebarEnvironment>;
  readonly primaryEnvironmentId: EnvironmentId | null;
}

/**
 * Sidebar-level entry points shared by the Projects and Inbox modes, above the
 * mode-specific list.
 *
 * The Omnifield narrows the Inbox list (or, in Projects mode, searches) and
 * hands any text to the command palette as "Search everywhere"; its ⌘K chip
 * opens the palette, the one place for everything else. "+" starts a thread in
 * the project you last worked in. "Automations" opens the schedules dialog,
 * with a badge for runs waiting for approval on any connected device; "Pull
 * requests" and "Projects" open their pages.
 *
 * While a list is scrolled, all of it folds into one toolbar row
 * (sidebarFold.ts) and the list gets the space back.
 */
export const SidebarPrimaryActions = memo(function SidebarPrimaryActions(
  props: SidebarPrimaryActionsProps,
) {
  const pathname = useLocation({ select: (location) => location.pathname });
  const phone = usePresentationTier() === "phone";
  const automationsCapability = useHostedRpcCapability(AGENT_CONTROL_WS_METHODS.automationCentre);
  const pullRequestsCapability = useHostedRpcCapability(WS_METHODS.sourceControlListChangeRequests);
  const projectsCapability = useHostedRpcCapability(WS_METHODS.projectsList);
  const folded = useSidebarFoldStore((store) => store.folded);
  const setFoldEnabled = useSidebarFoldStore((store) => store.setEnabled);
  const setFoldGain = useSidebarFoldStore((store) => store.setFoldGain);
  const resetFold = useSidebarFoldStore((store) => store.reset);

  const showAutomations = automationsCapability.allowed && !phone;
  // Destinations stack (or, folded, line up) in this order; each takes the next slot.
  const pullRequestsIndex = Number(showAutomations);
  const projectsIndex = pullRequestsIndex + Number(pullRequestsCapability.allowed);
  const destinationCount = projectsIndex + Number(projectsCapability.allowed);

  // The frozen phone tier keeps a still header (AGENTS.md).
  useEffect(() => setFoldEnabled(!phone), [phone, setFoldEnabled]);
  useEffect(
    () => setFoldGain(sidebarRestHeaderHeight(destinationCount) - SIDEBAR_FOLDED_HEADER_HEIGHT_PX),
    [destinationCount, setFoldGain],
  );
  // Each mode has its own list; the other one's scroll says nothing about this one.
  useEffect(
    () =>
      useUiStateStore.subscribe((state, previous) => {
        if (state.sidebarMode !== previous.sidebarMode) resetFold();
      }),
    [resetFold],
  );

  return (
    <div
      className="sidebar-fold"
      data-folded={folded}
      data-testid="sidebar-primary-actions"
      style={{ "--sidebar-fold-rows": destinationCount } as CSSProperties}
    >
      <SidebarOmnifield
        mode={props.mode}
        folded={folded}
        environments={props.environments}
        primaryEnvironmentId={props.primaryEnvironmentId}
        paletteShortcutLabel={props.searchShortcutLabel}
      />
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              aria-label="New thread"
              disabled={props.newThreadDisabled}
              onClick={props.onNewThread}
              data-testid="sidebar-new-thread-button"
              className="sidebar-fold-item sidebar-fold-new grid cursor-pointer place-items-center rounded-[10px] bg-primary text-primary-foreground outline-hidden ring-ring hover:shadow-[0_0_0_4px_color-mix(in_srgb,var(--primary)_10%,transparent)] focus-visible:ring-2 active:scale-90 disabled:pointer-events-none disabled:opacity-50"
            />
          }
        >
          <PlusIcon className="size-3.5" />
        </TooltipTrigger>
        <TooltipPopup side="bottom" className="flex items-center gap-1.5">
          {props.newThreadDisabled ? "Add a project first" : "New thread"}
          {!props.newThreadDisabled && props.newThreadShortcutLabel ? (
            <Kbd className="h-4 min-w-0 rounded-sm px-1 text-[10px]">
              {props.newThreadShortcutLabel}
            </Kbd>
          ) : null}
        </TooltipPopup>
      </Tooltip>
      {showAutomations ? <AutomationsEntry folded={folded} index={0} /> : null}
      {pullRequestsCapability.allowed ? (
        <FoldedTooltip folded={folded} label="Pull requests">
          <Link
            to={PULL_REQUESTS_ROUTE_PATH}
            aria-current={pathname === PULL_REQUESTS_ROUTE_PATH ? "page" : undefined}
            data-testid="sidebar-pull-requests-link"
            style={destinationStyle(pullRequestsIndex)}
            className={cn(
              DESTINATION_CLASS_NAME,
              pathname === PULL_REQUESTS_ROUTE_PATH
                ? "bg-sidebar-accent text-sidebar-accent-foreground"
                : "text-muted-foreground/70",
            )}
          />
        </FoldedTooltip>
      ) : null}
      {projectsCapability.allowed ? (
        <FoldedTooltip folded={folded} label="Projects">
          <Link
            to={PROJECTS_ROUTE_PATH}
            aria-current={pathname === PROJECTS_ROUTE_PATH ? "page" : undefined}
            data-testid="sidebar-projects-link"
            style={destinationStyle(projectsIndex)}
            className={cn(
              DESTINATION_CLASS_NAME,
              pathname === PROJECTS_ROUTE_PATH
                ? "bg-sidebar-accent text-sidebar-accent-foreground"
                : "text-muted-foreground/70",
            )}
          />
        </FoldedTooltip>
      ) : null}
    </div>
  );
});

function destinationStyle(index: number): CSSProperties {
  return { "--sidebar-fold-index": index } as CSSProperties;
}

const DESTINATION_ICONS = {
  "Pull requests": GitPullRequestIcon,
  Projects: FoldersIcon,
} as const;

/** A destination row; once folded it is an icon whose name moves to a tooltip. */
function FoldedTooltip(props: {
  readonly folded: boolean;
  readonly label: keyof typeof DESTINATION_ICONS;
  readonly children: ReactElement;
}) {
  const Icon = DESTINATION_ICONS[props.label];
  return (
    <Tooltip disabled={!props.folded}>
      <TooltipTrigger render={props.children}>
        <Icon className="size-3.5 shrink-0" />
        <span className="sidebar-fold-label min-w-0 flex-1">{props.label}</span>
      </TooltipTrigger>
      <TooltipPopup side="bottom">{props.label}</TooltipPopup>
    </Tooltip>
  );
}

/** The Automations dialog's entry, with the waiting-run badge. */
function AutomationsEntry(props: { readonly folded: boolean; readonly index: number }) {
  const waiting = useWaitingAutomationRuns();
  return (
    <Tooltip disabled={!props.folded}>
      <TooltipTrigger
        render={
          <button
            type="button"
            data-testid="sidebar-automations-button"
            aria-label={`Automations${waiting ? `, ${waiting} ${waiting === 1 ? "run" : "runs"} waiting for approval` : ""}`}
            onClick={(event) => openAutomationsDialog({ origin: event.currentTarget })}
            style={destinationStyle(props.index)}
            className={cn(DESTINATION_CLASS_NAME, "text-muted-foreground/70")}
          />
        }
      >
        <CalendarClockIcon className="size-3.5 shrink-0" />
        <span className="sidebar-fold-label min-w-0 flex-1">Automations</span>
        {waiting ? <WaitingBadge>{waiting}</WaitingBadge> : null}
      </TooltipTrigger>
      <TooltipPopup side="bottom">Automations</TooltipPopup>
    </Tooltip>
  );
}

function WaitingBadge(props: { readonly children: ReactNode }) {
  return (
    <span className="sidebar-fold-badge inline-grid h-4 min-w-4 shrink-0 place-items-center rounded-full bg-foreground/8 px-[5px] text-[10px] font-semibold text-foreground tabular-nums">
      {props.children}
    </span>
  );
}
