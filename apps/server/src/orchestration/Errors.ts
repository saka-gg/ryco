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
