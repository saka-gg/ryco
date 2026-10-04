/**
 * Codex usage-limit detection. Codex reports the account's rate limits as a sparse rolling
 * snapshot and a limit stop as `codexErrorInfo: "usageLimitExceeded"` on the `error`
 * notification and/or the failed `turn/completed`. Everything here reads payloads
 * structurally, so new Codex error literals never drop a notification.
 *
 * @module codexUsageLimits
 */
import {
  EventId,
  type ProviderEvent,
  type ProviderRuntimeEvent,
  type UsageLimitState,
} from "@ryco/contracts";

import { usageLimitStateFromWindows, type UsageWindowObservation } from "../usageLimitReset.ts";

export const CODEX_USAGE_LIMIT_FALLBACK_MESSAGE = "Codex usage limit reached.";

export type CodexRateLimitSnapshot = Readonly<Record<string, unknown>>;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Codex's rolling update is sparse: a present value overrides the previous one, while
 * null or absent never clears it. Window objects merge the same way one level down.
 */
export function mergeCodexRateLimitSnapshot(
  previous: CodexRateLimitSnapshot | undefined,
  update: unknown,
): CodexRateLimitSnapshot | undefined {
  const next = asRecord(update);
  if (!next) return previous;
  const merged: Record<string, unknown> = { ...previous };
  for (const [key, value] of Object.entries(next)) {
    if (value === null || value === undefined) continue;
    const before = asRecord(merged[key]);
    const after = asRecord(value);
    if (before && after) {
      const window: Record<string, unknown> = { ...before };
      for (const [field, fieldValue] of Object.entries(after)) {
        if (fieldValue !== null && fieldValue !== undefined) window[field] = fieldValue;
      }
      merged[key] = window;
    } else {
      merged[key] = value;
    }
  }
  return merged;
}

function readWindow(value: unknown): UsageWindowObservation | undefined {
  const window = asRecord(value);
  const usedPercent = window?.usedPercent;
  if (typeof usedPercent !== "number" || !Number.isFinite(usedPercent)) return undefined;
  const resetsAt = window?.resetsAt;
  return {
    exhausted: usedPercent >= 100,
    resetAtMs: typeof resetsAt === "number" && Number.isFinite(resetsAt) ? resetsAt * 1000 : null,
  };
}

export function codexUsageLimitState(
  snapshot: CodexRateLimitSnapshot | undefined,
  nowMs: number,
): UsageLimitState {
  const windows = [readWindow(snapshot?.primary), readWindow(snapshot?.secondary)].filter(
    (window): window is UsageWindowObservation => window !== undefined,
  );
  return usageLimitStateFromWindows(windows, nowMs);
}

/** `"usageLimitExceeded"` → itself; `{ httpConnectionFailed: {...} }` → its single key. */
export function codexErrorInfoCode(info: unknown): string | undefined {
  if (typeof info === "string") return info.length > 0 ? info : undefined;
  const record = asRecord(info);
  if (!record) return undefined;
  const keys = Object.keys(record);
  return keys.length === 1 ? keys[0] : undefined;
}

/**
 * `usageLimitExceeded` is a limit. `rateLimitExceeded` is not in the pinned schema; it
 * counts only while the account snapshot is exhausted, so a transient 429 stays an error.
 */
export function isCodexUsageLimitError(
  code: string | undefined,
  state: Pick<UsageLimitState, "exhausted">,
): boolean {
  if (code === "usageLimitExceeded") return true;
  if (code === "rateLimitExceeded") return state.exhausted;
  return false;
}

function readTurnError(payload: unknown): { readonly code?: string; readonly message?: string } {
  const turn = asRecord(asRecord(payload)?.turn);
  const error = asRecord(turn?.error);
  if (!error) return {};
  const message = typeof error.message === "string" ? error.message.trim() : "";
  const code = codexErrorInfoCode(error.codexErrorInfo);
  return {
    ...(code !== undefined ? { code } : {}),
    ...(message.length > 0 ? { message } : {}),
  };
}

export interface CodexUsageLimitTracker {
  readonly annotate: (
    event: ProviderEvent,
    mapped: ReadonlyArray<ProviderRuntimeEvent>,
    nowMs?: number,
  ) => ReadonlyArray<ProviderRuntimeEvent>;
}

/** Per-session state: the merged rate-limit snapshot and turns already reported as limited. */
export function makeCodexUsageLimitTracker(): CodexUsageLimitTracker {
  let snapshot: CodexRateLimitSnapshot | undefined;
  const announcedTurnIds = new Set<string>();

  const annotate: CodexUsageLimitTracker["annotate"] = (event, mapped, nowMs = Date.now()) => {
    if (event.method === "account/rateLimits/updated") {
      snapshot = mergeCodexRateLimitSnapshot(snapshot, asRecord(event.payload)?.rateLimits);
      const usageLimitState = codexUsageLimitState(snapshot, nowMs);
      return mapped.map((runtimeEvent) =>
        runtimeEvent.type === "account.rate-limits.updated"
          ? { ...runtimeEvent, payload: { ...runtimeEvent.payload, usageLimitState } }
          : runtimeEvent,
      );
    }

    if (event.method === "error") {
      const payload = asRecord(event.payload);
      if (payload?.willRetry === true) return mapped;
      const code = codexErrorInfoCode(asRecord(payload?.error)?.codexErrorInfo);
      const state = codexUsageLimitState(snapshot, nowMs);
      if (!isCodexUsageLimitError(code, state)) return mapped;
      return mapped.map((runtimeEvent) => {
        if (runtimeEvent.type !== "runtime.error") return runtimeEvent;
        if (runtimeEvent.turnId !== undefined) announcedTurnIds.add(runtimeEvent.turnId);
        return {
          ...runtimeEvent,
          payload: {
            ...runtimeEvent.payload,
            class: "usage_limit" as const,
            resetAt: state.exhausted ? state.resetAt : null,
          },
        };
      });
    }

    if (event.method === "turn/completed") {
      const completed = mapped.find(
        (runtimeEvent): runtimeEvent is Extract<ProviderRuntimeEvent, { type: "turn.completed" }> =>
          runtimeEvent.type === "turn.completed",
      );
      if (!completed) return mapped;
      const turnId = completed.turnId;
      const alreadyAnnounced = turnId !== undefined && announcedTurnIds.has(turnId);
      if (turnId !== undefined) announcedTurnIds.delete(turnId);
      if (completed.payload.state !== "failed" || alreadyAnnounced) return mapped;
      const turnError = readTurnError(event.payload);
      const state = codexUsageLimitState(snapshot, nowMs);
      if (!isCodexUsageLimitError(turnError.code, state)) return mapped;
      const { type: _type, payload: _payload, ...base } = completed;
      const synthesized: ProviderRuntimeEvent = {
        ...base,
        eventId: EventId.make(`${completed.eventId}:usage-limit`),
        type: "runtime.error",
        payload: {
          message: turnError.message ?? CODEX_USAGE_LIMIT_FALLBACK_MESSAGE,
          class: "usage_limit",
          resetAt: state.exhausted ? state.resetAt : null,
        },
      };
      return [synthesized, ...mapped];
    }

    return mapped;
  };

  return { annotate };
}
