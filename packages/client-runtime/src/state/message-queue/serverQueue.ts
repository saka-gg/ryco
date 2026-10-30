import type {
  AgentTokenMode,
  ChatAttachment,
  ScopedThreadRef,
  ClientOrchestrationCommand,
  CommandId,
  FollowUpQueueEntryAuthor,
  FollowUpQueueEntryFailure,
  FollowUpQueueHoldInput,
  MessageId,
  ModelSelection,
  ProviderInteractionMode,
  QueuedFollowUp,
  RuntimeMode,
  ServerConfig,
  ThreadFollowUpQueue,
  ThreadFollowUpQueueShell,
  ThreadId,
  TurnId,
  UploadChatAttachment,
} from "@ryco/contracts";
import { extractThreadReferences } from "@ryco/shared/threadMentions";
import { create } from "zustand";

import { isDefiniteDispatchFailure } from "../../rpc/protocol.ts";
import {
  selectEnvironmentState,
  selectSidebarThreadSummaryByRef,
  type AppState,
} from "../threads/store.ts";
import { selectThreadLiveDetailLoaded } from "../threads/storeSelectors.ts";
import { describeQueueHold, queueHoldInputOf, type QueueHold } from "./hold.ts";
import { summarizeQueuedMessage } from "./logic.ts";

// ---------------------------------------------------------------------------
// The server-owned follow-up queue (design §3.6): a node that advertises
// `capabilities.serverFollowUpQueue` keeps each thread's queue and sends it on
// its own. Clients read it from the thread detail (`followUpQueue`) and the
// shell (`followUpQueueSummary`) and change it with `thread.queue.*` commands.
// The device queue (`store.ts`, `coordinator.ts`) keeps running unchanged for
// nodes without the capability. Platform-neutral: web and mobile share it.
// ---------------------------------------------------------------------------

/**
 * The thread's server-owned follow-up queue as its loaded detail shows it; null while it is
 * empty, its detail is not loaded, or the node keeps no queue (older servers).
 */
export function selectThreadFollowUpQueue(
  state: AppState,
  ref: ScopedThreadRef | null | undefined,
): ThreadFollowUpQueue | null {
  if (!ref) return null;
  return (
    selectEnvironmentState(state, ref.environmentId).followUpQueueByThreadId?.[ref.threadId] ?? null
  );
}

/**
 * Whether the node is about to send its queue's head: the queue holds an entry, is not held,
 * and its head waits as `queued`. Neither a held queue nor a head waiting for Retry or being
 * steered goes out by itself.
 */
export function isFollowUpQueueWaiting(
  queue: Pick<ThreadFollowUpQueue, "entries" | "hold"> | null | undefined,
): boolean {
  const head = queue?.entries[0];
  return head !== undefined && queue!.hold === null && head.status === "queued";
}

/**
 * {@link isFollowUpQueueWaiting} for a thread: from its live detail once loaded (the queue
 * follows the node's events there), else from its shell's summary.
 */
export function selectServerFollowUpQueueWaiting(
  state: AppState,
  ref: ScopedThreadRef | null | undefined,
): boolean {
  if (!ref) return false;
  if (selectThreadLiveDetailLoaded(state, ref)) {
    return isFollowUpQueueWaiting(selectThreadFollowUpQueue(state, ref));
  }
  const summary = selectSidebarThreadSummaryByRef(state, ref);
  const queue = summary && "followUpQueueSummary" in summary ? summary.followUpQueueSummary : null;
  return queue != null && queue.hold === null && queue.headStatus === "queued";
}

/**
 * Whether a send must queue behind the node's follow-up queue although no turn runs: the node
 * is about to send its head, or an add of this device is still on its way ("Queuing…"). The
 * node's dispatch does not change the session's status, so the thread reads idle while it
 * starts; a turn start now would jump ahead of the queue, or land in its start window.
 */
export function followUpSendWaitsForServerQueue(input: {
  readonly serverQueueSupported: boolean;
  /** {@link selectServerFollowUpQueueWaiting}. */
  readonly queueWaiting: boolean;
  /** Adds of this device the thread does not show yet. */
  readonly pendingAdds: number;
}): boolean {
  return input.serverQueueSupported && (input.queueWaiting || input.pendingAdds > 0);
}

/** How a thread list marks a thread with queued follow-ups (the node's shell summary). */
export interface FollowUpQueueBadge {
  /** "2 queued" */
  readonly label: string;
  /** "2 queued follow-ups: Paused after an error" */
  readonly title: string;
  /** Held, or the next one waits for Retry: nothing goes out without the person. */
  readonly held: boolean;
}

/** The mark for a thread whose queue holds follow-ups, or null while it holds none. */
export function followUpQueueBadgeOf(
  summary: Pick<ThreadFollowUpQueueShell, "count" | "hold" | "headStatus"> | null | undefined,
): FollowUpQueueBadge | null {
  if (!summary || summary.count <= 0) return null;
  const queued = `${summary.count} queued follow-up${summary.count === 1 ? "" : "s"}`;
  const why =
    summary.hold !== null
      ? describeQueueHold(summary.hold).title
      : summary.headStatus === "failed"
        ? "The next one waits for Retry"
        : null;
  return {
    label: `${summary.count} queued`,
    title: why === null ? queued : `${queued}: ${why}`,
    held: why !== null,
  };
}

/** Whether the node keeps follow-up queues itself (`thread.queue.*`). */
export function selectServerFollowUpQueueSupported(
  config: Pick<ServerConfig, "environment"> | null | undefined,
): boolean {
  return config?.environment?.capabilities?.serverFollowUpQueue === true;
}

type ClientCommandOf<T extends ClientOrchestrationCommand["type"]> = Extract<
  ClientOrchestrationCommand,
  { type: T }
>;
export type FollowUpQueueAddCommand = ClientCommandOf<"thread.queue.add">;
export type FollowUpQueueEditCommand = ClientCommandOf<"thread.queue.edit">;
export type FollowUpQueueMoveCommand = ClientCommandOf<"thread.queue.move">;
export type FollowUpQueueRemoveCommand = ClientCommandOf<"thread.queue.remove">;
export type FollowUpQueueSteerCommand = ClientCommandOf<"thread.queue.steer">;
export type FollowUpQueuePauseCommand = ClientCommandOf<"thread.queue.hold">;
export type FollowUpQueueResumeCommand = ClientCommandOf<"thread.queue.resume">;
export type FollowUpQueueRetryCommand = ClientCommandOf<"thread.queue.retry">;
export type FollowUpQueueCommand =
  | FollowUpQueueAddCommand
  | FollowUpQueueEditCommand
  | FollowUpQueueMoveCommand
  | FollowUpQueueRemoveCommand
  | FollowUpQueueSteerCommand
  | FollowUpQueuePauseCommand
  | FollowUpQueueResumeCommand
  | FollowUpQueueRetryCommand;

/** What a queued follow-up sends: the fields of the turn start it becomes. */
export interface FollowUpQueueEntryContent {
  /** The outgoing message text, composed as a direct send composes it. */
  readonly text: string;
  readonly attachments: ReadonlyArray<UploadChatAttachment>;
  readonly modelSelection: ModelSelection;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
  readonly tokenMode?: AgentTokenMode | undefined;
  /** This device turned the Claude resume review off: the node sends it without asking. */
  readonly skipClaudeResumeReview?: boolean | undefined;
}

interface CommandBase {
  readonly commandId: CommandId;
  readonly threadId: ThreadId;
  readonly createdAt: string;
}

function contentFields(threadId: ThreadId, content: FollowUpQueueEntryContent) {
  const threadReferences = extractThreadReferences(content.text, threadId);
  return {
    text: content.text,
    modelSelection: content.modelSelection,
    runtimeMode: content.runtimeMode,
    interactionMode: content.interactionMode,
    ...(content.tokenMode === undefined ? {} : { tokenMode: content.tokenMode }),
    ...(threadReferences.length > 0 ? { threadReferences } : {}),
    ...(content.skipClaudeResumeReview === true ? { claudeResumeReview: "skip" as const } : {}),
  };
}

/**
 * A device's hold as the hold of `thread.queue.add` (it merges into the node's hold), bounded
 * by the shared `queueHoldInputOf`, so a long provider error never makes an add fail to decode.
 * A hold left without a cause gets one naming its reason: a pause is always safe.
 */
export function toFollowUpQueueHoldInput(hold: QueueHold): FollowUpQueueHoldInput {
  return (
    queueHoldInputOf(hold) ??
    queueHoldInputOf({ ...hold, causeKeys: [`device:${hold.reason}:${hold.heldAt}`] })!
  );
}

/** The failure a device's failed entry moves over with: it waits for Retry, never sends twice. */
export const MOVED_FAILED_ENTRY_FAILURE: FollowUpQueueEntryFailure = {
  reason: "start-failed",
  detail: "Its send failed on this device, so it may have been delivered. Retry or remove it.",
};

/** `FollowUpQueueEntryFailure.detail`'s limit. */
const FOLLOW_UP_FAILURE_DETAIL_MAX_CHARS = 1_000;

/**
 * The failure a device's entry moves over with when the device knows why it must not be sent
 * on its own (a steer the provider may have, a send stopped at a choice the user did not
 * confirm). It waits for Retry; the detail is cut to the contract's limit.
 */
export function movedFollowUpQueueFailure(
  reason: FollowUpQueueEntryFailure["reason"],
  detail: string | null,
): FollowUpQueueEntryFailure {
  return {
    reason,
    detail: detail === null ? null : detail.slice(0, FOLLOW_UP_FAILURE_DETAIL_MAX_CHARS),
  };
}

/**
 * Whether a send made while the thread is busy goes to the node's queue (`thread.queue.add`)
 * instead of this device's queue: the node keeps queues, the thread is one the node has, its
 * environment takes mutations now, and nothing of this device's own queue for the thread is
 * left or still waiting for its turn to start. Those go first, in order, so the send queues
 * behind them on the device and moves to the node with them. A send the node's queue cannot
 * carry stays on the device.
 */
export function shouldQueueFollowUpOnServer(input: {
  readonly serverQueueSupported: boolean;
  /** A thread the node has, not a local draft. */
  readonly serverThread: boolean;
  readonly mutationReady: boolean;
  /** Entries this device still holds for the thread. */
  readonly deviceQueueLength: number;
  /** A queued send of this device whose turn has not started yet. */
  readonly deviceDispatchPending: boolean;
  /** Whether the node's queue can carry the send (absent: it can). */
  readonly movable?: boolean | undefined;
}): boolean {
  return (
    input.serverQueueSupported &&
    input.serverThread &&
    input.mutationReady &&
    input.deviceQueueLength === 0 &&
    !input.deviceDispatchPending &&
    input.movable !== false
  );
}

export function buildFollowUpQueueAddCommand(
  input: CommandBase & {
    readonly messageId: MessageId;
    readonly content: FollowUpQueueEntryContent;
    readonly position?: "tail" | "head" | undefined;
    /** A device's hold that moves over with its queue. */
    readonly hold?: QueueHold | null | undefined;
    /** A device's entry whose delivery is unknown: queued as failed. */
    readonly failure?: FollowUpQueueEntryFailure | undefined;
  },
): FollowUpQueueAddCommand {
  return {
    type: "thread.queue.add",
    commandId: input.commandId,
    threadId: input.threadId,
    entry: {
      messageId: input.messageId,
      ...contentFields(input.threadId, input.content),
      attachments: [...input.content.attachments],
      ...(input.failure === undefined ? {} : { failure: input.failure }),
    },
    ...(input.position === undefined ? {} : { position: input.position }),
    ...(input.hold ? { hold: toFollowUpQueueHoldInput(input.hold) } : {}),
    createdAt: input.createdAt,
  };
}

/**
 * The node's queued entry a composer is editing (web and mobile): the next send saves it in
 * place (`thread.queue.edit` at the revision shown). Its stored attachments stay unless the
 * person drops them while editing; ones added in the composer are uploaded and added.
 */
export interface FollowUpQueueEdit {
  readonly threadKey: string;
  readonly messageId: MessageId;
  /** The revision the person edited; a save at it is refused once the entry changed. */
  readonly revision: number;
  /** The entry's stored attachments that stay. */
  readonly keptAttachmentIds: NonNullable<FollowUpQueueEditCommand["keptAttachmentIds"]>;
}

/** Starts editing `entry`: every stored attachment it has stays until dropped. */
export function followUpQueueEditOf(
  threadKey: string,
  entry: Pick<QueuedFollowUp, "messageId" | "revision" | "attachments">,
): FollowUpQueueEdit {
  return {
    threadKey,
    messageId: entry.messageId,
    revision: entry.revision,
    keptAttachmentIds: entry.attachments.flatMap((attachment) =>
      attachment.id === undefined ? [] : [attachment.id],
    ),
  };
}

/** A stored attachment the edit keeps, as the composer shows it. */
export interface FollowUpQueueEditAttachment {
  readonly id: NonNullable<ChatAttachment["id"]>;
  readonly name: string;
  readonly kind: "image" | "file";
}

/** The stored attachments `edit` still keeps, in the entry's order, for the composer to show. */
export function followUpQueueEditAttachments(
  edit: Pick<FollowUpQueueEdit, "keptAttachmentIds">,
  entry: Pick<QueuedFollowUp, "attachments"> | null | undefined,
): ReadonlyArray<FollowUpQueueEditAttachment> {
  const kept = new Set<string>(edit.keptAttachmentIds);
  return (entry?.attachments ?? []).flatMap((attachment) =>
    attachment.id === undefined || !kept.has(attachment.id)
      ? []
      : [
          {
            id: attachment.id,
            name: attachment.name ?? (attachment.type === "image" ? "Image" : "File"),
            kind: attachment.type === "image" ? ("image" as const) : ("file" as const),
          },
        ],
  );
}

/** The edit without one stored attachment: saving it then drops that attachment. */
export function withoutFollowUpQueueEditAttachment<E extends FollowUpQueueEdit>(
  edit: E,
  attachmentId: string,
): E {
  return {
    ...edit,
    keptAttachmentIds: edit.keptAttachmentIds.filter((id) => id !== attachmentId),
  };
}

/** Replaces what one entry sends, at the revision the user edited; `attachments` are new ones. */
export function buildFollowUpQueueEditCommand(
  input: CommandBase & {
    readonly entry: Pick<QueuedFollowUp, "messageId" | "revision">;
    readonly content: FollowUpQueueEntryContent;
    /** The entry's own stored attachments that stay. */
    readonly keptAttachmentIds: NonNullable<FollowUpQueueEditCommand["keptAttachmentIds"]>;
  },
): FollowUpQueueEditCommand {
  return {
    type: "thread.queue.edit",
    commandId: input.commandId,
    threadId: input.threadId,
    messageId: input.entry.messageId,
    expectedRevision: input.entry.revision,
    ...contentFields(input.threadId, input.content),
    attachments: [...input.content.attachments],
    ...(input.keptAttachmentIds.length > 0
      ? { keptAttachmentIds: [...input.keptAttachmentIds] }
      : {}),
    createdAt: input.createdAt,
  };
}

/**
 * Moves an entry one place up or down. Null at the queue's edge or when it is not queued.
 * `thread.queue.move` names the entry it goes before (null: the end).
 */
export function buildFollowUpQueueMoveCommand(
  input: CommandBase & {
    readonly entries: ReadonlyArray<Pick<QueuedFollowUp, "messageId">>;
    readonly messageId: MessageId;
    readonly direction: "up" | "down";
  },
): FollowUpQueueMoveCommand | null {
  const index = input.entries.findIndex((entry) => entry.messageId === input.messageId);
  if (index === -1) return null;
  let beforeMessageId: MessageId | null;
  if (input.direction === "up") {
    if (index === 0) return null;
    beforeMessageId = input.entries[index - 1]!.messageId;
  } else {
    if (index === input.entries.length - 1) return null;
    beforeMessageId = input.entries[index + 2]?.messageId ?? null;
  }
  return {
    type: "thread.queue.move",
    commandId: input.commandId,
    threadId: input.threadId,
    messageId: input.messageId,
    beforeMessageId,
    createdAt: input.createdAt,
  };
}

export function buildFollowUpQueueRemoveCommand(
  input: CommandBase & { readonly messageIds: ReadonlyArray<MessageId> },
): FollowUpQueueRemoveCommand {
  return {
    type: "thread.queue.remove",
    commandId: input.commandId,
    threadId: input.threadId,
    messageIds: [...input.messageIds],
    createdAt: input.createdAt,
  };
}

/** Sends a queued entry into the running turn; when that turn ended it stays queued. */
export function buildFollowUpQueueSteerCommand(
  input: CommandBase & { readonly messageId: MessageId; readonly expectedTurnId: TurnId },
): FollowUpQueueSteerCommand {
  return {
    type: "thread.queue.steer",
    commandId: input.commandId,
    threadId: input.threadId,
    messageId: input.messageId,
    expectedTurnId: input.expectedTurnId,
    createdAt: input.createdAt,
  };
}

/** The Pause button (`thread.queue.hold`). */
export function buildFollowUpQueuePauseCommand(input: CommandBase): FollowUpQueuePauseCommand {
  return {
    type: "thread.queue.hold",
    commandId: input.commandId,
    threadId: input.threadId,
    createdAt: input.createdAt,
  };
}

/**
 * Resume: acknowledges the causes of the hold the user saw. A cause recorded since stays held,
 * so the user always sees why the queue waits before it sends.
 */
export function buildFollowUpQueueResumeCommand(
  input: CommandBase & { readonly hold: Pick<QueueHold, "causeKeys"> },
): FollowUpQueueResumeCommand {
  return {
    type: "thread.queue.resume",
    commandId: input.commandId,
    threadId: input.threadId,
    acknowledgeCauseKeys: input.hold.causeKeys.slice(0, 64),
    createdAt: input.createdAt,
  };
}

export function buildFollowUpQueueRetryCommand(
  input: CommandBase & { readonly messageId: MessageId },
): FollowUpQueueRetryCommand {
  return {
    type: "thread.queue.retry",
    commandId: input.commandId,
    threadId: input.threadId,
    messageId: input.messageId,
    createdAt: input.createdAt,
  };
}

// ---------------------------------------------------------------------------
// View model
// ---------------------------------------------------------------------------

/**
 * `queuing`: added on this device, not yet in the thread detail. `moving`: a device entry whose
 * add to the node's queue is on its way. `sending`: a device entry being sent as a turn.
 * `steering`: being sent into the running turn.
 */
export type FollowUpQueueRowStatus =
  | "queued"
  | "queuing"
  | "moving"
  | "sending"
  | "steering"
  | "failed";

/** Why a message on its way to the node's queue cannot be edited or steered yet. */
export const FOLLOW_UP_ON_ITS_WAY_REASON = "This message is on its way to the node's queue.";

/**
 * Why the row cannot be edited or steered now because its add to the node's queue is on its
 * way, else null. The add can still land: an edited copy or a steer would make a second message.
 */
export function followUpQueueRowOnItsWayReason(
  row: Pick<FollowUpQueueRow, "status">,
): string | null {
  return row.status === "queuing" || row.status === "moving" ? FOLLOW_UP_ON_ITS_WAY_REASON : null;
}

/** One row of the queue a thread shows, whoever keeps it. */
export interface FollowUpQueueRow {
  /** The message id the entry is sent under. */
  readonly id: string;
  /** `server`: the node's entry; `pending`: an add on its way; `local`: this device's entry. */
  readonly source: "server" | "pending" | "local";
  readonly summary: string;
  readonly status: FollowUpQueueRowStatus;
  /** Why a failed entry waits for Retry. */
  readonly failureDetail: string | null;
  readonly author: FollowUpQueueEntryAuthor;
}

export interface FollowUpQueueViewModel {
  /** Node entries first (head first), then adds on their way, then this device's entries. */
  readonly rows: ReadonlyArray<FollowUpQueueRow>;
  /** The node's hold while its queue holds one, else this device's. */
  readonly hold: QueueHold | null;
  readonly holdSource: "server" | "local" | null;
}

/** A `thread.queue.add` this device sent whose entry the thread detail does not show yet. */
export interface PendingFollowUpAdd {
  readonly messageId: string;
  readonly summary: string;
  readonly createdAt: string;
}

/** A device queue entry as the view shows it. */
export interface LocalFollowUpRowInput {
  readonly id: string;
  readonly summary: string;
  readonly deliveryStatus?: "sending" | "failed" | undefined;
  readonly steering: boolean;
  /** Its add to the node's queue is on its way (the device queue is moving there). */
  readonly moving?: boolean | undefined;
}

const IMAGE_ATTACHMENT = "image";

/** A one-line label for a node's entry. */
export function summarizeQueuedFollowUp(
  entry: Pick<QueuedFollowUp, "text" | "attachments">,
): string {
  const images = entry.attachments.filter((attachment) => attachment.type === IMAGE_ATTACHMENT);
  const summary = summarizeQueuedMessage({
    trimmedPrompt: entry.text.replace(/^Ultrathink:\n/u, "").trim(),
    imageCount: images.length,
    terminalContextCount: 0,
  });
  const files = entry.attachments.length - images.length;
  if (summary === "Queued message" && files > 0) return files === 1 ? "1 file" : `${files} files`;
  return summary;
}

const EMPTY_VIEW: FollowUpQueueViewModel = { rows: [], hold: null, holdSource: null };

/**
 * The queue one thread shows: the node's entries and hold, adds this device sent that have not
 * arrived yet ("Queuing…", hidden once the entry or its message is there), and entries still
 * queued on this device (an older node, or ones moving to the node).
 */
export function deriveFollowUpQueueView(input: {
  readonly server: ThreadFollowUpQueue | null;
  readonly pending: ReadonlyArray<PendingFollowUpAdd>;
  /** Messages the thread has: a pending add whose message was sent is no longer queued. */
  readonly projectedMessageIds?: ReadonlySet<string> | undefined;
  readonly local: ReadonlyArray<LocalFollowUpRowInput>;
  readonly localHold: QueueHold | null;
}): FollowUpQueueViewModel {
  const serverEntries = input.server?.entries ?? [];
  if (
    serverEntries.length === 0 &&
    input.pending.length === 0 &&
    input.local.length === 0 &&
    input.server?.hold == null &&
    input.localHold === null
  ) {
    return EMPTY_VIEW;
  }
  const rows: FollowUpQueueRow[] = [];
  const shown = new Set<string>();
  for (const entry of serverEntries) {
    shown.add(entry.messageId);
    rows.push({
      id: entry.messageId,
      source: "server",
      summary: summarizeQueuedFollowUp(entry),
      status: entry.status,
      failureDetail: entry.status === "failed" ? (entry.failure?.detail ?? null) : null,
      author: entry.author,
    });
  }
  for (const pending of input.pending) {
    if (shown.has(pending.messageId) || input.projectedMessageIds?.has(pending.messageId)) continue;
    shown.add(pending.messageId);
    rows.push({
      id: pending.messageId,
      source: "pending",
      summary: pending.summary,
      status: "queuing",
      failureDetail: null,
      author: "user",
    });
  }
  for (const entry of input.local) {
    // An entry that moved to the node shows once, as the node's.
    if (shown.has(entry.id)) continue;
    rows.push({
      id: entry.id,
      source: "local",
      summary: entry.summary,
      status: entry.steering
        ? "steering"
        : entry.deliveryStatus === "sending"
          ? "sending"
          : entry.moving === true
            ? "moving"
            : entry.deliveryStatus === "failed"
              ? "failed"
              : "queued",
      failureDetail: null,
      author: "user",
    });
  }
  const serverHold = serverEntries.length > 0 ? (input.server?.hold ?? null) : null;
  const localHold = input.local.length > 0 ? input.localHold : null;
  return {
    rows,
    hold: serverHold ?? localHold,
    holdSource: serverHold ? "server" : localHold ? "local" : null,
  };
}

// ---------------------------------------------------------------------------
// Editing a node's entry
// ---------------------------------------------------------------------------

/**
 * Where an edit of a node's entry stands. `gone`: the entry left the queue (sent, or removed
 * elsewhere). `changed`: it is still queued at another revision (an edit on another device, a
 * Retry, a steer that came back), so a save at the edited revision would be refused. Either way
 * the edit is over and the composer keeps its text.
 */
export type FollowUpQueueEditState = "editing" | "gone" | "changed";

export function resolveFollowUpQueueEditState(input: {
  readonly queue: ThreadFollowUpQueue | null;
  /** Without the thread's detail the queue is not known: the edit goes on. */
  readonly detailLoaded: boolean;
  readonly messageId: string;
  readonly revision: number;
  /** This edit's own save is on its way: the revision it raises is not someone else's change. */
  readonly saving: boolean;
}): FollowUpQueueEditState {
  if (!input.detailLoaded) return "editing";
  const entry = input.queue?.entries.find((candidate) => candidate.messageId === input.messageId);
  if (!entry) return "gone";
  return entry.revision !== input.revision && !input.saving ? "changed" : "editing";
}

/** What the user is told when an edit ended without saving; the text stays in the composer. */
export function describeEndedFollowUpQueueEdit(state: "gone" | "changed"): {
  readonly title: string;
  readonly description: string;
} {
  return state === "gone"
    ? {
        title: "The queued message left the queue before your edit",
        description: "Your edit stays in the composer. Send it as a new message or clear it.",
      }
    : {
        title: "The queued message changed before your edit was saved",
        description:
          "Your edit stays in the composer. Send it as a new message, or clear the composer and edit the message again.",
      };
}

// ---------------------------------------------------------------------------
// Optimistic adds
// ---------------------------------------------------------------------------

export interface FollowUpQueuePendingState {
  /** Adds this device sent, per scoped thread key, in send order. */
  readonly pendingByThreadKey: Readonly<Record<string, ReadonlyArray<PendingFollowUpAdd>>>;
  readonly begin: (threadKey: string, pending: PendingFollowUpAdd) => void;
  readonly end: (threadKey: string, messageId: string) => void;
  readonly reset: () => void;
}

export function createFollowUpQueuePendingStore() {
  return create<FollowUpQueuePendingState>((set) => ({
    pendingByThreadKey: {},
    begin: (threadKey, pending) =>
      set((state) => {
        const current = state.pendingByThreadKey[threadKey] ?? [];
        if (current.some((entry) => entry.messageId === pending.messageId)) return state;
        return {
          pendingByThreadKey: { ...state.pendingByThreadKey, [threadKey]: [...current, pending] },
        };
      }),
    end: (threadKey, messageId) =>
      set((state) => {
        const current = state.pendingByThreadKey[threadKey];
        if (!current?.some((entry) => entry.messageId === messageId)) return state;
        const next = current.filter((entry) => entry.messageId !== messageId);
        const pendingByThreadKey = { ...state.pendingByThreadKey };
        if (next.length === 0) delete pendingByThreadKey[threadKey];
        else pendingByThreadKey[threadKey] = next;
        return { pendingByThreadKey };
      }),
    reset: () => set({ pendingByThreadKey: {} }),
  }));
}

export type FollowUpQueuePendingStore = ReturnType<typeof createFollowUpQueuePendingStore>;

/** How long an accepted add shows as "Queuing…" at most while its entry is on its way. */
export const PENDING_FOLLOW_UP_VISIBLE_TIMEOUT_MS = 10_000;

/** How a `thread.queue.add` of a send ended. */
export type FollowUpQueueAddOutcome =
  | { readonly kind: "queued" }
  /** A definite refusal (the node's answer, or this client's before sending): not queued. */
  | { readonly kind: "refused"; readonly error: unknown }
  /**
   * No answer (a lost reply): the node may have queued it. The caller keeps the message on the
   * device under the same message id; moving it re-adds it, and the node's no-op on a known id
   * keeps a single copy.
   */
  | { readonly kind: "unknown"; readonly error: unknown };

const QUEUED: FollowUpQueueAddOutcome = { kind: "queued" };

/**
 * Sends `thread.queue.add` with an optimistic "Queuing…" row. Only a definite refusal
 * (`isDefiniteDispatchFailure`) gives the message back to the caller; any other failure may
 * have reached the node. A failed add drops the row. An accepted one keeps it until
 * `isVisible` (the entry, or its message, is in the thread) or a timeout.
 */
export async function addFollowUpToServerQueue(input: {
  readonly pendingStore: Pick<FollowUpQueuePendingStore, "getState">;
  readonly threadKey: string;
  readonly command: FollowUpQueueAddCommand;
  readonly summary: string;
  readonly dispatch: (command: FollowUpQueueAddCommand) => Promise<unknown>;
  readonly isVisible: () => boolean;
  readonly subscribe: (listener: () => void) => () => void;
  readonly timers?: {
    setTimeout: (callback: () => void, ms: number) => unknown;
    clearTimeout: (handle: unknown) => void;
  };
}): Promise<FollowUpQueueAddOutcome> {
  const messageId = input.command.entry.messageId;
  input.pendingStore.getState().begin(input.threadKey, {
    messageId,
    summary: input.summary,
    createdAt: input.command.createdAt,
  });
  const end = () => input.pendingStore.getState().end(input.threadKey, messageId);
  try {
    await input.dispatch(input.command);
  } catch (error) {
    end();
    return isDefiniteDispatchFailure(error)
      ? { kind: "refused", error }
      : { kind: "unknown", error };
  }
  if (input.isVisible()) {
    end();
    return QUEUED;
  }
  const timers = input.timers ?? {
    setTimeout: (callback: () => void, ms: number) => setTimeout(callback, ms),
    clearTimeout: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
  let unsubscribe: (() => void) | null = null;
  const timeout = timers.setTimeout(() => {
    unsubscribe?.();
    end();
  }, PENDING_FOLLOW_UP_VISIBLE_TIMEOUT_MS);
  unsubscribe = input.subscribe(() => {
    if (!input.isVisible()) return;
    timers.clearTimeout(timeout);
    unsubscribe?.();
    end();
  });
  return QUEUED;
}
