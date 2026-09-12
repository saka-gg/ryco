import {
  AGENT_CONTROL_QUEUE_ACTIVE_LIMIT_DEFAULT,
  AGENT_CONTROL_QUEUE_ACTIVE_LIMIT_MAX,
  AGENT_CONTROL_QUEUE_RECENT_LIMIT_DEFAULT,
  AGENT_CONTROL_QUEUE_RECENT_LIMIT_MAX,
  type AgentControlProposalQueue,
} from "@ryco/contracts";
import { Duration, Effect, Layer, Option, Schedule, Stream } from "effect";

import { AgentControlPolicy } from "../Services/AgentControlPolicy.ts";
import { AgentControlProposalEvents } from "../Services/AgentControlProposalEvents.ts";
import {
  AgentControlProposalService,
  toAgentControlProposalReceipt,
  type AgentControlProposalServiceShape,
  type DecideAgentControlProposalRequest,
} from "../Services/AgentControlProposalService.ts";
import { AgentControlProposalStore } from "../Services/AgentControlProposalStore.ts";
import type { AgentControlProposalDecision } from "../Services/AgentControlProposalStore.ts";

const DEFAULT_EXPIRY_SWEEP_INTERVAL_MS = 30_000;

/** Upper bound on proposals expired per sweep pass; overdue backlogs larger
 * than this converge across consecutive passes. */
export const AGENT_CONTROL_EXPIRY_SWEEP_BATCH_LIMIT = 100;

export interface AgentControlProposalServiceLiveOptions {
  readonly expirySweepIntervalMs?: number;
  /** Disable the periodic sweep fiber (tests drive sweeps explicitly). */
  readonly disablePeriodicExpirySweep?: boolean;
}

const clampLimit = (value: number | undefined, fallback: number, max: number): number =>
  value === undefined || !Number.isFinite(value) || value < 1
    ? fallback
    : Math.min(Math.floor(value), max);

const makeAgentControlProposalService = (options?: AgentControlProposalServiceLiveOptions) =>
  Effect.gen(function* () {
    const store = yield* AgentControlProposalStore;
    const policy = yield* AgentControlPolicy;
    const events = yield* AgentControlProposalEvents;

    const expireOverdue: AgentControlProposalServiceShape["expireOverdue"] = (now) =>
      store.expireOverdue({ now, limit: AGENT_CONTROL_EXPIRY_SWEEP_BATCH_LIMIT });

    const sweepNow = Effect.suspend(() => expireOverdue(new Date().toISOString()));

    const getQueue: AgentControlProposalServiceShape["getQueue"] = (input) =>
      Effect.gen(function* () {
        yield* policy.requireEnabled("AgentControlProposalService.getQueue");
        // Revision before the sweep and reads: change events published in
        // between carry a higher revision, so a subscriber replays rather
        // than misses them; replays are idempotent upserts.
        const revision = yield* events.currentRevision;
        yield* sweepNow;
        const active = yield* store.listActive({
          limit: clampLimit(
            input.activeLimit,
            AGENT_CONTROL_QUEUE_ACTIVE_LIMIT_DEFAULT,
            AGENT_CONTROL_QUEUE_ACTIVE_LIMIT_MAX,
          ),
        });
        const recent = yield* store.listRecent({
          limit: clampLimit(
            input.recentLimit,
            AGENT_CONTROL_QUEUE_RECENT_LIMIT_DEFAULT,
            AGENT_CONTROL_QUEUE_RECENT_LIMIT_MAX,
          ),
        });
        return { revision, active, recent } satisfies AgentControlProposalQueue;
      });

    const getProposal: AgentControlProposalServiceShape["getProposal"] = (proposalId) =>
      Effect.gen(function* () {
        yield* policy.requireEnabled("AgentControlProposalService.getProposal");
        yield* sweepNow;
        return yield* store.getById(proposalId);
      });

    /**
     * Idempotent user decision: when the exact decision already stands —
     * a double submit or a lost race against the same decision — return
     * the current receipt instead of failing. A conflicting state keeps
     * the original refusal, which names the actual status.
     */
    const decide = (
      decision: Extract<AgentControlProposalDecision, "approved" | "rejected">,
      input: DecideAgentControlProposalRequest,
    ) =>
      Effect.gen(function* () {
        yield* policy.requireEnabled("AgentControlProposalService.decide");
        return yield* store.decide({
          proposalId: input.proposalId,
          decision,
          actor: "user",
          decidedAt: input.decidedAt,
        });
      }).pipe(
        Effect.map(toAgentControlProposalReceipt),
        Effect.catchTag("AgentControlInvalidTransitionError", (error) =>
          store.getById(input.proposalId).pipe(
            Effect.flatMap(
              Option.match({
                onNone: () => Effect.fail(error),
                onSome: (current) =>
                  current.status === decision
                    ? Effect.succeed(toAgentControlProposalReceipt(current))
                    : Effect.fail(error),
              }),
            ),
          ),
        ),
      );

    const accept: AgentControlProposalServiceShape["accept"] = (input) => decide("approved", input);

    const reject: AgentControlProposalServiceShape["reject"] = (input) => decide("rejected", input);

    const subscribeQueue: AgentControlProposalServiceShape["subscribeQueue"] = (input) =>
      Stream.unwrap(
        Effect.gen(function* () {
          // Subscribe before the snapshot read so nothing published in
          // between is lost; the revision filter drops what the snapshot
          // already covers.
          const subscription = yield* events.subscribe;
          const queue = yield* getQueue(input);
          const live = Stream.fromSubscription(subscription).pipe(
            Stream.filter((event) => event.revision > queue.revision),
          );
          return Stream.concat(
            Stream.make({ version: 1 as const, type: "snapshot" as const, queue }),
            live,
          );
        }),
      );

    if (options?.disablePeriodicExpirySweep !== true) {
      const sweepIntervalMs = Math.max(
        1,
        options?.expirySweepIntervalMs ?? DEFAULT_EXPIRY_SWEEP_INTERVAL_MS,
      );
      yield* Effect.forkScoped(
        sweepNow.pipe(
          Effect.catch((error) =>
            Effect.logWarning("agent-control.expiry-sweep-failed", { error }),
          ),
          Effect.repeat(Schedule.spaced(Duration.millis(sweepIntervalMs))),
        ),
      );
    }

    return {
      submit: store.submit,
      getQueue,
      getProposal,
      accept,
      reject,
      expireOverdue,
      subscribeQueue,
    } satisfies AgentControlProposalServiceShape;
  });

export const makeAgentControlProposalServiceLive = (
  options?: AgentControlProposalServiceLiveOptions,
) => Layer.effect(AgentControlProposalService, makeAgentControlProposalService(options));

export const AgentControlProposalServiceLive = makeAgentControlProposalServiceLive();
