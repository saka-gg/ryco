/**
 * AgentControlPolicy - Feature gate and capability evaluation for Agent
 * Control.
 *
 * The policy is server-authoritative and fails closed: when the feature is
 * disabled — or the settings backing it cannot be read — every check
 * refuses. Capabilities are evaluated strictly against the grant set the
 * caller's credential carries; unknown or ungranted capabilities are
 * denied. This service never mutates anything.
 *
 * @module AgentControlPolicy
 */
import type {
  AgentControlActionKind,
  AgentControlCapability,
  AgentControlPrincipal,
} from "@ryco/contracts";
import { Context } from "effect";
import type { Effect } from "effect";

import type { DelegationLimits } from "../../orchestration/delegationLimits.ts";
import type { AgentControlCapabilityDeniedError, AgentControlDisabledError } from "../Errors.ts";

export interface AgentControlAuthorizeInput {
  readonly principal: AgentControlPrincipal;
  /** Capabilities the caller's credential was issued with. */
  readonly grantedCapabilities: ReadonlyArray<AgentControlCapability>;
  readonly requiredCapability: AgentControlCapability;
  /** Operation name for error reporting and audit context. */
  readonly operation: string;
}

/**
 * AgentControlPolicyShape - Service API for policy evaluation.
 */
export interface AgentControlPolicyShape {
  /** Whether Agent Control is enabled. Never fails: unreadable settings read as disabled. */
  readonly isEnabled: Effect.Effect<boolean>;

  /**
   * The person's opt-in delegation limits (`AgentControlDelegationLimits`). Never fails:
   * unreadable settings read as no limits, and as disabled for `isEnabled`, so no lease or
   * request gets through then anyway.
   */
  readonly delegationLimits: Effect.Effect<DelegationLimits>;

  /** Fail with `AgentControlDisabledError` unless the feature is enabled. */
  readonly requireEnabled: (operation: string) => Effect.Effect<void, AgentControlDisabledError>;

  /** The capability a mutation action kind requires. */
  readonly requiredCapabilityForAction: (kind: AgentControlActionKind) => AgentControlCapability;

  /**
   * Full authorization: feature enabled and the required capability present
   * in the caller's grant set.
   */
  readonly authorize: (
    input: AgentControlAuthorizeInput,
  ) => Effect.Effect<void, AgentControlDisabledError | AgentControlCapabilityDeniedError>;
}

/**
 * AgentControlPolicy - Service tag for Agent Control policy evaluation.
 */
export class AgentControlPolicy extends Context.Service<
  AgentControlPolicy,
  AgentControlPolicyShape
>()("ryco/agentControl/Services/AgentControlPolicy") {}
