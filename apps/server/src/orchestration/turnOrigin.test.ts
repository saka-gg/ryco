import { CommandId, MessageId, ThreadId, TurnId, type OrchestrationCommand } from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import { stampTurnOrigin, turnOriginLine, withTurnOriginLine } from "./turnOrigin.ts";

const createdAt = "2026-10-28T10:00:00.000Z";
const message = {
  messageId: MessageId.make("message-1"),
  role: "user" as const,
  text: "Start the dev server",
  attachments: [],
};

describe("turnOrigin", () => {
  it("tells the agent only when the user is on another device", () => {
    expect(turnOriginLine(undefined)).toBeNull();
    expect(turnOriginLine({ connection: "local" })).toBeNull();
    expect(turnOriginLine({ connection: "remote" })).toContain("another device over the network");
    expect(turnOriginLine({ connection: "relay" })).toContain("through the Ryco relay");
    expect(turnOriginLine({ connection: "relay" })).toContain("localhost or 127.0.0.1");
  });

  it("puts the line in front of the provider input and leaves local input alone", () => {
    expect(withTurnOriginLine("Hi", { connection: "local" })).toBe("Hi");
    expect(withTurnOriginLine(undefined, undefined)).toBeUndefined();
    const relayed = withTurnOriginLine("Hi", { connection: "relay" });
    expect(relayed?.startsWith("<ryco_sent_from>")).toBe(true);
    expect(relayed?.endsWith("</ryco_sent_from>\n\nHi")).toBe(true);
    expect(withTurnOriginLine(undefined, { connection: "remote" })).toBe(
      turnOriginLine({ connection: "remote" }),
    );
  });

  it("stamps turn starts and steers only, and never without an origin", () => {
    const start: OrchestrationCommand = {
      type: "thread.turn.start",
      commandId: CommandId.make("start"),
      threadId: ThreadId.make("thread-1"),
      message,
      runtimeMode: "full-access",
      interactionMode: "default",
      createdAt,
    };
    const steer: OrchestrationCommand = {
      type: "thread.turn.steer",
      commandId: CommandId.make("steer"),
      threadId: ThreadId.make("thread-1"),
      expectedTurnId: TurnId.make("turn-1"),
      message,
      createdAt,
      requestedAt: createdAt,
    };
    const interrupt: OrchestrationCommand = {
      type: "thread.turn.interrupt",
      commandId: CommandId.make("interrupt"),
      threadId: ThreadId.make("thread-1"),
      createdAt,
    };
    expect(stampTurnOrigin(start, { connection: "relay" })).toEqual({
      ...start,
      origin: { connection: "relay" },
    });
    expect(stampTurnOrigin(steer, { connection: "remote" })).toEqual({
      ...steer,
      origin: { connection: "remote" },
    });
    expect(stampTurnOrigin(interrupt, { connection: "relay" })).toBe(interrupt);
    expect(stampTurnOrigin(start, undefined)).toBe(start);
  });
});
