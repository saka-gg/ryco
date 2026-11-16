import { SchemaIssue, Schema } from "effect";

import type { ProjectionRepositoryError } from "../persistence/Errors.ts";

/** Retryable admission failure: no command receipt is rejected or consumed. */
export class OrchestrationCommandAdmissionError extends Schema.TaggedError<OrchestrationCommandAdmissionError>()(
  "OrchestrationCommandAdmissionError",
  { detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}

/**
 * A model switch (a context handoff, or a change that restarts the session) refused while the
 * thread's runtime still runs native background work that replacing the runtime would end.
 * Retryable like an admission failure: no command receipt is rejected or consumed, so the same
 * command can be sent again (see `ModelSwitchBlockedByBackgroundWork`).
 */
export class OrchestrationModelSwitchBlockedError extends Schema.TaggedError<OrchestrationModelSwitchBlockedError>()(
  "OrchestrationModelSwitchBlockedError",
  { threadId: Schema.String, taskIds: Schema.Array(Schema.String) },
) {
  override get message(): string {
    return "This thread still has background tasks running, and switching the model now would stop them. Stop the tasks or wait for them to finish, then send again.";
  }
}

export class OrchestrationCommandInvariantError extends Schema.TaggedError<OrchestrationCommandInvariantError>()(
  "OrchestrationCommandInvariantError",
  {
    commandType: Schema.String,
    detail: Schema.String,
    /**
     * Set when only a compare-and-swap field of a valid command no longer held: the caller lost
     * a race to a newer write (see `isBranchPreconditionFailure`), it did not send a bad command.
     */
    failedPrecondition: Schema.optional(Schema.Literal("expectedBranch")),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Orchestration command invariant failed (${this.commandType}): ${this.detail}`;
  }
}

export class OrchestrationCommandPreviouslyRejectedError extends Schema.TaggedError<OrchestrationCommandPreviouslyRejectedError>()(
  "OrchestrationCommandPreviouslyRejectedError",
  {
    commandId: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Command previously rejected (${this.commandId}): ${this.detail}`;
  }
}

/**
 * A rejection the engine repeats for the same command, so retrying is pointless. Matches the
 * engine error bare (engine.dispatch) or wrapped as the `cause` of a dispatch error (command
 * application).
 */
export function isSettledDispatchRejection(error: unknown): boolean {
  const tagOf = (value: unknown) =>
    value !== null && typeof value === "object" && "_tag" in value
      ? (value as { readonly _tag?: unknown })._tag
      : undefined;
  const settled = (value: unknown) => {
    const tag = tagOf(value);
    return (
      tag === "OrchestrationCommandInvariantError" ||
      tag === "OrchestrationCommandPreviouslyRejectedError"
    );
  };
  const cause =
    error !== null && typeof error === "object" && "cause" in error
      ? (error as { readonly cause?: unknown }).cause
      : undefined;
  return settled(error) || settled(cause);
}

export class OrchestrationProjectorDecodeError extends Schema.TaggedError<OrchestrationProjectorDecodeError>()(
  "OrchestrationProjectorDecodeError",
  {
    eventType: Schema.String,
    issue: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Projector decode failed for ${this.eventType}: ${this.issue}`;
  }
}

export class OrchestrationListenerCallbackError extends Schema.TaggedError<OrchestrationListenerCallbackError>()(
  "OrchestrationListenerCallbackError",
  {
    listener: Schema.Literals(["read-model", "domain-event"]),
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Orchestration ${this.listener} listener failed: ${this.detail}`;
  }
}

export type OrchestrationDispatchError =
  | OrchestrationCommandAdmissionError
  | OrchestrationModelSwitchBlockedError
  | ProjectionRepositoryError
  | OrchestrationCommandInvariantError
  | OrchestrationCommandPreviouslyRejectedError
  | OrchestrationProjectorDecodeError
  | OrchestrationListenerCallbackError;

export function toProjectorDecodeError(eventType: string) {
  return (error: Schema.SchemaError): OrchestrationProjectorDecodeError =>
    new OrchestrationProjectorDecodeError({
      eventType,
      issue: SchemaIssue.makeFormatterDefault()(error.issue),
      cause: error,
    });
}
