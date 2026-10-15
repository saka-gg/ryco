import { assert, describe, it } from "@effect/vitest";
import {
  EventId,
  type OrchestrationArchivedThreadStub,
  type OrchestrationEvent,
  type OrchestrationShellSnapshot,
  type OrchestrationShellStreamItem,
  type OrchestrationStubbedShellSnapshot,
  type OrchestrationThreadShell,
  ThreadId,
} from "@ryco/contracts";
import { Effect, Fiber, Option, PubSub, Stream } from "effect";

import type { OrchestrationEngineShape } from "../../orchestration/Services/OrchestrationEngine.ts";
import type { ProjectionSnapshotQueryShape } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { makeOrchestrationStreamHelpers } from "./orchestrationStreams.ts";

const NOW = "2026-10-15T00:00:00.000Z";

const shell = (id: string, archivedAt: string | null): OrchestrationThreadShell =>
  ({
    id: ThreadId.make(id),
    projectId: "project-1",
    title: id,
    modelSelection: { instanceId: "codex", model: "gpt-5-codex" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    goal: null,
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt,
    settledOverride: null,
    settledAt: null,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
  }) as unknown as OrchestrationThreadShell;

const stub = (id: string): OrchestrationArchivedThreadStub =>
  ({
    id: ThreadId.make(id),
    projectId: "project-1",
    title: id,
    branch: null,
    worktreePath: null,
    worktreeId: null,
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: NOW,
    latestUserMessageAt: null,
    lineage: null,
  }) as unknown as OrchestrationArchivedThreadStub;

const fullSnapshot: OrchestrationShellSnapshot = {
  snapshotSequence: 20,
  projects: [],
  threads: [shell("live", null), shell("archived", NOW)],
  updatedAt: NOW,
};
const stubbedSnapshot: OrchestrationStubbedShellSnapshot = {
  snapshotSequence: 20,
  projects: [],
  threads: [shell("live", null)],
  archivedThreadStubs: [stub("archived")],
  updatedAt: NOW,
};

const threadEvent = (
  sequence: number,
  type: "thread.archived" | "thread.unarchived",
  threadId: string,
): OrchestrationEvent =>
  ({
    sequence,
    eventId: EventId.make(`event-stub-${sequence}`),
    aggregateKind: "thread",
    aggregateId: ThreadId.make(threadId),
    occurredAt: NOW,
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    type,
    payload:
      type === "thread.archived"
        ? { threadId, archivedAt: NOW, updatedAt: NOW }
        : { threadId, updatedAt: NOW },
  }) as unknown as OrchestrationEvent;

const makeHelpers = (options: {
  readonly rows?: Map<string, OrchestrationThreadShell>;
  readonly threadPriorityChanges?: Stream.Stream<void>;
}) =>
  Effect.gen(function* () {
    const live = yield* PubSub.unbounded<OrchestrationEvent>();
    const stored: Array<OrchestrationEvent> = [];
    const orchestrationEngine = {
      readEventsPage: (fromSequenceExclusive: number, limit: number) =>
        Effect.sync(() => {
          const after = stored.filter((event) => event.sequence > fromSequenceExclusive);
          const events = after.slice(0, limit);
          return {
            events,
            nextSequence: events.at(-1)?.sequence ?? fromSequenceExclusive,
            hasMore: after.length > limit,
          };
        }),
      subscribeDomainEvents: PubSub.subscribe(live),
    } as unknown as OrchestrationEngineShape;
    const projectionSnapshotQuery = {
      getThreadShellById: (threadId: ThreadId) =>
        Effect.succeed(Option.fromNullishOr(options.rows?.get(threadId))),
      getProjectShellById: () => Effect.succeed(Option.none()),
      getWorktreeShellById: () => Effect.succeed(Option.none()),
    } as unknown as ProjectionSnapshotQueryShape;
    const helpers = makeOrchestrationStreamHelpers({
      orchestrationEngine,
      projectionSnapshotQuery,
      repositoryIdentityResolver: { resolve: () => Effect.succeed(null) },
      ...(options.threadPriorityChanges === undefined
        ? {}
        : { threadPriorityChanges: options.threadPriorityChanges }),
    });
    return { helpers, live, stored };
  });

const take = <E>(stream: Stream.Stream<OrchestrationShellStreamItem, E>, items: number) =>
  stream.pipe(
    Stream.take(items),
    Stream.runCollect,
    Effect.map((chunk) => Array.from(chunk)),
  );

const kindsOf = (items: ReadonlyArray<OrchestrationShellStreamItem>) =>
  items.map((item) => item.kind);

describe("archived thread stubs in the shell stream", () => {
  it.effect("sends stub pages to a paged subscriber that asked for them", () =>
    Effect.gen(function* () {
      const { helpers } = yield* makeHelpers({});
      const items = yield* take(
        helpers.makeReplayableShellStream(Effect.die("the stubbed build is the only load"), {
          snapshotDelivery: "paged",
          stubbedSnapshot: Effect.succeed(stubbedSnapshot),
        }),
        4,
      );
      assert.deepEqual(kindsOf(items), [
        "snapshot-begin",
        "snapshot-threads",
        "snapshot-archived-threads",
        "snapshot-end",
      ]);
      const begin = items[0];
      assert(begin?.kind === "snapshot-begin");
      assert.equal(begin.threadCount, 2);
      assert.equal(begin.archivedThreadCount, 1);
      const stubs = items[2];
      assert(stubs?.kind === "snapshot-archived-threads");
      assert.deepEqual(stubs.threads, [stub("archived")]);
    }),
  );

  it.effect("sends full archived shells to a subscriber that did not ask (an older client)", () =>
    Effect.gen(function* () {
      const { helpers } = yield* makeHelpers({});
      const items = yield* take(
        helpers.makeReplayableShellStream(Effect.succeed(fullSnapshot), {
          snapshotDelivery: "paged",
        }),
        3,
      );
      assert.deepEqual(kindsOf(items), ["snapshot-begin", "snapshot-threads", "snapshot-end"]);
      const page = items[1];
      assert(page?.kind === "snapshot-threads");
      assert.deepEqual(
        page.threads.map((thread) => [thread.id, thread.archivedAt]),
        [
          ["live", null],
          ["archived", NOW],
        ],
      );
    }),
  );

  it.effect("never sends stubs in a single snapshot item, which every client decodes", () =>
    Effect.gen(function* () {
      const { helpers } = yield* makeHelpers({});
      const items = yield* take(
        helpers.makeReplayableShellStream(Effect.succeed(fullSnapshot), {
          stubbedSnapshot: Effect.die("stubs travel paged only"),
        }),
        1,
      );
      assert.deepEqual(items, [{ kind: "snapshot", snapshot: fullSnapshot }]);
    }),
  );

  it.live("sends full shells when a stub subscriber's thread is archived or unarchived", () =>
    Effect.gen(function* () {
      const rows = new Map([["archived", shell("archived", NOW)]]);
      const { helpers, live } = yield* makeHelpers({ rows });
      const fiber = yield* take(
        helpers.makeReplayableShellStream(Effect.die("unused"), {
          snapshotDelivery: "paged",
          stubbedSnapshot: Effect.succeed(stubbedSnapshot),
        }),
        6,
      ).pipe(Effect.forkChild);
      yield* Effect.sleep("20 millis");
      // Unarchive: the row now reads unarchived; archive again: archived.
      rows.set("archived", shell("archived", null));
      yield* PubSub.publish(live, threadEvent(21, "thread.unarchived", "archived"));
      yield* Effect.sleep("300 millis");
      rows.set("archived", shell("archived", NOW));
      yield* PubSub.publish(live, threadEvent(22, "thread.archived", "archived"));
      const items = yield* Fiber.join(fiber);
      const upserts = items.filter((item) => item.kind === "thread-upserted");
      assert.deepEqual(
        upserts.map((item) =>
          item.kind === "thread-upserted" ? [item.sequence, item.thread.archivedAt] : null,
        ),
        [
          [21, null],
          [22, NOW],
        ],
      );
      // Full shells, never stubs, on the live path.
      for (const item of upserts) {
        assert(item.kind === "thread-upserted");
        assert.property(item.thread, "modelSelection");
      }
    }),
  );

  it.live("a ranking reloads each shell form in its own shared load", () =>
    Effect.gen(function* () {
      const changes = yield* PubSub.unbounded<void>();
      const { helpers } = yield* makeHelpers({ threadPriorityChanges: Stream.fromPubSub(changes) });
      let fullLoads = 0;
      let stubbedLoads = 0;
      const full = Effect.sync(() => {
        fullLoads += 1;
        return fullSnapshot;
      });
      const stubbed = Effect.sync(() => {
        stubbedLoads += 1;
        return stubbedSnapshot;
      });
      const subscribe = (asksForStubs: boolean) =>
        take(
          helpers.makeReplayableShellStream(full, {
            snapshotDelivery: "paged",
            ...(asksForStubs ? { stubbedSnapshot: stubbed } : {}),
          }),
          // Snapshot pages, then the ranking's pages.
          asksForStubs ? 8 : 6,
        ).pipe(Effect.forkChild);
      const stubSubscribers = [yield* subscribe(true), yield* subscribe(true)];
      const fullSubscriber = yield* subscribe(false);
      yield* Effect.sleep("20 millis");
      assert.equal(stubbedLoads, 2);
      assert.equal(fullLoads, 1);
      yield* PubSub.publish(changes, undefined);
      for (const fiber of stubSubscribers) {
        const items = yield* Fiber.join(fiber);
        assert.deepEqual(kindsOf(items.slice(4)), [
          "snapshot-begin",
          "snapshot-threads",
          "snapshot-archived-threads",
          "snapshot-end",
        ]);
      }
      const fullItems = yield* Fiber.join(fullSubscriber);
      assert.deepEqual(kindsOf(fullItems.slice(3)), [
        "snapshot-begin",
        "snapshot-threads",
        "snapshot-end",
      ]);
      // One shared load per form for the ranking.
      assert.equal(stubbedLoads, 3);
      assert.equal(fullLoads, 2);
    }),
  );
});
