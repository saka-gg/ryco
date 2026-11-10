/**
 * attentionPublisherLive - Starts the node's push alert publisher beside an
 * enrolled Hub connector and feeds it domain events (`docs/push-alerts.md`).
 *
 * Kept apart from `HubConnectorLive` so that module only gains one call: the
 * publisher, its sealing and its client-runtime projector load with the
 * connector, never on the boot path.
 *
 * @module push/attentionPublisherLive
 */
import { mapThreadShellSummary, mapWorktreeShellSummary } from "@ryco/client-runtime/state/threads";
import type { EnvironmentId } from "@ryco/contracts";
import { isThreadSnoozed } from "@ryco/shared/threadSnooze";
import { Effect, Option, Stream } from "effect";
import * as SqlClient from "effect/sql/SqlClient";

import type { HubConnector } from "../hubConnector/HubConnector.ts";
import type { HubIdentityRuntimeShape } from "../hubConnector/HubIdentityRuntime.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { readAlertExcerpt } from "./alertExcerptSource.ts";
import { startAttentionPublisher } from "./attentionPublisher.ts";
import { makeActivitySignalSender, makeAttentionSignalSender } from "./attentionSignalHttp.ts";
import type { NodePushRegistryShape } from "./NodePushRegistry.ts";

/** Runs in the connector's scope; does nothing without a shell or an engine. */
export const startNodeAttentionPublisher = (input: {
  readonly hubOrigin: string;
  readonly identity: HubIdentityRuntimeShape;
  readonly connector: HubConnector;
  readonly registry: NodePushRegistryShape;
}) =>
  Effect.gen(function* () {
    const query = yield* Effect.serviceOption(ProjectionSnapshotQuery);
    const engine = yield* Effect.serviceOption(OrchestrationEngineService);
    if (Option.isNone(query) || Option.isNone(engine)) return;
    const sql = yield* Effect.serviceOption(SqlClient.SqlClient);
    const push = input.registry;
    const shell = query.value;
    const abort = new AbortController();
    const run = <A, E>(effect: Effect.Effect<A, E>) =>
      Effect.runPromise(effect, { signal: abort.signal });
    const sender = {
      hubOrigin: input.hubOrigin,
      identity: input.identity,
      connector: input.connector,
      signal: abort.signal,
    };
    const publisher = yield* Effect.acquireRelease(
      Effect.sync(() =>
        startAttentionPublisher({
          environmentId: async () => {
            const state = await input.identity.readState();
            return state.activeNode?.hubOrigin === input.hubOrigin ? state.environmentId : null;
          },
          isConnectorOnline: () => input.connector.status().state === "online",
          readShell: async () => {
            const snapshot = await run(shell.getShellSnapshot());
            // The environment id is set by the publisher; rows only need their own fields.
            const environmentId = "" as EnvironmentId;
            return {
              sequence: snapshot.snapshotSequence,
              threads: snapshot.threads.map((thread) =>
                mapThreadShellSummary(thread, environmentId),
              ),
              worktrees: (snapshot.worktrees ?? []).map((worktree) =>
                mapWorktreeShellSummary(worktree, environmentId),
              ),
              autoSettleAfterDays: snapshot.settlementPolicy?.autoSettleAfterDays,
            };
          },
          readThread: async (environmentId, threadId) => {
            const row = await run(shell.getThreadShellById(threadId).pipe(Effect.option));
            return Option.isSome(row) && Option.isSome(row.value)
              ? mapThreadShellSummary(row.value.value, environmentId)
              : null;
          },
          isSnoozed: isThreadSnoozed,
          readExcerpt: Option.isNone(sql)
            ? undefined
            : (excerpt) =>
                run(
                  readAlertExcerpt(excerpt).pipe(
                    Effect.provideService(SqlClient.SqlClient, sql.value),
                  ),
                ),
          registrations: () => run(push.list),
          foregroundEnrollments: (nowMs) => run(push.foregroundEnrollments(nowMs)),
          reserveSequence: () => run(push.reserveSequence),
          removeEnrollments: (enrollmentIds) => run(push.removeEnrollments(enrollmentIds)),
          setHubDelivery: (delivery) => {
            void run(push.setHubDelivery(delivery));
          },
          send: makeAttentionSignalSender(sender),
          sendActivity: makeActivitySignalSender(sender),
          onRegistrationsChanged: push.onChange,
          now: Date.now,
          setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
          clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
          reportFailure: (message, error) => {
            void Effect.runPromise(Effect.logWarning(message, { error: String(error ?? "") }));
          },
        }),
      ),
      (active) =>
        Effect.promise(async () => {
          abort.abort();
          await active.stop();
        }),
    );
    const changes = yield* engine.value.subscribeDomainEvents;
    yield* changes.pipe(
      Stream.runForEach((event) =>
        Effect.sync(() => {
          if (event.aggregateKind !== "thread") return;
          const threadId = event.aggregateId as Parameters<typeof publisher.threadChanged>[0];
          if (event.type === "thread.deleted" || event.type === "thread.trashed") {
            publisher.threadRemoved(threadId, event.sequence);
          } else {
            publisher.threadChanged(threadId, event.sequence);
          }
        }),
      ),
      Effect.forkScoped,
    );
  });
