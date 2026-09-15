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
