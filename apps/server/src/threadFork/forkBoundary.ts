/**
 * Resolves where a fork's inherited history ends.
 *
 * The boundary is the reply a completed turn ended on: `selectFinalTurnReplies` from
 * `@ryco/shared/turnReply`, the one rule clients use to offer "Fork from here". An attachment-only
 * carrier a tool published after the reply never displaces it, and a steer after it (an image-only
 * one too) means the turn went on past it. The fork inherits every message up to and including the
 * boundary turn, and nothing that belongs to a later turn, even when a later turn's message
 * carries an earlier timestamp (prompts, steers and queued prompts are stamped by the sending
 * client's clock). Turn order comes from those client stamps too; server-assigned evidence
 * (checkpoint counts, reply times) must agree with it, or the boundary is
 * refused rather than guessed. Input comes from SQL (all messages with full text,
 * `projection_turns`, the session row), never from the capped in-memory read model.
 *
 * Pure: no services, no clocks.
 */
import type {
  MessageId,
  OrchestrationMessage,
  OrchestrationSessionStatus,
  ThreadForkErrorReason,
  TurnId,
} from "@ryco/contracts";
import { selectFinalTurnReplies } from "@ryco/shared/turnReply";

import type { ProjectionTurn } from "../persistence/Services/ProjectionTurns.ts";

/** The most messages a fork inherits (the `thread.fork.create` command's limit). */
export const FORK_MAX_INHERITED_MESSAGES = 2000;

export type ForkBoundaryTurn = Pick<
  ProjectionTurn,
  | "turnId"
  | "state"
  | "pendingMessageId"
  | "assistantMessageId"
  | "requestedAt"
  | "checkpointTurnCount"
  | "checkpointRef"
  | "checkpointStatus"
>;

export interface ForkBoundarySession {
  readonly activeTurnId: TurnId | null;
  readonly status: OrchestrationSessionStatus;
}

export type ForkBoundaryErrorReason = Extract<
  ThreadForkErrorReason,
  "boundary-stale" | "boundary-unsupported" | "source-busy"
>;

export interface ForkBoundary {
  readonly turnId: TurnId;
  /** The boundary turn's row (checkpoint fields included). */
  readonly turn: ForkBoundaryTurn & { readonly turnId: TurnId };
  readonly boundaryMessage: OrchestrationMessage;
  /**
   * Oldest first, by `(createdAt, id)`: everything through `boundaryMessage`, plus what the
   * boundary turn published after it (attachment-only carriers, system notes).
   */
  readonly inheritedMessages: ReadonlyArray<OrchestrationMessage>;
  /** Turns the fork inherits, oldest first; ends with `turnId`. */
  readonly inheritedTurnIds: ReadonlyArray<TurnId>;
  /** The source's identified turns after the boundary, oldest first. */
  readonly laterTurnIds: ReadonlyArray<TurnId>;
  /**
   * A turn has no id yet (a queued or starting prompt). It has not started, so it is later than
   * the boundary whatever its client stamp says, and its provider entries cannot be told apart
   * from the boundary turn's while it has none.
   */
  readonly unidentifiedLaterTurns: boolean;
  /** Inherited prompts (user messages that are not steers): a Claude copy's `turnCount`. */
  readonly inheritedUserTurnCount: number;
}

export type ForkBoundaryResult =
  | ({ readonly ok: true } & ForkBoundary)
  | { readonly ok: false; readonly reason: ForkBoundaryErrorReason; readonly detail: string };

/** `(createdAt, id)` with binary string order, as SQL sorts history. */
export function compareHistoryOrder(
  left: { readonly createdAt: string; readonly id: string },
  right: { readonly createdAt: string; readonly id: string },
): number {
  if (left.createdAt !== right.createdAt) return left.createdAt < right.createdAt ? -1 : 1;
  if (left.id !== right.id) return left.id < right.id ? -1 : 1;
  return 0;
}

/** Turn request order; ties broken by ids so every caller agrees. */
function compareTurnOrder(left: ForkBoundaryTurn, right: ForkBoundaryTurn): number {
  const keys = (turn: ForkBoundaryTurn) => [
    turn.requestedAt,
    turn.turnId ?? "",
    turn.pendingMessageId ?? "",
  ];
  const [a, b] = [keys(left), keys(right)];
  for (let index = 0; index < a.length; index++) {
    if (a[index] !== b[index]) return a[index]! < b[index]! ? -1 : 1;
  }
  return 0;
}

type ServerOrder = "earlier" | "later";

/**
 * What server-assigned facts say about `turn` relative to the boundary turn. Turns never overlap
 * (a turn starts only once the previous one settled), so a checkpoint count or a reply time on
 * either side of the boundary turn's places the whole turn there. (Completion times are not used:
 * reconciling a stale turn after a restart stamps it late.)
 */
function serverOrderEvidence(
  turn: ForkBoundaryTurn,
  boundary: { readonly turn: ForkBoundaryTurn; readonly message: OrchestrationMessage },
  messagesById: ReadonlyMap<string, OrchestrationMessage>,
): ReadonlyArray<ServerOrder> {
  const evidence: ServerOrder[] = [];
  const compare = (left: string | number, right: string | number) => {
    if (left !== right) evidence.push(left < right ? "earlier" : "later");
  };
  if (turn.checkpointTurnCount !== null && boundary.turn.checkpointTurnCount !== null) {
    compare(turn.checkpointTurnCount, boundary.turn.checkpointTurnCount);
  }
  const reply =
    turn.assistantMessageId === null ? undefined : messagesById.get(turn.assistantMessageId);
  if (reply !== undefined) {
    const order = compareHistoryOrder(reply, boundary.message);
    if (order !== 0) evidence.push(order < 0 ? "earlier" : "later");
  }
  return evidence;
}

const failure = (reason: ForkBoundaryErrorReason, detail: string): ForkBoundaryResult => ({
  ok: false,
  reason,
  detail,
});

export function resolveForkBoundary(input: {
  readonly messages: ReadonlyArray<OrchestrationMessage>;
  readonly turns: ReadonlyArray<ForkBoundaryTurn>;
  readonly session: ForkBoundarySession | null;
  readonly messageId: MessageId;
}): ForkBoundaryResult {
  const messages = input.messages.toSorted(compareHistoryOrder);
  const boundaryMessage = messages.find((message) => message.id === input.messageId);
  if (!boundaryMessage) {
    return failure("boundary-stale", "The message no longer exists. Refresh and pick again.");
  }
  if (boundaryMessage.role !== "assistant" || boundaryMessage.turnId === null) {
    return failure("boundary-unsupported", "Fork from an assistant reply.");
  }
  if (boundaryMessage.streaming) {
    return failure("source-busy", "This reply is still being written.");
  }
  const turnId = boundaryMessage.turnId;
  const turns = input.turns.toSorted(compareTurnOrder);
  const turnIndex = turns.findIndex((turn) => turn.turnId === turnId);
  const turn = turns[turnIndex];
  if (turn === undefined) {
    return failure("boundary-stale", "This reply's turn changed. Refresh and pick again.");
  }
  if (
    input.session?.activeTurnId === turnId ||
    turn.state === "running" ||
    turn.state === "pending"
  ) {
    return failure("source-busy", "This turn is still running.");
  }
  if (turn.state !== "completed") {
    return failure("boundary-unsupported", "Fork from the reply of a completed turn.");
  }
  // The reply the turn ended on, exactly as clients pick it: never a carrier published next to
  // it, and none when a steer came after it. Whatever of the turn follows it is a trailing carrier
  // or system note, which the fork inherits with the turn.
  const turnMessages = messages.filter((message) => message.turnId === turnId);
  if (selectFinalTurnReplies(turnMessages).get(turnId)?.id !== boundaryMessage.id) {
    return failure("boundary-unsupported", "Fork from the last reply of a turn.");
  }

  // Client clocks order the turns; refuse when the server's own record disagrees.
  const messagesById = new Map(messages.map((message) => [message.id as string, message]));
  for (const [index, other] of turns.entries()) {
    if (index === turnIndex) continue;
    const evidence = serverOrderEvidence(other, { turn, message: boundaryMessage }, messagesById);
    if (evidence.includes(index < turnIndex ? "later" : "earlier")) {
      return failure(
        "boundary-unsupported",
        "This conversation's turns were sent from devices whose clocks disagree, so Ryco cannot tell exactly where this reply ends. Fork from another reply.",
      );
    }
  }

  const laterTurns = turns.slice(turnIndex + 1);
  const laterTurnIdSet = new Set<string>(laterTurns.flatMap((later) => later.turnId ?? []));
  const laterPromptIds = new Set<string>(
    laterTurns.flatMap((later) => later.pendingMessageId ?? []),
  );
  const inheritedMessages = messages.filter(
    (message) =>
      (compareHistoryOrder(message, boundaryMessage) <= 0 || message.turnId === turnId) &&
      !(message.turnId !== null && laterTurnIdSet.has(message.turnId)) &&
      !(message.role === "user" && laterPromptIds.has(message.id)),
  );
  if (inheritedMessages.length > FORK_MAX_INHERITED_MESSAGES) {
    return failure(
      "boundary-unsupported",
      `This conversation is too long to fork (more than ${FORK_MAX_INHERITED_MESSAGES} messages).`,
    );
  }

  const inheritedTurnIds: TurnId[] = [];
  const seen = new Set<string>();
  const inherit = (id: TurnId | null) => {
    if (id !== null && !laterTurnIdSet.has(id) && !seen.has(id)) {
      seen.add(id);
      inheritedTurnIds.push(id);
    }
  };
  for (const earlier of turns.slice(0, turnIndex + 1)) inherit(earlier.turnId);
  for (const message of inheritedMessages) inherit(message.turnId);
  // The boundary turn always ends the list.
  const boundaryPosition = inheritedTurnIds.indexOf(turnId);
  inheritedTurnIds.splice(boundaryPosition, 1);
  inheritedTurnIds.push(turnId);

  return {
    ok: true,
    turnId,
    turn: { ...turn, turnId },
    boundaryMessage,
    inheritedMessages,
    inheritedTurnIds,
    laterTurnIds: laterTurns.flatMap((later) => later.turnId ?? []),
    unidentifiedLaterTurns: turns.some((other) => other.turnId === null),
    inheritedUserTurnCount: inheritedMessages.filter(
      (message) => message.role === "user" && message.dispatchMode !== "steer",
    ).length,
  };
}
