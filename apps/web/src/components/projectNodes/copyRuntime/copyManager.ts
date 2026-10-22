// FILE: copyManager.ts
// Purpose: Runs this client's cross-node project copies: starts, resumes,
//          retries, cancels and detaches them, keeps each copy's progress in a
//          small store (toasts, the copy dialog, the Projects page's Copies
//          block), persists the ids-only job records, shows the progress and
//          result toasts, and reports Agent Control copies back to the node
//          their proposal lives on.
// Layer: Web copy runtime, a module-level singleton loaded on demand. The
//        coordinator (`@ryco/client-runtime/projectCopy` run/plan) and the
//        node IO load with the first copy; reading the store and the records
//        does not load them.

import {
  decodeProjectCopyJobRecords,
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
  type AgentControlClientExecutionResult,
  type AgentControlClientExecutorId,
  type AgentControlProposalId,
  type AgentControlReportClientExecutionInput,
  type EnvironmentId,
  type ScopedProjectRef,
} from "@ryco/contracts";
import * as Schema from "effect/Schema";
import { create } from "zustand";

import { readNodeCatalogSnapshot, subscribeNodeCatalog } from "../../../environments/nodeCatalog";
import { getLocalStorageItem, setLocalStorageItem } from "../../../hooks/useLocalStorage";
import { randomUUID } from "../../../lib/utils";
import { selectProjectByRef, useStore } from "../../../store";
import {
  markProjectCopiesActive,
  PROJECT_COPY_RECORDS_STORAGE_KEY,
} from "../projectNodesDialogStore";
import { projectCopyView, type ProjectCopyLabels } from "./projectCopyProgress.logic";
import {
  dismissProjectCopyToast,
  showProjectCopyProgressToast,
  showProjectCopyResultToast,
} from "./projectCopyToasts";
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
}

export interface RetryProjectCopyOptions {
  /** As in `StartProjectCopyOptions`: false while the copy dialog shows the retry. */
  readonly toast?: boolean;
}

export interface ManagedProjectCopy {
  readonly copyId: string;
  /**
   * Settles when the copy ends or is detached, after an Agent Control copy's
   * report went out (or gave up); never rejects.
   */
  readonly done: Promise<ProjectCopyOutcome>;
}

/** Opens a new-thread draft in a project (registered by the dialogs' surface). */
export type ProjectCopyViewer = (projectRef: ScopedProjectRef) => Promise<void> | void;

// ── State ──

const StoredRecords = Schema.Unknown;

function readStoredRecords(): ReadonlyArray<ProjectCopyJobRecord> {
  try {
    return decodeProjectCopyJobRecords(
      getLocalStorageItem(PROJECT_COPY_RECORDS_STORAGE_KEY, StoredRecords),
    );
  } catch {
    return [];
  }
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

function persistRecord(record: ProjectCopyJobRecord): void {
  const records = upsertProjectCopyJobRecord(
    useProjectCopyStore.getState().records,
    record,
    Date.now(),
  );
  useProjectCopyStore.setState({ records });
  writeStoredRecords(records);
}

function labelsOf(entry: ProjectCopyEntry): ProjectCopyLabels {
  return { title: entry.title, sourceLabel: entry.sourceLabel, targetLabel: entry.targetLabel };
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
  showProjectCopyProgressToast(copyId, projectCopyView(entry.progress, labelsOf(entry)), {
    onBackground: () => runProjectCopyInBackground(copyId),
    onCancel: () => cancelProjectCopy(copyId),
  });
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

const REPORT_ATTEMPTS = 5;
const REPORT_RETRY_BASE_MS = 2_000;

function boundedMessage(message: string): string | null {
  const trimmed = message.trim();
  return trimmed.length === 0 ? null : trimmed.slice(0, AGENT_CONTROL_ERROR_MESSAGE_MAX_CHARS);
}

/**
 * Reports to the node the proposal lives on. Repeating an outcome returns the
 * node's receipt, so a report retried after a dropped answer is safe.
 */
async function reportToAgentControl(
  copyId: string,
  context: ProjectCopyAgentControlContext,
  report: Omit<AgentControlReportClientExecutionInput, "proposalId" | "executorId">,
): Promise<void> {
  const { callNodeWithLease } = await loadRuntime();
  const input: AgentControlReportClientExecutionInput = {
    proposalId: context.proposalId,
    executorId: context.executorId,
    ...report,
  };
  for (let attempt = 1; ; attempt += 1) {
    try {
      await callNodeWithLease(
        context.environmentId,
        (api) => {
          const send = api.agentControl?.reportClientExecution;
          if (!send) throw new Error("This device can't take the copy's report.");
          return send(input);
        },
        { copyId },
      );
      return;
    } catch (error) {
      if (attempt >= REPORT_ATTEMPTS) {
        console.warn("Reporting a copy to Agent Control failed.", error);
        return;
      }
      await new Promise((resolve) =>
        globalThis.setTimeout(resolve, REPORT_RETRY_BASE_MS * 2 ** (attempt - 1)),
      );
    }
  }
}

/** The project root on the target, for the report; the node's own project when the copy lost track. */
function completedWorkspaceRoot(entry: ProjectCopyEntry): string | null {
  const project = entry.project;
  if (!project) return null;
  return (
    project.workspaceRoot ??
    selectProjectByRef(useStore.getState(), {
      environmentId: project.environmentId,
      projectId: project.projectId,
    })?.cwd ??
    entry.progress.importSnapshot?.destinationPath ??
    null
  );
}

function completedResult(entry: ProjectCopyEntry): AgentControlClientExecutionResult | null {
  const project = entry.project;
  const workspaceRoot = completedWorkspaceRoot(entry);
  if (!project || workspaceRoot === null) return null;
  return {
    targetEnvironmentId: project.environmentId,
    projectId: project.projectId,
    workspaceRoot,
    warnings: project.warnings
      .map(boundedMessage)
      .filter((warning): warning is string => warning !== null)
      .slice(0, AGENT_CONTROL_CLIENT_EXECUTION_WARNINGS_MAX),
  };
}

// ── Running ──

interface LaunchInput {
  readonly plan: ProjectCopyRunPlan | null;
  readonly resume?: ProjectCopyJobRecord | null;
  readonly restartOf?: ProjectCopyJobRecord | null;
  readonly agentControl: ProjectCopyAgentControlContext | null;
  readonly background: boolean;
  readonly inDialog: boolean;
}

async function launch(input: LaunchInput): Promise<ManagedProjectCopy> {
  const runtime = await loadRuntime();
  // Checked after the last await: from here to `live.set` nothing yields, so
  // two resumes of one record (app start and the Copies block) never both run.
  const existingCopyId = (input.resume ?? input.restartOf)?.copyId;
  if (existingCopyId !== undefined && live.has(existingCopyId)) {
    throw new Error("This copy is already running.");
  }
  markProjectCopiesActive();
  const io = runtime.createIo();
  const { agentControl, plan } = input;
  let startedReported = false;
  const reportStarted = (record: ProjectCopyJobRecord) => {
    if (!agentControl || startedReported || record.stage !== "importing") return;
    startedReported = true;
    void reportToAgentControl(record.copyId, agentControl, {
      outcome: "started",
      importId: record.importId,
    });
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
    const entry = useProjectCopyStore.getState().entries[progress.copyId];
    // A resumed copy learns its project's name from the target's import.
    const learnsTitle = entry !== undefined && entry.title === null && progress.importSnapshot;
    patchEntry(progress.copyId, {
      progress,
      ...(learnsTitle && progress.importSnapshot ? { title: progress.importSnapshot.title } : {}),
    });
    refreshToast(progress.copyId);
  };

  let run: ProjectCopyRun;
  try {
    run = runtime.startProjectCopy({
      io,
      plan,
      resume: input.resume ?? null,
      restartOf: input.restartOf ?? null,
      agentControl,
      onProgress,
      onRecord,
    });
  } catch (error) {
    io.dispose();
    throw error;
  }
  const record = pending.record ?? input.resume ?? null;
  if (record === null) {
    run.cancel();
    io.dispose();
    throw new Error("The copy did not start.");
  }
  const { copyId } = run;
  const progress = run.getProgress();
  const entry: ProjectCopyEntry = {
    copyId,
    title: plan?.title ?? progress.importSnapshot?.title ?? null,
    sourceLabel: plan?.source.label ?? nodeLabel(record.sourceEnvironmentId),
    targetLabel: plan?.target.label ?? nodeLabel(record.targetEnvironmentId),
    targetEnvironmentId: record.targetEnvironmentId,
    progress,
    record,
    project: null,
    running: true,
    background: input.background,
    inDialog: input.inDialog,
    hasPlan: plan !== null,
    agentControl,
  };
  useProjectCopyStore.setState((state) => ({ entries: { ...state.entries, [copyId]: entry } }));
  pending.entryReady = true;
  live.set(copyId, { run, io });
  if (plan) plans.set(copyId, plan);
  refreshToast(copyId);
  // A resumed copy whose import already runs reports `started` again: it is
  // idempotent and extends the node's deadline.
  reportStarted(record);

  const done = run.done.then((outcome) => finish(copyId, outcome, io));
  return { copyId, done };
}

async function finish(
  copyId: string,
  outcome: ProjectCopyOutcome,
  io: WebProjectCopyIo,
): Promise<ProjectCopyOutcome> {
  io.dispose();
  if (live.get(copyId)?.io === io) live.delete(copyId);
  const before = useProjectCopyStore.getState().entries[copyId];
  const agentControl = before?.agentControl ?? null;
  let record = outcome.record;
  // An Agent Control copy ends with its report: a failure is final there, so
  // the record is too and a reload does not run it again.
  if (
    agentControl &&
    record.stage !== "finished" &&
    (outcome.progress.phase === "failed" || outcome.progress.phase === "cancelled")
  ) {
    record = reduceProjectCopyJobRecord(record, {
      type: "finished",
      outcome: outcome.progress.phase === "failed" ? "failed" : "cancelled",
      at: Date.now(),
    });
  }
  persistRecord(record);
  patchEntry(copyId, {
    progress: outcome.progress,
    record,
    project: outcome.project,
    running: false,
  });
  const entry = useProjectCopyStore.getState().entries[copyId];
  // The copy dialog shows how it ended itself.
  if (entry && !entry.inDialog) showResultToast(entry);
  if (agentControl && entry) {
    switch (outcome.progress.phase) {
      case "done": {
        const result = completedResult(entry);
        await reportToAgentControl(
          copyId,
          agentControl,
          result
            ? { outcome: "completed", importId: record.importId, result }
            : {
                outcome: "failed",
                importId: record.importId,
                error: "The copy finished, but its project could not be found on the destination.",
              },
        );
        break;
      }
      case "failed":
      case "cancelled":
        await reportToAgentControl(copyId, agentControl, {
          outcome: "failed",
          importId: record.importId,
          error:
            boundedMessage(
              outcome.progress.phase === "cancelled"
                ? "The copy was cancelled."
                : (outcome.progress.error?.message ?? "The copy failed."),
            ) ?? "The copy failed.",
        });
        break;
      default:
        // Detached: the import runs on and a later follow reports how it ends.
        break;
    }
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
    agentControl: options.agentControl ?? null,
    background: options.toast === false,
    inDialog: options.toast === false,
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
    });
  }
  if (retry === "resume") {
    return launch({
      plan,
      resume: entry.record,
      agentControl: entry.agentControl,
      background: inDialog,
      inDialog,
    });
  }
  return null;
}

/**
 * Follows (or, with its plan, continues) a copy from its stored record: the
 * Copies block's Resume, and app start.
 */
export async function resumeProjectCopy(copyId: string): Promise<ManagedProjectCopy | null> {
  if (live.has(copyId)) return null;
  const record = useProjectCopyStore.getState().records.find((entry) => entry.copyId === copyId);
  if (!record || projectCopyResumeKind(record) === "none") return null;
  const agentControl = agentControlOf(record);
  return launch({
    plan: await planForResume(record, agentControl),
    resume: record,
    agentControl,
    background: true,
    inDialog: false,
  });
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
 * Reports an Agent Control copy that was accepted (`executing`) but never
 * started here, so the proposal ends now rather than at its deadline.
 */
export function reportAgentControlCopyNotStarted(
  context: ProjectCopyAgentControlContext,
  message: string,
): Promise<void> {
  // Holds the node under a copy id of its own: no copy of this proposal exists.
  return reportToAgentControl(randomUUID(), context, {
    outcome: "failed",
    error: boundedMessage(message) ?? "The copy did not start.",
  });
}

/** Drops a copy's record and entry (the Copies block's dismiss); a running copy is kept. */
export function forgetProjectCopy(copyId: string): void {
  if (live.has(copyId)) return;
  plans.delete(copyId);
  dismissProjectCopyToast(copyId);
  const records = useProjectCopyStore
    .getState()
    .records.filter((record) => record.copyId !== copyId);
  useProjectCopyStore.setState((state) => {
    const { [copyId]: _forgotten, ...entries } = state.entries;
    return { entries, records };
  });
  writeStoredRecords(records);
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
 * At app start: picks up every unfinished copy from its record, once its nodes
 * are known here. An import that already started is followed to its end (and an
 * Agent Control copy reports how it ended). An upload the app closed during
 * goes on when an Agent Control copy's plan can be rebuilt from its proposal
 * (still `executing`); otherwise it cleans up and fails. Runs once.
 */
export async function resumeProjectCopies(): Promise<void> {
  if (resumedAtStart) return;
  resumedAtStart = true;
  const records = readStoredRecords();
  useProjectCopyStore.setState({ records });
  await Promise.all(
    records
      .filter((record) => projectCopyResumeKind(record) !== "none" && !live.has(record.copyId))
      .map(async (record) => {
        const agentControl = agentControlOf(record);
        const nodes = [record.targetEnvironmentId];
        if (record.sourceEnvironmentId !== null) nodes.push(record.sourceEnvironmentId);
        if (agentControl !== null) nodes.push(agentControl.environmentId);
        if (!(await waitForNodes(nodes))) return;
        try {
          await launch({
            plan: await planForResume(record, agentControl),
            resume: record,
            agentControl,
            background: true,
            inDialog: false,
          });
        } catch (error) {
          console.warn("Resuming a project copy failed.", error);
        }
      }),
  );
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

/** Test-only: no copies, no records, nothing registered. */
export function resetProjectCopyManagerForTests(): void {
  for (const copy of live.values()) copy.io.dispose();
  live.clear();
  plans.clear();
  viewer = null;
  viewerListeners.clear();
  resumedAtStart = false;
  useProjectCopyStore.setState({ entries: {}, records: [] });
}
