import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "./ui/empty";
import { useNavigate } from "@tanstack/react-router";
import { ArrowLeftIcon } from "lucide-react";

import { SidebarInset } from "./ui/sidebar";
import { Button } from "./ui/button";
import { HostedConnectionControl } from "./hostedHub/HostedConnectionControls";
import { HostedRelayTrustNotice } from "./hostedHub/HostedRelayTrustNotice";
import { isElectron, isHostedHubMode } from "../env";
import { navigateHub } from "../hostedHub/hubRoutes";
import {
  APP_SIDEBAR_CHROME_INSET_TRANSITION_CLASS,
  COLLAPSED_APP_SIDEBAR_CHROME_INSET_CLASS,
} from "../appChrome";
import { useAppSidebarCollapsed } from "../hooks/useAppSidebarCollapsed";
import { cn } from "~/lib/utils";
import { DesktopAccountConnect } from "./DesktopAccountConnect";

export function NoActiveThreadState() {
  const navigate = useNavigate();
  // Same corner ownership as the chat header: with the thread sidebar
  // collapsed this bar has to clear the shell's floating show-sidebar control.
  const appSidebarCollapsed = useAppSidebarCollapsed();
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background">
        <header
          className={cn(
            "border-b border-border pr-3 sm:pr-5",
            APP_SIDEBAR_CHROME_INSET_TRANSITION_CLASS,
            appSidebarCollapsed ? COLLAPSED_APP_SIDEBAR_CHROME_INSET_CLASS : "pl-3 sm:pl-5",
            isElectron
              ? "drag-region flex h-[52px] items-center wco:h-[env(titlebar-area-height)]"
              : "py-2 sm:py-3",
          )}
        >
          {isElectron ? (
            <span className="text-xs text-muted-foreground/50 wco:pr-[calc(100vw-env(titlebar-area-width)-env(titlebar-area-x)+1em)]">
              No active thread
            </span>
          ) : (
            <div className="flex items-center gap-2">
              {/* This surface is reachable on the phone tier through stale or
                  deleted thread links; with no drawer on the phone shell the
                  way out is the URL-driven stack, so offer Home explicitly. */}
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label="Back to threads"
                className="shrink-0 not-phone:hidden"
                onClick={() => void navigate({ to: "/" })}
              >
                <ArrowLeftIcon />
              </Button>
              <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground md:text-muted-foreground/60">
                No active thread
              </span>
              {/* Hosted connection control stays reachable without an active
                  thread (pill and sheet on phone, inline menu on desktop);
                  renders nothing outside hosted-hub sessions. */}
              <HostedConnectionControl />
            </div>
          )}
        </header>

        <Empty className="flex-1">
          <div className="w-full max-w-lg rounded-3xl border border-border/55 bg-card/20 px-8 py-12 shadow-sm/5">
            <EmptyHeader className="max-w-none">
              <EmptyTitle className="text-foreground text-xl">Pick a thread to continue</EmptyTitle>
              <EmptyDescription className="mt-2 text-sm text-muted-foreground/78">
                Select an existing thread or create a new one to get started.
              </EmptyDescription>
              {isElectron ? <DesktopAccountConnect /> : null}
              {isHostedHubMode() ? (
                <div className="mt-5 space-y-3 text-left">
                  <Button variant="outline" onClick={() => navigateHub({ kind: "nodes" })}>
                    Manage nodes
                  </Button>
                  <HostedRelayTrustNotice compact />
                </div>
              ) : null}
            </EmptyHeader>
          </div>
        </Empty>
      </div>
    </SidebarInset>
  );
}
