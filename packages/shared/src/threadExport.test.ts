import type { OrchestrationThreadActivity } from "@ryco/contracts";
import { describe, expect, it } from "vitest";
import type { ThreadExportSource } from "./threadExport.ts";
import {
  projectThreadExportActivity,
  redactExportText,
  serializeThreadMarkdown,
  threadExportFilename,
} from "./threadExport.ts";
const thread = {
  id: "t",
  projectId: "p",
  title: "<script>\n# title",
  modelSelection: { instanceId: "codex", model: "model" },
  createdAt: "2026-09-15T00:00:00Z",
  updatedAt: "2026-09-15T00:00:00Z",
  messages: [
    {
      id: "m",
      role: "user",
      text: "  unchanged\n````\n<script>你好</script>\nhttps://example.com/#anchor\n",
      createdAt: "2026-09-15T00:00:00Z",
    },
  ],
  activities: [
    {
      id: "a",
      kind: "tool.completed",
      summary: "Read file",
      createdAt: "2026-09-15T00:00:00Z",
      payload: { token: "MUST-NOT-EXPORT", raw: "RAW-DUMP" },
    },
  ],
} as unknown as ThreadExportSource;
describe("Markdown export", () => {
  it("is deterministic and preserves text inside a longer fence", () => {
    const output = serializeThreadMarkdown(thread);
    expect(output).toEqual(serializeThreadMarkdown(thread));
    expect(output).toContain("`````text\n" + thread.messages[0]!.text + "\n`````");
    expect(output).toContain("Retained Ryco conversation");
    expect(output).toContain("Current provider instance: codex");
    expect(output).toContain("Read file");
    expect(output).not.toContain("MUST-NOT-EXPORT");
    expect(output).not.toContain("RAW-DUMP");
  });
  it("sorts equal-time messages deterministically without changing input", () => {
    const second = { ...thread.messages[0]!, id: "a", text: "first" };
    const input = { ...thread, messages: [...thread.messages, second] } as ThreadExportSource;
    expect(serializeThreadMarkdown(input)).toEqual(
      serializeThreadMarkdown({ ...input, messages: input.messages.toReversed() }),
    );
    expect(input.messages[0]!.id).toBe("m");
  });
  it("marks recognizable secrets and preserves ordinary URLs", () => {
    expect(
      redactExportText(
        'Bearer abc "api_key": "secret123" sk-123456789 https://user:pass@host/?token=abc',
      ),
    ).not.toMatch(/secret123|123456789|user:pass|token=abc/);
    expect(redactExportText("https://example.com/#anchor")).toBe("https://example.com/#anchor");
    expect(redactExportText("password=secret")).toContain("[redacted]");
  });
  it.each(["../CON", "", "😀", "a".repeat(500), "a/b\\c\u0000", "token=secret"])(
    "uses safe bounded filenames: %s",
    (title) => {
      const name = threadExportFilename(title);
      expect(name).toMatch(/^ryco-[A-Za-z0-9_-]{1,80}\.md$/);
      expect(name).not.toContain("secret");
    },
  );
});

it("exports recorded provider boundaries without retaining private payload fields", () => {
  const activity = projectThreadExportActivity({
    id: "boundary",
    createdAt: "2026-09-15T00:00:00Z",
    kind: "context-handoff",
    summary: "Handoff",
    payload: {
      schemaVersion: 1,
      handoffId: "handoff",
      mode: "full-context-fresh-session",
      targetMessageId: "m",
      sourceSelection: { instanceId: "codex_work", model: "source-model" },
      targetSelection: { instanceId: "claude_work", model: "target-model" },
      sources: [
        { providerInstanceId: "codex_work", driverKind: "codex", modelSlug: "source-model" },
      ],
      target: {
        providerInstanceId: "claude_work",
        driverKind: "claudeAgent",
        modelSlug: "target-model",
      },
      contextVersion: 1,
      contextDigest: "a".repeat(64),
      status: "consumed",
      token: "private",
    },
  } as unknown as OrchestrationThreadActivity);
  expect(activity).not.toHaveProperty("payload");
  const output = serializeThreadMarkdown({ ...thread, activities: [activity] });
  expect(output).toContain("consumed: codex_work/source-model → claude_work/target-model");
  expect(output).not.toContain("private");
});

const forkHandoffPayload = {
  schemaVersion: 1,
  handoffId: "handoff",
  mode: "full-context-fresh-session",
  reason: "fork",
  targetMessageId: "m",
  sourceSelection: { instanceId: "opencode_work", model: "fork-model" },
  targetSelection: { instanceId: "opencode_work", model: "fork-model" },
  sources: [
    { providerInstanceId: "opencode_work", driverKind: "opencode", modelSlug: "fork-model" },
  ],
  target: { providerInstanceId: "opencode_work", driverKind: "opencode", modelSlug: "fork-model" },
  contextVersion: 1,
  contextDigest: "a".repeat(64),
  status: "consumed",
};

it("exports a fork handoff as the delivery of the inherited conversation", () => {
  const activity = projectThreadExportActivity({
    id: "fork-handoff",
    createdAt: "2026-09-15T00:00:01Z",
    kind: "context-handoff",
    summary: "Handoff",
    payload: forkHandoffPayload,
  } as unknown as OrchestrationThreadActivity);
  const output = serializeThreadMarkdown({ ...thread, activities: [activity] });
  expect(output).toContain(
    "consumed: inherited conversation → fresh opencode_work/fork-model session",
  );
  expect(output).not.toContain("opencode_work/fork-model → opencode_work/fork-model");
});

it("exports a fork handoff that also switched provider with the provider it left", () => {
  const activity = projectThreadExportActivity({
    id: "fork-handoff",
    createdAt: "2026-09-15T00:00:01Z",
    kind: "context-handoff",
    summary: "Handoff",
    payload: {
      ...forkHandoffPayload,
      targetSelection: { instanceId: "claude_work", model: "sonnet" },
      target: { providerInstanceId: "claude_work", driverKind: "claudeAgent", modelSlug: "sonnet" },
    },
  } as unknown as OrchestrationThreadActivity);
  expect(serializeThreadMarkdown({ ...thread, activities: [activity] })).toContain(
    "consumed: inherited conversation → fresh claude_work/sonnet session (switched from opencode_work/fork-model)",
  );
});

it("exports where a fork's inherited history came from before its messages", () => {
  const activity = projectThreadExportActivity({
    id: "fork:forked",
    createdAt: "2026-09-15T00:00:05Z",
    kind: "thread.forked",
    summary: "Forked from Source",
    payload: {
      schemaVersion: 1,
      sourceThreadId: "source-thread",
      sourceMessageId: "source-reply",
      sourceTurnId: "source-turn",
      sourceTitle: "Source title",
      inheritedMessageCount: 6,
      providerContext: "handoff",
      handoffReason: "provider-unsupported",
      checkout: {
        kind: "new-worktree",
        worktreeId: "worktree-fork",
        worktreePath: "/worktrees/fork",
        branch: "ryco/fork-abcd1234",
        start: "base-ref",
        baseRef: "main",
      },
      notices: ["Attachments over the size limit were not copied."],
      privateField: "MUST-NOT-EXPORT",
    },
  } as unknown as OrchestrationThreadActivity);
  expect(activity).not.toHaveProperty("payload");
  const output = serializeThreadMarkdown({ ...thread, activities: [activity] });
  expect(output).toContain("## Fork origin · 2026-09-15T00:00:05.000Z");
  expect(output).toContain("Forked from: Source title");
  expect(output).toContain("Source message: source-reply (turn source-turn, inclusive)");
  expect(output).toContain("Provider context: handoff (provider-unsupported)");
  expect(output).toContain(
    "Checkout: new worktree /worktrees/fork on ryco/fork-abcd1234, from main",
  );
  expect(output).toContain("Notice: Attachments over the size limit were not copied.");
  expect(output.indexOf("## Fork origin")).toBeLessThan(output.indexOf("## Messages"));
  expect(output).not.toContain("MUST-NOT-EXPORT");
});

it("exports an answered agent question between the messages around it", () => {
  const activities = [
    {
      id: "ask",
      createdAt: "2026-09-15T00:00:01Z",
      kind: "user-input.requested",
      summary: "User input requested",
      payload: {
        requestId: "req",
        questions: [
          {
            id: "Which library?",
            header: "Library",
            question: "Which library?",
            options: [
              { label: "React", description: "MUST-NOT-EXPORT description" },
              { label: "Vue", description: "Vue." },
            ],
          },
        ],
        token: "MUST-NOT-EXPORT",
      },
    },
    {
      id: "answer",
      createdAt: "2026-09-15T00:00:02Z",
      kind: "user-input.resolved",
      summary: "User input submitted",
      payload: { requestId: "req", answers: { "Which library?": "React" } },
    },
  ].map((activity) =>
    projectThreadExportActivity(activity as unknown as OrchestrationThreadActivity),
  );
  const reply = {
    ...thread.messages[0]!,
    id: "reply",
    role: "assistant",
    text: "Using React.",
    createdAt: "2026-09-15T00:00:03Z",
  } as ThreadExportSource["messages"][number];
  const output = serializeThreadMarkdown({
    ...thread,
    messages: [...thread.messages, reply],
    activities,
  });
  expect(activities[0]).not.toHaveProperty("payload");
  expect(output).toContain(
    "### Agent question · 2026-09-15T00:00:02.000Z\n\n```text\nLibrary: Which library?\nOptions: React · Vue\nAnswer: React\n```",
  );
  expect(output.indexOf("### User")).toBeLessThan(output.indexOf("### Agent question"));
  expect(output.indexOf("### Agent question")).toBeLessThan(output.indexOf("### Assistant"));
  expect(output).not.toContain("MUST-NOT-EXPORT");
});

it("exports a cancelled agent question with its questions and no answers", () => {
  const activities = [
    {
      id: "ask",
      createdAt: "2026-09-15T00:00:01Z",
      kind: "user-input.requested",
      summary: "User input requested",
      payload: {
        requestId: "req",
        questions: [
          {
            id: "scope",
            header: "Scope",
            question: "Which scope?",
            options: [{ label: "Focused", description: "Focused." }],
          },
        ],
      },
    },
    {
      id: "cancel",
      createdAt: "2026-09-15T00:00:02Z",
      kind: "user-input.resolved",
      summary: "Question cancelled",
      payload: { requestId: "req", answers: {}, cancelled: true },
    },
  ].map((activity) =>
    projectThreadExportActivity(activity as unknown as OrchestrationThreadActivity),
  );
  const output = serializeThreadMarkdown({ ...thread, activities });
  expect(output).toContain(
    "### Agent question · 2026-09-15T00:00:02.000Z · cancelled\n\n```text\nScope: Which scope?\nOptions: Focused\n```",
  );
  expect(output).not.toContain("Answer:");
});

it("pairs a question and its answer recorded in the same millisecond in transcript order", () => {
  // The resolution's id sorts first, as a random id does about half the time.
  const project = (sequences: { ask?: number; cancel?: number }) =>
    [
      {
        id: "b-ask",
        createdAt: "2026-09-15T00:00:01Z",
        ...(sequences.ask !== undefined ? { sequence: sequences.ask } : {}),
        kind: "user-input.requested",
        summary: "User input requested",
        payload: {
          requestId: "req",
          questions: [
            {
              id: "scope",
              header: "Scope",
              question: "Which scope?",
              options: [{ label: "Focused", description: "Focused." }],
            },
          ],
        },
      },
      {
        id: "a-cancel",
        createdAt: "2026-09-15T00:00:01Z",
        ...(sequences.cancel !== undefined ? { sequence: sequences.cancel } : {}),
        kind: "user-input.resolved",
        summary: "Question cancelled",
        payload: { requestId: "req", answers: {}, cancelled: true },
      },
    ].map((activity) =>
      projectThreadExportActivity(activity as unknown as OrchestrationThreadActivity),
    );
  const heading = "### Agent question · 2026-09-15T00:00:01.000Z · cancelled";
  const withSequence = project({ ask: 7, cancel: 8 });
  expect(withSequence[0]).toMatchObject({ sequence: 7 });
  expect(serializeThreadMarkdown({ ...thread, activities: withSequence })).toContain(heading);
  // Without a sequence, a request still reads before the resolution recorded with it.
  expect(serializeThreadMarkdown({ ...thread, activities: project({}) })).toContain(heading);
});

it("lists activities in the transcript's order: sequence, time, then lifecycle", () => {
  const activities = [
    { id: "a-done", createdAt: "2026-09-15T00:00:01Z", kind: "tool.completed", summary: "Read b" },
    { id: "b-start", createdAt: "2026-09-15T00:00:01Z", kind: "tool.started", summary: "Read a" },
    { id: "late", createdAt: "2026-09-15T00:00:09Z", sequence: 1, kind: "tool.started" },
    { id: "early", createdAt: "2026-09-15T00:00:05Z", sequence: 2, kind: "tool.completed" },
  ].map((activity) =>
    projectThreadExportActivity({
      summary: activity.id,
      ...activity,
    } as unknown as OrchestrationThreadActivity),
  );
  const output = serializeThreadMarkdown({ ...thread, activities });
  // Recorded in the same instant, a start reads before its completion.
  expect(output.indexOf("Read a")).toBeLessThan(output.indexOf("Read b"));
  // The sequence decides before the time.
  expect(output.indexOf("Read b")).toBeLessThan(output.indexOf("```text\nlate"));
  expect(output.indexOf("```text\nlate")).toBeLessThan(output.indexOf("```text\nearly"));
});
