import * as fs from "node:fs";
import * as path from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, assert } from "@effect/vitest";
import { type ProviderEvent, RuntimeMode, RuntimeSessionId, ThreadId } from "@ryco/contracts";
import { Deferred, Duration, Effect, Ref, Stream } from "effect";
import fixture from "../testFixtures/codexMultiAgentWire.json" with { type: "json" };
import { makeCodexSessionRuntime } from "./CodexSessionRuntime.ts";

const root = fixture.rootThreadId;
const turnId = "elicitation-turn";

/** What OpenAI's Computer Use plugin sends before it acts in TextEdit. */
const computerUseParams = {
  threadId: root,
  turnId,
  serverName: "node_repl",
  mode: "form",
  message: 'Allow Computer Use to use "TextEdit"?',
  requestedSchema: { type: "object", properties: {} },
  _meta: {
    codex_approval_kind: "mcp_tool_call",
    connector_id: "computer-use",
    connector_name: "Computer Use",
    persist: ["session", "always"],
    tool_params: { app: "com.apple.TextEdit" },
    tool_params_display: [{ name: "app", display_name: "App", value: "TextEdit" }],
  },
};

interface Harness {
  readonly runtime: Effect.Success<ReturnType<typeof makeCodexSessionRuntime>>;
  /** The first event with this method, once it arrives. */
  readonly waitForEvent: (method: string) => Effect.Effect<ProviderEvent>;
  /** The first answer the peer received from Ryco. */
  readonly response: Effect.Effect<Record<string, unknown>>;
  readonly events: Effect.Effect<ReadonlyArray<ProviderEvent>>;
}

const startHarness = (input: {
  readonly name: string;
  readonly runtimeMode: RuntimeMode;
  readonly serverRequests: ReadonlyArray<Record<string, unknown>>;
  readonly elicitationTimeout?: Duration.Input;
  readonly completeTurn?: boolean;
}) =>
  Effect.gen(function* () {
    const scriptPath = path.join(
      import.meta.dirname,
      `../testFixtures/.elicitation-${input.name}.json`,
    );
    fs.writeFileSync(
      scriptPath,
      JSON.stringify({
        rootThreadId: root,
        holdTurnOpen: input.completeTurn !== true,
        turnIds: [turnId],
        notifications: [],
        serverRequests: input.serverRequests,
      }),
    );
    yield* Effect.addFinalizer(() => Effect.sync(() => fs.rmSync(scriptPath, { force: true })));
    const runtime = yield* makeCodexSessionRuntime({
      threadId: ThreadId.make(`elicitation-${input.name}`),
      runtimeSessionId: RuntimeSessionId.make(`elicitation-runtime-${input.name}`),
      binaryPath: path.join(import.meta.dirname, "../testFixtures/codexCollabMockPeer.sh"),
      cwd: "/tmp",
      runtimeMode: input.runtimeMode,
      tokenMode: "balanced",
      environment: { ...process.env, RYCO_CODEX_COLLAB_SCRIPT: scriptPath },
      ...(input.elicitationTimeout ? { elicitationTimeout: input.elicitationTimeout } : {}),
    });
    const seen = yield* Ref.make<ReadonlyArray<ProviderEvent>>([]);
    const firsts = new Map<string, Deferred.Deferred<ProviderEvent>>();
    const first = (method: string) =>
      Effect.sync(() => {
        const existing = firsts.get(method);
        if (existing) return existing;
        const created = Deferred.makeUnsafe<ProviderEvent>();
        firsts.set(method, created);
        return created;
      });
    yield* runtime.events.pipe(
      Stream.runForEach((event) =>
        Ref.update(seen, (current) => [...current, event]).pipe(
          Effect.andThen(first(event.method)),
          Effect.flatMap((deferred) => Deferred.succeed(deferred, event)),
        ),
      ),
      Effect.forkScoped,
    );
    const waitForEvent = (method: string) => first(method).pipe(Effect.flatMap(Deferred.await));
    const response = waitForEvent("item/agentMessage/delta").pipe(
      Effect.map((event) => JSON.parse(event.textDelta ?? "{}") as Record<string, unknown>),
    );
    yield* runtime.start();
    yield* runtime.sendTurn({ input: "Open TextEdit" });
    return { runtime, waitForEvent, response, events: Ref.get(seen) } satisfies Harness;
  });

it.live("shows Computer Use's app approval as a question and answers with the choice", () =>
  Effect.gen(function* () {
    const { runtime, waitForEvent, response } = yield* startHarness({
      name: "answer",
      runtimeMode: "auto-accept-edits",
      serverRequests: [
        { id: 7, method: "mcpServer/elicitation/request", params: computerUseParams },
      ],
    });
    const request = yield* waitForEvent("mcpServer/elicitation/request");
    assert.equal(request.kind, "request");
    assert.equal(request.turnId, turnId);
    const questions = (request.payload as { questions: Array<Record<string, unknown>> }).questions;
    assert.equal(questions[0]?.header, "Codex Computer Use");
    assert.equal(questions[0]?.question, 'Allow Computer Use to use "TextEdit"?');

    yield* runtime.respondToUserInput(request.requestId!, { decision: "Always allow" });
    const answer = yield* response;
    assert.deepEqual(answer, {
      id: 7,
      result: { action: "accept", _meta: { persist: "always" } },
    });
    const answered = yield* waitForEvent("mcpServer/elicitation/request/answered");
    assert.deepEqual(answered.payload, {
      answers: { decision: "Always allow" },
      action: "accept",
    });
    const again = yield* runtime
      .respondToUserInput(request.requestId!, { decision: "Deny" })
      .pipe(Effect.result);
    assert.equal(again._tag, "Failure");
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.live("rejects an invalid form answer and keeps the question open", () =>
  Effect.gen(function* () {
    const { runtime, waitForEvent, response } = yield* startHarness({
      name: "form",
      runtimeMode: "full-access",
      serverRequests: [
        {
          id: "form-1",
          method: "mcpServer/elicitation/request",
          params: {
            threadId: root,
            turnId,
            serverName: "tickets",
            mode: "form",
            message: "How many?",
            requestedSchema: {
              type: "object",
              required: ["count"],
              properties: { count: { type: "integer" } },
            },
          },
        },
      ],
    });
    // Full access never answers a request for data itself.
    const request = yield* waitForEvent("mcpServer/elicitation/request");
    const invalid = yield* runtime
      .respondToUserInput(request.requestId!, { "field:count": "many" })
      .pipe(Effect.result);
    assert.equal(invalid._tag, "Failure");
    yield* runtime.respondToUserInput(request.requestId!, { "field:count": "3" });
    const answer = yield* response;
    assert.deepEqual(answer, { id: "form-1", result: { action: "accept", content: { count: 3 } } });
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.live("full access allows a Computer Use app for this chat without asking", () =>
  Effect.gen(function* () {
    const { response, events } = yield* startHarness({
      name: "full-access",
      runtimeMode: "full-access",
      serverRequests: [
        { id: 3, method: "mcpServer/elicitation/request", params: computerUseParams },
      ],
    });
    const answer = yield* response;
    assert.deepEqual(answer, {
      id: 3,
      result: { action: "accept", _meta: { persist: "session" } },
    });
    const shown = (yield* events).filter((event) => event.method.startsWith("mcpServer/"));
    assert.deepEqual(shown, []);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.live("answers cancel when nobody answers in time and closes the question", () =>
  Effect.gen(function* () {
    const { response, waitForEvent } = yield* startHarness({
      name: "timeout",
      runtimeMode: "approval-required",
      elicitationTimeout: Duration.millis(100),
      serverRequests: [
        { id: 4, method: "mcpServer/elicitation/request", params: computerUseParams },
      ],
    });
    const answer = yield* response;
    assert.deepEqual(answer, { id: 4, result: { action: "cancel" } });
    const answered = yield* waitForEvent("mcpServer/elicitation/request/answered");
    assert.deepEqual(answered.payload, { answers: {}, action: "cancel", cancelled: true });
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.live("closes the question when Codex stops waiting for it", () =>
  Effect.gen(function* () {
    const { runtime, waitForEvent } = yield* startHarness({
      name: "resolved",
      runtimeMode: "approval-required",
      serverRequests: [
        {
          id: 5,
          method: "mcpServer/elicitation/request",
          params: computerUseParams,
          resolveAfterMs: 150,
        },
      ],
    });
    const request = yield* waitForEvent("mcpServer/elicitation/request");
    const answered = yield* waitForEvent("mcpServer/elicitation/request/answered");
    assert.equal(answered.requestId, request.requestId);
    assert.deepEqual(answered.payload, { answers: {}, action: "cancel", cancelled: true });
    const late = yield* runtime
      .respondToUserInput(request.requestId!, { decision: "Allow once" })
      .pipe(Effect.result);
    assert.equal(late._tag, "Failure");
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.live("answers cancel at once for a schema Ryco cannot show", () =>
  Effect.gen(function* () {
    const { response } = yield* startHarness({
      name: "unsupported",
      runtimeMode: "approval-required",
      serverRequests: [
        {
          id: 6,
          method: "mcpServer/elicitation/request",
          params: {
            threadId: root,
            serverName: "s",
            mode: "openai/form",
            message: "Pick a file",
            requestedSchema: { type: "object", properties: { file: { type: "file" } } },
          },
        },
      ],
    });
    const answer = yield* response;
    assert.deepEqual(answer, { id: 6, result: { action: "cancel" } });
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.live("closes the question when its turn ends", () =>
  Effect.gen(function* () {
    const { response, waitForEvent } = yield* startHarness({
      name: "turn-ended",
      runtimeMode: "auto-accept-edits",
      completeTurn: true,
      serverRequests: [
        { id: 8, method: "mcpServer/elicitation/request", params: computerUseParams },
      ],
    });
    const answered = yield* waitForEvent("mcpServer/elicitation/request/answered");
    assert.deepEqual(answered.payload, { answers: {}, action: "cancel", cancelled: true });
    const answer = yield* response;
    assert.deepEqual(answer, { id: 8, result: { action: "cancel" } });
  }).pipe(Effect.provide(NodeServices.layer)),
);
