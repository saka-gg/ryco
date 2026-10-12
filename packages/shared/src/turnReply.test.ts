import { TurnId } from "@ryco/contracts";
import { describe, expect, it } from "vitest";

import {
  continuesTurnAfterReply,
  isAttachmentOnlyMessage,
  selectFinalTurnReplies,
  selectTurnReplyMessage,
} from "./turnReply.ts";

const turn = TurnId.make("turn-1");

interface Message {
  readonly id: string;
  readonly role: "user" | "assistant" | "system";
  readonly text: string;
  readonly attachments?: ReadonlyArray<unknown>;
  readonly streaming: boolean;
  readonly turnId: TurnId | null;
}

const user = (id: string, turnId: TurnId | null = turn): Message => ({
  id,
  role: "user",
  text: id,
  streaming: false,
  turnId,
});
const reply = (id: string, turnId: TurnId | null = turn, streaming = false): Message => ({
  id,
  role: "assistant",
  text: id,
  streaming,
  turnId,
});
const page = (id: string, turnId: TurnId | null = turn): Message => ({
  id,
  role: "assistant",
  text: " ",
  attachments: [{ id: `${id}-file` }],
  streaming: false,
  turnId,
});
const notice = (id: string): Message => ({
  id,
  role: "system",
  text: id,
  streaming: false,
  turnId: turn,
});

const finalIds = (messages: ReadonlyArray<Message>) =>
  [...selectFinalTurnReplies(messages).values()].map((message) => message.id);

describe("isAttachmentOnlyMessage", () => {
  it("is a finished message with blank text and an attachment", () => {
    expect(isAttachmentOnlyMessage(page("p"))).toBe(true);
    expect(isAttachmentOnlyMessage(reply("r"))).toBe(false);
    expect(isAttachmentOnlyMessage({ ...page("p"), streaming: true })).toBe(false);
    expect(isAttachmentOnlyMessage({ ...page("p"), attachments: [] })).toBe(false);
  });
});

describe("continuesTurnAfterReply", () => {
  it("is any later message except a system notice or an assistant carrier", () => {
    expect(continuesTurnAfterReply(user("steer"))).toBe(true);
    expect(continuesTurnAfterReply(reply("more"))).toBe(true);
    expect(continuesTurnAfterReply(notice("n"))).toBe(false);
    expect(continuesTurnAfterReply(page("p"))).toBe(false);
    // An image-only steer is still a steer.
    expect(continuesTurnAfterReply({ ...page("image"), role: "user" })).toBe(true);
  });
});

describe("selectFinalTurnReplies", () => {
  it("picks the same reply as selectTurnReplyMessage when nothing continues the turn", () => {
    for (const messages of [
      [user("u"), reply("r1"), reply("r2")],
      [user("u"), reply("r"), page("p")],
      [user("u"), page("p"), reply("r")],
      [user("u"), page("p1"), page("p2")],
      [user("u"), reply("r"), notice("n")],
    ]) {
      expect(finalIds(messages)).toEqual([selectTurnReplyMessage(messages, turn)?.id]);
    }
  });

  it("drops a turn whose reply was followed by a steer", () => {
    expect(finalIds([user("u"), reply("r"), user("steer")])).toEqual([]);
    expect(finalIds([user("u"), reply("r"), page("p"), user("steer")])).toEqual([]);
    expect(finalIds([user("u"), page("p"), user("steer")])).toEqual([]);
    // A reply after the steer ends the turn again.
    expect(finalIds([user("u"), reply("r1"), user("steer"), reply("r2")])).toEqual(["r2"]);
  });

  it("keeps a streaming reply as the turn's reply, so callers can refuse it", () => {
    expect(finalIds([user("u"), reply("r", turn, true)])).toEqual(["r"]);
  });

  it("answers per turn and ignores turnless messages", () => {
    const other = TurnId.make("turn-2");
    expect(
      finalIds([
        user("u1"),
        reply("r1"),
        user("u2", other),
        reply("r2", other),
        page("p2", other),
        reply("legacy", null),
      ]).toSorted(),
    ).toEqual(["r1", "r2"]);
  });
});
