import type { EnvironmentId, SourceControlIssueSummary } from "@ryco/contracts";
import { useDebouncedValue } from "@tanstack/react-pacer";
import { PlusIcon, RotateCwIcon, SearchIcon } from "lucide-react";
import { useCallback, useMemo, useState, type RefObject } from "react";
import {
  invalidateSourceControl,
  useSourceControlIssueList,
  useSourceControlIssueSearch,
} from "~/rpc/useSourceControl";
import { searchSourceControlSummaries } from "@ryco/shared/sourceControlSearch";
import { NewIssueDialog } from "../issues/NewIssueDialog";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { cn } from "~/lib/utils";
import { IssueList } from "./IssueList";
import { StateFilterButtons, type IssueStateFilter } from "./StateFilterButtons";
import { errorMessage } from "~/lib/errorMessage";

interface IssuesTabProps {
  environmentId: EnvironmentId | null;
  cwd: string | null;
  searchInputRef: RefObject<HTMLInputElement | null>;
  query: string;
  onQueryChange: (value: string) => void;
  selectedKey?: string | null;
  stateFilter: IssueStateFilter;
  onStateFilterChange: (state: IssueStateFilter) => void;
  onSelect: (issue: SourceControlIssueSummary) => void;
  density?: "default" | "compact";
}

export function IssuesTab(props: IssuesTabProps) {
  const [debouncedQuery] = useDebouncedValue(props.query, { wait: 200 });
  const [showNewIssueDialog, setShowNewIssueDialog] = useState(false);

  const listQuery = useSourceControlIssueList({
    environmentId: props.environmentId,
    cwd: props.cwd,
    state: props.stateFilter,
    limit: 100,
  });

  const cachedItems = useMemo(() => listQuery.data ?? [], [listQuery.data]);
  const filteredItems = useMemo(
    () => searchSourceControlSummaries(cachedItems, props.query),
    [cachedItems, props.query],
  );

  const needsServerSearch = filteredItems.length === 0 && debouncedQuery.trim().length >= 2;
  const serverSearchQuery = useSourceControlIssueSearch({
    environmentId: props.environmentId,
    cwd: props.cwd,
    query: debouncedQuery,
    limit: 50,
    enabled: needsServerSearch,
  });

  const items: ReadonlyArray<SourceControlIssueSummary> = needsServerSearch
    ? (serverSearchQuery.data ?? [])
    : filteredItems;
  const isLoading = listQuery.isLoading || (needsServerSearch && serverSearchQuery.isLoading);
  const error = listQuery.error ?? (needsServerSearch ? serverSearchQuery.error : null);
  const isFetching = listQuery.isFetching || (needsServerSearch && serverSearchQuery.isFetching);

  const refreshIssues = useCallback(() => {
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
            placeholder="Search issues by title or number…"
            className="h-8 pl-7 text-sm"
          />
        </div>
        <StateFilterButtons value={props.stateFilter} onChange={props.onStateFilterChange} />
        {props.environmentId && props.cwd ? (
          <Button
            type="button"
            size="icon"
            variant="ghost"
            onClick={() => setShowNewIssueDialog(true)}
            aria-label="New issue"
          >
            <PlusIcon className="size-3.5" />
          </Button>
        ) : null}
        <Button
          type="button"
          size="icon"
          variant="ghost"
          onClick={refreshIssues}
          disabled={isFetching}
          aria-label="Refresh"
        >
          <RotateCwIcon className={isFetching ? "size-3.5 animate-spin" : "size-3.5"} />
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
            {errorMessage(error, "Failed to load issues.")}
          </p>
        ) : (
          <IssueList
            {...(props.density ? { density: props.density } : {})}
            items={items}
            isLoading={isLoading}
            emptyText={
              props.query.trim().length > 0 ? "No issues match this search." : "No issues to show."
            }
            selectedKey={props.selectedKey}
            onSelect={props.onSelect}
          />
        )}
      </div>

      {showNewIssueDialog && props.environmentId && props.cwd ? (
        <NewIssueDialog
          open={showNewIssueDialog}
          onOpenChange={setShowNewIssueDialog}
          environmentId={props.environmentId}
          cwd={props.cwd}
          onCreated={refreshIssues}
        />
      ) : null}
    </div>
  );
}
