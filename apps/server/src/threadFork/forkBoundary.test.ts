import { MessageId, TurnId } from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  FORK_MAX_INHERITED_MESSAGES,
  type ForkBoundaryTurn,
  resolveForkBoundary,
} from "./forkBoundary.ts";
import { message, sourceHistory, turnRow } from "./forkHistory.fixtures.ts";

const resolve = (
  messageId: string,
  overrides: Partial<Parameters<typeof resolveForkBoundary>[0]> = {},
) => {
  const { messages, turns } = sourceHistory();
  return resolveForkBoundary({
    messages,
    turns,
    session: { activeTurnId: null, status: "ready" },
    messageId: MessageId.make(messageId),
    ...overrides,
  });
};

describe("resolveForkBoundary", () => {
  it("inherits everything through the selected turn's reply and nothing of later turns", () => {
    const result = resolve("assistant-2b");
    if (!result.ok) throw new Error(result.detail);
    expect(result.turnId).toBe("turn-2");
    expect(result.boundaryMessage.id).toBe("assistant-2b");
    // The skewed steer of turn 3 and the queued prompt predate the reply but are later turns';
    // turn 2's own system note after its reply belongs to the inherited turn.
    expect(result.inheritedMessages.map((entry) => entry.id)).toEqual([
      "user-1",
      "assistant-1",
      "user-2",
      "assistant-2a",
      "steer-2",
      "assistant-2b",
      "system-2",
    ]);
    expect(result.inheritedTurnIds).toEqual(["turn-1", "turn-2"]);
    expect(result.laterTurnIds).toEqual(["turn-3"]);
    expect(result.unidentifiedLaterTurns).toBe(true);
    expect(result.inheritedUserTurnCount).toBe(2);
    expect(result.turn.turnId).toBe("turn-2");
  });

  it("inherits the whole thread at its newest reply", () => {
    const result = resolve("assistant-3");
    if (!result.ok) throw new Error(result.detail);
    expect(result.inheritedMessages.map((entry) => entry.id)).toEqual([
      "user-1",
      "assistant-1",
      "user-2",
      "assistant-2a",
      "steer-2",
      "steer-3-skewed",
      "assistant-2b",
      "system-2",
      "user-3",
      "assistant-3",
    ]);
    expect(result.inheritedTurnIds).toEqual(["turn-1", "turn-2", "turn-3"]);
    expect(result.laterTurnIds).toEqual([]);
    // The queued prompt's turn has no id yet: a newest-turn native cutoff cannot be proven.
    expect(result.unidentifiedLaterTurns).toBe(true);
    const settled = resolve("assistant-3", {
      turns: sourceHistory().turns.filter((turn) => turn.turnId !== null),
    });
    expect(settled).toMatchObject({ ok: true, laterTurnIds: [], unidentifiedLaterTurns: false });
  });

  it("refuses mid-turn commentary, prompts and missing messages", () => {
    expect(resolve("assistant-2a")).toMatchObject({ ok: false, reason: "boundary-unsupported" });
    expect(resolve("user-2")).toMatchObject({ ok: false, reason: "boundary-unsupported" });
    expect(resolve("system-2")).toMatchObject({ ok: false, reason: "boundary-unsupported" });
    expect(resolve("gone")).toMatchObject({ ok: false, reason: "boundary-stale" });
  });

  it("refuses a reply whose turn row disappeared (reverted)", () => {
    const { turns } = sourceHistory();
    expect(
      resolve("assistant-2b", { turns: turns.filter((turn) => turn.turnId !== "turn-2") }),
    ).toMatchObject({ ok: false, reason: "boundary-stale" });
  });

  it("refuses running, streaming and unfinished turns", () => {
    expect(
      resolve("assistant-3", {
        session: { activeTurnId: TurnId.make("turn-3"), status: "running" },
      }),
    ).toMatchObject({ ok: false, reason: "source-busy" });
    const { messages, turns, t3 } = sourceHistory();
    const streaming = [
      ...messages.filter((entry) => entry.id !== "assistant-3"),
      message("assistant-3", "assistant", 25, { turnId: t3, streaming: true }),
    ];
    expect(resolve("assistant-3", { messages: streaming })).toMatchObject({
      ok: false,
      reason: "source-busy",
    });
    const withTurn3 = (state: ForkBoundaryTurn["state"]) => [
      ...turns.filter((turn) => turn.turnId !== "turn-3"),
      turnRow("turn-3", 20, "user-3", { state }),
    ];
    for (const state of ["interrupted", "error"] as const) {
      expect(resolve("assistant-3", { turns: withTurn3(state) })).toMatchObject({
        ok: false,
        reason: "boundary-unsupported",
      });
    }
    expect(resolve("assistant-3", { turns: withTurn3("running") })).toMatchObject({
      ok: false,
      reason: "source-busy",
    });
  });

  it("does not depend on input order", () => {
    const { messages, turns } = sourceHistory();
    const forward = resolve("assistant-2b");
    const reversed = resolve("assistant-2b", {
      messages: messages.toReversed(),
      turns: turns.toReversed(),
    });
    expect(reversed).toEqual(forward);
  });

  it("refuses histories longer than a fork can carry", () => {
    const turnId = TurnId.make("turn-long");
    const messages = Array.from({ length: FORK_MAX_INHERITED_MESSAGES + 1 }, (_, index) =>
      message(`m-${String(index).padStart(5, "0")}`, "assistant", 30, { turnId }),
    );
    expect(
      resolveForkBoundary({
        messages,
        turns: [turnRow("turn-long", 1, null)],
        session: null,
        messageId: messages.at(-1)!.id,
      }),
    ).toMatchObject({ ok: false, reason: "boundary-unsupported" });
  });
});

describe("resolveForkBoundary with attachment carriers", () => {
  const turnId = TurnId.make("turn-1");
  const carrier = (id: string, seconds: number) =>
    message(id, "assistant", seconds, {
      turnId,
      text: " ",
      attachments: [
        {
          type: "file",
          id: `thread-${id}-11111111-1111-4111-8111-111111111111`,
          name: "page.html",
          mimeType: "text/html",
          sizeBytes: 10,
        },
      ],
    });
  const resolveIn = (messages: ReturnType<typeof message>[], messageId: string) =>
    resolveForkBoundary({
      messages,
      turns: [turnRow("turn-1", 1, "user-1")],
      session: null,
      messageId: MessageId.make(messageId),
    });

  it("forks from the turn's reply when a page is published after it, and inherits the page", () => {
    const messages = [
      message("user-1", "user", 1),
      message("reply", "assistant", 5, { turnId, text: "Revenue grew 40%." }),
      carrier("page", 6),
    ];
    const result = resolveIn(messages, "reply");
    if (!result.ok) throw new Error(result.detail);
    expect(result.inheritedMessages.map((entry) => entry.id)).toEqual(["user-1", "reply", "page"]);
    // The carrier is not the turn's reply while the turn has one.
    expect(resolveIn(messages, "page")).toMatchObject({
      ok: false,
      reason: "boundary-unsupported",
    });
  });

  it("forks from a text reply that follows a page", () => {
    const messages = [
      message("user-1", "user", 1),
      carrier("page", 4),
      message("reply", "assistant", 5, { turnId, text: "Here it is." }),
    ];
    const result = resolveIn(messages, "reply");
    if (!result.ok) throw new Error(result.detail);
    expect(result.inheritedMessages.map((entry) => entry.id)).toEqual(["user-1", "page", "reply"]);
    expect(resolveIn(messages, "page")).toMatchObject({ ok: false });
  });

  it("forks from the carrier of a turn that has nothing else, and refuses a reply a steer follows", () => {
    const pageOnly = [message("user-1", "user", 1), carrier("page-a", 4), carrier("page-b", 5)];
    const result = resolveIn(pageOnly, "page-b");
    if (!result.ok) throw new Error(result.detail);
    expect(result.inheritedMessages.map((entry) => entry.id)).toEqual([
      "user-1",
      "page-a",
      "page-b",
    ]);
    expect(resolveIn(pageOnly, "page-a")).toMatchObject({ ok: false });

    const steered = [
      message("user-1", "user", 1),
      message("reply", "assistant", 5, { turnId, text: "Done." }),
      carrier("page", 6),
      message("steer", "user", 7, { turnId, dispatchMode: "steer" }),
    ];
    expect(resolveIn(steered, "reply")).toMatchObject({
      ok: false,
      reason: "boundary-unsupported",
    });
  });
});

describe("resolveForkBoundary with skewed client clocks", () => {
  // Turn N is sent from a desktop at :20 and answered at :30. Turn N+1 is sent afterwards from a
  // phone whose clock is 15 s slow (stamped :18) and answered at :45 (server time).
  const turnN = TurnId.make("turn-n");
  const turnN1 = TurnId.make("turn-n1");
  const skewed = (overrides: { readonly n1Reply?: boolean; readonly counts?: boolean } = {}) => ({
    messages: [
      message("user-1", "user", 1),
      message("reply-1", "assistant", 5, { turnId: TurnId.make("turn-1") }),
      message("user-n1", "user", 18),
      message("user-n", "user", 20),
      message("reply-n", "assistant", 30, { turnId: turnN }),
      ...(overrides.n1Reply === false
        ? []
        : [message("reply-n1", "assistant", 45, { turnId: turnN1 })]),
    ],
    turns: [
      turnRow("turn-1", 1, "user-1", {
        assistantMessageId: MessageId.make("reply-1"),
        ...(overrides.counts ? { checkpointTurnCount: 1 } : {}),
      }),
      turnRow("turn-n", 20, "user-n", {
        assistantMessageId: MessageId.make("reply-n"),
        ...(overrides.counts ? { checkpointTurnCount: 2 } : {}),
      }),
      turnRow("turn-n1", 18, "user-n1", {
        assistantMessageId: overrides.n1Reply === false ? null : MessageId.make("reply-n1"),
        ...(overrides.counts ? { checkpointTurnCount: 3 } : {}),
      }),
    ],
  });

  it("refuses rather than inheriting a later turn's prompt when the server's order disagrees", () => {
    const { messages, turns } = skewed();
    expect(
      resolveForkBoundary({ messages, turns, session: null, messageId: MessageId.make("reply-n") }),
    ).toMatchObject({ ok: false, reason: "boundary-unsupported" });
    // Checkpoint counts tell the same story without the reply.
    const counted = skewed({ n1Reply: false, counts: true });
    expect(
      resolveForkBoundary({
        messages: counted.messages,
        turns: counted.turns,
        session: null,
        messageId: MessageId.make("reply-n"),
      }),
    ).toMatchObject({ ok: false, reason: "boundary-unsupported" });
    // Its own reply is refused too: turn N sorts after it but was answered first.
    expect(
      resolveForkBoundary({
        messages,
        turns,
        session: null,
        messageId: MessageId.make("reply-n1"),
      }),
    ).toMatchObject({ ok: false, reason: "boundary-unsupported" });
  });

  it("forks normally when the client order matches the server's", () => {
    const { messages } = sourceHistory();
    // Every turn's reply and checkpoint count agree with the order its prompt was sent in.
    const turns = [
      turnRow("turn-1", 1, "user-1", {
        assistantMessageId: MessageId.make("assistant-1"),
        checkpointTurnCount: 1,
      }),
      turnRow("turn-2", 10, "user-2", {
        assistantMessageId: MessageId.make("assistant-2b"),
        checkpointTurnCount: 2,
      }),
      turnRow("turn-3", 20, "user-3", {
        assistantMessageId: MessageId.make("assistant-3"),
        checkpointTurnCount: 3,
      }),
    ];
    const result = resolveForkBoundary({
      messages,
      turns,
      session: null,
      messageId: MessageId.make("assistant-2b"),
    });
    expect(result).toMatchObject({ ok: true, laterTurnIds: ["turn-3"] });
  });
});

describe("resolveForkBoundary unidentified turns", () => {
  it("counts a queued prompt as later even when its client stamp sorts it earlier", () => {
    const { messages, turns } = sourceHistory();
    const skewedQueue = [
      ...turns.filter((turn) => turn.turnId !== null),
      turnRow(null, 2, "queued-4", { state: "pending" }),
    ];
    const result = resolveForkBoundary({
      messages,
      turns: skewedQueue,
      session: null,
      messageId: MessageId.make("assistant-3"),
    });
    expect(result).toMatchObject({ ok: true, laterTurnIds: [], unidentifiedLaterTurns: true });
  });
});
