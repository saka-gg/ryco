/**
 * attentionSignalHttp - Posts one attention signal to the node's Hub, with a
 * fresh node proof, and classifies the answer for the publisher.
 *
 * A node-proof HTTPS call rather than a relay control frame on purpose: a Hub
 * closes a node's whole connector socket on a frame it does not know, and a
 * minor-version bump would touch every relay client. An older Hub answers 404
 * here and nothing else changes.
 *
 * @module push/attentionSignalHttp
 */
import { NativeE2eeEnrollmentId } from "@ryco/contracts/relay";
import {
  PUSH_ACTIVITY_SIGNAL_PATH,
  PUSH_ATTENTION_SIGNAL_PATH,
  PushActivityEntryStatus,
  PushActivitySignalResult,
  PushAttentionSignalResult,
  type PushActivitySignalInput,
  type PushAttentionSignalInput,
} from "@ryco/contracts/push-hub";
import { Option, Schema } from "effect";

import { postWithNodeProof } from "../hubConnector/nodeProofPost.ts";
import type { HubIdentityRuntimeShape } from "../hubConnector/HubIdentityRuntime.ts";
import type { HubConnector } from "../hubConnector/HubConnector.ts";
import type {
  ActivitySendOutcome,
  AttentionSendOutcome,
  HubSignalOutcome,
} from "./attentionPublisher.ts";

function classifyStatus(status: number): HubSignalOutcome<never> {
  if (status === 404 || status === 405) return { kind: "unsupported" };
  if (status === 401 || status === 403) return { kind: "refused" };
  return { kind: "failed" };
}

export interface HubSignalSenderDeps {
  readonly hubOrigin: string;
  readonly identity: HubIdentityRuntimeShape;
  readonly connector: HubConnector;
  readonly signal: AbortSignal;
  readonly fetch?: typeof fetch;
}

/**
 * Posts one node-proof signal to `path` and decodes the Hub's answer, which must name the
 * signal's own sequence.
 */
function makeHubSignalSender<
  Input extends { readonly sequence: number },
  Result extends {
    readonly sequence: number;
  },
>(deps: HubSignalSenderDeps, path: string, resultSchema: Schema.Decoder<Result>) {
  const decodeResult = Schema.decodeUnknownOption(resultSchema);
  return async (signal: Input): Promise<HubSignalOutcome<Result>> => {
    const response = await postWithNodeProof(deps, { path, body: signal });
    if (!response.ok) return classifyStatus(response.status);
    const decoded = decodeResult(response.value);
    return Option.isSome(decoded) && decoded.value.sequence === signal.sequence
      ? { kind: "delivered", result: decoded.value }
      : { kind: "failed" };
  };
}

export function makeAttentionSignalSender(
  deps: HubSignalSenderDeps,
): (signal: Omit<PushAttentionSignalInput, "proof">) => Promise<AttentionSendOutcome> {
  return makeHubSignalSender(deps, PUSH_ATTENTION_SIGNAL_PATH, PushAttentionSignalResult);
}

/**
 * The activity answer as read: an entry status this node does not know (from a newer Hub) is
 * kept as a string rather than failing the whole answer.
 */
const LenientActivitySignalResult = Schema.Struct({
  ...PushActivitySignalResult.fields,
  results: Schema.Array(
    Schema.Struct({
      enrollmentId: NativeE2eeEnrollmentId,
      status: Schema.String,
    }),
  ),
});
const isKnownActivityStatus = Schema.is(PushActivityEntryStatus);

/**
 * Live Activity counts (`docs/live-activity-push.md`): the same proof and answer rules. An
 * unknown entry status reads as `rate-limited`: the node sends that entry again later.
 */
export function makeActivitySignalSender(
  deps: HubSignalSenderDeps,
): (signal: Omit<PushActivitySignalInput, "proof">) => Promise<ActivitySendOutcome> {
  const send = makeHubSignalSender(deps, PUSH_ACTIVITY_SIGNAL_PATH, LenientActivitySignalResult);
  return async (signal) => {
    const outcome = await send(signal);
    if (outcome.kind !== "delivered") return outcome;
    return {
      kind: "delivered",
      result: {
        ...outcome.result,
        results: outcome.result.results.map((entry) => ({
          enrollmentId: entry.enrollmentId,
          status: isKnownActivityStatus(entry.status) ? entry.status : "rate-limited",
        })),
      },
    };
  };
}
