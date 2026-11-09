/**
 * Webhook triggers for automations (`docs/automation-webhooks.md`).
 *
 * An automation whose trigger is a webhook runs when something outside Ryco
 * (a GitHub repository webhook, a GitHub Actions step, curl) posts to its URL.
 * The node holds each hook's secret and checks every request; the Hub only
 * holds requests for a node until the node collects them, and never sees a
 * secret.
 *
 * - Direct: `POST <node>/api/automation-hooks/<hookId>`, for a node the sender
 *   reaches itself (a LAN, Tailscale). Signed, or `Authorization: Bearer <secret>`.
 * - Through the Hub: `POST <hub>/hooks/<hookId>`, signed only. The Hub queues the
 *   request for the node that registered the hook and nudges it with the relay
 *   frame `node.automation-hooks.pending`; the node collects queued requests
 *   with `POST /api/node/automation-hooks/sync` and a fresh node proof.
 */
import * as Schema from "effect/Schema";

import { NodeHubProof } from "./nodeProof.ts";

/** The relay node feature that asks the Hub for `node.automation-hooks.pending` frames. */
export const NODE_AUTOMATION_HOOKS_FEATURE = "automation-hooks";

/** The largest request body either path accepts, in bytes. */
export const AUTOMATION_HOOK_MAX_BODY_BYTES = 256 * 1024;

/**
 * A hook's public id: 16 random bytes, unpadded base64url. It names the hook
 * in its URLs and is not a secret; the secret is separate and stays on the node.
 */
export const AutomationHookId = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{22}$/u));
export type AutomationHookId = typeof AutomationHookId.Type;

/** A hook secret: 32 random bytes, unpadded base64url. Only the node stores it. */
export const AutomationHookSecret = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{43}$/u));
export type AutomationHookSecret = typeof AutomationHookSecret.Type;

/**
 * The signature header, in GitHub's webhook format: `sha256=` and the lowercase
 * hex HMAC-SHA256 of the raw body under the hook secret. GitHub repository and
 * organization webhooks send it as is; anything else can compute it
 * (`openssl dgst -sha256 -hmac "$SECRET"`).
 */
export const AUTOMATION_HOOK_SIGNATURE_HEADER = "x-hub-signature-256";

/** Ryco's own name for the same signature, accepted when the GitHub one is absent. */
export const AUTOMATION_HOOK_RYCO_SIGNATURE_HEADER = "x-ryco-signature-256";

/**
 * The request headers the Hub keeps and hands to the node, lowercase. Nothing
 * else of the request reaches the node; in particular never `authorization`.
 */
export const AUTOMATION_HOOK_FORWARDED_HEADERS = [
  "content-type",
  "user-agent",
  "x-github-event",
  "x-github-delivery",
  "x-github-hook-id",
  AUTOMATION_HOOK_SIGNATURE_HEADER,
  AUTOMATION_HOOK_RYCO_SIGNATURE_HEADER,
] as const;
export type AutomationHookForwardedHeader = (typeof AUTOMATION_HOOK_FORWARDED_HEADERS)[number];

// --- Public: `POST <hub>/hooks/<hookId>` and `POST <node>/api/automation-hooks/<hookId>` ---

export const AUTOMATION_HOOK_HUB_PATH_PREFIX = "/hooks/";
export const AUTOMATION_HOOK_NODE_PATH_PREFIX = "/api/automation-hooks/";

/**
 * The answer to a hook request that was taken (HTTP 202). Through the Hub,
 * `queued` means the Hub holds it for the node; `nodeOnline` says whether the
 * node is connected now (an offline node collects it when it comes back, within
 * a day). Directly, the node answers `queued: false` once it has started the run
 * or the run's approval request.
 */
export const AutomationHookAccepted = Schema.Struct({
  deliveryId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64)),
  queued: Schema.Boolean,
  nodeOnline: Schema.optionalKey(Schema.Boolean),
});
export type AutomationHookAccepted = typeof AutomationHookAccepted.Type;

/** Every refusal, on either path, is `{ error }` with one of these and its HTTP status. */
export const AutomationHookError = Schema.Struct({
  error: Schema.Literals([
    /** 404: no hook with that id (or, on the node, its automation is gone). */
    "unknown_hook",
    /** 401: no signature (or bearer, directly), or it does not match. */
    "unauthorized",
    /** 413: the body is larger than `AUTOMATION_HOOK_MAX_BODY_BYTES`. */
    "too_large",
    /** 429: too many requests for this hook or node; see `Retry-After`. */
    "rate_limited",
    /** 409: the automation is paused, cancelled or past its end. */
    "not_accepting",
  ]),
});
export type AutomationHookError = typeof AutomationHookError.Type;

// --- Node → Hub: `POST /api/node/automation-hooks/sync` ----------------------------

export const NODE_AUTOMATION_HOOKS_SYNC_PATH = "/api/node/automation-hooks/sync";
/** The most hooks one node registers. */
export const NODE_AUTOMATION_HOOKS_MAX_HOOKS = 100;
/** The most queued requests one sync answer carries; `more` asks the node to sync again. */
export const NODE_AUTOMATION_HOOKS_MAX_DELIVERIES = 10;

export const NodeAutomationHookAck = Schema.Struct({
  deliveryId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64)),
  /**
   * `accepted`: the node started a run or its approval request. `rejected`: the
   * node refused it for good (bad signature, unknown or paused hook, duplicate).
   * Either way the Hub forgets the request.
   */
  outcome: Schema.Literals(["accepted", "rejected"]),
});
export type NodeAutomationHookAck = typeof NodeAutomationHookAck.Type;

/**
 * One sync: the node's complete current hook list (it replaces what the Hub
 * holds for this node; an empty list removes every hook and drops their
 * queued requests), the outcomes of the requests the previous sync handed out,
 * and a request for more.
 */
export const NodeAutomationHooksSyncInput = Schema.Struct({
  proof: NodeHubProof,
  hookIds: Schema.Array(AutomationHookId).check(
    Schema.isMaxLength(NODE_AUTOMATION_HOOKS_MAX_HOOKS),
  ),
  acks: Schema.Array(NodeAutomationHookAck).check(
    Schema.isMaxLength(NODE_AUTOMATION_HOOKS_MAX_DELIVERIES),
  ),
});
export type NodeAutomationHooksSyncInput = typeof NodeAutomationHooksSyncInput.Type;

/** A queued request as the Hub received it. */
export const NodeAutomationHookDelivery = Schema.Struct({
  deliveryId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64)),
  hookId: AutomationHookId,
  /** When the Hub received it, ISO 8601. */
  receivedAt: Schema.String,
  /** Only `AUTOMATION_HOOK_FORWARDED_HEADERS`, lowercase names. */
  headers: Schema.Record(Schema.String, Schema.String),
  /** The raw body, standard base64. The node checks the signature over these bytes. */
  bodyBase64: Schema.String,
});
export type NodeAutomationHookDelivery = typeof NodeAutomationHookDelivery.Type;

/**
 * Up to `NODE_AUTOMATION_HOOKS_MAX_DELIVERIES` queued requests for this node's
 * hooks, oldest first. The Hub hands each one out again if the node does not
 * acknowledge it within two minutes, so the node ignores a `deliveryId` it has
 * already handled (and acknowledges it again).
 */
export const NodeAutomationHooksSyncResult = Schema.Struct({
  protocolVersion: Schema.Literal(1),
  deliveries: Schema.Array(NodeAutomationHookDelivery).check(
    Schema.isMaxLength(NODE_AUTOMATION_HOOKS_MAX_DELIVERIES),
  ),
  more: Schema.Boolean,
});
export type NodeAutomationHooksSyncResult = typeof NodeAutomationHooksSyncResult.Type;
