import assert from "node:assert/strict";

import { Deferred, Effect, Fiber, Redacted, Schema } from "effect";
import { describe, it } from "vite-plus/test";
import { MessageId, ThreadId, TurnId } from "@ryco/contracts";
import * as CodexErrors from "effect-codex-app-server/errors";
import * as CodexRpc from "effect-codex-app-server/rpc";
import * as CodexSchema from "effect-codex-app-server/schema";

import {
  CODEX_ASK_MODE_DEVELOPER_INSTRUCTIONS,
  CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS,
  CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS,
} from "../CodexDeveloperInstructions.ts";
import {
  CODEX_AGENT_CONTROL_SERVER_NAME,
  CodexSessionRuntimeCompactionNotStartedError,
  buildTurnStartParams,
  buildTurnSteerParams,
  isRecoverableThreadResumeError,
  makeCodexCompactionStarter,
  openCodexThread,
  revertCodexThread,
} from "./CodexSessionRuntime.ts";

function makeThreadOpenResponse(
  threadId: string,
): CodexRpc.ClientRequestResponsesByMethod["thread/start"] {
  return {
    cwd: "/tmp/project",
    model: "gpt-5.3-codex",
    modelProvider: "openai",
    approvalPolicy: "never",
    approvalsReviewer: "user",
    sandbox: { type: "danger-full-access" },
    thread: {
      id: threadId,
      createdAt: "2026-04-18T00:00:00.000Z",
      source: { session: "cli" },
      turns: [],
      status: {
        state: "idle",
        activeFlags: [],
      },
    },
  } as unknown as CodexRpc.ClientRequestResponsesByMethod["thread/start"];
}

describe("buildTurnStartParams", () => {
  it("includes plan collaboration mode when requested", () => {
    const params = Effect.runSync(
      buildTurnStartParams({
        threadId: "provider-thread-1",
        runtimeMode: "full-access",
        prompt: "Make a plan",
        model: "gpt-5.3-codex",
        effort: "medium",
        interactionMode: "plan",
      }),
    );

    assert.deepStrictEqual(params, {
      summary: "auto",
      threadId: "provider-thread-1",
      approvalPolicy: "never",
      approvalsReviewer: "user",
      sandboxPolicy: {
        type: "dangerFullAccess",
      },
      input: [
        {
          type: "text",
          text: "Make a plan",
        },
      ],
      model: "gpt-5.3-codex",
      effort: "medium",
      collaborationMode: {
        mode: "plan",
        settings: {
          model: "gpt-5.3-codex",
          reasoning_effort: "medium",
          developer_instructions: CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS,
        },
      },
    });
  });

  it("maps ask mode to default collaboration mode with a read-only sandbox", () => {
    const params = Effect.runSync(
      buildTurnStartParams({
        threadId: "provider-thread-1",
        runtimeMode: "full-access",
        prompt: "Explain this",
        model: "gpt-5.3-codex",
        effort: "medium",
        interactionMode: "ask",
      }),
    );

    assert.deepStrictEqual(params, {
      summary: "auto",
      threadId: "provider-thread-1",
      approvalPolicy: "never",
      approvalsReviewer: "user",
      // Ask mode forces a read-only sandbox even in full-access runtime mode.
      sandboxPolicy: {
        type: "readOnly",
      },
      input: [
        {
          type: "text",
          text: "Explain this",
        },
      ],
      model: "gpt-5.3-codex",
      effort: "medium",
      collaborationMode: {
        // The Codex protocol has no ask mode; ask rides on "default".
        mode: "default",
        settings: {
          model: "gpt-5.3-codex",
          reasoning_effort: "medium",
          developer_instructions: CODEX_ASK_MODE_DEVELOPER_INSTRUCTIONS,
        },
      },
    });
  });

  it("includes default collaboration mode and image attachments", () => {
    const params = Effect.runSync(
      buildTurnStartParams({
        threadId: "provider-thread-1",
        runtimeMode: "auto-accept-edits",
        prompt: "Implement it",
        model: "gpt-5.3-codex",
        interactionMode: "default",
        attachments: [
          {
            type: "image",
            url: "data:image/png;base64,abc",
          },
        ],
      }),
    );

    assert.deepStrictEqual(params, {
      summary: "auto",
      threadId: "provider-thread-1",
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandboxPolicy: {
        type: "workspaceWrite",
      },
      input: [
        {
          type: "text",
          text: "Implement it",
        },
        {
          type: "image",
          url: "data:image/png;base64,abc",
        },
      ],
      model: "gpt-5.3-codex",
      collaborationMode: {
        mode: "default",
        settings: {
          model: "gpt-5.3-codex",
          reasoning_effort: "medium",
          developer_instructions: CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS,
        },
      },
    });
  });

  it("appends project custom system prompt to collaboration developer instructions", () => {
    const params = Effect.runSync(
      buildTurnStartParams({
        threadId: "provider-thread-1",
        runtimeMode: "full-access",
        prompt: "Implement it",
        model: "gpt-5.3-codex",
        interactionMode: "default",
        customSystemPrompt: "Always use TypeScript.",
      }),
    );

    assert.equal(
      params.collaborationMode?.settings?.developer_instructions,
      `${CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS}\n\nProject custom system prompt:\n<project_custom_system_prompt>\nAlways use TypeScript.\n</project_custom_system_prompt>`,
    );
  });

  it("carries attachment instructions in the developer instructions, not the prompt", () => {
    const params = Effect.runSync(
      buildTurnStartParams({
        threadId: "provider-thread-1",
        runtimeMode: "full-access",
        prompt: "/review",
        model: "gpt-5.3-codex",
        interactionMode: "default",
        attachmentInstructions: "Deliver files like this.",
      }),
    );

    assert.equal(
      params.collaborationMode?.settings?.developer_instructions,
      `${CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS}\n\nDeliver files like this.`,
    );
    assert.deepStrictEqual(params.input, [{ type: "text", text: "/review" }]);
  });

  it("leads the prompt with attachment instructions only without a developer channel", () => {
    const prompted = Effect.runSync(
      buildTurnStartParams({
        threadId: "provider-thread-1",
        runtimeMode: "full-access",
        prompt: "Implement it",
        attachmentInstructions: "Deliver files like this.",
      }),
    );
    assert.deepStrictEqual(prompted.input, [
      { type: "text", text: "Deliver files like this.\n\nImplement it" },
    ]);

    const command = Effect.runSync(
      buildTurnStartParams({
        threadId: "provider-thread-1",
        runtimeMode: "full-access",
        prompt: "/compact",
        attachmentInstructions: "Deliver files like this.",
      }),
    );
    assert.deepStrictEqual(command.input, [{ type: "text", text: "/compact" }]);
  });

  it("routes approvals to the reviewer subagent in auto mode", () => {
    const params = Effect.runSync(
      buildTurnStartParams({
        threadId: "provider-thread-1",
        runtimeMode: "auto",
        prompt: "Ship it",
      }),
    );

    assert.deepStrictEqual(params, {
      summary: "auto",
      threadId: "provider-thread-1",
      approvalPolicy: "on-request",
      approvalsReviewer: "guardian_subagent",
      sandboxPolicy: {
        type: "workspaceWrite",
      },
      input: [
        {
          type: "text",
          text: "Ship it",
        },
      ],
    });
  });

  it("omits collaboration mode when interaction mode is absent", () => {
    const params = Effect.runSync(
      buildTurnStartParams({
        threadId: "provider-thread-1",
        runtimeMode: "approval-required",
        prompt: "Review",
      }),
    );

    assert.deepStrictEqual(params, {
      summary: "auto",
      threadId: "provider-thread-1",
      approvalPolicy: "untrusted",
      approvalsReviewer: "user",
      sandboxPolicy: {
        type: "readOnly",
      },
      input: [
        {
          type: "text",
          text: "Review",
        },
      ],
    });
  });
});

describe("buildTurnSteerParams", () => {
  it("sends only input and the exact active-turn precondition", () => {
    const params = Effect.runSync(
      buildTurnSteerParams({
        threadId: "provider-thread-1",
        expectedTurnId: TurnId.make("turn-active"),
        messageId: MessageId.make("message-steer"),
        prompt: "Also preserve the retry state.",
        attachments: [{ type: "image", url: "data:image/png;base64,abc" }],
      }),
    );

    assert.deepStrictEqual(params, {
      threadId: "provider-thread-1",
      expectedTurnId: "turn-active",
      clientUserMessageId: "message-steer",
      input: [
        { type: "text", text: "Also preserve the retry state." },
        { type: "image", url: "data:image/png;base64,abc" },
      ],
    });
  });
});

describe("isRecoverableThreadResumeError", () => {
  it("matches missing thread errors", () => {
    assert.equal(
      isRecoverableThreadResumeError(
        new CodexErrors.CodexAppServerRequestError({
          code: -32603,
          errorMessage: "Thread does not exist",
        }),
      ),
      true,
    );
  });

  it("matches Codex's missing-rollout error", () => {
    assert.equal(
      isRecoverableThreadResumeError(
        new CodexErrors.CodexAppServerRequestError({
          code: -32600,
          errorMessage: "no rollout found for thread id 019a0000-0000-7000-8000-000000000001",
        }),
      ),
      true,
    );
  });

  it("ignores non-recoverable resume errors", () => {
    assert.equal(
      isRecoverableThreadResumeError(
        new CodexErrors.CodexAppServerRequestError({
          code: -32603,
          errorMessage: "Permission denied",
        }),
      ),
      false,
    );
  });

  it("ignores unrelated missing-resource errors that do not mention threads", () => {
    assert.equal(
      isRecoverableThreadResumeError(
        new CodexErrors.CodexAppServerRequestError({
          code: -32603,
          errorMessage: "Config file not found",
        }),
      ),
      false,
    );
    assert.equal(
      isRecoverableThreadResumeError(
        new CodexErrors.CodexAppServerRequestError({
          code: -32603,
          errorMessage: "Model does not exist",
        }),
      ),
      false,
    );
  });
});

describe("openCodexThread", () => {
  it("continues an imported copy with the mapped cwd and its distinct native identity", async () => {
    const copiedId = "22222222-2222-4222-8222-222222222222";
    const client = {
      request: <M extends "thread/start" | "thread/resume">(
        method: M,
        payload: CodexRpc.ClientRequestParamsByMethod[M],
      ) => {
        assert.equal(method, "thread/resume");
        assert.equal(
          (payload as CodexRpc.ClientRequestParamsByMethod["thread/resume"]).threadId,
          copiedId,
        );
        assert.equal(payload.cwd, "/tmp/mapped-import-target");
        return Effect.succeed(
          makeThreadOpenResponse(copiedId) as CodexRpc.ClientRequestResponsesByMethod[M],
        );
      },
    };
    const result = await Effect.runPromise(
      openCodexThread({
        client,
        threadId: ThreadId.make("ryco-import-fixture"),
        runtimeMode: "approval-required",
        cwd: "/tmp/mapped-import-target",
        requestedModel: undefined,
        serviceTier: undefined,
        resumeThreadId: copiedId,
      }),
    );
    assert.equal(result.thread.id, copiedId);
  });

  it.each(["inProgress", "completed"] as const)(
    "resumes without historical items while preserving the latest %s turn",
    async (status) => {
      const latestTurn = {
        id: "latest-turn",
        items: [],
        status,
        error: null,
      };
      const client = {
        request: <M extends "thread/start" | "thread/resume">(
          method: M,
          payload: CodexRpc.ClientRequestParamsByMethod[M],
        ) => {
          assert.equal(method, "thread/resume");
          assert.ok("threadId" in payload);
          // Exercise wire encoding: an unknown field would otherwise be silently stripped.
          const encoded = Schema.encodeSync(CodexSchema.V2ThreadResumeParams)(payload);
          assert.equal(encoded.threadId, "long-thread");
          assert.equal(encoded.excludeTurns, true);
          assert.deepStrictEqual(encoded.initialTurnsPage, {
            limit: 1,
            sortDirection: "desc",
            itemsView: "notLoaded",
          });
          const page = Schema.decodeUnknownSync(
            CodexSchema.V2ThreadResumeResponse.fields.initialTurnsPage,
          )({
            data: [latestTurn],
            nextCursor: "older-turns",
          });
          return Effect.succeed({
            ...makeThreadOpenResponse("long-thread"),
            initialTurnsPage: page,
          } as CodexRpc.ClientRequestResponsesByMethod[M]);
        },
      };
      const result = await Effect.runPromise(
        openCodexThread({
          client,
          threadId: ThreadId.make("thread-1"),
          runtimeMode: "full-access",
          cwd: "/tmp/project",
          requestedModel: undefined,
          serviceTier: undefined,
          resumeThreadId: "long-thread",
        }),
      );
      assert.equal(result.thread.id, "long-thread");
      assert.deepStrictEqual(result.thread.turns, [latestTurn]);
    },
  );

  it("composes device and Agent Control MCP bindings in one thread config", async () => {
    const calls: Array<{ method: "thread/start" | "thread/resume"; payload: unknown }> = [];
    const client = {
      request: <M extends "thread/start" | "thread/resume">(
        method: M,
        payload: CodexRpc.ClientRequestParamsByMethod[M],
      ) => {
        calls.push({ method, payload });
        return Effect.succeed(
          makeThreadOpenResponse("fresh-thread") as CodexRpc.ClientRequestResponsesByMethod[M],
        );
      },
    };

    await Effect.runPromise(
      openCodexThread({
        client,
        threadId: ThreadId.make("thread-1"),
        runtimeMode: "full-access",
        cwd: "/tmp/project",
        requestedModel: undefined,
        serviceTier: undefined,
        resumeThreadId: undefined,
        deviceToolBinding: {
          url: "http://127.0.0.1:3100/device",
          headers: { Authorization: "Bearer device-token" },
          dispose: () => undefined,
        },
        agentControl: {
          serverName: CODEX_AGENT_CONTROL_SERVER_NAME,
          endpointUrl: "http://127.0.0.1:3200/mcp",
          authorization: Redacted.make("agent-control-token"),
          instructions: "Use Agent Control proposals.",
        },
      }),
    );

    assert.deepStrictEqual(calls[0]?.payload, {
      cwd: "/tmp/project",
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      approvalsReviewer: "user",
      config: {
        "features.goals": true,
        mcp_servers: {
          ryco_device: {
            url: "http://127.0.0.1:3100/device",
            http_headers: { Authorization: "Bearer device-token" },
          },
          ryco_agent_control: {
            url: "http://127.0.0.1:3200/mcp",
            http_headers: { Authorization: "Bearer agent-control-token" },
            startup_timeout_sec: 10,
          },
        },
      },
    });
  });

  it("passes fast service tier through thread/start", async () => {
    const calls: Array<{ method: "thread/start" | "thread/resume"; payload: unknown }> = [];
    const client = {
      request: <M extends "thread/start" | "thread/resume">(
        method: M,
        payload: CodexRpc.ClientRequestParamsByMethod[M],
      ) => {
        calls.push({ method, payload });
        return Effect.succeed(
          makeThreadOpenResponse("fresh-thread") as CodexRpc.ClientRequestResponsesByMethod[M],
        );
      },
    };

    await Effect.runPromise(
      openCodexThread({
        client,
        threadId: ThreadId.make("thread-1"),
        runtimeMode: "full-access",
        cwd: "/tmp/project",
        requestedModel: "gpt-5.5",
        serviceTier: "fast",
        resumeThreadId: undefined,
      }),
    );

    assert.deepStrictEqual(calls, [
      {
        method: "thread/start",
        payload: {
          cwd: "/tmp/project",
          approvalPolicy: "never",
          sandbox: "danger-full-access",
          approvalsReviewer: "user",
          model: "gpt-5.5",
          serviceTier: "fast",
          config: { "features.goals": true },
        },
      },
    ]);
  });

  it("preserves thread identity when a stored thread cannot be resumed", async () => {
    const calls: Array<{ method: "thread/start" | "thread/resume"; payload: unknown }> = [];
    const started = makeThreadOpenResponse("fresh-thread");
    const client = {
      request: <M extends "thread/start" | "thread/resume">(
        method: M,
        payload: CodexRpc.ClientRequestParamsByMethod[M],
      ) => {
        calls.push({ method, payload });
        if (method === "thread/resume") {
          return Effect.fail(
            new CodexErrors.CodexAppServerRequestError({
              code: -32603,
              errorMessage: "thread not found",
            }),
          );
        }
        return Effect.succeed(started as CodexRpc.ClientRequestResponsesByMethod[M]);
      },
    };

    const error = await Effect.runPromise(
      openCodexThread({
        client,
        threadId: ThreadId.make("thread-1"),
        runtimeMode: "full-access",
        cwd: "/tmp/project",
        requestedModel: "gpt-5.3-codex",
        serviceTier: undefined,
        resumeThreadId: "stale-thread",
      }).pipe(Effect.flip),
    );

    assert.equal(error.message, "thread not found");
    assert.deepStrictEqual(
      calls.map((call) => call.method),
      ["thread/resume"],
    );
  });

  it("propagates non-recoverable resume failures", async () => {
    const client = {
      request: <M extends "thread/start" | "thread/resume">(
        method: M,
        _payload: CodexRpc.ClientRequestParamsByMethod[M],
      ) => {
        if (method === "thread/resume") {
          return Effect.fail(
            new CodexErrors.CodexAppServerRequestError({
              code: -32603,
              errorMessage: "timed out waiting for server",
            }),
          );
        }
        return Effect.succeed(
          makeThreadOpenResponse("fresh-thread") as CodexRpc.ClientRequestResponsesByMethod[M],
        );
      },
    };

    await assert.rejects(
      Effect.runPromise(
        openCodexThread({
          client,
          threadId: ThreadId.make("thread-1"),
          runtimeMode: "full-access",
          cwd: "/tmp/project",
          requestedModel: "gpt-5.3-codex",
          serviceTier: undefined,
          resumeThreadId: "stale-thread",
        }),
      ),
      (error: unknown) =>
        Schema.is(CodexErrors.CodexAppServerRequestError)(error) &&
        error.errorMessage === "timed out waiting for server",
    );
  });
});

describe("makeCodexCompactionStarter", () => {
  const threadId = ThreadId.make("thread-1");
  const rootThread = "provider-thread";
  const idle = { turnRunning: () => false };

  function makeClient(
    request: (
      method: string,
      payload?: unknown,
    ) => Effect.Effect<unknown, CodexErrors.CodexAppServerError>,
  ) {
    const calls: Array<{ readonly method: string; readonly payload: unknown }> = [];
    return {
      calls,
      client: {
        raw: {
          request: (method: string, payload?: unknown) => {
            calls.push({ method, payload });
            return request(method, payload);
          },
        },
      },
    };
  }

  it("adopts the root thread's turn that starts before Codex answers", async () => {
    let starter: ReturnType<typeof makeCodexCompactionStarter>;
    const { client, calls } = makeClient(() =>
      starter.turnStarted(rootThread, TurnId.make("turn-compact")).pipe(Effect.as({})),
    );
    starter = makeCodexCompactionStarter(client, idle);

    const turnId = await Effect.runPromise(
      starter.start({ threadId, providerThreadId: rootThread }),
    );

    assert.equal(turnId, "turn-compact");
    assert.deepStrictEqual(calls, [
      { method: "thread/compact/start", payload: { threadId: rootThread } },
    ]);
    assert.equal(starter.waiting(), false);
  });

  it("adopts the root thread's turn that starts after Codex answers", async () => {
    const turnId = await Effect.runPromise(
      Effect.gen(function* () {
        const answered = yield* Deferred.make<void>();
        const { client } = makeClient(() =>
          Deferred.succeed(answered, undefined).pipe(Effect.as({})),
        );
        const starter = makeCodexCompactionStarter(client, idle);
        const started = yield* starter
          .start({ threadId, providerThreadId: rootThread })
          .pipe(Effect.forkChild);
        yield* Deferred.await(answered);
        assert.equal(starter.waiting(), true);
        yield* starter.turnStarted(rootThread, TurnId.make("turn-late"));
        return yield* Fiber.join(started);
      }),
    );

    assert.equal(turnId, "turn-late");
  });

  it("never adopts a child thread's turn", async () => {
    let starter: ReturnType<typeof makeCodexCompactionStarter>;
    const { client } = makeClient(() =>
      starter
        .turnStarted("child-thread", TurnId.make("turn-child"))
        .pipe(
          Effect.andThen(starter.turnStarted(rootThread, TurnId.make("turn-root"))),
          Effect.as({}),
        ),
    );
    starter = makeCodexCompactionStarter(client, idle);

    const turnId = await Effect.runPromise(
      starter.start({ threadId, providerThreadId: rootThread }),
    );

    assert.equal(turnId, "turn-root");
  });

  it("fails without retrying when no compaction turn starts in time", async () => {
    let starter: ReturnType<typeof makeCodexCompactionStarter>;
    const { client, calls } = makeClient(() =>
      // A child's turn is not the compaction's.
      starter.turnStarted("child-thread", TurnId.make("turn-child")).pipe(Effect.as({})),
    );
    starter = makeCodexCompactionStarter(client, idle);

    const error = await Effect.runPromise(
      starter
        .start({ threadId, providerThreadId: rootThread, timeout: "20 millis" })
        .pipe(Effect.flip),
    );

    assert.ok(Schema.is(CodexSessionRuntimeCompactionNotStartedError)(error));
    assert.match(error.message, /^Codex did not start compaction: no compaction turn started/);
    assert.equal(calls.length, 1);
    assert.equal(starter.waiting(), false);
    // A turn that starts late is an ordinary turn now.
    await Effect.runPromise(starter.turnStarted(rootThread, TurnId.make("turn-late")));
  });

  it("drops the wait when Codex refuses the request", async () => {
    let refuse = true;
    let starter: ReturnType<typeof makeCodexCompactionStarter>;
    const { client, calls } = makeClient(() =>
      refuse
        ? Effect.fail(
            new CodexErrors.CodexAppServerRequestError({
              code: -32601,
              errorMessage: "Method not found",
            }),
          )
        : starter.turnStarted(rootThread, TurnId.make("turn-2")).pipe(Effect.as({})),
    );
    starter = makeCodexCompactionStarter(client, idle);

    const error = await Effect.runPromise(
      starter.start({ threadId, providerThreadId: rootThread }).pipe(Effect.flip),
    );
    assert.equal(error.message, "Codex did not start compaction: Method not found");
    assert.equal(calls.length, 1);
    assert.equal(starter.waiting(), false);

    // Nothing is left waiting, so the next compaction adopts its own turn.
    refuse = false;
    const turnId = await Effect.runPromise(
      starter.start({ threadId, providerThreadId: rootThread }),
    );
    assert.equal(turnId, "turn-2");
  });

  it("refuses a second compaction while one waits for its turn", async () => {
    const error = await Effect.runPromise(
      Effect.gen(function* () {
        const answered = yield* Deferred.make<void>();
        const { client } = makeClient(() =>
          Deferred.succeed(answered, undefined).pipe(Effect.as({})),
        );
        const starter = makeCodexCompactionStarter(client, idle);
        const first = yield* starter
          .start({ threadId, providerThreadId: rootThread })
          .pipe(Effect.forkChild);
        yield* Deferred.await(answered);
        const second = yield* Effect.flip(
          starter.start({ threadId, providerThreadId: rootThread }),
        );
        yield* starter.turnStarted(rootThread, TurnId.make("turn-first"));
        assert.equal(yield* Fiber.join(first), "turn-first");
        return second;
      }),
    );

    assert.equal(
      error.message,
      "Codex did not start compaction: another compaction is still starting.",
    );
  });

  it("refuses while a turn runs, without asking Codex", async () => {
    const { client, calls } = makeClient(() => Effect.succeed({}));
    const starter = makeCodexCompactionStarter(client, { turnRunning: () => true });

    const error = await Effect.runPromise(
      starter.start({ threadId, providerThreadId: rootThread }).pipe(Effect.flip),
    );

    assert.equal(
      error.message,
      "Codex did not start compaction: a turn is running. Compact once it finishes.",
    );
    assert.deepStrictEqual(calls, []);
    assert.equal(starter.waiting(), false);
  });

  it("refuses while a turn/start is on its way, and compacts once it returned", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        let starter: ReturnType<typeof makeCodexCompactionStarter>;
        const { client, calls } = makeClient(() =>
          starter.turnStarted(rootThread, TurnId.make("turn-compact")).pipe(Effect.as({})),
        );
        starter = makeCodexCompactionStarter(client, idle);
        const sending = yield* Deferred.make<void>();
        const answer = yield* Deferred.make<void>();
        const turnStart = yield* starter
          .sendingTurn(
            Deferred.succeed(sending, undefined).pipe(Effect.andThen(Deferred.await(answer))),
          )
          .pipe(Effect.forkChild);
        yield* Deferred.await(sending);

        const refused = yield* Effect.flip(
          starter.start({ threadId, providerThreadId: rootThread }),
        );
        const callsWhileSending = calls.length;
        yield* Deferred.succeed(answer, undefined);
        yield* Fiber.join(turnStart);
        const turnId = yield* starter.start({ threadId, providerThreadId: rootThread });
        return { refused, callsWhileSending, turnId };
      }),
    );

    assert.equal(
      result.refused.message,
      "Codex did not start compaction: a turn is running. Compact once it finishes.",
    );
    assert.equal(result.callsWhileSending, 0);
    assert.equal(result.turnId, "turn-compact");
  });

  it("holds a turn/start until the compaction's turn has started", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const answered = yield* Deferred.make<void>();
        const { client } = makeClient(() =>
          Deferred.succeed(answered, undefined).pipe(Effect.as({})),
        );
        const starter = makeCodexCompactionStarter(client, idle);
        const compacting = yield* starter
          .start({ threadId, providerThreadId: rootThread })
          .pipe(Effect.forkChild);
        yield* Deferred.await(answered);

        let sent = false;
        const turnStart = yield* starter
          .sendingTurn(
            Effect.sync(() => {
              sent = true;
            }),
          )
          .pipe(Effect.forkChild);
        for (let step = 0; step < 5; step += 1) yield* Effect.yieldNow;
        const sentWhileCompactionWaited = sent;

        yield* starter.turnStarted(rootThread, TurnId.make("turn-compact"));
        const turnId = yield* Fiber.join(compacting);
        yield* Fiber.join(turnStart);
        return { sentWhileCompactionWaited, turnId, sent };
      }),
    );

    assert.equal(result.sentWhileCompactionWaited, false);
    assert.equal(result.turnId, "turn-compact");
    assert.equal(result.sent, true);
  });

  it("lets a held turn/start go when the compaction fails", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const answered = yield* Deferred.make<void>();
        const { client } = makeClient(() =>
          Deferred.succeed(answered, undefined).pipe(Effect.as({})),
        );
        const starter = makeCodexCompactionStarter(client, idle);
        const compacting = yield* starter
          .start({ threadId, providerThreadId: rootThread, timeout: "20 millis" })
          .pipe(Effect.flip, Effect.forkChild);
        yield* Deferred.await(answered);
        const turnStart = yield* starter.sendingTurn(Effect.succeed("sent")).pipe(Effect.forkChild);
        const error = yield* Fiber.join(compacting);
        return { error, sent: yield* Fiber.join(turnStart) };
      }),
    );

    assert.match(result.error.message, /no compaction turn started/);
    assert.equal(result.sent, "sent");
  });
});

describe("revertCodexThread", () => {
  function makeRevertClient(input: {
    readonly revert?: (payload: unknown) => Effect.Effect<unknown, CodexErrors.CodexAppServerError>;
    readonly rollback?: (
      payload: CodexRpc.ClientRequestParamsByMethod["thread/rollback"],
    ) => Effect.Effect<
      CodexRpc.ClientRequestResponsesByMethod["thread/rollback"],
      CodexErrors.CodexAppServerError
    >;
  }) {
    const calls: Array<{ readonly method: string; readonly payload: unknown }> = [];
    const client = {
      raw: {
        request: (method: string, payload?: unknown) => {
          calls.push({ method, payload });
          return input.revert?.(payload) ?? Effect.succeed({ thread: { id: "provider-thread" } });
        },
      },
      request: (
        method: "thread/rollback",
        payload: CodexRpc.ClientRequestParamsByMethod["thread/rollback"],
      ) => {
        calls.push({ method, payload });
        return (
          input.rollback?.(payload) ??
          Effect.succeed({
            thread: { id: "provider-thread", turns: [] },
          } as unknown as CodexRpc.ClientRequestResponsesByMethod["thread/rollback"])
        );
      },
    };
    return { client, calls };
  }

  const unknownVariant = (method: string) =>
    new CodexErrors.CodexAppServerRequestError({
      code: -32600,
      errorMessage: `Invalid request: unknown variant \`${method}\``,
    });

  it("reverts before the first dropped turn with thread/revert", async () => {
    const { client, calls } = makeRevertClient({});
    const snapshot = await Effect.runPromise(
      revertCodexThread(client, {
        threadId: "provider-thread",
        beforeTurnId: "turn-2",
        numTurns: 1,
      }),
    );
    assert.deepStrictEqual(calls, [
      { method: "thread/revert", payload: { threadId: "provider-thread", beforeTurnId: "turn-2" } },
    ]);
    assert.deepStrictEqual(snapshot, { threadId: "provider-thread", turns: [] });
  });

  it("falls back to thread/rollback when thread/revert is unknown", async () => {
    const { client, calls } = makeRevertClient({
      revert: () => Effect.fail(unknownVariant("thread/revert")),
    });
    await Effect.runPromise(
      revertCodexThread(client, {
        threadId: "provider-thread",
        beforeTurnId: "turn-2",
        numTurns: 1,
      }),
    );
    assert.deepStrictEqual(
      calls.map((call) => call.method),
      ["thread/revert", "thread/rollback"],
    );
    assert.deepStrictEqual(calls[1]?.payload, { threadId: "provider-thread", numTurns: 1 });
  });

  it("reports the thread/revert error when thread/rollback is unknown too", async () => {
    const { client } = makeRevertClient({
      revert: () =>
        Effect.fail(
          new CodexErrors.CodexAppServerRequestError({
            code: -32602,
            errorMessage: "turn turn-2 is not in this thread's history",
          }),
        ),
      rollback: () => Effect.fail(unknownVariant("thread/rollback")),
    });
    const error = await Effect.runPromise(
      revertCodexThread(client, {
        threadId: "provider-thread",
        beforeTurnId: "turn-2",
        numTurns: 1,
      }).pipe(Effect.flip),
    );
    assert.equal(error.message, "turn turn-2 is not in this thread's history");
  });

  it("uses thread/rollback without a dropped turn id", async () => {
    const { client, calls } = makeRevertClient({});
    await Effect.runPromise(
      revertCodexThread(client, { threadId: "provider-thread", numTurns: 2 }),
    );
    assert.deepStrictEqual(calls, [
      { method: "thread/rollback", payload: { threadId: "provider-thread", numTurns: 2 } },
    ]);
  });

  it("explains a binary that can neither revert nor roll back", async () => {
    const { client } = makeRevertClient({
      rollback: () =>
        Effect.fail(
          new CodexErrors.CodexAppServerRequestError({
            code: -32601,
            errorMessage: "Method not found",
          }),
        ),
    });
    const error = await Effect.runPromise(
      revertCodexThread(client, { threadId: "provider-thread", numTurns: 1 }).pipe(Effect.flip),
    );
    assert.equal(error.message, "This Codex version can't rewind threads.");
  });
});
