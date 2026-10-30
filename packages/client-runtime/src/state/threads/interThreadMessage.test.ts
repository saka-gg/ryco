import { ThreadId } from "@ryco/contracts";
import { agentSentMessageId } from "@ryco/shared/interThreadMessage";
import { describe, expect, it } from "vite-plus/test";

import {
  delegationReturnTone,
  delegationReturnVerb,
  interThreadMessageOf,
  interThreadRelationOf,
} from "./interThreadMessage.ts";

const parent = ThreadId.make("parent");
const child = ThreadId.make("child");
const delegatedFrom = (parentThreadId: ThreadId) => ({
  parentThreadId,
  rootThreadId: parentThreadId,
  relationship: "delegated",
});

describe("interThreadMessageOf", () => {
  it("reads the sender of an agent's message", () => {
    const id = agentSentMessageId({ operationSlug: "op-1", senderThreadId: child });
    expect(interThreadMessageOf({ id, role: "user", text: "Done" })).toEqual({
      kind: "agent-message",
      senderThreadId: child,
    });
    expect(
      interThreadMessageOf({
        id: "message-agent-control-op-1-send-message",
        role: "user",
        text: "",
      }),
    ).toEqual({ kind: "agent-message", senderThreadId: null });
  });

  it("reads a delegated result's tasks", () => {
    const text = [
      "Ryco delegation update.",
      "",
      "[1/1]",
      "Delegated initial-run result (completed).",
      "Child: [Open task](/ryco/thread/child)",
      '{"summary":"Opened PR #1004.","truncated":false}',
    ].join("\n");
    expect(interThreadMessageOf({ id: "delegation-result:child", role: "user", text })).toEqual({
      kind: "delegation-result",
      sections: [
        { childThreadId: "child", kind: "result", state: "completed", text: "Opened PR #1004." },
      ],
    });
  });

  it("leaves typed messages, Ryco's own wakes and replies alone", () => {
    expect(interThreadMessageOf({ id: "typed", role: "user", text: "Hi" })).toBeNull();
    expect(
      interThreadMessageOf({ id: "goal-continuation:1", role: "user", text: "Next" }),
    ).toBeNull();
    expect(
      interThreadMessageOf({ id: "delegation-result:child", role: "assistant", text: "" }),
    ).toBeNull();
  });
});

describe("interThreadRelationOf", () => {
  it("tells a delegated task reporting back from the parent that delegated this chat", () => {
    expect(
      interThreadRelationOf({
        threadId: parent,
        threadLineage: null,
        senderThreadId: child,
        senderLineage: delegatedFrom(parent),
      }),
    ).toBe("delegated-task");
    expect(
      interThreadRelationOf({
        threadId: child,
        threadLineage: delegatedFrom(parent),
        senderThreadId: parent,
        senderLineage: null,
      }),
    ).toBe("delegating-parent");
  });

  it("links nothing else: siblings, forks, unknown and missing senders", () => {
    const sibling = ThreadId.make("sibling");
    expect(
      interThreadRelationOf({
        threadId: child,
        threadLineage: delegatedFrom(parent),
        senderThreadId: sibling,
        senderLineage: delegatedFrom(parent),
      }),
    ).toBe("unlinked");
    expect(
      interThreadRelationOf({
        threadId: parent,
        threadLineage: null,
        senderThreadId: child,
        senderLineage: { ...delegatedFrom(parent), relationship: "forked" },
      }),
    ).toBe("unlinked");
    expect(
      interThreadRelationOf({
        threadId: parent,
        threadLineage: null,
        senderThreadId: child,
        senderLineage: undefined,
      }),
    ).toBe("unlinked");
    expect(
      interThreadRelationOf({
        threadId: parent,
        threadLineage: null,
        senderThreadId: null,
        senderLineage: undefined,
      }),
    ).toBe("unlinked");
  });
});

describe("delegated task outcomes", () => {
  it("words and tones each state", () => {
    expect(delegationReturnVerb({ state: "completed" })).toBe("finished and returned its result");
    expect(delegationReturnTone({ state: "completed" })).toBe("success");
    expect(delegationReturnTone({ state: "error" })).toBe("danger");
    expect(delegationReturnTone({ state: "expired" })).toBe("muted");
    expect(delegationReturnVerb({ state: "future-state" })).toBe("returned");
  });
});
