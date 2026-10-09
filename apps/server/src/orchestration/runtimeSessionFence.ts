/**
 * The runtime fence of provider-originated session updates.
 *
 * Runtime ingestion checks an event's runtime against the thread before it
 * dispatches, but a server-decided transition (a restart binding a new runtime,
 * an explicit stop) can commit in between. The session-set it derives therefore
 * carries the runtime it comes from, and the decider, which runs serially on
 * the engine's model, applies it only while the session is still bound to that
 * runtime. A late `session.exited` of a replaced runtime then cannot overwrite
 * its successor and orphan every event the new runtime emits.
 *
 * Pure module: no services, no I/O.
 *
 * @module runtimeSessionFence
 */
import type {
  OrchestrationSession,
  ProviderInstanceId,
  RuntimeSessionId,
  ThreadSessionSetExpectedRuntime,
} from "@ryco/contracts";
import { Cause, Schema } from "effect";

import { OrchestrationCommandInvariantError } from "./Errors.ts";

/** The decider's rejection detail of a session-set whose runtime was replaced. */
export const SUPERSEDED_RUNTIME_SESSION_SET_DETAIL =
  "The provider runtime this session update comes from is no longer bound to the thread.";

/** The fence of an update from the runtime that emitted it (absent identities are null). */
export function expectedRuntimeOf(source: {
  readonly providerInstanceId?: ProviderInstanceId | undefined;
  readonly runtimeSessionId?: RuntimeSessionId | undefined;
}): ThreadSessionSetExpectedRuntime {
  return {
    providerInstanceId: source.providerInstanceId ?? null,
    runtimeSessionId: source.runtimeSessionId ?? null,
  };
}

/** Why a thread's session is not the expected runtime's (as metric labels). */
export type RuntimeSessionMismatch =
  | "missing-active-session"
  | "provider-instance-mismatch"
  | "runtime-session-mismatch";

/** How the thread's current session differs from the expected runtime; null while bound to it. */
export function runtimeSessionMismatch(
  session: OrchestrationSession | null | undefined,
  expected: ThreadSessionSetExpectedRuntime,
): RuntimeSessionMismatch | null {
  if (session == null) return "missing-active-session";
  if ((session.providerInstanceId ?? null) !== expected.providerInstanceId)
    return "provider-instance-mismatch";
  if ((session.runtimeSessionId ?? null) !== expected.runtimeSessionId)
    return "runtime-session-mismatch";
  return null;
}

const isInvariantError = Schema.is(OrchestrationCommandInvariantError);

/** A dispatch failure that only says the update's runtime was replaced: nothing to apply. */
export function isSupersededRuntimeSessionSet(cause: Cause.Cause<unknown>): boolean {
  return (
    cause.reasons.length > 0 &&
    cause.reasons.every(
      (reason) =>
        Cause.isFailReason(reason) &&
        isInvariantError(reason.error) &&
        reason.error.commandType === "thread.session.set" &&
        reason.error.detail === SUPERSEDED_RUNTIME_SESSION_SET_DETAIL,
    )
  );
}
