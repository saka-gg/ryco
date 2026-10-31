// FILE: ProjectImportPanel.tsx
// Purpose: Import whole Codex and Claude Code projects: read every store,
//          show conversations grouped by the folder they ran in, let the user
//          pick projects or single conversations and review each group's
//          destination, then import one conversation at a time with progress,
//          Stop and Retry failed.
// Layer: Web UI over `@ryco/client-runtime/state/sessionImport`, which owns
//        grouping, planning and the run. Hosted by `ProjectImportDialog`.

import { useEffect, useMemo, useRef, useState } from "react";
import { ProjectId, type SessionImportSource, type SessionImportStore } from "@ryco/contracts";
import type { WsRpcClient } from "@ryco/client-runtime/rpc";
import {
  discoverProjectImportCandidates,
  groupProjectImportCandidates,
  isProjectImportCandidatePending,
  pendingProjectImportKeys,
  planProjectImport,
  projectImportDestinationOptions,
  projectImportGroupSelection,
  resolveProjectImportDestination,
  resolveSessionImportContinuation,
  runProjectImport,
  sessionImportContinuationProviders,
  setProjectImportGroupSelected,
  type ProjectImportCandidate,
  type ProjectImportDestination,
  type ProjectImportGroup,
  type ProjectImportItemStatus,
  type ProjectImportProject,
  type ProjectImportRunSummary,
  type SessionImportContinuationProvider,
} from "@ryco/client-runtime/state/sessionImport";
import { ChevronRightIcon, SearchIcon } from "lucide-react";

import { useEvent } from "../../hooks/useEvent";
import { inferProjectTitleFromPath } from "../../lib/projectPaths";
import { cn } from "../../lib/utils";
import { SettingsNotice } from "../settings/settingsLayout";
import { SettingsSelect } from "../settings/SettingsSelect";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";

export type ProjectImportClient = Pick<
  WsRpcClient["sessionImport"],
  "sources" | "discover" | "run"
>;

export interface ProjectImportPanelProps {
  readonly nodeLabel: string;
  /** Reading and importing the node's history is allowed now. */
  readonly allowed: boolean;
  /** New projects can be created on the node now. */
  readonly canCreateProjects: boolean;
  /** The node's projects that can receive conversations (no chats). */
  readonly projects: readonly ProjectImportProject[];
  readonly providerOptions: readonly SessionImportContinuationProvider[];
  readonly client: () => ProjectImportClient;
  /** Creates a project in the folder through the normal project creation path. */
  readonly createProject: (workspaceRoot: string) => Promise<ProjectId>;
  readonly onRunningChange?: (running: boolean) => void;
}

const SOURCES: readonly SessionImportSource[] = ["codex", "claudeAgent"];
const SOURCE_LABEL: Record<SessionImportSource, string> = {
  codex: "Codex",
  claudeAgent: "Claude Code",
};

interface SourceRow {
  readonly id: string;
  readonly source: SessionImportSource;
  readonly store: SessionImportStore;
  readonly label: string;
}

interface ContinuationChoice {
  readonly instanceId: string;
  readonly model: string;
}

const NO_CHOICE: ContinuationChoice = { instanceId: "", model: "" };

type Phase = "loading" | "idle" | "finding" | "running";

/** Each source's stores; a source that cannot be read adds a notice instead. */
async function loadSourceRows(
  client: () => ProjectImportClient,
): Promise<{ readonly rows: SourceRow[]; readonly notices: string[] }> {
  const results = await Promise.allSettled(
    SOURCES.map((source) => Promise.resolve().then(() => client().sources({ source }))),
  );
  const rows: SourceRow[] = [];
  const notices: string[] = [];
  results.forEach((result, index) => {
    const source = SOURCES[index]!;
    if (result.status === "rejected") {
      const reason = result.reason;
      notices.push(
        `${SOURCE_LABEL[source]}: ${reason instanceof Error ? reason.message : "History is unavailable."}`,
      );
      return;
    }
    for (const store of result.value)
      rows.push({
        id: `${source}:${store.key}`,
        source,
        store,
        label:
          result.value.length > 1 || !store.isDefault
            ? `${SOURCE_LABEL[source]} · ${store.label}`
            : SOURCE_LABEL[source],
      });
  });
  return { rows, notices };
}

function groupTitle(group: ProjectImportGroup): string {
  return group.folder === null ? "Folder unknown" : inferProjectTitleFromPath(group.folder);
}

function destinationValue(destination: ProjectImportDestination): string {
  if (destination.kind === "project") return `project:${destination.projectId}`;
  return destination.kind === "new" ? "new" : "";
}

function conversationCount(count: number): string {
  return count === 1 ? "1 conversation" : `${count} conversations`;
}

function statusText(
  candidate: ProjectImportCandidate,
  status: ProjectImportItemStatus | undefined,
) {
  if (status?.state === "importing") return "Importing…";
  if (status?.state === "imported") return "Imported";
  if (status?.state === "failed") return status.message;
  if (candidate.importedThreadId) return "Already imported";
  if (candidate.quarantined)
    return "Paused after an uncertain earlier import. Inspect it in Settings → Import conversations.";
  return null;
}

export function ProjectImportPanel({
  nodeLabel,
  allowed,
  canCreateProjects,
  projects,
  providerOptions,
  client,
  createProject,
  onRunningChange,
}: ProjectImportPanelProps) {
  // Bumps when access changes or the panel goes away: work started before
  // then stops at its next step and publishes nothing.
  const generation = useRef(0);
  const stopRequested = useRef(false);
  const [phase, setPhase] = useState<Phase>("loading");
  const [rows, setRows] = useState<readonly SourceRow[]>([]);
  const [rowEnabled, setRowEnabled] = useState<Record<string, boolean>>({});
  const [choices, setChoices] = useState<Record<string, ContinuationChoice>>({});
  const [archived, setArchived] = useState(false);
  const [found, setFound] = useState(0);
  const [candidates, setCandidates] = useState<readonly ProjectImportCandidate[] | null>(null);
  const [notices, setNotices] = useState<readonly string[]>([]);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [destinations, setDestinations] = useState<Record<string, ProjectImportDestination>>({});
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [statuses, setStatuses] = useState<Record<string, ProjectImportItemStatus>>({});
  const [created, setCreated] = useState<readonly ProjectImportProject[]>([]);
  const [stopping, setStopping] = useState(false);
  const [progress, setProgress] = useState({ settled: 0, total: 0 });
  const [summary, setSummary] = useState<ProjectImportRunSummary | null>(null);

  // Gaining or losing access starts over from reading the sources; losing it
  // also ends a run, so the dialog can close again.
  const [phaseAccess, setPhaseAccess] = useState(allowed);
  if (phaseAccess !== allowed) {
    setPhaseAccess(allowed);
    setPhase("loading");
  }
  // The latest `client`, so a new accessor identity does not read the sources again.
  const readClient = useEvent(() => client());
  useEffect(() => {
    if (allowed) {
      const attempt = generation.current;
      void loadSourceRows(readClient).then(({ rows: loaded, notices: loadNotices }) => {
        if (attempt !== generation.current) return;
        setRows(loaded);
        setNotices(loadNotices);
        // A conversation in flight when access was lost may or may not have finished.
        setStatuses((previous) =>
          Object.fromEntries(
            Object.entries(previous).filter(([, status]) => status.state !== "importing"),
          ),
        );
        setPhase("idle");
      });
    }
    return () => {
      generation.current += 1;
    };
  }, [allowed, readClient]);

  const running = phase === "running";
  useEffect(() => {
    onRunningChange?.(running);
  }, [onRunningChange, running]);

  // Projects created by this import count before the node's snapshot shows them.
  const knownProjects = useMemo(
    () => [
      ...projects,
      ...created.filter((entry) => !projects.some((project) => project.id === entry.id)),
    ],
    [created, projects],
  );
  const groups = useMemo(
    () => groupProjectImportCandidates(candidates ?? [], knownProjects),
    [candidates, knownProjects],
  );
  const done = useMemo(
    () =>
      new Set(
        Object.entries(statuses)
          .filter(([, status]) => status.state === "imported")
          .map(([key]) => key),
      ),
    [statuses],
  );
  const failedKeys = Object.entries(statuses)
    .filter(([, status]) => status.state === "failed")
    .map(([key]) => key);
  const plan = planProjectImport({
    groups,
    selected,
    done,
    destinations,
    projects: knownProjects,
  });
  const continuations = new Map(
    rows.map((row) => {
      const providers = sessionImportContinuationProviders(providerOptions, row.source, row.store);
      return [
        row.id,
        { providers, ...resolveSessionImportContinuation(providers, choices[row.id] ?? NO_CHOICE) },
      ] as const;
    }),
  );
  const usableRows = rows.filter((row) => continuations.get(row.id)?.model !== undefined);
  const readRows = usableRows.filter((row) => rowEnabled[row.id] !== false);
  const busy = phase !== "idle" || !allowed;
  const pendingKeys = pendingProjectImportKeys(groups, done);
  const createsProjects = plan.newProjects.length > 0;

  const find = () => {
    const attempt = generation.current;
    setPhase("finding");
    setFound(0);
    setSummary(null);
    void discoverProjectImportCandidates({
      rows: readRows.map((row) => ({
        id: row.id,
        source: row.source,
        storeKey: row.store.key,
        label: row.label,
      })),
      includeArchived: archived,
      discover: (request) => Promise.resolve().then(() => client().discover(request)),
      shouldContinue: () => attempt === generation.current,
      onProgress: (count) => {
        if (attempt === generation.current) setFound(count);
      },
    }).then((discovery) => {
      if (attempt !== generation.current) return;
      setCandidates(discovery.candidates);
      setNotices(discovery.notices);
      setSelected(new Set());
      setDestinations({});
      setExpanded(new Set());
      setStatuses({});
      setPhase("idle");
    });
  };

  const run = (keys: ReadonlySet<string>) => {
    const attempt = generation.current;
    const runPlan = planProjectImport({
      groups,
      selected: keys,
      done,
      destinations,
      projects: knownProjects,
    });
    stopRequested.current = false;
    setStopping(false);
    setSummary(null);
    setProgress({ settled: 0, total: runPlan.items.length });
    setPhase("running");
    const rowById = new Map(rows.map((row) => [row.id, row]));
    void runProjectImport(runPlan, {
      createProject,
      importCandidate: (candidate, projectId) => {
        const row = rowById.get(candidate.origin);
        const continuation = row ? continuations.get(row.id) : undefined;
        if (!row || !continuation?.provider || !continuation.model)
          return Promise.reject(new Error("Choose who continues these conversations, then retry."));
        const modelSelection = {
          instanceId: continuation.provider.instanceId,
          model: continuation.model.slug,
        };
        return Promise.resolve().then(() =>
          client().run({
            source: candidate.source,
            key: candidate.key,
            storeKey: row.store.key,
            projectId,
            modelSelection,
          }),
        );
      },
      shouldContinue: () => attempt === generation.current && !stopRequested.current,
      onProjectCreated: (workspaceRoot, projectId) => {
        if (attempt !== generation.current) return;
        setCreated((previous) => [
          ...previous,
          { id: projectId, name: inferProjectTitleFromPath(workspaceRoot), workspaceRoot },
        ]);
      },
      onItem: (key, status) => {
        if (attempt !== generation.current) return;
        setStatuses((previous) => ({ ...previous, [key]: status }));
        if (status.state !== "importing")
          setProgress((previous) => ({ ...previous, settled: previous.settled + 1 }));
        if (status.state === "imported")
          setSelected((previous) => {
            const next = new Set(previous);
            next.delete(key);
            return next;
          });
      },
    }).then((result) => {
      if (attempt !== generation.current) return;
      setSummary(result);
      setStopping(false);
      setPhase("idle");
    });
  };

  const footerStatus = running
    ? `Imported ${progress.settled} of ${conversationCount(progress.total)}…`
    : null;

  return (
    <div className="flex flex-col gap-4" aria-label="Import projects" role="group">
      {!allowed ? (
        <SettingsNotice role="status">
          Reconnect to {nodeLabel} with owner access to import its history.
        </SettingsNotice>
      ) : null}
      <section aria-label="Sources" className="flex flex-col gap-2">
        <h3 className="text-xs font-medium text-muted-foreground">Read from {nodeLabel}</h3>
        {phase === "loading" && allowed ? (
          <p className="text-sm text-muted-foreground">
            Looking for Codex and Claude Code history…
          </p>
        ) : null}
        <ul className="flex flex-col gap-2">
          {rows.map((row) => {
            const continuation = continuations.get(row.id);
            const usable = continuation?.model !== undefined;
            return (
              <li
                key={row.id}
                className="flex flex-col gap-2 rounded-lg border border-border/60 px-3 py-2 sm:flex-row sm:items-center"
              >
                <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-sm">
                  <Checkbox
                    aria-label={`Read ${row.label}`}
                    checked={usable && rowEnabled[row.id] !== false}
                    disabled={busy || !usable}
                    onCheckedChange={(checked) =>
                      setRowEnabled((previous) => ({ ...previous, [row.id]: checked === true }))
                    }
                  />
                  <span className="truncate">{row.label}</span>
                </label>
                {usable ? (
                  <div className="flex shrink-0 flex-wrap items-center gap-2">
                    <span className="text-xs text-muted-foreground">Continue with</span>
                    <SettingsSelect
                      ariaLabel={`${row.label} continues with`}
                      width="sm"
                      size="sm"
                      value={continuation?.provider?.instanceId ?? ""}
                      disabled={busy}
                      onValueChange={(value) =>
                        setChoices((previous) => ({
                          ...previous,
                          [row.id]: { instanceId: value, model: "" },
                        }))
                      }
                      options={(continuation?.providers ?? []).map((provider) => ({
                        value: provider.instanceId,
                        label: provider.displayName || provider.driver,
                      }))}
                    />
                    <SettingsSelect
                      ariaLabel={`${row.label} model`}
                      width="sm"
                      size="sm"
                      value={continuation?.model?.slug ?? ""}
                      disabled={busy}
                      onValueChange={(value) =>
                        setChoices((previous) => ({
                          ...previous,
                          [row.id]: {
                            instanceId: continuation?.provider?.instanceId ?? "",
                            model: value,
                          },
                        }))
                      }
                      options={(continuation?.provider?.models ?? []).map((choice) => ({
                        value: choice.slug,
                        label: choice.name,
                      }))}
                    />
                  </div>
                ) : (
                  <span className="text-xs text-muted-foreground">
                    Enable a {SOURCE_LABEL[row.source]} provider for this store to continue its
                    conversations.
                  </span>
                )}
              </li>
            );
          })}
        </ul>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <label className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
            <Checkbox
              checked={archived}
              disabled={busy}
              onCheckedChange={(checked) => setArchived(checked === true)}
            />
            Include archived conversations
          </label>
          <Button size="sm" variant="outline" disabled={busy || !readRows.length} onClick={find}>
            <SearchIcon />
            {phase === "finding" ? `Finding… ${found}` : "Find projects"}
          </Button>
        </div>
      </section>
      {notices.length > 0 ? (
        <div role="status" className="flex flex-col gap-2">
          {notices.map((notice) => (
            <SettingsNotice key={notice}>{notice}</SettingsNotice>
          ))}
        </div>
      ) : null}
      {candidates !== null ? (
        <section aria-label="Projects found" className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-xs font-medium text-muted-foreground">
              {groups.length === 0
                ? "No conversations found"
                : `${groups.length === 1 ? "1 folder" : `${groups.length} folders`} · ${conversationCount(candidates.length)}`}
            </h3>
            {pendingKeys.length > 0 ? (
              <Button
                size="xs"
                variant="ghost"
                disabled={busy}
                onClick={() =>
                  setSelected(
                    pendingKeys.every((key) => selected.has(key))
                      ? new Set()
                      : new Set(pendingKeys),
                  )
                }
              >
                {pendingKeys.every((key) => selected.has(key)) ? "Select none" : "Select all"}
              </Button>
            ) : null}
          </div>
          <ul className="max-h-96 divide-y divide-border/60 overflow-y-auto rounded-lg border border-border/60">
            {groups.map((group) => (
              <ProjectImportGroupRow
                key={group.key}
                group={group}
                projects={knownProjects}
                canCreateProjects={canCreateProjects}
                busy={busy}
                selected={selected}
                done={done}
                statuses={statuses}
                destination={resolveProjectImportDestination(
                  destinations[group.key] ?? group.suggested,
                  knownProjects,
                )}
                expanded={expanded.has(group.key)}
                onExpandedChange={(open) =>
                  setExpanded((previous) => {
                    const next = new Set(previous);
                    if (open) next.add(group.key);
                    else next.delete(group.key);
                    return next;
                  })
                }
                onSelectedChange={setSelected}
                onDestinationChange={(destination) =>
                  setDestinations((previous) => ({ ...previous, [group.key]: destination }))
                }
              />
            ))}
          </ul>
        </section>
      ) : null}
      <div className="flex flex-wrap items-center justify-end gap-3">
        <p role="status" className="mr-auto text-xs text-muted-foreground">
          {footerStatus ??
            (summary
              ? `${summary.stopped ? "Stopped. " : ""}Imported ${summary.imported}${summary.failed ? `, ${summary.failed} failed` : ""}.`
              : plan.unassigned > 0
                ? `Choose a project for ${conversationCount(plan.unassigned)}.`
                : plan.items.length > 0
                  ? `${conversationCount(plan.items.length)} selected${createsProjects ? `, ${plan.newProjects.length === 1 ? "1 new project" : `${plan.newProjects.length} new projects`}` : ""}.`
                  : null)}
        </p>
        {running ? (
          <Button
            size="sm"
            variant="outline"
            disabled={stopping}
            onClick={() => {
              stopRequested.current = true;
              setStopping(true);
            }}
          >
            {stopping ? "Stopping after this one…" : "Stop"}
          </Button>
        ) : failedKeys.length > 0 ? (
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => run(new Set(failedKeys))}
          >
            Retry failed
          </Button>
        ) : null}
        <Button
          size="sm"
          disabled={
            busy ||
            plan.items.length === 0 ||
            plan.unassigned > 0 ||
            (createsProjects && !canCreateProjects)
          }
          onClick={() => run(selected)}
        >
          {running ? "Importing…" : "Import selected"}
        </Button>
      </div>
    </div>
  );
}

function ProjectImportGroupRow({
  group,
  projects,
  canCreateProjects,
  busy,
  selected,
  done,
  statuses,
  destination,
  expanded,
  onExpandedChange,
  onSelectedChange,
  onDestinationChange,
}: {
  readonly group: ProjectImportGroup;
  readonly projects: readonly ProjectImportProject[];
  readonly canCreateProjects: boolean;
  readonly busy: boolean;
  readonly selected: ReadonlySet<string>;
  readonly done: ReadonlySet<string>;
  readonly statuses: Readonly<Record<string, ProjectImportItemStatus>>;
  readonly destination: ProjectImportDestination;
  readonly expanded: boolean;
  readonly onExpandedChange: (expanded: boolean) => void;
  readonly onSelectedChange: (
    update: (previous: ReadonlySet<string>) => ReadonlySet<string>,
  ) => void;
  readonly onDestinationChange: (destination: ProjectImportDestination) => void;
}) {
  const title = groupTitle(group);
  const selection = projectImportGroupSelection(group, selected, done);
  const hasPending = group.candidates.some((candidate) =>
    isProjectImportCandidatePending(candidate, done),
  );
  const failed = group.candidates.filter(
    (candidate) => statuses[candidate.key]?.state === "failed",
  ).length;
  const options = projectImportDestinationOptions(group, projects).map((option) =>
    option.kind === "new"
      ? {
          value: "new",
          label: `New project “${title}”`,
          disabled: !canCreateProjects,
        }
      : {
          value: `project:${option.projectId}`,
          label: projects.find((project) => project.id === option.projectId)?.name ?? "Project",
        },
  );
  return (
    <li className="flex flex-col gap-2 px-3 py-2.5">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start">
        <div className="flex min-w-0 flex-1 gap-3">
          <Checkbox
            className="mt-0.5"
            aria-label={`Select ${title}`}
            checked={selection === "all"}
            indeterminate={selection === "some"}
            disabled={busy || !hasPending}
            onCheckedChange={(checked) =>
              onSelectedChange((previous) =>
                setProjectImportGroupSelected(group, previous, done, checked === true),
              )
            }
          />
          <div className="min-w-0 flex-1">
            <p className="flex min-w-0 items-center gap-2 text-[13px] font-medium text-foreground">
              <span className="truncate">{title}</span>
              {group.folderState === "missing" ? (
                <Badge variant="warning" size="sm">
                  Folder gone
                </Badge>
              ) : null}
              {failed > 0 ? (
                <Badge variant="error" size="sm">
                  {failed} failed
                </Badge>
              ) : null}
            </p>
            <p className="mt-0.5 break-all text-xs text-muted-foreground">
              {group.folder ?? "These conversations recorded no folder"} ·{" "}
              {group.sources.map((source) => SOURCE_LABEL[source]).join(", ")}
            </p>
            <button
              type="button"
              aria-expanded={expanded}
              className="mt-1 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
              onClick={() => onExpandedChange(!expanded)}
            >
              <ChevronRightIcon
                aria-hidden
                className={cn("size-3 transition-transform", expanded && "rotate-90")}
              />
              {conversationCount(group.candidates.length)}
            </button>
          </div>
        </div>
        <SettingsSelect
          ariaLabel={`Destination for ${title}`}
          width="md"
          size="sm"
          value={destinationValue(destination)}
          disabled={busy}
          placeholder="Choose a project"
          onValueChange={(value) =>
            onDestinationChange(
              value === "new" && group.folder !== null
                ? { kind: "new", workspaceRoot: group.folder }
                : { kind: "project", projectId: ProjectId.make(value.slice("project:".length)) },
            )
          }
          options={options}
        />
      </div>
      {expanded ? (
        <ul aria-label={`Conversations in ${title}`} className="ml-7 flex flex-col gap-1.5">
          {group.candidates.map((candidate) => {
            const status = statusText(candidate, statuses[candidate.key]);
            const pending = isProjectImportCandidatePending(candidate, done);
            const itemFailed = statuses[candidate.key]?.state === "failed";
            return (
              <li key={candidate.key} className="flex gap-2">
                <Checkbox
                  className="mt-0.5"
                  aria-label={`Select ${candidate.title}`}
                  checked={pending && selected.has(candidate.key)}
                  disabled={busy || !pending}
                  onCheckedChange={(checked) =>
                    onSelectedChange((previous) => {
                      const next = new Set(previous);
                      if (checked === true) next.add(candidate.key);
                      else next.delete(candidate.key);
                      return next;
                    })
                  }
                />
                <div className="min-w-0 flex-1">
                  <p className="flex min-w-0 items-center gap-2 text-xs text-foreground">
                    <span className="min-w-0 break-words">{candidate.title}</span>
                    {candidate.archived ? (
                      <Badge variant="outline" size="sm">
                        Archived
                      </Badge>
                    ) : null}
                  </p>
                  <p className="text-[11px] text-muted-foreground">
                    {SOURCE_LABEL[candidate.source]} · {candidate.messageCount} messages
                    {status ? (
                      <span
                        className={cn(
                          "ml-1",
                          itemFailed
                            ? "text-destructive-foreground"
                            : candidate.quarantined
                              ? "text-warning-foreground"
                              : "text-success-foreground",
                        )}
                      >
                        · {status}
                      </span>
                    ) : null}
                  </p>
                </div>
              </li>
            );
          })}
        </ul>
      ) : null}
    </li>
  );
}
