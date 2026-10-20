import type { RelayEffectiveRole } from "@ryco/contracts";
import { ORCHESTRATION_WS_METHODS } from "@ryco/contracts/orchestration";
import { RELAY_PROTOCOL_MINOR } from "@ryco/contracts/relay";
import { WS_METHODS } from "@ryco/contracts/rpc";
import { hostedRoleAllows, rpcDeliveryEffectFor } from "@ryco/shared/rpcAccessPolicy";

import type { RpcRequestAdmission, WsProtocolLifecycleHandlers } from "@ryco/client-runtime/rpc";
import { HostedHubApiError } from "../authorization/api.ts";
import {
  hostedAdmitsReadBeforeSnapshot,
  hostedSessionAdmits,
} from "../authorization/capabilities.ts";
import {
  getHostedHubApi,
  getHostedRuntimeConfiguration,
  hostedEnvironmentSessionsMode,
} from "../authorization/runtime.ts";
import { hostedHubController, hostedHubStore } from "../authorization/state.ts";
import type {
  HostedEarlyRelaySocket,
  HostedRelayFailure,
  HostedRelayTransportStatus,
  HostedRycoSessionStatus,
  HostedServerAuthenticatedRelayInput,
} from "../authorization/types.ts";
import { HostedReconnectPolicy } from "./reconnectPolicy.ts";

/**
 * How long an attempt the Hub will authenticate itself stays usable between `nextUrl` and
 * `createSocket` — the lifetime an HTTP ticket would have had, so neither kind of attempt
 * outlives the other.
 */
const SERVER_AUTHENTICATED_ATTEMPT_TTL_MS = 60_000;

interface PendingTicket {
  /** The node this attempt was prepared for. */
  readonly nodeId: string;
  /** The client-held ticket; null for an attempt the Hub authenticates itself. */
  readonly ticket: string | null;
  /** Set when the Hub mints and consumes the ticket over the account session instead. */
  readonly serverAuthenticated: { readonly nodeId: string; readonly protocolMinor: 2 | 3 } | null;
  readonly expiresAt: number;
  readonly generation: number;
  readonly preparedSocketContext: unknown;
  readonly earlySocket: HostedEarlyRelaySocket | undefined;
  used: boolean;
}

/** Bounded preparation failure for native ticket/grant validation. Carries no secret detail. */
export class HostedRelayPreparationError extends Error {
  readonly failure: HostedRelayFailure;

  constructor(failure: HostedRelayFailure) {
    super("Hosted relay preparation failed.");
    this.name = "HostedRelayPreparationError";
    this.failure = failure;
  }
}

const HOSTED_SESSION_SYNC_SUBSCRIPTIONS = new Set<string>([
  ORCHESTRATION_WS_METHODS.subscribeShell,
  ORCHESTRATION_WS_METHODS.subscribeThread,
  ORCHESTRATION_WS_METHODS.subscribeThreadWindow,
  WS_METHODS.subscribeServerConfig,
  WS_METHODS.subscribeServerLifecycle,
  WS_METHODS.subscribeTerminalEvents,
  WS_METHODS.subscribeVcsStatus,
]);

type HostedRequestAuthorizationState = Pick<
  ReturnType<typeof hostedHubStore.getState>,
  | "effectiveRole"
  | "directoryStatus"
  | "transportStatus"
  | "browserStatus"
  | "sessionStatus"
  | "sessionRecoveredAfterUnknown"
>;

/**
 * Whether the hosted session admits a request now, not yet, or not at all.
 *
 * A method no hosted role may call, a role this session already knows that
 * does not reach the method's tier, or a terminally failed transport refuses
 * for good. Everything else that is refused is only waiting — for the session
 * (a role still being validated, a transport reconnecting, a replacement
 * session that has not accepted its snapshot) or, on a current session that
 * could not confirm an earlier action, for the user's acknowledgement — and a
 * subscription retries it rather than giving up: the client is rebuilt while
 * its session synchronizes, and a long-lived read stream started then must
 * survive that. An observe-only unary read does not wait for the snapshot: it
 * is admitted while its session catches up, as soon as the channel is online
 * and mode-locked (`hostedAdmitsReadBeforeSnapshot`); a stale, closed or
 * delivery-unknown session still holds it.
 */
export function admitHostedRequestForState(
  state: HostedRequestAuthorizationState,
  info: { readonly tag: string; readonly stream: boolean },
): RpcRequestAdmission {
  const roleFresh = state.directoryStatus === "ready";
  if (hostedRoleAllows(state.effectiveRole, info.tag, roleFresh)) {
    const live = state.transportStatus === "online" && state.browserStatus === "current";
    if (live && hostedSessionAdmits(state, info.tag)) return "allowed";
    if (
      info.stream &&
      (state.browserStatus === "current" || state.browserStatus === "synchronizing") &&
      (state.sessionStatus === "synchronizing" ||
        state.sessionStatus === "replaying" ||
        state.sessionStatus === "delivery-unknown" ||
        state.sessionStatus === "stale" ||
        state.sessionStatus === "closed") &&
      HOSTED_SESSION_SYNC_SUBSCRIPTIONS.has(info.tag)
    ) {
      return "allowed";
    }
    if (!info.stream && hostedAdmitsReadBeforeSnapshot(state, info.tag)) return "allowed";
    // Current, but holding mutations until the user has continued past an
    // unconfirmed action: waiting will not help, the inline notice will.
    if (live && state.sessionStatus === "delivery-unknown" && state.sessionRecoveredAfterUnknown) {
      return "awaiting-acknowledgement";
    }
  } else if (!hostedRoleAllows("owner", info.tag) || (roleFresh && state.effectiveRole !== null)) {
    return "forbidden";
  }
  return state.transportStatus === "terminal-failure" ? "forbidden" : "awaiting-session";
}

function admitHostedRequest(info: {
  readonly tag: string;
  readonly stream: boolean;
}): RpcRequestAdmission {
  return admitHostedRequestForState(hostedHubStore.getState(), info);
}

export function ticketFailure(error: HostedHubApiError): HostedRelayFailure {
  switch (error.code) {
    case "node_offline":
      return {
        kind: "offline",
        retryable: true,
        ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }),
      };
    case "server_draining":
      return {
        kind: "draining",
        retryable: true,
        ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }),
      };
    case "rate_limited":
      return {
        kind: "rate-limited",
        retryable: true,
        ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }),
      };
    case "unsupported_version":
      return { kind: "incompatible", retryable: false };
    case "forbidden":
    case "authorization_failed":
      return { kind: "authorization-removed", retryable: false };
    case "revoked":
      return { kind: "revoked", retryable: false };
    default:
      return { kind: "network", retryable: true };
  }
}

/**
 * Per-connection lifecycle binding. Web and single-selection clients omit it
 * and retain the package-owned hosted store/controller behavior. Mobile Wave
 * 3b binds one factory to one environment so a retained socket can neither buy
 * a reconnect ticket for a later selection nor publish delivery state into a
 * different environment's row. With retained environment sessions the binding
 * is mandatory (see `createHostedEnvironmentAttemptFactory`): the selection's
 * binding would admit one environment's requests on another's session.
 */
export interface HostedRelayAttemptBinding {
  readonly nodeId: () => string | null;
  readonly generation: () => number | null;
  readonly isAuthenticated: () => boolean;
  readonly isCurrent: (generation: number) => boolean;
  readonly prepareSocketContext?: () => Promise<unknown>;
  /**
   * Native-only atomic ticket/context finalizer. It may attach a transient grant
   * to the returned context; the factory retains it for exactly one socket.
   */
  readonly issueRelayAttempt?: (input: {
    readonly nodeId: string;
    readonly generation: number;
    readonly preparedSocketContext: unknown;
  }) => Promise<{
    readonly ticket: string;
    readonly expiresAt: number;
    readonly preparedSocketContext: unknown;
  }>;
  /** Erase/release a prepared context the factory could not hand to a socket. */
  readonly disposeSocketContext?: (context: unknown) => void;
  /** Start the relay upgrade beside the ticket request; see {@link HostedEarlyRelaySocket}. */
  readonly openEarlyRelaySocket?: () => HostedEarlyRelaySocket | undefined;
  readonly relayUrl?: () => string;
  readonly createRelaySocket?: (input: {
    readonly url: string;
    /** The node this attempt's ticket was issued for. */
    readonly nodeId: string;
    readonly ticket: string;
    readonly ticketExpiresAt: number;
    readonly earlySocket?: HostedEarlyRelaySocket;
    readonly callbacks: {
      readonly onTransportStatus: (status: HostedRelayTransportStatus) => void;
      readonly onSessionStatus: (status: HostedRycoSessionStatus) => void;
      readonly onRole: (role: RelayEffectiveRole | null) => void;
      readonly onFailure: (failure: HostedRelayFailure) => void;
    };
    readonly preparedSocketContext: unknown;
    /**
     * Whether this attempt may use relay payload compression (§4.6). `false`
     * once an earlier attempt of this connection ended with
     * `HostedRelayFailure.compressionFailed`.
     */
    readonly relayCompression: boolean;
  }) => unknown;
  /**
   * Whether the next attempt can be authenticated by the Hub itself over the account session
   * (Hub session version 2), skipping the HTTP ticket. Consulted per attempt, after socket
   * preparation; bindings without the account session omit it and always buy a ticket.
   */
  readonly serverAuthenticatedRelayAvailable?: () => boolean;
  readonly createServerAuthenticatedRelaySocket?: (
    input: HostedServerAuthenticatedRelayInput,
  ) => unknown;
  /**
   * A server-authenticated channel was refused for its session: the counterpart of an HTTP ticket
   * request answered 401. Hand the session to its lifecycle owner to revalidate, which expires it
   * when the Hub no longer accepts it.
   */
  readonly revalidateSession?: () => void;
  readonly authorizeRequest: (info: {
    readonly tag: string;
    readonly stream: boolean;
  }) => RpcRequestAdmission;
  readonly subscribeAdmissionChanges?: (listener: () => void) => () => void;
  readonly shouldReconnect: (generation: number) => boolean;
  readonly transportStatus: (generation: number, status: HostedRelayTransportStatus) => void;
  readonly sessionStatus: (generation: number, status: HostedRycoSessionStatus) => void;
  readonly role: (generation: number, role: RelayEffectiveRole | null) => void;
  readonly failure: (generation: number, failure: HostedRelayFailure) => void;
  readonly markDeliveryUnknown: (generation: number) => void;
  readonly connectionClosed: (generation: number) => void;
  readonly connectionRecovered?: (generation: number) => void;
  /**
   * The account connection carrying this channel may be dead: a unary request
   * has waited {@link HOSTED_REQUEST_STALL_PROBE_MS} without a reply, the
   * channel's heartbeat timed out, or the channel closed unintentionally. The
   * replacement channel must not be opened on that connection unchecked.
   */
  readonly connectionSuspect?: () => void;
}

/**
 * How long a unary relay request may wait for its first reply before the
 * connection carrying it is asked to prove it is alive. Long-lived streams are
 * not watched: they may legitimately stay silent.
 */
export const HOSTED_REQUEST_STALL_PROBE_MS = 5_000;

/**
 * The relay ports the hosted runtime configuration provides: how a channel's
 * context is prepared, its ticket issued and its early upgrade started, how a
 * channel the Hub authenticates itself is opened, and who hears about a refused
 * session or a suspect account connection. The relay URL and socket are not
 * among them: the factory falls back to the runtime's for any binding that
 * omits them.
 */
export type HostedRuntimeAttemptPorts = Required<
  Pick<
    HostedRelayAttemptBinding,
    | "prepareSocketContext"
    | "issueRelayAttempt"
    | "disposeSocketContext"
    | "openEarlyRelaySocket"
    | "serverAuthenticatedRelayAvailable"
    | "createServerAuthenticatedRelaySocket"
    | "revalidateSession"
    | "connectionSuspect"
  >
>;

/**
 * The selected node's relay ports, and what an environment-bound binding falls
 * back to for each one it omits. Every port reads the runtime configuration
 * when it is called, never when this is.
 */
export function hostedRuntimeAttemptPorts(): HostedRuntimeAttemptPorts {
  return {
    prepareSocketContext: () =>
      getHostedRuntimeConfiguration().prepareRelaySocketContext?.() ?? Promise.resolve(undefined),
    issueRelayAttempt: async (input) => {
      const issue = getHostedRuntimeConfiguration().issueRelayAttempt;
      if (issue) return issue(input);
      const result = await getHostedHubApi().issueRelayTicket(input.nodeId);
      return {
        ticket: result.ticket,
        expiresAt: result.expiresAt,
        preparedSocketContext: input.preparedSocketContext,
      };
    },
    disposeSocketContext: (context) =>
      getHostedRuntimeConfiguration().disposeRelaySocketContext?.(context),
    openEarlyRelaySocket: () => getHostedRuntimeConfiguration().openEarlyRelaySocket?.(),
    serverAuthenticatedRelayAvailable: () => {
      const configuration = getHostedRuntimeConfiguration();
      return (
        configuration.createServerAuthenticatedRelaySocket !== undefined &&
        configuration.serverAuthenticatedRelayAvailable?.() === true
      );
    },
    createServerAuthenticatedRelaySocket: (input) => {
      const create = getHostedRuntimeConfiguration().createServerAuthenticatedRelaySocket;
      if (!create) throw new Error("Server-authenticated relay channels are unavailable.");
      return create(input);
    },
    revalidateSession: () => void hostedHubController.revalidateSession(),
    connectionSuspect: () => getHostedRuntimeConfiguration().probeHubSubscription?.(),
  };
}

function defaultBinding(): HostedRelayAttemptBinding {
  return {
    nodeId: () => hostedHubStore.getState().selectedNode?.id ?? null,
    generation: () => hostedHubStore.getState().generation,
    isAuthenticated: () => hostedHubStore.getState().accountStatus === "authenticated",
    isCurrent: (generation) => hostedHubStore.getState().generation === generation,
    ...hostedRuntimeAttemptPorts(),
    authorizeRequest: admitHostedRequest,
    subscribeAdmissionChanges: hostedHubStore.subscribe,
    shouldReconnect: (generation) => {
      const state = hostedHubStore.getState();
      return (
        generation === state.generation &&
        state.accountStatus === "authenticated" &&
        state.selectedNode !== null &&
        (state.browserStatus === "current" || state.browserStatus === "synchronizing") &&
        state.transportStatus !== "terminal-failure"
      );
    },
    transportStatus: (generation, status) =>
      hostedHubController.transportStatus(generation, status),
    sessionStatus: (generation, status) => hostedHubController.sessionStatus(generation, status),
    role: (generation, role) => hostedHubController.role(generation, role),
    failure: (generation, failure) => hostedHubController.failure(generation, failure),
    markDeliveryUnknown: (generation) => hostedHubController.markDeliveryUnknown(generation),
    connectionClosed: (generation) => hostedHubController.connectionClosed(generation),
    connectionRecovered: recoverHostedRelayConnection,
  };
}

/**
 * Hand a replacement channel that authenticated after an unintentional close
 * back to the authoritative lifecycle owner.
 *
 * The transport has already paid for the replacement — a fresh ticket, stream,
 * E2EE handshake — and the client's shell and thread subscriptions resubscribe
 * on it, so the controller adopts that channel instead of rebuilding the client
 * (which bought a second ticket, stream, handshake and shell snapshot per
 * drop). Mutation authority still waits for the replacement session's own
 * accepted shell snapshot; see `HostedHubController.connectionRecovered`.
 */
export function recoverHostedRelayConnection(generation: number): void {
  hostedHubController.connectionRecovered(generation);
}

/**
 * Whoever answers for a connection's receipted requests after a drop
 * (`bindHostedDispatchReplay`). Until it claims them they are tracked like any
 * other mutation, so a client that does not replay them still leaves their
 * delivery uncertain.
 */
export interface HostedReceiptedRequestOwner {
  readonly ownsReceiptedRequests: () => boolean;
  /** The connection closed unexpectedly: what it had in flight may not have arrived. */
  readonly connectionLost: () => void;
}

export class HostedRelayAttemptFactory {
  readonly #binding: HostedRelayAttemptBinding;
  readonly #reconnect = new HostedReconnectPolicy();
  readonly #pendingRequests = new Map<string, "first-chunk" | "exit">();
  /** Unary requests awaiting their first reply, by id, with when they started. */
  readonly #unansweredRequests = new Map<string, number>();
  #stallTimer: ReturnType<typeof setTimeout> | null = null;
  #pendingTicket: PendingTicket | null = null;
  #lastRetryAfterMs: number | undefined;
  #activeGeneration: number | null = null;
  #nextAttemptId = 0;
  #activeAttemptId: number | null = null;
  #activeSocket: unknown = null;
  /** An unintentional close was seen; the next channel online is its replacement. */
  #recoveringAfterClose = false;
  #revision = 0;
  #preparation = 0;
  #disposed = false;
  #retryable = true;
  /**
   * An attempt of this connection ended on a compressed payload it could not
   * deliver (§4.6.5); every later attempt runs without compression. Compression
   * only saves bytes, so going without it costs nothing a peer could exploit.
   */
  #compressionDisabled = false;
  /**
   * The last attempt failed before it had a ticket. The next one opens its
   * socket only once it has one, so a node that is offline (or a Hub refusing
   * tickets) is not also sent an upgrade per retry.
   */
  #ticketStageFailed = false;

  constructor(binding?: HostedRelayAttemptBinding) {
    if (binding === undefined) assertSingleEnvironmentSessions();
    this.#binding = binding ?? defaultBinding();
  }

  async nextUrl(): Promise<string> {
    const nodeId = this.#binding.nodeId();
    const generation = this.#binding.generation();
    if (
      this.#disposed ||
      !this.#retryable ||
      !nodeId ||
      generation === null ||
      !this.#binding.isAuthenticated()
    ) {
      throw new Error("No authorized hosted node is selected.");
    }
    const revision = this.#revision;
    const preparation = ++this.#preparation;
    const isCurrent = () =>
      !this.#disposed &&
      revision === this.#revision &&
      preparation === this.#preparation &&
      this.#binding.isCurrent(generation) &&
      this.#binding.nodeId() === nodeId;
    this.#activeGeneration = generation;
    this.#binding.transportStatus(generation, "requesting-ticket");
    this.#discardPendingTicket();
    let preparedSocketContext: unknown;
    let earlySocket =
      this.#ticketStageFailed || this.#serverAuthenticatedAvailable()
        ? undefined
        : this.#openEarlySocket();
    try {
      preparedSocketContext = await this.#binding.prepareSocketContext?.();
      if (!isCurrent()) {
        throw new Error("Hosted node selection changed.");
      }
      // Decided after preparation, which may have awaited a chunk load: the account session's
      // state then is the one the channel opens on.
      if (this.#serverAuthenticatedAvailable()) {
        discardEarlySocket(earlySocket);
        earlySocket = undefined;
        this.#pendingTicket = {
          nodeId,
          ticket: null,
          serverAuthenticated: { nodeId, protocolMinor: RELAY_PROTOCOL_MINOR },
          expiresAt:
            getHostedRuntimeConfiguration().timers.now() + SERVER_AUTHENTICATED_ATTEMPT_TTL_MS,
          generation,
          preparedSocketContext,
          earlySocket: undefined,
          used: false,
        };
        preparedSocketContext = undefined;
        return this.#binding.relayUrl?.() ?? getHostedRuntimeConfiguration().relayUrl();
      }
      const issued = this.#binding.issueRelayAttempt
        ? await this.#binding.issueRelayAttempt({
            nodeId,
            generation,
            preparedSocketContext,
          })
        : {
            ...(await getHostedHubApi().issueRelayTicket(nodeId)),
            preparedSocketContext,
          };
      preparedSocketContext = undefined;
      if (!isCurrent()) {
        this.#disposeSocketContext(issued.preparedSocketContext);
        throw new Error("Hosted node selection changed.");
      }
      this.#ticketStageFailed = false;
      this.#pendingTicket = {
        nodeId,
        ticket: issued.ticket,
        serverAuthenticated: null,
        expiresAt: issued.expiresAt,
        generation,
        preparedSocketContext: issued.preparedSocketContext,
        earlySocket,
        used: false,
      };
      earlySocket = undefined;
      return this.#binding.relayUrl?.() ?? getHostedRuntimeConfiguration().relayUrl();
    } catch (error) {
      this.#disposeSocketContext(preparedSocketContext);
      discardEarlySocket(earlySocket);
      if (!isCurrent()) throw error;
      this.#ticketStageFailed = true;
      if (error instanceof HostedHubApiError && error.status === 401) {
        void hostedHubController.expireSession();
      } else if (error instanceof HostedRelayPreparationError) {
        this.#retryable = error.failure.retryable;
        this.#lastRetryAfterMs = error.failure.retryAfterMs;
        this.#binding.failure(generation, error.failure);
      } else if (error instanceof HostedHubApiError) {
        const failure = ticketFailure(error);
        this.#retryable = failure.retryable;
        this.#lastRetryAfterMs = failure.retryAfterMs;
        this.#binding.failure(generation, failure);
      }
      throw error;
    }
  }

  createSocket(url: string): unknown {
    const pending = this.#pendingTicket;
    this.#pendingTicket = null;
    if (
      !pending ||
      this.#disposed ||
      !this.#binding.isCurrent(pending.generation) ||
      pending.used ||
      pending.expiresAt <= getHostedRuntimeConfiguration().timers.now()
    ) {
      this.#disposeSocketContext(pending?.preparedSocketContext);
      discardEarlySocket(pending?.earlySocket);
      throw new Error("A fresh relay ticket is required for every connection attempt.");
    }
    pending.used = true;
    const generation = pending.generation;
    const ticket = pending.ticket;
    const ticketExpiresAt = pending.expiresAt;
    const attemptId = this.#nextAttemptId + 1;
    this.#nextAttemptId = attemptId;
    this.#activeAttemptId = attemptId;
    const revision = this.#revision;
    const isCurrentAttempt = () =>
      !this.#disposed &&
      revision === this.#revision &&
      this.#activeAttemptId === attemptId &&
      this.#binding.isCurrent(generation);
    const earlySocket = pending.earlySocket;
    const serverAuthenticatedAttempt = pending.serverAuthenticated !== null;
    const callbacks = {
      onTransportStatus: (status: HostedRelayTransportStatus) => {
        if (!isCurrentAttempt()) return;
        this.#binding.transportStatus(generation, status);
        if (status === "online" && this.#recoveringAfterClose) {
          this.#recoveringAfterClose = false;
          this.#binding.connectionRecovered?.(generation);
        }
      },
      onSessionStatus: (status: HostedRycoSessionStatus) => {
        if (isCurrentAttempt()) this.#binding.sessionStatus(generation, status);
      },
      onRole: (role: RelayEffectiveRole | null) => {
        if (isCurrentAttempt()) this.#binding.role(generation, role);
      },
      onFailure: (failure: HostedRelayFailure) => {
        if (!isCurrentAttempt()) return;
        this.#retryable = failure.retryable;
        this.#lastRetryAfterMs = failure.retryAfterMs;
        if (failure.compressionFailed === true) this.#compressionDisabled = true;
        this.#reconnect.closed();
        if (this.#pendingRequests.size > 0) {
          this.#binding.markDeliveryUnknown(generation);
          this.#pendingRequests.clear();
        }
        this.#binding.failure(generation, failure);
        // Over HTTP the Hub refuses a dead session with a 401 that expires it. On a channel the
        // Hub authenticated itself the same refusal arrives as an authentication close, so it
        // converges on the same owner instead of retrying until the account socket notices.
        // Node-level refusals (offline, draining, rate) stay ordinary retryable failures.
        if (serverAuthenticatedAttempt && isSessionRefusal(failure)) {
          this.#binding.revalidateSession?.();
        }
      },
    };
    this.#activeGeneration = generation;
    try {
      const serverAuthenticated = pending.serverAuthenticated;
      let socket: unknown;
      if (serverAuthenticated !== null) {
        const create = this.#binding.createServerAuthenticatedRelaySocket;
        if (!create) throw new Error("Server-authenticated relay channels are unavailable.");
        socket = create({
          url,
          nodeId: serverAuthenticated.nodeId,
          protocolMinor: serverAuthenticated.protocolMinor,
          callbacks,
          preparedSocketContext: pending.preparedSocketContext,
          relayCompression: !this.#compressionDisabled,
        });
      } else {
        if (ticket === null) throw new Error("A relay ticket is required for this attempt.");
        const input = {
          url,
          nodeId: pending.nodeId,
          ticket,
          ticketExpiresAt,
          callbacks,
          preparedSocketContext: pending.preparedSocketContext,
          relayCompression: !this.#compressionDisabled,
          ...(earlySocket === undefined ? {} : { earlySocket }),
        };
        socket = this.#binding.createRelaySocket
          ? this.#binding.createRelaySocket(input)
          : getHostedRuntimeConfiguration().createRelaySocket(input);
      }
      if (isCurrentAttempt()) this.#activeSocket = socket;
      return socket;
    } catch (error) {
      this.#disposeSocketContext(pending.preparedSocketContext);
      discardEarlySocket(earlySocket);
      if (isCurrentAttempt()) {
        this.#activeAttemptId = null;
        this.#activeSocket = null;
        if (this.#activeGeneration === generation) this.#activeGeneration = null;
      }
      throw error;
    }
  }

  lifecycleHandlers(
    receiptedRequestOwner?: HostedReceiptedRequestOwner,
  ): WsProtocolLifecycleHandlers {
    return {
      webSocketConstructor: (url) => this.createSocket(url) as WebSocket,
      isSocketCurrent: (socket) => socket === this.#activeSocket,
      preserveSocketPath: true,
      retryTransientErrors: false,
      persistentReconnect: true,
      recordGlobalConnectionState: false,
      onSessionStart: () => {
        this.#disposed = false;
        this.#retryable = true;
        this.#invalidateAttempt();
      },
      onDispose: () => {
        this.#disposed = true;
        this.#invalidateAttempt();
        this.#pendingRequests.clear();
        this.#clearStallWatch();
      },
      isTerminalUrlError: () => this.#disposed || !this.#retryable,
      shouldReconnect: () =>
        !this.#disposed &&
        this.#retryable &&
        this.#activeGeneration !== null &&
        this.#binding.shouldReconnect(this.#activeGeneration),
      authorizeRequest: (info) => this.#binding.authorizeRequest(info),
      ...(this.#binding.subscribeAdmissionChanges
        ? { subscribeAdmissionChanges: this.#binding.subscribeAdmissionChanges }
        : {}),
      getReconnectDelayMs: () => {
        const delay = this.#reconnect.nextDelay(this.#lastRetryAfterMs);
        this.#lastRetryAfterMs = undefined;
        return delay;
      },
      onOpen: () => this.#reconnect.opened(),
      // A silent channel says the account connection may be dead too — say a
      // NAT rebinding no browser signal reported. Probing it now, before the
      // retry builds the replacement channel, keeps that channel off a dead
      // connection instead of waiting out the connection's liveness bound.
      onHeartbeatTimeout: () => {
        if (!this.#disposed) this.#binding.connectionSuspect?.();
      },
      onClose: (_details, context) => {
        if (context.intentional) return;
        // The replies the stall watch waits for died with this channel.
        this.#clearStallWatch();
        if (!this.#disposed) this.#binding.connectionSuspect?.();
        receiptedRequestOwner?.connectionLost();
        const generation = this.#activeGeneration;
        if (generation === null) return;
        this.#reconnect.closed();
        this.#recoveringAfterClose = true;
        // A mutation sent on the lost channel and never answered stays
        // uncertain: the replacement channel this connection adopts cannot
        // answer for it.
        if (this.#pendingRequests.size > 0) {
          this.#pendingRequests.clear();
          this.#binding.markDeliveryUnknown(generation);
        }
        this.#binding.connectionClosed(generation);
      },
      onRequestStart: (info) => {
        if (!info.stream) this.#watchForStall(info.id);
        // Only a request that may have changed something can leave its
        // delivery uncertain. Reads — unary, or long-lived streams such as the
        // Agent Control queue — are harmless to lose. A receipted command is
        // left to its client only once that client has claimed it: the client
        // then replays it, or marks the session itself when it cannot.
        const effect = rpcDeliveryEffectFor(info.tag);
        if (effect === "read") return;
        if (effect === "receipted" && receiptedRequestOwner?.ownsReceiptedRequests() === true) {
          return;
        }
        this.#pendingRequests.set(info.id, info.stream ? "exit" : "first-chunk");
      },
      onRequestChunk: (info) => {
        this.#unansweredRequests.delete(info.id);
        if (this.#pendingRequests.get(info.id) === "first-chunk") {
          this.#pendingRequests.delete(info.id);
        }
      },
      onRequestExit: (info) => {
        this.#unansweredRequests.delete(info.id);
        this.#pendingRequests.delete(info.id);
      },
      onRequestInterrupt: (info) => {
        this.#unansweredRequests.delete(info.id);
        this.#pendingRequests.delete(info.id);
      },
    };
  }

  /**
   * One timer for every unanswered unary request: when the oldest has waited
   * {@link HOSTED_REQUEST_STALL_PROBE_MS}, the binding is told once, and the
   * watch re-arms for whatever is still waiting after that.
   */
  #watchForStall(id: string): void {
    this.#unansweredRequests.set(id, getHostedRuntimeConfiguration().timers.now());
    this.#armStallWatch();
  }

  #armStallWatch(): void {
    if (this.#stallTimer !== null || this.#unansweredRequests.size === 0) return;
    const timers = getHostedRuntimeConfiguration().timers;
    const oldest = Math.min(...this.#unansweredRequests.values());
    const delay = Math.max(0, oldest + HOSTED_REQUEST_STALL_PROBE_MS - timers.now());
    this.#stallTimer = timers.setTimeout(() => {
      this.#stallTimer = null;
      const now = timers.now();
      let stalled = false;
      for (const [id, startedAt] of this.#unansweredRequests) {
        if (now - startedAt < HOSTED_REQUEST_STALL_PROBE_MS) continue;
        stalled = true;
        // Reported once per request; a probe answers for every request it covers.
        this.#unansweredRequests.delete(id);
      }
      if (stalled && !this.#disposed) this.#binding.connectionSuspect?.();
      this.#armStallWatch();
    }, delay);
  }

  #clearStallWatch(): void {
    this.#unansweredRequests.clear();
    if (this.#stallTimer !== null) {
      getHostedRuntimeConfiguration().timers.clearTimeout(this.#stallTimer);
      this.#stallTimer = null;
    }
  }

  hasPendingRequests(): boolean {
    return this.#pendingRequests.size > 0;
  }

  #invalidateAttempt(): void {
    this.#revision += 1;
    this.#discardPendingTicket();
    this.#activeGeneration = null;
    this.#activeAttemptId = null;
    this.#activeSocket = null;
    this.#recoveringAfterClose = false;
  }

  reset(): void {
    this.#invalidateAttempt();
    this.#disposed = false;
    this.#retryable = true;
    this.#compressionDisabled = false;
    this.#pendingRequests.clear();
    this.#clearStallWatch();
    this.#lastRetryAfterMs = undefined;
    this.#activeGeneration = null;
    this.#activeAttemptId = null;
    this.#activeSocket = null;
    this.#recoveringAfterClose = false;
    this.#ticketStageFailed = false;
    this.#reconnect.reset();
  }

  #disposeSocketContext(context: unknown): void {
    if (context === undefined) return;
    try {
      this.#binding.disposeSocketContext?.(context);
    } catch {
      // Disposal is best effort; the attempt is already unreachable here.
    }
  }

  #discardPendingTicket(): void {
    const pending = this.#pendingTicket;
    this.#pendingTicket = null;
    if (pending !== null) {
      this.#disposeSocketContext(pending.preparedSocketContext);
      discardEarlySocket(pending.earlySocket);
    }
  }

  #serverAuthenticatedAvailable(): boolean {
    if (this.#binding.createServerAuthenticatedRelaySocket === undefined) return false;
    try {
      return this.#binding.serverAuthenticatedRelayAvailable?.() === true;
    } catch {
      // A broken probe never weakens the attempt: it falls back to an HTTP ticket.
      return false;
    }
  }

  #openEarlySocket(): HostedEarlyRelaySocket | undefined {
    try {
      return this.#binding.openEarlyRelaySocket?.();
    } catch {
      // Best effort: the attempt then opens its socket once it has a ticket.
      return undefined;
    }
  }
}

/** A relay refusal of the session that authenticated the channel, not of the node. */
function isSessionRefusal(failure: HostedRelayFailure): boolean {
  return (
    failure.kind === "authentication" &&
    (failure.closeReason === "authentication_failed" ||
      failure.closeReason === "authentication_required")
  );
}

function discardEarlySocket(socket: HostedEarlyRelaySocket | undefined): void {
  if (socket === undefined) return;
  try {
    socket.discard();
  } catch {
    // Best effort: an early socket carries no authority before its ticket.
  }
}

/**
 * The selection's binding follows whichever node is selected. Retained
 * environment sessions keep several connections at once, so each must be bound
 * to its own environment instead.
 */
function assertSingleEnvironmentSessions(): void {
  if (hostedEnvironmentSessionsMode() === "retained") {
    throw new Error("Retained hosted sessions require an environment-bound relay attempt binding.");
  }
}

let attemptFactory: HostedRelayAttemptFactory | null = null;

export function getHostedRelayAttemptFactory(): HostedRelayAttemptFactory {
  assertSingleEnvironmentSessions();
  attemptFactory ??= new HostedRelayAttemptFactory();
  return attemptFactory;
}

export function hasHostedRelayPendingRequests(): boolean {
  return attemptFactory?.hasPendingRequests() ?? false;
}

export function resetHostedRelayAttemptFactory(): void {
  attemptFactory?.reset();
  attemptFactory = null;
}
