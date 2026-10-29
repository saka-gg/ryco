import {
  ThreadPriorityBatchId,
  type ThreadPriorityEnsureCurrentInput,
  WS_METHODS,
} from "@ryco/contracts";
import { it } from "@effect/vitest";
import { Effect, Option, Stream } from "effect";
import { expect } from "vite-plus/test";

import type { ThreadPriorityCoordinatorShape } from "../threadPriority/ThreadPriorityCoordinator.ts";
import type { WsRpcContext } from "./context.ts";
import { makeOrchestrationHandlers } from "./orchestrationRpc.ts";

it.effect("authorizes and forwards only the decoded force flag to priority coordination", () =>
  Effect.gen(function* () {
    const received: ThreadPriorityEnsureCurrentInput[] = [];
    const coordinator: ThreadPriorityCoordinatorShape = {
      ensureCurrent: (input) =>
        Effect.sync(() => {
          received.push(input);
          return {
            batchId: ThreadPriorityBatchId.make("rpc-priority-batch"),
            disposition: "ranked" as const,
            freshness: {
              rankedAt: "2026-08-25T12:00:00.000Z",
              usableUntil: "2026-08-26T12:00:00.000Z",
              checkedAt: "2026-08-25T12:00:00.000Z",
            },
          };
        }),
      changes: Stream.empty,
    };
    const ctx = {
      ownerEffect: <A, E, R>(_method: string, effect: Effect.Effect<A, E, R>) => effect,
      threadPriorityCoordinator: Option.some(coordinator),
    } as unknown as WsRpcContext;
    const handlers = makeOrchestrationHandlers(ctx);
    const handler = handlers[WS_METHODS.threadPriorityEnsureCurrent] as (
      input: ThreadPriorityEnsureCurrentInput,
    ) => Effect.Effect<unknown>;

    yield* handler({ force: true });
    expect(received).toEqual([{ force: true }]);
  }),
);
