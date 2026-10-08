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
 *
 * Rows, status dots and roster identity are shared with the crown's Subagents
 * detail (./agents/agentRoster); this file owns the workflow, phase and
 * script sections and the agent detail view.
 */
import type { EnvironmentId, ThreadId } from "@ryco/contracts";
import { ArrowLeftIcon, BotIcon, BracesIcon, ChevronRightIcon, XIcon } from "lucide-react";
import { useCallback, useEffect, useEffectEvent, useRef, useState, type ReactNode } from "react";

import { readEnvironmentApi } from "../environmentApi";
import { landingFlashClass, scrollRowIntoView, useLandingFlash } from "../hooks/useLandingFlash";
import {
  agentPanelRoster,
  agentPhaseStatusText,
  canonicalSubagentIdentityKey,
  type ThreadSubagentView,
  formatSubagentModelLabel,
  formatSubagentTokenCount,
  summarizeAgentWorkflow,
  type AgentPanelModel,
  type AgentPanelWorkflowGroup,
  type RuntimeSubagent,
} from "../threadWorkspaceViewModel";
import { cn } from "~/lib/utils";
import { AgentActivityTimeline } from "./AgentActivityTimeline";
import {
  AGENT_STATUS_VISUALS,
  AgentElapsed,
  AgentLabel,
  AgentRosterProvider,
  AgentRow,
  AgentRowList,
  AgentStatusDot,
  PhaseMemberDots,
  useAgentRowIdentity,
} from "./agents/agentRoster";
import ChatMarkdown from "./ChatMarkdown";
import { ScrollArea } from "./ui/scroll-area";

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
        <span className="font-normal normal-case">{agentPhaseStatusText(phase)}</span>
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
          {agentPhaseStatusText(phase)}
        </span>
        {!open ? <PhaseMemberDots members={phase.members} className="ml-auto" /> : null}
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
 * because it settled. A focus token (a deep link into this workflow) opens
 * it, scrolls it to the top of the pane and flashes its header once.
 */
function WorkflowSection({
  group,
  environmentId,
  threadId,
  focusToken,
  headerClassName,
  onFocusLanded,
}: {
  group: AgentPanelWorkflowGroup;
  environmentId: EnvironmentId | null;
  threadId: ThreadId | null;
  /** Non-null while a focus request for this workflow waits to land. */
  focusToken: number | null;
  headerClassName: string | undefined;
  onFocusLanded: (workflowId: string, token: number) => void;
}) {
  const summary = summarizeAgentWorkflow(group);
  const [open, setOpen] = useState(() => summary.live);
  const [scriptOpen, setScriptOpen] = useState(false);
  const sectionRef = useRef<HTMLElement>(null);
  const workflowId = group.workflow.id;
  const scriptPath = group.workflow.runHandles?.scriptPath;
  const canShowScript = scriptPath !== undefined && environmentId !== null && threadId !== null;

  useEffect(() => {
    if (focusToken === null) return;
    setOpen(true);
    const frame = window.requestAnimationFrame(() => {
      if (sectionRef.current) scrollRowIntoView(sectionRef.current);
      onFocusLanded(workflowId, focusToken);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [focusToken, onFocusLanded, workflowId]);

  return (
    <section ref={sectionRef} data-workflow-section>
      <div className={cn("flex h-8 items-center gap-1 rounded-md pr-1", headerClassName)}>
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          className="flex h-full min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-left outline-none hover:bg-accent/30 focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          <AgentStatusDot status={summary.displayStatus} />
          <span className="min-w-0 flex-1 truncate text-[13px] font-semibold tracking-[-0.01em]">
            {summary.name}
          </span>
          <span className="flex shrink-0 items-center gap-1.5 font-mono text-[10.5px] text-muted-foreground/80 tabular-nums">
            {summary.failedCount > 0 ? (
              <span className="text-destructive-foreground">{summary.failedCount} failed</span>
            ) : null}
            {open ? (
              <span>
                {summary.settledCount}/{summary.memberCount}
              </span>
            ) : (
              <>
                <span>{summary.memberCount} agents</span>
                <span>· {formatSubagentTokenCount(summary.totalTokens)} tok</span>
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

/** One agent's header and activity feed, inside the Agents surface. */
function AgentDetailView({
  selected,
  transcript,
  onBack,
}: {
  selected: RuntimeSubagent;
  transcript: ThreadSubagentView | undefined;
  onBack: () => void;
}) {
  const { label, role } = useAgentRowIdentity(selected);
  return (
    <div className="flex h-full min-h-0 flex-col" data-agent-detail>
      <header className="space-y-1.5 border-b border-border/60 px-3 py-2.5">
        <button
          type="button"
          onClick={onBack}
          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          <ArrowLeftIcon aria-hidden className="size-3.5" />
          All agents
        </button>
        <div className="flex items-center gap-2">
          <AgentStatusDot status={selected.status} />
          <h3 className="flex min-w-0 flex-1">
            <AgentLabel label={label} wrap className="text-sm font-semibold" />
          </h3>
          <span className="shrink-0 text-xs text-muted-foreground">
            {AGENT_STATUS_VISUALS[selected.status].label}
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
          <p role="status" className="m-3 whitespace-pre-wrap break-words text-xs text-destructive">
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

interface AgentsPanelFocus {
  readonly workflowId: string;
  /** Bumped per request, so focusing the same workflow again re-lands. */
  readonly token: number;
  readonly landed: boolean;
}

export function AgentsPanel({
  model,
  environmentId = null,
  threadId = null,
  onOpenAgent = null,
  subagents = [],
  selectedAgentId = null,
  onBack,
  focusWorkflowId = null,
  onFocusWorkflowHandled,
}: {
  subagents?: ReadonlyArray<ThreadSubagentView>;
  selectedAgentId?: string | null;
  onBack?: () => void;
  model: AgentPanelModel;
  environmentId?: EnvironmentId | null;
  threadId?: ThreadId | null;
  onOpenAgent?: ((agentId: string) => void) | null;
  /**
   * One-shot deep link: expand this workflow, scroll it into view and flash
   * its header. Handled once per value (onFocusWorkflowHandled fires right
   * away so the owner can clear it); a new value lands again.
   */
  focusWorkflowId?: string | null;
  onFocusWorkflowHandled?: () => void;
}) {
  const [localSelection, setLocalSelection] = useState<string | null>(null);
  useEffect(() => setLocalSelection(null), [threadId]);

  const [focus, setFocus] = useState<AgentsPanelFocus | null>(null);
  const { flash, trigger: triggerFlash } = useLandingFlash();
  const reportFocusHandled = useEffectEvent(() => onFocusWorkflowHandled?.());
  useEffect(() => {
    if (!focusWorkflowId) return;
    setFocus((current) => ({
      workflowId: focusWorkflowId,
      token: (current?.token ?? 0) + 1,
      landed: false,
    }));
    setLocalSelection(null);
    reportFocusHandled();
  }, [focusWorkflowId]);
  const onFocusLanded = useCallback(
    (workflowId: string, token: number) => {
      triggerFlash(workflowId);
      setFocus((current) =>
        current !== null && current.token === token ? { ...current, landed: true } : current,
      );
    },
    [triggerFlash],
  );

  const selection = selectedAgentId ?? localSelection;
  const selected = selection
    ? agentPanelRoster(model).find(
        (agent) =>
          canonicalSubagentIdentityKey(agent.id) === canonicalSubagentIdentityKey(selection),
      )
    : undefined;

  let content: ReactNode;
  if (selected) {
    content = (
      <AgentDetailView
        selected={selected}
        transcript={subagents.find(
          (agent) =>
            canonicalSubagentIdentityKey(agent.key) === canonicalSubagentIdentityKey(selected.id),
        )}
        onBack={() => {
          setLocalSelection(null);
          onBack?.();
        }}
      />
    );
  } else if (!model.hasAgents) {
    content = (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
        <BotIcon aria-hidden className="size-6 text-muted-foreground/60" />
        <p className="text-sm font-medium">No agents yet</p>
        <p className="max-w-56 text-xs text-muted-foreground">
          When this thread spawns subagents or runs a workflow, they show up here with live status,
          activity, and token usage.
        </p>
      </div>
    );
  } else {
    content = (
      <div className="flex h-full min-h-0 flex-col">
        <ScrollArea className="min-h-0 flex-1">
          <div className="flex flex-col divide-y divide-border/40 px-1.5">
            {model.workflows.map((group) => (
              <div key={group.workflow.id} className="py-1.5">
                <WorkflowSection
                  group={group}
                  environmentId={environmentId}
                  threadId={threadId}
                  focusToken={
                    focus !== null && !focus.landed && focus.workflowId === group.workflow.id
                      ? focus.token
                      : null
                  }
                  headerClassName={landingFlashClass(flash, group.workflow.id)}
                  onFocusLanded={onFocusLanded}
                />
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
    );
  }

  return (
    <AgentRosterProvider model={model} onOpenAgent={onOpenAgent ?? setLocalSelection}>
      {content}
    </AgentRosterProvider>
  );
}
