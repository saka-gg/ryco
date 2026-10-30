import {
  resolveWorktreeSetupStages,
  startWorktreeLaunchFeed,
  stopWorktreeLaunchFeed,
  useWorktreeLaunchStore,
  type WorktreeLaunch,
  type WorktreeSetupFeedApi,
} from "@ryco/client-runtime/state/worktree-setup";
import type { CommandId } from "@ryco/contracts";

import {
  prepareNewTaskRetry,
  runNewTaskAttempt,
  type NewTaskAttempt,
  type NewTaskControllerDeps,
  type NewTaskFailureStep,
} from "./newTaskController";
import { inferTaskTitle } from "./newTaskModel";
import {
  newTaskLaunchKey,
  readNewTaskLaunch,
  useNewTaskLaunchStore,
  type NewTaskLaunch,
  type NewTaskLaunchDraft,
} from "./newTaskLaunchStore";

export {
  newTaskLaunchKey,
  readNewTaskLaunch,
  useNewTaskLaunchStore,
  type NewTaskLaunch,
  type NewTaskLaunchDraft,
  type NewTaskLaunchFailure,
  type NewTaskLaunchStatus,
} from "./newTaskLaunchStore";

/**
 * A New Task the phone has handed to its thread screen before the node
 * confirmed it: the thread opens as soon as the task is sent, and this record
 * carries it until the node's own thread and message take over. Kept outside
 * React because it outlives the New Task sheet that started it. The node's
 * worktree setup feed for it lives in the shared `useWorktreeLaunchStore`
 * under the same key, exactly as web's first send keeps it.
 *
 * A task sent while its machine is offline waits here as `queued` and is
 * started once the machine is live again (`newTaskOutbox.ts` persists those,
 * and launches still starting or failed, across app restarts).
 */

/** Started launches kept for a thread screen still waiting for the node's rows. */
const MAX_STARTED_LAUNCHES = 8;

function patchLaunch(key: string, change: (launch: NewTaskLaunch) => NewTaskLaunch | null): void {
  useNewTaskLaunchStore.setState((state) => {
    const current = state.launchesByKey[key];
    if (!current) return state;
    const next = change(current);
    const launchesByKey = { ...state.launchesByKey };
    if (next === null) delete launchesByKey[key];
    else launchesByKey[key] = next;
    return { launchesByKey: pruneStarted(launchesByKey) };
  });
}

function pruneStarted(
  launches: Record<string, NewTaskLaunch>,
): Readonly<Record<string, NewTaskLaunch>> {
  const started = Object.values(launches).filter((launch) => launch.status === "started");
  for (const launch of started.slice(0, Math.max(0, started.length - MAX_STARTED_LAUNCHES))) {
    delete launches[launch.key];
  }
  return launches;
}

/** A new worktree is set up by the node inside the turn start, with a live feed. */
function beginWorktreeFeed(launch: NewTaskLaunch, feedApi: WorktreeSetupFeedApi): void {
  const { attempt } = launch;
  if (attempt.worktree.kind !== "new" || attempt.turnStarted) return;
  useWorktreeLaunchStore.getState().begin({
    key: launch.key,
    environmentId: attempt.environmentId,
    threadId: attempt.threadId,
    messageId: attempt.ids.messageId,
    baseRef: attempt.worktree.baseBranch,
    fetchOrigin: attempt.worktree.fetchOrigin,
  });
  startWorktreeLaunchFeed({ api: feedApi, key: launch.key, threadId: attempt.threadId });
}

function dropWorktreeFeed(key: string): void {
  stopWorktreeLaunchFeed(key);
  useWorktreeLaunchStore.getState().remove(key);
}

export interface NewTaskLaunchDeps {
  readonly controller: NewTaskControllerDeps;
  readonly feedApi: WorktreeSetupFeedApi;
  /** A refused step is sent again under a fresh id (see `prepareNewTaskRetry`). */
  readonly newCommandId: () => CommandId;
}

/** Keys whose attempt is running, so a double tap on Retry runs it once. */
const running = new Set<string>();

async function run(key: string, deps: NewTaskLaunchDeps): Promise<void> {
  const launch = readNewTaskLaunch(key);
  if (!launch || running.has(key)) return;
  running.add(key);
  try {
    const result = await runNewTaskAttempt(launch.attempt, deps.controller);
    // Edit task or a discard took the launch away meanwhile: nothing to report.
    if (readNewTaskLaunch(key) !== launch) return;
    if (result.ok) {
      useWorktreeLaunchStore.getState().handOff(key);
      patchLaunch(key, (current) => ({
        ...current,
        attempt: result.attempt,
        status: "started",
        failure: null,
      }));
      return;
    }
    if (useWorktreeLaunchStore.getState().launchesByKey[key]) {
      useWorktreeLaunchStore.getState().fail(key, result.message);
      stopWorktreeLaunchFeed(key);
    }
    patchLaunch(key, (current) => ({
      ...current,
      attempt: result.attempt,
      status: "failed",
      failure: {
        step: result.step,
        message: result.message,
        deliveryUncertain: result.deliveryUncertain,
      },
    }));
  } finally {
    running.delete(key);
  }
}

/**
 * Hand a New Task to its thread screen and run it there. Returns the launch's
 * key, which is also the thread's scoped key.
 */
export function startNewTaskLaunch(input: {
  readonly attempt: NewTaskAttempt;
  readonly draft: NewTaskLaunchDraft;
  readonly deps: NewTaskLaunchDeps;
}): string {
  const key = addLaunch(input.attempt, input.draft, "starting");
  beginWorktreeFeed(readNewTaskLaunch(key)!, input.deps.feedApi);
  void run(key, input.deps);
  return key;
}

function addLaunch(
  attempt: NewTaskAttempt,
  draft: NewTaskLaunchDraft,
  status: "queued" | "starting",
): string {
  const key = newTaskLaunchKey(attempt.environmentId, attempt.threadId);
  const launch: NewTaskLaunch = {
    key,
    attempt,
    draft,
    status,
    failure: null,
    queuedAt: attempt.createdAt,
  };
  useNewTaskLaunchStore.setState((state) => ({
    launchesByKey: pruneStarted({ ...state.launchesByKey, [key]: launch }),
  }));
  return key;
}

/**
 * Keep a New Task on this device until its machine is live: nothing is sent
 * until {@link startQueuedNewTaskLaunch}. Returns the launch's key.
 */
export function queueNewTaskLaunch(input: {
  readonly attempt: NewTaskAttempt;
  readonly draft: NewTaskLaunchDraft;
}): string {
  return addLaunch(input.attempt, input.draft, "queued");
}

/** Start a queued launch now that its machine is live. */
export function startQueuedNewTaskLaunch(key: string, deps: NewTaskLaunchDeps): void {
  const launch = readNewTaskLaunch(key);
  if (!launch || launch.status !== "queued" || running.has(key)) return;
  const next: NewTaskLaunch = { ...launch, status: "starting" };
  patchLaunch(key, () => next);
  beginWorktreeFeed(next, deps.feedApi);
  void run(key, deps);
}

/**
 * Run a failed launch again from the step that failed: a step that may have
 * been delivered keeps its command id, a refused one gets a fresh one.
 */
export function retryNewTaskLaunch(key: string, deps: NewTaskLaunchDeps): void {
  const launch = readNewTaskLaunch(key);
  if (!launch || launch.status !== "failed" || running.has(key)) return;
  const next: NewTaskLaunch = {
    ...launch,
    attempt: launch.failure
      ? prepareNewTaskRetry(launch.attempt, launch.failure, deps.newCommandId)
      : launch.attempt,
    status: "starting",
    failure: null,
  };
  patchLaunch(key, () => next);
  beginWorktreeFeed(next, deps.feedApi);
  void run(key, deps);
}

/**
 * Whether Edit task may hand the draft back: only while the node holds no
 * thread for it, so editing can never leave the task behind as a second one.
 */
export function canEditNewTaskLaunch(launch: NewTaskLaunch): boolean {
  if (launch.interrupted === true) return false;
  if (launch.status === "queued") return true;
  const { attempt } = launch;
  // A new project the node took but this device has not seen yet: editing
  // would create it a second time under another id.
  const projectUnconfirmed =
    attempt.project.kind === "new" && attempt.projectCommandAccepted && !attempt.projectReady;
  return (
    launch.status === "failed" &&
    !attempt.threadCommandAccepted &&
    !projectUnconfirmed &&
    launch.failure?.deliveryUncertain !== true
  );
}

/**
 * The draft a failed launch hands back to the New Task sheet, or null when it
 * may not be edited (see {@link canEditNewTaskLaunch}). A project the attempt
 * already created becomes the draft's project, so editing does not create it
 * twice. Reading takes nothing: the sheet discards the launch once it shows
 * the draft.
 */
export function readNewTaskLaunchDraftForEdit(key: string): NewTaskLaunchDraft | null {
  const launch = readNewTaskLaunch(key);
  if (!launch || !canEditNewTaskLaunch(launch)) return null;
  const { attempt, draft } = launch;
  return attempt.project.kind === "new" && attempt.projectReady
    ? { ...draft, projectId: attempt.projectId, newProjectPath: "", newProjectTitle: "" }
    : draft;
}

export function discardNewTaskLaunch(key: string): void {
  dropWorktreeFeed(key);
  patchLaunch(key, () => null);
}

/* -------------------------------------------------------------------------- */
/* What the thread screen shows                                                */
/* -------------------------------------------------------------------------- */

export type NewTaskLaunchStepStatus = "pending" | "running" | "done" | "skipped" | "failed";

export interface NewTaskLaunchStepView {
  readonly id: string;
  readonly label: string;
  readonly status: NewTaskLaunchStepStatus;
  readonly percent: number | null;
}

export interface NewTaskLaunchView {
  readonly queued: boolean;
  readonly title: string;
  readonly prompt: string;
  readonly attachmentCount: number;
  readonly statusLabel: string;
  readonly steps: ReadonlyArray<NewTaskLaunchStepView>;
  readonly failureMessage: string | null;
  readonly canRetry: boolean;
  readonly canEdit: boolean;
  /** Drop the task: only while the node holds nothing for it (as for Edit task). */
  readonly canRemove: boolean;
}

/**
 * The thread screen's view of a launch: the task as sent, the steps the node
 * is taking for it (the worktree setup's own stages when it prepares one), and
 * what the user can do after a failure. Null once the node's thread has
 * messages of its own to show.
 */
export function deriveNewTaskLaunchView(input: {
  readonly launch: NewTaskLaunch | null | undefined;
  readonly worktreeLaunch: WorktreeLaunch | null | undefined;
  readonly threadHasMessages: boolean;
  /** The machine's name, for a queued task's status. */
  readonly machineLabel?: string | null;
}): NewTaskLaunchView | null {
  const { launch } = input;
  if (!launch || input.threadHasMessages) return null;
  const { attempt } = launch;
  const failed = launch.status === "failed";
  const failedStep = launch.failure?.step ?? null;
  const stepStatus = (
    done: boolean,
    step: NewTaskFailureStep,
    active: boolean,
  ): NewTaskLaunchStepStatus =>
    done
      ? "done"
      : failed && failedStep === step
        ? "failed"
        : active && !failed
          ? "running"
          : "pending";

  const steps: NewTaskLaunchStepView[] = [];
  if (attempt.project.kind === "new") {
    steps.push({
      id: "project",
      label: "Create project",
      status: stepStatus(attempt.projectReady, "project", true),
      percent: null,
    });
  }
  if (attempt.worktree.kind === "new") {
    const stages = resolveWorktreeSetupStages(
      input.worktreeLaunch ?? {
        snapshot: null,
        baseRef: attempt.worktree.baseBranch,
        fetchOrigin: attempt.worktree.fetchOrigin,
      },
    );
    for (const stage of stages) {
      steps.push({
        id: stage.id,
        label: stage.label,
        status:
          attempt.turnStarted && stage.status !== "skipped"
            ? "done"
            : failed && failedStep === "worktree" && stage.status === "running"
              ? "failed"
              : stage.status,
        percent: stage.percent,
      });
    }
  } else {
    steps.push({
      id: "thread",
      label: "Create task",
      status: stepStatus(
        attempt.threadReady && attempt.worktreeAttached,
        "thread",
        attempt.projectReady,
      ),
      percent: null,
    });
    steps.push({
      id: "turn",
      label: "Start agent",
      status: stepStatus(attempt.turnStarted, "turn", attempt.threadReady),
      percent: null,
    });
  }

  const queued = launch.status === "queued";
  const canEdit = canEditNewTaskLaunch(launch);
  return {
    queued,
    title: inferTaskTitle(attempt.prompt),
    prompt: attempt.prompt,
    attachmentCount: attempt.attachments.length,
    statusLabel: queued
      ? `Queued: starts when ${input.machineLabel?.trim() || "its machine"} is back`
      : failed
        ? "Not started"
        : launch.status === "started"
          ? "Started"
          : attempt.worktree.kind === "new"
            ? "Setting up a worktree"
            : "Starting",
    steps: queued
      ? steps.map((step) => (step.status === "running" ? { ...step, status: "pending" } : step))
      : steps,
    failureMessage: failed ? (launch.failure?.message ?? null) : null,
    canRetry: failed,
    canEdit,
    canRemove: canEdit,
  };
}
