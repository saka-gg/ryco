import {
  type ProviderApprovalDecision,
  type ProviderDriverKind,
  type ThreadId,
} from "@ryco/contracts";
import { Cause, Effect, Option, Schema } from "effect";
import * as EffectAcpErrors from "effect-acp/errors";

import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  type ProviderAdapterError,
} from "../Errors.ts";

export function mapAcpToAdapterError(
  provider: ProviderDriverKind,
  threadId: ThreadId,
  method: string,
  error: EffectAcpErrors.AcpError,
): ProviderAdapterError {
  if (Schema.is(EffectAcpErrors.AcpProcessExitedError)(error)) {
    return new ProviderAdapterSessionClosedError({
      provider,
      threadId,
      cause: error,
    });
  }
  if (Schema.is(EffectAcpErrors.AcpRequestError)(error)) {
    return new ProviderAdapterRequestError({
      provider,
      method,
      detail: error.message,
      cause: error,
    });
  }
  return new ProviderAdapterRequestError({
    provider,
    method,
    detail: Schema.is(EffectAcpErrors.AcpTransportError)(error) ? error.detail : error.message,
    cause: error,
  });
}

export function acpPermissionOutcome(decision: ProviderApprovalDecision): string {
  switch (decision) {
    case "acceptForSession":
      return "allow-always";
    case "accept":
      return "allow-once";
    case "decline":
    default:
      return "reject-once";
  }
}

const STARTED_TURN_FAILURE_FALLBACK_MESSAGE = "Provider turn failed";

function nonEmptyTrimmed(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Human-readable message for a started turn's failure: the adapter error's
 * `detail`/`issue`/`message`, then `Cause.pretty`, never empty (the runtime
 * `turn.completed.errorMessage` must be a non-empty trimmed string).
 */
export function startedTurnFailureMessage(cause: Cause.Cause<unknown>): string {
  const error = Option.getOrUndefined(Cause.findErrorOption(cause));
  const fromError =
    typeof error === "object" && error !== null
      ? (nonEmptyTrimmed((error as { readonly detail?: unknown }).detail) ??
        nonEmptyTrimmed((error as { readonly issue?: unknown }).issue) ??
        nonEmptyTrimmed((error as { readonly message?: unknown }).message))
      : nonEmptyTrimmed(error);
  return fromError ?? nonEmptyTrimmed(Cause.pretty(cause)) ?? STARTED_TURN_FAILURE_FALLBACK_MESSAGE;
}

/**
 * Close a started turn when the rest of the send fails: emit one
 * `turn.completed {state: "failed"}` for the turn whose `turn.started` was already
 * offered, so ingestion settles it on the same runtime stream no matter how it races
 * the command reactor. Interrupt-only causes and turns whose terminal was already
 * emitted are skipped. Emission failures are ignored and the original failure is
 * re-raised unchanged.
 */
export function failStartedTurnOnError(input: {
  readonly isTerminalEmitted: () => boolean;
  readonly emitFailed: (errorMessage: string) => Effect.Effect<void>;
}): <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R> {
  return (effect) =>
    Effect.onError(effect, (cause) =>
      Cause.hasInterruptsOnly(cause) || input.isTerminalEmitted()
        ? Effect.void
        : input
            .emitFailed(startedTurnFailureMessage(cause))
            .pipe(Effect.catchCause(() => Effect.void)),
    );
}
