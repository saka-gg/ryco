/**
 * relayResponseCompression - which node-to-client relay RPC messages are
 * compressed, and the per-channel state that decides it.
 *
 * Compression happens inside the relay payload (see
 * `@ryco/shared/relayPayloadCompression`), above the E2EE seal and the chunk
 * layer, so the Hub only ever sees its padded length. That length now depends
 * on how well the content compresses, which is a CRIME/BREACH-class side
 * channel for any message that mixes text an attacker can influence with text
 * worth learning. The allowlist below is therefore deliberately small and is
 * the ONE place that decides exposure: drop a class by deleting its entry. The
 * analysis lives in docs/relay-e2ee-protocol.md §4.6.6.
 *
 * Everything not listed stays uncompressed: errors and defects, auth, pairing,
 * tokens, terminals, device and computer streams, settings, project data, and
 * every event and delta. A message is compressed only when ALL of these hold:
 *
 * - the client advertised a frame version this node writes, on this channel;
 * - the response belongs to an allowlisted method, and every value it carries
 *   is an allowlisted kind (a stream batch mixing in anything else is left
 *   alone, except that a leading shell `snapshot-begin` is split off and sent
 *   uncompressed in a message of its own);
 * - the encoded message is at least the permessage-deflate threshold, and it
 *   and its compressed frame TOGETHER fit the channel's message ceiling: the
 *   client holds both while it inflates, and charges both to its inbound queue;
 * - compressing (fresh context, level 1, padded) saves at least 10%.
 *
 * @module relayResponseCompression
 */
import * as Zlib from "node:zlib";

import { ORCHESTRATION_WS_METHODS, WS_METHODS } from "@ryco/contracts";
import { RELAY_MAX_RPC_MESSAGE_BYTES } from "@ryco/contracts/relay";
import {
  encodeCompressedRelayPayload,
  RELAY_COMPRESSED_PAYLOAD_VERSION,
  readRelayCompressionAdvertisement,
} from "@ryco/shared/relayPayloadCompression";

import { WEBSOCKET_PER_MESSAGE_DEFLATE } from "../webSocketCompression.ts";

/** How one allowlisted method's responses may be compressed. */
export interface RelayCompressionRule {
  /**
   * For one stream batch: `undefined` when it may not be compressed, otherwise
   * how many LEADING values must travel uncompressed in a message of their own
   * (0 for none) ahead of the compressed rest.
   */
  readonly streamBatch?: (values: ReadonlyArray<unknown>) => number | undefined;
  /** The successful result of a unary call may be compressed. */
  readonly success?: true;
}

function hasField(field: string, values: ReadonlyArray<string>): (value: unknown) => boolean {
  const accepted = new Set(values);
  return (value) =>
    typeof value === "object" &&
    value !== null &&
    accepted.has((value as Record<string, unknown>)[field] as string);
}

function everyValue(test: (value: unknown) => boolean) {
  return (values: ReadonlyArray<unknown>): number | undefined =>
    values.length > 0 && values.every(test) ? 0 : undefined;
}

const isThreadPage = hasField("kind", ["snapshot-threads"]);
const isThreadPageOrEnd = hasField("kind", ["snapshot-threads", "snapshot-end"]);
const isSnapshotBegin = hasField("kind", ["snapshot-begin"]);

/**
 * A paged shell snapshot's thread pages. `snapshot-begin` carries the projects —
 * their scripts' commands and custom system prompts, where users do put
 * credentials — so it is never compressed; when it shares the first page's
 * message it is split off into an uncompressed message of its own. The
 * unpaged `snapshot` item carries projects too and is never compressed.
 * `snapshot-end` carries nothing and rides along with a page.
 */
function shellThreadPages(values: ReadonlyArray<unknown>): number | undefined {
  const lead = values.length > 0 && isSnapshotBegin(values[0]) ? 1 : 0;
  const rest = values.slice(lead);
  return rest.some(isThreadPage) && rest.every(isThreadPageOrEnd) ? lead : undefined;
}

/**
 * Classes that are NOT compressed by default, kept defined so that turning one
 * on is a single line in `RELAY_COMPRESSION_ALLOWLIST`.
 *
 * - `threadWindows`: thread window snapshots and history pages. The most
 *   exposed class — conversation text mixes whatever the user pasted and tools
 *   printed with repository content and model output an attacker can shape —
 *   for the weakest measured gain (about 2.6–3.2x).
 */
export const RELAY_COMPRESSION_OPT_IN_CLASSES = {
  threadWindows: {
    [ORCHESTRATION_WS_METHODS.subscribeThreadWindow]: {
      streamBatch: everyValue(hasField("kind", ["snapshot"])),
    },
    [ORCHESTRATION_WS_METHODS.getThreadWindow]: { success: true },
    [ORCHESTRATION_WS_METHODS.getThreadHistoryPage]: { success: true },
  },
} as const satisfies Record<string, Record<string, RelayCompressionRule>>;

/**
 * THE ALLOWLIST, by exposure class. Snapshot pages only; what each carries is
 * stated so a reviewer can weigh it (docs/relay-e2ee-protocol.md §4.6.3):
 *
 * - `shellSnapshotPages`: thread pages of a paged shell snapshot — titles,
 *   goals, branches, worktree paths, model selections, and each thread's
 *   session, whose `lastError` is provider error text. Never project data.
 * - `providerStatuses`: the full provider list, sent to clients that do not ask
 *   for deltas — model catalogs, status `message` (which may embed an OpenCode
 *   server URL or CLI stderr), `updateState.output` (raw update-command output,
 *   up to 10k characters), and `auth.email`. Deltas, the server config
 *   snapshot, `settingsUpdated`, and `server.getConfig` are NOT here: the
 *   latter three carry `ServerSettings`, whose client copy still holds
 *   credential-bearing values in plain text.
 *
 * To compress thread windows too, add
 * `threadWindows: RELAY_COMPRESSION_OPT_IN_CLASSES.threadWindows,`.
 */
export const RELAY_COMPRESSION_ALLOWLIST: Readonly<
  Record<string, Readonly<Record<string, RelayCompressionRule>>>
> = {
  shellSnapshotPages: {
    [ORCHESTRATION_WS_METHODS.subscribeShell]: { streamBatch: shellThreadPages },
  },
  providerStatuses: {
    [WS_METHODS.subscribeServerConfig]: {
      streamBatch: everyValue(hasField("type", ["providerStatuses"])),
    },
  },
};

/** Messages below this many bytes are never compressed (permessage-deflate's threshold). */
export const RELAY_COMPRESSION_THRESHOLD_BYTES = WEBSOCKET_PER_MESSAGE_DEFLATE.threshold;
/** The padded frame must be at most this fraction of the original, or the original is sent. */
export const RELAY_COMPRESSION_MAX_RATIO = 0.9;
/** Allowlisted requests tracked per channel; beyond it new ones are simply not compressed. */
export const RELAY_COMPRESSION_MAX_TRACKED_REQUESTS = 1_024;

/**
 * Raw DEFLATE at level 1 on the zlib threadpool, with a fresh context for this
 * message alone: nothing one message contributes can change how another one
 * compresses.
 */
export function deflateRelayRpcMessage(message: Uint8Array): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    Zlib.deflateRaw(
      message,
      { level: WEBSOCKET_PER_MESSAGE_DEFLATE.zlibDeflateOptions.level },
      (error, deflated) => {
        if (error) reject(error);
        else resolve(new Uint8Array(deflated.buffer, deflated.byteOffset, deflated.byteLength));
      },
    );
  });
}

/**
 * The compressed frame for `message`, or `undefined` when it saves too little.
 * Size and allowlist gates are the caller's; this only compresses and pads.
 */
export async function compressRelayRpcMessage(
  message: Uint8Array,
  deflate: (message: Uint8Array) => Promise<Uint8Array> = deflateRelayRpcMessage,
): Promise<Uint8Array | undefined> {
  const frame = encodeCompressedRelayPayload(await deflate(message), message.byteLength);
  return frame.byteLength <= message.byteLength * RELAY_COMPRESSION_MAX_RATIO ? frame : undefined;
}

interface RpcMessageLike {
  readonly _tag?: unknown;
  readonly id?: unknown;
  readonly tag?: unknown;
  readonly requestId?: unknown;
  readonly values?: unknown;
  readonly exit?: unknown;
}

function asRecord(value: unknown): RpcMessageLike | undefined {
  return typeof value === "object" && value !== null ? (value as RpcMessageLike) : undefined;
}

function requestKey(id: unknown): string | undefined {
  return typeof id === "string" || typeof id === "number" ? String(id) : undefined;
}

interface TrackedRequest {
  readonly rule: RelayCompressionRule;
  /** Client acks still owed for messages this channel split a chunk into. */
  surplusAcks: number;
}

/**
 * One channel's compression state: the frame version its client advertised,
 * and which of its in-flight requests are allowlisted. Owned by the channel's
 * RPC byte session, which feeds it every inbound message and every outbound
 * response in order.
 */
export class RelayResponseCompressor {
  readonly #deflate: (message: Uint8Array) => Promise<Uint8Array>;
  readonly #rules: ReadonlyMap<string, RelayCompressionRule>;
  readonly #maxMessageBytes: number;
  /** The frame version this node writes for this channel; 0 until advertised. */
  #frameVersion = 0;
  readonly #requests = new Map<string, TrackedRequest>();

  constructor(
    options: {
      readonly deflate?: (message: Uint8Array) => Promise<Uint8Array>;
      readonly allowlist?: Readonly<Record<string, Readonly<Record<string, RelayCompressionRule>>>>;
      /**
       * The channel's message ceiling (§4.5's `plaintextCeiling`). A message is
       * compressed only when it and its frame together fit it, so the client
       * never holds more for a compressed message than the channel lets one
       * message occupy. Defaults to the relay message limit.
       */
      readonly maxMessageBytes?: number;
    } = {},
  ) {
    this.#deflate = options.deflate ?? deflateRelayRpcMessage;
    this.#maxMessageBytes = Math.min(
      RELAY_MAX_RPC_MESSAGE_BYTES,
      Math.max(0, options.maxMessageBytes ?? RELAY_MAX_RPC_MESSAGE_BYTES),
    );
    this.#rules = new Map(
      Object.values(options.allowlist ?? RELAY_COMPRESSION_ALLOWLIST).flatMap((rules) =>
        Object.entries(rules),
      ),
    );
  }

  /** Whether this channel's client advertised a frame version this node writes. */
  get advertised(): boolean {
    return this.#frameVersion > 0;
  }

  /** Allowlisted requests currently tracked. */
  get trackedRequests(): number {
    return this.#requests.size;
  }

  /**
   * One inbound message, after reassembly and after the E2EE layer accepted it
   * (so on an E2EE channel the advertisement is authenticated and the Hub can
   * neither forge nor strip it). Latches the advertisement and returns the
   * message without it.
   */
  acceptInbound(message: Uint8Array): Uint8Array {
    const advertisement = readRelayCompressionAdvertisement(message);
    if (advertisement === undefined) return message;
    // The highest version both ends know; today that is version 1 or nothing.
    const version = Math.min(advertisement.maxVersion, RELAY_COMPRESSED_PAYLOAD_VERSION);
    if (version >= 1) this.#frameVersion = version;
    return advertisement.message;
  }

  /**
   * One decoded inbound RPC message: remembers allowlisted requests, and
   * answers whether the RPC server should see it. The one message it withholds
   * is the client's acknowledgement of the uncompressed half of a chunk this
   * channel split in two: the server sent ONE chunk and waits for ONE ack, and a
   * second would open its stream latch early.
   */
  admitInbound(message: unknown): boolean {
    const record = asRecord(message);
    if (record === undefined) return true;
    const key = requestKey(record._tag === "Request" ? record.id : record.requestId);
    if (key === undefined) return true;
    if (record._tag === "Ack") {
      const tracked = this.#requests.get(key);
      if (tracked === undefined || tracked.surplusAcks === 0) return true;
      tracked.surplusAcks -= 1;
      return false;
    }
    if (record._tag !== "Request" || typeof record.tag !== "string") return true;
    // A reused id starts over: whatever the old request was, this one decides.
    this.#requests.delete(key);
    const rule = this.#rules.get(record.tag);
    if (rule === undefined || this.#requests.size >= RELAY_COMPRESSION_MAX_TRACKED_REQUESTS) {
      return true;
    }
    this.#requests.set(key, { rule, surplusAcks: 0 });
    return true;
  }

  /**
   * The messages to send for one encoded response, in order: usually `bytes`
   * unchanged or one compressed frame; for a batch with leading values that may
   * not be compressed, those values uncompressed and then the compressed rest.
   * Never fails — a compression error sends the original.
   */
  async encode(
    response: unknown,
    bytes: Uint8Array,
    reencode: (response: unknown) => Uint8Array | undefined,
  ): Promise<ReadonlyArray<Uint8Array>> {
    const record = asRecord(response);
    if (record === undefined) return [bytes];
    const key = requestKey(record.requestId);
    const tracked = key === undefined ? undefined : this.#requests.get(key);
    if (record._tag === "Exit" && key !== undefined) this.#requests.delete(key);
    if (tracked === undefined || !this.advertised) return [bytes];
    try {
      if (record._tag === "Exit") {
        return tracked.rule.success === true && asRecord(record.exit)?._tag === "Success"
          ? [(await this.#compress(bytes)) ?? bytes]
          : [bytes];
      }
      if (record._tag !== "Chunk" || !Array.isArray(record.values)) return [bytes];
      const lead = tracked.rule.streamBatch?.(record.values);
      if (lead === undefined) return [bytes];
      if (lead === 0) return [(await this.#compress(bytes)) ?? bytes];
      const head = reencode({ ...record, values: record.values.slice(0, lead) });
      const rest = reencode({ ...record, values: record.values.slice(lead) });
      if (head === undefined || rest === undefined) return [bytes];
      const compressed = await this.#compress(rest);
      if (compressed === undefined) return [bytes];
      tracked.surplusAcks += 1;
      return [head, compressed];
    } catch {
      return [bytes];
    }
  }

  async #compress(bytes: Uint8Array): Promise<Uint8Array | undefined> {
    if (
      bytes.byteLength < RELAY_COMPRESSION_THRESHOLD_BYTES ||
      bytes.byteLength >= this.#maxMessageBytes
    ) {
      return undefined;
    }
    const frame = await compressRelayRpcMessage(bytes, this.#deflate);
    return frame !== undefined && bytes.byteLength + frame.byteLength <= this.#maxMessageBytes
      ? frame
      : undefined;
  }

  reset(): void {
    this.#requests.clear();
  }
}
