import * as Schema from "effect/Schema";
import { HubAccountId, HubBrowserSessionId } from "./hostedIdentity.ts";
import { RELAY_MAX_DATA_FRAME_BYTES, RelayNodeId } from "./relay.ts";

/** The outer session never changes the authenticated relay frames it carries. */
export const HUB_SESSION_PROTOCOL_VERSION = 2 as const;
/** The version every Hub and client speaks; the only one a client that advertises nothing gets. */
export const HUB_SESSION_BASE_PROTOCOL_VERSION = 1 as const;
export type HubSessionProtocolVersion = 1 | 2;
/**
 * The WebSocket subprotocol a client offers to advertise the highest session version it decodes,
 * `ryco.hub-session.v<N>`. It only advertises: the version in `ready` is the negotiated one, the
 * lower of the client's and the Hub's. A Hub that predates version 2 ignores the offer (the
 * upgrade accepts it and selects it unchanged) and answers version 1.
 */
export const HUB_SESSION_SUBPROTOCOL_PREFIX = "ryco.hub-session.v";
export function hubSessionSubprotocol(version: HubSessionProtocolVersion): string {
  return `${HUB_SESSION_SUBPROTOCOL_PREFIX}${version}`;
}
export const HUB_SESSION_PATH = "/v1/relay/session";
export const HUB_SESSION_MAX_CHANNELS = 8;
export const HUB_SESSION_HEADER_BYTES = 5;
export const HUB_SESSION_MAX_FRAME_BYTES = RELAY_MAX_DATA_FRAME_BYTES + HUB_SESSION_HEADER_BYTES;
export const HUB_SESSION_MAX_QUEUED_FRAMES = 2_048;
export const HUB_SESSION_MAX_QUEUED_BYTES = 2 * 1_024 * 1_024;
export const HUB_SESSION_CLOSE_REASON_BYTES = 64;
export const HUB_SESSION_HEARTBEAT_INTERVAL_MS = 20_000;
export const HUB_SESSION_DEAD_CONNECTION_TIMEOUT_MS = 45_000;
/** The relay capability an `openNode` may request; the only one the relay defines. */
export const HUB_SESSION_OPEN_NODE_CAPABILITIES = ["ryco.rpc"] as const;

const streamId = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 0xffff_ffff }));
const nonce = Schema.Uint8Array.check(Schema.isMinLength(8), Schema.isMaxLength(8));
const maxChannels = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: HUB_SESSION_MAX_CHANNELS }),
);
export const HubSessionFrame = Schema.Union([
  Schema.Struct({ type: Schema.Literal("open"), streamId }),
  Schema.Struct({
    type: Schema.Literal("data"),
    streamId,
    payload: Schema.Uint8Array.check(
      Schema.isMinLength(1),
      Schema.isMaxLength(RELAY_MAX_DATA_FRAME_BYTES),
    ),
  }),
  Schema.Struct({
    type: Schema.Literal("close"),
    streamId,
    code: Schema.Int.check(Schema.isBetween({ minimum: 1000, maximum: 4999 })),
    reason: Schema.String.check(
      Schema.isMaxLength(HUB_SESSION_CLOSE_REASON_BYTES),
      Schema.makeFilter(
        (value) => new TextEncoder().encode(value).byteLength <= HUB_SESSION_CLOSE_REASON_BYTES,
      ),
    ),
  }),
  Schema.Struct({
    type: Schema.Literal("ready"),
    protocolVersion: Schema.Literal(HUB_SESSION_BASE_PROTOCOL_VERSION),
    maxChannels,
  }),
  /**
   * Version 2 `ready` also names the account and browser session the Hub authenticated the
   * socket as. Sent only to a client that advertised version 2.
   */
  Schema.Struct({
    type: Schema.Literal("ready"),
    protocolVersion: Schema.Literal(2),
    maxChannels,
    accountId: HubAccountId,
    sessionId: HubBrowserSessionId,
  }),
  Schema.Struct({ type: Schema.Literal("ping"), nonce }),
  Schema.Struct({ type: Schema.Literal("pong"), nonce }),
  Schema.Struct({
    type: Schema.Literal("invalidate"),
    directory: Schema.Boolean,
    threadCache: Schema.Boolean,
  }).check(Schema.makeFilter((value) => value.directory || value.threadCache)),
  /**
   * Version 2 only: open a logical stream to `nodeId` that the Hub authenticates itself, with a
   * single-use ticket it mints and consumes for this socket's session under the authorization
   * checks of an HTTP ticket request. `sessionId` is the browser session the client expects the
   * socket to be authenticated as; the Hub refuses the open when it is not, so a stream can never
   * be authorized for a session the client did not restore. The stream carries no relay `auth`
   * frame; its first inbound frame is the relay's `ready` (or its refusal).
   */
  Schema.Struct({
    type: Schema.Literal("openNode"),
    streamId,
    nodeId: RelayNodeId,
    sessionId: HubBrowserSessionId,
    capability: Schema.Literals(HUB_SESSION_OPEN_NODE_CAPABILITIES),
    protocolMajor: Schema.Literal(1),
    protocolMinor: Schema.Literals([2, 3]),
  }),
]);
export type HubSessionFrame = typeof HubSessionFrame.Type;
export type HubSessionReadyFrame = Extract<HubSessionFrame, { readonly type: "ready" }>;
export type HubSessionOpenNodeFrame = Extract<HubSessionFrame, { readonly type: "openNode" }>;
