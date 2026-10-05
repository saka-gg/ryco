import { Schema } from "effect";
import { RELAY_MAX_DATA_FRAME_BYTES } from "./relay.ts";

/** The outer session never changes the authenticated relay frames it carries. */
export const HUB_SESSION_PROTOCOL_VERSION = 1 as const;
export const HUB_SESSION_PATH = "/v1/relay/session";
export const HUB_SESSION_MAX_CHANNELS = 8;
export const HUB_SESSION_HEADER_BYTES = 5;
export const HUB_SESSION_MAX_FRAME_BYTES = RELAY_MAX_DATA_FRAME_BYTES + HUB_SESSION_HEADER_BYTES;
export const HUB_SESSION_MAX_QUEUED_FRAMES = 2_048;
export const HUB_SESSION_MAX_QUEUED_BYTES = 2 * 1_024 * 1_024;
export const HUB_SESSION_CLOSE_REASON_BYTES = 64;
export const HUB_SESSION_HEARTBEAT_INTERVAL_MS = 20_000;
export const HUB_SESSION_DEAD_CONNECTION_TIMEOUT_MS = 45_000;

const streamId = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 0xffff_ffff }));
const nonce = Schema.Uint8Array.check(Schema.isMinLength(8), Schema.isMaxLength(8));
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
    protocolVersion: Schema.Literal(HUB_SESSION_PROTOCOL_VERSION),
    maxChannels: Schema.Int.check(
      Schema.isBetween({ minimum: 1, maximum: HUB_SESSION_MAX_CHANNELS }),
    ),
  }),
  Schema.Struct({ type: Schema.Literal("ping"), nonce }),
  Schema.Struct({ type: Schema.Literal("pong"), nonce }),
  Schema.Struct({
    type: Schema.Literal("invalidate"),
    directory: Schema.Boolean,
    threadCache: Schema.Boolean,
  }).check(Schema.makeFilter((value) => value.directory || value.threadCache)),
]);
export type HubSessionFrame = typeof HubSessionFrame.Type;
