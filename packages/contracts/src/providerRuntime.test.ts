import { describe, expect, it } from "vite-plus/test";
import { Schema } from "effect";

import { ProviderRuntimeEvent } from "./providerRuntime.ts";

const decodeRuntimeEvent = Schema.decodeUnknownSync(ProviderRuntimeEvent);

describe("ProviderRuntimeEvent", () => {
  it("decodes historical events without an epoch and new events with one", () => {
    const base = {
      type: "session.started",
      eventId: "event-session",
      provider: "codex",
      providerInstanceId: "codex_work",
      createdAt: "2026-02-28T00:00:00.000Z",
      threadId: "thread-1",
      payload: {},
    } as const;
    expect(decodeRuntimeEvent(base).runtimeSessionId).toBeUndefined();
    expect(
      decodeRuntimeEvent({ ...base, runtimeSessionId: "runtime-session-1" }).runtimeSessionId,
    ).toBe("runtime-session-1");
  });

  it("accepts fork-provided driver kinds as branded slugs", () => {
    const parsed = decodeRuntimeEvent({
      type: "session.started",
      eventId: "event-ollama-session",
      provider: "ollama",
      providerInstanceId: "ollama_local",
      createdAt: "2026-02-28T00:00:00.000Z",
      threadId: "thread-1",
      payload: {
        message: "started",
      },
    });

    expect(parsed.provider).toBe("ollama");
    expect(parsed.providerInstanceId).toBe("ollama_local");
  });

  it("decodes turn.plan.updated for plan rendering", () => {
    const parsed = decodeRuntimeEvent({
      type: "turn.plan.updated",
      eventId: "event-1",
      provider: "claudeAgent",
      sessionId: "runtime-session-1",
      createdAt: "2026-02-28T00:00:00.000Z",
      threadId: "thread-1",
      turnId: "turn-1",
      payload: {
        explanation: "Implement schema updates",
        plan: [
          { step: "Define event union", status: "completed" },
          { step: "Wire adapter mapping", status: "inProgress" },
        ],
      },
    });

    expect(parsed.type).toBe("turn.plan.updated");
    if (parsed.type !== "turn.plan.updated") {
      throw new Error("expected turn.plan.updated");
    }
    expect(parsed.payload.plan).toHaveLength(2);
    expect(parsed.payload.plan[1]?.status).toBe("inProgress");
  });

  it("decodes proposed-plan completion events", () => {
    const parsed = decodeRuntimeEvent({
      type: "turn.proposed.completed",
      eventId: "event-proposed-plan-1",
      provider: "codex",
      createdAt: "2026-02-28T00:00:00.000Z",
      threadId: "thread-1",
      turnId: "turn-1",
      payload: {
        planMarkdown: "# Ship it",
      },
    });

    expect(parsed.type).toBe("turn.proposed.completed");
    if (parsed.type !== "turn.proposed.completed") {
      throw new Error("expected turn.proposed.completed");
    }
    expect(parsed.payload.planMarkdown).toBe("# Ship it");
  });

  it("decodes tool.denied events", () => {
    const parsed = decodeRuntimeEvent({
      type: "tool.denied",
      eventId: "event-tool-denied-1",
      provider: "claudeAgent",
      createdAt: "2026-02-28T00:00:00.000Z",
      threadId: "thread-1",
      turnId: "turn-1",
      payload: {
        toolName: "Bash",
        toolUseId: "tool-use-1",
        reason: "User denied command execution.",
        agentId: "agent-1",
      },
    });

    expect(parsed.type).toBe("tool.denied");
    if (parsed.type !== "tool.denied") {
      throw new Error("expected tool.denied");
    }
    expect(parsed.payload.toolName).toBe("Bash");
    expect(parsed.payload.reason).toBe("User denied command execution.");
  });

  it("decodes user-input.requested with structured questions", () => {
    const parsed = decodeRuntimeEvent({
      type: "user-input.requested",
      eventId: "event-2",
      provider: "claudeAgent",
      sessionId: "runtime-session-2",
      createdAt: "2026-02-28T00:00:01.000Z",
      threadId: "thread-2",
      requestId: "request-1",
      payload: {
        questions: [
          {
            id: "sandbox_mode",
            header: "Sandbox",
            question: "Which mode should be used?",
            options: [
              {
                label: "workspace-write",
                description: "Allow edits in workspace only",
              },
              {
                label: "danger-full-access",
                description: "Allow unrestricted access",
              },
            ],
          },
        ],
      },
    });

    expect(parsed.type).toBe("user-input.requested");
    if (parsed.type !== "user-input.requested") {
      throw new Error("expected user-input.requested");
    }
    expect(parsed.payload.questions[0]?.id).toBe("sandbox_mode");
    expect(parsed.payload.questions[0]?.options).toHaveLength(2);
  });

  it("decodes user-input.resolved with answer map", () => {
    const parsed = decodeRuntimeEvent({
      type: "user-input.resolved",
      eventId: "event-3",
      provider: "claudeAgent",
      sessionId: "runtime-session-2",
      createdAt: "2026-02-28T00:00:02.000Z",
      threadId: "thread-2",
      requestId: "request-1",
      payload: {
        answers: {
          sandbox_mode: "workspace-write",
        },
      },
    });

    expect(parsed.type).toBe("user-input.resolved");
    if (parsed.type !== "user-input.resolved") {
      throw new Error("expected user-input.resolved");
    }
    expect(parsed.payload.answers.sandbox_mode).toBe("workspace-write");
  });

  it("rejects legacy message.delta type", () => {
    expect(() =>
      decodeRuntimeEvent({
        type: "message.delta",
        eventId: "event-4",
        provider: "codex",
        sessionId: "runtime-session-3",
        createdAt: "2026-02-28T00:00:03.000Z",
        payload: { delta: "legacy" },
      }),
    ).toThrow();
  });

  it("rejects empty branded canonical ids", () => {
    expect(() =>
      decodeRuntimeEvent({
        type: "runtime.error",
        eventId: "event-5",
        provider: "codex",
        sessionId: "runtime-session-3",
        createdAt: "2026-02-28T00:00:03.000Z",
        threadId: "   ",
        payload: { message: "boom" },
      }),
    ).toThrow();
  });

  it("decodes normalized thread token usage snapshots", () => {
    const parsed = decodeRuntimeEvent({
      type: "thread.token-usage.updated",
      eventId: "event-token-usage-1",
      provider: "claudeAgent",
      createdAt: "2026-02-28T00:00:04.000Z",
      threadId: "thread-1",
      payload: {
        usage: {
          usedTokens: 31251,
          maxTokens: 200000,
          toolUses: 25,
          durationMs: 43567,
        },
      },
    });

    expect(parsed.type).toBe("thread.token-usage.updated");
    if (parsed.type !== "thread.token-usage.updated") {
      throw new Error("expected thread.token-usage.updated");
    }
    expect(parsed.payload.usage.maxTokens).toBe(200000);
    expect(parsed.payload.usage.usedTokens).toBe(31251);
  });

  it("decodes a task.updated status patch with linkage", () => {
    const parsed = decodeRuntimeEvent({
      type: "task.updated",
      eventId: "event-task-updated",
      provider: "claudeAgent",
      threadId: "thread-1",
      createdAt: "2026-08-01T10:00:00.000Z",
      payload: {
        taskId: "task-1",
        status: "cancelled",
        endedAt: "2026-08-01T10:05:00.000Z",
        isBackgrounded: true,
        taskType: "local_agent",
        role: "explorer",
        model: "claude-opus-4-6",
      },
    });
    expect(parsed.type).toBe("task.updated");
    if (parsed.type !== "task.updated") {
      throw new Error("expected task.updated");
    }
    expect(parsed.payload.status).toBe("cancelled");
    expect(parsed.payload.role).toBe("explorer");
  });

  it("decodes a task.progress row carrying typedUsage and workflow linkage", () => {
    const parsed = decodeRuntimeEvent({
      type: "task.progress",
      eventId: "event-task-progress-linkage",
      provider: "claudeAgent",
      threadId: "thread-1",
      createdAt: "2026-08-01T10:00:00.000Z",
      payload: {
        taskId: "wf-1:wf:0",
        description: "member-0",
        status: "running",
        typedUsage: { totalTokens: 1200, toolUses: 3 },
        parentAgentId: "wf-1",
        agentIndex: 0,
        phaseIndex: 1,
        phaseTitle: "Verify",
        timelineBypass: true,
      },
    });
    expect(parsed.type).toBe("task.progress");
    if (parsed.type !== "task.progress") {
      throw new Error("expected task.progress");
    }
    expect(parsed.payload.typedUsage?.totalTokens).toBe(1200);
    expect(parsed.payload.parentAgentId).toBe("wf-1");
    expect(parsed.payload.timelineBypass).toBe(true);
  });
  it("decodes usage_limit runtime errors with and without a reset", () => {
    const base = {
      type: "runtime.error",
      eventId: "event-usage-limit",
      provider: "claudeAgent",
      createdAt: "2026-02-28T00:00:00.000Z",
      threadId: "thread-1",
      turnId: "turn-1",
    } as const;
    const limited = decodeRuntimeEvent({
      ...base,
      payload: {
        message: "Claude usage limit reached.",
        class: "usage_limit",
        resetAt: "2026-02-28T05:00:00.000Z",
      },
    });
    expect(limited.type === "runtime.error" && limited.payload.class).toBe("usage_limit");
    expect(limited.type === "runtime.error" && limited.payload.resetAt).toBe(
      "2026-02-28T05:00:00.000Z",
    );
    const unknownReset = decodeRuntimeEvent({
      ...base,
      payload: { message: "Limited", class: "usage_limit", resetAt: null },
    });
    expect(unknownReset.type === "runtime.error" && unknownReset.payload.resetAt).toBeNull();
    const legacy = decodeRuntimeEvent({
      ...base,
      payload: { message: "boom", class: "provider_error" },
    });
    expect(legacy.type === "runtime.error" && "resetAt" in legacy.payload).toBe(false);
  });

  it("decodes account.rate-limits.updated with a normalised usage-limit state", () => {
    const parsed = decodeRuntimeEvent({
      type: "account.rate-limits.updated",
      eventId: "event-rate-limits",
      provider: "codex",
      createdAt: "2026-02-28T00:00:00.000Z",
      threadId: "thread-1",
      payload: {
        rateLimits: { primary: { usedPercent: 100 } },
        usageLimitState: { exhausted: true, resetAt: null },
      },
    });
    expect(parsed.type === "account.rate-limits.updated" && parsed.payload.usageLimitState).toEqual(
      { exhausted: true, resetAt: null },
    );
  });
});
