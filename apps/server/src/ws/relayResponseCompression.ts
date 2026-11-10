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
 * tokens, terminals, device and computer streams, project data, diffs, file
 * contents, and every event and delta. A message is compressed only when ALL of
 * these hold:
 *
 * - the client advertised a frame version this node writes, on this channel;
 * - the response belongs to an allowlisted method, and every value it carries
 *   is an allowlisted kind (a stream batch mixing in anything else is left
 *   alone, except that a leading shell `snapshot-begin` is split off and sent
 *   uncompressed in a message of its own); a history page only when nothing in
 *   it belongs to the thread's running turn;
 * - the encoded message is at least 16 KiB, and it
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
  type RelayCompressionPadding,
} from "@ryco/shared/relayPayloadCompression";

import { WEBSOCKET_PER_MESSAGE_DEFLATE } from "../webSocketCompression.ts";

/**
 * What the node knows about a thread's turns, for rules that depend on it. A
 * thread's running turn: `null` when none runs, `undefined` when it cannot be
 * told (the rule then does not compress).
 */
export interface RelayCompressionTurnState {
  readonly runningTurnOf: (
    threadId: string,
  ) => Promise<RelayCompressionRunningTurn | null | undefined>;
}

export interface RelayCompressionRunningTurn {
  readonly turnId: string;
  /** When the turn was requested: everything of the thread updated before it belongs to earlier turns. */
  readonly requestedAt: string;
}

/** The request a response answers, for rules that look at it. */
export interface RelayCompressionRequest {
  /** The request's payload as the client encoded it. */
  readonly payload: unknown;
  readonly turnState: RelayCompressionTurnState | undefined;
}

/** How one allowlisted method's responses may be compressed. */
export interface RelayCompressionRule {
  /**
   * For one stream batch: `undefined` when it may not be compressed, otherwise
   * how many LEADING values must travel uncompressed in a message of their own
   * (0 for none) ahead of the compressed rest.
   */
  readonly streamBatch?: (values: ReadonlyArray<unknown>) => number | undefined;
  /**
   * The successful result of a unary call may be compressed: always (`true`),
   * or when the predicate says so for this value and request.
   */
  readonly success?:
    | true
    | ((value: unknown, request: RelayCompressionRequest) => boolean | Promise<boolean>);
  /**
   * The frame's padding (`@ryco/shared/relayPayloadCompression`). `"coarse"`
   * for content that may still change while the Hub watches its length.
   */
  readonly padding?: RelayCompressionPadding;
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

function threadIdOf(payload: unknown): string | undefined {
  const threadId =
    typeof payload === "object" && payload !== null
      ? (payload as Record<string, unknown>).threadId
      : undefined;
  return typeof threadId === "string" ? threadId : undefined;
}

/** When a history item last changed: `updatedAt`, else `createdAt`, else `completedAt` (checkpoints). */
function itemChangedAtMs(item: unknown): number | undefined {
  if (typeof item !== "object" || item === null) return undefined;
  const record = item as Record<string, unknown>;
  const stamp = record.updatedAt ?? record.createdAt ?? record.completedAt;
  if (typeof stamp !== "string") return undefined;
  const ms = Date.parse(stamp);
  return Number.isFinite(ms) ? ms : undefined;
}

/**
 * A history page all of whose items belong to turns that ended: nothing in it
 * streams, carries the running turn's id, or changed after that turn was
 * requested. Such content no longer changes, so every delivery of the same page
 * has the same length (§4.6.6). Unknown turn state, an unknown item shape or a
 * missing timestamp leaves the page uncompressed.
 */
async function isFinishedHistoryPage(
  value: unknown,
  request: RelayCompressionRequest,
): Promise<boolean> {
  const items =
    typeof value === "object" && value !== null
      ? (value as Record<string, unknown>).items
      : undefined;
  const threadId = threadIdOf(request.payload);
  if (!Array.isArray(items) || threadId === undefined || request.turnState === undefined) {
    return false;
  }
  for (const item of items) {
    if (typeof item !== "object" || item === null) return false;
    if ((item as Record<string, unknown>).streaming === true) return false;
    if (itemChangedAtMs(item) === undefined) return false;
  }
  const running = await request.turnState.runningTurnOf(threadId);
  if (running === undefined) return false;
  if (running === null) return true;
  const requestedAtMs = Date.parse(running.requestedAt);
  if (!Number.isFinite(requestedAtMs)) return false;
  return items.every(
    (item) =>
      (item as Record<string, unknown>).turnId !== running.turnId &&
      itemChangedAtMs(item)! < requestedAtMs,
  );
}

/**
 * THE ALLOWLIST, by exposure class. What each carries is stated so a reviewer
 * can weigh it; the side-channel reasoning per class is
 * docs/relay-e2ee-protocol.md §4.6.6:
 *
 * - `shellSnapshotPages`: thread pages of a paged shell snapshot — titles,
 *   goals, branches, worktree paths, model selections, and each thread's
 *   session, whose `lastError` is provider error text. Never project data.
 * - `providerStatuses`: the full provider list, sent to clients that do not ask
 *   for deltas — model catalogs, status `message` (which may embed an OpenCode
 *   server URL or CLI stderr), `updateState.output` (raw update-command output,
 *   up to 10k characters), and `auth.email`. Deltas are never compressed.
 * - `serverConfig`: the config stream's `snapshot` and `settingsUpdated`, and
 *   `server.getConfig`. They carry the client copy of `ServerSettings`, which
 *   is redacted (secrets presence-only, URL credentials replaced by a marker);
 *   provider environment variables the user did not mark sensitive are sent as
 *   entered.
 * - `fileTree`: `projects.listEntries` results — workspace paths and kinds only,
 *   never file contents.
 * - `finishedHistoryPages`: `orchestration.getThreadHistoryPage` results whose
 *   every item belongs to a turn that ended (`isFinishedHistoryPage`).
 * - `threadWindows`: thread window snapshots (`subscribeThreadWindow` snapshot
 *   items, `getThreadWindow`), which hold the running turn, with COARSE padding.
 *
 * Diffs and file contents are not here and stay uncompressed.
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
  serverConfig: {
    [WS_METHODS.subscribeServerConfig]: {
      streamBatch: everyValue(hasField("type", ["snapshot", "settingsUpdated"])),
    },
    [WS_METHODS.serverGetConfig]: { success: true },
  },
  fileTree: {
    [WS_METHODS.projectsListEntries]: { success: true },
  },
  finishedHistoryPages: {
    [ORCHESTRATION_WS_METHODS.getThreadHistoryPage]: { success: isFinishedHistoryPage },
  },
  threadWindows: {
    [ORCHESTRATION_WS_METHODS.subscribeThreadWindow]: {
      streamBatch: everyValue(hasField("kind", ["snapshot"])),
      padding: "coarse",
    },
    [ORCHESTRATION_WS_METHODS.getThreadWindow]: { success: true, padding: "coarse" },
  },
};

/**
 * Messages below this many bytes are never compressed. Relay compression is for large allowlisted
 * responses only (shell pages, provider lists): a padded frame must save 10%, which smaller
 * messages rarely do.
 */
export const RELAY_COMPRESSION_THRESHOLD_BYTES = 16 * 1024;
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
  padding: RelayCompressionPadding = "standard",
): Promise<Uint8Array | undefined> {
  const frame = encodeCompressedRelayPayload(await deflate(message), message.byteLength, padding);
  return frame.byteLength <= message.byteLength * RELAY_COMPRESSION_MAX_RATIO ? frame : undefined;
}

interface RpcMessageLike {
  readonly _tag?: unknown;
  readonly id?: unknown;
  readonly tag?: unknown;
  readonly payload?: unknown;
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
  /** Every class's rule for the request's method, in allowlist order. */
  readonly rules: ReadonlyArray<RelayCompressionRule>;
  readonly payload: unknown;
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
  readonly #rules: ReadonlyMap<string, ReadonlyArray<RelayCompressionRule>>;
  readonly #turnState: RelayCompressionTurnState | undefined;
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
      /**
       * Turn state for rules that depend on it (finished history pages). Absent,
       * those rules never compress.
       */
      readonly turnState?: RelayCompressionTurnState | undefined;
    } = {},
  ) {
    this.#deflate = options.deflate ?? deflateRelayRpcMessage;
    this.#turnState = options.turnState;
    this.#maxMessageBytes = Math.min(
      RELAY_MAX_RPC_MESSAGE_BYTES,
      Math.max(0, options.maxMessageBytes ?? RELAY_MAX_RPC_MESSAGE_BYTES),
    );
    const rules = new Map<string, Array<RelayCompressionRule>>();
    for (const methods of Object.values(options.allowlist ?? RELAY_COMPRESSION_ALLOWLIST)) {
      for (const [method, rule] of Object.entries(methods)) {
        const existing = rules.get(method);
        if (existing === undefined) rules.set(method, [rule]);
        else existing.push(rule);
      }
    }
    this.#rules = rules;
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
    const rules = this.#rules.get(record.tag);
    if (rules === undefined || this.#requests.size >= RELAY_COMPRESSION_MAX_TRACKED_REQUESTS) {
      return true;
    }
    this.#requests.set(key, { rules, payload: record.payload, surplusAcks: 0 });
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
        const exit = asRecord(record.exit) as { _tag?: unknown; value?: unknown } | undefined;
        if (exit?._tag !== "Success") return [bytes];
        const rule = await this.#acceptingResult(tracked, exit.value);
        return rule === undefined
          ? [bytes]
          : [(await this.#compress(bytes, rule.padding)) ?? bytes];
      }
      if (record._tag !== "Chunk" || !Array.isArray(record.values)) return [bytes];
      const values = record.values;
      let lead: number | undefined;
      let rule: RelayCompressionRule | undefined;
      for (const candidate of tracked.rules) {
        lead = candidate.streamBatch?.(values);
        if (lead !== undefined) {
          rule = candidate;
          break;
        }
      }
      if (lead === undefined || rule === undefined) return [bytes];
      if (lead === 0) return [(await this.#compress(bytes, rule.padding)) ?? bytes];
      const head = reencode({ ...record, values: values.slice(0, lead) });
      const rest = reencode({ ...record, values: values.slice(lead) });
      if (head === undefined || rest === undefined) return [bytes];
      const compressed = await this.#compress(rest, rule.padding);
      if (compressed === undefined) return [bytes];
      tracked.surplusAcks += 1;
      return [head, compressed];
    } catch {
      return [bytes];
    }
  }

  /** The first class whose rule accepts this successful unary result. */
  async #acceptingResult(
    tracked: TrackedRequest,
    value: unknown,
  ): Promise<RelayCompressionRule | undefined> {
    for (const rule of tracked.rules) {
      if (rule.success === true) return rule;
      if (
        rule.success !== undefined &&
        (await rule.success(value, { payload: tracked.payload, turnState: this.#turnState }))
      ) {
        return rule;
      }
    }
    return undefined;
  }

  async #compress(
    bytes: Uint8Array,
    padding: RelayCompressionPadding = "standard",
  ): Promise<Uint8Array | undefined> {
    if (
      bytes.byteLength < RELAY_COMPRESSION_THRESHOLD_BYTES ||
      bytes.byteLength >= this.#maxMessageBytes
    ) {
      return undefined;
    }
    const frame = await compressRelayRpcMessage(bytes, this.#deflate, padding);
    return frame !== undefined && bytes.byteLength + frame.byteLength <= this.#maxMessageBytes
      ? frame
      : undefined;
  }

  reset(): void {
    this.#requests.clear();
  }
}
