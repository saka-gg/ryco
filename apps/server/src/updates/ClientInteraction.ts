/**
 * ClientInteraction - when a person last used a client of this node.
 *
 * Clients of a node with `automaticUpdates` on report input with `server.noteClientInteraction`
 * (at most every 30 s while there is input), and unattended updates wait until nobody has for a
 * while (`updateWindow.ts`). Times are on the monotonic clock, so time asleep and wall-clock jumps
 * never count as quiet. A session's reports count at most once per
 * {@link CLIENT_INTERACTION_MIN_INTERVAL}: a client can make the node write one timestamp, nothing
 * more, and the timestamp can only delay an update.
 *
 * @module ClientInteraction
 */
import { Clock, Context, Duration, Effect, Layer } from "effect";

/** Reports from one session closer together than this are dropped. */
export const CLIENT_INTERACTION_MIN_INTERVAL = Duration.seconds(15);
const MIN_INTERVAL_NANOS = Duration.toNanosUnsafe(CLIENT_INTERACTION_MIN_INTERVAL);
/** Sessions the rate limit remembers; the longest-quiet one is forgotten first. */
const MAX_TRACKED_SESSIONS = 256;

export interface ClientInteractionShape {
  /** A person used a client on the session `sessionKey` names. */
  readonly note: (sessionKey: string) => Effect.Effect<void>;
  /** Time since the last counted report, or since this server started while none came. */
  readonly sinceLast: Effect.Effect<Duration.Duration>;
}

export class ClientInteraction extends Context.Service<ClientInteraction, ClientInteractionShape>()(
  "ryco/updates/ClientInteraction",
) {}

export const makeClientInteraction = Effect.gen(function* () {
  let lastNanos = yield* Clock.monotonicTimeNanos;
  const countedAt = new Map<string, bigint>();
  return {
    note: (sessionKey) =>
      Effect.map(Clock.monotonicTimeNanos, (now) => {
        const previous = countedAt.get(sessionKey);
        if (previous !== undefined && now - previous < MIN_INTERVAL_NANOS) return;
        // Re-inserted, so the map stays ordered from the longest-quiet session.
        countedAt.delete(sessionKey);
        countedAt.set(sessionKey, now);
        if (countedAt.size > MAX_TRACKED_SESSIONS) {
          countedAt.delete(countedAt.keys().next().value!);
        }
        if (now > lastNanos) lastNanos = now;
      }),
    sinceLast: Effect.map(Clock.monotonicTimeNanos, (now) =>
      Duration.nanos(now > lastNanos ? now - lastNanos : 0n),
    ),
  } satisfies ClientInteractionShape;
});

export const ClientInteractionLive = Layer.effect(ClientInteraction, makeClientInteraction);
