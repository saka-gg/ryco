/**
 * automationHooksSyncHttp - One webhook sync with the node's Hub, with a fresh node proof
 * (`POST /api/node/automation-hooks/sync`), and the hand-over of what it answers to the request
 * pipeline.
 *
 * @module hubConnector/automationHooksSyncHttp
 */
import {
  AUTOMATION_HOOK_FORWARDED_HEADERS,
  AUTOMATION_HOOK_MAX_BODY_BYTES,
  NODE_AUTOMATION_HOOKS_MAX_DELIVERIES,
  NODE_AUTOMATION_HOOKS_SYNC_PATH,
  NodeAutomationHooksSyncResult,
  type NodeAutomationHookDelivery,
} from "@ryco/contracts/automation-hooks";
import { Effect, Option, Schema } from "effect";

import type {
  AutomationHookAnswer,
  AutomationHookRequest,
} from "../automationHooks/automationHookRequest.ts";
import type {
  AutomationHookDeliveryOutcome,
  AutomationHooksSyncDeps,
  AutomationHooksSyncOutcome,
} from "./automationHooksSync.ts";
import type { HubConnector } from "./HubConnector.ts";
import type { HubIdentityRuntimeShape } from "./HubIdentityRuntime.ts";
import { postWithNodeProof } from "./nodeProofPost.ts";

const decodeResult = Schema.decodeUnknownOption(NodeAutomationHooksSyncResult);

/** Ten bodies at the limit, base64, with their headers. */
const MAX_RESPONSE_BYTES =
  NODE_AUTOMATION_HOOKS_MAX_DELIVERIES * Math.ceil((AUTOMATION_HOOK_MAX_BODY_BYTES * 4) / 3) +
  256 * 1024;

export function makeAutomationHooksSyncer(deps: {
  readonly hubOrigin: string;
  readonly identity: HubIdentityRuntimeShape;
  readonly connector: Pick<HubConnector, "asIdentityOwner">;
  readonly signal: AbortSignal;
  readonly fetch?: typeof fetch;
}): AutomationHooksSyncDeps["sync"] {
  return async ({ hookIds, acks }): Promise<AutomationHooksSyncOutcome> => {
    const response = await postWithNodeProof(deps, {
      path: NODE_AUTOMATION_HOOKS_SYNC_PATH,
      body: { hookIds, acks },
      timeoutMs: 60_000,
      maxResponseBytes: MAX_RESPONSE_BYTES,
    });
    // 404 (no route, or `node_not_found`): stop until the next connect. Anything else, a
    // `node_rate_limited` 429 included, is tried again later.
    if (!response.ok) {
      return response.status === 404 || response.status === 405
        ? { kind: "unsupported" }
        : { kind: "failed" };
    }
    const decoded = decodeResult(response.value);
    return Option.isSome(decoded)
      ? { kind: "answered", result: decoded.value }
      : { kind: "failed" };
  };
}

const forwarded = new Set<string>(AUTOMATION_HOOK_FORWARDED_HEADERS);

/** A request the Hub held, as the pipeline takes it: only the forwarded headers, the raw body. */
export function automationHookRequestOfDelivery(
  delivery: NodeAutomationHookDelivery,
  now: Date = new Date(),
): AutomationHookRequest {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(delivery.headers)) {
    const lower = name.toLowerCase();
    if (forwarded.has(lower)) headers[lower] = value;
  }
  const receivedMs = Date.parse(delivery.receivedAt);
  return {
    hookId: delivery.hookId,
    body: Buffer.from(delivery.bodyBase64, "base64"),
    headers,
    deliveryId: delivery.deliveryId,
    receivedAt:
      Number.isFinite(receivedMs) && receivedMs <= now.getTime() ? new Date(receivedMs) : now,
    via: "cloud",
  };
}

/**
 * The outcome the Hub hears: refused for good (unknown, unauthorized, paused, too large) is
 * `rejected`; a rate-limited or failed one gets none, so the Hub hands it out again later.
 */
export function automationHookDeliveryOutcome(
  answer: AutomationHookAnswer,
): AutomationHookDeliveryOutcome {
  if (answer.kind === "accepted") return "accepted";
  if (answer.kind === "failed") return "retry";
  return answer.error === "rate_limited" ? "retry" : "rejected";
}

/** Hands one held request to the pipeline (loaded on the first one). */
export const deliverAutomationHook =
  (
    run: <A>(effect: Effect.Effect<A>) => Promise<A>,
    take: (request: AutomationHookRequest) => Effect.Effect<AutomationHookAnswer>,
  ) =>
  (delivery: NodeAutomationHookDelivery): Promise<AutomationHookDeliveryOutcome> =>
    run(
      take(automationHookRequestOfDelivery(delivery)).pipe(
        Effect.map(automationHookDeliveryOutcome),
      ),
    );
