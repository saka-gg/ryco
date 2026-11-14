import { assert, describe, it } from "@effect/vitest";
import {
  EventId,
  ProviderDriverKind,
  type ProviderRuntimeEvent,
  RuntimeSessionId,
  ThreadId,
  TurnId,
} from "@ryco/contracts";
import { Effect } from "effect";

import type { AcpSessionRuntimeShape } from "../acp/AcpSessionRuntime.ts";
import type { AcpAdapterExtensionContext, AcpUserInputResolution } from "./AcpAdapter.ts";
import { cursorAskQuestionAnswers, registerCursorExtensions } from "./CursorAdapter.ts";

type Handler = (params: unknown) => Effect.Effect<unknown>;

const threadId = ThreadId.make("cursor-extension-thread");
const turnId = TurnId.make("cursor-extension-turn");

function makeHarness(resolution: AcpUserInputResolution) {
  const handlers = new Map<string, Handler>();
  const emitted: Array<ProviderRuntimeEvent> = [];
  const logged: Array<{ method: string; payload: unknown }> = [];
  const planUpdates: Array<Parameters<AcpAdapterExtensionContext["emitPlanUpdate"]>[0]> = [];
  const userInputRequests: Array<Parameters<AcpAdapterExtensionContext["requestUserInput"]>[0]> =
    [];
  const register = (method: string, _schema: unknown, handler: Handler) =>
    Effect.sync(() => {
      handlers.set(method, handler);
    });
  const runtime = {
    handleExtRequest: register,
    handleExtNotification: register,
  } as unknown as AcpSessionRuntimeShape;
  const context: AcpAdapterExtensionContext = {
    runtime,
    threadId,
    runtimeSessionId: RuntimeSessionId.make("cursor-extension-runtime"),
    logNative: (method, payload) => Effect.sync(() => void logged.push({ method, payload })),
    emit: (event) => Effect.sync(() => void emitted.push(event)),
    makeEventStamp: () =>
      Effect.succeed({ eventId: EventId.make("event-1"), createdAt: "2026-11-14T00:00:00.000Z" }),
    activeTurnId: () => turnId,
    emitPlanUpdate: (input) => Effect.sync(() => void planUpdates.push(input)),
    requestUserInput: (input) =>
      Effect.sync(() => {
        userInputRequests.push(input);
        return resolution;
      }),
  };
  const call = (method: string, params: unknown) => {
    const handler = handlers.get(method);
    assert.isDefined(handler, `no handler for ${method}`);
    return handler!(params);
  };
  return { context, handlers, emitted, logged, planUpdates, userInputRequests, call };
}

const askQuestionParams = {
  toolCallId: "ask-1",
  title: "Question",
  questions: [
    {
      id: "scope",
      prompt: "Which scope?",
      options: [{ id: "workspace", label: "Workspace" }],
    },
  ],
};

describe("cursorAskQuestionAnswers", () => {
  it("passes a person's answers through", () => {
    assert.deepStrictEqual(
      cursorAskQuestionAnswers({ _tag: "answered", answers: { scope: "workspace" } }),
      { scope: "workspace" },
    );
  });

  it("answers a cancelled question with no answers", () => {
    assert.deepStrictEqual(cursorAskQuestionAnswers({ _tag: "cancelled" }), {});
  });
});

describe("registerCursorExtensions", () => {
  it.effect("registers Cursor's three extension methods", () =>
    Effect.gen(function* () {
      const harness = makeHarness({ _tag: "cancelled" });
      yield* registerCursorExtensions(harness.context);
      assert.deepStrictEqual([...harness.handlers.keys()].toSorted(), [
        "cursor/ask_question",
        "cursor/create_plan",
        "cursor/update_todos",
      ]);
    }),
  );

  it.effect("asks the person and returns their answers to Cursor", () =>
    Effect.gen(function* () {
      const harness = makeHarness({ _tag: "answered", answers: { scope: "workspace" } });
      yield* registerCursorExtensions(harness.context);
      const response = yield* harness.call("cursor/ask_question", askQuestionParams);

      assert.deepStrictEqual(response, { answers: { scope: "workspace" } });
      assert.deepStrictEqual(harness.logged, [
        { method: "cursor/ask_question", payload: askQuestionParams },
      ]);
      assert.equal(harness.userInputRequests.length, 1);
      const request = harness.userInputRequests[0]!;
      assert.deepStrictEqual(request.raw, {
        source: "acp.cursor.extension",
        method: "cursor/ask_question",
        payload: askQuestionParams,
      });
      // Cursor's resolved event never carried the native request.
      assert.equal(request.rawOnResolved, false);
      assert.equal(request.questions.length, 1);
    }),
  );

  it.effect("tells Cursor no answers when the question was cancelled", () =>
    Effect.gen(function* () {
      const harness = makeHarness({ _tag: "cancelled" });
      yield* registerCursorExtensions(harness.context);
      const response = yield* harness.call("cursor/ask_question", askQuestionParams);
      assert.deepStrictEqual(response, { answers: {} });
    }),
  );

  it.effect("turns a proposed plan into turn.proposed.completed for the active turn", () =>
    Effect.gen(function* () {
      const harness = makeHarness({ _tag: "cancelled" });
      yield* registerCursorExtensions(harness.context);
      const params = { toolCallId: "plan-1", plan: "# Plan\n\n- step", todos: [] };
      const response = yield* harness.call("cursor/create_plan", params);

      assert.deepStrictEqual(response, { accepted: true });
      assert.deepStrictEqual(harness.emitted, [
        {
          type: "turn.proposed.completed",
          eventId: EventId.make("event-1"),
          createdAt: "2026-11-14T00:00:00.000Z",
          provider: ProviderDriverKind.make("cursor"),
          threadId,
          turnId,
          payload: { planMarkdown: "# Plan\n\n- step" },
          raw: { source: "acp.cursor.extension", method: "cursor/create_plan", payload: params },
        },
      ]);
    }),
  );

  it.effect("turns Cursor's todo list into a plan update", () =>
    Effect.gen(function* () {
      const harness = makeHarness({ _tag: "cancelled" });
      yield* registerCursorExtensions(harness.context);
      const params = {
        toolCallId: "todos-1",
        merge: false,
        todos: [{ id: "1", content: "Write the test", status: "in_progress" }],
      };
      yield* harness.call("cursor/update_todos", params);

      assert.equal(harness.planUpdates.length, 1);
      const update = harness.planUpdates[0]!;
      assert.equal(update.source, "acp.cursor.extension");
      assert.equal(update.method, "cursor/update_todos");
      assert.equal(update.rawPayload, params);
      assert.deepStrictEqual(
        update.payload.plan.map((step) => step.step),
        ["Write the test"],
      );
    }),
  );
});
