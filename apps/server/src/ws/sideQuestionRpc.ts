import { Deferred, Effect, Option } from "effect";
import { TextGenerationError, WS_METHODS } from "@ryco/contracts";
import { defineWsHandlers, type WsRpcContext } from "./context.ts";

const error = (detail: string) => new TextGenerationError({ operation: "askSideQuestion", detail });

/** Instance lifetime is one authenticated websocket. Requests remain children of
 * RPC fibers so disconnect/revocation interrupts provider work automatically. */
export function makeSideQuestionRequests() {
  const active = new Map<string, Deferred.Deferred<never, TextGenerationError>>();
  const retired = new Map<string, number>();
  const prune = () => {
    const cutoff = Date.now() - 300_000;
    for (const [key, time] of retired) if (time < cutoff) retired.delete(key);
    while (retired.size > 256) retired.delete(retired.keys().next().value!);
  };
  const retire = (id: string) => {
    retired.set(id, Date.now());
    prune();
  };
  return {
    run: <A, E, R>(id: string, work: Effect.Effect<A, E, R>) =>
      Effect.acquireUseRelease(
        Effect.gen(function* () {
          const cancelled = yield* Deferred.make<never, TextGenerationError>();
          // Admission is atomic and masked until its release action is installed.
          prune();
          if (retired.has(id))
            return yield* Effect.fail(error("Side question was cancelled or already completed."));
          if (active.has(id))
            return yield* Effect.fail(error("Side question request is already running."));
          if (active.size >= 4)
            return yield* Effect.fail(error("Too many concurrent side questions."));
          active.set(id, cancelled);
          return cancelled;
        }),
        (cancelled) => Effect.raceFirst(work, Deferred.await(cancelled)),
        () =>
          Effect.sync(() => {
            active.delete(id);
            retire(id);
          }),
      ),
    cancel: (id: string) =>
      Effect.gen(function* () {
        retire(id);
        const cancelled = active.get(id);
        if (cancelled) yield* Deferred.fail(cancelled, error("Side question cancelled."));
        return {};
      }),
  };
}

export const makeSideQuestionHandlers = (ctx: WsRpcContext) => {
  const requests = makeSideQuestionRequests();
  return defineWsHandlers({
    [WS_METHODS.textGenerationAskSideQuestion]: (input) =>
      ctx.ownerEffect(
        WS_METHODS.textGenerationAskSideQuestion,
        requests.run(
          input.requestId,
          Effect.gen(function* () {
            const query = ctx.projectionSnapshotQuery;
            if (!query.getCompletedSideQuestionContext)
              return yield* Effect.fail(error("Thread history is unavailable."));
            const threadOption = yield* query
              .getThreadShellById(input.threadId)
              .pipe(Effect.mapError(() => error("Could not load thread.")));
            if (Option.isNone(threadOption))
              return yield* Effect.fail(error("Thread is unavailable."));
            const thread = threadOption.value;
            const completed = yield* query
              .getCompletedSideQuestionContext(input.threadId)
              .pipe(Effect.mapError(() => error("Could not load completed thread context.")));
            if (completed.messages.length > 200 || completed.activities.length > 200) {
              return yield* Effect.fail(
                error(
                  "Completed thread context exceeds the side chat limit (200 messages or activities).",
                ),
              );
            }
            const context = [
              ...completed.messages.map((message) => `${message.role}: ${message.text}`),
              ...completed.activities.map(
                (activity) => `activity (${activity.kind}): ${activity.summary}`,
              ),
            ].join("\n\n");
            if (context.length > 64_000)
              return yield* Effect.fail(
                error("Completed thread context exceeds the side chat limit (64,000 characters)."),
              );
            const project = yield* query
              .getProjectShellById(thread.projectId)
              .pipe(Effect.mapError(() => error("Could not load thread project.")));
            if (Option.isNone(project))
              return yield* Effect.fail(error("Thread project is unavailable."));
            if (
              input.history.reduce(
                (size, item) => size + item.question.length + item.answer.length,
                0,
              ) > 64_000
            ) {
              return yield* Effect.fail(
                error("Side question history exceeds 64,000 characters. Start a new side chat."),
              );
            }
            const result = yield* ctx.textGeneration.answerSideQuestion({
              cwd: thread.worktreePath ?? project.value.workspaceRoot,
              context,
              question: input.question,
              history: input.history,
              modelSelection: input.modelSelection,
            });
            return { requestId: input.requestId, answer: result.answer };
          }),
        ),
      ),
    [WS_METHODS.textGenerationCancelSideQuestion]: (input) =>
      ctx.ownerEffect(
        WS_METHODS.textGenerationCancelSideQuestion,
        requests.cancel(input.requestId),
      ),
  });
};
