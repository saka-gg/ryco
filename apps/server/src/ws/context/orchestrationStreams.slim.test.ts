import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  type OrchestrationEvent,
  OrchestrationThreadWindowStreamItem,
  ThreadId,
  TurnId,
} from "@ryco/contracts";
import { Effect, PubSub, Queue, Schema, Stream } from "effect";
import { deflateRawSync } from "node:zlib";

import type { OrchestrationEngineShape } from "../../orchestration/Services/OrchestrationEngine.ts";
import type { ProjectionSnapshotQueryShape } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { WEBSOCKET_PER_MESSAGE_DEFLATE } from "../../webSocketCompression.ts";
import { makeOrchestrationStreamHelpers } from "./orchestrationStreams.ts";

const threadId = ThreadId.make("4f1c2a7e-8a0b-4c1d-9e2f-3a4b5c6d7e8f");
const turnId = TurnId.make("9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d");
const messageId = MessageId.make("assistant:0b1c2d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e");

/** A streamed assistant delta as provider ingestion writes it. */
const deltaEvent = (sequence: number): OrchestrationEvent => {
  const commandId = CommandId.make(`provider:${crypto.randomUUID()}:assistant-delta:${messageId}`);
  return {
    sequence,
    eventId: EventId.make(crypto.randomUUID()),
    aggregateKind: "thread",
    aggregateId: threadId,
    occurredAt: "2026-11-10T12:00:00.000Z",
    commandId,
    causationEventId: null,
    correlationId: commandId,
    metadata: {
      providerTurnId: "turn_8c2d1e0f9a8b7c6d",
      adapterKey: "claude",
      ingestedAt: "2026-11-10T12:00:00.000Z",
    },
    type: "thread.message-sent",
    payload: {
      threadId,
      messageId,
      role: "assistant",
      text: "The quick brown fox jumps over the lazy dog, then ",
      turnId,
      streaming: true,
      createdAt: "2026-11-10T12:00:00.000Z",
      updatedAt: "2026-11-10T12:00:00.000Z",
    },
  };
};

const startFeed = (liveEventForm: "full" | "slim" | undefined) =>
  Effect.gen(function* () {
    const live = yield* PubSub.unbounded<OrchestrationEvent>();
    const helpers = makeOrchestrationStreamHelpers({
      orchestrationEngine: {
        subscribeDomainEvents: Effect.map(PubSub.subscribe(live), Stream.fromSubscription),
        readEventsPage: (fromSequenceExclusive: number) =>
          Effect.succeed({ events: [], nextSequence: fromSequenceExclusive, hasMore: false }),
      } as unknown as OrchestrationEngineShape,
      projectionSnapshotQuery: {} as unknown as ProjectionSnapshotQueryShape,
      repositoryIdentityResolver: { resolve: () => Effect.succeed(null) },
    });
    const items = yield* Queue.unbounded<{ readonly kind: string; readonly event?: unknown }>();
    yield* helpers
      .makeReplayableThreadStream(Effect.succeed({ snapshotSequence: 10 }), threadId, {
        ...(liveEventForm === undefined ? {} : { liveEventForm }),
      })
      .pipe(
        Stream.runForEach((item) => Queue.offer(items, item)),
        Effect.forkChild,
      );
    assert.equal((yield* Queue.take(items)).kind, "snapshot");
    return { live, items };
  });

const encodeItem = Schema.encodeSync(OrchestrationThreadWindowStreamItem);
const decodeItem = Schema.decodeUnknownSync(OrchestrationThreadWindowStreamItem);

/** A live frame as the socket sends it: one RPC chunk, deflated on its own above the threshold. */
const wireBytes = (values: ReadonlyArray<unknown>) => {
  const json = JSON.stringify({ _tag: "Chunk", requestId: "4711", values: values.map(encodeItem) });
  return {
    raw: Buffer.byteLength(json),
    deflated:
      json.length >= WEBSOCKET_PER_MESSAGE_DEFLATE.threshold
        ? deflateRawSync(json, { level: 1 }).length
        : Buffer.byteLength(json),
  };
};

describe("slim live thread events", () => {
  it.effect("sends slim items only to subscribers that asked, and they decode", () =>
    Effect.gen(function* () {
      for (const form of [undefined, "full" as const]) {
        const { live, items } = yield* startFeed(form);
        const event = deltaEvent(11);
        yield* PubSub.publish(live, event);
        const item = yield* Queue.take(items);
        assert.equal(item.kind, "event");
        assert.strictEqual(item.event, event);
      }

      const { live, items } = yield* startFeed("slim");
      const event = deltaEvent(11);
      yield* PubSub.publish(live, event);
      const item = yield* Queue.take(items);
      assert.deepEqual(item, {
        kind: "slim-event",
        event: {
          sequence: 11,
          occurredAt: event.occurredAt,
          type: event.type,
          payload: event.payload,
        },
      });
      // The item round-trips through the wire schema a client decodes.
      assert.deepEqual(decodeItem(JSON.parse(JSON.stringify(encodeItem(item as never)))), item);
    }),
  );

  it.effect("measures live frames: bytes of streamed deltas full and slim", () =>
    Effect.gen(function* () {
      const lines: Array<string> = [];
      for (const count of [1, 4, 16]) {
        const events = Array.from({ length: count }, (_, index) => deltaEvent(100 + index));
        const full = wireBytes(events.map((event) => ({ kind: "event", event })));
        const slim = wireBytes(
          events.map((event) => ({
            kind: "slim-event",
            event: {
              sequence: event.sequence,
              occurredAt: event.occurredAt,
              type: event.type,
              payload: event.payload,
            },
          })),
        );
        lines.push(
          `${count} delta(s) per frame: full ${full.raw} B raw / ${full.deflated} B sent, slim ${slim.raw} B raw / ${slim.deflated} B sent`,
        );
        assert.isBelow(slim.raw, full.raw * 0.6);
      }
      console.info(`[B6] ${lines.join("; ")}`);
    }),
  );
});
