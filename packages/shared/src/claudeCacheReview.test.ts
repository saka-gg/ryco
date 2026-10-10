import { describe, expect, it } from "vite-plus/test";
import {
  EventId,
  ProviderInstanceId,
  RuntimeSessionId,
  ThreadId,
  type ClaudeCacheObservation,
  type OrchestrationThread,
} from "@ryco/contracts";

import {
  assessClaudeCacheResume,
  claudeCompactUnavailableReason,
  latestClaudeCacheObservation,
} from "./claudeCacheReview.ts";

const observation: ClaudeCacheObservation = {
  source: "assistant-usage",
  observedAt: "2026-09-27T10:00:00.000Z",
  runtimeSessionId: RuntimeSessionId.make("runtime-1"),
  providerInstanceId: ProviderInstanceId.make("claude"),
  model: "sonnet",
  messageId: "request-1",
  directInputTokens: 100,
  cacheReadInputTokens: 50_000,
  cacheWriteInputTokens: 2_000,
  observedTtlSeconds: 300,
};

function thread(input: { readonly observation?: ClaudeCacheObservation } = {}) {
  const evidence = input.observation ?? observation;
  return {
    id: ThreadId.make("thread-1"),
    modelSelection: { instanceId: evidence.providerInstanceId, model: "sonnet" },
    session: {
      threadId: ThreadId.make("thread-1"),
      providerName: "claudeAgent",
      providerInstanceId: evidence.providerInstanceId,
      runtimeSessionId: evidence.runtimeSessionId,
      status: "error",
      activeTurnId: null,
      lastError: null,
      runtimeMode: "full-access",
      updatedAt: evidence.observedAt,
    },
    latestTurn: null,
    messages: [],
    activities: [
      {
        id: EventId.make("usage-1"),
        kind: "context-window.updated",
        tone: "info",
        summary: "Context usage",
        payload: { claudeCache: evidence },
        turnId: null,
        createdAt: evidence.observedAt,
      },
    ],
  } as unknown as OrchestrationThread;
}

describe("assessClaudeCacheResume", () => {
  const observedAtMs = Date.parse(observation.observedAt);

  it("reviews a large conversation once the observed cache lifetime elapsed", () => {
    const subject = thread();
    expect(assessClaudeCacheResume(subject, subject.modelSelection, observedAtMs + 1_000)).toBe(
      undefined,
    );
    expect(
      assessClaudeCacheResume(subject, subject.modelSelection, observedAtMs + 301_000)?.reason,
    ).toContain("lifetime reported");
  });

  it("leaves small conversations and non-Claude sessions alone", () => {
    const small = thread({
      observation: { ...observation, cacheReadInputTokens: 1_000, cacheWriteInputTokens: 0 },
    });
    expect(
      assessClaudeCacheResume(small, small.modelSelection, observedAtMs + 3_600_000),
    ).toBeUndefined();
    const codex = thread();
    const codexThread = {
      ...codex,
      session: { ...codex.session!, providerName: "codex" },
    } as OrchestrationThread;
    expect(
      assessClaudeCacheResume(codexThread, codexThread.modelSelection, observedAtMs + 3_600_000),
    ).toBeUndefined();
  });

  it("reviews a stopped session without a runtime and offers only continuing", () => {
    const subject = thread();
    const stopped = {
      ...subject,
      session: { ...subject.session!, status: "stopped", runtimeSessionId: undefined },
    } as OrchestrationThread;
    const review = assessClaudeCacheResume(stopped, stopped.modelSelection, observedAtMs + 1_000);
    expect(review?.reason).toContain("session stopped");
    expect(review?.compactUnavailableReason).toContain("stopped, so it cannot compact");
    // A session that failed before binding a runtime is not "stopped", but has none either.
    const unbound = {
      ...subject,
      session: { ...subject.session!, status: "error", runtimeSessionId: undefined },
    } as OrchestrationThread;
    expect(claudeCompactUnavailableReason(unbound, unbound.modelSelection)).toBe(
      "Claude has no running session to compact first.",
    );
  });

  it("offers compaction only for a ready, idle runtime on the selected model", () => {
    const subject = thread();
    const ready = {
      ...subject,
      session: { ...subject.session!, status: "ready" },
    } as OrchestrationThread;
    const at = observedAtMs + 301_000;
    expect(
      assessClaudeCacheResume(ready, ready.modelSelection, at)?.compactUnavailableReason,
    ).toBeNull();
    expect(claudeCompactUnavailableReason(subject, subject.modelSelection)).toContain(
      "ready before compacting",
    );
    expect(
      claudeCompactUnavailableReason(ready, { ...ready.modelSelection, model: "opus" }),
    ).toContain("Apply the model");
  });

  it("skips the review once the thread's directory moved away from the observed runtime's", () => {
    const subject = thread({ observation: { ...observation, cwd: "/chats/pelican" } });
    const at = observedAtMs + 301_000;
    expect(
      assessClaudeCacheResume(subject, subject.modelSelection, at, {
        workspaceCwd: "/projects/pelican",
      }),
    ).toBeUndefined();
    expect(
      assessClaudeCacheResume(subject, subject.modelSelection, at, {
        workspaceCwd: "/chats/pelican",
      }),
    ).toBeDefined();
    // Either directory unknown (older server or client): review as before.
    expect(assessClaudeCacheResume(subject, subject.modelSelection, at)).toBeDefined();
    expect(
      assessClaudeCacheResume(thread(), thread().modelSelection, at, {
        workspaceCwd: "/projects/pelican",
      }),
    ).toBeDefined();
  });

  it("forgets the observation after a compaction", () => {
    const subject = thread();
    expect(
      latestClaudeCacheObservation([
        ...subject.activities,
        { ...subject.activities[0]!, kind: "context-compaction" },
      ]),
    ).toBeUndefined();
  });
});
