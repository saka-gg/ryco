import { assert, describe, it } from "@effect/vitest";
import {
  EventId,
  MessageId,
  type OrchestrationEvent,
  type OrchestrationThreadShell,
  ThreadId,
} from "@ryco/contracts";
import { Deferred, Effect, Fiber, Option, PubSub, Stream } from "effect";

import type { OrchestrationEngineShape } from "../../orchestration/Services/OrchestrationEngine.ts";
import type { ProjectionSnapshotQueryShape } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ORCHESTRATION_STREAM_CHUNK_MAX_BYTES } from "./constants.ts";
import { rechunkByBudget, splitByChunkBudget } from "../streamBatching.ts";
import { orchestrationEventBytes } from "./orchestrationStreamBatching.ts";
import { makeOrchestrationStreamHelpers } from "./orchestrationStreams.ts";

const THREAD = ThreadId.make("thread-batching");

const messageEvent = (sequence: number, threadId = THREAD, chars = 1_000): OrchestrationEvent => ({
  sequence,
  eventId: EventId.make(`event-batching-message-${sequence}`),
  aggregateKind: "thread",
  aggregateId: threadId,
  occurredAt: "2026-10-01T00:00:00.000Z",
  commandId: null,
  causationEventId: null,
  correlationId: null,
  metadata: {},
  type: "thread.message-sent",
  payload: {
    threadId,
    messageId: MessageId.make(`message-batching-${sequence}`),
    role: "assistant",
    text: "x".repeat(chars),
    turnId: null,
    streaming: false,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
  },
});

const deletedEvent = (sequence: number, threadId: ThreadId): OrchestrationEvent => ({
  sequence,
  eventId: EventId.make(`event-batching-deleted-${sequence}`),
  aggregateKind: "thread",
  aggregateId: threadId,
  occurredAt: "2026-10-01T00:00:00.000Z",
  commandId: null,
  causationEventId: null,
  correlationId: null,
  metadata: {},
  type: "thread.deleted",
  payload: { threadId, deletedAt: "2026-10-01T00:00:00.000Z" },
});

interface Harness {
  readonly stored: Array<OrchestrationEvent>;
  readonly live: PubSub.PubSub<OrchestrationEvent>;
  readonly pageReads: { count: number };
  readonly streamPageReads: { count: number };
  readonly shellReads: Array<ThreadId>;
  readonly probe: {
    anchored: boolean;
    eventsAfter: number;
    streamEventsAfter: number | null;
  };
}

const makeHarnessWith = (options: {
  readonly getProjectShellById?: ProjectionSnapshotQueryShape["getProjectShellById"];
  /** Serve thread replay through the stream index, counting reads in `streamPageReads`. */
  readonly streamPages?: boolean;
}) =>
  Effect.gen(function* () {
    const harness: Harness = {
      stored: [],
      live: yield* PubSub.unbounded<OrchestrationEvent>(),
      pageReads: { count: 0 },
      streamPageReads: { count: 0 },
      shellReads: [],
      probe: { anchored: true, eventsAfter: 0, streamEventsAfter: 0 },
    };
    const orchestrationEngine = {
      readEventsPage: (fromSequenceExclusive: number, limit: number) =>
        Effect.sync(() => {
          harness.pageReads.count += 1;
          const after = harness.stored.filter((event) => event.sequence > fromSequenceExclusive);
          const events = after.slice(0, limit);
          return {
            events,
            nextSequence: events.at(-1)?.sequence ?? fromSequenceExclusive,
            hasMore: after.length > limit,
          };
        }),
      subscribeDomainEvents: Effect.map(PubSub.subscribe(harness.live), Stream.fromSubscription),
    } as unknown as OrchestrationEngineShape;
    const projectionSnapshotQuery = {
      getThreadShellById: (threadId: ThreadId) =>
        Effect.sync(() => {
          harness.shellReads.push(threadId);
          return Option.some({ id: threadId } as unknown as OrchestrationThreadShell);
        }),
      getProjectShellById: options.getProjectShellById ?? (() => Effect.succeed(Option.none())),
      getWorktreeShellById: () => Effect.succeed(Option.none()),
    } as unknown as ProjectionSnapshotQueryShape;
    const helpers = makeOrchestrationStreamHelpers({
      orchestrationEngine,
      projectionSnapshotQuery,
      repositoryIdentityResolver: { resolve: () => Effect.succeed(null) },
      probeResume: () => Effect.sync(() => ({ ...harness.probe })),
      ...(options.streamPages === true
        ? {
            readStreamEventsPage: (input: {
              readonly streamId: string;
              readonly fromSequenceExclusive: number;
              readonly limit: number;
            }) =>
              Effect.sync(() => {
                harness.streamPageReads.count += 1;
                const after = harness.stored.filter(
                  (event) =>
                    event.aggregateId === input.streamId &&
                    event.sequence > input.fromSequenceExclusive,
                );
                const events = after.slice(0, input.limit);
                return {
                  events,
                  nextSequence: events.at(-1)?.sequence ?? input.fromSequenceExclusive,
                  hasMore: after.length > input.limit,
                };
              }),
          }
        : {}),
    });
    return { harness, helpers };
  });

const makeHarness = makeHarnessWith({});

const neverSnapshot = Effect.die("a resumed subscription must not load a snapshot");

/** The arrays an RPC server would write as chunks: one per emitted array. */
const collectChunks = <A, E>(stream: Stream.Stream<A, E>, items: number) =>
  Effect.gen(function* () {
    const chunks: Array<ReadonlyArray<A>> = [];
    yield* stream.pipe(
      Stream.take(items),
      Stream.runForEachArray((values) => Effect.sync(() => chunks.push([...values]))),
    );
    return chunks;
  });

describe("splitByChunkBudget", () => {
  it("keeps a batch within budget as the same array", () => {
    const items = [1, 2, 3] as const;
    const groups = splitByChunkBudget(items, { maxItems: 3 });
    assert.equal(groups.length, 1);
    assert.strictEqual(groups[0], items);
  });

  it("splits by count and by bytes, keeping order and sending an oversized item alone", () => {
    assert.deepEqual(splitByChunkBudget([1, 2, 3, 4, 5], { maxItems: 2 }), [[1, 2], [3, 4], [5]]);
    assert.deepEqual(
      splitByChunkBudget([10, 10, 50, 10, 10, 10], {
        maxItems: 100,
        maxBytes: 25,
        sizeOf: (item) => item,
      }),
      [[10, 10], [50], [10, 10], [10]],
    );
  });

  it.effect("re-chunks a stream without merging its arrays", () =>
    Effect.gen(function* () {
      const chunks = yield* collectChunks(
        Stream.fromArrays([1, 2, 3, 4, 5], [6]).pipe(rechunkByBudget({ maxItems: 2 })),
        6,
      );
      assert.deepEqual(chunks, [[1, 2], [3, 4], [5], [6]]);
    }),
  );
});

describe("orchestration stream chunking", () => {
  it.effect("replays N thread events in byte-bounded chunks, not one chunk per event", () =>
    Effect.gen(function* () {
      const { harness, helpers } = yield* makeHarness;
      for (let sequence = 11; sequence <= 1_010; sequence += 1) {
        harness.stored.push(messageEvent(sequence));
      }
      harness.probe.streamEventsAfter = 1_000;
      harness.probe.eventsAfter = 1_000;

      const chunks = yield* collectChunks(
        helpers.makeReplayableThreadStream(neverSnapshot, THREAD, { resumeFromSequence: 10 }),
        1_001,
      );

      const totalBytes = harness.stored.reduce(
        (total, event) => total + orchestrationEventBytes(event),
        0,
      );
      const head = chunks[0]!;
      assert.deepEqual(head, [{ kind: "resumed", fromSequence: 10 }]);
      const eventChunks = chunks.slice(1);
      assert.isAtMost(
        eventChunks.length,
        Math.ceil(totalBytes / ORCHESTRATION_STREAM_CHUNK_MAX_BYTES) + 1,
      );
      assert.isAbove(eventChunks.length, 1);
      for (const chunk of eventChunks) {
        const bytes = chunk.reduce(
          (total, item) => total + ("event" in item ? orchestrationEventBytes(item.event) : 0),
          0,
        );
        assert.isAtMost(bytes, ORCHESTRATION_STREAM_CHUNK_MAX_BYTES);
      }
      const sequences = eventChunks
        .flat()
        .map((item) => ("event" in item ? item.event.sequence : 0));
      assert.deepEqual(
        sequences,
        harness.stored.map((event) => event.sequence),
      );
      // The resume decision read no event page; only the replay did.
      assert.equal(harness.pageReads.count, 1);
    }),
  );

  it.effect("re-reads each thread row once per replayed batch, at its last event", () =>
    Effect.gen(function* () {
      const { harness, helpers } = yield* makeHarness;
      const other = ThreadId.make("thread-batching-other");
      for (let sequence = 11; sequence <= 510; sequence += 1) {
        harness.stored.push(messageEvent(sequence, THREAD, 10));
      }
      harness.stored.push(deletedEvent(511, other));
      harness.probe.eventsAfter = 501;

      const chunks = yield* collectChunks(
        helpers.makeReplayableShellStream(neverSnapshot, { resumeFromSequence: 10 }),
        3,
      );

      const items = chunks.flat();
      assert.deepEqual(
        items.map((item) => [item.kind, "sequence" in item ? item.sequence : null]),
        [
          ["resumed", null],
          ["thread-upserted", 510],
          ["thread-removed", 511],
        ],
      );
      assert.deepEqual(harness.shellReads, [THREAD]);
      assert.equal(chunks.length, 2);
    }),
  );

  it.live("drains a live backlog that queued during one acknowledgement as one chunk", () =>
    Effect.gen(function* () {
      const { harness, helpers } = yield* makeHarness;
      const release = yield* Deferred.make<void>();
      const chunks: Array<number> = [];
      const fiber = yield* helpers
        .makeReplayableThreadStream(neverSnapshot, THREAD, { resumeFromSequence: 10 })
        .pipe(
          Stream.take(201),
          // The head waits like a chunk awaiting its client acknowledgement.
          Stream.runForEachArray((values) =>
            Effect.sync(() => chunks.push(values.length)).pipe(
              Effect.andThen(chunks.length === 1 ? Deferred.await(release) : Effect.void),
            ),
          ),
          Effect.forkChild,
        );
      yield* Effect.sleep("20 millis");
      for (let sequence = 11; sequence <= 210; sequence += 1) {
        yield* PubSub.publish(harness.live, messageEvent(sequence, THREAD, 10));
      }
      yield* Effect.sleep("20 millis");
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(fiber);

      assert.equal(chunks[0], 1);
      assert.equal(
        chunks.slice(1).reduce((total, size) => total + size, 0),
        200,
      );
      assert.isAtMost(chunks.length - 1, 2);
    }),
  );
});

describe("resume decisions", () => {
  it.effect("resumes an idle thread on its own backlog while other threads stream", () =>
    Effect.gen(function* () {
      const { harness, helpers } = yield* makeHarness;
      harness.stored.push(messageEvent(11));
      harness.probe.eventsAfter = 3_000;
      harness.probe.streamEventsAfter = 1;

      const chunks = yield* collectChunks(
        helpers.makeReplayableThreadStream(neverSnapshot, THREAD, { resumeFromSequence: 10 }),
        1,
      );
      assert.deepEqual(chunks[0], [{ kind: "resumed", fromSequence: 10 }]);
    }),
  );

  it.effect("sends a snapshot when the thread itself missed more than a replay page", () =>
    Effect.gen(function* () {
      const { harness, helpers } = yield* makeHarness;
      harness.probe.eventsAfter = 1_001;
      harness.probe.streamEventsAfter = 1_001;
      const snapshot = { snapshotSequence: 2_000 };

      const chunks = yield* collectChunks(
        helpers.makeReplayableThreadStream(Effect.succeed(snapshot), THREAD, {
          resumeFromSequence: 10,
        }),
        1,
      );
      assert.deepEqual(chunks[0], [{ kind: "snapshot", snapshot }]);
    }),
  );

  it.effect("replays a resumed thread through its own stream, whatever the global backlog", () =>
    Effect.gen(function* () {
      const { harness, helpers } = yield* makeHarnessWith({ streamPages: true });
      const other = ThreadId.make("thread-other");
      for (let sequence = 11; sequence <= 20; sequence += 1) {
        harness.stored.push(messageEvent(sequence, sequence === 15 ? THREAD : other));
      }
      // Far past the global scan bound: a scan of global pages would refuse.
      harness.probe.eventsAfter = 100_000;
      harness.probe.streamEventsAfter = 1;

      const chunks = yield* collectChunks(
        helpers.makeReplayableThreadStream(neverSnapshot, THREAD, { resumeFromSequence: 10 }),
        2,
      );
      assert.deepEqual(chunks[0], [{ kind: "resumed", fromSequence: 10 }]);
      assert.deepEqual(
        chunks
          .slice(1)
          .flat()
          .map((item) => (item as { event: OrchestrationEvent }).event.sequence),
        [15],
      );
      assert.equal(harness.pageReads.count, 0);
      assert.equal(harness.streamPageReads.count, 1);
    }),
  );

  it.effect("keeps the shell on the global backlog", () =>
    Effect.gen(function* () {
      const { harness, helpers } = yield* makeHarness;
      harness.probe.eventsAfter = 1_001;
      const snapshot = {
        snapshotSequence: 2_000,
        projects: [],
        threads: [],
        updatedAt: "2026-10-01T00:00:00.000Z",
      };

      const chunks = yield* collectChunks(
        helpers.makeReplayableShellStream(Effect.succeed(snapshot), { resumeFromSequence: 10 }),
        1,
      );
      assert.deepEqual(chunks[0], [{ kind: "snapshot", snapshot }]);
    }),
  );
});

describe("project event enrichment", () => {
  it.effect("takes the repository identity from the projected row, never from git", () =>
    Effect.gen(function* () {
      const repositoryIdentity = { canonicalKey: "github.com/acme/app" } as never;
      const { helpers } = yield* makeHarnessWith({
        getProjectShellById: () => Effect.succeed(Option.some({ repositoryIdentity } as never)),
      });
      const created = {
        sequence: 1,
        eventId: EventId.make("event-project-created"),
        aggregateKind: "project",
        aggregateId: "project-1",
        occurredAt: "2026-10-12T00:00:00.000Z",
        commandId: null,
        causationEventId: null,
        correlationId: null,
        metadata: {},
        type: "project.created",
        payload: { projectId: "project-1", workspaceRoot: "/repo" },
      } as unknown as OrchestrationEvent;

      const [enriched] = yield* helpers.enrichOrchestrationEvents([created]);
      assert.deepEqual((enriched as { readonly payload: unknown }).payload, {
        projectId: "project-1",
        workspaceRoot: "/repo",
        repositoryIdentity,
      });
    }),
  );
});
