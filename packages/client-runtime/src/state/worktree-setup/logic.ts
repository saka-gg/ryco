import {
  WORKTREE_SETUP_STAGE_IDS,
  type WorktreeSetupSnapshot,
  type WorktreeSetupStage,
  type WorktreeSetupStageId,
  type WorktreeSetupStageStatus,
} from "@ryco/contracts/worktree-setup";

/**
 * A first send's worktree launch as the sending client sees it: from pressing
 * send, through the node's setup feed, to the turn the agent starts. It
 * outlives the draft view, so the thread view that replaces it can carry the
 * setup on (its timer, its hand-off) instead of starting over.
 */
export type WorktreeLaunchPhase =
  /** Send pressed; the client prepares the command and the node sets up. */
  | "preparing"
  /** The user asked to stop; the node has not confirmed yet. */
  | "cancelling"
  /** The turn was dispatched: the agent owns the thread now. */
  | "handed-off"
  /** The setup failed before any thread existed; the message stays put. */
  | "failed";

export interface WorktreeLaunch {
  readonly key: string;
  readonly environmentId: string;
  readonly threadId: string;
  readonly messageId: string;
  /** When send was pressed: the setup's timer counts from here. */
  readonly startedAt: string;
  readonly startedAtMs: number;
  /** The base the worktree branches from, as sent (`origin/main`). */
  readonly baseRef: string;
  readonly fetchOrigin: boolean;
  readonly phase: WorktreeLaunchPhase;
  readonly snapshot: WorktreeSetupSnapshot | null;
  /** The node publishes no setup feed (an older node): show no stage card. */
  readonly feedUnavailable: boolean;
  readonly handedOffAtMs: number | null;
  readonly error: string | null;
  /** A stop arrived too late to cancel the setup: stop the turn once it starts. */
  readonly interruptOnStart: boolean;
}

export interface WorktreeSetupStageView {
  readonly id: WorktreeSetupStageId;
  readonly status: WorktreeSetupStageStatus;
  readonly label: string;
  readonly percent: number | null;
  readonly detail: string | null;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
}

const STAGE_LABELS: Record<WorktreeSetupStageId, string> = {
  fetch: "Fetch",
  checkout: "Check out files",
  "setup-script": "Run setup script",
  agent: "Start agent",
};

function stageLabel(id: WorktreeSetupStageId, baseRef: string, scriptName: string | null): string {
  if (id === "fetch") return `${STAGE_LABELS.fetch} ${baseRef}`;
  if (id === "setup-script" && scriptName) return `${STAGE_LABELS["setup-script"]} · ${scriptName}`;
  return STAGE_LABELS[id];
}

/**
 * Every stage of the launch, in order, from the node's feed when it has one.
 * Before the first snapshot all stages wait (a fetch the send skips is
 * skipped), so a view can lay out every row from the first frame.
 */
export function resolveWorktreeSetupStages(
  launch: Pick<WorktreeLaunch, "snapshot" | "baseRef" | "fetchOrigin">,
): ReadonlyArray<WorktreeSetupStageView> {
  const byId = new Map<WorktreeSetupStageId, WorktreeSetupStage>(
    (launch.snapshot?.stages ?? []).map((stage) => [stage.id, stage]),
  );
  const baseRef = launch.snapshot?.baseRef ?? launch.baseRef;
  const scriptName = byId.get("setup-script")?.detail ?? null;
  return WORKTREE_SETUP_STAGE_IDS.map((id) => {
    const stage = byId.get(id);
    const status: WorktreeSetupStageStatus =
      stage?.status ?? (id === "fetch" && !launch.fetchOrigin ? "skipped" : "pending");
    return {
      id,
      status,
      label: stageLabel(id, baseRef, scriptName),
      percent: stage?.percent ?? null,
      detail: id === "setup-script" ? null : (stage?.detail ?? null),
      startedAt: stage?.startedAt ?? null,
      finishedAt: stage?.finishedAt ?? null,
    };
  });
}

/** Whether the launch still owns the thread's working row (setup on screen). */
export function isWorktreeLaunchSettingUp(launch: WorktreeLaunch | null | undefined): boolean {
  return launch?.phase === "preparing" || launch?.phase === "cancelling";
}

export interface WorktreeSetupScriptChip {
  readonly name: string;
  readonly status: "running" | "done" | "failed";
  readonly terminalId: string | null;
  /** When the script's process went away; null while it runs. */
  readonly finishedAt: string | null;
}

/**
 * The setup script that outlived the hand-off: it never blocks the agent, so
 * once the card folds away it continues as a chip beside the working label.
 */
export function resolveWorktreeSetupScriptChip(
  launch: WorktreeLaunch | null | undefined,
): WorktreeSetupScriptChip | null {
  if (!launch || launch.phase !== "handed-off") return null;
  const stage = launch.snapshot?.stages.find((candidate) => candidate.id === "setup-script");
  if (
    !stage ||
    (stage.status !== "running" && stage.status !== "done" && stage.status !== "failed")
  )
    return null;
  return {
    name: stage.detail ?? "Setup script",
    status: stage.status,
    terminalId: launch.snapshot?.setupTerminalId ?? null,
    finishedAt: stage.status === "running" ? null : (stage.finishedAt ?? null),
  };
}

/** The feed has nothing more to say: the setup ended and no script still runs. */
export function isWorktreeSetupFeedSettled(snapshot: WorktreeSetupSnapshot): boolean {
  if (snapshot.status === "running") return false;
  return !snapshot.stages.some((stage) => stage.status === "running");
}

/**
 * When the thread's working state started, if a launch owns it: the send, for
 * the whole setup and the turn it launched. Later turns count as usual.
 */
export function resolveWorktreeLaunchWorkStartedAt(
  launch: WorktreeLaunch | null | undefined,
  messages: ReadonlyArray<{ readonly role: string }> | undefined,
): string | null {
  if (!launch) return null;
  if (launch.phase !== "handed-off") return launch.startedAt;
  let userMessages = 0;
  for (const message of messages ?? []) {
    if (message.role === "user") userMessages += 1;
    if (userMessages > 1) return null;
  }
  return launch.startedAt;
}
