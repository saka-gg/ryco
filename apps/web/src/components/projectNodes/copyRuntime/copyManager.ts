// FILE: copyManager.ts
// Purpose: Runs this client's cross-node project copies: starts, resumes,
//          retries, cancels and detaches them, keeps each copy's progress in a
//          small store (toasts, the copy dialog, the Projects page's Copies
//          block), persists the ids-only job records, shows the progress and
//          result toasts, reports Agent Control copies back to the node
//          their proposal lives on (until that node answers, after a reload
//          too), follows the clones and links the add-project dialog hands over
//          when it closes, and publishes the sidebar's badge of the checkouts
//          being copied. Upload progress reaches the store at most four times a
//          second, with its speed and time left; while an upload still needs
//          this window, closing it asks first (browsers). A copy the user
//          started whose upload stopped when Ryco closed is offered again
//          (toast, Copies block) through the copy dialog, which goes on with
//          its ids: its plan never reaches storage. Every run holds its copy's claim
//          (`projectCopyClaims`), so with the records shared between windows a
//          copy is run, resumed, cleaned up or reported by one window only.
// Layer: Web copy runtime, a module-level singleton loaded on demand. The
//        coordinator (`@ryco/client-runtime/projectCopy` run/plan) and the
//        node IO load with the first copy; reading the store and the records
//        does not load them.

import {
  createProjectCopyJobRecord,
  decodeProjectCopyJobRecords,
  projectCopyReportOwed,
  projectCopyResumeKind,
  reduceProjectCopyJobRecord,
  upsertProjectCopyJobRecord,
  type ProjectCopyCompletedProject,
  type ProjectCopyJobRecord,
  type ProjectCopyOutcome,
  type ProjectCopyProgress,
  type ProjectCopyRun,
  type ProjectCopyRunPlan,
} from "@ryco/client-runtime/projectCopy";
import {
  AGENT_CONTROL_CLIENT_EXECUTION_WARNINGS_MAX,
  AGENT_CONTROL_ERROR_MESSAGE_MAX_CHARS,
  AgentControlClientExecutorId,
  AgentControlProposalId,
  AgentControlRpcError,
  EnvironmentId,
  type AgentControlClientExecutionResult,
  type ProjectId,
  type ScopedProjectRef,
} from "@ryco/contracts";
import { scopedProjectKey } from "@ryco/client-runtime/scoped";
import type { ProjectImportId, ProjectImportSnapshot } from "@ryco/contracts/project-copy";
import { projectImportSetupOutcome } from "@ryco/shared/projectImportOutcome";
import * as Schema from "effect/Schema";
import { create } from "zustand";

import { readNodeCatalogSnapshot, subscribeNodeCatalog } from "../../../environments/nodeCatalog";
import { getLocalStorageItem, setLocalStorageItem } from "../../../hooks/useLocalStorage";
import { randomUUID } from "../../../lib/utils";
import { selectProjectByRef, useStore } from "../../../store";
import {
  PROJECT_COPY_RECORDS_STORAGE_KEY,
  PROJECT_COPY_STARTS_STORAGE_KEY,
} from "../projectCopyStorage";
import { isElectron } from "../../../env";
import { openCopyProject } from "../projectNodesDialogStore";
import { markProjectCopiesActive, publishProjectCopyBadges } from "../projectNodesShellActions";
import {
  agentControlReportRetryDelayMs,
  deliverAgentControlReport,
  type AgentControlReportBody,
  type AgentControlReportDelivery,
} from "@ryco/client-runtime/projectCopy/agentControlReports";
import {
  copyThroughput,
  nextCopyByteSamples,
  projectCopyPercent,
  projectCopyView,
  type ProjectCopyAction,
  type ProjectCopyByteSample,
  type ProjectCopyLabels,
  type ProjectCopyThroughput,
} from "@ryco/client-runtime/projectCopy/progressView";
import {
  dismissProjectCopyToast,
  showProjectCopyInterruptedToast,
  showProjectCopyProgressToast,
  showProjectCopyResultToast,
} from "./projectCopyToasts";
import {
  createProjectCopyClaims,
  type ProjectCopyClaim,
  type ProjectCopyClaims,
} from "./projectCopyClaims";
import type { WebProjectCopyIo } from "./webProjectCopyIo";

// ── Types ──

/**
 * A copy an Agent Control proposal asked for (`copyProjectToNode`): the
 * executor that accepted it, and the node the proposal lives on (the agent's
 * node), which gets the `started` / `completed` / `failed` reports.
 */
export interface ProjectCopyAgentControlContext {
  readonly environmentId: EnvironmentId;
  readonly proposalId: AgentControlProposalId;
  readonly executorId: AgentControlClientExecutorId;
}

export interface ProjectCopyEntry {
  readonly copyId: string;
  /** The project's name: the plan's, else the target import's once it reports. */
  readonly title: string | null;
  readonly sourceLabel: string | null;
  readonly targetLabel: string | null;
  readonly targetEnvironmentId: EnvironmentId;
  readonly progress: ProjectCopyProgress;
  /** The upload's speed and time left while it runs and moved long enough to tell. */
  readonly throughput: ProjectCopyThroughput | null;
  readonly record: ProjectCopyJobRecord;
  /** The new project once the copy completed. */
  readonly project: ProjectCopyCompletedProject | null;
  /** A run of this copy is live in this session. */
  readonly running: boolean;
  /** The progress toast is hidden ("Run in background"); how it ends still toasts. */
  readonly background: boolean;
  /**
   * The copy dialog shows this copy's progress and how it ends, so neither
   * toasts until the dialog hands it over (`showProjectCopyProgress`).
   */
  readonly inDialog: boolean;
  /** The plan is still in memory, so a failure's retry can run here. */
  readonly hasPlan: boolean;
  readonly agentControl: ProjectCopyAgentControlContext | null;
  /** How the toasts word it: a copy, a clone or a link. */
  readonly action: ProjectCopyAction;
  /** The checkout being copied, when known: the sidebar badges its project's row. */
  readonly sourceRef: ScopedProjectRef | null;
}

export interface ProjectCopyStoreState {
  /** This session's copies, live or ended, by copy id. */
  readonly entries: Readonly<Record<string, ProjectCopyEntry>>;
  /** The persisted job records (ids only), newest first, unfinished ones kept. */
  readonly records: ReadonlyArray<ProjectCopyJobRecord>;
}

export interface StartProjectCopyOptions {
  readonly plan: ProjectCopyRunPlan;
  readonly agentControl?: ProjectCopyAgentControlContext | null;
  /**
   * Show the progress toast right away (default). A dialog that shows the
   * progress itself passes false and calls `showProjectCopyProgress` when it
   * closes ("Run in background"); until then the copy's result does not toast
   * either.
   */
  readonly toast?: boolean;
  /** The checkout the copy starts from, when the plan does not name it (an old source). */
  readonly sourceRef?: ScopedProjectRef | null;
  /**
   * A stored copy whose upload stopped when Ryco closed: the copy goes on with
   * its ids and this plan (the copy dialog started it again).
   */
  readonly resume?: ProjectCopyJobRecord | null;
}

export interface RetryProjectCopyOptions {
  /** As in `StartProjectCopyOptions`: false while the copy dialog shows the retry. */
  readonly toast?: boolean;
}

export interface ManagedProjectCopy {
  readonly copyId: string;
  /**
   * Settles when the copy ends or is detached, and for an Agent Control copy
   * once the proposal's node answered its final report (which can take as long
   * as that node is unreachable); never rejects.
   */
  readonly done: Promise<ProjectCopyOutcome>;
}

/** Opens a new-thread draft in a project (registered by the dialogs' surface). */
export type ProjectCopyViewer = (projectRef: ScopedProjectRef) => Promise<void> | void;

// ── State ──

const StoredRecords = Schema.Unknown;

/** The stored records as they are now (another window may have written them); null when unreadable. */
function readStoredRecordsNow(): ReadonlyArray<ProjectCopyJobRecord> | null {
  try {
    return decodeProjectCopyJobRecords(
      getLocalStorageItem(PROJECT_COPY_RECORDS_STORAGE_KEY, StoredRecords),
    );
  } catch {
    return null;
  }
}

function readStoredRecords(): ReadonlyArray<ProjectCopyJobRecord> {
  return readStoredRecordsNow() ?? [];
}

function writeStoredRecords(records: ReadonlyArray<ProjectCopyJobRecord>): void {
  try {
    setLocalStorageItem(PROJECT_COPY_RECORDS_STORAGE_KEY, records, StoredRecords);
  } catch {
    // Best effort: a full or unavailable storage keeps the records for this session.
  }
}

export const useProjectCopyStore = create<ProjectCopyStoreState>()(() => ({
  entries: {},
  records: readStoredRecords(),
}));

/**
 * The records to change: as storage has them now, since other windows of a
 * direct or Desktop build write their own copies' records there too; this
 * window's when storage can't be read.
 */
function currentRecords(): ReadonlyArray<ProjectCopyJobRecord> {
  return readStoredRecordsNow() ?? useProjectCopyStore.getState().records;
}

function readRecord(copyId: string): ProjectCopyJobRecord | null {
  return currentRecords().find((record) => record.copyId === copyId) ?? null;
}

// Another window's changes show here too (the Copies block).
if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key !== null && event.key !== PROJECT_COPY_RECORDS_STORAGE_KEY) return;
    const records = readStoredRecordsNow();
    if (records !== null) useProjectCopyStore.setState({ records });
  });
}

// ── Claims ──

const RUNNING_HERE = "This copy is already running.";
const RUNNING_ELSEWHERE = "This copy is running in another Ryco window.";

let claims: ProjectCopyClaims = createProjectCopyClaims();
/** The claims this window holds, by key; each is released when its run ends. */
const heldClaims = new Map<string, ProjectCopyClaim>();

const copyClaimKey = (copyId: string) => `copy:${copyId}`;
const startClaimKey = (executorId: string) => `start:${executorId}`;

/** Claims `key` for this window; null when a run here or in another window holds it. */
async function claim(key: string): Promise<ProjectCopyClaim | null> {
  if (heldClaims.has(key)) return null;
  const claimed = await claims.tryClaim(key);
  if (claimed === null) return null;
  const held: ProjectCopyClaim = {
    release: () => {
      if (heldClaims.get(key) === held) heldClaims.delete(key);
      claimed.release();
    },
  };
  heldClaims.set(key, held);
  return held;
}

interface LiveCopy {
  readonly run: ProjectCopyRun;
  readonly io: WebProjectCopyIo;
}

/** Runs of this session, and the plans a retry needs (kept after a run ends). */
const live = new Map<string, LiveCopy>();
const plans = new Map<string, ProjectCopyRunPlan>();
let viewer: ProjectCopyViewer | null = null;
const viewerListeners = new Set<() => void>();

function patchEntry(copyId: string, patch: Partial<ProjectCopyEntry>): void {
  useProjectCopyStore.setState((state) => {
    const current = state.entries[copyId];
    if (!current) return state;
    return { entries: { ...state.entries, [copyId]: { ...current, ...patch } } };
  });
}

/** Saves one record into the stored list as it is now, so no other window's record is lost. */
function persistRecord(record: ProjectCopyJobRecord): void {
  const records = upsertProjectCopyJobRecord(currentRecords(), record, Date.now());
  useProjectCopyStore.setState({ records });
  writeStoredRecords(records);
}

function labelsOf(entry: ProjectCopyEntry): ProjectCopyLabels {
  return {
    title: entry.title,
    sourceLabel: entry.sourceLabel,
    targetLabel: entry.targetLabel,
    action: entry.action,
  };
}

/** A plan's wording: linking a checkout, cloning a remote with no source node, else a copy. */
function actionOfPlan(plan: ProjectCopyRunPlan | null): ProjectCopyAction {
  if (plan === null) return "copy";
  if (plan.choices.mode === "link") return "link";
  return plan.source.kind === "clone-only" && plan.source.label === null ? "clone" : "copy";
}

function sourceRefOf(record: ProjectCopyJobRecord): ScopedProjectRef | null {
  return record.sourceEnvironmentId !== null && record.sourceProjectId !== null
    ? { environmentId: record.sourceEnvironmentId, projectId: record.sourceProjectId }
    : null;
}

function nodeLabel(environmentId: EnvironmentId | null): string | null {
  if (environmentId === null) return null;
  return (
    readNodeCatalogSnapshot().nodes.find((node) => node.environmentId === environmentId)?.label ??
    null
  );
}

// ── Coordinator loading ──

type Coordinator = typeof import("@ryco/client-runtime/projectCopy");
type IoModule = typeof import("./webProjectCopyIo");

/**
 * Rebuilds an Agent Control copy's plan from its proposal after a reload, so
 * an upload the app closed during goes on; null when the proposal no longer
 * runs it (the copy then cleans up and reports `failed`).
 */
export type ProjectCopyPlanRebuilder = (
  record: ProjectCopyJobRecord,
  context: ProjectCopyAgentControlContext,
) => Promise<ProjectCopyRunPlan | null>;

/** What the manager needs from the coordinator and the node IO, loaded with the first copy. */
export interface ProjectCopyRuntime {
  readonly startProjectCopy: Coordinator["startProjectCopy"];
  readonly projectCopyPlanWithSendFiles: Coordinator["projectCopyPlanWithSendFiles"];
  readonly createIo: () => WebProjectCopyIo;
  readonly callNodeWithLease: IoModule["callNodeWithLease"];
  readonly callNodeToRead: IoModule["callNodeToRead"];
  /** The Agent Control executor's; without it a resumed upload has no plan. */
  readonly rebuildAgentControlPlan?: ProjectCopyPlanRebuilder;
}

let runtimeLoad: Promise<ProjectCopyRuntime> | null = null;

/** One load in flight; a failed one is tried again by the next copy. */
function loadRuntime(): Promise<ProjectCopyRuntime> {
  runtimeLoad ??= Promise.all([
    import("@ryco/client-runtime/projectCopy"),
    import("./webProjectCopyIo"),
  ]).then(
    ([coordinator, io]): ProjectCopyRuntime => ({
      startProjectCopy: coordinator.startProjectCopy,
      projectCopyPlanWithSendFiles: coordinator.projectCopyPlanWithSendFiles,
      createIo: () => io.createWebProjectCopyIo(),
      callNodeWithLease: io.callNodeWithLease,
      callNodeToRead: io.callNodeToRead,
      // Loaded only when a resumed Agent Control copy needs its plan back.
      rebuildAgentControlPlan: (record, context) =>
        import("../agentControlCopyExecutor").then((executor) =>
          executor.rebuildAgentControlCopyPlan(record, context),
        ),
    }),
    (error: unknown) => {
      runtimeLoad = null;
      throw error;
    },
  );
  return runtimeLoad;
}

// ── Toasts ──

function refreshToast(copyId: string): void {
  const entry = useProjectCopyStore.getState().entries[copyId];
  if (!entry || entry.background || !entry.running) return;
  showProjectCopyProgressToast(
    copyId,
    projectCopyView(entry.progress, labelsOf(entry), entry.throughput),
    {
      onBackground: () => runProjectCopyInBackground(copyId),
      onCancel: () => cancelProjectCopy(copyId),
    },
  );
}

function showResultToast(entry: ProjectCopyEntry): void {
  const view = projectCopyView(entry.progress, labelsOf(entry));
  if (view.kind === "progress") {
    // Detached: the import runs on; the Copies block keeps following it.
    dismissProjectCopyToast(entry.copyId);
    return;
  }
  showProjectCopyResultToast(entry.copyId, view, {
    onView: entry.project ? () => void viewCopiedProject(entry.copyId) : undefined,
    onRetry:
      view.retryLabel !== null && entry.agentControl === null
        ? () => void retryProjectCopy(entry.copyId)
        : undefined,
  });
}

// ── Agent Control reports ──

function boundedMessage(message: string): string | null {
  const trimmed = message.trim();
  return trimmed.length === 0 ? null : trimmed.slice(0, AGENT_CONTROL_ERROR_MESSAGE_MAX_CHARS);
}

const NOT_STARTED = "The copy did not start.";
const START_INTERRUPTED = "The app that approved this request closed before the copy started.";
const PROJECT_NOT_FOUND =
  "The copy finished, but its project could not be found on the destination.";

function isNodeOnline(environmentId: EnvironmentId): boolean {
  return readNodeCatalogSnapshot().nodes.some(
    (node) => node.environmentId === environmentId && node.presence === "online",
  );
}

/**
 * Waits before the next report attempt: the backoff, or less once the node
 * comes back online (a reconnect, a node that woke up).
 */
function waitToReportAgain(
  environmentId: EnvironmentId,
  attempt: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const wasOnline = isNodeOnline(environmentId);
    let finished = false;
    let unsubscribe: () => void = () => undefined;
    const done = () => {
      if (finished) return;
      finished = true;
      globalThis.clearTimeout(timer);
      unsubscribe();
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = globalThis.setTimeout(done, agentControlReportRetryDelayMs(attempt));
    signal?.addEventListener("abort", done, { once: true });
    const stop = subscribeNodeCatalog(() => {
      if (!wasOnline && isNodeOnline(environmentId)) done();
    });
    if (finished) stop();
    else unsubscribe = stop;
  });
}

/**
 * Sends one report to the node the proposal lives on until that node answers
 * it (or `signal` stops it). Repeating an outcome returns the node's receipt,
 * so a report sent again after a lost answer is safe. `scopeId` names the hold
 * on that node (the copy's id, or the executor's for a copy that never started).
 */
function deliverReport(
  scopeId: string,
  context: ProjectCopyAgentControlContext,
  build: () => Promise<AgentControlReportBody | null>,
  signal?: AbortSignal,
): Promise<AgentControlReportDelivery> {
  return deliverAgentControlReport({
    environmentId: context.environmentId,
    build,
    send: async (body) => {
      const { callNodeWithLease } = await loadRuntime();
      await callNodeWithLease(
        context.environmentId,
        (api) => {
          const send = api.agentControl?.reportClientExecution;
          if (!send) {
            throw new AgentControlRpcError({
              code: "unsupported",
              message: "This device can't take the copy's report.",
            });
          }
          return send({ proposalId: context.proposalId, executorId: context.executorId, ...body });
        },
        { copyId: scopeId },
      );
    },
    signal,
    waitToRetry: waitToReportAgain,
  });
}

/** One copy's reports: `started` until the final one replaces it, then the final one. */
interface CopyReports {
  /** The target accepted the import; repeated by a resumed run (it extends the node's deadline). */
  readonly started: (importId: ProjectImportId) => void;
  /** How the copy ended, until the node answers; marks the record reported then. */
  readonly final: (build: () => Promise<AgentControlReportBody | null>) => Promise<void>;
}

function copyReports(copyId: string, context: ProjectCopyAgentControlContext): CopyReports {
  let startedSent = false;
  let current: AbortController | null = null;
  const deliver = (build: () => Promise<AgentControlReportBody | null>) => {
    // A newer report replaces one still waiting to be tried again.
    current?.abort();
    const controller = new AbortController();
    current = controller;
    return deliverReport(copyId, context, build, controller.signal);
  };
  return {
    started: (importId) => {
      if (startedSent) return;
      startedSent = true;
      void deliver(async () => ({ outcome: "started", importId }));
    },
    final: async (build) => {
      if ((await deliver(build)) !== "stopped") markReported(copyId);
    },
  };
}

/** The node took (or refused for good) the copy's final report: nothing is owed any more. */
function markReported(copyId: string): void {
  const record = readRecord(copyId);
  if (record === null) return;
  const reported = reduceProjectCopyJobRecord(record, { type: "reported", at: Date.now() });
  if (reported === record) return;
  persistRecord(reported);
  patchEntry(copyId, { record: reported });
}

/** What a copy's final report is built from. */
interface FinalReportFacts {
  readonly project: ProjectCopyCompletedProject | null;
  readonly importSnapshot: ProjectImportSnapshot | null;
  /** Why it failed; null for a cancel, or when the reason is not known. */
  readonly errorMessage: string | null;
}

/** The project root on the target, for the report; the node's own project when the copy lost track. */
function completedWorkspaceRoot(facts: FinalReportFacts): string | null {
  const project = facts.project;
  if (!project) return null;
  return (
    project.workspaceRoot ??
    selectProjectByRef(useStore.getState(), {
      environmentId: project.environmentId,
      projectId: project.projectId,
    })?.cwd ??
    facts.importSnapshot?.destinationPath ??
    null
  );
}

function completedResult(facts: FinalReportFacts): AgentControlClientExecutionResult | null {
  const project = facts.project;
  const workspaceRoot = completedWorkspaceRoot(facts);
  if (!project || workspaceRoot === null) return null;
  return {
    targetEnvironmentId: project.environmentId,
    projectId: project.projectId,
    workspaceRoot,
    warnings: project.warnings
      .map(boundedMessage)
      .filter((warning): warning is string => warning !== null)
      .slice(0, AGENT_CONTROL_CLIENT_EXECUTION_WARNINGS_MAX),
    // How the target's setup went and its setup thread, so the agent learns them (absent when
    // the target's import could not be read).
    ...(facts.importSnapshot === null
      ? {}
      : {
          setup: projectImportSetupOutcome(facts.importSnapshot),
          followUpThreadId: facts.importSnapshot.followUpThreadId ?? null,
        }),
  };
}

/** The final report of a finished record: `completed` with where the project is, else `failed`. */
function finalReportBody(
  record: ProjectCopyJobRecord,
  facts: FinalReportFacts,
): AgentControlReportBody {
  const importId = record.importId;
  if (record.outcome === "completed") {
    const result = completedResult(facts);
    return result
      ? { outcome: "completed", importId, result }
      : { outcome: "failed", importId, error: PROJECT_NOT_FOUND };
  }
  const fallback = record.outcome === "cancelled" ? "The copy was cancelled." : "The copy failed.";
  return {
    outcome: "failed",
    importId,
    error: boundedMessage(facts.errorMessage ?? fallback) ?? fallback,
  };
}

/**
 * The final report a previous session finished but could not deliver, rebuilt
 * from the copy's import on its destination (the record keeps ids only). Null
 * while a completed copy's project can't be placed: its destination did not
 * answer and this client does not know the project either.
 */
async function rebuiltFinalReport(
  record: ProjectCopyJobRecord,
): Promise<AgentControlReportBody | null> {
  let reachable = true;
  let snapshot: ProjectImportSnapshot | null = null;
  try {
    const { callNodeToRead } = await loadRuntime();
    const listed = await callNodeToRead(
      record.targetEnvironmentId,
      async (api) => (await api.projects.listImports?.({})) ?? { imports: [] },
      { copyId: record.copyId },
    );
    snapshot = listed.imports.find((entry) => entry.importId === record.importId) ?? null;
  } catch {
    reachable = false;
  }
  const facts: FinalReportFacts = {
    project:
      record.outcome === "completed"
        ? {
            environmentId: record.targetEnvironmentId,
            projectId: snapshot?.projectId ?? record.projectId,
            workspaceRoot: null,
            warnings: snapshot?.warnings ?? [],
          }
        : null,
    importSnapshot: snapshot,
    errorMessage: snapshot?.error?.message ?? null,
  };
  if (record.outcome === "completed" && !reachable && completedResult(facts) === null) return null;
  return finalReportBody(record, facts);
}

// ── Progress ──

/** Upload ticks reach the store (the dialog, the toast, the badge) at most this often. */
export const PROJECT_COPY_PROGRESS_INTERVAL_MS = 250;

interface ProgressFeed {
  samples: ReadonlyArray<ProjectCopyByteSample>;
  lastAppliedAt: number;
  pending: ProjectCopyProgress | null;
  timer: ReturnType<typeof globalThis.setTimeout> | null;
}

const progressFeeds = new Map<string, ProgressFeed>();

function applyProgress(copyId: string, progress: ProjectCopyProgress, feed: ProgressFeed): void {
  feed.lastAppliedAt = Date.now();
  feed.pending = null;
  const entry = useProjectCopyStore.getState().entries[copyId];
  // A resumed copy learns its project's name from the target's import.
  const learnsTitle = entry !== undefined && entry.title === null && progress.importSnapshot;
  patchEntry(copyId, {
    progress,
    throughput:
      progress.phase === "upload" ? copyThroughput(feed.samples, progress.totalBytes) : null,
    ...(learnsTitle && progress.importSnapshot ? { title: progress.importSnapshot.title } : {}),
  });
  refreshToast(copyId);
}

/**
 * Takes one progress report: an upload tick after another is held back until
 * the interval passed (the latest one wins); anything else applies at once.
 */
function feedProgress(copyId: string, progress: ProjectCopyProgress): void {
  let feed = progressFeeds.get(copyId);
  if (!feed) {
    feed = { samples: [], lastAppliedAt: 0, pending: null, timer: null };
    progressFeeds.set(copyId, feed);
  }
  const now = Date.now();
  if (progress.phase === "upload" && progress.totalBytes > 0) {
    feed.samples = nextCopyByteSamples(feed.samples, { at: now, bytes: progress.uploadedBytes });
  } else {
    feed.samples = [];
  }
  const current = useProjectCopyStore.getState().entries[copyId]?.progress;
  const tick = progress.phase === "upload" && current?.phase === "upload";
  const wait = feed.lastAppliedAt + PROJECT_COPY_PROGRESS_INTERVAL_MS - now;
  if (!tick || wait <= 0) {
    if (feed.timer !== null) globalThis.clearTimeout(feed.timer);
    feed.timer = null;
    applyProgress(copyId, progress, feed);
    return;
  }
  feed.pending = progress;
  if (feed.timer !== null) return;
  const held = feed;
  held.timer = globalThis.setTimeout(() => {
    held.timer = null;
    if (held.pending !== null && progressFeeds.get(copyId) === held) {
      applyProgress(copyId, held.pending, held);
    }
  }, wait);
}

/** The copy ended: a held tick must not land after its outcome. */
function stopProgressFeed(copyId: string): void {
  const feed = progressFeeds.get(copyId);
  if (feed?.timer != null) globalThis.clearTimeout(feed.timer);
  progressFeeds.delete(copyId);
}

// ── Running ──

interface LaunchInput {
  readonly plan: ProjectCopyRunPlan | null;
  readonly resume?: ProjectCopyJobRecord | null;
  readonly restartOf?: ProjectCopyJobRecord | null;
  readonly agentControl: ProjectCopyAgentControlContext | null;
  readonly background: boolean;
  readonly inDialog: boolean;
  /** Overrides what the plan (or, without one, the target's import) says. */
  readonly title?: string | null;
  readonly action?: ProjectCopyAction;
  readonly sourceRef?: ScopedProjectRef | null;
  /**
   * The copy's claim, when the caller took it first (a resume reads the
   * record again once it holds it). The run releases it when it ends.
   */
  readonly claim?: ProjectCopyClaim | null;
}

/** Runs a copy under its claim: taken here unless the caller holds it, and held until it ends. */
async function launch(input: LaunchInput): Promise<ManagedProjectCopy> {
  let runtime: ProjectCopyRuntime;
  try {
    runtime = await loadRuntime();
  } catch (error) {
    input.claim?.release();
    throw error;
  }
  const io = runtime.createIo();
  // A new copy's id is minted here and claimed before its first record is
  // published, so no other window resumes a copy this one is starting.
  const copyId = (input.resume ?? input.restartOf)?.copyId ?? io.uuid();
  const claimed = input.claim ?? (live.has(copyId) ? null : await claim(copyClaimKey(copyId)));
  if (claimed === null) {
    io.dispose();
    throw new Error(live.has(copyId) ? RUNNING_HERE : RUNNING_ELSEWHERE);
  }
  try {
    return launchClaimed(input, runtime, io, copyId, claimed);
  } catch (error) {
    io.dispose();
    claimed.release();
    throw error;
  }
}

function launchClaimed(
  input: LaunchInput,
  runtime: ProjectCopyRuntime,
  io: WebProjectCopyIo,
  copyId: string,
  claimed: ProjectCopyClaim,
): ManagedProjectCopy {
  // The claim makes this a formality; nothing below yields until `live.set`.
  if (live.has(copyId)) throw new Error(RUNNING_HERE);
  markProjectCopiesActive();
  const { agentControl, plan } = input;
  const reports = agentControl ? copyReports(copyId, agentControl) : null;
  const reportStarted = (record: ProjectCopyJobRecord) => {
    if (reports && record.stage === "importing") reports.started(record.importId);
  };

  // The coordinator reports its first record and progress before it returns;
  // the entry is made from them once it did.
  const pending: { record: ProjectCopyJobRecord | null; entryReady: boolean } = {
    record: null,
    entryReady: false,
  };
  const onRecord = (record: ProjectCopyJobRecord) => {
    persistRecord(record);
    if (!pending.entryReady) {
      pending.record = record;
      return;
    }
    patchEntry(record.copyId, { record });
    reportStarted(record);
  };
  const onProgress = (progress: ProjectCopyProgress) => {
    if (!pending.entryReady) return;
    feedProgress(progress.copyId, progress);
  };

  const run = runtime.startProjectCopy({
    io,
    copyId,
    plan,
    resume: input.resume ?? null,
    restartOf: input.restartOf ?? null,
    agentControl,
    onProgress,
    onRecord,
  });
  const record = pending.record ?? input.resume ?? null;
  if (record === null || run.copyId !== copyId) {
    run.cancel();
    throw new Error("The copy did not start.");
  }
  const progress = run.getProgress();
  const entry: ProjectCopyEntry = {
    copyId,
    title: input.title ?? plan?.title ?? progress.importSnapshot?.title ?? null,
    sourceLabel: plan?.source.label ?? nodeLabel(record.sourceEnvironmentId),
    targetLabel: plan?.target.label ?? nodeLabel(record.targetEnvironmentId),
    targetEnvironmentId: record.targetEnvironmentId,
    progress,
    throughput: null,
    record,
    project: null,
    running: true,
    background: input.background,
    inDialog: input.inDialog,
    hasPlan: plan !== null,
    agentControl,
    action: input.action ?? actionOfPlan(plan),
    sourceRef: input.sourceRef ?? sourceRefOf(record),
  };
  useProjectCopyStore.setState((state) => ({ entries: { ...state.entries, [copyId]: entry } }));
  pending.entryReady = true;
  live.set(copyId, { run, io });
  if (plan) plans.set(copyId, plan);
  refreshToast(copyId);
  // A resumed copy whose import already runs reports `started` again: it is
  // idempotent and extends the node's deadline.
  reportStarted(record);

  const done = run.done
    .then((outcome) => finish(copyId, outcome, io, reports))
    .finally(() => claimed.release());
  return { copyId, done };
}

async function finish(
  copyId: string,
  outcome: ProjectCopyOutcome,
  io: WebProjectCopyIo,
  reports: CopyReports | null,
): Promise<ProjectCopyOutcome> {
  io.dispose();
  if (live.get(copyId)?.io === io) {
    live.delete(copyId);
    stopProgressFeed(copyId);
  }
  let record = outcome.record;
  // An Agent Control copy ends with its report: a failure is final there, so
  // the record is too and a reload does not run it again.
  if (
    reports &&
    record.stage !== "finished" &&
    (outcome.progress.phase === "failed" || outcome.progress.phase === "cancelled")
  ) {
    record = reduceProjectCopyJobRecord(record, {
      type: "finished",
      outcome: outcome.progress.phase === "failed" ? "failed" : "cancelled",
      at: Date.now(),
    });
  }
  // Persisted (still owing its report) before the report goes out, so a
  // reload sends it if this session can't.
  persistRecord(record);
  patchEntry(copyId, {
    progress: outcome.progress,
    throughput: null,
    record,
    project: outcome.project,
    running: false,
  });
  const entry = useProjectCopyStore.getState().entries[copyId];
  // The copy dialog shows how it ended itself.
  if (entry && !entry.inDialog) showResultToast(entry);
  // Detached copies are left unfinished: the import runs on and a later follow reports it.
  if (reports && record.stage === "finished") {
    const finished = record;
    const facts: FinalReportFacts = {
      project: outcome.project,
      importSnapshot: outcome.progress.importSnapshot,
      errorMessage:
        outcome.progress.phase === "failed" ? (outcome.progress.error?.message ?? null) : null,
    };
    await reports.final(async () => finalReportBody(finished, facts));
    record = readRecord(copyId) ?? record;
  }
  return { ...outcome, record };
}

// ── Public API ──

/** Starts a copy from a plan the copy dialog or the Agent Control executor built. */
export function startManagedProjectCopy(
  options: StartProjectCopyOptions,
): Promise<ManagedProjectCopy> {
  return launch({
    plan: options.plan,
    resume: options.resume ?? null,
    agentControl: options.agentControl ?? null,
    background: options.toast === false,
    inDialog: options.toast === false,
    sourceRef: options.sourceRef ?? null,
  });
}

/** A clone or link the add-project dialog started on one node, handed over when the dialog closes. */
export interface TrackProjectImportInput {
  readonly environmentId: EnvironmentId;
  readonly importId: ProjectImportId;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly action: Exclude<ProjectCopyAction, "copy">;
  /** The project a link registers a checkout of (its sidebar row gets the badge). */
  readonly sourceRef?: ScopedProjectRef | null;
}

/**
 * Follows an import the node accepted after the add-project dialog that
 * started it closed: its progress toast, how it ends ("X is ready on Y ·
 * View"), the Copies block and a reload pick it up like a copy whose upload
 * finished. Nothing runs here but following it.
 */
export async function trackProjectImport(
  input: TrackProjectImportInput,
): Promise<ManagedProjectCopy> {
  const copyId = randomUUID();
  // Claimed before its record is stored: no other window takes over a fresh id.
  const claimed = await claim(copyClaimKey(copyId));
  if (claimed === null) throw new Error(RUNNING_ELSEWHERE);
  const at = Date.now();
  const record = reduceProjectCopyJobRecord(
    createProjectCopyJobRecord({
      copyId,
      at,
      sourceEnvironmentId: null,
      sourceProjectId: null,
      targetEnvironmentId: input.environmentId,
      projectId: input.projectId,
      importId: input.importId,
    }),
    { type: "import-accepted", at },
  );
  persistRecord(record);
  return launch({
    plan: null,
    resume: record,
    agentControl: null,
    background: false,
    inDialog: false,
    title: input.title,
    action: input.action,
    sourceRef: input.sourceRef ?? null,
    claim: claimed,
  });
}

/** Before the import started: stops and cleans up. After: asks the destination to cancel it. */
export function cancelProjectCopy(copyId: string): void {
  live.get(copyId)?.run.cancel();
}

/**
 * Stops following a copy whose import runs on the destination by itself (the
 * Copies block can follow it again). Before the import was accepted the copy
 * still needs this client; it detaches once it was.
 */
export function detachProjectCopy(copyId: string): void {
  live.get(copyId)?.run.detach();
}

/** Hides the copy's progress toast; how it ends still toasts. */
export function runProjectCopyInBackground(copyId: string): void {
  patchEntry(copyId, { background: true });
  dismissProjectCopyToast(copyId);
}

/**
 * Hands a copy the dialog showed over to the toasts (the dialog closed): its
 * progress toast while it runs, else how it ended.
 */
export function showProjectCopyProgress(copyId: string): void {
  const entry = useProjectCopyStore.getState().entries[copyId];
  if (!entry) return;
  patchEntry(copyId, { background: false, inDialog: false });
  if (entry.running) refreshToast(copyId);
}

/**
 * Runs a failed copy's retry (`progress.error.retry`): `send-files` starts the
 * same copy over with the files sent instead of cloned, `resume` picks it up
 * with its ids. Null when there is nothing to retry here (no plan, or running).
 */
export async function retryProjectCopy(
  copyId: string,
  options: RetryProjectCopyOptions = {},
): Promise<ManagedProjectCopy | null> {
  const entry = useProjectCopyStore.getState().entries[copyId];
  if (!entry || entry.running) return null;
  const plan = plans.get(copyId) ?? null;
  const retry = entry.progress.error?.retry ?? null;
  const inDialog = options.toast === false;
  if (retry === "send-files") {
    if (!plan) return null;
    const sendFiles = (await loadRuntime()).projectCopyPlanWithSendFiles(plan);
    if (!sendFiles) return null;
    return launch({
      plan: sendFiles,
      restartOf: entry.record,
      agentControl: entry.agentControl,
      background: inDialog,
      inDialog,
      sourceRef: entry.sourceRef,
    });
  }
  if (retry === "resume") {
    return launch({
      plan,
      resume: entry.record,
      agentControl: entry.agentControl,
      background: inDialog,
      inDialog,
      title: entry.title,
      action: entry.action,
      sourceRef: entry.sourceRef,
    });
  }
  return null;
}

/**
 * Follows (or, with its plan, continues) a copy from its stored record: the
 * Copies block's Resume. Fails when another window runs it.
 */
export async function resumeProjectCopy(copyId: string): Promise<ManagedProjectCopy | null> {
  if (live.has(copyId)) return null;
  const claimed = await claim(copyClaimKey(copyId));
  if (claimed === null) {
    if (live.has(copyId)) return null;
    throw new Error(RUNNING_ELSEWHERE);
  }
  return resumeClaimed(copyId, claimed);
}

/**
 * Picks a claimed copy up from its record as storage has it now (another
 * window may have moved it on before letting go): continues or follows it, or
 * delivers the final report it still owes. Null when nothing was launched.
 */
async function resumeClaimed(
  copyId: string,
  claimed: ProjectCopyClaim,
): Promise<ManagedProjectCopy | null> {
  let handedOver = false;
  try {
    const record = readRecord(copyId);
    if (record === null || live.has(copyId)) return null;
    const agentControl = agentControlOf(record);
    if (projectCopyResumeKind(record) !== "none") {
      const plan = await planForResume(record, agentControl);
      handedOver = true;
      return await launch({
        plan,
        resume: record,
        agentControl,
        background: true,
        inDialog: false,
        claim: claimed,
      });
    }
    if (agentControl !== null && projectCopyReportOwed(record)) {
      await copyReports(copyId, agentControl).final(() => rebuiltFinalReport(record));
    }
    return null;
  } finally {
    if (!handedOver) claimed.release();
  }
}

/**
 * The plan a resumed copy goes on with: the one still in memory, else, for an
 * Agent Control copy that needs one (its upload or its import request did not
 * finish), the plan rebuilt from its proposal while that proposal still runs
 * it. Null otherwise: the copy then follows an import that started, or cleans
 * up and fails (reported to Agent Control).
 */
async function planForResume(
  record: ProjectCopyJobRecord,
  agentControl: ProjectCopyAgentControlContext | null,
): Promise<ProjectCopyRunPlan | null> {
  const known = plans.get(record.copyId);
  if (known) return known;
  const needsPlan =
    projectCopyResumeKind(record) === "continue" || record.stage === "import-requested";
  if (agentControl === null || !needsPlan) return null;
  try {
    const rebuild = (await loadRuntime()).rebuildAgentControlPlan;
    return rebuild ? await rebuild(record, agentControl) : null;
  } catch (error) {
    console.warn("Rebuilding an Agent Control copy's plan failed.", error);
    return null;
  }
}

/**
 * Drops a copy's record and entry (the Copies block's dismiss). A copy running
 * here or in another window is kept; one whose report this window still
 * delivers is dropped while the delivery goes on from memory.
 */
export function forgetProjectCopy(copyId: string): void {
  if (live.has(copyId)) return;
  const drop = () => {
    plans.delete(copyId);
    dismissProjectCopyToast(copyId);
    const records = currentRecords().filter((record) => record.copyId !== copyId);
    useProjectCopyStore.setState((state) => {
      const { [copyId]: _forgotten, ...entries } = state.entries;
      return { entries, records };
    });
    writeStoredRecords(records);
  };
  if (heldClaims.has(copyClaimKey(copyId))) {
    drop();
    return;
  }
  void claim(copyClaimKey(copyId)).then((claimed) => {
    // Another window runs or reports it.
    if (claimed === null) return;
    try {
      drop();
    } finally {
      claimed.release();
    }
  });
}

// ── Agent Control approvals ──

/**
 * An approval of an Agent Control copy from just before its accept until its
 * copy runs (whose own record reports from then on). From the accept on, the
 * node may run the proposal for this client's executor, so every way out ends
 * it: the copy starts, the node refused the accept, or `reportNotStarted`.
 */
export interface AgentControlCopyStartHold {
  /** The copy started (its record carries the executor now), or nothing was bound to it. */
  readonly release: () => void;
  /**
   * The node may run the proposal for this executor, but its copy can't start:
   * reports it `failed` until the node answers, then lets go. Returns at once.
   */
  readonly reportNotStarted: (message: string) => void;
}

const StoredStart = Schema.Struct({
  environmentId: EnvironmentId,
  proposalId: AgentControlProposalId,
  executorId: AgentControlClientExecutorId,
  createdAt: Schema.Number,
});
type StoredStart = typeof StoredStart.Type;
const isStoredStart = Schema.is(StoredStart);
const StoredStarts = Schema.Unknown;

/** Past a day the proposal's deadline is long gone; such a start is dropped unreported. */
const START_TTL_MS = 24 * 60 * 60 * 1000;

function readStoredStarts(): ReadonlyArray<StoredStart> {
  try {
    const stored = getLocalStorageItem(PROJECT_COPY_STARTS_STORAGE_KEY, StoredStarts);
    return Array.isArray(stored) ? stored.filter(isStoredStart) : [];
  } catch {
    return [];
  }
}

function writeStoredStarts(starts: ReadonlyArray<StoredStart>): void {
  try {
    setLocalStorageItem(PROJECT_COPY_STARTS_STORAGE_KEY, starts, StoredStarts);
  } catch {
    // Best effort: this session still settles it.
  }
}

function forgetStoredStart(executorId: string): void {
  const starts = readStoredStarts();
  const kept = starts.filter((entry) => entry.executorId !== executorId);
  if (kept.length !== starts.length) writeStoredStarts(kept);
}

/**
 * Holds an approval before its accept goes out: its ids (only) are stored and
 * claimed for this window, so a reload, or another window's start, still ends
 * a proposal this executor may have been bound to.
 */
export async function holdAgentControlCopyStart(
  context: ProjectCopyAgentControlContext,
): Promise<AgentControlCopyStartHold> {
  // A fresh executor id: no other approval holds it.
  const claimed = await claim(startClaimKey(context.executorId));
  const now = Date.now();
  writeStoredStarts([
    ...readStoredStarts().filter(
      (entry) => entry.executorId !== context.executorId && now - entry.createdAt <= START_TTL_MS,
    ),
    {
      environmentId: context.environmentId,
      proposalId: context.proposalId,
      executorId: context.executorId,
      createdAt: now,
    },
  ]);
  let settled = false;
  const settle = () => {
    if (settled) return;
    settled = true;
    forgetStoredStart(context.executorId);
    claimed?.release();
  };
  return {
    release: settle,
    reportNotStarted: (message) => {
      if (settled) return;
      void deliverReport(context.executorId, context, async () => ({
        outcome: "failed",
        error: boundedMessage(message) ?? NOT_STARTED,
      })).then(settle, settle);
    },
  };
}

/**
 * At app start: an approval a previous session (or a closed window) held when
 * it ended. Its copy started when a record carries its executor; otherwise the
 * proposal is reported `failed` (a node that never bound it refuses that).
 */
async function settleInterruptedStart(start: StoredStart): Promise<void> {
  if (Date.now() - start.createdAt > START_TTL_MS) {
    forgetStoredStart(start.executorId);
    return;
  }
  if (!(await waitForNodes([start.environmentId]))) return;
  // A window still approving it holds its claim.
  const claimed = await claim(startClaimKey(start.executorId));
  if (claimed === null) return;
  try {
    if (!readStoredStarts().some((entry) => entry.executorId === start.executorId)) return;
    const started = currentRecords().some(
      (record) => record.agentControl?.executorId === start.executorId,
    );
    if (!started) {
      await deliverReport(start.executorId, start, async () => ({
        outcome: "failed",
        error: START_INTERRUPTED,
      }));
    }
    forgetStoredStart(start.executorId);
  } finally {
    claimed.release();
  }
}

function agentControlOf(record: ProjectCopyJobRecord): ProjectCopyAgentControlContext | null {
  const context = record.agentControl;
  return context
    ? {
        environmentId: context.environmentId,
        // Decoded from the record; the node checks them again.
        proposalId: context.proposalId as AgentControlProposalId,
        executorId: context.executorId as AgentControlClientExecutorId,
      }
    : null;
}

/** How long app start waits for a record's nodes to appear in the catalog. */
const RESUME_CATALOG_WAIT_MS = 60_000;

function waitForNodes(environmentIds: ReadonlyArray<EnvironmentId>): Promise<boolean> {
  const known = () => {
    const nodes = readNodeCatalogSnapshot().nodes;
    return environmentIds.every((id) => nodes.some((node) => node.environmentId === id));
  };
  if (known()) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = globalThis.setTimeout(() => {
      unsubscribe();
      resolve(known());
    }, RESUME_CATALOG_WAIT_MS);
    const unsubscribe = subscribeNodeCatalog(() => {
      if (!known()) return;
      globalThis.clearTimeout(timer);
      unsubscribe();
      resolve(true);
    });
  });
}

let resumedAtStart = false;

/**
 * At app start, once a record's nodes are known here: picks up every
 * unfinished copy no other window runs. An import that already started is
 * followed to its end (and an Agent Control copy reports how it ended). An
 * upload the app closed during goes on when an Agent Control copy's plan can be
 * rebuilt from its proposal (still `executing`), and otherwise cleans up and
 * fails; a user's copy keeps what it sent and is offered again instead
 * (`projectCopyResumesInDialog`). A final report a previous session could not
 * deliver is sent, and an approval it left between accept and copy ends its
 * proposal. Runs once.
 */
export async function resumeProjectCopies(): Promise<void> {
  if (resumedAtStart) return;
  resumedAtStart = true;
  const records = readStoredRecords();
  useProjectCopyStore.setState({ records });
  await Promise.all([
    ...records
      .filter(
        (record) =>
          !live.has(record.copyId) &&
          (projectCopyResumeKind(record) !== "none" || projectCopyReportOwed(record)),
      )
      .map(resumeAtStart),
    ...readStoredStarts().map((start) =>
      settleInterruptedStart(start).catch((error: unknown) => {
        console.warn("Settling an interrupted Agent Control approval failed.", error);
      }),
    ),
  ]);
}

async function resumeAtStart(stale: ProjectCopyJobRecord): Promise<void> {
  if (projectCopyResumesInDialog(stale)) {
    // Its destination's name, once the catalog knows it (it offers either way).
    await waitForNodes([stale.targetEnvironmentId]);
    await offerInterruptedCopy(stale);
    return;
  }
  try {
    const agentControl = agentControlOf(stale);
    const nodes = [stale.targetEnvironmentId];
    if (stale.sourceEnvironmentId !== null && projectCopyResumeKind(stale) !== "none") {
      nodes.push(stale.sourceEnvironmentId);
    }
    if (agentControl !== null) nodes.push(agentControl.environmentId);
    if (!(await waitForNodes(nodes))) return;
    // A window that runs (or reports) it holds its claim: it stays that window's.
    const claimed = await claim(copyClaimKey(stale.copyId));
    if (claimed === null) return;
    await resumeClaimed(stale.copyId, claimed);
  } catch (error) {
    console.warn("Resuming a project copy failed.", error);
  }
}

// ── Copies the user started that stopped during the upload ──

/**
 * A copy the user started whose upload (or export) stopped when Ryco closed,
 * with no plan in memory: its folder, setup command and options never reach
 * storage, so it goes on through the copy dialog (`openInterruptedProjectCopy`),
 * which starts it again with its ids. An Agent Control copy rebuilds its plan
 * from its proposal instead.
 */
export function projectCopyResumesInDialog(record: ProjectCopyJobRecord): boolean {
  return (
    record.agentControl === null &&
    projectCopyResumeKind(record) === "continue" &&
    record.sourceEnvironmentId !== null &&
    record.sourceProjectId !== null &&
    !plans.has(record.copyId) &&
    !live.has(record.copyId)
  );
}

/** The stored record of a copy, as storage has it now. */
export function readProjectCopyRecord(copyId: string): ProjectCopyJobRecord | null {
  return readRecord(copyId);
}

/** The project a record copies, by its source checkout, when this client knows it. */
function recordTitle(record: ProjectCopyJobRecord): string | null {
  const ref = sourceRefOf(record);
  return ref ? (selectProjectByRef(useStore.getState(), ref)?.name ?? null) : null;
}

/** Opens the copy dialog on a stopped copy, prefilled with its checkout and destination. */
export function openInterruptedProjectCopy(copyId: string): void {
  const record = readRecord(copyId);
  const source = record ? sourceRefOf(record) : null;
  if (record === null || source === null) return;
  dismissProjectCopyToast(copyId);
  openCopyProject({
    source,
    targetEnvironmentId: record.targetEnvironmentId,
    origin: "projects-page",
    resumeCopyId: copyId,
  });
}

/** Says, once per app start, that a copy stopped and can go on (no other window runs it). */
async function offerInterruptedCopy(record: ProjectCopyJobRecord): Promise<void> {
  try {
    const claimed = await claim(copyClaimKey(record.copyId));
    if (claimed === null) return;
    claimed.release();
    const title = recordTitle(record);
    const target = nodeLabel(record.targetEnvironmentId) ?? "the destination";
    // The dialogs' surface hosts the dialog the toast's Resume opens.
    markProjectCopiesActive();
    showProjectCopyInterruptedToast(
      record.copyId,
      {
        title: title ? `Copying ${title} to ${target} stopped` : `A copy to ${target} stopped`,
        description: "Ryco closed during the upload. Resume sends the rest.",
      },
      {
        onResume: () => openInterruptedProjectCopy(record.copyId),
        onDiscard: () => discardProjectCopy(record.copyId),
      },
    );
  } catch (error) {
    console.warn("Offering a stopped project copy failed.", error);
  }
}

/**
 * Gives up a stopped copy: removes what it sent to the destination and left
 * on the source (the run without a plan cleans up), then forgets it.
 */
export function discardProjectCopy(copyId: string): void {
  dismissProjectCopyToast(copyId);
  const record = readRecord(copyId);
  if (record === null || live.has(copyId) || projectCopyResumeKind(record) === "none") {
    forgetProjectCopy(copyId);
    return;
  }
  void launch({
    plan: null,
    resume: record,
    agentControl: null,
    background: true,
    // Its end is no news: nothing toasts, and the sidebar shows no badge for it.
    inDialog: true,
  })
    .then((managed) => managed.done)
    .then(
      () => forgetProjectCopy(copyId),
      (error: unknown) => console.warn("Discarding a stopped project copy failed.", error),
    );
}

// ── Closing the window during an upload ──

/** Whether a copy running here still needs this window (its upload, A22). */
function needsThisWindow(entries: Readonly<Record<string, ProjectCopyEntry>>): boolean {
  return Object.values(entries).some((entry) => entry.running && !entry.progress.canCloseClient);
}

const confirmLeavingDuringUpload = (event: BeforeUnloadEvent) => {
  event.preventDefault();
  event.returnValue = "";
};
let leaveGuardInstalled = false;

/**
 * Asks before the browser closes or reloads the tab while an upload needs it.
 * Desktop windows are left alone: Electron would cancel the close without
 * asking, and the copy is offered again on the next start anyway.
 */
function syncLeaveGuard(entries: Readonly<Record<string, ProjectCopyEntry>>): void {
  if (typeof window === "undefined" || isElectron) return;
  const wanted = needsThisWindow(entries);
  if (wanted === leaveGuardInstalled) return;
  leaveGuardInstalled = wanted;
  if (wanted) window.addEventListener("beforeunload", confirmLeavingDuringUpload);
  else window.removeEventListener("beforeunload", confirmLeavingDuringUpload);
}

// ── View ──

/** The dialogs' surface registers how to open a draft in a project; the latest wins. */
export function registerProjectCopyViewer(next: ProjectCopyViewer): () => void {
  viewer = next;
  for (const listener of Array.from(viewerListeners)) listener();
  return () => {
    if (viewer === next) viewer = null;
  };
}

const VIEWER_WAIT_MS = 5_000;

function awaitViewer(): Promise<ProjectCopyViewer | null> {
  if (viewer) return Promise.resolve(viewer);
  // Copies keep the dialogs' surface mounted; it registers once its chunk loads.
  markProjectCopiesActive();
  return new Promise((resolve) => {
    const done = () => {
      globalThis.clearTimeout(timer);
      viewerListeners.delete(done);
      resolve(viewer);
    };
    const timer = globalThis.setTimeout(done, VIEWER_WAIT_MS);
    viewerListeners.add(done);
  });
}

/** "View": opens a new-thread draft in the copied project on its destination. */
export async function viewCopiedProject(copyId: string): Promise<void> {
  const project = useProjectCopyStore.getState().entries[copyId]?.project;
  if (!project) return;
  dismissProjectCopyToast(copyId);
  const open = await awaitViewer();
  if (!open) return;
  await open({ environmentId: project.environmentId, projectId: project.projectId });
}

// ── Sidebar badge ──

/** The running copies the dialog does not show, by the checkout they copy. */
function copyBadgesOf(
  entries: Readonly<Record<string, ProjectCopyEntry>>,
): Readonly<Record<string, number | null>> {
  const badges: Record<string, number | null> = {};
  for (const entry of Object.values(entries)) {
    if (!entry.running || entry.inDialog || entry.sourceRef === null) continue;
    badges[scopedProjectKey(entry.sourceRef)] = projectCopyPercent(entry.progress);
  }
  return badges;
}

useProjectCopyStore.subscribe((state, previous) => {
  if (state.entries === previous.entries) return;
  publishProjectCopyBadges(copyBadgesOf(state.entries));
  syncLeaveGuard(state.entries);
});

// ── Reading ──

export function readProjectCopyEntry(copyId: string): ProjectCopyEntry | null {
  return useProjectCopyStore.getState().entries[copyId] ?? null;
}

export function useProjectCopyEntry(copyId: string | null): ProjectCopyEntry | null {
  return useProjectCopyStore((state) => (copyId ? (state.entries[copyId] ?? null) : null));
}

export function useProjectCopyEntries(): Readonly<Record<string, ProjectCopyEntry>> {
  return useProjectCopyStore((state) => state.entries);
}

export function useProjectCopyRecords(): ReadonlyArray<ProjectCopyJobRecord> {
  return useProjectCopyStore((state) => state.records);
}

/** Test-only: runs copies through `runtime` instead of loading the coordinator. */
export function setProjectCopyRuntimeForTests(runtime: ProjectCopyRuntime | null): void {
  runtimeLoad = runtime ? Promise.resolve(runtime) : null;
}

/** Test-only: claims copies through `next` (one with another window's claims, say). */
export function setProjectCopyClaimsForTests(next: ProjectCopyClaims | null): void {
  claims = next ?? createProjectCopyClaims();
}

/** Test-only: no copies, no records, nothing registered. */
export function resetProjectCopyManagerForTests(): void {
  for (const copy of live.values()) copy.io.dispose();
  live.clear();
  for (const copyId of Array.from(progressFeeds.keys())) stopProgressFeed(copyId);
  for (const held of Array.from(heldClaims.values())) held.release();
  plans.clear();
  viewer = null;
  viewerListeners.clear();
  resumedAtStart = false;
  useProjectCopyStore.setState({ entries: {}, records: [] });
}
