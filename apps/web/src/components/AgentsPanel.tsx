/**
 * Agents workspace surface: the fleet view over the native subagent fold,
 * and the ONLY place the roster renders (the chat carries one CTA row per
 * spawn batch).
 *
 * Visualization rules:
 * - Stable spawn order: activity and usage updates never reshuffle the roster.
 * - Rows open an ordered agent activity feed inside the same Agents surface.
 * - Workflow expansion is presentation state keyed by workflow id; lifecycle
 *   changes cannot move or implicitly collapse the group.
 * - Static status dots, DOM-write elapsed timers, plain token counters.
 * - Rows lead with the agent's functional label (Claude's `verify:implementor`)
 *   and say what it is doing now; model, usage and timestamps live in the
 *   agent's detail view, not on every row.
 */
import type { EnvironmentId, ThreadId } from "@ryco/contracts";
import { ArrowLeftIcon, BotIcon, BracesIcon, ChevronRightIcon, XIcon } from "lucide-react";
import { createContext, use, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { readEnvironmentApi } from "../environmentApi";
import {
  assignSubagentIdentities,
  canonicalSubagentIdentityKey,
  type ThreadSubagentView,
  formatSubagentModelLabel,
  formatSubagentTokenCount,
  isTerminalSubagentStatus,
  resolveSubagentDisplayLabel,
  resolveSubagentDisplayLabels,
  splitSubagentLabelScope,
  subagentRoleDuplicatesLabel,
  type AgentPanelModel,
  type AgentPanelWorkflowGroup,
  type RuntimeSubagent,
  type SubagentIdentity,
} from "../threadWorkspaceViewModel";
import { cn } from "~/lib/utils";
import { AgentActivityTimeline } from "./AgentActivityTimeline";
import ChatMarkdown from "./ChatMarkdown";
import { ScrollArea } from "./ui/scroll-area";

/**
 * Provider phases remain distinct, including resumable idle agents. `word` is
 * the status a row spells out next to its time: running and completed read
 * from the dot and the ticking/frozen time alone, every other state is named
 * so it never depends on color (or on a stale activity line).
 */
const STATUS_VISUALS: Record<
  RuntimeSubagent["status"],
  { dotClass: string; label: string; word: { text: string; className: string } | null }
> = {
  pending: { dotClass: "bg-info", label: "Queued", word: { text: "Queued", className: "" } },
  running: { dotClass: "bg-info", label: "Running", word: null },
  waiting: {
    dotClass: "bg-info",
    label: "Waiting",
    word: { text: "Waiting", className: "text-info-foreground" },
  },
  // Idle reads as settled (muted, not sky): a resting Codex child looks done
  // unless resumed.
  idle: {
    dotClass: "bg-muted-foreground/50",
    label: "Idle · resumable",
    word: { text: "Idle", className: "" },
  },
  completed: { dotClass: "bg-success", label: "Completed", word: null },
  failed: {
    dotClass: "bg-destructive",
    label: "Failed",
    word: { text: "Failed", className: "text-destructive-foreground" },
  },
  cancelled: {
    dotClass: "bg-muted-foreground/60",
    label: "Stopped",
    word: { text: "Stopped", className: "" },
  },
  interrupted: {
    dotClass: "bg-muted-foreground/60",
    label: "Interrupted",
    word: { text: "Interrupted", className: "" },
  },
};

interface AgentsPanelIdentityContextValue {
  readonly identities: ReadonlyMap<string, SubagentIdentity>;
  /** Row labels for the whole roster (functional labels, collisions numbered). */
  readonly labels: ReadonlyMap<string, string>;
  readonly onOpenAgent: ((agentId: string) => void) | null;
}

const AgentsPanelIdentityContext = createContext<AgentsPanelIdentityContextValue>({
  identities: new Map(),
  labels: new Map(),
  onOpenAgent: null,
});

function StatusDot({ status }: { status: RuntimeSubagent["status"] }) {
  return (
    <span
      aria-hidden
      className={cn("size-1.5 shrink-0 rounded-full", STATUS_VISUALS[status].dotClass)}
    />
  );
}

function formatElapsedSeconds(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const minutes = Math.floor(seconds / 60);
  if (minutes === 0) {
    return `${seconds}s`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours === 0) {
    return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  }
  return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
}

function elapsedBetween(startedAt: string, endIso: string | null): string {
  const start = Date.parse(startedAt);
  const end = endIso ? Date.parse(endIso) : Date.now();
  if (Number.isNaN(start) || Number.isNaN(end)) {
    return "";
  }
  return formatElapsedSeconds((end - start) / 1000);
}

/**
 * How long a settled agent actually ran. The provider's own duration_ms is
 * authoritative when reported; activity timestamps are the fallback for
 * synthesized rows (workflow members) that carry no usage duration.
 */
function settledDuration(agent: RuntimeSubagent): string | null {
  if (agent.usage?.durationMs !== undefined) {
    return formatElapsedSeconds(agent.usage.durationMs / 1000);
  }
  if (agent.startedAt && agent.completedAt) {
    return elapsedBetween(agent.startedAt, agent.completedAt);
  }
  return null;
}

/**
 * Elapsed time for the current activation. Live agents self-tick via DOM
 * writes (zero React commits per tick); settled agents freeze at the run's
 * actual duration.
 */
function AgentElapsed({ agent }: { agent: RuntimeSubagent }) {
  const textRef = useRef<HTMLSpanElement>(null);
  const live = agent.status === "running" || agent.status === "waiting";
  const startedAt = agent.startedAt;

  useEffect(() => {
    if (!live || !startedAt) {
      return;
    }
    const update = () => {
      if (textRef.current) {
        textRef.current.textContent = elapsedBetween(startedAt, null);
      }
    };
    update();
    const id = setInterval(update, 1000);
    return () => clearInterval(id);
  }, [live, startedAt]);

  if (!live) {
    const duration = settledDuration(agent);
    return duration ? <span className="tabular-nums">{duration}</span> : null;
  }
  if (!startedAt) {
    return null;
  }
  return (
    <span ref={textRef} className="tabular-nums">
      {elapsedBetween(startedAt, null)}
    </span>
  );
}

/**
 * Human label for an agent's last tool. The Workflow harness makes agents
 * deliver their result through an internal tool literally named
 * "StructuredOutput" — surfacing that verbatim reads like a bug, so it maps
 * to result language instead.
 */
function agentToolHint(name: string, live: boolean): string {
  if (/^structured[\s_-]?output$/i.test(name)) {
    return live ? "Delivering result" : "Delivered result";
  }
  return live ? `Using ${name}` : name;
}

/**
 * Status-dependent activity line. Live rows lead with what is happening now;
 * settled rows lead with the outcome. Errors are the only inline previews on
 * failed rows because they explain a red row at a glance.
 */
function agentActivityText(agent: RuntimeSubagent): string | null {
  const live =
    agent.status === "running" || agent.status === "pending" || agent.status === "waiting";
  if (live) {
    return (
      agent.progress ??
      (agent.lastToolName ? agentToolHint(agent.lastToolName, true) : null) ??
      agent.result ??
      agent.error
    );
  }
  return (
    agent.error ??
    agent.result ??
    agent.progress ??
    (agent.lastToolName ? agentToolHint(agent.lastToolName, false) : null)
  );
}

/** Hairline separation between stacked agent rows. */
function AgentRowList({ children }: { children: ReactNode }) {
  return <div className="divide-y divide-border/25">{children}</div>;
}

/**
 * A workflow label's `scope:` prefix (`verify:`, `review:`) is set back so the
 * agent's own name carries the row.
 */
function AgentLabel({
  label,
  className,
  wrap = false,
}: {
  label: string;
  className?: string;
  /** Show the whole label (the detail header) instead of truncating it. */
  wrap?: boolean;
}) {
  const { scope, name } = splitSubagentLabelScope(label);
  return (
    <span
      className={cn(
        "min-w-0 text-[13px] font-medium",
        wrap ? "break-words" : "truncate",
        className,
      )}
      title={wrap ? undefined : label}
    >
      {scope ? <span className="font-normal text-muted-foreground/70">{scope}:</span> : null}
      {name}
    </span>
  );
}

/** Shared two-line row geometry; updates never change a row's height. */
const AGENT_ROW_GRID_CLASS =
  "grid h-10 w-full grid-cols-[0.375rem_minmax(0,1fr)_auto] grid-rows-[1.125rem_1rem] content-center items-center gap-x-2.5 rounded-md px-2 text-left";

/** Fixed two-line row: what the agent is, then what it is doing now. */
function AgentRow({ agent }: { agent: RuntimeSubagent }) {
  const { identities, labels, onOpenAgent } = use(AgentsPanelIdentityContext);
  const visuals = STATUS_VISUALS[agent.status];
  const activity = agentActivityText(agent);
  const identity = identities.get(agent.id);
  const label =
    labels.get(agent.id) ??
    resolveSubagentDisplayLabel({
      id: agent.id,
      title: agent.title,
      codename: identity?.codename ?? agent.id,
    });
  // Compared with the title too: a numbered label ("Explore 2") still repeats its role.
  const role =
    identity?.role &&
    !subagentRoleDuplicatesLabel(identity.role, label) &&
    !subagentRoleDuplicatesLabel(identity.role, agent.title)
      ? identity.role
      : null;
  // A named status already says what a quiet row is doing; do not repeat it.
  const activityLine = activity ?? (visuals.word ? "" : visuals.label);
  const aside = [role, agent.activationCount > 1 ? `run ${agent.activationCount}` : null]
    .filter((value): value is string => value !== null)
    .join(" · ");

  const content = (
    <>
      <span className="col-start-1 row-start-1 flex">
        <StatusDot status={agent.status} />
      </span>
      <AgentLabel label={label} className="col-start-2 row-start-1" />
      <span className="col-start-3 row-start-1 inline-flex items-center justify-end gap-1.5 text-right font-mono text-[10.5px] text-muted-foreground/70">
        {visuals.word ? (
          <span className={cn("font-sans", visuals.word.className)}>{visuals.word.text}</span>
        ) : null}
        <AgentElapsed agent={agent} />
      </span>
      <span
        className={cn(
          "col-start-2 row-start-2 block min-w-0 truncate text-[11.5px]",
          agent.status === "failed" ? "text-destructive-foreground" : "text-muted-foreground",
        )}
        title={activityLine || undefined}
      >
        {activityLine}
      </span>
      {aside ? (
        <span className="col-start-3 row-start-2 max-w-32 truncate text-right text-[10.5px] text-muted-foreground/65">
          {aside}
        </span>
      ) : null}
      {/* Rows without a visible status word still name their status (buttons
          carry it in their accessible name instead). */}
      {visuals.word || onOpenAgent ? null : <span className="sr-only">{visuals.label}</span>}
    </>
  );

  const className = cn(
    AGENT_ROW_GRID_CLASS,
    "outline-none transition-colors",
    onOpenAgent && "hover:bg-accent/35 focus-visible:ring-2 focus-visible:ring-ring/50",
  );
  return onOpenAgent ? (
    <button
      type="button"
      className={className}
      data-agent-row
      data-agent-id={agent.id}
      onClick={() => onOpenAgent(agent.id)}
      aria-label={`Open ${label}${role ? `, ${role}` : ""} transcript. ${visuals.label}.`}
    >
      {content}
    </button>
  ) : (
    <div className={className} data-agent-row data-agent-id={agent.id}>
      {content}
    </div>
  );
}

function workflowIsLive(group: AgentPanelWorkflowGroup): boolean {
  const status = group.workflow.status;
  return (
    status !== "completed" &&
    status !== "failed" &&
    status !== "cancelled" &&
    status !== "interrupted"
  );
}

function workflowMembers(group: AgentPanelWorkflowGroup): ReadonlyArray<RuntimeSubagent> {
  return [...group.phases.flatMap((phase) => phase.members), ...group.unphasedMembers];
}

/** Small-caps section label shared by phases and the direct spawns list. */
const SECTION_LABEL_CLASS =
  "flex h-7 w-full items-center gap-1.5 px-2 text-left text-[10.5px] font-medium uppercase tracking-wider";

type WorkflowScriptState =
  | { readonly state: "loading" }
  | { readonly state: "loaded"; readonly contents: string; readonly truncated: boolean }
  | { readonly state: "failed" };

/** A hung RPC must resolve to the failed state (with its retry affordance),
 * not an indefinite "Loading…". */
const SCRIPT_FETCH_TIMEOUT_MS = 15_000;

/**
 * Read-only workflow script viewer, fetched through the contained
 * getWorkflowScript RPC (never a raw filesystem read from the client).
 */
function WorkflowScriptView({
  environmentId,
  threadId,
  scriptPath,
  onClose,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  scriptPath: string;
  onClose: () => void;
}) {
  const [result, setResult] = useState<WorkflowScriptState>({ state: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    setResult({ state: "loading" });
    const getWorkflowScript = readEnvironmentApi(environmentId)?.orchestration.getWorkflowScript;
    if (!getWorkflowScript) {
      setResult({ state: "failed" });
      return;
    }
    const timeout = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(
        () => reject(new Error("workflow script fetch timed out")),
        SCRIPT_FETCH_TIMEOUT_MS,
      );
    });
    Promise.race([getWorkflowScript({ threadId, scriptPath }), timeout])
      .then((value) => {
        if (!cancelled) {
          setResult({ state: "loaded", contents: value.contents, truncated: value.truncated });
        }
      })
      .catch(() => {
        if (!cancelled) {
          setResult({ state: "failed" });
        }
      })
      .finally(() => {
        if (timeoutId !== undefined) {
          clearTimeout(timeoutId);
        }
      });
    return () => {
      cancelled = true;
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
      }
    };
  }, [environmentId, threadId, scriptPath, attempt]);

  return (
    <div className="mx-1.5 mb-1 rounded-md border border-border/60 bg-background/60">
      <div className="flex items-center gap-2 border-b border-border/50 px-2 py-1">
        <BracesIcon aria-hidden className="size-3 text-muted-foreground" />
        <span className="truncate font-mono text-[.65rem] text-muted-foreground">
          {scriptPath.split("/").at(-1)}
        </span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close script"
          className="ml-auto text-muted-foreground hover:text-foreground"
        >
          <XIcon aria-hidden className="size-3" />
        </button>
      </div>
      <div className="max-h-72 overflow-auto p-2">
        {result.state === "loaded" ? (
          <pre className="whitespace-pre-wrap break-words font-mono text-[.7rem] leading-relaxed text-foreground/90">
            {result.contents}
            {result.truncated ? "\n… (truncated)" : ""}
          </pre>
        ) : result.state === "failed" ? (
          <div className="flex items-center gap-2">
            <p className="text-xs text-destructive-foreground">Could not load the script.</p>
            <button
              type="button"
              onClick={() => setAttempt((value) => value + 1)}
              className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
            >
              Retry
            </button>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">Loading…</p>
        )}
      </div>
    </div>
  );
}

/**
 * Collapsible phase section: live phases open by default, done phases keep
 * their member dots in the header. User toggles override the default and
 * stick for the phase's lifetime. Claude reveals workflow agents
 * phase-by-phase, so a future phase stays visible as a pending header until
 * its first agent slot arrives — the whole Work → Review → Verify arc reads
 * from the first snapshot without inventing agents.
 */
function PhaseSection({
  phase,
  defaultOpen = false,
}: {
  phase: AgentPanelWorkflowGroup["phases"][number];
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen || phase.state === "running");
  const previousState = useRef(phase.state);

  useEffect(() => {
    if (previousState.current !== "running" && phase.state === "running") {
      setOpen(true);
    }
    previousState.current = phase.state;
  }, [phase.state]);

  if (phase.members.length === 0 && phase.state === "pending") {
    return (
      <div
        data-workflow-pending-step
        data-phase-title={phase.title}
        aria-label={`${phase.title} pending`}
        className={cn(SECTION_LABEL_CLASS, "text-muted-foreground/55")}
      >
        <span
          aria-hidden
          className="ml-[3px] size-1.5 shrink-0 rounded-full border border-dashed border-muted-foreground/60"
        />
        <span>{phase.title}</span>
        <span className="font-normal normal-case">not started</span>
      </div>
    );
  }

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className={cn(
          SECTION_LABEL_CLASS,
          "rounded-md outline-none hover:bg-accent/30 focus-visible:ring-2 focus-visible:ring-ring/50",
          phase.state === "done"
            ? "text-success-foreground"
            : phase.state === "running"
              ? "text-info-foreground"
              : "text-muted-foreground/70",
        )}
      >
        <ChevronRightIcon
          aria-hidden
          className={cn("size-3 shrink-0 transition-transform", open && "rotate-90")}
        />
        <span>{phase.title}</span>
        <span className="font-normal normal-case text-muted-foreground/70">
          {phase.state === "done"
            ? `${phase.settledCount} done`
            : `${phase.activeCount} active · ${phase.settledCount} done`}
        </span>
        {!open ? (
          <span className="ml-auto flex items-center gap-0.5">
            {phase.members.map((member) => (
              <StatusDot key={member.id} status={member.status} />
            ))}
          </span>
        ) : null}
      </button>
      {open ? (
        <AgentRowList>
          {phase.members.map((member) => (
            <AgentRow key={member.id} agent={member} />
          ))}
        </AgentRowList>
      ) : null}
    </div>
  );
}

/**
 * One workflow: a single header row that toggles the phase tree. The open
 * state belongs to the parent so a live workflow never collapses merely
 * because it settled.
 */
function WorkflowSection({
  group,
  environmentId,
  threadId,
}: {
  group: AgentPanelWorkflowGroup;
  environmentId: EnvironmentId | null;
  threadId: ThreadId | null;
}) {
  const [open, setOpen] = useState(() => workflowIsLive(group));
  const [scriptOpen, setScriptOpen] = useState(false);
  const members = workflowMembers(group);
  const failed = members.filter((member) => member.status === "failed").length;
  const settled = members.filter((member) => isTerminalSubagentStatus(member.status)).length;
  // Coordinator usage may already aggregate members (panel-footer rule):
  // count it only when there are no member rows to sum.
  const totalTokens = members.reduce(
    (sum, member) => sum + (member.usage?.totalTokens ?? 0),
    members.length === 0 ? (group.workflow.usage?.totalTokens ?? 0) : 0,
  );
  const name = group.workflow.workflowName ?? group.workflow.title;
  const scriptPath = group.workflow.runHandles?.scriptPath;
  const canShowScript = scriptPath !== undefined && environmentId !== null && threadId !== null;

  return (
    <section data-workflow-section>
      <div className="flex h-8 items-center gap-1 pr-1">
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          className="flex h-full min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-left outline-none hover:bg-accent/30 focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          <StatusDot status={failed > 0 ? "failed" : group.workflow.status} />
          <span className="min-w-0 flex-1 truncate text-[13px] font-semibold tracking-[-0.01em]">
            {name}
          </span>
          <span className="flex shrink-0 items-center gap-1.5 font-mono text-[10.5px] text-muted-foreground/80 tabular-nums">
            {failed > 0 ? (
              <span className="text-destructive-foreground">{failed} failed</span>
            ) : null}
            {open ? (
              <span>
                {settled}/{members.length}
              </span>
            ) : (
              <>
                <span>{members.length} agents</span>
                <span>· {formatSubagentTokenCount(totalTokens)} tok</span>
                <AgentElapsed agent={group.workflow} />
              </>
            )}
          </span>
          <ChevronRightIcon
            aria-hidden
            className={cn(
              "size-3 shrink-0 text-muted-foreground transition-transform",
              open && "rotate-90",
            )}
          />
        </button>
        {open && canShowScript ? (
          <button
            type="button"
            onClick={() => setScriptOpen((value) => !value)}
            aria-expanded={scriptOpen}
            aria-label={scriptOpen ? "Hide workflow script" : "Show workflow script"}
            title="Workflow script"
            className={cn(
              "flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-accent/40 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50",
              scriptOpen && "bg-accent/40 text-foreground",
            )}
          >
            <BracesIcon aria-hidden className="size-3" />
          </button>
        ) : null}
      </div>
      {open ? (
        <>
          {scriptOpen && canShowScript ? (
            <WorkflowScriptView
              environmentId={environmentId}
              threadId={threadId}
              scriptPath={scriptPath}
              onClose={() => setScriptOpen(false)}
            />
          ) : null}
          {group.phases.map((phase) => (
            <PhaseSection key={phase.index} phase={phase} defaultOpen />
          ))}
          <AgentRowList>
            {group.unphasedMembers.map((member) => (
              <AgentRow key={member.id} agent={member} />
            ))}
          </AgentRowList>
          {group.phases.length === 0 && group.unphasedMembers.length === 0 ? (
            <AgentRow agent={group.workflow} />
          ) : null}
        </>
      ) : null}
    </section>
  );
}

export function AgentsPanel({
  model,
  environmentId = null,
  threadId = null,
  onOpenAgent = null,
  subagents = [],
  selectedAgentId = null,
  onBack,
}: {
  subagents?: ReadonlyArray<ThreadSubagentView>;
  selectedAgentId?: string | null;
  onBack?: () => void;
  model: AgentPanelModel;
  environmentId?: EnvironmentId | null;
  threadId?: ThreadId | null;
  onOpenAgent?: ((agentId: string) => void) | null;
}) {
  const [localSelection, setLocalSelection] = useState<string | null>(null);
  useEffect(() => setLocalSelection(null), [threadId]);
  const identityContext = useMemo<AgentsPanelIdentityContextValue>(() => {
    const agentsById = new Map<string, RuntimeSubagent>();
    for (const group of model.workflows) {
      agentsById.set(group.workflow.id, group.workflow);
      for (const member of workflowMembers(group)) agentsById.set(member.id, member);
    }
    for (const agent of model.directAgents) agentsById.set(agent.id, agent);
    const agents = [...agentsById.values()];
    const identities = assignSubagentIdentities(
      agents.map((agent) => ({
        key: agent.id,
        role: agent.role,
        taskLabel: agent.title,
      })),
    );
    return {
      identities,
      labels: resolveSubagentDisplayLabels(
        agents.map((agent) => ({
          id: agent.id,
          title: agent.title,
          codename: identities.get(agent.id)?.codename ?? agent.id,
        })),
      ),
      onOpenAgent: onOpenAgent ?? setLocalSelection,
    };
  }, [model, onOpenAgent]);

  const selection = selectedAgentId ?? localSelection;
  const selected = selection
    ? [
        ...model.directAgents,
        ...model.workflows.flatMap((group) => [group.workflow, ...workflowMembers(group)]),
      ].find(
        (agent) =>
          canonicalSubagentIdentityKey(agent.id) === canonicalSubagentIdentityKey(selection),
      )
    : undefined;
  if (selected) {
    const transcript = subagents.find(
      (agent) =>
        canonicalSubagentIdentityKey(agent.key) === canonicalSubagentIdentityKey(selected.id),
    );
    const identity = identityContext.identities.get(selected.id);
    const label =
      identityContext.labels.get(selected.id) ??
      resolveSubagentDisplayLabel({
        id: selected.id,
        title: selected.title,
        codename: identity?.codename ?? selected.id,
      });
    const role =
      identity?.role &&
      !subagentRoleDuplicatesLabel(identity.role, label) &&
      !subagentRoleDuplicatesLabel(identity.role, selected.title)
        ? identity.role
        : null;
    return (
      <div className="flex h-full min-h-0 flex-col" data-agent-detail>
        <header className="space-y-1.5 border-b border-border/60 px-3 py-2.5">
          <button
            type="button"
            onClick={() => {
              setLocalSelection(null);
              onBack?.();
            }}
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          >
            <ArrowLeftIcon aria-hidden className="size-3.5" />
            All agents
          </button>
          <div className="flex items-center gap-2">
            <StatusDot status={selected.status} />
            <h3 className="flex min-w-0 flex-1">
              <AgentLabel label={label} wrap className="text-sm font-semibold" />
            </h3>
            <span className="shrink-0 text-xs text-muted-foreground">
              {STATUS_VISUALS[selected.status].label}
            </span>
          </div>
          {label !== selected.title.trim() ? (
            <p className="break-words text-xs leading-relaxed text-muted-foreground">
              {selected.title}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-x-3 gap-y-1 font-mono text-[10.5px] text-muted-foreground tabular-nums">
            {role ? <span className="font-sans">{role}</span> : null}
            {selected.model ? (
              <span>{formatSubagentModelLabel(selected.model, selected.effort)}</span>
            ) : null}
            <AgentElapsed agent={selected} />
            {selected.usage?.totalTokens !== undefined ? (
              <span>{formatSubagentTokenCount(selected.usage.totalTokens)} tok</span>
            ) : null}
            {selected.usage?.toolUses !== undefined ? (
              <span>{selected.usage.toolUses} tools</span>
            ) : null}
            <span>
              updated{" "}
              <time dateTime={selected.updatedAt}>
                {new Date(selected.updatedAt).toLocaleTimeString()}
              </time>
            </span>
          </div>
        </header>
        <ScrollArea className="min-h-0 flex-1">
          {selected.error ? (
            <p
              role="status"
              className="m-3 whitespace-pre-wrap break-words text-xs text-destructive"
            >
              {selected.error}
            </p>
          ) : null}
          <AgentActivityTimeline
            subagent={transcript ?? { messages: [], entries: [] }}
            running={selected.status === "running" || selected.status === "waiting"}
          />
          {!transcript && selected.progress ? (
            <p className="px-3 pb-3 text-xs text-muted-foreground">{selected.progress}</p>
          ) : null}
          {selected.result &&
          !transcript?.messages.some((message) => message.text === selected.result) ? (
            <div className="border-t border-border/40 p-3 text-sm">
              <p className="mb-2 text-xs font-medium text-muted-foreground">Result summary</p>
              <ChatMarkdown text={selected.result} cwd={undefined} isStreaming={false} />
            </div>
          ) : null}
        </ScrollArea>
      </div>
    );
  }

  if (!model.hasAgents) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
        <BotIcon aria-hidden className="size-6 text-muted-foreground/60" />
        <p className="text-sm font-medium">No agents yet</p>
        <p className="max-w-56 text-xs text-muted-foreground">
          When this thread spawns subagents or runs a workflow, they show up here with live status,
          activity, and token usage.
        </p>
      </div>
    );
  }

  return (
    <AgentsPanelIdentityContext.Provider value={identityContext}>
      <div className="flex h-full min-h-0 flex-col">
        <ScrollArea className="min-h-0 flex-1">
          <div className="flex flex-col divide-y divide-border/40 px-1.5">
            {model.workflows.map((group) => (
              <div key={group.workflow.id} className="py-1.5">
                <WorkflowSection group={group} environmentId={environmentId} threadId={threadId} />
              </div>
            ))}
            {model.directAgents.length > 0 ? (
              <section className="py-1.5">
                <div className={cn(SECTION_LABEL_CLASS, "text-muted-foreground")}>
                  Direct spawns
                </div>
                <AgentRowList>
                  {model.directAgents.map((agent) => (
                    <AgentRow key={agent.id} agent={agent} />
                  ))}
                </AgentRowList>
              </section>
            ) : null}
          </div>
        </ScrollArea>
        <footer className="flex items-center justify-between border-t border-border/60 px-3 py-1.5 font-mono text-[.7rem] text-muted-foreground">
          <span className="flex items-center gap-2">
            {model.runningCount + model.waitingCount > 0 ? (
              <span className="text-info-foreground">
                ● {model.runningCount} active
                {model.waitingCount > 0 ? ` · ${model.waitingCount} waiting` : ""}
              </span>
            ) : null}
            {model.idleCount > 0 ? <span>{model.idleCount} idle</span> : null}
            {model.settledCount > 0 ? <span>{model.settledCount} settled</span> : null}
          </span>
          <span className="tabular-nums">Σ {formatSubagentTokenCount(model.totalTokens)} tok</span>
        </footer>
      </div>
    </AgentsPanelIdentityContext.Provider>
  );
}
