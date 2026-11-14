import type { ChangeRequest, EnvironmentId } from "@ryco/contracts";
import { useDebouncedValue } from "@tanstack/react-pacer";
import { SearchIcon, RotateCwIcon } from "lucide-react";
import { useCallback, useMemo, type RefObject } from "react";
import {
  invalidateSourceControl,
  useSourceControlChangeRequestList,
  useSourceControlChangeRequestSearch,
} from "~/rpc/useSourceControl";
import { searchSourceControlSummaries } from "@ryco/shared/sourceControlSearch";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { cn } from "~/lib/utils";
import { useSettings } from "~/hooks/useSettings";
import { resolveSourceControlRefreshDelay } from "~/rpc/sourceControlRefreshPolicy";
import { PullRequestList } from "./PullRequestList";
import { getPrCheckStatusFromChangeRequest, shouldRefreshPrCheckStatus } from "./prCheckStatus";
import {
  ChangeRequestStateFilterButtons,
  type ChangeRequestStateFilter,
} from "./StateFilterButtons";
import { usePrCheckPassNotifications } from "./usePrCheckPassNotifications";
import { errorMessage } from "~/lib/errorMessage";

interface PullRequestsTabProps {
  environmentId: EnvironmentId | null;
  cwd: string | null;
  searchInputRef: RefObject<HTMLInputElement | null>;
  query: string;
  onQueryChange: (value: string) => void;
  selectedKey?: string | null;
  stateFilter: ChangeRequestStateFilter;
  onStateFilterChange: (state: ChangeRequestStateFilter) => void;
  onSelect: (changeRequest: ChangeRequest) => void;
  density?: "default" | "compact";
}

export function PullRequestsTab(props: PullRequestsTabProps) {
  const [debouncedQuery] = useDebouncedValue(props.query, { wait: 200 });
  const sourceControlRefreshMode = useSettings((settings) => settings.sourceControlRefreshMode);

  const resolveListIntervalMs = useCallback(
    (data: ReadonlyArray<ChangeRequest> | null): number | false => {
      const hasActiveChecks =
        data?.some((pr) => shouldRefreshPrCheckStatus(getPrCheckStatusFromChangeRequest(pr))) ??
        false;
      return resolveSourceControlRefreshDelay({
        mode: sourceControlRefreshMode,
        phase: hasActiveChecks ? "active" : "settled",
      });
    },
    [sourceControlRefreshMode],
  );

  const listQuery = useSourceControlChangeRequestList(
    {
      environmentId: props.environmentId,
      cwd: props.cwd,
      state: props.stateFilter,
      limit: 100,
    },
    resolveListIntervalMs,
  );

  const cachedItems = useMemo(() => listQuery.data ?? [], [listQuery.data]);
  const filteredItems = useMemo(
    () => searchSourceControlSummaries(cachedItems, props.query),
    [cachedItems, props.query],
  );

  const needsServerSearch = filteredItems.length === 0 && debouncedQuery.trim().length >= 2;
  const serverSearchQuery = useSourceControlChangeRequestSearch({
    environmentId: props.environmentId,
    cwd: props.cwd,
    query: debouncedQuery,
    limit: 50,
    enabled: needsServerSearch,
  });

  const items = useMemo<ReadonlyArray<ChangeRequest>>(
    () => (needsServerSearch ? (serverSearchQuery.data ?? []) : filteredItems),
    [filteredItems, needsServerSearch, serverSearchQuery.data],
  );
  const isLoading = listQuery.isLoading || (needsServerSearch && serverSearchQuery.isLoading);
  const error = listQuery.error ?? (needsServerSearch ? serverSearchQuery.error : null);
  const notificationTargets = useMemo(
    () =>
      items.map((pr) => ({
        environmentId: props.environmentId,
        cwd: props.cwd,
        provider: pr.provider,
        number: pr.number,
        title: pr.title,
        url: pr.url,
        status: getPrCheckStatusFromChangeRequest(pr),
      })),
    [items, props.cwd, props.environmentId],
  );

  usePrCheckPassNotifications(notificationTargets);

  const refreshPullRequests = useCallback(() => {
    if (props.environmentId === null || props.cwd === null) {
      return;
    }
    invalidateSourceControl({ environmentId: props.environmentId, cwd: props.cwd });
  }, [props.environmentId, props.cwd]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div
        className={cn(
          "flex items-center gap-2 border-border/60 border-b",
          props.density === "compact" ? "px-2 py-1.5" : "px-4 py-2.5",
        )}
      >
        <div className="relative flex-1">
          <SearchIcon className="-translate-y-1/2 absolute top-1/2 left-2 size-3.5 text-muted-foreground" />
          <Input
            ref={props.searchInputRef}
            value={props.query}
            onChange={(event) => props.onQueryChange(event.target.value)}
            placeholder="Search pull requests by title or number…"
            className="h-8 pl-7 text-sm"
          />
        </div>
        <ChangeRequestStateFilterButtons
          value={props.stateFilter}
          onChange={props.onStateFilterChange}
        />
        <Button
          type="button"
          size="icon"
          variant="ghost"
          onClick={refreshPullRequests}
          disabled={listQuery.isFetching}
          aria-label="Refresh"
        >
          <RotateCwIcon className={listQuery.isFetching ? "size-3.5 animate-spin" : "size-3.5"} />
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {error ? (
          <p
            className={cn(
              "text-destructive text-sm",
              props.density === "compact" ? "px-2.5 py-4" : "px-4 py-6",
            )}
          >
            {errorMessage(error, "Failed to load pull requests.")}
          </p>
        ) : (
          <PullRequestList
            {...(props.density ? { density: props.density } : {})}
            items={items}
            isLoading={isLoading}
            emptyText={
              props.query.trim().length > 0
                ? "No pull requests match this search."
                : "No pull requests to show."
            }
            selectedKey={props.selectedKey}
            onSelect={props.onSelect}
          />
        )}
      </div>
    </div>
  );
}
