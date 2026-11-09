// FILE: manager.ts
// Purpose: Runs a client's cross-node project copies: starts, resumes,
//          retries, cancels and detaches them, keeps each copy's progress in a
//          small store (the copy screen or dialog, notices, a Copies list),
//          persists the ids-only job records, reports Agent Control copies back
//          to the node their proposal lives on (until that node answers, after
//          a restart too), follows the clones and links an add-project flow
//          hands over, and offers a copy whose upload stopped when the app
//          closed again. Upload progress reaches the store at most four times a
//          second, with its speed and time left. Every run holds its copy's
//          claim, so with records shared between windows a copy is run,
//          resumed, cleaned up or reported by one window only.
// Layer: Client runtime. Each app creates one manager with its ports
//        (`createProjectCopyManager`): storage, claims, node catalog,
//        notices, and the coordinator plus node IO loaded with the first copy.
//        No DOM or React Native code here.

import type {
  AgentControlClientExecutionResult,
  EnvironmentApi,
  ProjectId,
  ScopedProjectRef,
} from "@ryco/contracts";
import {
  AGENT_CONTROL_ERROR_MESSAGE_MAX_CHARS,
  AgentControlClientExecutorId,
  AgentControlProposalId,
  AgentControlRpcError,
} from "@ryco/contracts/agent-control";
import { AGENT_CONTROL_CLIENT_EXECUTION_WARNINGS_MAX } from "@ryco/contracts/agent-control-project-copy";
import { EnvironmentId } from "@ryco/contracts/base-schemas";
import type { ProjectImportId, ProjectImportSnapshot } from "@ryco/contracts/project-copy";
import { projectImportSetupOutcome } from "@ryco/shared/projectImportOutcome";
import * as Schema from "effect/Schema";
import { createStore, type StoreApi } from "zustand/vanilla";

import { scopedProjectKey } from "../scoped.ts";
import type { NodeCatalogEntry } from "../state/nodes/types.ts";
import {
  agentControlReportRetryDelayMs,
  deliverAgentControlReport,
  type AgentControlReportBody,
  type AgentControlReportDelivery,
} from "./agentControlReports.ts";
import type { ProjectCopyIo } from "./io.ts";
import {
  createProjectCopyJobRecord,
  decodeProjectCopyJobRecords,
  projectCopyReportOwed,
  projectCopyResumeKind,
  reduceProjectCopyJobRecord,
  upsertProjectCopyJobRecord,
  type ProjectCopyJobRecord,
} from "./jobRecord.ts";
import type { projectCopyPlanWithSendFiles, ProjectCopyRunPlan } from "./plan.ts";
import {
  copyThroughput,
  nextCopyByteSamples,
  projectCopyPercent,
  projectCopyView,
  type ProjectCopyAction,
  type ProjectCopyByteSample,
  type ProjectCopyLabels,
  type ProjectCopyThroughput,
  type ProjectCopyView,
} from "./progressView.ts";
import type {
  ProjectCopyCompletedProject,
  ProjectCopyOutcome,
  ProjectCopyProgress,
  ProjectCopyRun,
  startProjectCopy,
} from "./run.ts";

// ── Claims ──

/** One window's hold on a copy (or an approval); release it when the run ends. */
export interface ProjectCopyClaim {
  /** Lets go of the claim; later calls do nothing. */
  readonly release: () => void;
}

export interface ProjectCopyClaims {
  /** Claims `key` for this window; null when a run here or in another window holds it. */
  readonly tryClaim: (key: string) => Promise<ProjectCopyClaim | null>;
}

/** Claims this app instance keeps to itself (one holder per key; other windows don't see them). */
export function createInMemoryProjectCopyClaims(): ProjectCopyClaims {
  const held = new Set<string>();
  return {
    tryClaim: async (key) => {
      if (held.has(key)) return null;
      held.add(key);
      let released = false;
      return {
        release: () => {
          if (released) return;
          released = true;
          held.delete(key);
        },
      };
    },
  };
}

// ── Ports ──

/** Where the manager keeps its ids-only records; values are opaque JSON. */
export interface ProjectCopyManagerStorage {
  /** The stored records as they are now; null when storage can't be read. Throwing counts as null. */
  readonly readRecords: () => unknown;
  readonly writeRecords: (records: ReadonlyArray<ProjectCopyJobRecord>) => void;
  /** The Agent Control approvals held between accept and copy; anything else is dropped. */
  readonly readStarts: () => unknown;
  readonly writeStarts: (starts: ReadonlyArray<unknown>) => void;
}

export interface ProjectCopyProgressNoticeActions {
  readonly onBackground: () => void;
  readonly onCancel: () => void;
}

export interface ProjectCopyResultNoticeActions {
  readonly onView: (() => void) | undefined;
  readonly onRetry: (() => void) | undefined;
}

export interface ProjectCopyInterruptedNoticeActions {
  readonly onResume: () => void;
  readonly onDiscard: () => void;
}

/** How a client tells the user about a copy outside the screen that started it. */
export interface ProjectCopyNotices {
  /** A running copy's progress (replaces the copy's previous notice). */
  readonly showProgress: (
    copyId: string,
    view: ProjectCopyView,
    actions: ProjectCopyProgressNoticeActions,
  ) => void;
  /** How a copy ended. */
  readonly showResult: (
    copyId: string,
    view: ProjectCopyView,
    actions: ProjectCopyResultNoticeActions,
  ) => void;
  /** A copy the user started stopped when the app closed; it can go on. */
  readonly showInterrupted: (
    copyId: string,
    text: { readonly title: string; readonly description: string },
    actions: ProjectCopyInterruptedNoticeActions,
  ) => void;
  readonly dismiss: (copyId: string) => void;
}

/** Opens the app's copy flow on a stopped copy, prefilled with its checkout and destination. */
export interface ProjectCopyResumeRequest {
  readonly source: ScopedProjectRef;
  readonly targetEnvironmentId: EnvironmentId;
  readonly resumeCopyId: string;
}

export interface ProjectCopyManagerPorts {
  readonly storage: ProjectCopyManagerStorage;
  readonly claims: ProjectCopyClaims;
  /** The coordinator and the node IO, loaded with the first copy. */
  readonly loadRuntime: () => Promise<ProjectCopyRuntime>;
  /** The node catalog: labels, presence, and waiting for nodes a record names. */
  readonly nodes: {
    readonly read: () => ReadonlyArray<NodeCatalogEntry>;
    readonly subscribe: (listener: () => void) => () => void;
  };
  /** A checkout this client knows, for titles and the report's workspace root. */
  readonly readProject: (
    ref: ScopedProjectRef,
  ) => { readonly name: string; readonly cwd: string } | null;
  readonly notices: ProjectCopyNotices;
  /** Opens the copy flow on a stopped copy (the interrupted notice's Resume). */
  readonly openInterruptedCopy?: (request: ProjectCopyResumeRequest) => void;
  /** A copy runs or is offered: the surface that hosts copy UI should be mounted. */
  readonly onCopiesActive?: () => void;
  readonly uuid: () => string;
}

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

const RUNNING_HERE = "This copy is already running.";
const RUNNING_ELSEWHERE = "This copy is running in another Ryco window.";

const copyClaimKey = (copyId: string) => `copy:${copyId}`;
const startClaimKey = (executorId: string) => `start:${executorId}`;

interface LiveCopy {
  readonly run: ProjectCopyRun;
  readonly io: ProjectCopyManagedIo;
}

/**
 * Rebuilds an Agent Control copy's plan from its proposal after a reload, so
 * an upload the app closed during goes on; null when the proposal no longer
 * runs it (the copy then cleans up and reports `failed`).
 */
export type ProjectCopyPlanRebuilder = (
  record: ProjectCopyJobRecord,
  context: ProjectCopyAgentControlContext,
) => Promise<ProjectCopyRunPlan | null>;

/** One copy's node IO as the manager drives it: the coordinator's IO, released when the copy ends. */
export interface ProjectCopyManagedIo extends ProjectCopyIo {
  /** Releases every node this IO still holds. The coordinator releases its own; this is the backstop. */
  readonly dispose: () => void;
}

/** Runs one call against a node outside a copy's own holds (an Agent Control report, a resumed read). */
export type ProjectCopyNodeCall = <T>(
  environmentId: EnvironmentId,
  call: (api: EnvironmentApi) => Promise<T>,
  options: { readonly copyId: string; readonly signal?: AbortSignal },
) => Promise<T>;

/** What the manager needs from the coordinator and the node IO, loaded with the first copy. */
export interface ProjectCopyRuntime {
  readonly startProjectCopy: typeof startProjectCopy;
  readonly projectCopyPlanWithSendFiles: typeof projectCopyPlanWithSendFiles;
  readonly createIo: () => ProjectCopyManagedIo;
  /** Holds the node with its mutation lease for `call` (a report to the agent's node). */
  readonly callNodeWithLease: ProjectCopyNodeCall;
  /** Holds the node only to read (how a resumed copy's import ended). */
  readonly callNodeToRead: ProjectCopyNodeCall;
  /** The Agent Control executor's; without it a resumed upload has no plan. */
  readonly rebuildAgentControlPlan?: ProjectCopyPlanRebuilder;
}

const NOT_STARTED = "The copy did not start.";
const START_INTERRUPTED = "The app that approved this request closed before the copy started.";
const PROJECT_NOT_FOUND =
  "The copy finished, but its project could not be found on the destination.";

/** One copy's reports: `started` until the final one replaces it, then the final one. */
interface CopyReports {
  /** The target accepted the import; repeated by a resumed run (it extends the node's deadline). */
  readonly started: (importId: ProjectImportId) => void;
  /** How the copy ended, until the node answers; marks the record reported then. */
  readonly final: (build: () => Promise<AgentControlReportBody | null>) => Promise<void>;
}

/** What a copy's final report is built from. */
interface FinalReportFacts {
  readonly project: ProjectCopyCompletedProject | null;
  readonly importSnapshot: ProjectImportSnapshot | null;
  /** Why it failed; null for a cancel, or when the reason is not known. */
  readonly errorMessage: string | null;
}

/** Upload ticks reach the store (the dialog, the toast, the badge) at most this often. */
export const PROJECT_COPY_PROGRESS_INTERVAL_MS = 250;

interface ProgressFeed {
  samples: ReadonlyArray<ProjectCopyByteSample>;
  lastAppliedAt: number;
  pending: ProjectCopyProgress | null;
  timer: ReturnType<typeof globalThis.setTimeout> | null;
}

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

/** Past a day the proposal's deadline is long gone; such a start is dropped unreported. */
const START_TTL_MS = 24 * 60 * 60 * 1000;

/** How long app start waits for a record's nodes to appear in the catalog. */
const RESUME_CATALOG_WAIT_MS = 60_000;

const VIEWER_WAIT_MS = 5_000;

/** One client's copy manager; create it once per app. */
/** The manager's store; named here so the apps' typecheck can name it too. */
export type ProjectCopyStore = StoreApi<ProjectCopyStoreState>;

export function createProjectCopyManager(ports: ProjectCopyManagerPorts) {
  // ── State ──

  /** The stored records as they are now (another window may have written them); null when unreadable. */
  function readStoredRecordsNow(): ReadonlyArray<ProjectCopyJobRecord> | null {
    try {
      const stored = ports.storage.readRecords();
      return stored === null ? null : decodeProjectCopyJobRecords(stored);
    } catch {
      return null;
    }
  }

  function readStoredRecords(): ReadonlyArray<ProjectCopyJobRecord> {
    return readStoredRecordsNow() ?? [];
  }

  function writeStoredRecords(records: ReadonlyArray<ProjectCopyJobRecord>): void {
    try {
      ports.storage.writeRecords(records);
    } catch {
      // Best effort: a full or unavailable storage keeps the records for this session.
    }
  }

  const store: ProjectCopyStore = createStore<ProjectCopyStoreState>()(() => ({
    entries: {},
    records: readStoredRecords(),
  }));

  /**
   * The records to change: as storage has them now, since other windows of a
   * direct or Desktop build write their own copies' records there too; this
   * window's when storage can't be read.
   */
  function currentRecords(): ReadonlyArray<ProjectCopyJobRecord> {
    return readStoredRecordsNow() ?? store.getState().records;
  }

  function readRecord(copyId: string): ProjectCopyJobRecord | null {
    return currentRecords().find((record) => record.copyId === copyId) ?? null;
  }

  /** Another window wrote the records (a storage event): the Copies block shows its changes too. */
  function reloadStoredRecords(): void {
    const records = readStoredRecordsNow();
    if (records !== null) store.setState({ records });
  }

  // ── Claims ──

  let claims: ProjectCopyClaims = ports.claims;
  /** The claims this window holds, by key; each is released when its run ends. */
  const heldClaims = new Map<string, ProjectCopyClaim>();

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

  /** Runs of this session, and the plans a retry needs (kept after a run ends). */
  const live = new Map<string, LiveCopy>();
  const plans = new Map<string, ProjectCopyRunPlan>();
  let viewer: ProjectCopyViewer | null = null;
  const viewerListeners = new Set<() => void>();

  function patchEntry(copyId: string, patch: Partial<ProjectCopyEntry>): void {
    store.setState((state) => {
      const current = state.entries[copyId];
      if (!current) return state;
      return { entries: { ...state.entries, [copyId]: { ...current, ...patch } } };
    });
  }

  /** Saves one record into the stored list as it is now, so no other window's record is lost. */
  function persistRecord(record: ProjectCopyJobRecord): void {
    const records = upsertProjectCopyJobRecord(currentRecords(), record, Date.now());
    store.setState({ records });
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
    return ports.nodes.read().find((node) => node.environmentId === environmentId)?.label ?? null;
  }

  // ── Coordinator loading ──

  let runtimeLoad: Promise<ProjectCopyRuntime> | null = null;

  /** One load in flight; a failed one is tried again by the next copy. */
  function loadRuntime(): Promise<ProjectCopyRuntime> {
    runtimeLoad ??= ports.loadRuntime().catch((error: unknown) => {
      runtimeLoad = null;
      throw error;
    });
    return runtimeLoad;
  }

  // ── Notices (toasts on the web, the copy screen's banner on the phone) ──

  function refreshToast(copyId: string): void {
    const entry = store.getState().entries[copyId];
    if (!entry || entry.background || !entry.running) return;
    ports.notices.showProgress(
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
      ports.notices.dismiss(entry.copyId);
      return;
    }
    ports.notices.showResult(entry.copyId, view, {
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

  function isNodeOnline(environmentId: EnvironmentId): boolean {
    return ports.nodes
      .read()
      .some((node) => node.environmentId === environmentId && node.presence === "online");
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
      const stop = ports.nodes.subscribe(() => {
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
            return send({
              proposalId: context.proposalId,
              executorId: context.executorId,
              ...body,
            });
          },
          { copyId: scopeId },
        );
      },
      signal,
      waitToRetry: waitToReportAgain,
    });
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

  /** The project root on the target, for the report; the node's own project when the copy lost track. */
  function completedWorkspaceRoot(facts: FinalReportFacts): string | null {
    const project = facts.project;
    if (!project) return null;
    return (
      project.workspaceRoot ??
      ports.readProject({
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
    const fallback =
      record.outcome === "cancelled" ? "The copy was cancelled." : "The copy failed.";
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
    if (record.outcome === "completed" && !reachable && completedResult(facts) === null)
      return null;
    return finalReportBody(record, facts);
  }

  // ── Progress ──

  const progressFeeds = new Map<string, ProgressFeed>();

  function applyProgress(copyId: string, progress: ProjectCopyProgress, feed: ProgressFeed): void {
    feed.lastAppliedAt = Date.now();
    feed.pending = null;
    const entry = store.getState().entries[copyId];
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
    const current = store.getState().entries[copyId]?.progress;
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
    io: ProjectCopyManagedIo,
    copyId: string,
    claimed: ProjectCopyClaim,
  ): ManagedProjectCopy {
    // The claim makes this a formality; nothing below yields until `live.set`.
    if (live.has(copyId)) throw new Error(RUNNING_HERE);
    ports.onCopiesActive?.();
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
    store.setState((state) => ({ entries: { ...state.entries, [copyId]: entry } }));
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
    io: ProjectCopyManagedIo,
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
    const entry = store.getState().entries[copyId];
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
  function startManagedProjectCopy(options: StartProjectCopyOptions): Promise<ManagedProjectCopy> {
    return launch({
      plan: options.plan,
      resume: options.resume ?? null,
      agentControl: options.agentControl ?? null,
      background: options.toast === false,
      inDialog: options.toast === false,
      sourceRef: options.sourceRef ?? null,
    });
  }

  /**
   * Follows an import the node accepted after the add-project dialog that
   * started it closed: its progress toast, how it ends ("X is ready on Y ·
   * View"), the Copies block and a reload pick it up like a copy whose upload
   * finished. Nothing runs here but following it.
   */
  async function trackProjectImport(input: TrackProjectImportInput): Promise<ManagedProjectCopy> {
    const copyId = ports.uuid();
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
  function cancelProjectCopy(copyId: string): void {
    live.get(copyId)?.run.cancel();
  }

  /**
   * Stops following a copy whose import runs on the destination by itself (the
   * Copies block can follow it again). Before the import was accepted the copy
   * still needs this client; it detaches once it was.
   */
  function detachProjectCopy(copyId: string): void {
    live.get(copyId)?.run.detach();
  }

  /** Hides the copy's progress toast; how it ends still toasts. */
  function runProjectCopyInBackground(copyId: string): void {
    patchEntry(copyId, { background: true });
    ports.notices.dismiss(copyId);
  }

  /**
   * Hands a copy the dialog showed over to the toasts (the dialog closed): its
   * progress toast while it runs, else how it ended.
   */
  function showProjectCopyProgress(copyId: string): void {
    const entry = store.getState().entries[copyId];
    if (!entry) return;
    patchEntry(copyId, { background: false, inDialog: false });
    if (entry.running) refreshToast(copyId);
  }

  /**
   * Runs a failed copy's retry (`progress.error.retry`): `send-files` starts the
   * same copy over with the files sent instead of cloned, `resume` picks it up
   * with its ids. Null when there is nothing to retry here (no plan, or running).
   */
  async function retryProjectCopy(
    copyId: string,
    options: RetryProjectCopyOptions = {},
  ): Promise<ManagedProjectCopy | null> {
    const entry = store.getState().entries[copyId];
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
  async function resumeProjectCopy(copyId: string): Promise<ManagedProjectCopy | null> {
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
  function forgetProjectCopy(copyId: string): void {
    if (live.has(copyId)) return;
    const drop = () => {
      plans.delete(copyId);
      ports.notices.dismiss(copyId);
      const records = currentRecords().filter((record) => record.copyId !== copyId);
      store.setState((state) => {
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

  function readStoredStarts(): ReadonlyArray<StoredStart> {
    try {
      const stored = ports.storage.readStarts();
      return Array.isArray(stored) ? stored.filter(isStoredStart) : [];
    } catch {
      return [];
    }
  }

  function writeStoredStarts(starts: ReadonlyArray<StoredStart>): void {
    try {
      ports.storage.writeStarts(starts);
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
  async function holdAgentControlCopyStart(
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

  function waitForNodes(environmentIds: ReadonlyArray<EnvironmentId>): Promise<boolean> {
    const known = () => {
      const nodes = ports.nodes.read();
      return environmentIds.every((id) => nodes.some((node) => node.environmentId === id));
    };
    if (known()) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = globalThis.setTimeout(() => {
        unsubscribe();
        resolve(known());
      }, RESUME_CATALOG_WAIT_MS);
      const unsubscribe = ports.nodes.subscribe(() => {
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
  async function resumeProjectCopies(): Promise<void> {
    if (resumedAtStart) return;
    resumedAtStart = true;
    const records = readStoredRecords();
    store.setState({ records });
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
  function projectCopyResumesInDialog(record: ProjectCopyJobRecord): boolean {
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
  function readProjectCopyRecord(copyId: string): ProjectCopyJobRecord | null {
    return readRecord(copyId);
  }

  /** The project a record copies, by its source checkout, when this client knows it. */
  function recordTitle(record: ProjectCopyJobRecord): string | null {
    const ref = sourceRefOf(record);
    return ref ? (ports.readProject(ref)?.name ?? null) : null;
  }

  /** Opens the copy dialog on a stopped copy, prefilled with its checkout and destination. */
  function openInterruptedProjectCopy(copyId: string): void {
    const record = readRecord(copyId);
    const source = record ? sourceRefOf(record) : null;
    if (record === null || source === null) return;
    ports.notices.dismiss(copyId);
    ports.openInterruptedCopy?.({
      source,
      targetEnvironmentId: record.targetEnvironmentId,
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
      ports.onCopiesActive?.();
      ports.notices.showInterrupted(
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
  function discardProjectCopy(copyId: string): void {
    ports.notices.dismiss(copyId);
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

  // ── View ──

  /** The dialogs' surface registers how to open a draft in a project; the latest wins. */
  function registerProjectCopyViewer(next: ProjectCopyViewer): () => void {
    viewer = next;
    for (const listener of Array.from(viewerListeners)) listener();
    return () => {
      if (viewer === next) viewer = null;
    };
  }

  function awaitViewer(): Promise<ProjectCopyViewer | null> {
    if (viewer) return Promise.resolve(viewer);
    // Copies keep the dialogs' surface mounted; it registers once its chunk loads.
    ports.onCopiesActive?.();
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
  async function viewCopiedProject(copyId: string): Promise<void> {
    const project = store.getState().entries[copyId]?.project;
    if (!project) return;
    ports.notices.dismiss(copyId);
    const open = await awaitViewer();
    if (!open) return;
    await open({ environmentId: project.environmentId, projectId: project.projectId });
  }

  // ── Reading ──

  function readProjectCopyEntry(copyId: string): ProjectCopyEntry | null {
    return store.getState().entries[copyId] ?? null;
  }

  /** Test-only: runs copies through `runtime` instead of loading the coordinator. */
  function setProjectCopyRuntimeForTests(runtime: ProjectCopyRuntime | null): void {
    runtimeLoad = runtime ? Promise.resolve(runtime) : null;
  }

  /** Test-only: claims copies through `next` (one with another window's claims, say). */
  function setProjectCopyClaimsForTests(next: ProjectCopyClaims | null): void {
    claims = next ?? ports.claims;
  }

  /** Test-only: no copies, no records, nothing registered. */
  function resetProjectCopyManagerForTests(): void {
    for (const copy of live.values()) copy.io.dispose();
    live.clear();
    for (const copyId of Array.from(progressFeeds.keys())) stopProgressFeed(copyId);
    for (const held of Array.from(heldClaims.values())) held.release();
    plans.clear();
    viewer = null;
    viewerListeners.clear();
    resumedAtStart = false;
    store.setState({ entries: {}, records: [] });
  }

  return {
    store,
    startManagedProjectCopy,
    trackProjectImport,
    cancelProjectCopy,
    detachProjectCopy,
    runProjectCopyInBackground,
    showProjectCopyProgress,
    retryProjectCopy,
    resumeProjectCopy,
    forgetProjectCopy,
    holdAgentControlCopyStart,
    resumeProjectCopies,
    projectCopyResumesInDialog,
    readProjectCopyRecord,
    openInterruptedProjectCopy,
    discardProjectCopy,
    registerProjectCopyViewer,
    viewCopiedProject,
    readProjectCopyEntry,
    reloadStoredRecords,
    setProjectCopyRuntimeForTests,
    setProjectCopyClaimsForTests,
    resetProjectCopyManagerForTests,
  };
}

export type ProjectCopyManager = ReturnType<typeof createProjectCopyManager>;

// ── Derived views ──

/** Whether a running copy still needs this client open (its upload, A22). */
export function projectCopyNeedsClient(
  entries: Readonly<Record<string, ProjectCopyEntry>>,
): boolean {
  return Object.values(entries).some((entry) => entry.running && !entry.progress.canCloseClient);
}

/** The running copies no copy screen shows, by the checkout they copy, with their percent. */
export function projectCopyBadges(
  entries: Readonly<Record<string, ProjectCopyEntry>>,
): Readonly<Record<string, number | null>> {
  const badges: Record<string, number | null> = {};
  for (const entry of Object.values(entries)) {
    if (!entry.running || entry.inDialog || entry.sourceRef === null) continue;
    badges[scopedProjectKey(entry.sourceRef)] = projectCopyPercent(entry.progress);
  }
  return badges;
}
