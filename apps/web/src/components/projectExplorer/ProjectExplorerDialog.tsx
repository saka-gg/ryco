import type {
  ChangeRequest,
  SourceControlIssueSummary,
  WorkItemStateFilter,
  WorkItemSummary,
} from "@ryco/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  hasNoShortcutModifiers,
  isDifferentDialogShortcutTarget,
  isEditableShortcutTarget,
  matchesExactModShortcut,
} from "~/keybindings";
import type { SidebarProjectGroupMember } from "~/sidebarProjectGrouping";
import { ContextPickerTabs } from "../chat/ContextPickerTabs";
import { Dialog, DialogPopup, DialogTitle } from "../ui/dialog";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { ActionsTab } from "./ActionsTab";
import { IssueDetail } from "./IssueDetail";
import { IssuesTab } from "./IssuesTab";
import { ProjectOverviewTab } from "./ProjectOverviewTab";
import { PullRequestDetail } from "./PullRequestDetail";
import { PullRequestsTab } from "./PullRequestsTab";
import { WorkItemDetail } from "./WorkItemDetail";
import { WorkItemsTab } from "./WorkItemsTab";
import type { ChangeRequestStateFilter, IssueStateFilter } from "./StateFilterButtons";

export type ProjectExplorerTabId = "overview" | "issues" | "prs" | "actions" | "workItems";

type Selection =
  | { kind: "issue"; number: number }
  | { kind: "pr"; number: number }
  | { kind: "workItem"; key: string }
  | null;

interface ProjectExplorerDialogProps {
  open: boolean;
  projectName: string;
  memberProjects: ReadonlyArray<SidebarProjectGroupMember>;
  initialTab: ProjectExplorerTabId;
  onOpenChange: (open: boolean) => void;
}

export function ProjectExplorerDialog(props: ProjectExplorerDialogProps) {
  const [activeTab, setActiveTab] = useState<ProjectExplorerTabId>(props.initialTab);
  const [issueQuery, setIssueQuery] = useState("");
  const [prQuery, setPrQuery] = useState("");
  const [workItemQuery, setWorkItemQuery] = useState("");
  const [issueStateFilter, setIssueStateFilter] = useState<IssueStateFilter>("open");
  const [prStateFilter, setPrStateFilter] = useState<ChangeRequestStateFilter>("open");
  const [workItemStateFilter, setWorkItemStateFilter] = useState<WorkItemStateFilter>("open");
  const [selection, setSelection] = useState<Selection>(null);
  const [selectedMemberKey, setSelectedMemberKey] = useState<string>(
    () => props.memberProjects[0]?.physicalProjectKey ?? "",
  );
  const issueInputRef = useRef<HTMLInputElement>(null);
  const prInputRef = useRef<HTMLInputElement>(null);
  const workItemInputRef = useRef<HTMLInputElement>(null);
  const previousOpenRef = useRef(props.open);
  const previousInitialTabRef = useRef(props.initialTab);
  const memberProjectKeys = useMemo(
    () => props.memberProjects.map((member) => member.physicalProjectKey),
    [props.memberProjects],
  );
  const memberProjectKeySignature = memberProjectKeys.join("\0");
  const firstMemberKey = memberProjectKeys[0] ?? "";

  const selectedMember = useMemo(
    () =>
      props.memberProjects.find((m) => m.physicalProjectKey === selectedMemberKey) ??
      props.memberProjects[0] ??
      null,
    [props.memberProjects, selectedMemberKey],
  );

  useEffect(() => {
    if (!props.open) {
      setSelection(null);
    }
  }, [props.open]);

  useEffect(() => {
    const wasOpen = previousOpenRef.current;
    const previousInitialTab = previousInitialTabRef.current;
    previousOpenRef.current = props.open;
    previousInitialTabRef.current = props.initialTab;

    if (props.open && (!wasOpen || props.initialTab !== previousInitialTab)) {
      setActiveTab(props.initialTab);
      setSelection(null);
      setSelectedMemberKey((current) =>
        memberProjectKeys.includes(current) ? current : firstMemberKey,
      );
    }
  }, [firstMemberKey, memberProjectKeys, props.initialTab, props.open]);

  useEffect(() => {
    if (!props.open) return;
    setSelectedMemberKey((current) =>
      memberProjectKeys.includes(current) ? current : firstMemberKey,
    );
  }, [firstMemberKey, memberProjectKeySignature, memberProjectKeys, props.open]);

  useEffect(() => {
    if (!props.open || selection !== null) return;
    const frame = window.requestAnimationFrame(() => {
      const target =
        activeTab === "issues"
          ? issueInputRef.current
          : activeTab === "prs"
            ? prInputRef.current
            : activeTab === "workItems"
              ? workItemInputRef.current
              : null;
      target?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [props.open, activeTab, selection]);

  const handleSelectIssue = useCallback((issue: SourceControlIssueSummary) => {
    setSelection({ kind: "issue", number: issue.number });
  }, []);

  const handleSelectChangeRequest = useCallback((cr: ChangeRequest) => {
    setSelection({ kind: "pr", number: cr.number });
  }, []);

  const handleSelectWorkItem = useCallback((item: WorkItemSummary) => {
    setSelection({ kind: "workItem", key: item.key });
  }, []);

  const handleSelectLinkedIssue = useCallback((issueNumber: number) => {
    setActiveTab("issues");
    setSelection({ kind: "issue", number: issueNumber });
  }, []);

  const handleSelectLinkedChangeRequest = useCallback((changeRequestNumber: number) => {
    setActiveTab("prs");
    setSelection({ kind: "pr", number: changeRequestNumber });
  }, []);

  const handleSelectLinkedWorkItem = useCallback((workItemKey: string) => {
    setActiveTab("workItems");
    setSelection({ kind: "workItem", key: workItemKey });
  }, []);

  const handleBack = useCallback(() => setSelection(null), []);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (
        isDifferentDialogShortcutTarget({
          currentTarget: event.currentTarget,
          target: event.target,
        })
      ) {
        return;
      }

      if (isEditableShortcutTarget(event.target)) {
        return;
      }

      if (matchesExactModShortcut(event, "1")) {
        event.preventDefault();
        setActiveTab("issues");
        setSelection(null);
        return;
      }
      if (matchesExactModShortcut(event, "2")) {
        event.preventDefault();
        setActiveTab("prs");
        setSelection(null);
        return;
      }
      if (matchesExactModShortcut(event, "3")) {
        event.preventDefault();
        setActiveTab("actions");
        setSelection(null);
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key === "4") {
        event.preventDefault();
        setActiveTab("workItems");
        setSelection(null);
        return;
      }
      if (event.key === "/" && hasNoShortcutModifiers(event)) {
        event.preventDefault();
        const target =
          activeTab === "issues"
            ? issueInputRef.current
            : activeTab === "prs"
              ? prInputRef.current
              : activeTab === "workItems"
                ? workItemInputRef.current
                : null;
        target?.focus();
      }
    },
    [activeTab],
  );

  const tabs = useMemo(
    () => [
      { id: "overview" as const, label: "Overview" },
      { id: "issues" as const, label: "Issues" },
      { id: "prs" as const, label: "Pull requests" },
      { id: "actions" as const, label: "Actions" },
      { id: "workItems" as const, label: "Jira" },
    ],
    [],
  );

  const tabLabel =
    activeTab === "overview"
      ? "Overview"
      : activeTab === "issues"
        ? "Issues"
        : activeTab === "prs"
          ? "Pull requests"
          : activeTab === "actions"
            ? "Actions"
            : "Jira";
  const dialogTitle = `${props.projectName} · ${tabLabel}`;
  const showRepoPicker = props.memberProjects.length > 1 && selectedMember !== null;
  const environmentId = selectedMember?.environmentId ?? null;
  const cwd = selectedMember?.cwd ?? null;

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogPopup
        className="flex h-[88vh] max-h-[1060px] w-[90vw] max-w-[1340px] flex-col p-0 phone:h-[100dvh] phone:w-screen"
        onKeyDown={handleKeyDown}
      >
        <header className="flex items-center justify-between border-border/60 border-b py-3 pl-5 pr-14">
          <DialogTitle className="truncate text-base">{dialogTitle}</DialogTitle>
          <span className="shrink-0 text-muted-foreground text-xs pointer-coarse:hidden">
            ⌘1 issues · ⌘2 PRs · ⌘3 Actions · ⌘4 Jira · / focus search · Esc close
          </span>
        </header>

        {showRepoPicker ? (
          <div className="flex items-center gap-2 border-border/60 border-b px-5 py-2">
            <span className="text-muted-foreground text-xs">Repository</span>
            <Select
              value={selectedMemberKey}
              onValueChange={(v) => {
                if (typeof v === "string") setSelectedMemberKey(v);
              }}
            >
              <SelectTrigger size="sm" className="min-w-56">
                <SelectValue placeholder="Select a repository" />
              </SelectTrigger>
              <SelectPopup>
                {props.memberProjects.map((member) => (
                  <SelectItem key={member.physicalProjectKey} value={member.physicalProjectKey}>
                    <span className="truncate">
                      {member.name}
                      {member.environmentLabel ? (
                        <span className="ml-1 text-muted-foreground">
                          · {member.environmentLabel}
                        </span>
                      ) : null}
                    </span>
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </div>
        ) : null}

        {selection === null ? (
          <>
            <ContextPickerTabs
              tabs={tabs}
              activeId={activeTab}
              onSelect={(id) => setActiveTab(id as ProjectExplorerTabId)}
            />
            <div className="min-h-0 flex-1">
              {activeTab === "overview" ? (
                <ProjectOverviewTab
                  environmentId={environmentId}
                  cwd={cwd}
                  projectId={selectedMember?.id ?? null}
                  onOpenTab={setActiveTab}
                  onSelectIssue={handleSelectIssue}
                  onSelectChangeRequest={handleSelectChangeRequest}
                  onSelectWorkItem={handleSelectWorkItem}
                />
              ) : activeTab === "issues" ? (
                <IssuesTab
                  environmentId={environmentId}
                  cwd={cwd}
                  searchInputRef={issueInputRef}
                  query={issueQuery}
                  onQueryChange={setIssueQuery}
                  stateFilter={issueStateFilter}
                  onStateFilterChange={setIssueStateFilter}
                  onSelect={handleSelectIssue}
                />
              ) : activeTab === "prs" ? (
                <PullRequestsTab
                  environmentId={environmentId}
                  cwd={cwd}
                  searchInputRef={prInputRef}
                  query={prQuery}
                  onQueryChange={setPrQuery}
                  stateFilter={prStateFilter}
                  onStateFilterChange={setPrStateFilter}
                  onSelect={handleSelectChangeRequest}
                />
              ) : activeTab === "actions" ? (
                <ActionsTab environmentId={environmentId} cwd={cwd} />
              ) : (
                <WorkItemsTab
                  environmentId={environmentId}
                  cwd={cwd}
                  projectId={selectedMember?.id ?? null}
                  searchInputRef={workItemInputRef}
                  query={workItemQuery}
                  onQueryChange={setWorkItemQuery}
                  stateFilter={workItemStateFilter}
                  onStateFilterChange={setWorkItemStateFilter}
                  onSelect={handleSelectWorkItem}
                />
              )}
            </div>
          </>
        ) : selection.kind === "issue" ? (
          <IssueDetail
            environmentId={environmentId}
            cwd={cwd}
            issueNumber={selection.number}
            onBack={handleBack}
            onSelectLinkedChangeRequest={handleSelectLinkedChangeRequest}
          />
        ) : selection.kind === "pr" ? (
          <PullRequestDetail
            environmentId={environmentId}
            cwd={cwd}
            pullRequestNumber={selection.number}
            onBack={handleBack}
            onSelectLinkedIssue={handleSelectLinkedIssue}
            onSelectLinkedWorkItem={handleSelectLinkedWorkItem}
            onSelectPullRequest={handleSelectLinkedChangeRequest}
          />
        ) : (
          <WorkItemDetail
            environmentId={environmentId}
            projectId={selectedMember?.id ?? null}
            cwd={cwd}
            workItemKey={selection.key}
            onBack={handleBack}
            onSelectLinkedChangeRequest={handleSelectLinkedChangeRequest}
          />
        )}
      </DialogPopup>
    </Dialog>
  );
}
