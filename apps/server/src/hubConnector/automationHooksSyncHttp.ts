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
import { RELAY_PROTOCOL_MAJOR, RELAY_PROTOCOL_MINOR } from "@ryco/contracts/relay";
import { Effect, Option, Schema } from "effect";

import type {
  AutomationHookAnswer,
  AutomationHookRequest,
} from "../automationHooks/automationHookRequest.ts";
import { fetchBoundedJson } from "../hubIdentity/BoundedHttp.ts";
import type {
  AutomationHookDeliveryOutcome,
  AutomationHooksSyncDeps,
  AutomationHooksSyncOutcome,
} from "./automationHooksSync.ts";
import type { HubConnector } from "./HubConnector.ts";
import type { HubIdentityRuntimeShape } from "./HubIdentityRuntime.ts";

const decodeResult = Schema.decodeUnknownOption(NodeAutomationHooksSyncResult);

/** Ten bodies at the limit, base64, with their headers. */
const MAX_RESPONSE_BYTES =
  NODE_AUTOMATION_HOOKS_MAX_DELIVERIES * Math.ceil((AUTOMATION_HOOK_MAX_BODY_BYTES * 4) / 3) +
  256 * 1024;

class SyncHttpFailure extends Error {
  readonly status: number;
  constructor(status: number) {
    super("The automation hooks sync failed.");
    this.status = status;
  }
}

export function makeAutomationHooksSyncer(deps: {
  readonly hubOrigin: string;
  readonly identity: HubIdentityRuntimeShape;
  readonly connector: Pick<HubConnector, "asIdentityOwner">;
  readonly signal: AbortSignal;
  readonly fetch?: typeof fetch;
}): AutomationHooksSyncDeps["sync"] {
  return async ({ hookIds, acks }): Promise<AutomationHooksSyncOutcome> => {
    let proof;
    try {
      proof = await deps.connector.asIdentityOwner(() =>
        deps.identity.createRelayAuthenticationFrame(deps.hubOrigin, {
          protocolMajor: RELAY_PROTOCOL_MAJOR,
          protocolMinor: RELAY_PROTOCOL_MINOR,
        }),
      );
    } catch {
      return { kind: "failed" };
    }
    let body: string;
    try {
      body = JSON.stringify({
        proof: {
          nodeId: proof.nodeId,
          protocolMajor: proof.protocolMajor,
          protocolMinor: proof.protocolMinor,
          nonce: Buffer.from(proof.nonce).toString("base64url"),
          signature: Buffer.from(proof.signature).toString("base64url"),
        },
        hookIds,
        acks,
      });
    } finally {
      proof.nonce.fill(0);
      proof.signature.fill(0);
    }
    let response;
    try {
      response = await fetchBoundedJson(
        deps.fetch ?? fetch,
        `${deps.hubOrigin}${NODE_AUTOMATION_HOOKS_SYNC_PATH}`,
        {
          method: "POST",
          redirect: "error",
          signal: deps.signal,
          headers: { "content-type": "application/json" },
          body,
        },
        // An older Hub's 404 need not be JSON: keep the status either way.
        (failure) => {
          throw new SyncHttpFailure(failure.kind === "invalid_response" ? failure.status : 0);
        },
        { timeoutMs: 60_000, maxResponseBytes: MAX_RESPONSE_BYTES },
      );
    } catch (error) {
      const status = error instanceof SyncHttpFailure ? error.status : 0;
      return status === 404 || status === 405 ? { kind: "unsupported" } : { kind: "failed" };
    }
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
