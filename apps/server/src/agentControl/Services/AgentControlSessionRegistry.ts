/**
 * AgentControlSessionRegistry - In-memory credential and lease authority
 * for the internal provider-session MCP surface.
 *
 * Every supported provider runtime receives a fresh opaque bearer bound to
 * exactly one `(threadId, providerInstanceId, runtimeSessionId)` runtime
 * epoch and a fixed capability grant set. The registry is deliberately
 * memory-only: credentials do not survive a server restart, are stored
 * only as digests, and are never persisted or logged. Revocation is
 * synchronous — a revoked session's in-flight MCP requests are aborted and
 * later requests fail authentication indistinguishably from never-issued
 * credentials.
 *
 * The registry also owns two adjacent responsibilities:
 *
 *   - The private MCP endpoint slot. The loopback listener publishes its
 *     address here and clears it on teardown; provider adapters only ever
 *     learn the endpoint through an issued lease, so the address never
 *     reaches browser/client runtime state.
 *   - Exact-turn write authority (consumed by the proposal-backed thread
 *     actions slice). This PR ships the lease API — bind, synchronous
 *     retirement, in-flight cancellation — but no write tool exercises it.
 *
 * @module AgentControlSessionRegistry
 */
import type {
  AgentControlCapability,
  AgentControlInjectionMode,
  ProviderInstanceId,
  RuntimeSessionId,
  ThreadId,
  TurnId,
} from "@ryco/contracts";
import { Context } from "effect";
import type { Effect, Option, Redacted } from "effect";

import type {
  AgentControlBootstrapError,
  AgentControlMcpAuthError,
  AgentControlTurnAuthorityError,
} from "../Errors.ts";

/** Private loopback endpoint of the internal MCP listener. */
export interface AgentControlMcpEndpoint {
  readonly url: string;
}

export interface IssueAgentControlLeaseInput {
  readonly threadId: ThreadId;
  readonly providerInstanceId: ProviderInstanceId;
  readonly runtimeSessionId: RuntimeSessionId;
  readonly capabilities: ReadonlyArray<AgentControlCapability>;
  readonly injectionMode: AgentControlInjectionMode;
}

/**
 * Handed to the provider adapter exactly once at runtime start. The raw
 * credential lives only inside `credential` (redacted) and the provider
 * process configuration derived from it.
 */
export interface AgentControlIssuedLease {
  readonly sessionId: string;
  readonly endpointUrl: string;
  readonly credential: Redacted.Redacted<string>;
}

/** A stdio proxy receives only this short-lived, one-shot bootstrap secret. */
export interface AgentControlIssuedBootstrap {
  readonly sessionId: string;
  readonly endpointUrl: string;
  readonly bootstrapToken: Redacted.Redacted<string>;
  readonly expiresAt: number;
}

/** Authenticated caller identity for one internal MCP request. */
export interface AgentControlSessionRecord {
  readonly sessionId: string;
  readonly threadId: ThreadId;
  readonly providerInstanceId: ProviderInstanceId;
  readonly runtimeSessionId: RuntimeSessionId;
  readonly grantedCapabilities: ReadonlyArray<AgentControlCapability>;
  readonly issuedAt: string;
  readonly injectionMode: AgentControlInjectionMode;
}

export type AgentControlLeaseRevocationReason =
  | "runtime-teardown"
  | "runtime-replaced"
  | "session-stopped"
  | "server-shutdown"
  | "feature-disabled"
  | "listener-stopped";

export interface RevokeAgentControlLeasesInput {
  readonly threadId: ThreadId;
  /** When present, only leases of this exact runtime epoch are revoked. */
  readonly runtimeSessionId?: RuntimeSessionId | undefined;
  readonly reason: AgentControlLeaseRevocationReason;
}

/** One session's currently bound exact-turn write authority. */
/**
 * Who opened a turn: the user (a prompt Ryco sent) or the provider itself (a Claude
 * "wake" turn after a background task finished, with no new prompt).
 */
export type AgentControlTurnOpener = "user" | "provider";

export interface AgentControlTurnAuthority {
  readonly sessionId: string;
  readonly threadId: ThreadId;
  readonly turnId: TurnId;
  readonly boundAt: string;
  /** Absent means "user". */
  readonly openedBy?: AgentControlTurnOpener;
  /**
   * The user turn whose task this turn carries on: the turn itself for a user turn, the
   * session's last user turn for a provider turn. Per-task consents key on it, so a wake
   * turn finishing the user's task is not asked again. Absent means `turnId`.
   */
  readonly taskTurnId?: TurnId;
}

export interface RetireAgentControlTurnAuthorityInput {
  readonly threadId: ThreadId;
  /** When present, only authority for this exact turn is retired. */
  readonly turnId?: TurnId | undefined;
}

/** Cancels one in-flight request when its session or turn authority dies. */
export interface AgentControlInFlightRequest {
  readonly abort: () => void;
  /** Set when the request exercises turn-bound write authority. */
  readonly turnId?: TurnId | undefined;
}

/**
 * AgentControlSessionRegistryShape - Service API for the session registry.
 */
export interface AgentControlSessionRegistryShape {
  /**
   * Issue a fresh credential for a starting provider runtime. Returns
   * `none` when Agent Control is disabled or no healthy private listener
   * endpoint exists — the adapter then starts the provider without Agent
   * Control and must not claim the tools are available. Issuing for a
   * thread revokes any prior lease of that thread (`runtime-replaced`).
   */
  readonly issueLease: (
    input: IssueAgentControlLeaseInput,
  ) => Effect.Effect<Option.Option<AgentControlIssuedLease>>;

  /** Issue a lease whose bearer can only be obtained by one bootstrap exchange. */
  readonly issueStdioBootstrap: (
    input: IssueAgentControlLeaseInput,
  ) => Effect.Effect<Option.Option<AgentControlIssuedBootstrap>>;

  /** Consume a bootstrap token exactly once. Invalid attempts reveal no session details. */
  readonly exchangeStdioBootstrap: (
    bootstrapToken: string,
  ) => Effect.Effect<AgentControlIssuedLease, AgentControlBootstrapError>;

  /**
   * Authenticate an `Authorization` header value. Missing, malformed,
   * revoked, unknown, and restart-stale credentials all fail; only a
   * currently-leased credential resolves to its session record.
   */
  readonly authenticate: (
    authorizationHeader: string | undefined,
  ) => Effect.Effect<AgentControlSessionRecord, AgentControlMcpAuthError>;

  /**
   * Synchronously revoke exactly one issued lease by its unique session
   * id, aborting its in-flight requests. Idempotent and incapable of
   * touching a successor lease: session ids are never reused, so a stale
   * runtime's late teardown cannot revoke the credential of a recovered
   * runtime that reused the same `(threadId, runtimeSessionId)` epoch.
   */
  readonly revokeLease: (input: {
    readonly sessionId: string;
    readonly reason: AgentControlLeaseRevocationReason;
  }) => Effect.Effect<void>;

  /** Synchronously revoke leases by runtime identity and abort their in-flight requests. */
  readonly revokeLeases: (input: RevokeAgentControlLeasesInput) => Effect.Effect<void>;

  /** Revoke every lease (server shutdown, feature disable, listener stop). */
  readonly revokeAll: (reason: AgentControlLeaseRevocationReason) => Effect.Effect<void>;

  readonly activeSessionCount: Effect.Effect<number>;

  /**
   * Track an in-flight request so revocation (and turn retirement, for
   * turn-bound requests) can abort it. Returns the unregister callback.
   */
  readonly registerInFlight: (
    sessionId: string,
    request: AgentControlInFlightRequest,
  ) => Effect.Effect<() => void, AgentControlTurnAuthorityError>;

  /**
   * Bind write authority to the exact running turn. At most one authority
   * per session; binding again replaces it. Proposal-backed mutation tools
   * must present this exact authority while creating their immutable plan.
   * A provider-opened turn gets the same authority but never the user's
   * staged Computer Use request, which only a user turn may carry.
   */
  readonly bindTurnAuthority: (input: {
    readonly sessionId: string;
    readonly turnId: TurnId;
    /** Defaults to "user". */
    readonly openedBy?: AgentControlTurnOpener;
  }) => Effect.Effect<AgentControlTurnAuthority, AgentControlTurnAuthorityError>;

  /**
   * Synchronously retire turn authority for a thread (or one exact turn)
   * and abort in-flight requests bound to it. An interrupted or replaced
   * turn can never lend authority to a later turn.
   */
  readonly retireTurnAuthority: (
    input: RetireAgentControlTurnAuthorityInput,
  ) => Effect.Effect<void>;

  readonly getTurnAuthority: (
    sessionId: string,
  ) => Effect.Effect<Option.Option<AgentControlTurnAuthority>>;

  /** Written only by the private listener lifecycle; never client-visible. */
  readonly publishEndpoint: (endpoint: AgentControlMcpEndpoint) => Effect.Effect<void>;
  readonly clearEndpoint: Effect.Effect<void>;
  readonly currentEndpoint: Effect.Effect<Option.Option<AgentControlMcpEndpoint>>;
}

/**
 * AgentControlSessionRegistry - Service tag for the session registry.
 */
export class AgentControlSessionRegistry extends Context.Service<
  AgentControlSessionRegistry,
  AgentControlSessionRegistryShape
>()("ryco/agentControl/Services/AgentControlSessionRegistry") {}
