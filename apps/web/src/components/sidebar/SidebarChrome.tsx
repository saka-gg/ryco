import {
  BarChart3Icon,
  FolderTreeIcon,
  InboxIcon,
  PanelLeftCloseIcon,
  SettingsIcon,
} from "lucide-react";
import React, { memo, useCallback } from "react";
import { Link, useLocation } from "@tanstack/react-router";
import { WS_METHODS } from "@ryco/contracts";
import { APP_BASE_NAME, APP_STAGE_LABEL, APP_VERSION } from "../../branding";
import { useSettingsDialogStore } from "../../settingsDialogStore";
import { SETTINGS_ROUTE_PATH } from "../../settingsRoute";
import { SidebarFooter, SidebarHeader, useSidebar } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { RycoLetterMark } from "../RycoLetterMark";
import { SidebarUpdatePill } from "./SidebarUpdatePill";
import { SidebarProviderUpdatePill } from "./SidebarProviderUpdatePill";
import { useHostedRpcCapability } from "../../hostedHub/capabilities";
import { cn } from "../../lib/utils";
import type { SidebarMode } from "../../uiStateStore";

const SIDEBAR_HEADER_ACTION_CLASS_NAME =
  "inline-flex shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-1.5 py-1 text-muted-foreground/70 outline-hidden ring-ring transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2";

export const SidebarChromeHeader = memo(function SidebarChromeHeader({
  isElectron,
  mode,
  onModeChange,
}: {
  isElectron: boolean;
  mode: SidebarMode;
  onModeChange: (mode: SidebarMode) => void;
}) {
  const { isMobile, setOpenMobile, toggleSidebar } = useSidebar();
  const pathname = useLocation({ select: (location) => location.pathname });
  const statisticsCapability = useHostedRpcCapability(WS_METHODS.serverGetStatistics);
  const openSettings = useSettingsDialogStore((s) => s.openSettings);
  const handleSettingsClick = useCallback(() => {
    if (isMobile) {
      setOpenMobile(false);
    }
    openSettings();
  }, [isMobile, openSettings, setOpenMobile]);
  const nextMode = mode === "inbox" ? "projects" : "inbox";
  const ModeIcon = mode === "inbox" ? InboxIcon : FolderTreeIcon;
  const nextModeLabel = nextMode === "inbox" ? "Inbox" : "Projects";

  const actionButtons = (
    <div className="ml-auto flex shrink-0 items-center gap-0.5">
      {statisticsCapability.allowed ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <Link
                to="/statistics"
                aria-label="Open statistics"
                aria-current={pathname === "/statistics" ? "page" : undefined}
                onClick={() => {
                  if (isMobile) setOpenMobile(false);
                }}
                className={cn(
                  SIDEBAR_HEADER_ACTION_CLASS_NAME,
                  // Reserve narrow headers for the mode, settings, and collapse controls.
                  "@max-[10rem]/sidebar-header:hidden",
                  pathname === "/statistics" && "bg-sidebar-accent text-sidebar-accent-foreground",
                )}
              >
                <BarChart3Icon className="size-3.5" />
              </Link>
            }
          />
          <TooltipPopup side="bottom" sideOffset={2}>
            Statistics
          </TooltipPopup>
        </Tooltip>
      ) : null}
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              aria-label="Settings"
              aria-current={pathname === SETTINGS_ROUTE_PATH ? "page" : undefined}
              onClick={handleSettingsClick}
              className={cn(
                SIDEBAR_HEADER_ACTION_CLASS_NAME,
                pathname === SETTINGS_ROUTE_PATH &&
                  "bg-sidebar-accent text-sidebar-accent-foreground",
              )}
            >
              <SettingsIcon className="size-3.5" />
            </button>
          }
        />
        <TooltipPopup side="bottom" sideOffset={2}>
          Settings
        </TooltipPopup>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              aria-label="Hide sidebar"
              onClick={toggleSidebar}
              className={SIDEBAR_HEADER_ACTION_CLASS_NAME}
            >
              <PanelLeftCloseIcon className="size-3.5" />
            </button>
          }
        />
        <TooltipPopup side="bottom" sideOffset={2}>
          Hide sidebar
        </TooltipPopup>
      </Tooltip>
    </div>
  );

  const brandRow = (
    <div className="@container/sidebar-header flex w-full min-w-0 items-center gap-2">
      <Tooltip>
        <TooltipTrigger
          render={
            <Link
              aria-label="Go to threads"
              className="ml-1 flex shrink-0 cursor-pointer items-center rounded-md outline-hidden ring-ring transition-opacity hover:opacity-80 focus-visible:ring-2"
              to="/"
            >
              <RycoLetterMark className="h-4.5 text-foreground" />
            </Link>
          }
        />
        {/* The release stage moved off the header with the wordmark badge, so
            the tooltip carries it — a Dev or Nightly build still has to be
            identifiable without opening settings. */}
        <TooltipPopup side="bottom" sideOffset={2}>
          {APP_BASE_NAME} {APP_STAGE_LABEL} · Version {APP_VERSION}
        </TooltipPopup>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              aria-label={`Show ${nextModeLabel} sidebar`}
              aria-pressed={mode === "inbox"}
              onClick={() => onModeChange(nextMode)}
              className={cn(
                "inline-flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md outline-hidden ring-ring transition-colors focus-visible:ring-2 [-webkit-app-region:no-drag]",
                mode === "inbox"
                  ? "bg-primary/10 text-primary hover:bg-primary/15"
                  : "text-muted-foreground/70 hover:bg-accent hover:text-foreground",
              )}
            >
              <ModeIcon className="size-4" />
            </button>
          }
        />
        <TooltipPopup side="bottom" sideOffset={2}>
          Switch to {nextModeLabel}
        </TooltipPopup>
      </Tooltip>
      {actionButtons}
    </div>
  );

  return isElectron ? (
    <SidebarHeader className="drag-region h-[52px] flex-row items-center gap-2 px-4 py-0 pl-[90px] wco:h-[env(titlebar-area-height)] wco:pl-[calc(env(titlebar-area-x)+1em)]">
      {brandRow}
    </SidebarHeader>
  ) : (
    <SidebarHeader className="gap-3 px-3 py-2 sm:gap-2.5 sm:px-4 sm:py-3">{brandRow}</SidebarHeader>
  );
});

export const SidebarChromeFooter = memo(function SidebarChromeFooter() {
  return (
    <SidebarFooter className="p-2">
      <SidebarProviderUpdatePill />
      <SidebarUpdatePill />
    </SidebarFooter>
  );
});
