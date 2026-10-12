import {
  type EventId,
  OrchestrationGetActivityPayloadError,
  type OrchestrationGetActivityPayloadResult,
  type ThreadId,
} from "@ryco/contracts";
import { Effect, Option } from "effect";

import type { ProjectionSnapshotQueryShape } from "./Services/ProjectionSnapshotQuery.ts";

/**
 * Bounded previews of activity payloads for thread windows and history pages.
 *
 * Tool activities carry command output, MCP results and file diffs: 80-95 % of
 * a thread window, and a single row (a large diff, or a legacy row from before
 * ingestion bounded tool data) can exceed what one relay message carries.
 * Clients that advertise `activityPayloads: "preview"` get each oversized
 * payload reduced to a preview that keeps its structure — keys, numbers,
 * booleans, short strings and the head of long strings and arrays — so every
 * collapsed-row summary (labels, commands, changed files and their stats)
 * still derives from it. The expanded panel fetches the stored payload through
 * `orchestration.getActivityPayload`.
 */

/** Tool lifecycle payloads above this are previewed; their full text is only read on expand. */
export const TOOL_ACTIVITY_PREVIEW_MAX_BYTES = 8 * 1024;
/**
 * Every other activity kind carries structured state clients act on (approvals,
 * questions, plans, tasks), so only a pathological payload is previewed.
 */
export const ACTIVITY_PREVIEW_MAX_BYTES = 64 * 1024;
/**
 * The largest payload `getActivityPayload` returns whole. The hosted relay
 * carries at most 4 MiB per message, before JSON escaping of the RPC envelope
 * and encryption; anything larger is returned as a preview at this size.
 */
export const ACTIVITY_PAYLOAD_RESPONSE_MAX_BYTES = 2 * 1024 * 1024;

const TOOL_ACTIVITY_KINDS: ReadonlySet<string> = new Set([
  "tool.started",
  "tool.updated",
  "tool.completed",
]);

const MAX_DEPTH = 12;
const FALLBACK_TOP_LEVEL_KEYS = 24;
const FALLBACK_STRING_CHARS = 160;
const ELLIPSIS = "…";

interface PreviewLevel {
  readonly stringChars: number;
  readonly arrayItems: number;
}

function previewLevels(maxBytes: number): ReadonlyArray<PreviewLevel> {
  const base = Math.max(64, Math.floor(maxBytes / 4));
  return [
    { stringChars: base, arrayItems: 64 },
    { stringChars: Math.max(64, Math.floor(base / 4)), arrayItems: 16 },
    { stringChars: Math.max(64, Math.floor(base / 16)), arrayItems: 4 },
  ];
}

export function activityPreviewMaxBytes(kind: string): number {
  return TOOL_ACTIVITY_KINDS.has(kind) ? TOOL_ACTIVITY_PREVIEW_MAX_BYTES : ACTIVITY_PREVIEW_MAX_BYTES;
}

function truncateString(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  // Never split a surrogate pair: the preview must stay valid UTF-16.
  let end = maxChars;
  const code = value.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return `${value.slice(0, end)}${ELLIPSIS}`;
}

function previewValue(value: unknown, level: PreviewLevel, depth: number): unknown {
  if (typeof value === "string") return truncateString(value, level.stringChars);
  if (value === null || typeof value !== "object") return value;
  if (depth >= MAX_DEPTH) return Array.isArray(value) ? [] : {};
  if (Array.isArray(value)) {
    const kept = value.length > level.arrayItems ? value.slice(0, level.arrayItems) : value;
    return kept.map((entry) => previewValue(entry, level, depth + 1));
  }
  const next: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    next[key] = previewValue(entry, level, depth + 1);
  }
  return next;
}

/** Top-level scalars only: the last resort for a payload whose structure alone is too large. */
function scalarShell(value: unknown): unknown {
  if (typeof value === "string") return truncateString(value, FALLBACK_STRING_CHARS);
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return Array.isArray(value) ? [] : value;
  }
  const next: Record<string, unknown> = {};
  let kept = 0;
  for (const [key, entry] of Object.entries(value)) {
    if (kept >= FALLBACK_TOP_LEVEL_KEYS) break;
    if (entry !== null && typeof entry === "object") continue;
    next[key] = typeof entry === "string" ? truncateString(entry, FALLBACK_STRING_CHARS) : entry;
    kept += 1;
  }
  return next;
}

export function jsonByteLength(value: unknown): number {
  const json = JSON.stringify(value);
  return json === undefined ? 0 : Buffer.byteLength(json, "utf8");
}

export interface ActivityPayloadPreview {
  /** The payload to send: the stored one when it fits, else a bounded preview. */
  readonly payload: unknown;
  /** The encoded size of `payload`. */
  readonly bytes: number;
  /** Whether `payload` is a preview of a larger stored payload. */
  readonly truncated: boolean;
}

/**
 * Returns `payload` when its encoded size (`payloadBytes`, measured by SQLite
 * without parsing) fits `maxBytes`, else the largest preview level that fits.
 */
export function boundPayload(input: {
  readonly payload: unknown;
  readonly payloadBytes: number;
  readonly maxBytes: number;
}): ActivityPayloadPreview {
  if (input.payloadBytes <= input.maxBytes) {
    return { payload: input.payload, bytes: input.payloadBytes, truncated: false };
  }
  for (const level of previewLevels(input.maxBytes)) {
    const preview = previewValue(input.payload, level, 0);
    const bytes = jsonByteLength(preview);
    if (bytes <= input.maxBytes) return { payload: preview, bytes, truncated: true };
  }
  const shell = scalarShell(input.payload);
  return { payload: shell, bytes: jsonByteLength(shell), truncated: true };
}

/** The payload a window sends for one activity: bounded by its kind's preview budget. */
export function previewActivityPayload(input: {
  readonly kind: string;
  readonly payload: unknown;
  readonly payloadBytes: number;
}): ActivityPayloadPreview {
  return boundPayload({ ...input, maxBytes: activityPreviewMaxBytes(input.kind) });
}

/**
 * `orchestration.getActivityPayload`: the stored payload of one activity of an
 * active thread, bounded only by what one response can carry. Unknown threads,
 * deleted threads and activities of other threads all answer `not-found`.
 */
export const loadActivityPayload = (
  query: ProjectionSnapshotQueryShape["getActivityPayload"],
  input: { readonly threadId: ThreadId; readonly activityId: EventId },
): Effect.Effect<OrchestrationGetActivityPayloadResult, OrchestrationGetActivityPayloadError> =>
  Effect.gen(function* () {
    const fail = (reason: "not-found" | "unavailable") =>
      new OrchestrationGetActivityPayloadError({
        reason,
        threadId: input.threadId,
        activityId: input.activityId,
      });
    if (query === undefined) return yield* fail("unavailable");
    const row = yield* query(input).pipe(
      Effect.tapError((cause) =>
        Effect.logWarning("activity payload read failed", {
          threadId: input.threadId,
          activityId: input.activityId,
          cause,
        }),
      ),
      Effect.mapError(() => fail("unavailable")),
    );
    if (Option.isNone(row)) return yield* fail("not-found");
    const bounded = boundPayload({
      payload: row.value.payload,
      payloadBytes: row.value.payloadBytes,
      maxBytes: ACTIVITY_PAYLOAD_RESPONSE_MAX_BYTES,
    });
    return {
      activityId: input.activityId,
      payload: bounded.payload,
      fullBytes: row.value.payloadBytes,
      truncated: bounded.truncated,
    };
  });
