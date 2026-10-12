import { describe, expect, it } from "vitest";

import {
  FORKED_THREAD_RELATIONSHIP,
  forkContextHandoffPending,
  inheritedItemId,
  inheritedItemIdPrefix,
  isForkBaseItemId,
  isInheritedItemId,
  originalItemId,
  readThreadForkedActivity,
  threadForkedActivityId,
  threadHasConversation,
  threadIdOfForkedActivityId,
} from "./threadFork.ts";

function forked(overrides: Record<string, unknown> = {}) {
  return {
    kind: "thread.forked",
    payload: {
      schemaVersion: 1,
      sourceThreadId: "source",
      sourceMessageId: "source-reply",
      sourceTurnId: "source-turn",
      sourceTitle: "Refactor auth",
      inheritedMessageCount: 4,
      providerContext: "handoff",
      handoffReason: "provider-unsupported",
      checkout: { kind: "current-checkout", worktreePath: null, branch: "main" },
      notices: [],
      ...overrides,
    },
  };
}

function handoff(status: string, reason = "fork") {
  return {
    kind: "context-handoff",
    payload: {
      schemaVersion: 1,
      handoffId: "handoff-1",
      mode: "full-context-fresh-session",
      reason,
      targetMessageId: "first-own-message",
      sourceSelection: { instanceId: "opencode", model: "model" },
      targetSelection: { instanceId: "opencode", model: "model" },
      sources: [{ providerInstanceId: "opencode", driverKind: "opencode", modelSlug: "model" }],
      target: { providerInstanceId: "opencode", driverKind: "opencode", modelSlug: "model" },
      contextVersion: 1,
      contextDigest: "a".repeat(64),
      status,
      ...(status === "failed" || status === "delivery-uncertain"
        ? { error: "Provider exited" }
        : {}),
    },
  };
}

describe("readThreadForkedActivity", () => {
  it("decodes the provenance payload of a thread.forked activity only", () => {
    expect(readThreadForkedActivity(forked())).toMatchObject({
      sourceThreadId: "source",
      providerContext: "handoff",
      handoffReason: "provider-unsupported",
    });
    expect(readThreadForkedActivity({ ...forked(), kind: "tool.completed" })).toBeNull();
  });

  it("returns null for a payload this build cannot read", () => {
    expect(readThreadForkedActivity(forked({ schemaVersion: 2 }))).toBeNull();
    expect(readThreadForkedActivity({ kind: "thread.forked", payload: null })).toBeNull();
  });
});

describe("forkContextHandoffPending", () => {
  it("is pending for a handoff fork until a context handoff is consumed", () => {
    expect(forkContextHandoffPending([forked()])).toBe(true);
    expect(forkContextHandoffPending([forked(), handoff("consumed")])).toBe(false);
    // A consumed handoff recorded before the provenance in the list still counts.
    expect(forkContextHandoffPending([handoff("consumed"), forked()])).toBe(false);
  });

  it("stays pending after a failed or unconfirmed delivery so the next send retries", () => {
    expect(forkContextHandoffPending([forked(), handoff("failed")])).toBe(true);
    expect(forkContextHandoffPending([forked(), handoff("delivery-uncertain")])).toBe(true);
    expect(forkContextHandoffPending([forked(), handoff("requested")])).toBe(true);
  });

  it("is never pending for native forks, threads that were not forked, or unreadable provenance", () => {
    expect(
      forkContextHandoffPending([forked({ providerContext: "native", handoffReason: undefined })]),
    ).toBe(false);
    expect(forkContextHandoffPending([])).toBe(false);
    expect(forkContextHandoffPending([forked({ providerContext: "telepathy" })])).toBe(false);
  });
});

describe("inherited item identity", () => {
  it("prefixes a copy with its fork and keeps the original id through forks of forks", () => {
    const first = inheritedItemId({
      forkThreadId: "fork-a",
      sourceThreadId: "s",
      sourceItemId: "m",
    });
    expect(first).toBe("fork-a:inherited:m");
    expect(isInheritedItemId("fork-a", first)).toBe(true);
    expect(isInheritedItemId("fork-b", first)).toBe(false);
    const second = inheritedItemId({
      forkThreadId: "fork-b",
      sourceThreadId: "fork-a",
      sourceItemId: first,
    });
    expect(second).toBe(`${inheritedItemIdPrefix("fork-b")}m`);
    expect(originalItemId("fork-b", second)).toBe("m");
  });

  it("treats a fork's inherited items and its provenance as base items no revert removes", () => {
    expect(isForkBaseItemId("fork-a", "fork-a:inherited:m")).toBe(true);
    expect(isForkBaseItemId("fork-a", threadForkedActivityId("fork-a"))).toBe(true);
    expect(isForkBaseItemId("fork-a", "own-message")).toBe(false);
    // Another fork's items and provenance are not this fork's base.
    expect(isForkBaseItemId("fork-a", "fork-b:inherited:m")).toBe(false);
    expect(isForkBaseItemId("fork-a", threadForkedActivityId("fork-b"))).toBe(false);
  });

  it("finds the fork a provenance activity id belongs to", () => {
    expect(threadIdOfForkedActivityId(threadForkedActivityId("fork-a"))).toBe("fork-a");
    expect(threadIdOfForkedActivityId("fork-a:inherited:tool")).toBeNull();
    expect(threadIdOfForkedActivityId(":forked")).toBeNull();
  });
});

describe("threadHasConversation", () => {
  it("counts a fork's inherited conversation before it sends anything of its own", () => {
    expect(
      threadHasConversation({
        latestUserMessageAt: null,
        lineage: { relationship: FORKED_THREAD_RELATIONSHIP },
      }),
    ).toBe(true);
    expect(threadHasConversation({ latestUserMessageAt: "2026-10-11T00:00:00.000Z" })).toBe(true);
    expect(threadHasConversation({ latestUserMessageAt: null })).toBe(false);
    expect(
      threadHasConversation({ latestUserMessageAt: null, lineage: { relationship: "delegated" } }),
    ).toBe(false);
  });
});
