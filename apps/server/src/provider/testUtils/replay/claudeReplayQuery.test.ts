import type {
  Options as ClaudeQueryOptions,
  PermissionResult,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { assert, describe, it } from "@effect/vitest";
import { Deferred, Effect } from "effect";

import {
  makeClaudeReplayQueryFactory,
  type ClaudeQueryRuntime,
  type ClaudeReplayQueryFactory,
} from "./claudeReplayQuery.ts";
import { normalizeClaudeOutbound } from "./replayMatch.ts";
import type { ReplayEntry, ReplayTranscript } from "./replayTranscript.ts";

const transcriptOf = (
  entries: ReadonlyArray<ReplayEntry>,
  metadata?: Record<string, unknown>,
): ReplayTranscript => ({
  header: {
    type: "transcript_start",
    provider: "claudeAgent",
    protocol: "claude-agent-sdk.query",
    version: "0.3.296",
    scenario: "claude-query-unit",
    source: "hand-authored",
    ...(metadata ? { metadata } : {}),
  },
  entries,
});

const SECRET_TOKEN = "sk-ant-oat01-replay-secret";
const AGENT_CONTROL_TOKEN = "agent-control-bearer-secret";

const RECORDED_OPTIONS = {
  cwd: "/replay/workspace",
  model: "claude-sonnet-4-6",
  sessionId: "session-recorded",
  includePartialMessages: true,
  permissionMode: "bypassPermissions",
  allowDangerouslySkipPermissions: true,
  settingSources: ["user", "project", "local"],
  additionalDirectories: ["/replay/workspace"],
  systemPrompt: { type: "preset", preset: "claude_code", hasAppend: true },
};

/** What the adapter passes: credentials, callbacks and product copy beside the stable options. */
const actualOptions = (overrides: Record<string, unknown> = {}) =>
  ({
    ...RECORDED_OPTIONS,
    sessionId: "session-actual",
    systemPrompt: { type: "preset", preset: "claude_code", append: "Attachment instructions." },
    env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:8317", ANTHROPIC_AUTH_TOKEN: SECRET_TOKEN },
    mcpServers: {
      ryco_agent_control: {
        type: "http",
        url: "http://127.0.0.1:1/mcp",
        headers: { Authorization: `Bearer ${AGENT_CONTROL_TOKEN}` },
      },
    },
    pathToClaudeCodeExecutable: "/replay/bin/claude",
    extraArgs: { "thinking-display": "summarized" },
    canUseTool: async () => ({ behavior: "allow", updatedInput: {} }),
    ...overrides,
  }) as unknown as ClaudeQueryOptions;

const open = (options: Record<string, unknown> = RECORDED_OPTIONS): ReplayEntry => ({
  type: "expect_outbound",
  label: "query.open",
  frame: { type: "query.open", options },
});

const userMessage = (uuid: string, text: string) => ({
  type: "user",
  uuid,
  parent_tool_use_id: null,
  message: { role: "user", content: [{ type: "text", text }] },
});

const offer = (label: string, uuid: string, text: string): ReplayEntry => ({
  type: "expect_outbound",
  label,
  frame: { type: "prompt.offer", message: userMessage(uuid, text) },
});

const sdk = (label: string, message: Record<string, unknown>): ReplayEntry => ({
  type: "emit_inbound",
  label,
  frame: { type: "sdk.message", message: { session_id: "session-recorded", ...message } },
});

const textStart = (uuid: string, echo: string) => ({
  type: "stream_event",
  uuid,
  parent_tool_use_id: null,
  user_message_uuid: echo,
  user_message_uuids: [echo],
  event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
});

const result = (echo: ReadonlyArray<string>, extra: Record<string, unknown> = {}) => ({
  type: "result",
  subtype: "success",
  is_error: false,
  num_turns: 1,
  result: "done",
  uuid: "result-1",
  user_message_uuids: [...echo],
  ...extra,
});

/** A prompt stream the test writes to, as the adapter's prompt queue is. */
function makePromptSource() {
  const buffered: Array<SDKUserMessage> = [];
  const waiters: Array<(result: IteratorResult<SDKUserMessage>) => void> = [];
  return {
    iterable: {
      [Symbol.asyncIterator]: () => ({
        next: () => {
          const message = buffered.shift();
          if (message !== undefined)
            return Promise.resolve({ done: false as const, value: message });
          return new Promise<IteratorResult<SDKUserMessage>>((resolve) => waiters.push(resolve));
        },
      }),
    } satisfies AsyncIterable<SDKUserMessage>,
    offer: (uuid: string, text: string) => {
      const message = {
        ...userMessage(uuid, text),
        session_id: "",
      } as unknown as SDKUserMessage;
      const waiter = waiters.shift();
      if (waiter) waiter({ done: false, value: message });
      else buffered.push(message);
    },
  };
}

const openQuery = (
  factory: ClaudeReplayQueryFactory,
  options: ClaudeQueryOptions = actualOptions(),
) => {
  const prompt = makePromptSource();
  const query = factory.createQuery({ prompt: prompt.iterable, options });
  return { query, prompt, messages: query[Symbol.asyncIterator]() };
};

const next = (messages: AsyncIterator<SDKMessage>) =>
  Effect.promise(async () => {
    const step = await messages.next();
    assert.isFalse(step.done, "the query ended");
    return step.value as unknown as Record<string, unknown>;
  });

/** True when the next message is already buffered: its read resolves before a fresh promise. */
const nextIsBuffered = (messages: AsyncIterator<SDKMessage>) =>
  Effect.promise(async () => {
    const pending = Symbol("pending");
    const raced = await Promise.race([messages.next(), Promise.resolve(pending)]);
    return raced !== pending;
  });

const awaitFailure = (factory: ClaudeReplayQueryFactory) => Deferred.await(factory.failure);

describe("Claude replay query", () => {
  it("normalizes query.open to its stable options, without credentials", () => {
    const normalized = normalizeClaudeOutbound({ type: "query.open", options: actualOptions() });
    assert.deepEqual(normalized, {
      type: "query.open",
      options: { ...RECORDED_OPTIONS, sessionId: "session-actual" },
    });
    // A recorded (already stable) frame keeps its shape.
    assert.deepEqual(normalizeClaudeOutbound(normalized), normalized);
    assert.deepEqual(
      normalizeClaudeOutbound({ type: "prompt.offer", message: { uuid: "u", session_id: "" } }),
      { type: "prompt.offer", message: { uuid: "u" } },
    );
  });

  it.effect("opens a query with the bound session id and keeps credentials out of a mismatch", () =>
    Effect.gen(function* () {
      const matching = yield* makeClaudeReplayQueryFactory(
        transcriptOf([open(), sdk("init", { type: "system", subtype: "init", uuid: "init-1" })]),
      );
      // The init flows once query.open matched.
      assert.equal((yield* next(openQuery(matching).messages)).session_id, "session-actual");
      yield* matching.assertConsumed;

      const mismatched = yield* makeClaudeReplayQueryFactory(transcriptOf([open()]));
      openQuery(mismatched, actualOptions({ model: "claude-opus-4-7" }));
      const failure = yield* awaitFailure(mismatched);
      assert.equal(failure._tag, "ReplayFrameMismatchError");
      if (failure._tag !== "ReplayFrameMismatchError") return;
      assert.equal(failure.diffPath, "$.options.model");
      assert.equal(failure.label, "query.open");
      for (const secret of [SECRET_TOKEN, AGENT_CONTROL_TOKEN, "Attachment instructions."]) {
        assert.notInclude(failure.message, secret);
      }
      assert.equal((yield* Effect.flip(mismatched.assertConsumed))._tag, failure._tag);
    }).pipe(Effect.scoped),
  );

  it.effect("binds the prompt uuid and rewrites the echoes of it and of the session", () =>
    Effect.gen(function* () {
      const factory = yield* makeClaudeReplayQueryFactory(
        transcriptOf([
          open(),
          offer("prompt", "prompt-recorded", "Say hello."),
          sdk("text-start", textStart("frame-1", "prompt-recorded")),
          sdk("result", result(["prompt-recorded"])),
        ]),
      );
      const { prompt, messages } = openQuery(factory);
      prompt.offer("prompt-actual", "Say hello.");

      const started = yield* next(messages);
      assert.equal(started.user_message_uuid, "prompt-actual");
      assert.deepEqual(started.user_message_uuids, ["prompt-actual"]);
      assert.equal(started.session_id, "session-actual");
      // A uuid of the CLI's own stays as recorded.
      assert.equal(started.uuid, "frame-1");
      assert.deepEqual((yield* next(messages)).user_message_uuids, ["prompt-actual"]);
      yield* factory.assertConsumed;
    }).pipe(Effect.scoped),
  );

  it.effect("delivers messages recorded before an interrupt receipt ahead of it", () =>
    Effect.gen(function* () {
      const factory = yield* makeClaudeReplayQueryFactory(
        transcriptOf([
          open(),
          offer("prompt", "prompt-recorded", "Count to ten."),
          sdk("text-start", textStart("frame-1", "prompt-recorded")),
          {
            type: "expect_outbound",
            label: "interrupt",
            frame: { type: "query.interrupt", args: [{ cancelQueued: true }] },
          },
          sdk(
            "aborted",
            result(["prompt-recorded"], {
              subtype: "error_during_execution",
              terminal_reason: "aborted_streaming",
            }),
          ),
          {
            type: "emit_inbound",
            label: "receipt",
            frame: {
              type: "interrupt.result",
              value: { still_queued: [], cancelled: ["prompt-recorded"] },
            },
          },
        ]),
      );
      const { query, prompt, messages } = openQuery(factory);
      prompt.offer("prompt-actual", "Count to ten.");
      yield* next(messages);

      const receipt = yield* Effect.promise(() => query.interrupt({ cancelQueued: true }));
      // Receipts list prompt uuids, rewritten like echoes.
      assert.deepEqual(receipt, { still_queued: [], cancelled: ["prompt-actual"] });
      assert.isTrue(yield* nextIsBuffered(messages));
      yield* factory.assertConsumed;
    }).pipe(Effect.scoped),
  );

  it.effect("answers a permission request through canUseTool and matches the answer", () =>
    Effect.gen(function* () {
      const permissionEntries = (behavior: "allow" | "deny"): ReadonlyArray<ReplayEntry> => [
        open(),
        offer("prompt", "prompt-recorded", "List the files."),
        {
          type: "emit_inbound",
          label: "permission",
          frame: {
            type: "permission.request",
            toolName: "Bash",
            input: { command: "ls" },
            options: { toolUseID: "tool-1", decisionReason: "Bash needs approval" },
          },
        },
        {
          type: "expect_outbound",
          label: "permission.response",
          frame: {
            type: "permission.response",
            result:
              behavior === "allow"
                ? { behavior: "allow", updatedInput: { command: "ls" } }
                : { behavior: "deny", message: "User declined tool execution." },
          },
        },
        sdk("result", result(["prompt-recorded"])),
      ];
      const calls: Array<{
        readonly toolName: string;
        readonly input: Record<string, unknown>;
        readonly toolUseID: string;
        readonly requestId: string;
        readonly decisionReason: string | undefined;
        readonly hasSignal: boolean;
      }> = [];
      const canUseTool = async (
        toolName: string,
        input: Record<string, unknown>,
        options: Parameters<NonNullable<ClaudeQueryOptions["canUseTool"]>>[2],
      ): Promise<PermissionResult> => {
        calls.push({
          toolName,
          input,
          toolUseID: options.toolUseID,
          requestId: options.requestId,
          decisionReason: options.decisionReason,
          hasSignal: options.signal instanceof AbortSignal,
        });
        return { behavior: "allow", updatedInput: input };
      };

      const allowed = yield* makeClaudeReplayQueryFactory(transcriptOf(permissionEntries("allow")));
      const { prompt, messages } = openQuery(allowed, actualOptions({ canUseTool }));
      prompt.offer("prompt-actual", "List the files.");
      // The result flows only once the answer matched.
      assert.deepEqual((yield* next(messages)).user_message_uuids, ["prompt-actual"]);
      assert.deepEqual(calls, [
        {
          toolName: "Bash",
          input: { command: "ls" },
          toolUseID: "tool-1",
          // The SDK's control request id; the transcript defaults it to the tool use id.
          requestId: "tool-1",
          decisionReason: "Bash needs approval",
          hasSignal: true,
        },
      ]);
      yield* allowed.assertConsumed;

      const declined = yield* makeClaudeReplayQueryFactory(transcriptOf(permissionEntries("deny")));
      const declinedQuery = openQuery(declined, actualOptions({ canUseTool }));
      declinedQuery.prompt.offer("prompt-actual", "List the files.");
      const failure = yield* awaitFailure(declined);
      assert.equal(
        failure._tag === "ReplayFrameMismatchError" && failure.diffPath,
        "$.result.behavior",
      );
    }).pipe(Effect.scoped),
  );

  it.effect("fails a frame sent after close and ends the query's messages", () =>
    Effect.gen(function* () {
      const factory = yield* makeClaudeReplayQueryFactory(
        transcriptOf([
          open(),
          { type: "expect_outbound", label: "close", frame: { type: "query.close" } },
        ]),
      );
      const { query, messages } = openQuery(factory);
      query.close();
      // Closing twice writes nothing more.
      query.close();
      assert.isTrue((yield* Effect.promise(() => messages.next())).done);

      const rejected = yield* Effect.promise(() =>
        query.setModel("claude-opus-4-7").then(
          () => undefined,
          (cause: unknown) => cause,
        ),
      );
      assert.instanceOf(rejected, Error);
      const failure = yield* awaitFailure(factory);
      assert.equal(failure._tag, "ReplayUnexpectedOutboundError");
      assert.include(failure.message, "the query was closed");
      assert.equal(factory.queries[0]?.state(), "closed");
    }).pipe(Effect.scoped),
  );

  it.effect("fails on an inbound frame it cannot deliver and ends the query's messages", () =>
    Effect.gen(function* () {
      const factory = yield* makeClaudeReplayQueryFactory(
        transcriptOf([
          open(),
          { type: "emit_inbound", label: "receipt", frame: { type: "interrupt.result" } },
          sdk("init", { type: "system", subtype: "init", uuid: "init-1" }),
        ]),
      );
      const { messages } = openQuery(factory);
      const failure = yield* awaitFailure(factory);
      assert.equal(failure._tag, "ReplayInvalidInboundError");
      assert.include(failure.message, "no interrupt() awaits a receipt");
      const thrown = yield* Effect.promise(() =>
        messages.next().then(
          () => undefined,
          (cause: unknown) => cause,
        ),
      );
      assert.instanceOf(thrown, Error);
      const query = factory.queries[0];
      assert.equal(query?.state(), "failed");
      assert.include(query?.describePosition() ?? "", "failed with ReplayInvalidInboundError");
      assert.equal((yield* Effect.flip(factory.assertConsumed))._tag, failure._tag);
    }).pipe(Effect.scoped),
  );

  it.effect("resumes the session an earlier query opened, and refuses a query too many", () =>
    Effect.gen(function* () {
      const entries: ReadonlyArray<ReplayEntry> = [
        open(),
        sdk("init", { type: "system", subtype: "init", uuid: "init-1" }),
        { type: "runtime_exit", status: "success" },
        { type: "spawn", label: "restart" },
        open({ ...RECORDED_OPTIONS, sessionId: undefined, resume: "session-recorded" }),
        sdk("init-2", { type: "system", subtype: "init", uuid: "init-2" }),
      ];
      const factory = yield* makeClaudeReplayQueryFactory(transcriptOf(entries));
      const first = openQuery(factory);
      assert.equal((yield* next(first.messages)).session_id, "session-actual");
      assert.isTrue((yield* Effect.promise(() => first.messages.next())).done);
      // The process is gone: close writes nothing.
      first.query.close();
      const second = openQuery(
        factory,
        actualOptions({ sessionId: undefined, resume: "session-actual" }),
      );
      assert.equal((yield* next(second.messages)).session_id, "session-actual");
      yield* factory.assertConsumed;

      assert.throws(() => openQuery(factory), /no transcript for query #3/u);
      assert.equal((yield* awaitFailure(factory))._tag, "ReplayUnexpectedSpawnError");

      // A resume of anything but the bound session does not match.
      const other = yield* makeClaudeReplayQueryFactory(transcriptOf(entries));
      const otherFirst = openQuery(other);
      yield* next(otherFirst.messages);
      openQuery(other, actualOptions({ sessionId: undefined, resume: "session-elsewhere" }));
      const failure = yield* awaitFailure(other);
      assert.equal(
        failure._tag === "ReplayFrameMismatchError" && failure.diffPath,
        "$.options.resume",
      );
    }).pipe(Effect.scoped),
  );

  it.effect("throws a recorded runtime error from the query and reports unplayed entries", () =>
    Effect.gen(function* () {
      const crashed = yield* makeClaudeReplayQueryFactory(
        transcriptOf([
          open(),
          {
            type: "runtime_exit",
            status: "error",
            code: 1,
            error: { message: "Claude Code process exited with code 1" },
          },
        ]),
      );
      const { messages } = openQuery(crashed);
      const thrown = yield* Effect.promise(() =>
        messages.next().then(
          () => undefined,
          (cause: unknown) => cause,
        ),
      );
      assert.equal(
        (thrown as Error | undefined)?.message,
        "Claude Code process exited with code 1",
      );
      // A recorded exit is a scenario, not a replay failure.
      yield* crashed.assertConsumed;

      const unplayed = yield* makeClaudeReplayQueryFactory(
        transcriptOf([
          open(),
          sdk("init", { type: "system", subtype: "init", uuid: "init-1" }),
          offer("prompt", "prompt-recorded", "Hi."),
          sdk("reply", result([])),
        ]),
      );
      yield* next(openQuery(unplayed).messages);
      const incomplete = yield* Effect.flip(unplayed.assertConsumed);
      assert.equal(incomplete._tag, "ReplayIncompleteError");
      assert.deepEqual(
        incomplete._tag === "ReplayIncompleteError" ? incomplete.remainingLabels : [],
        ["prompt", "reply"],
      );
      assert.include(unplayed.describePosition(), "waiting for outbound prompt");
    }).pipe(Effect.scoped),
  );

  it.effect("offers initialize results only when the transcript records them", () =>
    Effect.gen(function* () {
      const bare = yield* makeClaudeReplayQueryFactory(transcriptOf([open()]));
      const bareQuery: ClaudeQueryRuntime = openQuery(bare).query;
      assert.isUndefined(bareQuery.initializationResult);
      assert.isUndefined(bareQuery.mcpServerStatus);

      const initialized = yield* makeClaudeReplayQueryFactory(
        transcriptOf([open()], {
          initializationResult: { commands: [] },
          mcpServerStatus: [{ name: "ryco_device", status: "connected" }],
        }),
      );
      const query = openQuery(initialized).query;
      assert.deepEqual(yield* Effect.promise(() => query.initializationResult!()), {
        commands: [],
      });
      assert.deepEqual(yield* Effect.promise(() => query.mcpServerStatus!()), [
        { name: "ryco_device", status: "connected" },
      ]);
    }).pipe(Effect.scoped),
  );
});
