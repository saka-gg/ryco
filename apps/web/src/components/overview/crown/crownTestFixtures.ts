import {
  EnvironmentId,
  NotesError,
  OrchestrationProposedPlanId,
  TurnId,
  type NotesApi,
  type NotesCommand,
  type NotesSnapshot,
  type ProjectId,
  type WorktreeNote,
} from "@ryco/contracts";

import { makeRuntimeAgent } from "../../agents/agentRosterTestFixtures";
import type { PrCheckStatusKind, PrCheckStatusView } from "../../projectExplorer/prCheckStatus";
import {
  deriveAgentPanelModel,
  isTerminalSubagentStatus,
  type AgentPanelModel,
  type RuntimeSubagent,
  type RuntimeSubagentStatus,
  type ThreadSubagentView,
} from "../../../threadWorkspaceViewModel";
import type { NoteView } from "../notes/noteView";
import type { CrownSnapshot } from "./crownAlerts.logic";
import type { CrownNotesBinding } from "./crownTypes";
import type {
  OverviewChanges,
  OverviewLayoutProps,
  OverviewPullRequestCheckRun,
  OverviewPullRequestState,
} from "../overviewTypes";

/**
 * Test-only builders for the crown's logic, hook and component tests: base
 * factories, plus the prototype's sample state built from them.
 */

const KIND_TONE: Record<PrCheckStatusKind, PrCheckStatusView["tone"]> = {
  loading: "neutral",
  pending: "pending",
  running: "running",
  passed: "success",
  failed: "failure",
  cancelled: "cancelled",
  unavailable: "neutral",
  "api-error": "error",
};

export function makeCheckStatus(
  kind: PrCheckStatusKind,
  extras: { headSha?: string; failed?: ReadonlyArray<string> } = {},
): PrCheckStatusView {
  return {
    kind,
    tone: KIND_TONE[kind],
    icon: "check",
    label: kind,
    shortLabel: kind,
    description: kind,
    ariaLabel: kind,
    className: "",
    iconClassName: "",
    dotClassName: "",
    isTerminal: kind === "passed" || kind === "failed" || kind === "cancelled",
    isRefreshable: true,
    failedChecks: (extras.failed ?? []).map((name) => ({ name })),
    ...(extras.headSha ? { headSha: extras.headSha } : {}),
  };
}

export function makeRun(
  name: string,
  tone: OverviewPullRequestCheckRun["tone"],
  id = `run:${name}`,
): OverviewPullRequestCheckRun {
  return { id, name, tone, statusKind: "running", statusLabel: tone };
}

export function makePullRequest(
  overrides: Partial<OverviewPullRequestState> = {},
): OverviewPullRequestState {
  const latestRuns = overrides.latestRuns ?? [];
  return {
    number: 42,
    title: "Crown rail",
    state: "open",
    checkStatus: null,
    checksLoading: false,
    hasMergeConflicts: false,
    activeCheckCount: latestRuns.length,
    runs: latestRuns,
    latestRuns,
    ...overrides,
  };
}

export function makeChanges(overrides: Partial<OverviewChanges> = {}): OverviewChanges {
  return {
    files: [],
    insertions: 0,
    deletions: 0,
    refName: "feature/crown",
    aheadCount: 0,
    behindCount: 0,
    ...overrides,
  };
}

export function makeSubagent(
  key: string,
  status: ThreadSubagentView["status"],
  name = key,
  overrides: Partial<ThreadSubagentView> = {},
): ThreadSubagentView {
  return {
    key,
    name,
    status,
    origin: null,
    capability: null,
    tool: null,
    detail: null,
    providerThreadIds: [],
    providerSessionIds: [],
    startedAt: "2026-10-07T10:00:00.000Z",
    updatedAt: "2026-10-07T10:00:00.000Z",
    entries: [],
    messages: [],
    ...overrides,
  };
}

/** The runtime agents model the crown's Subagents section, counts and alerts read. */
export function makeAgentPanelModel(agents: ReadonlyArray<RuntimeSubagent>): AgentPanelModel {
  return deriveAgentPanelModel({ agents });
}

const AGENT_STARTED_AT = "2026-10-07T10:00:00.000Z";

/** A member of a workflow run, in phase `phaseIndex`. */
export function makeWorkflowMember(
  id: string,
  workflowId: string,
  phaseIndex: number,
  overrides: Partial<RuntimeSubagent> = {},
): RuntimeSubagent {
  return makeRuntimeAgent(id, {
    kind: "workflow_agent",
    parentAgentId: workflowId,
    phaseIndex,
    firstSeenAt: AGENT_STARTED_AT,
    ...overrides,
  });
}

export const AUDIT_WORKFLOW_ID = "wf-audit";

type AuditMember = "map" | "types" | "card" | "alerts";

/**
 * The `wf-audit` run: Work done (map completed, types failed), Review running
 * (card running, alerts completed), Verify not started. Pass statuses to move
 * the coordinator or any member along.
 */
export function auditWorkflowAgents(
  statuses: {
    readonly coordinator?: RuntimeSubagentStatus;
    readonly members?: Partial<Record<AuditMember, RuntimeSubagentStatus>>;
  } = {},
): RuntimeSubagent[] {
  const member = (key: AuditMember, phaseIndex: number, agentIndex: number, title: string) => {
    const defaults: Record<AuditMember, RuntimeSubagentStatus> = {
      map: "completed",
      types: "failed",
      card: "running",
      alerts: "completed",
    };
    const status = statuses.members?.[key] ?? defaults[key];
    return makeWorkflowMember(`${AUDIT_WORKFLOW_ID}:${key}`, AUDIT_WORKFLOW_ID, phaseIndex, {
      title,
      agentIndex,
      status,
      usage: { totalTokens: 12_000 + agentIndex * 4_100 },
      ...(status === "failed" ? { error: "Typecheck failed in AgentsDetail.tsx" } : {}),
      ...(status === "running" ? { progress: "Reviewing CrownWorkflowCard" } : {}),
      ...(status === "running" || status === "pending" || status === "waiting"
        ? {}
        : { completedAt: "2026-10-07T10:04:12.000Z" }),
    });
  };
  return [
    makeRuntimeAgent(AUDIT_WORKFLOW_ID, {
      kind: "workflow",
      title: "Audit the crown follow-ups",
      workflowName: "Audit",
      status: statuses.coordinator ?? "running",
      ...(statuses.coordinator && isTerminalSubagentStatus(statuses.coordinator)
        ? { completedAt: "2026-10-07T10:06:40.000Z" }
        : {}),
      phases: [
        { index: 0, title: "Work" },
        { index: 1, title: "Review" },
        { index: 2, title: "Verify" },
      ],
      firstSeenAt: AGENT_STARTED_AT,
    }),
    member("map", 0, 0, "work:map-details"),
    member("types", 0, 1, "work:types"),
    member("card", 1, 2, "review:card"),
    member("alerts", 1, 3, "review:alerts"),
  ];
}

/** Two direct spawns: Scout running, Docs writer completed. */
export function crownDirectAgents(
  statuses: { readonly scout?: RuntimeSubagentStatus; readonly docs?: RuntimeSubagentStatus } = {},
): RuntimeSubagent[] {
  return [
    makeRuntimeAgent("agent-scout", {
      title: "Scout",
      status: statuses.scout ?? "running",
      ...((statuses.scout ?? "running") === "running"
        ? { progress: "Reading crownAlerts.logic.ts" }
        : { result: "Mapped the alert rules", completedAt: "2026-10-07T10:05:10.000Z" }),
      usage: { totalTokens: 8_200 },
      firstSeenAt: "2026-10-07T10:01:00.000Z",
    }),
    makeRuntimeAgent("agent-docs", {
      title: "Docs writer",
      status: statuses.docs ?? "completed",
      result: "Updated the overview docs",
      usage: { totalTokens: 3_400 },
      firstSeenAt: "2026-10-07T10:02:00.000Z",
      completedAt: "2026-10-07T10:03:30.000Z",
    }),
  ];
}

/** The `wf-audit` run plus the two direct agents. */
export function crownAgentPanelFixture(): AgentPanelModel {
  return makeAgentPanelModel([...auditWorkflowAgents(), ...crownDirectAgents()]);
}

export function makePlan(
  steps: ReadonlyArray<[string, "pending" | "inProgress" | "completed"]>,
  turnId = "turn-1",
): NonNullable<OverviewLayoutProps["activePlan"]> {
  return {
    createdAt: "2026-10-07T10:00:00.000Z",
    turnId: TurnId.make(turnId),
    steps: steps.map(([step, status]) => ({ step, status })),
  };
}

export function makeLayout(overrides: Partial<OverviewLayoutProps> = {}): OverviewLayoutProps {
  return {
    activePlan: null,
    activeProposedPlan: null,
    environmentId: EnvironmentId.make("environment-local"),
    markdownCwd: undefined,
    workspaceRoot: undefined,
    ...overrides,
  };
}

export function makeSnapshot(overrides: Partial<CrownSnapshot> = {}): CrownSnapshot {
  return {
    scopeKey: "thread-1|/repo",
    turn: null,
    checks: null,
    pr: null,
    branch: { refName: "feature/crown", ahead: 0, behind: 0 },
    prSettled: true,
    plan: null,
    agents: { direct: {}, workflows: {} },
    fileCount: 0,
    notes: null,
    ...overrides,
  };
}

export function makeNoteView(id: string, overrides: Partial<NoteView> = {}): NoteView {
  return {
    id,
    body: `Note ${id}`,
    scope: "worktree",
    worktreeLabel: null,
    thread: { id: "thread-1", title: "Overview rail" },
    createdAt: "2026-10-07T10:00:00.000Z",
    ...overrides,
  };
}

/** A loaded, writable notes binding with no-op actions; pass `worktreeNotes` to fill it. */
export function makeNotesBinding(overrides: Partial<CrownNotesBinding> = {}): CrownNotesBinding {
  const worktreeNotes = overrides.worktreeNotes ?? [];
  const projectNotes = overrides.projectNotes ?? worktreeNotes;
  return {
    available: true,
    status: "ready",
    loaded: true,
    error: null,
    worktreeNotes,
    projectNotes,
    alertNotes: overrides.alertNotes ?? worktreeNotes,
    truncatedLimit: null,
    counts: { worktree: worktreeNotes.length, project: projectNotes.length },
    view: "worktree",
    setView: () => {},
    worktreeViewDisabledReason: null,
    notesFor: (view) => (view === "project" ? projectNotes : worktreeNotes),
    breadcrumb: { project: "ryco", worktree: "notes-panel" },
    threadTitle: "Overview rail",
    disabledReason: null,
    composerDisabledReason: null,
    ownNoteIds: new Set(),
    save: async () => "saved",
    toggleTodo: () => {},
    togglePin: () => {},
    remove: () => {},
    refresh: () => {},
    openThread: null,
    ...overrides,
  };
}

/** The prototype's sample pull request: four runs (pass, fail, running, pending). */
export const crownPullRequestFixture: OverviewPullRequestState = makePullRequest({
  number: 683,
  title: "Overview rail + worktree notes",
  url: "https://github.com/ryco/ryco/pull/683",
  isDraft: false,
  commentsCount: 3,
  reviewsApproved: 1,
  reviewsRequested: 2,
  mergeability: "mergeable",
  activeCheckCount: 2,
  latestRuns: [
    {
      id: "fmt",
      name: "Format",
      detail: "14s",
      statusLabel: "Succeeded",
      statusKind: "passed",
      tone: "success",
      url: "https://github.com/ryco/ryco/actions/runs/1",
    },
    {
      id: "types",
      name: "Typecheck",
      statusLabel: "Failed",
      statusKind: "failed",
      tone: "failure",
      url: "https://github.com/ryco/ryco/actions/runs/2",
    },
    {
      id: "test",
      name: "Unit tests",
      activeDetail: "Test / Run vitest",
      statusLabel: "Running",
      statusKind: "running",
      tone: "running",
    },
    {
      id: "browser",
      name: "Browser suite",
      statusLabel: "Pending",
      statusKind: "pending",
      tone: "pending",
    },
  ],
  runs: [],
});

/** The prototype's sample overview: a plan in progress, four changed files, the PR and the `wf-audit` run with two direct agents. */
export function crownLayoutFixture(
  overrides: Partial<OverviewLayoutProps> = {},
): OverviewLayoutProps {
  return makeLayout({
    activePlan: {
      createdAt: "2026-10-07T10:00:00.000Z",
      turnId: null,
      explanation: "Ship the crown rail on existing data.",
      steps: [
        { step: "Notes contract + storage", status: "completed" },
        { step: "NotesService over RPC", status: "completed" },
        { step: "Overview rail + flyouts", status: "inProgress" },
        { step: "Scope switcher", status: "pending" },
        { step: "Browser tests", status: "pending" },
      ],
    },
    activeProposedPlan: {
      id: OrchestrationProposedPlanId.make("plan-1"),
      createdAt: "2026-10-07T10:00:00.000Z",
      updatedAt: "2026-10-07T10:00:00.000Z",
      turnId: null,
      planMarkdown: "# Crown rail\n\n- Build the rail",
      implementedAt: null,
      implementationThreadId: null,
    },
    changes: makeChanges({
      files: [
        {
          path: "apps/web/src/components/PlanSidebar.tsx",
          insertions: 84,
          deletions: 31,
          category: "local",
          status: "M",
        },
        {
          path: "apps/web/src/components/overview/OverviewRail.tsx",
          insertions: 212,
          deletions: 0,
          category: "local",
          status: "A",
        },
        {
          path: "packages/contracts/src/notes.ts",
          insertions: 41,
          deletions: 0,
          category: "committed",
          status: "A",
        },
        {
          path: "apps/web/src/legacy.css",
          insertions: 0,
          deletions: 4,
          category: "committed",
          status: "D",
        },
      ],
      insertions: 337,
      deletions: 35,
      aheadCount: 2,
      behindCount: 1,
      hasUpstream: true,
    }),
    pullRequest: crownPullRequestFixture,
    agentPanelModel: crownAgentPanelFixture(),
    ...overrides,
  });
}

/**
 * An in-memory notes node for hook and component tests: it applies commands
 * like the server (idempotent creates, revision checks, newest first) and
 * records every call. `dropReplies` lands that many commands but loses their
 * replies, like a dropped connection.
 */
export function createFakeNotesNode(projectId: ProjectId) {
  const node = {
    notes: [] as WorktreeNote[],
    reads: 0,
    commands: [] as NotesCommand[],
    dropReplies: 0,
    clock: 0,
    /** Deleted ids: like the node's tombstones, a create reusing one conflicts. */
    deleted: new Set<string>(),
  };
  const snapshot = (): NotesSnapshot => ({
    projectId,
    notes: node.notes.map((note) => ({ ...note })),
    limit: 500,
    truncated: false,
  });
  const apply = (command: NotesCommand) => {
    const at = new Date(Date.UTC(2026, 9, 7, 10, 0, ++node.clock)).toISOString();
    const index = node.notes.findIndex((note) => note.noteId === command.noteId);
    if (command.kind === "create") {
      if (node.deleted.has(command.noteId))
        throw new NotesError({ reason: "conflict", message: "Note identifier is already in use." });
      if (index >= 0) return;
      node.notes.unshift({
        noteId: command.noteId,
        revision: 0,
        projectId: command.projectId,
        worktreeId: command.worktreeId,
        scope: command.scope,
        body: command.body.trim(),
        threadId: command.threadId,
        createdAt: at,
        updatedAt: at,
      });
      return;
    }
    const current = node.notes[index];
    if (!current) throw new NotesError({ reason: "not-found", message: "Note not found." });
    if (current.revision !== command.expectedRevision)
      throw new NotesError({ reason: "conflict", message: "The note changed." });
    if (command.kind === "delete") {
      node.notes.splice(index, 1);
      node.deleted.add(command.noteId);
      return;
    }
    node.notes[index] = {
      ...current,
      revision: current.revision + 1,
      updatedAt: at,
      ...(command.body !== undefined ? { body: command.body } : {}),
      ...(command.scope !== undefined ? { scope: command.scope } : {}),
    };
  };
  const api: NotesApi = {
    list: async () => {
      node.reads += 1;
      return snapshot();
    },
    command: async (command) => {
      node.commands.push(command);
      apply(command);
      if (node.dropReplies > 0) {
        node.dropReplies -= 1;
        throw new Error("socket closed");
      }
      return snapshot();
    },
  };
  /** Seeds a note; each seed is newer than the ones before it. */
  const seed = (noteId: string, overrides: Partial<WorktreeNote> = {}): WorktreeNote => {
    const at = new Date(Date.UTC(2026, 9, 7, 9, node.notes.length)).toISOString();
    const note: WorktreeNote = {
      noteId,
      revision: 0,
      projectId,
      worktreeId: null,
      scope: "worktree",
      body: noteId,
      threadId: null,
      createdAt: at,
      updatedAt: at,
      ...overrides,
    };
    node.notes.unshift(note);
    return note;
  };
  const reset = () => {
    node.notes = [];
    node.reads = 0;
    node.commands = [];
    node.dropReplies = 0;
    node.clock = 0;
    node.deleted = new Set();
  };
  return { node, api, seed, reset };
}
