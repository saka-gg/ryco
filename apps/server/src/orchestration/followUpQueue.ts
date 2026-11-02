/**
 * The server-owned follow-up queue (port batch 3, design §3): what a queue command records, what
 * a dispatch must find, which holds other commands record in their own batch, and how a
 * thread's queue follows from its events. The decider and the in-memory projector load it with
 * `import()` (`followUpQueueLoader.ts`) when a command or an event concerns a queue; the SQL
 * projection mirrors `projectFollowUpQueueEvent`, and the drain (`ServerQueueDrain`) sends the
 * head.
 *
 * Holds are recorded on the event that causes them (a Stop, a usage limit, a failed turn, the
 * Pause button, a restart), never re-derived from thread state, so a follow-up the user queued
 * after seeing a failure is never held by that failure.
 *
 * Pure module: no services, no I/O. It imports no value from a module the server's boot graph
 * loads; the boot-side rules it needs come in through `FollowUpQueueHost`.
 *
 * @module followUpQueue
 */
import type {
  AgentTokenMode,
  FollowUpQueueHold,
  FollowUpQueueHoldInput,
  FollowUpQueueRemovalReason,
  MessageId,
  OrchestrationCommand,
  OrchestrationEvent,
  OrchestrationReadModel,
  QueuedFollowUp,
  RuntimeMode,
  ThreadFollowUpQueue,
  ThreadId,
  ThreadQueueAddCommand,
  ThreadReferences,
} from "@ryco/contracts";
import {
  createInterruptQueueHold,
  headExemptCauseKeys,
  isQueueFailureCauseExempt,
  mergeQueueHold,
  pausedCauseKey,
  QUEUE_HOLD_RANK,
  queueHoldsEqual,
  removeQueueHoldCauses,
  sessionErrorCauseKey,
  trashedCauseKey,
  usageLimitCauseKey,
} from "@ryco/shared/queueHold";

type Thread = OrchestrationReadModel["threads"][number];

/** The boot-side rules and limits the queue rules use (passed in, never imported). */
export interface FollowUpQueueHost {
  readonly isThreadLive: (thread: Thread) => boolean;
  readonly isThreadTrashed: (thread: Thread) => boolean;
  readonly threadLifecycleTurnBlocker: (
    readModel: OrchestrationReadModel,
    thread: Thread,
  ) => string | null;
  readonly reservedForkItemIdBlocker: (threadId: ThreadId, messageId: string) => string | null;
  readonly runtimeModePrivilegeRank: Readonly<Record<RuntimeMode, number>>;
  readonly findThread: (
    threads: OrchestrationReadModel["threads"],
    threadId: string,
  ) => Thread | undefined;
  readonly threadReferencesPayload: (
    references: ThreadReferences | undefined,
    threadId: ThreadId,
  ) => { readonly threadReferences?: ThreadReferences };
  /** A restart's orphaned session error (`@ryco/shared/restartContinuation`). */
  readonly orphanedSessionError: string;
  /** `isUserOriginatedCommandId`: a person's command, not the node's own. */
  readonly isUserOriginatedCommandId: (commandId: string) => boolean;
  readonly maxEntries: number;
  readonly maxAttachments: number;
  /** The token mode of a thread that never set one. */
  readonly defaultTokenMode: AgentTokenMode;
  /**
   * Message ids the node mints for its own turns. A queued follow-up never takes one: its turn
   * would read as a delegated result, an Agent Control message, a goal's next turn or a pull
   * request update.
   */
  readonly serverMintedMessageIdPrefixes: ReadonlyArray<string>;
  /**
   * The one of them an Agent Control message takes; only the node's own agent and automation
   * adds may use it.
   */
  readonly agentControlMessageIdPrefix: string;
}
type PlannedEvent = Omit<OrchestrationEvent, "sequence">;

export type FollowUpQueueEventType =
  | "thread.queue-entry-added"
  | "thread.queue-entry-edited"
  | "thread.queue-reordered"
  | "thread.queue-entries-removed"
  | "thread.queue-entry-failed"
  | "thread.queue-held"
  | "thread.queue-released";

type DraftOf<T extends OrchestrationEvent["type"]> = {
  readonly type: T;
  readonly payload: Extract<OrchestrationEvent, { type: T }>["payload"];
};

/** A queue event before the decider adds its envelope (ids, command, timestamps). */
export type FollowUpQueueEventDraft = {
  [T in FollowUpQueueEventType]: DraftOf<T>;
}[FollowUpQueueEventType];

/** What a queue command records: queue events, and for a steer the steer request itself. */
export type FollowUpQueueDraft = FollowUpQueueEventDraft | DraftOf<"thread.turn-steer-requested">;

export type FollowUpQueueDecision =
  | { readonly refused: string }
  | { readonly drafts: ReadonlyArray<FollowUpQueueDraft> };

const EMPTY_QUEUE: ThreadFollowUpQueue = { entries: [], hold: null };

const followUpQueueOf = (thread: Pick<Thread, "followUpQueue">): ThreadFollowUpQueue =>
  thread.followUpQueue ?? EMPTY_QUEUE;

// ── projection ────────────────────────────────────────────────────────────

/** The queue after one of its events; undefined once it is empty and unheld. */
export function projectFollowUpQueueEvent(
  queue: ThreadFollowUpQueue,
  event: FollowUpQueueEventDraft,
): ThreadFollowUpQueue | undefined {
  const next = applyQueueEvent(queue, event);
  return next.entries.length === 0 && next.hold === null ? undefined : next;
}

function applyQueueEvent(
  queue: ThreadFollowUpQueue,
  event: FollowUpQueueEventDraft,
): ThreadFollowUpQueue {
  switch (event.type) {
    case "thread.queue-entry-added": {
      const { entry, beforeMessageId } = event.payload;
      // Replaying an add keeps the entry where it is.
      if (queue.entries.some((candidate) => candidate.messageId === entry.messageId)) {
        return { ...queue, entries: replaceEntry(queue.entries, entry) };
      }
      const index =
        beforeMessageId === null
          ? -1
          : queue.entries.findIndex((candidate) => candidate.messageId === beforeMessageId);
      const entries =
        index < 0
          ? [...queue.entries, entry]
          : [...queue.entries.slice(0, index), entry, ...queue.entries.slice(index)];
      return { ...queue, entries };
    }
    case "thread.queue-entry-edited":
      return { ...queue, entries: replaceEntry(queue.entries, event.payload.entry) };
    case "thread.queue-reordered":
      return { ...queue, entries: reorderEntries(queue.entries, event.payload.order) };
    case "thread.queue-entries-removed": {
      const removed = new Set<string>(event.payload.messageIds);
      return { ...queue, entries: queue.entries.filter((entry) => !removed.has(entry.messageId)) };
    }
    case "thread.queue-entry-failed": {
      const { messageId, revision, failure, updatedAt } = event.payload;
      return {
        ...queue,
        entries: queue.entries.map((entry) =>
          entry.messageId === messageId
            ? { ...entry, status: "failed" as const, failure, revision, updatedAt }
            : entry,
        ),
      };
    }
    case "thread.queue-held":
      return { ...queue, hold: event.payload.hold };
    case "thread.queue-released":
      return { ...queue, hold: null };
  }
}

function replaceEntry(
  entries: ReadonlyArray<QueuedFollowUp>,
  entry: QueuedFollowUp,
): ReadonlyArray<QueuedFollowUp> {
  return entries.map((candidate) => (candidate.messageId === entry.messageId ? entry : candidate));
}

/** `order` first; an entry it does not name (none should) keeps its place after them. */
export function reorderEntries<E extends { readonly messageId: string }>(
  entries: ReadonlyArray<E>,
  order: ReadonlyArray<string>,
): ReadonlyArray<E> {
  const byId = new Map(entries.map((entry) => [entry.messageId, entry] as const));
  const ordered: E[] = [];
  for (const messageId of order) {
    const entry = byId.get(messageId);
    if (entry === undefined) continue;
    ordered.push(entry);
    byId.delete(messageId);
  }
  return [...ordered, ...byId.values()];
}

// ── queue commands ───────────────────────────────────────────────────────

type FollowUpQueueCommand = Extract<
  OrchestrationCommand,
  {
    type:
      | "thread.queue.add"
      | "thread.queue.edit"
      | "thread.queue.move"
      | "thread.queue.remove"
      | "thread.queue.steer"
      | "thread.queue.hold"
      | "thread.queue.resume"
      | "thread.queue.retry"
      | "thread.queue.hold.record";
  }
>;

const refuse = (refused: string): FollowUpQueueDecision => ({ refused });

/** An agent's edit or removal (Agent Control) reaches only what that chat's agent queued. */
const NOT_THE_AGENTS =
  "Only follow-ups this chat's agent queued, still queued and not being sent, can be changed.";
const queuedByAgentOf = (entry: QueuedFollowUp, chat: ThreadId): boolean =>
  entry.author === "agent" && entry.queuedBy === chat;
const record = (...drafts: ReadonlyArray<FollowUpQueueDraft>): FollowUpQueueDecision => ({
  drafts,
});
const NO_CHANGE: FollowUpQueueDecision = { drafts: [] };

const NOT_QUEUED = "That follow-up is no longer queued.";

function reservedMessageIdBlocker(
  host: FollowUpQueueHost,
  threadId: ThreadId,
  messageId: MessageId,
  author: QueuedFollowUp["author"],
): string | null {
  // An Agent Control message or a scheduled run queued by the node keeps its own id, so its
  // turn reads as one.
  const reserved = (prefix: string) =>
    messageId.startsWith(prefix) &&
    !(author !== "user" && prefix === host.agentControlMessageIdPrefix);
  if (host.serverMintedMessageIdPrefixes.some(reserved)) {
    return `Message id '${messageId}' is reserved for messages the node sends.`;
  }
  return host.reservedForkItemIdBlocker(threadId, messageId);
}

const hasContent = (entry: {
  readonly text: string;
  readonly attachments: ReadonlyArray<unknown>;
}) => entry.text.trim().length > 0 || entry.attachments.length > 0;

/**
 * `input` merged into the hold, after the `replaces` causes left it. It takes their place: on an
 * equal rank its own reason and detail show, so no detail of a cause that left stays behind.
 */
function replacedHold(
  hold: FollowUpQueueHold | null,
  input: FollowUpQueueHoldInput,
  replaces: ReadonlyArray<string>,
  occurredAt: string,
) {
  const base =
    hold === null || replaces.length === 0 ? hold : removeQueueHoldCauses(hold, replaces);
  const merged = mergeQueueHold(base, input, occurredAt);
  return base === hold ||
    base === null ||
    QUEUE_HOLD_RANK[input.reason] < QUEUE_HOLD_RANK[base.reason]
    ? merged
    : { ...merged, reason: input.reason, detail: input.detail };
}

/** The queue's hold after `input` (in place of `replaces`), or null when it already covers it. */
function heldDraft(
  threadId: ThreadId,
  hold: FollowUpQueueHold | null,
  input: FollowUpQueueHoldInput,
  occurredAt: string,
  replaces: ReadonlyArray<string> = [],
): FollowUpQueueEventDraft | null {
  const merged = replacedHold(hold, input, replaces, occurredAt);
  return queueHoldsEqual(merged, hold) ? null : heldEventDraft(threadId, merged, occurredAt);
}

/** The queue's hold after each of `inputs`, in one event, or null when it already covers them. */
function heldDraftOf(
  threadId: ThreadId,
  hold: FollowUpQueueHold | null,
  inputs: ReadonlyArray<FollowUpQueueHoldInput>,
  occurredAt: string,
): FollowUpQueueEventDraft | null {
  const merged = inputs.reduce<FollowUpQueueHold | null>(
    (current, input) => mergeQueueHold(current, input, occurredAt),
    hold,
  );
  return merged === null || queueHoldsEqual(merged, hold)
    ? null
    : heldEventDraft(threadId, merged, occurredAt);
}

function heldEventDraft(
  threadId: ThreadId,
  hold: FollowUpQueueHold,
  occurredAt: string,
): FollowUpQueueEventDraft {
  return {
    type: "thread.queue-held",
    payload: { threadId, hold: { ...hold, causeKeys: [...hold.causeKeys] }, updatedAt: occurredAt },
  };
}

/**
 * The hold a Stop of `holdIfTurnInterrupted` records, when that turn is the thread's latest and
 * ended interrupted (`thread.queue.add`): the Stop held nothing while the queue was empty.
 */
function interruptedTurnHold(
  thread: Thread,
  command: ThreadQueueAddCommand,
): FollowUpQueueHoldInput | undefined {
  const turnId = command.holdIfTurnInterrupted;
  if (
    turnId === undefined ||
    thread.latestTurn?.turnId !== turnId ||
    thread.latestTurn.state !== "interrupted"
  ) {
    return undefined;
  }
  const stop = createInterruptQueueHold(turnId, command.createdAt);
  return { reason: stop.reason, causeKeys: stop.causeKeys, detail: stop.detail };
}

/** Releases `causeKeys` of the hold: a smaller hold, its end, or nothing when none matched. */
function releasedDraft(
  threadId: ThreadId,
  hold: FollowUpQueueHold | null,
  causeKeys: ReadonlyArray<string>,
  occurredAt: string,
): FollowUpQueueEventDraft | null {
  if (hold === null) return null;
  const released = hold.causeKeys.filter((key) => causeKeys.includes(key));
  if (released.length === 0) return null;
  const remaining = removeQueueHoldCauses(hold, released);
  return remaining === null
    ? {
        type: "thread.queue-released",
        payload: { threadId, acknowledgedCauseKeys: released, updatedAt: occurredAt },
      }
    : {
        type: "thread.queue-held",
        payload: {
          threadId,
          hold: { ...remaining, causeKeys: [...remaining.causeKeys] },
          updatedAt: occurredAt,
        },
      };
}

/**
 * Removes entries; an emptied queue also loses its hold (there is nothing left to hold, and a
 * follow-up queued later must not wait for a cause it never saw).
 */
function removedDrafts(
  threadId: ThreadId,
  queue: ThreadFollowUpQueue,
  messageIds: ReadonlyArray<MessageId>,
  reason: FollowUpQueueRemovalReason,
  occurredAt: string,
): ReadonlyArray<FollowUpQueueEventDraft> {
  const removing = new Set<string>(messageIds);
  const removed = queue.entries.filter((entry) => removing.has(entry.messageId));
  if (removed.length === 0) return [];
  const drafts: FollowUpQueueEventDraft[] = [
    {
      type: "thread.queue-entries-removed",
      payload: {
        threadId,
        messageIds: removed.map((entry) => entry.messageId),
        reason,
        updatedAt: occurredAt,
      },
    },
  ];
  if (removed.length === queue.entries.length && queue.hold !== null) {
    drafts.push({
      type: "thread.queue-released",
      payload: { threadId, acknowledgedCauseKeys: queue.hold.causeKeys, updatedAt: occurredAt },
    });
  }
  return drafts;
}

/** Model selections compare as the decider's wake fence compares them. */
const sameSelection = (left: QueuedFollowUp["modelSelection"], right: Thread["modelSelection"]) =>
  JSON.stringify(left) === JSON.stringify(right);

function addedEntry(command: ThreadQueueAddCommand, thread: Thread): QueuedFollowUp {
  const { entry } = command;
  const author = command.author ?? "user";
  return {
    messageId: entry.messageId,
    text: entry.text,
    attachments: entry.attachments,
    modelSelection: entry.modelSelection,
    runtimeMode: entry.runtimeMode,
    interactionMode: entry.interactionMode,
    ...(entry.tokenMode === undefined ? {} : { tokenMode: entry.tokenMode }),
    ...(entry.threadReferences === undefined ? {} : { threadReferences: entry.threadReferences }),
    ...(entry.claudeResumeReview === undefined
      ? {}
      : { claudeResumeReview: entry.claudeResumeReview }),
    createdAt: command.createdAt,
    updatedAt: command.createdAt,
    revision: 1,
    status: entry.failure === undefined ? "queued" : "failed",
    ...(entry.failure === undefined ? {} : { failure: entry.failure }),
    author,
    // A person's entry remembers the chat's selection it was queued over (see the field).
    ...(author === "user" ? { queuedOverModelSelection: thread.modelSelection } : {}),
    // Only an agent's entry names the chat that queued it.
    ...(command.author === "agent" && command.queuedBy !== undefined
      ? { queuedBy: command.queuedBy }
      : {}),
  };
}

/** The decision of one `thread.queue.*` command on `thread` (which exists). */
export function decideFollowUpQueueCommand(
  host: FollowUpQueueHost,
  readModel: OrchestrationReadModel,
  thread: Thread,
  command: FollowUpQueueCommand,
): FollowUpQueueDecision {
  const decision = decideQueueCommand(host, readModel, thread, command);
  return "refused" in decision
    ? decision
    : withHeadExemptions(host, thread, decision, command.createdAt);
}

/**
 * Releases the hold's causes a changed head no longer runs into: the person moved or edited a
 * follow-up for another provider instance to the front, which is how they recover from that
 * instance's error or usage limit (`headExemptCauseKeys`).
 */
function withHeadExemptions(
  host: FollowUpQueueHost,
  thread: Thread,
  decision: Extract<FollowUpQueueDecision, { readonly drafts: unknown }>,
  occurredAt: string,
): FollowUpQueueDecision {
  const before = followUpQueueOf(thread);
  const after = decision.drafts.reduce(
    (queue, draft) =>
      draft.type === "thread.turn-steer-requested" ? queue : applyQueueEvent(queue, draft),
    before,
  );
  const headInstance = (queue: ThreadFollowUpQueue) =>
    queue.entries[0]?.modelSelection.instanceId ?? null;
  if (after.hold === null || headInstance(after) === headInstance(before)) return decision;
  const released = releasedDraft(
    thread.id,
    after.hold,
    headExemptCauseKeys({
      hold: after.hold,
      headProviderInstanceId: headInstance(after),
      sessionError: currentSessionError(host, thread),
      usageLimit: thread.usageLimit ?? null,
    }),
    occurredAt,
  );
  return released === null ? decision : { drafts: [...decision.drafts, released] };
}

/**
 * The `error:` cause the thread's session still accounts for (the key `followUpQueueFollowOns`
 * held it under), with its instance; null without one, or after a restart, which is no provider
 * failure.
 */
function currentSessionError(
  host: FollowUpQueueHost,
  thread: Thread,
): { readonly causeKey: string; readonly providerInstanceId: string } | null {
  const session = thread.session;
  if (
    session === null ||
    session.lastError === null ||
    session.lastError === host.orphanedSessionError ||
    session.providerInstanceId === undefined ||
    session.providerInstanceId === null
  ) {
    return null;
  }
  return {
    causeKey: sessionErrorCauseKey(thread.latestTurn?.turnId ?? null, session.lastError),
    providerInstanceId: session.providerInstanceId,
  };
}

function decideQueueCommand(
  host: FollowUpQueueHost,
  readModel: OrchestrationReadModel,
  thread: Thread,
  command: FollowUpQueueCommand,
): FollowUpQueueDecision {
  const queue = followUpQueueOf(thread);
  const entryOf = (messageId: MessageId) =>
    queue.entries.find((entry) => entry.messageId === messageId);
  if (!host.isThreadLive(thread) || host.isThreadTrashed(thread)) {
    return refuse("This conversation is in Trash or was deleted.");
  }
  switch (command.type) {
    case "thread.queue.add": {
      const messageId = command.entry.messageId;
      const reserved = reservedMessageIdBlocker(
        host,
        thread.id,
        messageId,
        command.author ?? "user",
      );
      if (reserved !== null) return refuse(reserved);
      // Idempotent: a retry after a lost reply, a second device's copy, or a device queue that
      // moves to the node after its own send went through never makes a second message.
      if (
        command.alreadySent === true ||
        entryOf(messageId) !== undefined ||
        thread.messages.some((message) => message.id === messageId)
      ) {
        return NO_CHANGE;
      }
      if (thread.archivedAt !== null) return refuse("Unarchive this conversation to queue to it.");
      const lifecycle = host.threadLifecycleTurnBlocker(readModel, thread);
      if (lifecycle !== null) return refuse(lifecycle);
      if (queue.entries.length >= host.maxEntries) {
        return refuse(`The queue is full (${host.maxEntries} follow-ups).`);
      }
      if (!hasContent(command.entry)) return refuse("A follow-up needs text or an attachment.");
      const added: FollowUpQueueEventDraft = {
        type: "thread.queue-entry-added",
        payload: {
          threadId: thread.id,
          entry: addedEntry(command, thread),
          beforeMessageId:
            command.position === "head" ? (queue.entries[0]?.messageId ?? null) : null,
        },
      };
      // The hold the add carries, and a Stop of the caller's turn its own read could not see.
      const held = heldDraftOf(
        thread.id,
        queue.hold,
        [command.hold, interruptedTurnHold(thread, command)].filter(
          (hold): hold is FollowUpQueueHoldInput => hold !== undefined,
        ),
        command.createdAt,
      );
      return held === null ? record(added) : record(added, held);
    }

    case "thread.queue.edit": {
      const entry = entryOf(command.messageId);
      if (entry === undefined) return refuse(NOT_QUEUED);
      if (entry.revision !== command.expectedRevision) {
        return refuse("That follow-up changed since you opened it. Edit it again.");
      }
      if (entry.status === "steering") {
        return refuse("That follow-up is being sent into the running turn.");
      }
      if (command.queuedBy !== undefined && !queuedByAgentOf(entry, command.queuedBy)) {
        return refuse(NOT_THE_AGENTS);
      }
      // Only the entry's own stored attachments can stay; anything else is uploaded anew.
      const kept = new Set<string>(command.keptAttachmentIds ?? []);
      const keptAttachments = entry.attachments.filter(
        (attachment) => attachment.id !== undefined && kept.has(attachment.id),
      );
      if (keptAttachments.length !== kept.size) {
        return refuse("An attachment to keep is not one of this follow-up's.");
      }
      const attachments = [...keptAttachments, ...command.attachments];
      if (attachments.length > host.maxAttachments) {
        return refuse(`A follow-up takes at most ${host.maxAttachments} attachments.`);
      }
      if (!hasContent({ text: command.text, attachments })) {
        return refuse("A follow-up needs text or an attachment.");
      }
      return record({
        type: "thread.queue-entry-edited",
        payload: {
          threadId: thread.id,
          entry: {
            messageId: entry.messageId,
            text: command.text,
            attachments,
            modelSelection: command.modelSelection,
            runtimeMode: command.runtimeMode,
            interactionMode: command.interactionMode,
            ...(command.tokenMode === undefined ? {} : { tokenMode: command.tokenMode }),
            ...(command.threadReferences === undefined
              ? {}
              : { threadReferences: command.threadReferences }),
            ...(command.claudeResumeReview === undefined
              ? {}
              : { claudeResumeReview: command.claudeResumeReview }),
            createdAt: entry.createdAt,
            updatedAt: command.createdAt,
            revision: entry.revision + 1,
            status: entry.status,
            ...(entry.failure === undefined ? {} : { failure: entry.failure }),
            author: entry.author,
            // An edit to another model is queued over the chat's selection of now.
            ...(entry.author !== "user"
              ? {}
              : !sameSelection(command.modelSelection, entry.modelSelection)
                ? { queuedOverModelSelection: thread.modelSelection }
                : entry.queuedOverModelSelection === undefined
                  ? {}
                  : { queuedOverModelSelection: entry.queuedOverModelSelection }),
            // A person's edit makes the text theirs: the agent no longer changes it.
            ...(entry.queuedBy === undefined || command.queuedBy === undefined
              ? {}
              : { queuedBy: entry.queuedBy }),
          },
        },
      });
    }

    case "thread.queue.move": {
      const entry = entryOf(command.messageId);
      if (entry === undefined) return refuse(NOT_QUEUED);
      if (command.beforeMessageId === command.messageId) return NO_CHANGE;
      if (command.beforeMessageId !== null && entryOf(command.beforeMessageId) === undefined) {
        return refuse("The follow-up to move it before is no longer queued.");
      }
      const rest = queue.entries
        .map((candidate) => candidate.messageId)
        .filter((messageId) => messageId !== command.messageId);
      const index = command.beforeMessageId === null ? -1 : rest.indexOf(command.beforeMessageId);
      const order =
        index < 0
          ? [...rest, command.messageId]
          : [...rest.slice(0, index), command.messageId, ...rest.slice(index)];
      if (order.every((messageId, at) => queue.entries[at]?.messageId === messageId)) {
        return NO_CHANGE;
      }
      return record({
        type: "thread.queue-reordered",
        payload: { threadId: thread.id, order, updatedAt: command.createdAt },
      });
    }

    case "thread.queue.remove": {
      const { queuedBy } = command;
      if (
        queuedBy !== undefined &&
        !command.messageIds.every((messageId) => {
          const entry = entryOf(messageId);
          return (
            entry !== undefined && entry.status !== "steering" && queuedByAgentOf(entry, queuedBy)
          );
        })
      ) {
        return refuse(NOT_THE_AGENTS);
      }
      return record(
        ...removedDrafts(thread.id, queue, command.messageIds, "user", command.createdAt),
      );
    }

    case "thread.queue.steer": {
      const entry = entryOf(command.messageId);
      // Already sent, steered or removed: nothing left to steer.
      if (entry === undefined || entry.status === "steering") return NO_CHANGE;
      if (entry.status === "failed") return refuse("Retry this follow-up before sending it.");
      const session = thread.session;
      // The turn ended meanwhile: the entry stays queued and goes as the next turn.
      if (
        session?.status !== "running" ||
        session.activeTurnId === null ||
        session.activeTurnId !== command.expectedTurnId
      ) {
        return NO_CHANGE;
      }
      return record(
        {
          type: "thread.queue-entry-edited",
          payload: {
            threadId: thread.id,
            entry: {
              ...entry,
              status: "steering",
              revision: entry.revision + 1,
              updatedAt: command.createdAt,
            },
          },
        },
        {
          type: "thread.turn-steer-requested",
          payload: {
            threadId: thread.id,
            expectedTurnId: command.expectedTurnId,
            message: {
              messageId: entry.messageId,
              role: "user",
              text: entry.text,
              attachments: entry.attachments,
            },
            ...host.threadReferencesPayload(entry.threadReferences, thread.id),
            createdAt: command.createdAt,
            requestedAt: command.createdAt,
          },
        },
      );
    }

    case "thread.queue.hold": {
      if (queue.entries.length === 0) return NO_CHANGE;
      const held = heldDraft(
        thread.id,
        queue.hold,
        { reason: "paused", causeKeys: [pausedCauseKey(command.createdAt)], detail: null },
        command.createdAt,
      );
      return held === null ? NO_CHANGE : record(held);
    }

    case "thread.queue.resume": {
      const released = releasedDraft(
        thread.id,
        queue.hold,
        command.acknowledgeCauseKeys,
        command.createdAt,
      );
      return released === null ? NO_CHANGE : record(released);
    }

    case "thread.queue.retry": {
      const entry = entryOf(command.messageId);
      if (entry === undefined) return refuse(NOT_QUEUED);
      if (entry.status !== "failed") return NO_CHANGE;
      const { failure: _failure, ...rest } = entry;
      return record({
        type: "thread.queue-entry-edited",
        payload: {
          threadId: thread.id,
          entry: {
            ...rest,
            status: "queued",
            revision: entry.revision + 1,
            updatedAt: command.createdAt,
          },
        },
      });
    }

    case "thread.queue.hold.record": {
      if (queue.entries.length === 0) return NO_CHANGE;
      const held = heldDraft(
        thread.id,
        queue.hold,
        command.hold,
        command.createdAt,
        command.replacesCauseKeys,
      );
      return held === null ? NO_CHANGE : record(held);
    }
  }
}

// ── dispatch ─────────────────────────────────────────────────────────────

/**
 * Why a queue dispatch (`thread.turn.start` with `queueDispatch`) must be refused, or null. The
 * drain read the queue before; this is the decider's own, atomic check that the head it sends is
 * still that entry, at that revision, unheld, and never with more privilege than it was queued
 * with.
 */
export function followUpQueueDispatchBlocker(
  host: FollowUpQueueHost,
  thread: Thread,
  command: Extract<OrchestrationCommand, { type: "thread.turn.start" }>,
): string | null {
  const dispatch = command.queueDispatch;
  if (dispatch === undefined) return null;
  const queue = followUpQueueOf(thread);
  const head = queue.entries[0];
  if (queue.hold !== null) return "The follow-up queue is paused.";
  if (
    head === undefined ||
    head.messageId !== dispatch.messageId ||
    head.revision !== dispatch.revision ||
    command.message.messageId !== dispatch.messageId
  ) {
    return "The queued follow-up changed before it was sent.";
  }
  if (head.status !== "queued") return "The queued follow-up is not ready to send.";
  const rank = host.runtimeModePrivilegeRank;
  if (rank[command.runtimeMode] > rank[head.runtimeMode]) {
    return "A queued follow-up never runs with more permissions than it was queued with.";
  }
  // An agent's or an automation's entry never raises the thread's mode.
  if (head.author !== "user" && rank[command.runtimeMode] > rank[thread.runtimeMode]) {
    return "A queued follow-up the person did not write never raises the chat's permissions.";
  }
  return null;
}

type ModeDraft =
  | DraftOf<"thread.runtime-mode-set">
  | DraftOf<"thread.interaction-mode-set">
  | DraftOf<"thread.token-mode-set">;

/**
 * The modes an accepted queue dispatch runs with (its entry's, carried by the command) and the
 * `*-mode-set` events it records first where they differ from the thread's: what a client's send
 * of a queued message writes. The thread keeps them for its next turn.
 */
export function followUpQueueDispatchModes(
  host: FollowUpQueueHost,
  thread: Thread,
  command: Extract<OrchestrationCommand, { type: "thread.turn.start" }>,
) {
  const modes = {
    runtimeMode: command.runtimeMode,
    interactionMode: command.interactionMode,
    tokenMode: command.tokenMode ?? thread.tokenMode ?? host.defaultTokenMode,
  };
  const at = command.createdAt;
  const drafts: ModeDraft[] = [];
  if (modes.runtimeMode !== thread.runtimeMode) {
    drafts.push({
      type: "thread.runtime-mode-set",
      payload: { threadId: thread.id, runtimeMode: modes.runtimeMode, updatedAt: at },
    });
  }
  if (modes.interactionMode !== thread.interactionMode) {
    drafts.push({
      type: "thread.interaction-mode-set",
      payload: { threadId: thread.id, interactionMode: modes.interactionMode, updatedAt: at },
    });
  }
  if (modes.tokenMode !== (thread.tokenMode ?? host.defaultTokenMode)) {
    drafts.push({
      type: "thread.token-mode-set",
      payload: { threadId: thread.id, tokenMode: modes.tokenMode, updatedAt: at },
    });
  }
  // A person's entry: the selection its turn may replace (`queuedOverModelSelection`).
  const head = followUpQueueOf(thread).entries[0];
  const queuedOverModelSelection =
    head?.author === "user" && head.messageId === command.queueDispatch?.messageId
      ? head.queuedOverModelSelection
      : undefined;
  return {
    modes,
    drafts,
    ...(queuedOverModelSelection === undefined ? {} : { queuedOverModelSelection }),
  };
}

// ── holds and removals other commands record ─────────────────────────────

/** An event type's payload (`Omit` over the event union loses the type/payload link). */
type EventPayload<T extends OrchestrationEvent["type"]> = Extract<
  OrchestrationEvent,
  { type: T }
>["payload"];

const FOLLOW_ON_EVENT_TYPES: ReadonlySet<OrchestrationEvent["type"]> = new Set([
  "thread.message-sent",
  "thread.turn-steer-rejected",
  "thread.turn-interrupt-requested",
  "thread.usage-limit-set",
  "thread.usage-limit-cleared",
  "thread.session-set",
  "thread.session-stop-requested",
  "thread.trashed",
  "thread.deleted",
]);

/**
 * The queue events a command's own events cause, recorded in the same batch: a person's Stop
 * holds the queue, a new usage limit or a failed turn holds it (unless the head targets
 * another provider instance), a cleared limit releases its causes, a sent or steered message
 * leaves the queue, and Trash or deletion ends it. `events` are the command's planned events
 * in order; `readModel` is the model before them.
 */
export function followUpQueueFollowOns(
  host: FollowUpQueueHost,
  input: {
    readonly command: OrchestrationCommand;
    readonly readModel: OrchestrationReadModel;
    readonly events: ReadonlyArray<PlannedEvent>;
  },
): ReadonlyArray<FollowUpQueueEventDraft> {
  // The queue of each thread as this batch leaves it, so causes in one batch compose.
  const queues = new Map<ThreadId, ThreadFollowUpQueue>();
  const threads = new Map<ThreadId, Thread | undefined>();
  const threadOf = (threadId: ThreadId) => {
    if (!threads.has(threadId)) {
      threads.set(threadId, host.findThread(input.readModel.threads, threadId));
    }
    return threads.get(threadId);
  };
  const queueOf = (threadId: ThreadId) => {
    const known = queues.get(threadId);
    if (known !== undefined) return known;
    const thread = threadOf(threadId);
    return thread === undefined ? EMPTY_QUEUE : followUpQueueOf(thread);
  };
  const drafts: FollowUpQueueEventDraft[] = [];
  const emit = (threadId: ThreadId, next: ReadonlyArray<FollowUpQueueEventDraft | null>) => {
    let queue = queueOf(threadId);
    for (const draft of next) {
      if (draft === null) continue;
      drafts.push(draft);
      queue = applyQueueEvent(queue, draft);
    }
    queues.set(threadId, queue);
  };
  const headInstance = (queue: ThreadFollowUpQueue) =>
    queue.entries[0]?.modelSelection.instanceId ?? null;

  for (const event of input.events) {
    // Cheap checks first: the decider runs this for every command, streaming deltas included.
    if (event.aggregateKind !== "thread" || !FOLLOW_ON_EVENT_TYPES.has(event.type)) continue;
    if (
      event.type === "thread.message-sent" &&
      (event.payload as EventPayload<"thread.message-sent">).role !== "user"
    ) {
      continue;
    }
    const threadId = event.aggregateId as ThreadId;
    const queue = queueOf(threadId);
    if (queue.entries.length === 0 && queue.hold === null) continue;
    const thread = threadOf(threadId);
    switch (event.type) {
      case "thread.message-sent": {
        const payload = event.payload as EventPayload<"thread.message-sent">;
        if (payload.role !== "user") break;
        emit(
          threadId,
          removedDrafts(
            threadId,
            queue,
            [payload.messageId],
            payload.dispatchMode === "steer" ? "steered" : "dispatched",
            event.occurredAt,
          ),
        );
        break;
      }
      case "thread.turn-steer-rejected": {
        const payload = event.payload as EventPayload<"thread.turn-steer-rejected">;
        const entry = queue.entries.find((candidate) => candidate.messageId === payload.messageId);
        if (entry?.status !== "steering") break;
        emit(threadId, [
          payload.deliveryUncertain === true
            ? {
                type: "thread.queue-entry-failed",
                payload: {
                  threadId,
                  messageId: entry.messageId,
                  revision: entry.revision + 1,
                  failure: { reason: "steer-uncertain", detail: payload.error.slice(0, 1_000) },
                  updatedAt: event.occurredAt,
                },
              }
            : {
                type: "thread.queue-entry-edited",
                payload: {
                  threadId,
                  entry: {
                    ...entry,
                    status: "queued",
                    revision: entry.revision + 1,
                    updatedAt: event.occurredAt,
                  },
                },
              },
          // Its provider stopped the turn to take it (interrupt-restart): it goes next, ahead of
          // anything queued before it.
          ...(payload.restartedTurn === true && queue.entries[0]?.messageId !== entry.messageId
            ? [
                {
                  type: "thread.queue-reordered" as const,
                  payload: {
                    threadId,
                    order: [
                      entry.messageId,
                      ...queue.entries
                        .map((candidate) => candidate.messageId)
                        .filter((messageId) => messageId !== entry.messageId),
                    ],
                    updatedAt: event.occurredAt,
                  },
                },
              ]
            : []),
        ]);
        break;
      }
      case "thread.turn-interrupt-requested": {
        if (
          input.command.type !== "thread.turn.interrupt" ||
          input.command.holdQueue !== true ||
          queue.entries.length === 0
        ) {
          break;
        }
        const payload = event.payload as EventPayload<"thread.turn-interrupt-requested">;
        const stop = createInterruptQueueHold(payload.turnId ?? null, payload.createdAt);
        emit(threadId, [
          heldDraft(
            threadId,
            queue.hold,
            { reason: stop.reason, causeKeys: stop.causeKeys, detail: stop.detail },
            payload.createdAt,
          ),
        ]);
        break;
      }
      case "thread.usage-limit-set": {
        const limit = (event.payload as EventPayload<"thread.usage-limit-set">).usageLimit;
        if (queue.entries.length === 0) break;
        if (thread?.usageLimit?.limitId === limit.limitId) break;
        if (
          isQueueFailureCauseExempt(
            { reason: "limit", providerInstanceId: limit.providerInstanceId },
            headInstance(queue),
          )
        ) {
          break;
        }
        emit(threadId, [
          heldDraft(
            threadId,
            queue.hold,
            {
              reason: "limit",
              causeKeys: [usageLimitCauseKey(limit.turnId)],
              detail: limit.message,
            },
            event.occurredAt,
          ),
        ]);
        break;
      }
      case "thread.usage-limit-cleared": {
        const turnId = thread?.usageLimit?.turnId;
        if (turnId === undefined || queue.hold === null) break;
        // The limit's cause and the `error:` causes of the same limited turn.
        const errorPrefix = sessionErrorCauseKey(turnId, "");
        emit(threadId, [
          releasedDraft(
            threadId,
            queue.hold,
            queue.hold.causeKeys.filter(
              (key) => key === usageLimitCauseKey(turnId) || key.startsWith(errorPrefix),
            ),
            event.occurredAt,
          ),
        ]);
        break;
      }
      case "thread.session-set": {
        const payload = event.payload as EventPayload<"thread.session-set">;
        const session = payload.session;
        const turnFailed = payload.releasedTurn?.state === "error";
        const sessionFailed = session.status === "error" && thread?.session?.status !== "error";
        if (queue.entries.length === 0 || (!turnFailed && !sessionFailed)) break;
        // A restart's orphaned session: the restart hold the drain records at boot covers it.
        if (session.lastError === host.orphanedSessionError) break;
        if (
          isQueueFailureCauseExempt(
            { reason: "error", providerInstanceId: session.providerInstanceId ?? null },
            headInstance(queue),
          )
        ) {
          break;
        }
        emit(threadId, [
          heldDraft(
            threadId,
            queue.hold,
            {
              reason: "error",
              causeKeys: [
                sessionErrorCauseKey(
                  payload.releasedTurn?.turnId ?? thread?.latestTurn?.turnId ?? null,
                  session.lastError ?? null,
                ),
              ],
              detail: session.lastError?.slice(0, 1_000) ?? null,
            },
            event.occurredAt,
          ),
        ]);
        break;
      }
      case "thread.session-stop-requested": {
        // A person's "Stop session" holds a queue like a Stop does; the node's own stops do not.
        if (
          input.command.type !== "thread.session.stop" ||
          !host.isUserOriginatedCommandId(input.command.commandId) ||
          queue.entries.length === 0
        ) {
          break;
        }
        const at = (event.payload as EventPayload<"thread.session-stop-requested">).createdAt;
        const stop = createInterruptQueueHold(thread?.session?.activeTurnId ?? null, at);
        emit(threadId, [
          heldDraft(
            threadId,
            queue.hold,
            { reason: stop.reason, causeKeys: stop.causeKeys, detail: stop.detail },
            at,
          ),
        ]);
        break;
      }
      case "thread.trashed": {
        // Trash can be undone, so it pauses the queue; the entries wait for a restore and Resume.
        if (queue.entries.length === 0) break;
        const at = (event.payload as EventPayload<"thread.trashed">).trashedAt;
        emit(threadId, [
          heldDraft(
            threadId,
            queue.hold,
            {
              reason: "paused",
              causeKeys: [trashedCauseKey(at)],
              detail: "The chat was moved to Trash.",
            },
            at,
          ),
        ]);
        break;
      }
      case "thread.deleted":
        emit(
          threadId,
          removedDrafts(
            threadId,
            queue,
            queue.entries.map((entry) => entry.messageId),
            "thread-ended",
            event.occurredAt,
          ),
        );
        break;
      default:
        break;
    }
  }
  return drafts;
}

/** The queue rules bound to the boot side's host (what `followUpQueueLoader.ts` hands out). */
export const makeFollowUpQueueRules = (host: FollowUpQueueHost) => ({
  decideCommand: (
    readModel: OrchestrationReadModel,
    thread: Thread,
    command: FollowUpQueueCommand,
  ): FollowUpQueueDecision => decideFollowUpQueueCommand(host, readModel, thread, command),
  dispatchBlocker: (
    thread: Thread,
    command: Extract<OrchestrationCommand, { type: "thread.turn.start" }>,
  ): string | null => followUpQueueDispatchBlocker(host, thread, command),
  dispatchModes: (
    thread: Thread,
    command: Extract<OrchestrationCommand, { type: "thread.turn.start" }>,
  ) => followUpQueueDispatchModes(host, thread, command),
  followOns: (input: {
    readonly command: OrchestrationCommand;
    readonly readModel: OrchestrationReadModel;
    readonly events: ReadonlyArray<PlannedEvent>;
  }): ReadonlyArray<FollowUpQueueEventDraft> => followUpQueueFollowOns(host, input),
  project: projectFollowUpQueueEvent,
});
export type FollowUpQueueRules = ReturnType<typeof makeFollowUpQueueRules>;
