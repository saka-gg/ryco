import { Schema } from "effect";

// ===============================
// Agent Control Domain Errors
// ===============================

/**
 * The Agent Control feature gate is off (or unreadable — the gate fails
 * closed). Every Agent Control entry point surfaces this instead of
 * partially working while disabled.
 */
export class AgentControlDisabledError extends Schema.TaggedError<AgentControlDisabledError>()(
  "AgentControlDisabledError",
  {
    operation: Schema.String,
  },
) {
  override get message(): string {
    return `Agent Control is disabled: ${this.operation} refused`;
  }
}

export class AgentControlCapabilityDeniedError extends Schema.TaggedError<AgentControlCapabilityDeniedError>()(
  "AgentControlCapabilityDeniedError",
  {
    operation: Schema.String,
    capability: Schema.String,
  },
) {
  override get message(): string {
    return `Agent Control capability ${this.capability} denied in ${this.operation}`;
  }
}

/**
 * The caller reused a request id with a different plan. The original
 * proposal is never modified; the caller must issue a new request id.
 */
export class AgentControlDuplicateRequestError extends Schema.TaggedError<AgentControlDuplicateRequestError>()(
  "AgentControlDuplicateRequestError",
  {
    requestId: Schema.String,
    existingProposalId: Schema.NullOr(Schema.String),
    requestedPlanDigest: Schema.String,
    existingPlanDigest: Schema.NullOr(Schema.String),
  },
) {
  override get message(): string {
    return `Agent Control request ${this.requestId} was already used with a different plan`;
  }
}

export class AgentControlProposalNotFoundError extends Schema.TaggedError<AgentControlProposalNotFoundError>()(
  "AgentControlProposalNotFoundError",
  {
    proposalId: Schema.String,
  },
) {
  override get message(): string {
    return `Agent Control proposal ${this.proposalId} was not found`;
  }
}

export class AgentControlOperationNotFoundError extends Schema.TaggedError<AgentControlOperationNotFoundError>()(
  "AgentControlOperationNotFoundError",
  {
    operationId: Schema.String,
  },
) {
  override get message(): string {
    return `Agent Control operation ${this.operationId} was not found`;
  }
}

/**
 * A state transition outside the legal transition table (or by an actor
 * that is not permitted to perform it) was rejected. Also raised when a
 * compare-and-set loses a race and the re-read state no longer permits the
 * transition — the winner's state stands.
 */
export class AgentControlInvalidTransitionError extends Schema.TaggedError<AgentControlInvalidTransitionError>()(
  "AgentControlInvalidTransitionError",
  {
    entity: Schema.Literals(["proposal", "operation"]),
    from: Schema.String,
    to: Schema.String,
    actor: Schema.String,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `Illegal Agent Control ${this.entity} transition ${this.from} -> ${this.to} by ${this.actor}: ${this.detail}`;
  }
}

/** The proposal's expiry passed before it could be decided or executed. */
export class AgentControlProposalExpiredError extends Schema.TaggedError<AgentControlProposalExpiredError>()(
  "AgentControlProposalExpiredError",
  {
    proposalId: Schema.String,
    expiresAt: Schema.String,
  },
) {
  override get message(): string {
    return `Agent Control proposal ${this.proposalId} expired at ${this.expiresAt}`;
  }
}

/**
 * An internal MCP request presented no usable credential. `unknown`
 * deliberately covers revoked, expired, and never-issued tokens alike —
 * a caller cannot distinguish "this credential existed once" from "this
 * credential never existed". The raw credential never appears here.
 */
export class AgentControlMcpAuthError extends Schema.TaggedError<AgentControlMcpAuthError>()(
  "AgentControlMcpAuthError",
  {
    reason: Schema.Literals(["missing", "malformed", "unknown"]),
  },
) {
  override get message(): string {
    return `Agent Control MCP credential rejected: ${this.reason}`;
  }
}

/** One-shot stdio bootstrap material was absent, malformed, expired, or already consumed. */
export class AgentControlBootstrapError extends Schema.TaggedError<AgentControlBootstrapError>()(
  "AgentControlBootstrapError",
  {
    reason: Schema.Literals(["malformed", "unknown", "expired"]),
  },
) {}

/**
 * Exact-turn write authority could not be bound or exercised. Raised by
 * the session registry's lease API; consumed by the proposal-backed
 * mutation slice.
 */
export class AgentControlTurnAuthorityError extends Schema.TaggedError<AgentControlTurnAuthorityError>()(
  "AgentControlTurnAuthorityError",
  {
    reason: Schema.Literals(["session-unknown", "authority-retired", "turn-mismatch"]),
  },
) {
  override get message(): string {
    return `Agent Control turn authority refused: ${this.reason}`;
  }
}

/** A proposal plan failed server-side scope, availability, or stale-state validation. */
export class AgentControlPlanValidationError extends Schema.TaggedError<AgentControlPlanValidationError>()(
  "AgentControlPlanValidationError",
  {
    reason: Schema.Literals([
      "caller-stale",
      "project-scope",
      "project-unavailable",
      "project-stale",
      "thread-unavailable",
      "thread-stale",
      "provider-unavailable",
      "model-unavailable",
      "invalid-options",
      "invalid-plan",
      "privilege-escalation",
      "worktree-escalation",
      "worktree-preflight",
      "settings-unsupported",
      "automation-unavailable",
      "automation-stale",
      "automation-limit",
      "schedule-invalid",
      "artifact-unavailable",
    ]),
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `Agent Control plan validation failed (${this.reason}): ${this.detail}`;
  }
}

/**
 * Settings changes require fresh owner reauthentication evidence at both
 * approval and execution. The node server cannot currently obtain or persist
 * that evidence, so settings proposal approval fails closed.
 */
export class AgentControlSettingsChangeUnsupportedError extends Schema.TaggedError<AgentControlSettingsChangeUnsupportedError>()(
  "AgentControlSettingsChangeUnsupportedError",
  {
    detail: Schema.String,
  },
) {
  override get message(): string {
    return this.detail;
  }
}

export class AgentControlExternalIntegrationError extends Schema.TaggedError<AgentControlExternalIntegrationError>()(
  "AgentControlExternalIntegrationError",
  {
    reason: Schema.Literals([
      "not-found",
      "topology-unavailable",
      "revoked",
      "expired",
      "pairing-refused",
      "credential-refused",
      "audience-refused",
      "project-denied",
      "capability-denied",
      "rate-limited",
      "capacity-exhausted",
      "task-not-found",
      "task-conflict",
      "storage",
    ]),
  },
) {
  override get message(): string {
    return `External Agent Control integration refused: ${this.reason}`;
  }
}

export class AgentControlMcpInstallationError extends Schema.TaggedError<AgentControlMcpInstallationError>()(
  "AgentControlMcpInstallationError",
  {
    reason: Schema.Literals([
      "not-found",
      "unsupported",
      "conflict",
      "storage",
      "provider",
      "verification",
    ]),
    detail: Schema.String,
  },
) {
  override get message(): string {
    return this.detail;
  }
}

/** Bounded operational read failure; deliberately carries no underlying payload. */
export class AgentControlDiagnosticsReadError extends Schema.TaggedError<AgentControlDiagnosticsReadError>()(
  "AgentControlDiagnosticsReadError",
  { operation: Schema.String },
) {}
