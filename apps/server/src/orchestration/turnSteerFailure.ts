/**
 * Classifies why a provider did not take a steer. A turn that already ended (or a provider that
 * cannot take the steer right now) defers: the message stays queued and is sent as the next
 * turn. Anything else is a real failure. Pure module: no services, no I/O.
 */
import type { TurnSteerRejectionReason } from "@ryco/contracts";
import { truncateUnicodeSafe } from "@ryco/shared/String";
import { Cause, Schema } from "effect";

import {
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  ProviderSessionNotFoundError,
  ProviderTurnNotSteerableError,
} from "../provider/Errors.ts";

export const TURN_STEER_ERROR_MAX_CHARS = 1_000;
export const TURN_STEER_SESSION_ENDED_DETAIL =
  "The turn already finished. The message stays queued and is sent next.";
export const TURN_STEER_FAILED_FALLBACK = "Provider rejected turn steering.";

export interface TurnSteerFailureClassification {
  readonly reason: TurnSteerRejectionReason;
  readonly error: string;
}

function bounded(text: string, fallback: string): string {
  const trimmed = truncateUnicodeSafe(text.trim(), TURN_STEER_ERROR_MAX_CHARS).trimEnd();
  return trimmed.length > 0 ? trimmed : fallback;
}

export function classifyTurnSteerFailure(
  cause: Cause.Cause<unknown>,
  formatFailed: (cause: Cause.Cause<unknown>) => string,
): TurnSteerFailureClassification {
  const failure = cause.reasons.find(Cause.isFailReason)?.error;
  if (Schema.is(ProviderTurnNotSteerableError)(failure)) {
    return { reason: "deferred", error: bounded(failure.detail, TURN_STEER_SESSION_ENDED_DETAIL) };
  }
  if (
    Schema.is(ProviderSessionNotFoundError)(failure) ||
    Schema.is(ProviderAdapterSessionNotFoundError)(failure) ||
    Schema.is(ProviderAdapterSessionClosedError)(failure)
  ) {
    return { reason: "deferred", error: TURN_STEER_SESSION_ENDED_DETAIL };
  }
  return { reason: "failed", error: bounded(formatFailed(cause), TURN_STEER_FAILED_FALLBACK) };
}
