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
 */
import type { EnvironmentId, ThreadId } from "@ryco/contracts";
import {
  ArrowLeftIcon,
  BotIcon,
  BracesIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  Clock3Icon,
  XIcon,
} from "lucide-react";
import { createContext, use, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { readEnvironmentApi } from "../environmentApi";
import {
  assignSubagentIdentities,
  canonicalSubagentIdentityKey,
  type ThreadSubagentView,
  formatSubagentModelLabel,
  formatSubagentTokenCount,
  subagentRoleDuplicatesLabel,
  type AgentPanelModel,
  type AgentPanelWorkflowGroup,
  type RuntimeSubagent,
  type SubagentIdentity,
} from "../threadWorkspaceViewModel";
import { cn } from "~/lib/utils";
import { AgentActivityTimeline } from "./AgentActivityTimeline";
import ChatMarkdown from "./ChatMarkdown";
import { SubagentAvatar } from "./sidebar/SubagentAvatar";
import { ScrollArea } from "./ui/scroll-area";

/** Provider phases remain distinct, including resumable idle agents. */
const STATUS_VISUALS: Record<RuntimeSubagent["status"], { dotClass: string; label: string }> = {
  pending: { dotClass: "bg-info", label: "Queued" },
  running: { dotClass: "bg-info", label: "Running" },
  waiting: { dotClass: "bg-info", label: "Waiting" },
  // Idle reads as settled (muted, not sky): a resting Codex child looks done
  // unless resumed.
  idle: { dotClass: "bg-muted-foreground/50", label: "Idle · resumable" },
  completed: { dotClass: "bg-success", label: "Completed" },
  failed: { dotClass: "bg-destructive", label: "Failed" },
  cancelled: { dotClass: "bg-muted-foreground/60", label: "Stopped" },
  interrupted: { dotClass: "bg-muted-foreground/60", label: "Interrupted" },
};

interface AgentsPanelIdentityContextValue {
  readonly identities: ReadonlyMap<string, SubagentIdentity>;
  readonly onOpenAgent: ((agentId: string) => void) | null;
}

const AgentsPanelIdentityContext = createContext<AgentsPanelIdentityContextValue>({
  identities: new Map(),
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
  return <div className="divide-y divide-border/30">{children}</div>;
}

/**
 * Claude reveals workflow agents phase-by-phase. Keep future stages visible
 * as deliberate pending rows until their concrete agent slots arrive; this
 * makes the complete Work → Review → Verify arc readable from the first
 * workflow snapshot without pretending an unknown agent already exists.
 */
function PendingWorkflowPhaseRow({ title }: { title: string }) {
  return (
    <div
      data-workflow-pending-step
      data-phase-title={title}
      aria-label={`${title} pending`}
      className="grid h-14 grid-cols-[1.75rem_minmax(0,1fr)_auto] items-center gap-x-2 rounded-md px-1.5 py-1 text-left"
    >
      <span
        aria-hidden
        className="flex size-7 items-center justify-center rounded-lg border border-dashed border-border/60 bg-background/30 text-muted-foreground/55"
      >
        <Clock3Icon className="size-3.5" />
      </span>
      <span className="min-w-0">
        <span className="block truncate text-sm font-medium text-foreground/75">{title}</span>
        <span className="block truncate text-[11px] text-muted-foreground/65">
          Waiting for this stage to start
        </span>
      </span>
      <span className="inline-flex items-center gap-1 font-mono text-[.68rem] text-muted-foreground/65">
        <span aria-hidden className="size-1.5 rounded-full bg-muted-foreground/40" />
        Pending
      </span>
    </div>
  );
}

/** Fixed three-line identity/task/activity row; updates never change height. */
function AgentRow({ agent }: { agent: RuntimeSubagent }) {
  const { identities, onOpenAgent } = use(AgentsPanelIdentityContext);
  const visuals = STATUS_VISUALS[agent.status];
  const activity = agentActivityText(agent);
  const modelLabel = formatSubagentModelLabel(agent.model, agent.effort);
  const identity = identities.get(agent.id);
  const codename = identity?.codename ?? agent.title;
  const role =
    identity?.role &&
    !subagentRoleDuplicatesLabel(identity.role, codename) &&
    !subagentRoleDuplicatesLabel(identity.role, agent.title)
      ? identity.role
      : null;
  const taskLabel = identity?.taskLabel ?? agent.title;
  const metadata = [
    modelLabel,
    agent.usage ? `${formatSubagentTokenCount(agent.usage.totalTokens)} tok` : "— tok",
    agent.usage?.toolUses !== undefined ? `${agent.usage.toolUses} tools` : null,
    agent.activationCount > 1 ? `run ${agent.activationCount}` : null,
  ].filter((value): value is string => value !== null);

  const content = (
    <>
      <span
        aria-hidden
        className="relative col-start-1 row-span-3 row-start-1 mt-0.5 flex size-7 items-center justify-center rounded-lg border border-border/45 bg-background/45"
      >
        <SubagentAvatar name={identity?.avatarKey ?? agent.id} className="size-5" />
        <span className="absolute -right-0.5 -bottom-0.5 grid size-2.5 place-items-center rounded-full bg-background ring-1 ring-background">
          <StatusDot status={agent.status} />
        </span>
      </span>
      <span className="col-start-2 row-start-1 flex min-w-0 items-center gap-1.5">
        <span className="min-w-0 truncate text-sm font-semibold tracking-[-0.01em]">
          {codename}
        </span>
        {role ? (
          <span className="max-w-32 shrink-0 truncate rounded-sm border border-border/60 bg-background/40 px-1.5 py-px text-[10px] font-medium text-muted-foreground">
            {role}
          </span>
        ) : null}
      </span>
      <span className="col-start-3 row-start-1 min-w-14 text-right font-mono text-[.7rem] text-muted-foreground/80">
        <span className="inline-flex items-center gap-1">
          <span>{visuals.label}</span>
          <AgentElapsed agent={agent} />
          {agent.status === "completed" ? (
            <CheckIcon aria-hidden className="size-3 text-success" />
          ) : null}
        </span>
      </span>
      <span
        className="col-start-2 col-end-4 row-start-2 block truncate text-[11px] text-foreground/65"
        title={taskLabel}
      >
        {taskLabel}
      </span>
      <span
        className={cn(
          "col-start-2 row-start-3 block min-w-0 truncate text-xs",
          agent.status === "failed" ? "text-destructive-foreground" : "text-muted-foreground",
        )}
        title={activity ?? visuals.label}
      >
        {activity ?? visuals.label}
      </span>
      <span className="col-start-3 row-start-3 max-w-40 truncate text-right font-mono text-[.68rem] tabular-nums text-muted-foreground/65">
        {metadata.join(" · ")}
      </span>
      <span className="sr-only">{visuals.label}</span>
    </>
  );

  const className = cn(
    "grid h-[4.5rem] w-full grid-cols-[1.75rem_minmax(0,1fr)_auto] grid-rows-[1.375rem_1.125rem_1rem] items-center gap-x-2 rounded-md px-1.5 py-1 text-left outline-none transition-colors",
    onOpenAgent && "hover:bg-accent/35 focus-visible:ring-2 focus-visible:ring-ring/50",
  );
  return onOpenAgent ? (
    <button
      type="button"
      className={className}
      data-agent-row
      data-agent-id={agent.id}
      onClick={() => onOpenAgent(agent.id)}
      aria-label={`Open ${codename}${role ? `, ${role}` : ""} transcript. ${visuals.label}.`}
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

/**
 * Phase rail: the run's shape at a glance. One segment per phase in order,
 * separated by chevrons; each segment shows title + one dot per member.
 * The whole arc (done → live → pending) is visible without scrolling the
 * member list.
 */
function PhaseRail({ group }: { group: AgentPanelWorkflowGroup }) {
  if (group.phases.length === 0) {
    return null;
  }
  return (
    <div className="flex flex-wrap items-center gap-x-1 gap-y-1 px-1.5 pb-1 pt-1.5">
      {group.phases.map((phase, index) => (
        <div key={phase.index} className="flex items-center gap-1">
          {index > 0 ? (
            <ChevronRightIcon aria-hidden className="size-3 text-muted-foreground/40" />
          ) : null}
          <div
            className={cn(
              "flex items-center gap-1 rounded-sm border px-1.5 py-0.5",
              phase.state === "running"
                ? "border-info/40"
                : phase.state === "done"
                  ? "border-success/30"
                  : "border-border/50",
            )}
          >
            <span
              className={cn(
                "font-mono text-[.65rem]",
                phase.state === "running"
                  ? "text-info-foreground"
                  : phase.state === "done"
                    ? "text-success-foreground"
                    : "text-muted-foreground/70",
              )}
            >
              {phase.state === "done" ? "✓ " : ""}
              {phase.title}
            </span>
            <span className="flex items-center gap-0.5">
              {phase.members.length === 0 ? (
                <span className="font-mono text-[.6rem] text-muted-foreground/50">–</span>
              ) : (
                phase.members.map((member) => <StatusDot key={member.id} status={member.status} />)
              )}
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}

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
 * Collapsible phase section: live phases open by default, done phases
 * collapsed to header + member dot row. User toggles override the default
 * and stick for the phase's lifetime.
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

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className={cn(
          "mt-2 flex w-full items-center gap-1.5 rounded-sm px-1.5 text-left text-[.65rem] font-medium uppercase tracking-wider hover:bg-accent/40",
          phase.state === "done"
            ? "text-success-foreground"
            : phase.state === "running"
              ? "text-info-foreground"
              : "text-muted-foreground/70",
        )}
      >
        {open ? (
          <ChevronDownIcon aria-hidden className="size-3 shrink-0" />
        ) : (
          <ChevronRightIcon aria-hidden className="size-3 shrink-0" />
        )}
        {phase.state === "done" ? <CheckIcon aria-hidden className="size-3" /> : null}
        <span>{phase.title}</span>
        <span className="font-normal normal-case text-muted-foreground/70">
          {phase.state === "pending" && phase.members.length === 0
            ? "pending"
            : phase.state === "done"
              ? `${phase.settledCount} done`
              : `${phase.activeCount} active · ${phase.settledCount} done`}
        </span>
        {!open && phase.members.length > 0 ? (
          <span className="ml-auto flex items-center gap-0.5">
            {phase.members.map((member) => (
              <StatusDot key={member.id} status={member.status} />
            ))}
          </span>
        ) : null}
      </button>
      {open ? (
        <AgentRowList>
          {phase.members.length === 0 && phase.state === "pending" ? (
            <PendingWorkflowPhaseRow title={phase.title} />
          ) : (
            phase.members.map((member) => <AgentRow key={member.id} agent={member} />)
          )}
        </AgentRowList>
      ) : null}
    </div>
  );
}

/** Expanded workflow: phase rail + full phase tree. */
function ExpandedWorkflowSection({
  group,
  environmentId,
  threadId,
  onCollapse,
}: {
  group: AgentPanelWorkflowGroup;
  environmentId: EnvironmentId | null;
  threadId: ThreadId | null;
  onCollapse: () => void;
}) {
  const [scriptOpen, setScriptOpen] = useState(false);
  const members = workflowMembers(group);
  const settled = members.filter(
    (member) =>
      member.status === "completed" ||
      member.status === "failed" ||
      member.status === "cancelled" ||
      member.status === "interrupted",
  ).length;
  const scriptPath = group.workflow.runHandles?.scriptPath;
  const canShowScript = scriptPath !== undefined && environmentId !== null && threadId !== null;
  return (
    <section className="rounded-lg border border-border/50 bg-card/30 p-1.5">
      <div className="flex items-center gap-2 px-1.5 pt-0.5 text-[.65rem] font-medium uppercase tracking-wider text-muted-foreground">
        <StatusDot status={group.workflow.status} />
        <span className="min-w-0 truncate">
          {group.workflow.workflowName ?? group.workflow.title}
        </span>
        {canShowScript ? (
          <button
            type="button"
            onClick={() => setScriptOpen((value) => !value)}
            className={cn(
              "rounded-sm border border-border/60 px-1 font-mono normal-case hover:text-foreground",
              scriptOpen && "text-foreground",
            )}
            aria-expanded={scriptOpen}
          >
            {"{}"} script
          </button>
        ) : null}
        <span className="ml-auto font-mono normal-case text-muted-foreground/80">
          {settled}/{members.length} settled
        </span>
        <button
          type="button"
          onClick={onCollapse}
          aria-label="Collapse workflow"
          className="rounded-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          <ChevronDownIcon aria-hidden className="size-3" />
        </button>
      </div>
      <PhaseRail group={group} />
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
    </section>
  );
}

/**
 * Collapsed workflow: one stable summary row. The parent owns presentation
 * state so a live workflow never collapses merely because it settled.
 */
function CollapsedWorkflowSection({
  group,
  onExpand,
}: {
  group: AgentPanelWorkflowGroup;
  onExpand: () => void;
}) {
  const members = workflowMembers(group);
  const failed = members.filter((member) => member.status === "failed").length;
  // Coordinator usage may already aggregate members (panel-footer rule):
  // count it only when there are no member rows to sum.
  const totalTokens = members.reduce(
    (sum, member) => sum + (member.usage?.totalTokens ?? 0),
    members.length === 0 ? (group.workflow.usage?.totalTokens ?? 0) : 0,
  );
  const elapsed =
    group.workflow.startedAt && group.workflow.completedAt
      ? elapsedBetween(group.workflow.startedAt, group.workflow.completedAt)
      : null;
  return (
    <section>
      <button
        type="button"
        onClick={onExpand}
        className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left outline-none hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring/50"
        aria-expanded={false}
      >
        <StatusDot status={failed > 0 ? "failed" : group.workflow.status} />
        <span className="min-w-0 flex-1 truncate text-sm font-medium">
          {group.workflow.workflowName ?? group.workflow.title}
        </span>
        <span className="flex shrink-0 items-center gap-1.5 font-mono text-[.7rem] text-muted-foreground/80">
          {failed > 0 ? <span className="text-destructive-foreground">{failed} failed</span> : null}
          <span>{members.length} agents</span>
          <span className="tabular-nums">· {formatSubagentTokenCount(totalTokens)} tok</span>
          {elapsed ? <span className="tabular-nums">· {elapsed}</span> : null}
          <ChevronRightIcon aria-hidden className="size-3" />
        </span>
      </button>
    </section>
  );
}

/** A workflow's open state is presentation state, never a status derivative. */
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
  return open ? (
    <ExpandedWorkflowSection
      group={group}
      environmentId={environmentId}
      threadId={threadId}
      onCollapse={() => setOpen(false)}
    />
  ) : (
    <CollapsedWorkflowSection group={group} onExpand={() => setOpen(true)} />
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
    return {
      identities: assignSubagentIdentities(
        [...agentsById.values()].map((agent) => ({
          key: agent.id,
          role: agent.role,
          taskLabel: agent.title,
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
    return (
      <div className="flex h-full min-h-0 flex-col" data-agent-detail>
        <header className="space-y-2 border-b border-border/60 px-3 py-3">
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
          <div className="flex items-center justify-between gap-2">
            <h3 className="truncate text-sm font-semibold">
              {identity?.codename ?? selected.role ?? selected.title}
            </h3>
            <span className="flex shrink-0 items-center gap-1.5 text-xs">
              <StatusDot status={selected.status} />
              {STATUS_VISUALS[selected.status].label}
            </span>
          </div>
          <p className="break-words text-xs leading-relaxed text-muted-foreground">
            {selected.title}
          </p>
          <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
            <span>
              {selected.model
                ? formatSubagentModelLabel(selected.model, selected.effort)
                : "Model not reported"}
            </span>
            <AgentElapsed agent={selected} />
            {selected.usage?.totalTokens !== undefined ? (
              <span>{formatSubagentTokenCount(selected.usage.totalTokens)} tokens</span>
            ) : null}
          </div>
          <p className="text-[10px] text-muted-foreground/70">
            Last reported activity{" "}
            <time dateTime={selected.updatedAt}>
              {new Date(selected.updatedAt).toLocaleTimeString()}
            </time>
          </p>
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
          <div className="flex flex-col gap-2 p-2">
            {model.workflows.map((group) => (
              <WorkflowSection
                key={group.workflow.id}
                group={group}
                environmentId={environmentId}
                threadId={threadId}
              />
            ))}
            {model.directAgents.length > 0 ? (
              <section>
                <div className="px-1.5 pt-1 text-[.65rem] font-medium uppercase tracking-wider text-muted-foreground">
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
