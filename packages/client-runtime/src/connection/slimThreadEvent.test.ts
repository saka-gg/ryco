import type { OrchestrationSlimThreadEvent, ThreadId } from "@ryco/contracts";
import { OrchestrationThreadWindowStreamItem } from "@ryco/contracts";
import { isUnknownUnionMember } from "@ryco/contracts/base-schemas";
import { Schema } from "effect";
import { describe, expect, it } from "vite-plus/test";

import { expandSlimThreadEvent } from "./slimThreadEvent.ts";

const threadId = "thread-1" as ThreadId;
const decode = Schema.decodeUnknownSync(OrchestrationThreadWindowStreamItem);

describe("expandSlimThreadEvent", () => {
  it("restores a slim event to the event the store applies", () => {
    const item = decode({
      kind: "slim-event",
      event: {
        sequence: 42,
        occurredAt: "2026-11-10T12:00:00.000Z",
        type: "thread.message-sent",
        payload: {
          threadId,
          messageId: "message-1",
          role: "assistant",
          text: "hello",
          turnId: null,
          streaming: true,
          createdAt: "2026-11-10T12:00:00.000Z",
          updatedAt: "2026-11-10T12:00:00.000Z",
        },
      },
    });
    if (item.kind !== "slim-event") throw new Error("expected a slim event");
    const event = expandSlimThreadEvent(item.event, threadId);
    expect(event).toMatchObject({
      sequence: 42,
      type: "thread.message-sent",
      aggregateKind: "thread",
      aggregateId: threadId,
      commandId: null,
      metadata: {},
      payload: { text: "hello" },
    });
  });

  it("keeps an event type a newer node added as an unknown member with its place", () => {
    const item = decode({
      kind: "slim-event",
      event: {
        sequence: 43,
        occurredAt: "2026-11-10T12:00:00.000Z",
        type: "thread.future",
        payload: {},
      },
    });
    if (item.kind !== "slim-event") throw new Error("expected a slim event");
    const event = expandSlimThreadEvent(item.event as OrchestrationSlimThreadEvent, threadId);
    expect(isUnknownUnionMember(event)).toBe(true);
    expect(event).toMatchObject({ sequence: 43, aggregateKind: "thread", aggregateId: threadId });
  });
});
