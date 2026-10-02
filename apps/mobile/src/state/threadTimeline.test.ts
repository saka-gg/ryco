import type { Thread } from "@ryco/client-runtime/state/threads";
import { describe, expect, it } from "vite-plus/test";

import { buildThreadTimeline, createThreadTimelineBuilder } from "./threadTimelineModel";

function thread(overrides: Partial<Thread>): Thread {
  return {
    activities: [],
    messages: [],
    proposedPlans: [],
    latestTurn: null,
    session: null,
    ...overrides,
  } as unknown as Thread;
}

describe("buildThreadTimeline", () => {
  it("reuses activity derivation and unchanged entries across text updates", () => {
    const build = createThreadTimelineBuilder();
    const initial = thread({
      messages: [
        { id: "message", role: "assistant", text: "a", createdAt: "2026-07-24T09:00:00.000Z" },
      ] as unknown as Thread["messages"],
    });
    const first = build(initial)!;
    const updated = { ...initial, messages: [{ ...initial.messages[0]!, text: "ab" }] };
    const second = build(updated)!;
    expect(second.viewModel).toBe(first.viewModel);
    expect(second).toEqual(buildThreadTimeline(updated));
    expect(build(updated)!.timeline).toBe(second.timeline);
    expect(build({ ...updated, activities: [] })!.viewModel).not.toBe(second.viewModel);
  });

  it("returns null for a missing thread", () => {
    expect(buildThreadTimeline(null)).toBeNull();
  });

  it("flows a proposed plan through the view model into a proposed-plan timeline entry", () => {
    const built = buildThreadTimeline(
      thread({
        proposedPlans: [
          {
            id: "plan-1",
            turnId: null,
            planMarkdown: "1. Do the thing",
            implementedAt: null,
            implementationThreadId: null,
            createdAt: "2026-07-24T10:00:00.000Z",
            updatedAt: "2026-07-24T10:00:00.000Z",
          },
        ] as unknown as Thread["proposedPlans"],
      }),
    );

    expect(built).not.toBeNull();
    const planEntries = built!.timeline.filter((entry) => entry.kind === "proposed-plan");
    expect(planEntries).toHaveLength(1);
    expect(planEntries[0]!.id).toBe("plan-1");
  });

  it("orders a message and a proposed plan by createdAt", () => {
    const built = buildThreadTimeline(
      thread({
        messages: [
          {
            id: "msg-1",
            role: "user",
            createdAt: "2026-07-24T09:00:00.000Z",
          },
        ] as unknown as Thread["messages"],
        proposedPlans: [
          {
            id: "plan-1",
            turnId: null,
            planMarkdown: "later",
            implementedAt: null,
            implementationThreadId: null,
            createdAt: "2026-07-24T10:00:00.000Z",
            updatedAt: "2026-07-24T10:00:00.000Z",
          },
        ] as unknown as Thread["proposedPlans"],
      }),
    );

    const kinds = built!.timeline.map((entry) => entry.kind);
    expect(kinds).toEqual(["message", "proposed-plan"]);
  });

  it("anchors a persisted context handoff immediately before its target message", () => {
    const built = buildThreadTimeline(
      thread({
        messages: [
          {
            id: "message-target",
            role: "user",
            text: "Continue with Claude",
            createdAt: "2026-08-23T10:00:00.000Z",
            streaming: false,
          },
        ] as unknown as Thread["messages"],
        activities: [
          {
            id: "handoff-activity",
            createdAt: "2026-08-23T10:00:00.000Z",
            kind: "context-handoff",
            summary: "Context handoff",
            tone: "info",
            turnId: "turn-target",
            payload: {
              schemaVersion: 1,
              handoffId: "handoff-1",
              mode: "full-context-fresh-session",
              targetMessageId: "message-target",
              targetTurnId: "turn-target",
              sourceSelection: { instanceId: "codex-work", model: "gpt-5.6" },
              targetSelection: { instanceId: "claude-work", model: "claude-opus-5" },
              sources: [
                {
                  providerInstanceId: "codex-work",
                  driverKind: "codex",
                  modelSlug: "gpt-5.6",
                },
              ],
              target: {
                providerInstanceId: "claude-work",
                driverKind: "claudeAgent",
                modelSlug: "claude-opus-5",
              },
              contextVersion: 1,
              contextDigest: "a".repeat(64),
              status: "consumed",
            },
          },
        ] as unknown as Thread["activities"],
      }),
    );

    expect(built?.timeline.map((entry) => entry.kind)).toEqual(["context-handoff", "message"]);
    expect(built?.viewModel.contextHandoffEntries).toHaveLength(1);
  });
});
