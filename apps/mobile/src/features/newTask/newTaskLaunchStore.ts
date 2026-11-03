import { scopeThreadRef, scopedThreadKey } from "@ryco/client-runtime/scoped";
import type {
  EnvironmentId,
  ModelSelection,
  ProjectId,
  ProviderInteractionMode,
  RuntimeMode,
  ThreadId,
  WorktreeId,
} from "@ryco/contracts";
import { create } from "zustand";

import type { DraftComposerImageAttachment } from "../../lib/composerImages";
import type { NewTaskAttempt, NewTaskFailureStep } from "./newTaskController";
import { inferTaskTitle } from "./newTaskModel";

/**
 * The New Task launches this device holds, and what Home lists of them. Kept
 * apart from the runner (`newTaskLaunch.ts`) so Home, which is on the launch
 * path, reads them without loading the send code.
 */

/** What Edit task puts back on the New Task sheet. */
export interface NewTaskLaunchDraft {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId | null;
  readonly newProjectPath: string;
  readonly newProjectTitle: string;
  readonly worktree:
    | { readonly kind: "local" }
    | { readonly kind: "existing"; readonly worktreeId: WorktreeId }
    | { readonly kind: "new" };
  readonly newBranch: string;
  readonly baseBranch: string;
  readonly prompt: string;
  readonly attachments: ReadonlyArray<DraftComposerImageAttachment>;
  readonly modelSelection: ModelSelection;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
}

export interface NewTaskLaunchFailure {
  readonly step: NewTaskFailureStep;
  readonly message: string;
  readonly deliveryUncertain: boolean;
}

export type NewTaskLaunchStatus =
  /** Waiting on this device for its machine to be live: nothing was sent. */
  | "queued"
  | "starting"
  /** The node took the task: its thread takes over from here. */
  | "started"
  | "failed";

export interface NewTaskLaunch {
  readonly key: string;
  readonly attempt: NewTaskAttempt;
  readonly draft: NewTaskLaunchDraft;
  readonly status: NewTaskLaunchStatus;
  readonly failure: NewTaskLaunchFailure | null;
  /**
   * The app stopped while this launch was starting, so some of its commands
   * may have reached the node. It starts again under the same ids (the node
   * answers those from its receipts) and is never handed back for editing.
   */
  readonly interrupted?: boolean;
  /**
   * Written while its machine was away. Only these are kept across restarts:
   * a task sent online lives as long as its thread screen needs it.
   */
  readonly fromOutbox?: boolean;
  /** Its draft is open on the New Task sheet: the outbox leaves it alone meanwhile. */
  readonly editing?: boolean;
  /** When the user sent it. */
  readonly queuedAt: string;
}

interface NewTaskLaunchStore {
  readonly launchesByKey: Readonly<Record<string, NewTaskLaunch>>;
}

export const useNewTaskLaunchStore = create<NewTaskLaunchStore>(() => ({ launchesByKey: {} }));

export function newTaskLaunchKey(environmentId: EnvironmentId, threadId: ThreadId): string {
  return scopedThreadKey(scopeThreadRef(environmentId, threadId));
}

export function readNewTaskLaunch(key: string): NewTaskLaunch | null {
  return useNewTaskLaunchStore.getState().launchesByKey[key] ?? null;
}

/** Queued and failed launches waiting on this device, oldest first. */
export function listWaitingNewTaskLaunches(
  launches: Readonly<Record<string, NewTaskLaunch>>,
): ReadonlyArray<NewTaskLaunch> {
  return Object.values(launches)
    .filter((launch) => launch.status === "queued" || launch.status === "failed")
    .toSorted((left, right) => left.queuedAt.localeCompare(right.queuedAt));
}

export interface WaitingTaskRow {
  readonly key: string;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly title: string;
  readonly detail: string;
  readonly failed: boolean;
}

/** Home's rows for tasks still on this device: queued, or not started. */
export function buildWaitingTaskRows(input: {
  readonly launches: Readonly<Record<string, NewTaskLaunch>>;
  readonly machineLabel: (environmentId: EnvironmentId) => string | null;
}): ReadonlyArray<WaitingTaskRow> {
  return listWaitingNewTaskLaunches(input.launches).map((launch) => {
    const machine = input.machineLabel(launch.attempt.environmentId)?.trim() || "its machine";
    const failed = launch.status === "failed";
    return {
      key: launch.key,
      environmentId: launch.attempt.environmentId,
      threadId: launch.attempt.threadId,
      title: inferTaskTitle(launch.attempt.prompt),
      detail: failed ? `Did not start on ${machine}` : `Starts when ${machine} is back`,
      failed,
    };
  });
}
