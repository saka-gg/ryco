import { assert, describe, it, vi } from "@effect/vitest";

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

    const json = serializeProviderEventLogRecord("canonical", event, "full");
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
      serializeProviderEventLogRecord("native", event.raw.payload, "full") ?? "",
      "member 399",
    );
  });

  it("caps long strings, summarizes inline base64 and redacts Agent Control secrets", () => {
    const longText = `${"lorem ipsum ".repeat(2_000)}TAIL`;
    const base64 = "QUJD".repeat(10_000);
    const json = serializeProviderEventLogRecord(
      "native",
      {
        text: longText,
        image: `data:image/png;base64,${base64}`,
        blob: base64,
        auth: `Bearer rycoac_${"z".repeat(43)}`,
      },
      "full",
    );
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
    assert.strictEqual(serializeProviderEventLogRecord("native", record, "full"), plain);

    const nested = {
      payload: { progress: [...progress, { output: "command output ".repeat(2_000) }] },
    };
    const json = serializeProviderEventLogRecord("native", nested, "full")!;
    assert.include(json, "chars omitted");
    assert.isBelow(json.length, plain.length + PROVIDER_EVENT_LOG_STRING_CAP);
  });

  it("serializes a record with an over-cap string once, already capped", () => {
    const record = {
      method: "item/completed",
      payload: { item: { type: "imageView", data: "QUJD".repeat(400_000) } },
    };
    const stringify = vi.spyOn(JSON, "stringify");
    try {
      const json = serializeProviderEventLogRecord("native", record, "full")!;
      assert.match(json, /\[inline base64 omitted chars=1600000 sha256=[0-9a-f]{16}\]/);
      // No full-size plain serialization ahead of the capping one.
      assert.strictEqual(stringify.mock.calls.length, 1);
    } finally {
      stringify.mockRestore();
    }
  });

  it("serializes records the bounded scan cannot finish exactly as before", () => {
    const createdAt = new Date("2026-10-12T00:00:00.000Z");
    const withToJson = { createdAt, payload: { output: "lorem ipsum ".repeat(1_000) } };
    const json = serializeProviderEventLogRecord("native", withToJson, "full")!;
    assert.include(json, '"createdAt":"2026-10-12T00:00:00.000Z"');
    assert.include(json, "chars omitted");

    const wide = {
      members: Array.from({ length: 1_000 }, (_, index) => ({ index })),
      tail: "lorem ipsum ".repeat(1_000),
    };
    assert.include(serializeProviderEventLogRecord("native", wide, "full")!, "chars omitted");

    // Strings and primitives count against the scan budget too.
    const longList = { lines: Array.from({ length: 5_000 }, (_, index) => `line ${index}`) };
    assert.strictEqual(
      serializeProviderEventLogRecord("native", longList, "full"),
      JSON.stringify(longList),
    );
    const longListWithTail = { ...longList, tail: "lorem ipsum ".repeat(1_000) };
    assert.include(
      serializeProviderEventLogRecord("native", longListWithTail, "full")!,
      "chars omitted",
    );
  });
});

describe("canonical raw at each detail level", () => {
  const canonical = (type: string, raw: Record<string, unknown>) => ({
    type,
    eventId: "event-1",
    threadId: "thread-1",
    payload: {},
    raw,
  });
  const writtenRaw = (record: unknown, mode: "full" | "lifecycle") =>
    JSON.parse(serializeProviderEventLogRecord("canonical", record, mode)!).raw;

  it("writes no provider content at lifecycle, even for a message the native log drops", () => {
    const taskNotification = canonical("task.completed", {
      source: "claude.sdk.message",
      method: "claude/system/task_notification",
      messageType: "system:task_notification",
      payload: {
        uuid: "sdk-uuid-2",
        task_id: "task-1",
        output_file: "/tmp/out.txt",
        summary: "provider-written task summary",
      },
    });
    assert.isFalse(
      shouldWriteProviderEventRecord(
        "lifecycle",
        "native",
        claudeNative("claude/system/task_notification"),
      ),
    );
    const reference = {
      source: "claude.sdk.message",
      method: "claude/system/task_notification",
      messageType: "system:task_notification",
      nativeId: "sdk-uuid-2",
    };
    // The native log drops it at lifecycle, so this raw is not written anywhere there.
    assert.deepStrictEqual(writtenRaw(taskNotification, "lifecycle"), reference);
    const json = serializeProviderEventLogRecord("canonical", taskNotification, "lifecycle")!;
    assert.notInclude(json, "provider-written task summary");
    assert.notInclude(json, "/tmp/out.txt");
    // At full the native log holds it, so the canonical record only points there.
    assert.deepStrictEqual(writtenRaw(taskNotification, "full"), reference);
  });

  it("keeps only the reference when the lifecycle native log holds the message", () => {
    const init = canonical("session.configured", {
      source: "claude.sdk.message",
      method: "claude/system/init",
      messageType: "system:init",
      payload: { uuid: "sdk-uuid-3", tools: ["Bash"], model: "claude" },
    });
    assert.deepStrictEqual(writtenRaw(init, "lifecycle"), {
      source: "claude.sdk.message",
      method: "claude/system/init",
      messageType: "system:init",
      nativeId: "sdk-uuid-3",
    });
    const codexRequest = canonical("request.opened", {
      source: "codex.app-server.request",
      method: "item/commandExecution/requestApproval",
      payload: { threadId: "t", turnId: "u", itemId: "i", command: ["ls", "-la"], cwd: "/" },
    });
    assert.isUndefined(writtenRaw(codexRequest, "lifecycle").payload);
  });

  it("references adapter-made payloads that repeat the canonical payload at every level", () => {
    const content = "file body ".repeat(2_400);
    const permission = {
      ...canonical("request.opened", {
        source: "claude.sdk.permission",
        method: "canUseTool/request",
        payload: { toolName: "Write", input: { file_path: "/tmp/a.ts", content } },
      }),
      payload: { requestType: "file_change", args: { toolName: "Write", input: { content } } },
    };
    const copilotSynthetic = canonical("request.opened", {
      source: "copilot.sdk.synthetic",
      payload: { requestType: "command_execution", args: { command: ["ls", "-la"] } },
    });
    for (const mode of ["full", "lifecycle"] as const) {
      assert.deepStrictEqual(writtenRaw(permission, mode), {
        source: "claude.sdk.permission",
        method: "canUseTool/request",
      });
      assert.deepStrictEqual(writtenRaw(copilotSynthetic, mode), {
        source: "copilot.sdk.synthetic",
      });
    }
    // The tool input is written once, in the canonical payload.
    const json = serializeProviderEventLogRecord("canonical", permission, "lifecycle")!;
    assert.isBelow(json.length, content.length * 1.5);
  });

  it("names OpenCode raws by their event type, as the native log does", () => {
    const openCodeRaw = (type: string) => ({
      source: "opencode.sdk.event",
      payload: { type, properties: { sessionID: "ses-1", status: { type: "busy" } } },
    });
    const nativeOpenCode = (type: string) => ({
      observedAt: "2026-10-12T00:00:00.000Z",
      event: {
        provider: "opencode",
        threadId: "thread-1",
        type,
        payload: openCodeRaw(type).payload,
      },
    });

    // session.idle is a lifecycle name: the native log keeps it, so only the reference stays.
    assert.isTrue(
      shouldWriteProviderEventRecord("lifecycle", "native", nativeOpenCode("session.idle")),
    );
    assert.deepStrictEqual(
      writtenRaw(canonical("turn.completed", openCodeRaw("session.idle")), "lifecycle"),
      { source: "opencode.sdk.event" },
    );
    // session.status is not; lifecycle still writes only the reference.
    assert.isFalse(
      shouldWriteProviderEventRecord("lifecycle", "native", nativeOpenCode("session.status")),
    );
    const status = canonical("session.state.changed", openCodeRaw("session.status"));
    assert.deepStrictEqual(writtenRaw(status, "lifecycle"), { source: "opencode.sdk.event" });
    assert.deepStrictEqual(writtenRaw(status, "full"), { source: "opencode.sdk.event" });
  });

  it("references Codex session notifications, which the native session envelope keeps", () => {
    const connecting = canonical("session.state.changed", {
      source: "codex.app-server.notification",
      method: "session/connecting",
      payload: { message: "Starting Codex App Server session.", detail: { attempt: 1 } },
    });
    assert.isTrue(
      shouldWriteProviderEventRecord("lifecycle", "native", {
        observedAt: "2026-10-12T00:00:00.000Z",
        event: { kind: "session", method: "session/connecting", provider: "codex" },
      }),
    );
    assert.deepStrictEqual(writtenRaw(connecting, "lifecycle"), {
      source: "codex.app-server.notification",
      method: "session/connecting",
    });
  });

  it("keeps a small adapter-made payload inline at full only", () => {
    const turnStarted = canonical("turn.started", {
      source: "claude.sdk.message",
      method: "claude/synthetic-turn-start",
      payload: { openedBy: "wake-signal" },
    });
    assert.deepStrictEqual(writtenRaw(turnStarted, "full"), turnStarted.raw);
    assert.deepStrictEqual(writtenRaw(turnStarted, "lifecycle"), {
      source: "claude.sdk.message",
      method: "claude/synthetic-turn-start",
    });
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

  it("recognises OpenCode part deltas and Copilot assistant deltas", () => {
    const openCode = (partID: string, delta: string) => ({
      observedAt: "2026-10-12T00:00:00.000Z",
      event: {
        provider: "opencode",
        threadId: "thread-1",
        providerThreadId: "ses-1",
        type: "message.part.delta",
        turnId: "turn-1",
        payload: {
          type: "message.part.delta",
          properties: { sessionID: "ses-1", messageID: "msg-1", partID, field: "text", delta },
        },
      },
    });
    const first = extractProviderEventDelta("native", openCode("part-1", "he"));
    assert.strictEqual(first?.text, "he");
    assert.strictEqual(
      extractProviderEventDelta("native", openCode("part-1", "llo"))?.key,
      first?.key,
    );
    assert.notStrictEqual(
      extractProviderEventDelta("native", openCode("part-2", "x"))?.key,
      first?.key,
    );

    const copilot = (type: string, data: Record<string, unknown>) => ({
      observedAt: "2026-10-12T00:00:00.000Z",
      event: { id: "evt", timestamp: "t", parentId: null, ephemeral: true, type, data },
    });
    const message = extractProviderEventDelta(
      "native",
      copilot("assistant.message_delta", { messageId: "msg-1", deltaContent: "hi" }),
    );
    assert.strictEqual(message?.text, "hi");
    const reasoning = extractProviderEventDelta(
      "native",
      copilot("assistant.reasoning_delta", { reasoningId: "r-1", deltaContent: "hm" }),
    );
    assert.strictEqual(reasoning?.text, "hm");
    assert.notStrictEqual(reasoning?.key, message?.key);
    assert.notStrictEqual(
      extractProviderEventDelta(
        "native",
        copilot("assistant.message_delta", { messageId: "msg-2", deltaContent: "yo" }),
      )?.key,
      message?.key,
    );

    assert.isUndefined(
      extractProviderEventDelta("native", copilot("assistant.message", { messageId: "msg-1" })),
    );
    assert.isUndefined(
      extractProviderEventDelta("native", {
        event: { type: "message.part.updated", payload: { properties: {} } },
      }),
    );
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
