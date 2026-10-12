/**
 * Record policy for the provider event logs (`logs/provider/<thread>[.native].log`).
 *
 * Pure functions only: file naming and the line format, which records each
 * detail level keeps, how streaming deltas are recognised for coalescing, and
 * how one record is serialized. `EventNdjsonLogger` owns buffering and I/O;
 * Diagnostics reads the files back through `parseProviderEventLogLine`.
 *
 * Serialization is where the logs stay bounded and safe, for every provider:
 *   - Agent Control secrets are redacted in every string as it is written.
 *   - Strings past `PROVIDER_EVENT_LOG_STRING_CAP` keep a head and tail;
 *     inline base64 (attachments, images) is replaced by its size and digest.
 *   - Canonical records keep `raw` as a reference (`source`, `method`,
 *     `messageType`, `nativeId`) instead of a second copy of the native
 *     message, which the native log already holds.
 *
 * @module provider/providerEventLogRecords
 */
import { createHash } from "node:crypto";

import type { ProviderEventLogMode, ProviderRuntimeEvent } from "@ryco/contracts";

import {
  AGENT_CONTROL_SECRET_MARKER,
  redactAgentControlSecretText,
} from "../agentControl/secretRedaction.ts";

export type EventNdjsonStream = "native" | "canonical" | "orchestration";

// ── Files and lines ─────────────────────────────────────────────────────

/** Every file a provider log writer produces: current, rotated, compressed, in-flight. */
export const PROVIDER_EVENT_LOG_FILE_PATTERN = /\.log(?:\.\d+)?(?:\.gz)?(?:\.tmp)?$/;

const NATIVE_FILE_SUFFIX = ".native.log";

/**
 * The native and canonical streams write distinct files. Sharing one path
 * would put two sinks (with independent byte counters) on the same file,
 * interleaving streams and breaking rotation accounting.
 */
export function providerEventLogFileName(threadSegment: string, stream: EventNdjsonStream): string {
  return `${threadSegment}${stream === "native" ? NATIVE_FILE_SUFFIX : ".log"}`;
}

/** The live (unrotated) canonical file of a thread: its most recent runtime events. */
export function isCurrentCanonicalProviderEventLog(fileName: string): boolean {
  return fileName.endsWith(".log") && !fileName.endsWith(NATIVE_FILE_SUFFIX);
}

export function providerEventLogStreamLabel(stream: EventNdjsonStream): string {
  return stream === "native" ? "NTIVE" : "CANON";
}

export function formatProviderEventLogLine(label: string, observedAtMs: number, json: string) {
  return `[${new Date(observedAtMs).toISOString()}] ${label}: ${json}\n`;
}

const LOG_LINE_PREFIX = /^\[([^\]]+)\] ([A-Z]+): /;

export interface ParsedProviderEventLogLine {
  readonly observedAt: string;
  readonly label: string;
  readonly record: unknown;
}

/** Parses one written line; `null` for fragments, foreign lines and malformed JSON. */
export function parseProviderEventLogLine(line: string): ParsedProviderEventLogLine | null {
  const match = LOG_LINE_PREFIX.exec(line);
  if (!match?.[1] || !match[2]) return null;
  try {
    return {
      observedAt: match[1],
      label: match[2],
      record: JSON.parse(line.slice(match[0].length)),
    };
  } catch {
    return null;
  }
}

// ── Detail levels ───────────────────────────────────────────────────────

/**
 * Canonical events kept at `lifecycle`: what a support engineer needs to
 * reconstruct a session (start/stop, turn boundaries, requests, task
 * boundaries, warnings and errors) without content, deltas or progress ticks.
 */
const CANONICAL_LIFECYCLE_TYPES: ReadonlySet<string> = new Set<ProviderRuntimeEvent["type"]>([
  "session.started",
  "session.configured",
  "session.state.changed",
  "session.exited",
  "thread.started",
  "thread.state.changed",
  "thread.realtime.started",
  "thread.realtime.error",
  "thread.realtime.closed",
  "turn.started",
  "turn.completed",
  "turn.aborted",
  "request.opened",
  "request.resolved",
  "user-input.requested",
  "user-input.resolved",
  "task.started",
  "task.completed",
  "subagent.started",
  "subagent.completed",
  "hook.started",
  "hook.completed",
  "auth.status",
  "mcp.status.updated",
  "mcp.oauth.completed",
  "model.rerouted",
  "config.warning",
  "deprecation.notice",
  "tool.denied",
  "runtime.warning",
  "runtime.error",
]);

/** Native envelope kinds that are lifecycle by construction (Codex, ACP request logs). */
const NATIVE_LIFECYCLE_KINDS: ReadonlySet<string> = new Set(["session", "request", "error"]);

/**
 * Native method / event-type names are provider-specific (`turn/completed`,
 * `claude/system/init`, `claude/result/success`, `session.idle`, …); a name
 * counts as lifecycle when one of its segments is a lifecycle word and none of
 * it names a stream, progress tick or item payload.
 */
const NATIVE_LIFECYCLE_NAME =
  /(?:^|[/._])(?:init|start|started|end|ended|complete|completed|created|idle|exit|exited|abort|aborted|interrupted|result|retry|compact|error|failed|failure)(?:$|[/._])/i;
const NATIVE_STREAMING_NAME = /delta|progress|stream_event|token|rate_?limit|item/i;

/** Whether `lifecycle` keeps this record. `full` keeps everything; `off` nothing. */
export function isLifecycleProviderEventRecord(
  stream: EventNdjsonStream,
  record: unknown,
): boolean {
  if (!isRecord(record)) return false;
  if (stream !== "native") {
    return typeof record.type === "string" && CANONICAL_LIFECYCLE_TYPES.has(record.type);
  }
  const envelope = nativeEnvelope(record);
  if (typeof envelope.kind === "string" && NATIVE_LIFECYCLE_KINDS.has(envelope.kind)) {
    return true;
  }
  const name = nativeRecordName(envelope);
  return (
    name !== undefined && NATIVE_LIFECYCLE_NAME.test(name) && !NATIVE_STREAMING_NAME.test(name)
  );
}

/** Native records with no diagnostic value at any level: token counters and keep-alives. */
const NATIVE_NOISE_NAMES: ReadonlySet<string> = new Set([
  "claude/system/thinking_tokens",
  "claude/stream_event/ping",
]);

export function shouldWriteProviderEventRecord(
  mode: ProviderEventLogMode,
  stream: EventNdjsonStream,
  record: unknown,
): boolean {
  switch (mode) {
    case "off":
      return false;
    case "lifecycle":
      return isLifecycleProviderEventRecord(stream, record);
    case "full": {
      if (stream !== "native" || !isRecord(record)) return true;
      const name = nativeRecordName(nativeEnvelope(record));
      return name === undefined || !NATIVE_NOISE_NAMES.has(name);
    }
  }
}

// ── Streaming deltas ────────────────────────────────────────────────────

export interface ProviderEventDelta {
  /** Records with the same key belong to one content stream and coalesce into one run. */
  readonly key: string;
  readonly text: string;
}

const CLAUDE_CONTENT_DELTA_METHOD = "claude/stream_event/content_block_delta";
const CODEX_DELTA_METHOD = /(?:\/delta|Delta)$/;

/**
 * Recognises a streaming-delta record: canonical `*.delta` events with a
 * string `payload.delta`, Claude `content_block_delta` stream events and
 * Codex `…/delta` / `…Delta` notifications. Anything else is `undefined`.
 */
export function extractProviderEventDelta(
  stream: EventNdjsonStream,
  record: unknown,
): ProviderEventDelta | undefined {
  if (!isRecord(record)) return undefined;
  if (stream !== "native") {
    const type = record.type;
    const payload = asRecord(record.payload);
    if (typeof type !== "string" || !type.endsWith(".delta") || !payload) return undefined;
    if (typeof payload.delta !== "string") return undefined;
    return {
      key: deltaKey(
        type,
        record.turnId,
        record.itemId,
        payload.subagentId,
        payload.providerMessageId,
        payload.role,
        payload.streamKind,
        payload.contentIndex,
        payload.summaryIndex,
      ),
      text: payload.delta,
    };
  }

  const envelope = nativeEnvelope(record);
  const method = envelope.method;
  if (typeof method !== "string") return undefined;
  const payload = asRecord(envelope.payload);
  if (method.startsWith(CLAUDE_CONTENT_DELTA_METHOD)) {
    const streamEvent = asRecord(payload?.event);
    const delta = asRecord(streamEvent?.delta);
    const text = firstString(delta?.text, delta?.thinking, delta?.partial_json, delta?.signature);
    if (text === undefined) return undefined;
    return {
      key: deltaKey(method, envelope.turnId, payload?.parent_tool_use_id, streamEvent?.index),
      text,
    };
  }
  if (CODEX_DELTA_METHOD.test(method)) {
    const text = firstString(envelope.textDelta, payload?.delta);
    if (text === undefined) return undefined;
    return {
      key: deltaKey(
        method,
        envelope.turnId,
        envelope.itemId ?? payload?.itemId,
        payload?.contentIndex,
        payload?.summaryIndex,
      ),
      text,
    };
  }
  return undefined;
}

export interface ProviderEventDeltaRun {
  /** The run's first delta record; it identifies the stream. */
  readonly first: unknown;
  readonly firstAtMs: number;
  readonly lastAtMs: number;
  readonly count: number;
  readonly text: string;
}

/**
 * One record standing for a run of consecutive deltas of the same stream:
 * the identifying fields of the first delta, the count and time span, and
 * the concatenated text.
 */
export function providerEventDeltaRunRecord(
  stream: EventNdjsonStream,
  run: ProviderEventDeltaRun,
): Record<string, unknown> {
  const summary = {
    kind: "delta-run",
    count: run.count,
    chars: run.text.length,
    firstAt: new Date(run.firstAtMs).toISOString(),
    lastAt: new Date(run.lastAtMs).toISOString(),
  };
  const first = asRecord(run.first) ?? {};
  if (stream !== "native") {
    const { delta: _delta, ...payload } = asRecord(first.payload) ?? {};
    return {
      type: first.type,
      ...summary,
      provider: first.provider,
      providerInstanceId: first.providerInstanceId,
      threadId: first.threadId,
      turnId: first.turnId,
      itemId: first.itemId,
      payload: { ...payload, delta: run.text },
    };
  }

  const envelope = nativeEnvelope(first);
  const payload = asRecord(envelope.payload);
  return {
    observedAt: summary.firstAt,
    event: {
      ...summary,
      provider: envelope.provider,
      method: envelope.method,
      threadId: envelope.threadId,
      turnId: envelope.turnId,
      itemId: envelope.itemId ?? payload?.itemId,
      index: asRecord(payload?.event)?.index,
      contentIndex: payload?.contentIndex,
      summaryIndex: payload?.summaryIndex,
      parentToolUseId: payload?.parent_tool_use_id,
      text: run.text,
    },
  };
}

// ── Serialization ───────────────────────────────────────────────────────

/** Longest string written verbatim; delta runs are cut at this length too. */
export const PROVIDER_EVENT_LOG_STRING_CAP = 8_192;
const STRING_HEAD_CHARS = 6_144;
const STRING_TAIL_CHARS = 1_024;
const BASE64_SAMPLE_CHARS = 512;
const DATA_URL_PREFIX = /^data:([^;,]*)(?:;[^;,]*)*;base64,/;
const BASE64_SAMPLE = /^[A-Za-z0-9+/_-]+={0,2}$/;

/**
 * Serializes one record for `stream` (see the module notes). Returns
 * `undefined` for values JSON cannot represent; throws like `JSON.stringify`
 * on cycles and BigInts.
 */
export function serializeProviderEventLogRecord(
  stream: EventNdjsonStream,
  record: unknown,
): string | undefined {
  const value = stream === "native" ? record : withRawReference(record);
  // Fast path: without the token marker there is nothing to redact, and a
  // record with no over-cap string needs no capping, so the plain
  // (replacer-free, several times faster) serialization is already final. A
  // short record cannot hold an over-cap string; a long one (large workflow
  // progress, Codex items) is checked with an allocation-free walk.
  const plain = JSON.stringify(value) as string | undefined;
  if (
    plain === undefined ||
    (!plain.includes(AGENT_CONTROL_SECRET_MARKER) &&
      (plain.length <= PROVIDER_EVENT_LOG_STRING_CAP || !containsOverCapString(value, 0)))
  ) {
    return plain;
  }
  return JSON.stringify(value, capLogValue) as string | undefined;
}

/** Nesting past which the walk stops looking and lets the replacer decide. */
const OVER_CAP_WALK_MAX_DEPTH = 64;

/**
 * Whether any string reachable in `value` exceeds the cap. Only called after
 * `JSON.stringify` succeeded, so the value has no cycles.
 */
function containsOverCapString(value: unknown, depth: number): boolean {
  if (typeof value === "string") return value.length > PROVIDER_EVENT_LOG_STRING_CAP;
  if (typeof value !== "object" || value === null) return false;
  if (
    depth >= OVER_CAP_WALK_MAX_DEPTH ||
    typeof (value as { toJSON?: unknown }).toJSON === "function"
  ) {
    // Too deep to finish cheaply, or serialized through `toJSON` (whose output
    // the walk cannot see): take the capping path.
    return true;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (containsOverCapString(entry, depth + 1)) return true;
    }
    return false;
  }
  const record = value as Record<string, unknown>;
  for (const key in record) {
    if (Object.hasOwn(record, key) && containsOverCapString(record[key], depth + 1)) return true;
  }
  return false;
}

/** Redacts secrets, then bounds the string (inline base64 becomes a size + digest marker). */
export function capProviderEventLogString(value: string): string {
  const redacted = redactAgentControlSecretText(value);
  if (redacted.length <= PROVIDER_EVENT_LOG_STRING_CAP) return redacted;
  const binary = summarizeInlineBase64(redacted);
  if (binary !== undefined) return binary;
  const omitted = redacted.length - STRING_HEAD_CHARS - STRING_TAIL_CHARS;
  return `${redacted.slice(0, STRING_HEAD_CHARS)}…[${omitted} chars omitted]…${redacted.slice(-STRING_TAIL_CHARS)}`;
}

function capLogValue(_key: string, value: unknown): unknown {
  return typeof value === "string" ? capProviderEventLogString(value) : value;
}

function summarizeInlineBase64(value: string): string | undefined {
  let mime: string | undefined;
  if (value.startsWith("data:")) {
    const match = DATA_URL_PREFIX.exec(value.slice(0, 256));
    if (!match) return undefined;
    mime = match[1] || "unknown";
  } else if (
    !BASE64_SAMPLE.test(value.slice(0, BASE64_SAMPLE_CHARS)) ||
    !BASE64_SAMPLE.test(value.slice(-64))
  ) {
    return undefined;
  }
  const digest = createHash("sha256").update(value).digest("hex").slice(0, 16);
  return `[inline base64 omitted${mime === undefined ? "" : ` mime=${mime}`} chars=${value.length} sha256=${digest}]`;
}

/**
 * Canonical `raw.payload` is the full provider message the native log already
 * holds (and, for Claude task progress, the same message on every fan-out
 * event). Keep only what finds it there.
 */
function withRawReference(record: unknown): unknown {
  if (!isRecord(record)) return record;
  const raw = asRecord(record.raw);
  if (!raw || raw.payload === undefined) return record;
  const payload = asRecord(raw.payload);
  return {
    ...record,
    raw: {
      source: raw.source,
      method: raw.method,
      messageType: raw.messageType,
      nativeId: firstString(payload?.uuid, payload?.id),
    },
  };
}

// ── Helpers ─────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function firstString(...values: ReadonlyArray<unknown>): string | undefined {
  for (const value of values) {
    if (typeof value === "string") return value;
  }
  return undefined;
}

/** Native records are either the envelope itself (Codex) or `{ observedAt, event }`. */
function nativeEnvelope(record: Record<string, unknown>): Record<string, unknown> {
  return asRecord(record.event) ?? record;
}

function nativeRecordName(envelope: Record<string, unknown>): string | undefined {
  return firstString(envelope.method, envelope.type);
}

function deltaKey(...parts: ReadonlyArray<unknown>): string {
  return parts
    .map((part) => (part === undefined || part === null ? "" : String(part)))
    .join("\u0000");
}
