import { assert, describe, it } from "@effect/vitest";
import {
  EventId,
  type OrchestrationEvent,
  type OrchestrationThreadActivity,
  ThreadId,
  TurnId,
} from "@ryco/contracts";
import { Effect, PubSub, Queue, Stream } from "effect";

import {
  jsonByteLength,
  TOOL_ACTIVITY_PREVIEW_MAX_BYTES,
} from "../../orchestration/activityPayloadPreview.ts";
import type { OrchestrationEngineShape } from "../../orchestration/Services/OrchestrationEngine.ts";
import type { ProjectionSnapshotQueryShape } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { makeOrchestrationStreamHelpers } from "./orchestrationStreams.ts";

const threadId = ThreadId.make("thread-live-preview");
const turnId = TurnId.make("turn-live-preview");

/** A command's output as tool activities carry it: up to 16,000 characters per text field. */
const commandOutput = (chars: number) =>
  Array.from({ length: Math.ceil(chars / 80) }, (_, line) =>
    `${String(line).padStart(5, "0")} ${"build output line with some realistic text ".repeat(2)}`.slice(
      0,
      79,
    ),
  )
    .join("\n")
    .slice(0, chars);

const toolActivityEvent = (input: {
  readonly sequence: number;
  readonly kind: "tool.started" | "tool.updated" | "tool.completed";
  readonly activityId: string;
  readonly outputChars: number;
}): OrchestrationEvent => ({
  sequence: input.sequence,
  eventId: EventId.make(`event-${input.sequence}`),
  aggregateKind: "thread",
  aggregateId: threadId,
  occurredAt: "2026-11-10T00:00:00.000Z",
  commandId: null,
  causationEventId: null,
  correlationId: null,
  metadata: {},
  type: "thread.activity-appended",
  payload: {
    threadId,
    activity: {
      id: EventId.make(input.activityId),
      tone: "tool",
      kind: input.kind,
      summary: "Run command",
      payload: {
        itemType: "command_execution",
        status: input.kind === "tool.completed" ? "completed" : "inProgress",
        providerItemId: `item-${input.activityId}`,
        detail: "bun run build",
        data: {
          item: {
            command: "bun run build",
            ...(input.outputChars > 0
              ? { aggregatedOutput: commandOutput(input.outputChars) }
              : {}),
            ...(input.kind === "tool.completed" ? { exitCode: 0 } : {}),
          },
        },
      },
      turnId,
      createdAt: "2026-11-10T00:00:00.000Z",
    },
  },
});

/**
 * A turn that runs five commands with large output: each starts, streams its
 * output in three coalesced updates and completes with all of it.
 */
const largeOutputTurn = (firstSequence: number): ReadonlyArray<OrchestrationEvent> => {
  const events: Array<OrchestrationEvent> = [];
  let sequence = firstSequence;
  for (let command = 0; command < 5; command += 1) {
    const id = `activity-command-${command}`;
    events.push(
      toolActivityEvent({
        sequence: sequence++,
        kind: "tool.started",
        activityId: `${id}-start`,
        outputChars: 0,
      }),
    );
    for (const chars of [4_000, 9_000, 16_000]) {
      events.push(
        toolActivityEvent({
          sequence: sequence++,
          kind: "tool.updated",
          activityId: id,
          outputChars: chars,
        }),
      );
    }
    events.push(
      toolActivityEvent({
        sequence: sequence++,
        kind: "tool.completed",
        activityId: `${id}-done`,
        outputChars: 16_000,
      }),
    );
  }
  return events;
};

const activityOf = (event: OrchestrationEvent): OrchestrationThreadActivity => {
  if (event.type !== "thread.activity-appended") throw new Error(`unexpected ${event.type}`);
  return event.payload.activity;
};

/**
 * A thread window subscription over an in-memory event feed whose replay
 * pages serve `replayed` after the snapshot at sequence 10.
 */
const startFeed = (options: {
  readonly liveActivityPayloads?: "full" | "preview";
  readonly replayed?: ReadonlyArray<OrchestrationEvent>;
}) =>
  Effect.gen(function* () {
    const live = yield* PubSub.unbounded<OrchestrationEvent>();
    const replayed = options.replayed ?? [];
    const helpers = makeOrchestrationStreamHelpers({
      orchestrationEngine: {
        subscribeDomainEvents: Effect.map(PubSub.subscribe(live), Stream.fromSubscription),
        readEventsPage: (fromSequenceExclusive: number) => {
          const events = replayed.filter((event) => event.sequence > fromSequenceExclusive);
          return Effect.succeed({
            events,
            nextSequence: events.at(-1)?.sequence ?? fromSequenceExclusive,
            hasMore: false,
          });
        },
      } as unknown as OrchestrationEngineShape,
      projectionSnapshotQuery: {} as unknown as ProjectionSnapshotQueryShape,
      repositoryIdentityResolver: { resolve: () => Effect.succeed(null) },
    });
    const delivered = yield* Queue.unbounded<OrchestrationEvent>();
    const head = yield* Queue.unbounded<string>();
    yield* helpers
      .makeReplayableThreadStream(Effect.succeed({ snapshotSequence: 10 }), threadId, {
        ...(options.liveActivityPayloads === undefined
          ? {}
          : { liveActivityPayloads: options.liveActivityPayloads }),
      })
      .pipe(
        Stream.runForEach((item) =>
          item.kind === "event" ? Queue.offer(delivered, item.event) : Queue.offer(head, item.kind),
        ),
        Effect.forkChild,
      );
    assert.equal(yield* Queue.take(head), "snapshot");
    return { live, delivered };
  });

const takeN = (queue: Queue.Queue<OrchestrationEvent>, count: number) =>
  Effect.forEach(Array.from({ length: count }), () => Queue.take(queue));

describe("live activity previews", () => {
  it.effect("sends large live tool payloads as previews to subscribers that asked", () =>
    Effect.gen(function* () {
      const { live, delivered } = yield* startFeed({ liveActivityPayloads: "preview" });
      const small = toolActivityEvent({
        sequence: 11,
        kind: "tool.started",
        activityId: "small",
        outputChars: 0,
      });
      const large = toolActivityEvent({
        sequence: 12,
        kind: "tool.completed",
        activityId: "large",
        outputChars: 16_000,
      });
      yield* PubSub.publish(live, small);
      yield* PubSub.publish(live, large);
      const [sentSmall, sentLarge] = yield* takeN(delivered, 2);

      // A payload within its budget passes through untouched.
      assert.strictEqual(sentSmall, small);
      const activity = activityOf(sentLarge!);
      const fullBytes = jsonByteLength(activityOf(large).payload);
      assert.deepEqual(activity.payloadPreview, { fullBytes });
      assert.isAtMost(jsonByteLength(activity.payload), TOOL_ACTIVITY_PREVIEW_MAX_BYTES);
      // Everything but the payload is the event as stored.
      assert.equal(sentLarge!.sequence, 12);
      assert.equal(activity.id, activityOf(large).id);
      assert.equal(activity.kind, "tool.completed");
      assert.deepEqual(
        (activity.payload as { data: { item: { exitCode: number } } }).data.item.exitCode,
        0,
      );
    }),
  );

  it.effect("keeps full live payloads for subscribers that did not ask (older clients)", () =>
    Effect.gen(function* () {
      for (const mode of [undefined, "full" as const]) {
        const { live, delivered } = yield* startFeed(
          mode === undefined ? {} : { liveActivityPayloads: mode },
        );
        const large = toolActivityEvent({
          sequence: 11,
          kind: "tool.completed",
          activityId: "large",
          outputChars: 16_000,
        });
        yield* PubSub.publish(live, large);
        const [sent] = yield* takeN(delivered, 1);
        assert.strictEqual(sent, large);
      }
    }),
  );

  it.effect("previews replayed activity events too", () =>
    Effect.gen(function* () {
      const replayed = [
        toolActivityEvent({
          sequence: 11,
          kind: "tool.completed",
          activityId: "replayed",
          outputChars: 16_000,
        }),
      ];
      const { delivered } = yield* startFeed({ liveActivityPayloads: "preview", replayed });
      const [sent] = yield* takeN(delivered, 1);
      assert.equal(sent!.sequence, 11);
      assert.isDefined(activityOf(sent!).payloadPreview);
    }),
  );

  it.effect("measures a large-output turn: bytes sent with and without live previews", () =>
    Effect.gen(function* () {
      const turn = largeOutputTurn(11);
      const measure = (mode: "full" | "preview") =>
        Effect.gen(function* () {
          const { live, delivered } = yield* startFeed({ liveActivityPayloads: mode });
          for (const event of turn) yield* PubSub.publish(live, event);
          const sent = yield* takeN(delivered, turn.length);
          return sent.reduce((bytes, event) => bytes + jsonByteLength({ kind: "event", event }), 0);
        });
      const full = yield* measure("full");
      const preview = yield* measure("preview");
      // Five commands with 16,000 characters of output each: about 250 KB as
      // stored, about a fifth of that as previews.
      console.info(
        `[B2] large-output turn: ${turn.length} events, ${full} bytes full, ${preview} bytes previewed (${((preview / full) * 100).toFixed(1)} %)`,
      );
      assert.isBelow(preview, full * 0.35);
    }),
  );
});
