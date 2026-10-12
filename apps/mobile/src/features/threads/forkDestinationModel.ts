import { resolveChatsAvailability } from "@ryco/client-runtime/state/composer";
import {
  alignThreadForkSelection,
  defaultThreadForkBaseRef,
  isMaterializableCheckpointSummary,
  isThreadForkAttemptDismissible,
  listThreadForkDestinations,
  listThreadForkWorktreeStarts,
  resolveThreadForkSourceGit,
  THREAD_FORK_COPY,
  threadForkAttemptView,
  type ThreadForkAttemptController,
  type ThreadForkAttemptNotice,
  type ThreadForkAttemptSnapshot,
  type ThreadForkDestinationKind,
  type ThreadForkDestinationOption,
  type ThreadForkSelection,
  type ThreadForkWorktreeStartKind,
  type ThreadForkWorktreeStartOption,
  type TurnDiffSummary,
} from "@ryco/client-runtime/state/threads";
import type { EnvironmentId, MessageId, ServerConfig, ThreadId, TurnId } from "@ryco/contracts";
import { isChatProject, type ProjectKindCarrier } from "@ryco/shared/projectKind";

// The native fork sheet's presentation, kept out of the component (react-native cannot load
// under Vitest). Keys, locks, retries, what the form shows and every label and notice come from
// the shared fork-attempt controller, state machine and fork helpers in client-runtime; this
// module only maps them onto the sheet's rows and decides when the screen offers "Fork from
// here".

/**
 * Whether "Fork from here" is offered on this thread at all. Each input closes it on its own:
 * - `mutationReady`: the environment's role-aware readiness (a hosted viewer never forks);
 * - `actionsDisabled`: the thread is rendered from cache or a degraded retarget;
 * - `serverCapability`: the node advertises `threadFork` (absent on older nodes);
 * - `forkApiAvailable`: the live client exposes `threads.fork`.
 * The node re-checks everything, including the operator role.
 */
export function isThreadForkOffered(input: {
  readonly mutationReady: boolean | null | undefined;
  readonly actionsDisabled: boolean;
  readonly serverCapability: boolean | null | undefined;
  readonly forkApiAvailable: boolean;
}): boolean {
  return (
    input.mutationReady === true &&
    !input.actionsDisabled &&
    input.serverCapability === true &&
    input.forkApiAvailable
  );
}

/** One opening of the sheet on one reply, and the attempt it drives. */
export interface ForkSheetRequest {
  readonly environmentId: EnvironmentId;
  readonly sourceThreadId: ThreadId;
  readonly sourceTitle: string;
  readonly messageId: MessageId;
  readonly turnId: TurnId;
  readonly excerpt: string;
}

export interface ForkSheetHandle {
  readonly request: ForkSheetRequest;
  readonly controller: ThreadForkAttemptController;
  /** False while the sheet slides away; a new opening is a new handle. */
  readonly visible: boolean;
}

/**
 * The sheet a screen showing `target` may keep. A sheet opened on another thread (the screen was
 * retargeted by `navigate`) is dropped for good rather than hidden, so it never pops up again on
 * its own when the screen comes back; its attempt stays in the shared registry for a reopen.
 */
export function forkSheetOnTarget(
  sheet: ForkSheetHandle | null,
  target: { readonly environmentId: EnvironmentId; readonly threadId: ThreadId },
): ForkSheetHandle | null {
  return sheet !== null &&
    sheet.request.environmentId === target.environmentId &&
    sheet.request.sourceThreadId === target.threadId
    ? sheet
    : null;
}

/** What the sheet needs to know about the source thread to list its destinations. */
export interface ForkSheetSource {
  readonly isChat: boolean;
  /** A confirmed answer for the project root; null while the status is unknown. */
  readonly isGitRepo: boolean | null;
  readonly chatsAvailable: boolean;
  readonly sourceWorktreePath: string | null;
  readonly sourceBranch: string | null;
  /** The selected turn has a captured checkpoint a new worktree can start from. */
  readonly checkpointAvailable: boolean;
}

export function buildForkSheetSource(input: {
  readonly project: ProjectKindCarrier | null | undefined;
  /**
   * The project root's VCS status read (`useRepositoryStatus`): a status, or the failure of the
   * last read. A failed read is not "still checking": it resolves like web, as not a repository.
   */
  readonly repository: {
    readonly data: { readonly isRepo: boolean } | null;
    readonly error: unknown;
  } | null;
  /** This environment's server config, never the active environment's atom. */
  readonly serverConfig: Pick<ServerConfig, "chats"> | null | undefined;
  readonly thread: {
    readonly worktreePath: string | null;
    readonly branch: string | null;
    readonly turnDiffSummaries: ReadonlyArray<TurnDiffSummary>;
  } | null;
  readonly turnId: TurnId | null;
}): ForkSheetSource {
  const isChat = isChatProject(input.project);
  return {
    isChat,
    isGitRepo: resolveThreadForkSourceGit({
      isChat,
      status: input.repository ?? { data: null, error: null },
    }),
    chatsAvailable: resolveChatsAvailability(input.serverConfig).available,
    sourceWorktreePath: input.thread?.worktreePath ?? null,
    sourceBranch: input.thread?.branch ?? null,
    checkpointAvailable:
      input.turnId !== null &&
      isMaterializableCheckpointSummary(
        input.thread?.turnDiffSummaries.find((summary) => summary.turnId === input.turnId),
      ),
  };
}

/**
 * The form a new attempt opens with: the source's first destination (the shared list's order)
 * with its start left to the first enabled option, and the base ref prefilled.
 */
export function initialForkSheetSelection(input: {
  readonly isChat: boolean;
  readonly sourceBranch: string | null;
}): ThreadForkSelection {
  return {
    destination: input.isChat ? "new-chat" : "current-checkout",
    worktreeStart: null,
    baseRef: defaultThreadForkBaseRef(input.sourceBranch),
  };
}

export interface ForkSheetModel {
  readonly destinations: ReadonlyArray<ThreadForkDestinationOption>;
  /** The selected destination; null when none is enabled (chats unavailable). */
  readonly destination: ThreadForkDestinationKind | null;
  /** Shown while a new worktree is selected; empty otherwise. */
  readonly worktreeStarts: ReadonlyArray<ThreadForkWorktreeStartOption>;
  readonly worktreeStart: ThreadForkWorktreeStartKind | null;
  readonly showBaseRef: boolean;
  readonly baseRef: string;
  /** The options and the base ref can change (never while the attempt is locked or in flight). */
  readonly editable: boolean;
  /** What "Fork" sends from while editable: the effective selection. */
  readonly selection: ThreadForkSelection | null;
  readonly canSubmit: boolean;
  /** A request or the new fork's opening is in flight. */
  readonly busy: boolean;
  /** The primary button: Fork, Retry or Check again, or the busy label while busy. */
  readonly actionLabel: string;
  /** Cancel, swipe and Android back may close the sheet. */
  readonly canDismiss: boolean;
  readonly notice: ThreadForkAttemptNotice | null;
  /** Why the selection cannot be sent yet. */
  readonly selectionError: string | null;
  /** The node stopped being ready while the sheet was open (cached, reconnecting, viewer). */
  readonly notReady: boolean;
}

/**
 * Everything the sheet renders. While editable, a pick that became unavailable (Git turned out
 * not to be a repository, the node refused the checkpoint) shows and sends the first enabled
 * option instead. While the attempt is locked or in flight, the rows show the request the node
 * may hold, which is the only one that can go out again (`alignThreadForkSelection`).
 */
export function deriveForkSheetModel(input: {
  readonly source: ForkSheetSource;
  readonly snapshot: ThreadForkAttemptSnapshot;
  /** The thread can fork right now (`isThreadForkOffered`). */
  readonly ready: boolean;
}): ForkSheetModel {
  const { source, snapshot, ready } = input;
  const { attempt, opening } = snapshot;
  const destinations = listThreadForkDestinations(source);
  const starts = listThreadForkWorktreeStarts({
    checkpointAvailable: source.checkpointAvailable && !attempt.checkpointRefused,
  });
  const shown = alignThreadForkSelection(attempt, { destinations, worktreeStarts: starts });
  const view = threadForkAttemptView(shown);
  const { selection } = shown;
  // While editable, a destination with no enabled option (chats unavailable) sends nothing.
  const destination =
    view.canEdit &&
    !destinations.some((option) => option.kind === selection.destination && option.enabled)
      ? null
      : selection.destination;
  const worktreeStarts = destination === "new-worktree" ? starts : [];
  const worktreeStart = destination === "new-worktree" ? (selection.worktreeStart ?? null) : null;
  const baseRef = selection.baseRef ?? "";
  const sendable: ThreadForkSelection | null =
    destination === null ? null : { destination, worktreeStart, baseRef };
  const unavailable =
    view.canEdit && sendable === null
      ? (destinations.find((option) => option.disabledReason)?.disabledReason ??
        THREAD_FORK_COPY.errors["destination-unavailable"])
      : null;
  const busy = attempt.phase === "submitting" || opening;
  return {
    destinations,
    destination,
    worktreeStarts,
    worktreeStart,
    showBaseRef: worktreeStart === "base-ref",
    baseRef,
    editable: view.canEdit && !opening,
    selection: sendable,
    canSubmit: ready && !opening && unavailable === null && view.canSubmit,
    busy,
    // Opening a fork that exists says so, never "Creating fork…".
    actionLabel: opening ? THREAD_FORK_COPY.busy.opening : (view.busyLabel ?? view.submitLabel),
    canDismiss: isThreadForkAttemptDismissible(snapshot),
    notice: view.notice,
    selectionError: unavailable ?? view.selectionError,
    notReady: !ready && !busy,
  };
}
