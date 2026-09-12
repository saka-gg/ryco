import {
  ProviderInstanceId,
  ThreadId,
  TextGenerationError,
  WS_METHODS,
  type SideQuestionInput,
} from "@ryco/contracts";
import type { WsRpcContext } from "./context.ts";
import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Exit, Fiber, Option } from "effect";
import { makeSideQuestionHandlers, makeSideQuestionRequests } from "./sideQuestionRpc.ts";

describe("side question request isolation", () => {
  it.effect("cancels early without starting provider work", () =>
    Effect.gen(function* () {
      const requests = makeSideQuestionRequests();
      let started = false;
      yield* requests.cancel("early");
      const result = yield* Effect.exit(
        requests.run(
          "early",
          Effect.sync(() => {
            started = true;
          }),
        ),
      );
      expect(Exit.isFailure(result)).toBe(true);
      expect(started).toBe(false);
    }),
  );

  it.effect("cancels only its provider while another request and main turn continue", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const requests = makeSideQuestionRequests();
        const started = yield* Deferred.make<void>();
        const stopped = yield* Deferred.make<void>();
        const mainDone = yield* Deferred.make<string>();
        const main = yield* Deferred.await(mainDone).pipe(Effect.forkScoped);
        const side = yield* requests
          .run(
            "side",
            Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.ensuring(Deferred.succeed(stopped, undefined)),
            ),
          )
          .pipe(Effect.forkScoped);
        yield* Deferred.await(started);
        yield* requests.cancel("side");
        expect(Exit.isFailure(yield* Fiber.await(side))).toBe(true);
        yield* Deferred.await(stopped);
        expect(yield* requests.run("other", Effect.succeed("independent"))).toBe("independent");
        yield* Deferred.succeed(mainDone, "main completed");
        expect(yield* Fiber.join(main)).toBe("main completed");
      }),
    ),
  );

  it.effect("cleans up after failures and refuses replay on the same connection", () =>
    Effect.gen(function* () {
      const requests = makeSideQuestionRequests();
      expect(
        Exit.isFailure(yield* Effect.exit(requests.run("failed", Effect.fail("provider failed")))),
      ).toBe(true);
      expect(
        Exit.isFailure(yield* Effect.exit(requests.run("failed", Effect.succeed("replayed")))),
      ).toBe(true);
      expect(yield* requests.run("retry", Effect.succeed("recovered"))).toBe("recovered");
    }),
  );

  it.effect(
    "disconnect interrupts provider work and reconnect has independent request ownership",
    () =>
      Effect.gen(function* () {
        const requests = makeSideQuestionRequests();
        const started = yield* Deferred.make<void>();
        const stopped = yield* Deferred.make<void>();
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* requests
              .run(
                "old",
                Deferred.succeed(started, undefined).pipe(
                  Effect.andThen(Effect.never),
                  Effect.ensuring(Deferred.succeed(stopped, undefined)),
                ),
              )
              .pipe(Effect.forkScoped);
            yield* Deferred.await(started);
          }),
        );
        yield* Deferred.await(stopped);
        const reconnected = makeSideQuestionRequests();
        yield* requests.cancel("new");
        expect(yield* reconnected.run("new", Effect.succeed("new socket"))).toBe("new socket");
      }),
  );
});

describe("side question request admission", () => {
  it.effect("releases admission after repeated immediate interruption", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const requests = makeSideQuestionRequests();
        for (let index = 0; index < 40; index++) {
          const request = yield* requests
            .run(`interrupted-${index}`, Effect.never)
            .pipe(Effect.forkScoped);
          yield* Fiber.interrupt(request);
        }
        const release = yield* Deferred.make<void>();
        const admitted = yield* Effect.all(Array.from({ length: 4 }, () => Deferred.make<void>()));
        const requestsAfterInterruption = [];
        for (const [index, started] of admitted.entries()) {
          requestsAfterInterruption.push(
            yield* requests
              .run(
                `admitted-${index}`,
                Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(release))),
              )
              .pipe(Effect.forkScoped),
          );
          yield* Deferred.await(started);
        }
        yield* Deferred.succeed(release, undefined);
        for (const request of requestsAfterInterruption) yield* Fiber.join(request);
      }),
    ),
  );

  it.effect(
    "rejects duplicate IDs and limits concurrent work without interrupting admitted work",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const requests = makeSideQuestionRequests();
          const starters = yield* Effect.all(
            Array.from({ length: 4 }, () => Deferred.make<void>()),
          );
          for (const [index, started] of starters.entries()) {
            yield* requests
              .run(
                `request-${index}`,
                Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
              )
              .pipe(Effect.forkScoped);
            yield* Deferred.await(started);
          }
          let dispatched = false;
          const work = Effect.sync(() => {
            dispatched = true;
          });
          expect(Exit.isFailure(yield* Effect.exit(requests.run("request-0", work)))).toBe(true);
          expect(Exit.isFailure(yield* Effect.exit(requests.run("overflow", work)))).toBe(true);
          expect(dispatched).toBe(false);
          yield* requests.cancel("request-0");
        }),
      ),
  );
});

const questionInput: SideQuestionInput = {
  threadId: ThreadId.make("thread"),
  requestId: "question",
  question: "Why?",
  history: [],
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6" },
};
const handlerFixture = (
  options: {
    denied?: boolean;
    context?: Effect.Effect<{ messages: { role: string; text: string }[]; activities: never[] }>;
  } = {},
) => {
  let generations = 0;
  const ctx = {
    ownerEffect: (_method: string, work: Effect.Effect<unknown>) =>
      options.denied
        ? Effect.fail(new TextGenerationError({ operation: "authorization", detail: "Denied" }))
        : work,
    projectionSnapshotQuery: {
      getThreadShellById: () =>
        Effect.succeed(Option.some({ projectId: "project", worktreePath: null })),
      getProjectShellById: () => Effect.succeed(Option.some({ workspaceRoot: "/workspace" })),
      getCompletedSideQuestionContext: () =>
        options.context ?? Effect.succeed({ messages: [], activities: [] }),
    },
    textGeneration: {
      answerSideQuestion: () =>
        Effect.sync(() => {
          generations++;
          return { answer: "Answer" };
        }),
    },
  } as unknown as WsRpcContext;
  return { handlers: makeSideQuestionHandlers(ctx), generations: () => generations };
};

describe("side question RPC boundaries", () => {
  it.effect("owner authorization denial never starts generation", () =>
    Effect.gen(function* () {
      const fixture = handlerFixture({ denied: true });
      expect(
        Exit.isFailure(
          yield* Effect.exit(
            fixture.handlers[WS_METHODS.textGenerationAskSideQuestion](questionInput),
          ),
        ),
      ).toBe(true);
      expect(fixture.generations()).toBe(0);
    }),
  );
  it.effect("cancellation while context loads never starts generation", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const fixture = handlerFixture({
          context: Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
        });
        const pending = yield* fixture.handlers[WS_METHODS.textGenerationAskSideQuestion](
          questionInput,
        ).pipe(Effect.forkScoped);
        yield* Deferred.await(started);
        yield* fixture.handlers[WS_METHODS.textGenerationCancelSideQuestion]({
          requestId: questionInput.requestId,
        });
        expect(Exit.isFailure(yield* Fiber.await(pending))).toBe(true);
        expect(fixture.generations()).toBe(0);
      }),
    ),
  );
  it.effect("oversized history and completed context fail before provider dispatch", () =>
    Effect.gen(function* () {
      const oversizedHistory = handlerFixture();
      expect(
        Exit.isFailure(
          yield* Effect.exit(
            oversizedHistory.handlers[WS_METHODS.textGenerationAskSideQuestion]({
              ...questionInput,
              history: Array.from({ length: 3 }, () => ({
                question: "q",
                answer: "x".repeat(32_000),
              })),
            }),
          ),
        ),
      ).toBe(true);
      expect(oversizedHistory.generations()).toBe(0);
      for (const messages of [
        [{ role: "assistant", text: "x".repeat(64_001) }],
        Array.from({ length: 201 }, () => ({ role: "assistant", text: "x" })),
      ]) {
        const fixture = handlerFixture({ context: Effect.succeed({ messages, activities: [] }) });
        expect(
          Exit.isFailure(
            yield* Effect.exit(
              fixture.handlers[WS_METHODS.textGenerationAskSideQuestion](questionInput),
            ),
          ),
        ).toBe(true);
        expect(fixture.generations()).toBe(0);
      }
    }),
  );
});
