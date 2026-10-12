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
