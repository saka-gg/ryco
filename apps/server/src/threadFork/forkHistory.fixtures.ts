import { MessageId, type OrchestrationMessage, TurnId } from "@ryco/contracts";

import type { ForkBoundaryTurn } from "./forkBoundary.ts";

const at = (seconds: number) => `2026-10-11T10:00:${String(seconds).padStart(2, "0")}.000Z`;

export const message = (
  id: string,
  role: OrchestrationMessage["role"],
  seconds: number,
  overrides: Partial<OrchestrationMessage> = {},
): OrchestrationMessage => ({
  id: MessageId.make(id),
  role,
  text: `${role} ${id}`,
  turnId: null,
  streaming: false,
  createdAt: at(seconds),
  updatedAt: at(seconds),
  ...overrides,
});

export const turnRow = (
  turnId: string | null,
  seconds: number,
  pendingMessageId: string | null,
  overrides: Partial<ForkBoundaryTurn> = {},
): ForkBoundaryTurn => ({
  turnId: turnId === null ? null : TurnId.make(turnId),
  state: "completed",
  pendingMessageId: pendingMessageId === null ? null : MessageId.make(pendingMessageId),
  assistantMessageId: null,
  requestedAt: at(seconds),
  checkpointTurnCount: null,
  checkpointRef: null,
  checkpointStatus: null,
  ...overrides,
});

/**
 * Three completed turns. Turn 2 has mid-turn commentary and a steer; turn 3 has a steer whose
 * client clock is earlier than turn 2's reply, and a queued prompt waits behind it.
 */
export function sourceHistory() {
  const t1 = TurnId.make("turn-1");
  const t2 = TurnId.make("turn-2");
  const t3 = TurnId.make("turn-3");
  const messages = [
    message("user-1", "user", 1),
    message("assistant-1", "assistant", 5, { turnId: t1 }),
    message("user-2", "user", 10),
    message("assistant-2a", "assistant", 12, { turnId: t2 }),
    message("steer-2", "user", 13, { turnId: t2, dispatchMode: "steer" }),
    message("steer-3-skewed", "user", 14, { turnId: t3, dispatchMode: "steer" }),
    message("assistant-2b", "assistant", 15, { turnId: t2 }),
    message("queued-4", "user", 15, { dispatchMode: "queue" }),
    message("system-2", "system", 16, { turnId: t2 }),
    message("user-3", "user", 20),
    message("assistant-3", "assistant", 25, { turnId: t3 }),
  ];
  const turns = [
    turnRow("turn-1", 1, "user-1"),
    turnRow("turn-2", 10, "user-2"),
    turnRow("turn-3", 20, "user-3"),
    turnRow(null, 21, "queued-4", { state: "pending" }),
  ];
  return { t1, t2, t3, messages, turns };
}
