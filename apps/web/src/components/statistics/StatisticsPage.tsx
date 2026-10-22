import { WS_METHODS } from "@ryco/contracts";
import { ActivityIcon, BarChart3Icon, GaugeIcon, ShieldAlertIcon } from "lucide-react";

import { useHostedRpcCapability } from "~/hostedHub/capabilities";
import { useHostedHubStore } from "~/hostedHub/state";
import { hostedCapabilityCopy, hostedSwitchTargetLabel } from "~/hostedHub/switchTarget";
import { cn } from "~/lib/utils";
import {
  APP_SIDEBAR_CHROME_INSET_TRANSITION_CLASS,
  COLLAPSED_APP_SIDEBAR_CHROME_INSET_CLASS,
} from "~/appChrome";
import { useAppSidebarCollapsed } from "~/hooks/useAppSidebarCollapsed";

import { SidebarInset } from "../ui/sidebar";
import { ScrollArea } from "../ui/scroll-area";
import { StatePanel } from "../settings/statistics/parts";
import { ActivityView } from "./activity/ActivityView";
import { LimitsView } from "./limits/LimitsView";
import type { StatisticsSearch } from "./statisticsSearch";
import { UsageView } from "./usage/UsageView";

export function StatisticsPage({
  search,
  onSearchChange,
}: {
  readonly search: StatisticsSearch;
  readonly onSearchChange: (next: StatisticsSearch) => void;
}) {
  const appSidebarCollapsed = useAppSidebarCollapsed();
  const method =
    search.view === "usage"
      ? WS_METHODS.serverGetUsageSummary
      : search.view === "limits"
        ? WS_METHODS.serverReadCliProxyHubs
        : WS_METHODS.serverGetStatistics;
  // hosted-capability: routed node
  const capability = useHostedRpcCapability(method, null);
  const nodeLabel = useHostedHubStore((state) => hostedSwitchTargetLabel(state));
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <header
          className={cn(
            "app-content-surface flex min-h-14 shrink-0 flex-wrap items-center gap-x-5 gap-y-2 border-b border-border/75 bg-background/90 py-2 pr-5 backdrop-blur-sm sm:pr-7",
            APP_SIDEBAR_CHROME_INSET_TRANSITION_CLASS,
            appSidebarCollapsed ? COLLAPSED_APP_SIDEBAR_CHROME_INSET_CLASS : "pl-5 sm:pl-7",
          )}
        >
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-5 gap-y-2">
            <div className="min-w-0">
              <h1 className="truncate text-sm font-semibold tracking-tight">Statistics</h1>
              <p className="text-[11px] text-muted-foreground">Usage and work signals</p>
            </div>
            <div className="inline-flex shrink-0 rounded-lg bg-muted/75 p-0.5">
              {(["usage", "activity", "limits"] as const).map((view) => {
                const Icon =
                  view === "usage" ? BarChart3Icon : view === "activity" ? ActivityIcon : GaugeIcon;
                return (
                  <button
                    key={view}
                    type="button"
                    onClick={() => onSearchChange({ ...search, view })}
                    className={cn(
                      "inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-xs font-medium capitalize transition-colors",
                      search.view === view
                        ? "bg-background text-foreground shadow-xs"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    <Icon className="size-3.5" /> {view}
                  </button>
                );
              })}
            </div>
          </div>
          <div className="hidden text-right sm:block">
            {search.view === "limits" ? (
              <>
                <p className="text-xs font-medium">Live subscription quota</p>
                <p className="text-[11px] text-muted-foreground">
                  From providers and CLIProxyAPI hubs
                </p>
              </>
            ) : (
              <>
                <p className="text-xs font-medium">
                  {search.range === "all"
                    ? "All available history"
                    : `Last ${search.range.slice(0, -1)} days`}
                </p>
                <p className="text-[11px] text-muted-foreground">
                  {search.view === "usage" ? "Local calendar window" : "UTC activity window"}
                </p>
              </>
            )}
          </div>
        </header>

        <ScrollArea className="min-h-0 flex-1">
          <div className="mx-auto w-full max-w-[1480px] px-5 py-7 sm:px-8 sm:py-9 lg:px-10">
            {!capability.allowed ? (
              <StatePanel
                icon={ShieldAlertIcon}
                title="Statistics aren’t available for this session"
                description={
                  hostedCapabilityCopy(capability, nodeLabel) ?? "Owner access is required."
                }
              />
            ) : search.view === "usage" ? (
              <UsageView search={search} onSearchChange={onSearchChange} />
            ) : search.view === "limits" ? (
              <LimitsView search={search} onSearchChange={onSearchChange} />
            ) : (
              <ActivityView search={search} onSearchChange={onSearchChange} />
            )}
          </div>
        </ScrollArea>
      </div>
    </SidebarInset>
  );
}
