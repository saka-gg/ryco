/**
 * Shared client side of chat forking (`threads.fork`, docs/thread-forks.md): which replies can be
 * forked, which destinations a thread offers, the copy both apps show, and one guarded call.
 * The fork dialog's state (keys, locks, retries) lives in `threadForkAttempt.ts`. Web, desktop and
 * mobile add only presentation and navigation.
 *
 * The server owns every decision that matters (boundary, inherited history, checkout, provider
 * context); these helpers are hints that keep the UI honest and are re-checked by the node.
 */
import {
  ThreadForkAttemptState,
  ThreadForkBaseRef,
  ThreadForkErrorReason,
  ThreadForkInput,
  ThreadForkKey,
  type EnvironmentApi,
  type MessageId,
  type OrchestrationLatestTurn,
  type ThreadForkDestination,
  type ThreadForkResult,
  type ThreadForkWorktreeStart,
  type ThreadId,
} from "@ryco/contracts";
import { htmlRenderOfAttachment } from "@ryco/shared/htmlRender";
import { selectFinalTurnReplies } from "@ryco/shared/turnReply";
import { Schema } from "effect";

import { isAwaitingAdmission, RpcRequestRefusedError } from "../../rpc/protocol.ts";
import { RpcTransportDisposedError } from "../../rpc/wsTransport.ts";
import type { ChatAttachment, ChatMessage, ThreadSession } from "./types.ts";

export type ThreadForkDestinationKind = ThreadForkDestination["kind"];
export type ThreadForkWorktreeStartKind = ThreadForkWorktreeStart["kind"];

/**
 * What each refusal means, without claiming anything about what the node kept: that depends on
 * the error's `attempt` and is added by `threadForkFailureMessage`.
 */
const THREAD_FORK_ERROR_COPY = {
  unavailable: "Forking isn't available for this thread on this machine.",
  "source-unavailable": "The original thread was deleted or moved to Trash.",
  "boundary-unsupported": "You can only fork from the final reply of a completed turn.",
  "boundary-stale": "This reply changed or no longer exists. Choose a reply again.",
  "source-busy": "The original thread is busy, for example reverting.",
  "destination-unavailable": "That destination isn't available for this thread anymore.",
  "checkpoint-unavailable":
    "This turn has no checkpoint that can start a worktree. Start from a branch or commit instead.",
  "base-ref-invalid": "Git couldn't find that branch or commit.",
  "idempotency-conflict": "A fork from this reply was already requested with different options.",
  "preparation-failed": "Preparing the fork didn't finish.",
  deleted: "This fork was created earlier, but it has since been deleted.",
} as const satisfies Record<ThreadForkErrorReason, string>;

/**
 * What the node said it holds for the key (`ThreadForkError.attempt`). Only `none` and `stopped`
 * may say nothing is left: a `stopped` attempt released what it created before the node answered.
 */
const THREAD_FORK_ATTEMPT_COPY = {
  none: "Nothing was created.",
  noneRetry: "Nothing was created. Try again in a moment.",
  stopped: "Nothing was left behind.",
  stoppedRetry: "Nothing was left behind. Retry to start it again.",
  running:
    "The fork is still being prepared and will finish on its own. Retry to check on it; that never starts a second fork.",
  /** A conflicting request under the key is still being prepared; it cannot be checked from here. */
  runningElsewhere:
    "That fork is still being prepared and will appear in your threads when it finishes.",
} as const;

/** Platform-neutral wording for the fork dialog, its outcomes and its destinations. */
export const THREAD_FORK_COPY = {
  action: "Fork from here",
  dialogTitle: "Fork from here",
  dialogDescription:
    "Start a new thread with this conversation up to and including this reply. Later messages aren't copied, and the original thread doesn't change.",
  destinationHeading: "Work in",
  destinations: {
    currentWorktree: "This worktree",
    currentCheckout: "The current checkout",
    currentFolder: "This folder",
    currentDescription:
      "Shares the original's files as they are now. Nothing is copied or rewound.",
    currentBranchDescription: (branch: string) =>
      `Shares ${branch} with the original as it is now. Nothing is copied or rewound.`,
    newWorktree: "New worktree",
    newWorktreeDescription: "A separate worktree on a new branch, so changes stay apart.",
    checkingGit: "Checking Git…",
    newChat: "New chat",
    newChatDescription: "A new chat with an empty folder. Files from this chat aren't copied.",
    chatsUnavailable: "Chats aren't available on this machine.",
  },
  worktreeStartHeading: "Start from",
  worktreeStarts: {
    checkpoint: "Saved checkpoint of this turn",
    checkpointDescription:
      "Files match the end of this turn. Ignored files such as .env aren't included.",
    checkpointUnavailable: "This turn has no saved checkpoint.",
    baseRef: "Branch or commit",
    baseRefDescription:
      "Files come from this ref and may differ from this point in the conversation.",
    baseRefRequired: "Enter a branch or commit.",
    baseRefTooLong: "Branch and commit names can't be longer than 256 characters.",
  },
  worktreeStartRequired: "Choose where the worktree starts.",
  providerNote:
    "Codex and Claude continue an independent copy of their session up to this reply. Other providers start a fresh session that receives this conversation as context; their tool results and reasoning aren't carried over.",
  submit: "Fork",
  cancel: "Cancel",
  retry: "Retry",
  /** The primary action while the node is still preparing the fork: it asks again, same key. */
  checkAgain: "Check again",
  busy: {
    preparingWorktree: "Preparing worktree…",
    creating: "Creating fork…",
    /** The fork exists; the dialog waits for its thread to arrive before opening it. */
    opening: "Opening the fork…",
  },
  /** Notice headlines; which one applies is decided by `threadForkAttemptView`. */
  titles: {
    notCreated: "The fork wasn't created",
    failed: "Couldn't create the fork",
    uncertain: "The fork may have been created",
    running: "The fork is still being prepared",
    notSent: "Nothing was sent",
  },
  uncertain:
    "Ryco couldn't confirm whether the fork was created. Retry to find out; retrying never creates a second fork.",
  created: "The fork was created.",
  running: THREAD_FORK_ATTEMPT_COPY.running,
  refusedForbidden: "You don't have permission to fork threads on this machine.",
  /** Pass to `captureReviewedSendReadiness` as its message. */
  connectionChanged:
    "The connection changed while you were choosing. Nothing was sent; try again once it reconnects.",
  errors: THREAD_FORK_ERROR_COPY,
  attempts: THREAD_FORK_ATTEMPT_COPY,
} as const;

/** How long a client waits for a new fork's thread to reach its shell stream before it stops. */
export const THREAD_FORK_SHELL_TIMEOUT_MS = 12_000;

/**
 * What a typed refusal tells the user: the reason, then what the node kept for the key. Never
 * claims nothing is left unless the node reported `none` or `stopped`.
 */
export function threadForkFailureMessage(input: {
  readonly reason: ThreadForkErrorReason;
  readonly retryable: boolean;
  readonly attempt: ThreadForkAttemptState;
}): string {
  const base = THREAD_FORK_ERROR_COPY[input.reason];
  const copy = THREAD_FORK_ATTEMPT_COPY;
  if (input.reason === "idempotency-conflict") {
    return input.attempt === "running" ? `${base} ${copy.runningElsewhere}` : base;
  }
  // A deleted fork existed; "nothing was created" would be false.
  if (input.reason === "deleted") return base;
  switch (input.attempt) {
    case "none":
      return `${base} ${input.retryable ? copy.noneRetry : copy.none}`;
    case "stopped":
      return `${base} ${input.retryable ? copy.stoppedRetry : copy.stopped}`;
    case "running":
      return `${base} ${copy.running}`;
  }
}

// ── Eligibility ────────────────────────────────────────────────────────

type ForkReplyMessage = Pick<
  ChatMessage,
  "id" | "role" | "streaming" | "turnId" | "text" | "attachments"
>;

export interface ThreadForkReplyContext {
  readonly latestTurn: Pick<OrchestrationLatestTurn, "turnId" | "state"> | null | undefined;
  readonly session: Pick<ThreadSession, "activeTurnId"> | null | undefined;
}

function isSettledReply(message: ForkReplyMessage, context: ThreadForkReplyContext): boolean {
  if (message.role !== "assistant" || message.streaming || !message.turnId) return false;
  if (context.session?.activeTurnId === message.turnId) return false;
  return !(
    context.latestTurn?.turnId === message.turnId && context.latestTurn.state !== "completed"
  );
}

/**
 * The replies "Fork from here" may be offered on, in one pass: per turn, the reply the turn ended
 * on (`selectFinalTurnReplies`, the rule the node's boundary check uses: an attachment-only page
 * or file never displaces the turn's text reply, and a later steer disqualifies it), when it is
 * settled. Older turns' outcomes are not loaded on the client; the node rejects an interrupted or
 * failed one with `boundary-unsupported`.
 */
export function deriveForkableReplyMessageIds(
  input: ThreadForkReplyContext & { readonly messages: ReadonlyArray<ForkReplyMessage> },
): ReadonlySet<MessageId> {
  const eligible = new Set<MessageId>();
  for (const reply of selectFinalTurnReplies(input.messages).values()) {
    if (isSettledReply(reply, input)) eligible.add(reply.id);
  }
  return eligible;
}

// ── Destinations ───────────────────────────────────────────────────────

export interface ThreadForkOption<Kind extends string> {
  readonly kind: Kind;
  readonly label: string;
  readonly description: string;
  readonly enabled: boolean;
  readonly disabledReason?: string;
}

export type ThreadForkDestinationOption = ThreadForkOption<ThreadForkDestinationKind>;
export type ThreadForkWorktreeStartOption = ThreadForkOption<ThreadForkWorktreeStartKind>;

/**
 * Whether the source's checkout is a Git repository, as far as this client knows: a chat folder
 * never is; otherwise only a loaded status answers (null while it loads, so "New worktree" stays
 * disabled rather than guessed). A failed status read counts as not a repository: the node would
 * refuse a new worktree it cannot verify either.
 */
export function resolveThreadForkSourceGit(input: {
  readonly isChat: boolean;
  readonly status: {
    readonly data: { readonly isRepo: boolean } | null | undefined;
    readonly error: unknown;
  };
}): boolean | null {
  if (input.isChat) return false;
  if (input.status.data) return input.status.data.isRepo;
  return input.status.error ? false : null;
}

/**
 * The destinations a source thread offers, in display order:
 * - a projectless chat: a new chat only (one thread per chat; its folder is not copied);
 * - a non-Git project: its folder;
 * - a Git project: its checkout and a new worktree. `isGitRepo` must be a confirmed answer;
 *   while it is unknown (null) the worktree option stays disabled.
 */
export function listThreadForkDestinations(input: {
  readonly isChat: boolean;
  readonly isGitRepo: boolean | null;
  readonly chatsAvailable: boolean;
  readonly sourceWorktreePath: string | null;
  readonly sourceBranch: string | null;
}): ReadonlyArray<ThreadForkDestinationOption> {
  const copy = THREAD_FORK_COPY.destinations;
  if (input.isChat) {
    return [
      {
        kind: "new-chat",
        label: copy.newChat,
        description: copy.newChatDescription,
        enabled: input.chatsAvailable,
        ...(input.chatsAvailable ? {} : { disabledReason: copy.chatsUnavailable }),
      },
    ];
  }
  const branch = input.sourceBranch?.trim() || null;
  const current: ThreadForkDestinationOption = {
    kind: "current-checkout",
    label:
      input.isGitRepo !== true
        ? copy.currentFolder
        : input.sourceWorktreePath
          ? copy.currentWorktree
          : copy.currentCheckout,
    description:
      input.isGitRepo === true && branch
        ? copy.currentBranchDescription(branch)
        : copy.currentDescription,
    enabled: true,
  };
  if (input.isGitRepo === false) return [current];
  return [
    current,
    {
      kind: "new-worktree",
      label: copy.newWorktree,
      description: copy.newWorktreeDescription,
      enabled: input.isGitRepo === true,
      ...(input.isGitRepo === true ? {} : { disabledReason: copy.checkingGit }),
    },
  ];
}

/** Where a new worktree can start; the checkpoint only when the selected turn has one. */
export function listThreadForkWorktreeStarts(input: {
  readonly checkpointAvailable: boolean;
}): ReadonlyArray<ThreadForkWorktreeStartOption> {
  const copy = THREAD_FORK_COPY.worktreeStarts;
  return [
    {
      kind: "checkpoint",
      label: copy.checkpoint,
      description: copy.checkpointDescription,
      enabled: input.checkpointAvailable,
      ...(input.checkpointAvailable ? {} : { disabledReason: copy.checkpointUnavailable }),
    },
    { kind: "base-ref", label: copy.baseRef, description: copy.baseRefDescription, enabled: true },
  ];
}

/** The option selected when a list opens: the first enabled one. */
export function defaultThreadForkOption<Option extends { readonly enabled: boolean }>(
  options: ReadonlyArray<Option>,
): Option | null {
  return options.find((option) => option.enabled) ?? null;
}

/**
 * The option a list shows as selected: the user's choice while it is enabled, else the first
 * enabled option (options change as Git status loads or a checkpoint turns out to be unusable).
 */
export function effectiveThreadForkOption<Kind extends string>(
  options: ReadonlyArray<{ readonly kind: Kind; readonly enabled: boolean }>,
  chosen: Kind | null | undefined,
): Kind | null {
  const picked = options.find((option) => option.kind === chosen && option.enabled);
  return (picked ?? defaultThreadForkOption(options))?.kind ?? null;
}

/** The base ref a new worktree is prefilled with: the source's branch, else `HEAD`. */
export function defaultThreadForkBaseRef(sourceBranch: string | null | undefined): string {
  return sourceBranch?.trim() || "HEAD";
}

export function threadForkBusyLabel(destination: ThreadForkDestinationKind): string {
  return destination === "new-worktree"
    ? THREAD_FORK_COPY.busy.preparingWorktree
    : THREAD_FORK_COPY.busy.creating;
}

function publishedLabels(attachments: ReadonlyArray<ChatAttachment>): ReadonlyArray<string> {
  return attachments
    .map((attachment) => htmlRenderOfAttachment(attachment)?.title ?? attachment.name)
    .filter((label): label is string => label !== undefined && label.trim().length > 0);
}

/**
 * What a fork dialog quotes for the reply `messageId` a fork ends at: its text, or for a turn
 * that answered with a page or file alone, what the turn published (a page's title, else the
 * file's name). That covers both shapes such a turn ends on: the page's own carrier, and a blank
 * reply under the page. Empty when there is nothing to quote.
 */
export function threadForkBoundaryQuote(
  messages: ReadonlyArray<Pick<ChatMessage, "id" | "role" | "turnId" | "text" | "attachments">>,
  messageId: MessageId,
): string {
  const reply = messages.find((message) => message.id === messageId);
  if (reply === undefined) return "";
  if (reply.text.trim().length > 0) return reply.text;
  const own = publishedLabels(reply.attachments ?? []);
  if (own.length > 0 || !reply.turnId) return own.join(", ");
  return messages
    .filter((message) => message.role === "assistant" && message.turnId === reply.turnId)
    .flatMap((message) => publishedLabels(message.attachments ?? []))
    .join(", ");
}

/** Longest boundary excerpt a fork dialog quotes; the rest is elided. */
export const THREAD_FORK_EXCERPT_MAX_CHARS = 280;

/** The boundary reply as a dialog quotes it: one paragraph, bounded, never splitting a character. */
export function threadForkReplyExcerpt(
  text: string,
  maxChars: number = THREAD_FORK_EXCERPT_MAX_CHARS,
): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= maxChars) return compact;
  let end = Math.max(0, maxChars - 1);
  // Never cut between the two halves of a surrogate pair.
  const lastCode = compact.charCodeAt(end - 1);
  if (lastCode >= 0xd800 && lastCode <= 0xdbff) end -= 1;
  return `${compact.slice(0, end).trimEnd()}…`;
}

// ── Request ────────────────────────────────────────────────────────────

const isThreadForkKey = Schema.is(ThreadForkKey);
const isThreadForkBaseRef = Schema.is(ThreadForkBaseRef);
const isThreadForkInput = Schema.is(ThreadForkInput);
const isThreadForkErrorReason = Schema.is(ThreadForkErrorReason);
const isThreadForkAttemptState = Schema.is(ThreadForkAttemptState);
const RANDOM_HEX = /^[0-9a-f]{16,120}$/i;

/**
 * Mints the idempotency key for one fork attempt. Retries of that attempt reuse it; re-minting
 * could create a second fork while the node may still hold the first. When a new key is allowed
 * is decided by `threadForkAttempt.ts`. `randomHex` comes from the platform and must return at
 * least 16 random hex characters.
 */
export function createThreadForkKey(randomHex: () => string): ThreadForkKey {
  const random = randomHex();
  const key = `fork-${random}`;
  if (!RANDOM_HEX.test(random) || !isThreadForkKey(key)) {
    throw new Error("A fork key needs at least 16 random hex characters.");
  }
  return key;
}

export interface ThreadForkSelection {
  readonly destination: ThreadForkDestinationKind;
  /** `new-worktree` only. */
  readonly worktreeStart?: ThreadForkWorktreeStartKind | null | undefined;
  /** `new-worktree` from `base-ref` only, as typed; it is trimmed here. */
  readonly baseRef?: string | null | undefined;
}

export type BuildThreadForkInputResult =
  | { readonly ok: true; readonly input: ThreadForkInput }
  | { readonly ok: false; readonly message: string };

function buildDestination(
  selection: ThreadForkSelection,
): ThreadForkDestination | { readonly invalid: string } {
  switch (selection.destination) {
    case "current-checkout":
      return { kind: "current-checkout" };
    case "new-chat":
      return { kind: "new-chat" };
    case "new-worktree": {
      if (selection.worktreeStart === "checkpoint") {
        return { kind: "new-worktree", start: { kind: "checkpoint" } };
      }
      if (selection.worktreeStart !== "base-ref") {
        return { invalid: THREAD_FORK_COPY.worktreeStartRequired };
      }
      const baseRef = selection.baseRef?.trim() ?? "";
      if (baseRef.length === 0) return { invalid: THREAD_FORK_COPY.worktreeStarts.baseRefRequired };
      if (!isThreadForkBaseRef(baseRef)) {
        return { invalid: THREAD_FORK_COPY.worktreeStarts.baseRefTooLong };
      }
      return { kind: "new-worktree", start: { kind: "base-ref", baseRef } };
    }
  }
}

/** The `threads.fork` payload for a selection, or why the selection cannot be sent yet. */
export function buildThreadForkInput(input: {
  readonly forkKey: ThreadForkKey;
  readonly sourceThreadId: ThreadId;
  readonly sourceMessageId: MessageId;
  readonly selection: ThreadForkSelection;
}): BuildThreadForkInputResult {
  const destination = buildDestination(input.selection);
  if ("invalid" in destination) return { ok: false, message: destination.invalid };
  const request: ThreadForkInput = {
    forkKey: input.forkKey,
    sourceThreadId: input.sourceThreadId,
    sourceMessageId: input.sourceMessageId,
    destination,
  };
  if (!isThreadForkInput(request)) {
    throw new Error("buildThreadForkInput received an invalid fork key or source.");
  }
  return { ok: true, input: request };
}

/**
 * A request's identity without its key: two requests with the same signature ask the node for
 * the same fork. The one comparison every client and the call dedupe use.
 */
export function threadForkRequestSignature(input: Omit<ThreadForkInput, "forkKey">): string {
  const { destination } = input;
  const start =
    destination.kind === "new-worktree"
      ? destination.start.kind === "base-ref"
        ? `base-ref:${destination.start.baseRef}`
        : "checkpoint"
      : "";
  return [input.sourceThreadId, input.sourceMessageId, destination.kind, start].join("\u0000");
}

// ── Call ───────────────────────────────────────────────────────────────

/** The one method a fork needs; `EnvironmentApi["threads"]` and `WsRpcClient["threads"]` fit. */
export interface ThreadForkApi {
  readonly fork: (input: ThreadForkInput) => Promise<ThreadForkResult>;
}

/** The environment's fork API when it has one. Stable per connection, so calls dedupe. */
export function readThreadForkApi(api: EnvironmentApi | null | undefined): ThreadForkApi | null {
  const threads = api?.threads;
  return threads?.fork ? (threads as ThreadForkApi) : null;
}

/** Why nothing can be sent to an environment right now; a submit records it as a refusal. */
export interface ThreadForkApiRefusal {
  readonly refusal: Extract<ThreadForkOutcome, { status: "refused" }>;
}

/**
 * The environment's fork API at the moment of a send, or why nothing can be sent. Without a live
 * client (none registered, one being replaced, or `read` throws) the send waits for the
 * connection, as when the reviewed connection changed. A client that cannot fork refuses it as
 * unavailable. Every client resolves it this way, so the same condition reads the same everywhere.
 */
export function resolveThreadForkApi(
  read: () => EnvironmentApi | null | undefined,
): ThreadForkApi | ThreadForkApiRefusal {
  let api: EnvironmentApi | null | undefined;
  try {
    api = read();
  } catch (error) {
    return {
      refusal: {
        status: "refused",
        awaiting: true,
        message: THREAD_FORK_COPY.connectionChanged,
        error,
      },
    };
  }
  if (api == null) {
    return {
      refusal: {
        status: "refused",
        awaiting: true,
        message: THREAD_FORK_COPY.connectionChanged,
        error: null,
      },
    };
  }
  return (
    readThreadForkApi(api) ?? {
      refusal: {
        status: "refused",
        awaiting: false,
        message: THREAD_FORK_COPY.errors.unavailable,
        error: null,
      },
    }
  );
}

export type ThreadForkOutcome =
  | { readonly status: "succeeded"; readonly result: ThreadForkResult }
  /** The node answered with a typed refusal. `retryable`: the same key can succeed. */
  | {
      readonly status: "failed";
      readonly reason: ThreadForkErrorReason;
      readonly retryable: boolean;
      /** What the node holds for the key (`ThreadForkError.attempt`). */
      readonly attempt: ThreadForkAttemptState;
      /** Shared copy for `reason` and `attempt` (`threadForkFailureMessage`). */
      readonly message: string;
      /** The node's own message. Never branched on; preparation failures may show it. */
      readonly detail: string;
    }
  /**
   * Nothing ran on the node: the request was refused before sending, the connection changed
   * since the selection was reviewed, or the node's role check refused it. `awaiting`: the same
   * request can be sent once the connection is ready again (re-capture readiness first).
   */
  | {
      readonly status: "refused";
      readonly awaiting: boolean;
      readonly message: string;
      readonly error: unknown;
    }
  /** The request may have run. Retry with the same key; the node never creates a second fork. */
  | { readonly status: "uncertain"; readonly message: string; readonly error: unknown };

export type ThreadForkFailedOutcome = Exclude<ThreadForkOutcome, { status: "succeeded" }>;

function hasTag(error: unknown, tag: string): error is Record<string, unknown> {
  return typeof error === "object" && error !== null && "_tag" in error && error._tag === tag;
}

/**
 * Classifies a `threads.fork` rejection; never reads the node's message for branching. A typed
 * error this build cannot fully read (unknown reason or attempt) is uncertain: what the node holds
 * for the key is unknown.
 */
export function classifyThreadForkError(error: unknown): ThreadForkFailedOutcome {
  if (hasTag(error, "ThreadForkError")) {
    const { reason, retryable, attempt, message } = error;
    if (
      isThreadForkErrorReason(reason) &&
      typeof retryable === "boolean" &&
      isThreadForkAttemptState(attempt)
    ) {
      return {
        status: "failed",
        reason,
        retryable,
        attempt,
        message: threadForkFailureMessage({ reason, retryable, attempt }),
        detail: typeof message === "string" ? message : "",
      };
    }
  }
  if (error instanceof RpcRequestRefusedError) {
    return {
      status: "refused",
      awaiting: isAwaitingAdmission(error),
      message: error.message,
      error,
    };
  }
  if (error instanceof RpcTransportDisposedError) {
    return {
      status: "refused",
      awaiting: true,
      message: THREAD_FORK_COPY.connectionChanged,
      error,
    };
  }
  if (hasTag(error, "AuthRpcError")) {
    return {
      status: "refused",
      awaiting: false,
      message: THREAD_FORK_COPY.refusedForbidden,
      error,
    };
  }
  return { status: "uncertain", message: THREAD_FORK_COPY.uncertain, error };
}

interface PendingFork {
  readonly signature: string;
  readonly outcome: Promise<ThreadForkOutcome>;
}

const pendingForks = new WeakMap<ThreadForkApi, Map<ThreadForkKey, PendingFork>>();

async function runThreadForkOnce(input: {
  readonly api: ThreadForkApi;
  readonly input: ThreadForkInput;
  readonly assertMutationReady?: (() => void) | undefined;
}): Promise<ThreadForkOutcome> {
  try {
    input.assertMutationReady?.();
  } catch (error) {
    // The reviewed connection is gone; nothing was sent.
    return {
      status: "refused",
      awaiting: true,
      message: THREAD_FORK_COPY.connectionChanged,
      error,
    };
  }
  try {
    return { status: "succeeded", result: await input.api.fork(input.input) };
  } catch (error) {
    return classifyThreadForkError(error);
  }
}

/**
 * Sends one fork request and classifies its outcome; never throws, never retries and never
 * mints a key. Concurrent calls for the same API, key and request share one call. The caller's
 * `assertMutationReady` (`captureReviewedSendReadiness`; which capture a dialog passes is
 * `threadForkSendReadiness`) runs right before sending. Dialogs go through
 * `createThreadForkAttemptController`, which also keeps the attempt's key and lock.
 */
export function runThreadFork(input: {
  readonly api: ThreadForkApi;
  readonly input: ThreadForkInput;
  readonly assertMutationReady?: (() => void) | undefined;
}): Promise<ThreadForkOutcome> {
  let forks = pendingForks.get(input.api);
  if (!forks) {
    forks = new Map();
    pendingForks.set(input.api, forks);
  }
  const key = input.input.forkKey;
  const signature = threadForkRequestSignature(input.input);
  const pending = forks.get(key);
  // A different request under the same key goes to the node, which answers idempotency-conflict.
  if (pending?.signature === signature) return pending.outcome;
  const outcome = runThreadForkOnce(input);
  const entry: PendingFork = { signature, outcome };
  forks.set(key, entry);
  void outcome.then(() => {
    if (forks.get(key) === entry) forks.delete(key);
  });
  return outcome;
}

export interface ThreadForkFailureNotice {
  readonly message: string;
  /** Sending the same request (same key) again can succeed or report the fork's outcome. */
  readonly canRetry: boolean;
  /** The selected turn has no usable checkpoint: offer a base-ref start instead. */
  readonly suggestBaseRef: boolean;
}

/** What a dialog says after an outcome that did not create the fork. */
export function describeThreadForkFailure(
  outcome: ThreadForkFailedOutcome,
): ThreadForkFailureNotice {
  switch (outcome.status) {
    case "failed":
      return {
        message: outcome.message,
        // A running attempt answers a same-key retry with its outcome.
        canRetry:
          outcome.reason !== "idempotency-conflict" &&
          (outcome.retryable || outcome.attempt === "running"),
        suggestBaseRef: outcome.reason === "checkpoint-unavailable",
      };
    case "refused":
      return { message: outcome.message, canRetry: outcome.awaiting, suggestBaseRef: false };
    case "uncertain":
      return { message: outcome.message, canRetry: true, suggestBaseRef: false };
  }
}
