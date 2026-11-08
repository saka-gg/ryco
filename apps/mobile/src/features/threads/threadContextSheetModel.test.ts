import { describe, expect, it } from "vite-plus/test";

import { MessageId, ThreadId, TurnId } from "@ryco/contracts/base-schemas";
import type { AgentControlCompletionReturn } from "@ryco/contracts/agent-control";

import { buildThreadParentLink, threadStatusTone } from "./threadContextSheetModel";

const parentThreadId = ThreadId.make("parent-1");
const lineage = { parentThreadId, rootThreadId: parentThreadId, relationship: "delegated" };

function completionReturn(
  status: AgentControlCompletionReturn["status"],
): AgentControlCompletionReturn {
  return {
    revision: 1,
    childThreadId: ThreadId.make("child-1"),
    initialMessageId: MessageId.make("message-1"),
    parentThreadId,
    parentTurnId: TurnId.make("turn-1"),
    childTurnId: null,
    status,
    detail: "",
    updatedAt: "2026-11-08T10:00:00.000Z",
  };
}

describe("thread context sheet model", () => {
  it("gives each status word one tone", () => {
    expect(threadStatusTone("Running")).toBe("working");
    expect(threadStatusTone("Needs approval")).toBe("attention");
    expect(threadStatusTone("Input needed")).toBe("attention");
    expect(threadStatusTone("Ready")).toBe("ready");
    expect(threadStatusTone("Offline")).toBe("muted");
    expect(threadStatusTone("Archived")).toBe("muted");
  });

  it("links a delegated chat back to its parent with where its result stands", () => {
    expect(
      buildThreadParentLink({
        lineage,
        parentTitle: "Ship the release",
        completionReturn: completionReturn("delivered"),
      }),
    ).toEqual({
      threadId: parentThreadId,
      title: "Ship the release",
      resultLabel: "Returned",
      resultTone: "success",
    });
    expect(
      buildThreadParentLink({ lineage, parentTitle: "  ", completionReturn: undefined }),
    ).toMatchObject({ title: "Parent chat", resultLabel: null });
  });

  it("has no parent link for a chat that was not delegated", () => {
    expect(
      buildThreadParentLink({ lineage: null, parentTitle: "x", completionReturn: undefined }),
    ).toBeNull();
    expect(
      buildThreadParentLink({
        lineage: { ...lineage, relationship: "forked" },
        parentTitle: "x",
        completionReturn: undefined,
      }),
    ).toBeNull();
  });
});
