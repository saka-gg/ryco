import { assert, describe, it } from "@effect/vitest";

import {
  capProviderEventLogString,
  extractProviderEventDelta,
  isCurrentCanonicalProviderEventLog,
  isLifecycleProviderEventRecord,
  parseProviderEventLogLine,
  formatProviderEventLogLine,
  PROVIDER_EVENT_LOG_FILE_PATTERN,
  PROVIDER_EVENT_LOG_STRING_CAP,
  serializeProviderEventLogRecord,
  shouldWriteProviderEventRecord,
} from "./providerEventLogRecords.ts";

const claudeNative = (method: string, payload: unknown = {}) => ({
  observedAt: "2026-10-12T00:00:00.000Z",
  event: { id: "evt", kind: "notification", provider: "claudeAgent", method, payload },
});

describe("serializeProviderEventLogRecord", () => {
  it("keeps canonical raw as a reference to the native record", () => {
    const workflowProgress = Array.from({ length: 400 }, (_, index) => ({
      index,
      label: `member ${index}`,
      status: "running",
      lastToolName: "Bash",
    }));
    const event = {
      type: "task.progress",
      eventId: "event-1",
      threadId: "thread-1",
      payload: { taskId: "task-1", description: "workflow" },
      raw: {
        source: "claude.sdk.message",
        method: "claude/system/task_progress",
        messageType: "system:task_progress",
        payload: { uuid: "sdk-uuid-1", workflow_progress: workflowProgress },
      },
    };
    assert.isAbove(JSON.stringify(event).length, 30_000);

    const json = serializeProviderEventLogRecord("canonical", event);
    assert.isDefined(json);
    // Guard: a workflow tick stays a few hundred bytes however large the native message is.
    assert.isBelow(json!.length, 2_048);
    assert.deepStrictEqual(JSON.parse(json!).raw, {
      source: "claude.sdk.message",
      method: "claude/system/task_progress",
      messageType: "system:task_progress",
      nativeId: "sdk-uuid-1",
    });
    // The native stream is the copy of record and keeps the message.
    assert.include(
      serializeProviderEventLogRecord("native", event.raw.payload) ?? "",
      "member 399",
    );
  });

  it("caps long strings, summarizes inline base64 and redacts Agent Control secrets", () => {
    const longText = `${"lorem ipsum ".repeat(2_000)}TAIL`;
    const base64 = "QUJD".repeat(10_000);
    const json = serializeProviderEventLogRecord("native", {
      text: longText,
      image: `data:image/png;base64,${base64}`,
      blob: base64,
      auth: `Bearer rycoac_${"z".repeat(43)}`,
    });
    const record = JSON.parse(json!) as Record<string, string>;

    assert.isBelow(record.text!.length, PROVIDER_EVENT_LOG_STRING_CAP);
    assert.isTrue(record.text!.endsWith("TAIL"));
    assert.include(record.text!, "chars omitted");
    assert.match(
      record.image!,
      /^\[inline base64 omitted mime=image\/png chars=\d+ sha256=[0-9a-f]{16}\]$/,
    );
    assert.match(record.blob!, /^\[inline base64 omitted chars=40000 sha256=[0-9a-f]{16}\]$/);
    assert.strictEqual(record.auth, "Bearer [REDACTED]");
    assert.strictEqual(capProviderEventLogString("short"), "short");
  });

  it("writes a long record of short strings verbatim and still caps a deeply nested long one", () => {
    const progress = Array.from({ length: 200 }, (_, index) => ({
      index,
      summary: "y".repeat(100),
    }));
    const record = { method: "claude/system/task_progress", payload: { progress } };
    const plain = JSON.stringify(record);
    assert.isAbove(plain.length, PROVIDER_EVENT_LOG_STRING_CAP);
    assert.strictEqual(serializeProviderEventLogRecord("native", record), plain);

    const nested = {
      payload: { progress: [...progress, { output: "command output ".repeat(2_000) }] },
    };
    const json = serializeProviderEventLogRecord("native", nested)!;
    assert.include(json, "chars omitted");
    assert.isBelow(json.length, plain.length + PROVIDER_EVENT_LOG_STRING_CAP);
  });
});

describe("detail levels", () => {
  it("keeps only lifecycle records at the lifecycle level", () => {
    const keep = (stream: "native" | "canonical", record: unknown) =>
      shouldWriteProviderEventRecord("lifecycle", stream, record);

    assert.isTrue(keep("canonical", { type: "turn.completed" }));
    assert.isTrue(keep("canonical", { type: "runtime.error" }));
    assert.isFalse(keep("canonical", { type: "content.delta" }));
    assert.isFalse(keep("canonical", { type: "task.progress" }));

    assert.isTrue(keep("native", claudeNative("claude/system/init")));
    assert.isTrue(keep("native", claudeNative("claude/result/success")));
    assert.isFalse(keep("native", claudeNative("claude/assistant")));
    assert.isFalse(keep("native", claudeNative("claude/system/task_progress")));
    assert.isFalse(
      keep("native", claudeNative("claude/stream_event/content_block_delta/text_delta")),
    );
    assert.isTrue(keep("native", { kind: "notification", method: "turn/completed" }));
    assert.isTrue(
      keep("native", { kind: "request", method: "item/commandExecution/requestApproval" }),
    );
    assert.isFalse(keep("native", { kind: "notification", method: "item/completed" }));
    assert.isFalse(keep("native", { kind: "notification", method: "item/agentMessage/delta" }));
    assert.isTrue(isLifecycleProviderEventRecord("native", { event: { type: "session.idle" } }));
  });

  it("writes nothing when off and drops native noise at full", () => {
    assert.isFalse(shouldWriteProviderEventRecord("off", "canonical", { type: "runtime.error" }));
    assert.isTrue(shouldWriteProviderEventRecord("full", "canonical", { type: "content.delta" }));
    assert.isFalse(
      shouldWriteProviderEventRecord(
        "full",
        "native",
        claudeNative("claude/system/thinking_tokens"),
      ),
    );
    assert.isFalse(
      shouldWriteProviderEventRecord("full", "native", claudeNative("claude/stream_event/ping")),
    );
    assert.isTrue(
      shouldWriteProviderEventRecord("full", "native", claudeNative("claude/assistant")),
    );
  });
});

describe("extractProviderEventDelta", () => {
  it("recognises Claude, Codex and canonical deltas with per-stream keys", () => {
    const claude = (index: number, text: string) =>
      claudeNative("claude/stream_event/content_block_delta/text_delta", {
        event: { type: "content_block_delta", index, delta: { type: "text_delta", text } },
      });
    const first = extractProviderEventDelta("native", claude(0, "he"));
    assert.strictEqual(first?.text, "he");
    assert.strictEqual(extractProviderEventDelta("native", claude(0, "llo"))?.key, first?.key);
    assert.notStrictEqual(extractProviderEventDelta("native", claude(1, "x"))?.key, first?.key);

    const codex = extractProviderEventDelta("native", {
      kind: "notification",
      method: "item/agentMessage/delta",
      itemId: "item-1",
      payload: { delta: "hi" },
    });
    assert.strictEqual(codex?.text, "hi");

    const canonical = extractProviderEventDelta("canonical", {
      type: "content.delta",
      itemId: "item-1",
      payload: { streamKind: "assistant_text", delta: "yo" },
    });
    assert.strictEqual(canonical?.text, "yo");
    const subagentMessage = (providerMessageId: string) =>
      extractProviderEventDelta("canonical", {
        type: "subagent.message.delta",
        turnId: "turn-1",
        payload: { subagentId: "agent-1", providerMessageId, delta: "hi" },
      })?.key;
    assert.notStrictEqual(subagentMessage("msg-1"), subagentMessage("msg-2"));

    assert.isUndefined(extractProviderEventDelta("native", claudeNative("claude/assistant")));
    assert.isUndefined(extractProviderEventDelta("canonical", { type: "turn.completed" }));
  });
});

describe("log files and lines", () => {
  it("round-trips lines and recognises every file a writer leaves behind", () => {
    const line = formatProviderEventLogLine(
      "CANON",
      Date.parse("2026-10-12T01:02:03.000Z"),
      '{"a":1}',
    );
    assert.deepStrictEqual(parseProviderEventLogLine(line.trimEnd()), {
      observedAt: "2026-10-12T01:02:03.000Z",
      label: "CANON",
      record: { a: 1 },
    });
    assert.isNull(parseProviderEventLogLine("garbage"));

    for (const name of ["t.log", "t.native.log", "t.log.2", "t.log.1.gz", "t.log.1.gz.tmp"]) {
      assert.isTrue(PROVIDER_EVENT_LOG_FILE_PATTERN.test(name), name);
    }
    assert.isFalse(PROVIDER_EVENT_LOG_FILE_PATTERN.test("notes.txt"));
    assert.isTrue(isCurrentCanonicalProviderEventLog("thread.log"));
    assert.isFalse(isCurrentCanonicalProviderEventLog("thread.native.log"));
    assert.isFalse(isCurrentCanonicalProviderEventLog("thread.log.1"));
  });
});
