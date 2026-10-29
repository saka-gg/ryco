/**
 * Pure rules for following a checkout's branch into its thread and workspace
 * records: when a branch is adopted, which provider events ask for a sync, which
 * turns shared a checkout, and how queued sync requests merge.
 *
 * Loaded with the thread git metadata runtime, off the server's boot path.
 *
 * @module threadGitMetadata
 */
import type { ProviderRuntimeEvent, ThreadId } from "@ryco/contracts";
import { isTemporaryWorktreeBranch } from "@ryco/shared/git";
import { readToolCommandText } from "@ryco/shared/toolActivity";
import {
  classifyVcsCommand,
  mergeVcsCommandEffects,
  type VcsCommandEffect,
} from "@ryco/shared/vcsCommand";

export type ThreadBranchAdoptionSkip =
  | "unchanged"
  | "detached"
  | "temporary"
  | "invalid"
  | "unreadable";

export type ThreadBranchAdoption =
  | { readonly _tag: "skip"; readonly reason: ThreadBranchAdoptionSkip }
  | {
      readonly _tag: "adopt";
      readonly branch: string;
      /** Null: the thread already records `branch`. */
      readonly thread: { readonly expectedBranch: string | null } | null;
      /** Null: no dedicated workspace record, or it already records `branch`. */
      readonly worktree: { readonly expectedBranch: string } | null;
    };

/**
 * Whether git accepts `name` as a branch (`git check-ref-format --branch`). HEAD
 * is read from a plain file, so a hand-written or corrupt HEAD could otherwise
 * put an option-like or malformed name into records that later reach git argv
 * (missing-worktree recovery passes the thread's branch to `git worktree add`).
 */
export function isAdoptableBranchName(name: string): boolean {
  if (name.length === 0 || name === "@" || name === "HEAD") return false;
  for (let index = 0; index < name.length; index += 1) {
    const code = name.charCodeAt(index);
    // Control characters, space and DEL.
    if (code <= 32 || code === 127) return false;
  }
  // ~ ^ : ? * [ and backslash; "..", "@{", "//"; a leading "-", "/" or "."; a component that starts
  // with "." or ends with ".lock"; a trailing "/" or ".".
  return !/[~^:?*[\\]|\.\.|@\{|\/\/|^[-/.]|\/\.|\.lock(?:\/|$)|[/.]$/u.test(name);
}

/**
 * Whether the thread (and its own workspace record) should follow the branch
 * its checkout is on. Rules, in order: an unreadable HEAD, a detached HEAD
 * (rebases and bisects in progress), a temporary branch (only worktree creation
 * puts a checkout there, and it records it), a name git would refuse, and
 * records that already agree are all skipped. Never adopts `null`. Whether
 * another thread shared the checkout is checked by the caller, only for an
 * adoption (it reads other threads).
 */
export function decideThreadBranchAdoption(input: {
  readonly threadBranch: string | null;
  /** The thread's own workspace record (not the main checkout, live, same path), else null. */
  readonly worktree: { readonly branch: string } | null;
  /** undefined: HEAD unreadable; null: detached HEAD. */
  readonly observedBranch: string | null | undefined;
  readonly worktreeBranchPrefix: string;
}): ThreadBranchAdoption {
  const observed = input.observedBranch;
  if (observed === undefined) return { _tag: "skip", reason: "unreadable" };
  if (observed === null) return { _tag: "skip", reason: "detached" };
  if (isTemporaryWorktreeBranch(observed, input.worktreeBranchPrefix)) {
    return { _tag: "skip", reason: "temporary" };
  }
  if (!isAdoptableBranchName(observed)) return { _tag: "skip", reason: "invalid" };
  const thread = input.threadBranch === observed ? null : { expectedBranch: input.threadBranch };
  const worktree =
    input.worktree === null || input.worktree.branch === observed
      ? null
      : { expectedBranch: input.worktree.branch };
  if (thread === null && worktree === null) return { _tag: "skip", reason: "unchanged" };
  return { _tag: "adopt", branch: observed, thread, worktree };
}

/** Which other threads ran turns while a thread's turns ran. */
export interface TurnOverlap {
  /** False when a turn in the window started before this process saw it: ownership unknown. */
  readonly tracked: boolean;
  /** Threads whose turns ran at the same time, at any point. */
  readonly overlaps: ReadonlySet<ThreadId>;
  /** More threads overlapped than are recorded: treat the checkout as shared. */
  readonly overflowed: boolean;
}

const NO_THREADS: ReadonlySet<ThreadId> = new Set();

/** A turn this process never saw start (it began before the server subscribed). */
export const UNTRACKED_TURN: TurnOverlap = {
  tracked: false,
  overlaps: NO_THREADS,
  overflowed: false,
};

/** Both windows: overlaps unioned, tracked only when both were. */
export function combineTurnOverlaps(left: TurnOverlap, right: TurnOverlap): TurnOverlap {
  const overlaps =
    right.overlaps.size === 0
      ? left.overlaps
      : left.overlaps.size === 0
        ? right.overlaps
        : new Set([...left.overlaps, ...right.overlaps]);
  return {
    tracked: left.tracked && right.tracked,
    overlaps,
    overflowed: left.overflowed || right.overflowed,
  };
}

export interface ThreadTurnOwnership {
  /** Idempotent for the same turn; a new turn id replaces a turn whose end was missed. */
  readonly start: (threadId: ThreadId, turnId: string) => void;
  /**
   * The thread's turn `turnId` ended. Null when the thread runs another turn or
   * already ended this one (a stray, late or repeated end, which must neither end
   * ownership nor pass for a turn this process never saw); {@link UNTRACKED_TURN}
   * when no turn was tracked (it started before this process subscribed).
   */
  readonly end: (threadId: ThreadId, turnId: string) => TurnOverlap | null;
  /** The thread's session ended: so did its running turn. Null when none was tracked. */
  readonly endSession: (threadId: ThreadId) => TurnOverlap | null;
  /** The running turn's overlap so far; null when the thread runs no tracked turn. */
  readonly current: (threadId: ThreadId) => TurnOverlap | null;
  readonly running: () => ReadonlyArray<ThreadId>;
}

interface RunningTurn {
  readonly turnId: string;
  readonly overlaps: Set<ThreadId>;
  overflowed: boolean;
}

export function makeThreadTurnOwnership(options?: {
  /** Running turns tracked at once; the oldest is forgotten past it (it then reads as untracked). */
  readonly maxRunning?: number;
  /** Overlapping threads recorded per turn; past it the turn counts as shared. */
  readonly maxOverlaps?: number;
}): ThreadTurnOwnership {
  const maxRunning = Math.max(1, options?.maxRunning ?? 4_096);
  const maxOverlaps = Math.max(0, options?.maxOverlaps ?? 64);
  const runningTurns = new Map<ThreadId, RunningTurn>();
  /**
   * The turn each thread ended last (as many threads as `maxRunning`, least recent
   * dropped), so a second end of it (a stop and then a completion, or a session
   * exit and then the stop) is ignored instead of read as untracked.
   */
  const endedTurns = new Map<ThreadId, string>();
  const rememberEnded = (threadId: ThreadId, turnId: string) => {
    endedTurns.delete(threadId);
    endedTurns.set(threadId, turnId);
    if (endedTurns.size > maxRunning) {
      const oldest = endedTurns.keys().next();
      if (!oldest.done) endedTurns.delete(oldest.value);
    }
  };

  const addOverlap = (turn: RunningTurn, threadId: ThreadId) => {
    if (turn.overlaps.has(threadId)) return;
    if (turn.overlaps.size >= maxOverlaps) {
      turn.overflowed = true;
      return;
    }
    turn.overlaps.add(threadId);
  };
  const snapshot = (turn: RunningTurn): TurnOverlap => ({
    tracked: true,
    overlaps: new Set(turn.overlaps),
    overflowed: turn.overflowed,
  });

  return {
    start: (threadId, turnId) => {
      const existing = runningTurns.get(threadId);
      if (existing?.turnId === turnId) return;
      if (existing === undefined && runningTurns.size >= maxRunning) {
        const oldest = runningTurns.keys().next();
        if (!oldest.done) runningTurns.delete(oldest.value);
      }
      // A missed end keeps what the earlier turn overlapped: the checkout may still carry it.
      const turn: RunningTurn = {
        turnId,
        overlaps: existing?.overlaps ?? new Set(),
        overflowed: existing?.overflowed ?? false,
      };
      for (const [otherId, other] of runningTurns) {
        if (otherId === threadId) continue;
        addOverlap(turn, otherId);
        addOverlap(other, threadId);
      }
      runningTurns.delete(threadId);
      runningTurns.set(threadId, turn);
    },
    end: (threadId, turnId) => {
      const turn = runningTurns.get(threadId);
      if (turn === undefined) {
        return endedTurns.get(threadId) === turnId ? null : UNTRACKED_TURN;
      }
      if (turn.turnId !== turnId) return null;
      runningTurns.delete(threadId);
      rememberEnded(threadId, turnId);
      return snapshot(turn);
    },
    endSession: (threadId) => {
      const turn = runningTurns.get(threadId);
      if (turn === undefined) return null;
      runningTurns.delete(threadId);
      rememberEnded(threadId, turn.turnId);
      return snapshot(turn);
    },
    current: (threadId) => {
      const turn = runningTurns.get(threadId);
      return turn === undefined ? null : snapshot(turn);
    },
    running: () => [...runningTurns.keys()],
  };
}

/** What one queued sync of a thread covers; requests that arrive before it runs merge in. */
export interface ThreadGitSyncRequest {
  readonly turnStart: boolean;
  /** What the finished git or forge commands may have changed; null for none. */
  readonly command: VcsCommandEffect | null;
  /**
   * The provider's own git and pull request signals, by the directory each command finished in.
   * One counts only once the sync finds that directory inside the thread's checkout or its
   * repository: the directory is a hint, and a signal from elsewhere changed nothing here.
   * Null for none.
   */
  readonly signals: ReadonlyMap<string, VcsCommandEffect> | null;
  readonly turnEnd: { readonly overlap: TurnOverlap; readonly aborted: boolean } | null;
  /** A remote refresh held back by the per-checkout spacing is now due. */
  readonly remoteDue: boolean;
}

export const EMPTY_SYNC_REQUEST: ThreadGitSyncRequest = {
  turnStart: false,
  command: null,
  signals: null,
  turnEnd: null,
  remoteDue: false,
};

/**
 * Signal directories one queued sync keeps apart. Past it a signal counts as if it had named no
 * directory: over-counting costs one re-read, losing one a missed refresh.
 */
export const MAX_SIGNAL_DIRECTORIES = 8;

export function mergeThreadGitSyncRequests(
  current: ThreadGitSyncRequest | undefined,
  next: ThreadGitSyncRequest,
): ThreadGitSyncRequest {
  if (current === undefined) return next;
  const turnEnd =
    current.turnEnd === null
      ? next.turnEnd
      : next.turnEnd === null
        ? current.turnEnd
        : {
            overlap: combineTurnOverlaps(current.turnEnd.overlap, next.turnEnd.overlap),
            aborted: current.turnEnd.aborted || next.turnEnd.aborted,
          };
  let command = mergeVcsCommandEffects(current.command, next.command);
  let signals = current.signals;
  if (next.signals !== null) {
    if (signals === null) {
      signals = next.signals;
    } else {
      const merged = new Map(signals);
      for (const [cwd, effect] of next.signals) {
        const known = merged.get(cwd);
        if (known !== undefined || merged.size < MAX_SIGNAL_DIRECTORIES) {
          merged.set(cwd, mergeVcsCommandEffects(known ?? null, effect) ?? effect);
        } else {
          command = mergeVcsCommandEffects(command, effect);
        }
      }
      signals = merged;
    }
  }
  return {
    turnStart: current.turnStart || next.turnStart,
    command,
    signals,
    turnEnd,
    remoteDue: current.remoteDue || next.remoteDue,
  };
}

/**
 * The effect of the signals whose directory `counts` (lies in the repository of the thread's
 * checkout), merged; null when none does.
 */
export function countedSignalEffect(
  signals: ReadonlyMap<string, VcsCommandEffect> | null,
  counts: (cwd: string) => boolean,
): VcsCommandEffect | null {
  if (signals === null) return null;
  let effect: VcsCommandEffect | null = null;
  for (const [cwd, signal] of signals) {
    if (counts(cwd)) effect = mergeVcsCommandEffects(effect, signal);
  }
  return effect;
}

/**
 * Only commands or signals to settle: the sync waits briefly so a burst of them reads HEAD once
 * (and a signal meets the command it reports).
 */
export function isCommandOnlyRequest(request: ThreadGitSyncRequest): boolean {
  return (
    (request.command !== null || request.signals !== null) &&
    !request.turnStart &&
    request.turnEnd === null &&
    !request.remoteDue
  );
}

const SIGNAL_LOCAL: VcsCommandEffect = { local: true, remote: false };
const SIGNAL_REMOTE: VcsCommandEffect = { local: false, remote: true };
const SIGNAL_BOTH: VcsCommandEffect = { local: true, remote: true };

/**
 * What a provider's git or pull request signal may have changed. A push and a pull request
 * change reach the remote; checking a pull request out also moves HEAD. Every other kind (commit,
 * merge, rebase, one a newer CLI adds) is local. Adapters send only changes: an announcement of
 * what already was (Claude's `started`) never becomes a signal.
 */
export function vcsSignalEffect(payload: {
  readonly kind: string;
  readonly action?: string | undefined;
}): VcsCommandEffect {
  if (payload.kind === "push") return SIGNAL_REMOTE;
  if (payload.kind !== "change-request") return SIGNAL_LOCAL;
  return payload.action === "checked-out" ? SIGNAL_BOTH : SIGNAL_REMOTE;
}

export type GitSyncTrigger =
  | { readonly kind: "turn-start"; readonly turnId: string }
  | {
      readonly kind: "command";
      readonly effect: VcsCommandEffect;
      /**
       * Where a provider signal says the command ran; it counts only inside the repository of
       * the thread's checkout. Undefined for a command seen in a tool call's text, and for a
       * signal that names no directory (both count without a check).
       */
      readonly cwd?: string;
    }
  | { readonly kind: "turn-end"; readonly turnId: string; readonly aborted: boolean }
  | { readonly kind: "session-exit" };

/**
 * What one provider event asks of the thread's git sync; null for almost all.
 * Turn ends without a turn id are ignored: an untargeted completion (Claude's
 * resume handshake) proves no turn. `runtime.error` can be retried, so it ends
 * nothing. Copilot tool items carry no command, so Copilot threads sync at turn
 * boundaries only. A provider's own git signal (`vcs.state.changed`, Claude)
 * also catches pushes and pull requests inside scripts and aliases; Claude
 * sends none for a branch switch, which the command text and the turn
 * boundaries still catch.
 */
export function gitSyncTriggerFor(event: ProviderRuntimeEvent): GitSyncTrigger | null {
  switch (event.type) {
    case "turn.started":
      return event.turnId === undefined ? null : { kind: "turn-start", turnId: event.turnId };
    case "turn.completed":
    case "turn.aborted":
      return event.turnId === undefined
        ? null
        : { kind: "turn-end", turnId: event.turnId, aborted: event.type === "turn.aborted" };
    case "session.exited":
      return { kind: "session-exit" };
    case "item.completed": {
      const { itemType, status, detail, data } = event.payload;
      if (itemType !== "command_execution" || status === "declined") return null;
      const command = readToolCommandText({ itemType, detail, data });
      const effect = command === undefined ? null : classifyVcsCommand(command);
      return effect === null ? null : { kind: "command", effect };
    }
    case "vcs.state.changed": {
      const effect = vcsSignalEffect(event.payload);
      const { cwd } = event.payload;
      return cwd === undefined ? { kind: "command", effect } : { kind: "command", effect, cwd };
    }
    default:
      return null;
  }
}
