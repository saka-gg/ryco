import type { ChangeRequest, EnvironmentId, SourceControlIssueSummary } from "@ryco/contracts";
import { type DragEvent, type ChangeEvent, useRef, useState } from "react";
import { useDebouncedValue } from "@tanstack/react-pacer";
import { PaperclipIcon } from "lucide-react";
import {
  useSourceControlChangeRequestList,
  useSourceControlChangeRequestSearch,
  useSourceControlIssueList,
  useSourceControlIssueSearch,
} from "~/rpc/useSourceControl";
import { searchSourceControlSummaries } from "./composerSourceControlContextSearch";
import { ContextPickerList } from "./ContextPickerList";
import { ContextPickerTabs } from "./ContextPickerTabs";

type TabId = "issues" | "prs";

/** Same rows as the composer `#` picker, sliced from the shared open-list superset. */
const CONTEXT_PICKER_LIST_LIMIT = 50;

export function ContextPickerPopup(props: {
  environmentId: EnvironmentId | null;
  cwd: string;
  hasSourceControlRemote: boolean;
  onSelectIssue: (issue: SourceControlIssueSummary) => void;
  onSelectChangeRequest: (cr: ChangeRequest) => void;
  onAttachFile: (file: File) => void;
}) {
  const [activeTab, setActiveTab] = useState<TabId>("issues");
  const [query, setQuery] = useState("");
  const [isDragOver, setIsDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [debouncedQuery] = useDebouncedValue(query, { wait: 200 });

  // Cached list queries
  const issueListQuery = useSourceControlIssueList({
    environmentId: props.environmentId,
    cwd: props.cwd,
    state: "open",
    limit: CONTEXT_PICKER_LIST_LIMIT,
  });
  const prListQuery = useSourceControlChangeRequestList({
    environmentId: props.environmentId,
    cwd: props.cwd,
    state: "open",
    limit: CONTEXT_PICKER_LIST_LIMIT,
  });

  // Client-side filter
  const cachedIssues = issueListQuery.data ?? [];
  const cachedPrs = prListQuery.data ?? [];

  const filteredIssues = searchSourceControlSummaries(cachedIssues, query);
  // For PRs, ChangeRequest has number and title, so it satisfies the constraint
  const filteredPrs = searchSourceControlSummaries(
    cachedPrs as unknown as ReadonlyArray<SourceControlIssueSummary>,
    query,
  ) as unknown as ReadonlyArray<ChangeRequest>;

  // Fall-through server search when client filter is empty and query is long enough
  const needsServerSearchIssues =
    activeTab === "issues" && filteredIssues.length === 0 && debouncedQuery.length >= 2;
  const needsServerSearchPrs =
    activeTab === "prs" && filteredPrs.length === 0 && debouncedQuery.length >= 2;

  const serverIssueSearchQuery = useSourceControlIssueSearch({
    environmentId: props.environmentId,
    cwd: props.cwd,
    query: debouncedQuery,
    enabled: needsServerSearchIssues,
  });
  const serverPrSearchQuery = useSourceControlChangeRequestSearch({
    environmentId: props.environmentId,
    cwd: props.cwd,
    query: debouncedQuery,
    enabled: needsServerSearchPrs,
  });

  // Effective display lists
  const displayIssues: ReadonlyArray<SourceControlIssueSummary> = needsServerSearchIssues
    ? (serverIssueSearchQuery.data ?? [])
    : filteredIssues;
  const displayPrs: ReadonlyArray<ChangeRequest> = needsServerSearchPrs
    ? (serverPrSearchQuery.data ?? [])
    : filteredPrs;

  const isLoadingIssues =
    issueListQuery.isLoading || (needsServerSearchIssues && serverIssueSearchQuery.isLoading);
  const isLoadingPrs =
    prListQuery.isLoading || (needsServerSearchPrs && serverPrSearchQuery.isLoading);
  // A failed list read must not pass for an empty one.
  const issuesUnavailable = issueListQuery.error !== null && issueListQuery.data === null;
  const prsUnavailable = prListQuery.error !== null && prListQuery.data === null;

  function handleFileChange(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) {
      props.onAttachFile(file);
    }
    // Reset so the same file can be re-selected
    e.target.value = "";
  }

  function handleDragOver(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setIsDragOver(true);
  }

  function handleDragLeave() {
    setIsDragOver(false);
  }

  function handleDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setIsDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file) {
      props.onAttachFile(file);
    }
  }

  return (
    <div
      className="flex w-80 flex-col"
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      data-drag-over={isDragOver || undefined}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border">
        <span className="text-sm font-medium">Add context</span>
        <button
          type="button"
          aria-label="Attach file"
          className="text-muted-foreground hover:text-foreground"
          onClick={() => fileInputRef.current?.click()}
        >
          <PaperclipIcon className="size-4" />
        </button>
        <input
          ref={fileInputRef}
          type="file"
          className="sr-only"
          tabIndex={-1}
          aria-hidden
          onChange={handleFileChange}
        />
      </div>

      {/* Search */}
      <div className="px-3 py-2 border-b border-border">
        <input
          type="text"
          className="w-full rounded-md bg-muted px-2 py-1 text-sm outline-none placeholder:text-muted-foreground"
          placeholder="Search…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      {props.hasSourceControlRemote ? (
        <>
          {/* Tabs */}
          <ContextPickerTabs
            tabs={[
              { id: "issues", label: "Issues", count: cachedIssues.length },
              { id: "prs", label: "PRs", count: cachedPrs.length },
            ]}
            activeId={activeTab}
            onSelect={(id) => setActiveTab(id as TabId)}
          />

          {/* List */}
          {activeTab === "issues" ? (
            <ContextPickerList
              items={displayIssues}
              isLoading={isLoadingIssues}
              emptyText={
                issuesUnavailable
                  ? "Couldn't load issues"
                  : query.length > 0
                    ? "No matching issues"
                    : "No open issues"
              }
              onSelect={props.onSelectIssue}
            />
          ) : (
            <ContextPickerList
              items={displayPrs as unknown as ReadonlyArray<SourceControlIssueSummary>}
              isLoading={isLoadingPrs}
              emptyText={
                prsUnavailable
                  ? "Couldn't load PRs"
                  : query.length > 0
                    ? "No matching PRs"
                    : "No open PRs"
              }
              onSelect={(item) => props.onSelectChangeRequest(item as unknown as ChangeRequest)}
            />
          )}
        </>
      ) : (
        <p className="px-3 py-4 text-xs text-muted-foreground">
          No source-control remote detected. File attach is still available above.
        </p>
      )}
    </div>
  );
}
