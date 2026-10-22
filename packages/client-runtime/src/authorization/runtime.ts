import type {
  DpopSignerService,
  EndpointService,
  HttpClientService,
  NativeAuthorizationService,
  PasskeyCeremonyService,
  SessionCredentialsService,
} from "../platform/index.ts";
import { HostedHubApi } from "./api.ts";
import type {
  HostedEarlyRelaySocket,
  HostedHubNode,
  HostedServerAuthenticatedRelayInput,
} from "./types.ts";
import type {
  HostedRelayFailure,
  HostedRelayTransportStatus,
  HostedRycoSessionStatus,
} from "./types.ts";
import type { RelayEffectiveRole } from "@ryco/contracts";
import type { EnvironmentId, ExecutionEnvironmentDescriptor } from "@ryco/contracts";

/**
 * The hosted owner is configured once by the application bootstrap. No Hub
 * material is accepted by this contract and no value here is persisted.
 */
export interface HostedNodeLifecycle {
  readonly activate: (
    node: HostedHubNode,
    previousEnvironmentId: EnvironmentId | null,
    signal?: AbortSignal,
  ) => Promise<void>;
  readonly suspend: (environmentId: EnvironmentId) => Promise<void>;
  readonly deactivate: (environmentId: EnvironmentId) => Promise<void>;
  readonly clearNodeScopedState: (environmentId: EnvironmentId) => void;
  readonly writePrimaryEnvironmentDescriptor: (
    descriptor: ExecutionEnvironmentDescriptor | null,
  ) => void;
  readonly connectPrimaryEnvironment: () => void;
  readonly disconnectPrimaryEnvironment: () => Promise<void>;
  readonly setActiveEnvironmentId: (environmentId: EnvironmentId) => void;
  // Retained environment sessions only. Each port names the session generation
  // it acts for, and the platform ignores a call when a newer generation
  // already owns the environment, so a late release or suspend of an old
  // generation never tears down a newer connection.
  /** Create the environment's connection for this generation, replacing an older one. */
  readonly connectEnvironment?: (node: HostedHubNode, generation: number) => void;
  /** Remove the environment's connection when its generation is at most `generation`. */
  readonly releaseEnvironment?: (environmentId: EnvironmentId, generation: number) => Promise<void>;
  /**
   * Dispose the transport of the environment's connection when its generation
   * is at most `generation`, keeping what it displays.
   */
  readonly suspendEnvironment?: (environmentId: EnvironmentId, generation: number) => Promise<void>;
  /**
   * Ask the platform to re-plan which environments are connected. In retained
   * mode the lifecycle owner never connects on its own.
   */
  readonly requestEnvironmentReconcile?: (request: HostedEnvironmentReconcileRequest) => void;
}

export interface HostedEnvironmentReconcileRequest {
  readonly reason: "resume" | "retry" | "directory";
  readonly environmentId?: EnvironmentId;
}

/**
 * `single`: one connection, to the selected node. `retained`: one session per
 * environment, each with its own relay attempt binding.
 */
export type HostedEnvironmentSessionsMode = "single" | "retained";

export interface HostedRuntimeTimers {
  readonly now: () => number;
  /** Bound platform timer wrappers; never pass browser methods unbound. */
  readonly setTimeout: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  readonly clearTimeout: (timer: ReturnType<typeof setTimeout>) => void;
  readonly queueMicrotask: (callback: () => void) => void;
}

export interface HostedRuntimeConfiguration {
  readonly endpoint: EndpointService;
  readonly httpClient: HttpClientService;
  readonly passkeyCeremony: PasskeyCeremonyService;
  readonly sessionCredentials: SessionCredentialsService;
  /**
   * Required when `sessionCredentials.mode` is `"bearer"`; supplies the
   * per-request DPoP proof. Omitted (undefined) in cookie mode, which web uses.
   */
  readonly dpopSigner?: DpopSignerService;
  /** Preferred system-browser sign-in for bearer/native clients. */
  readonly nativeAuthorization?: NativeAuthorizationService;
  readonly nodeLifecycle: HostedNodeLifecycle;
  /** Defaults to `single`. */
  readonly environmentSessions?: HostedEnvironmentSessionsMode;
  readonly timers: HostedRuntimeTimers;
  readonly isForeground: () => boolean;
  readonly subscribeForeground: (listener: () => void) => () => void;
  readonly hasPendingRelayRequests: () => boolean;
  /** A live account subscription pushes directory changes independently of node channels. */
  readonly hasLiveHubSubscription?: () => boolean;
  /**
   * Without a live account subscription, poll the directory at the normal
   * cadence only while a surface that shows node presence holds demand (see
   * `retainHostedDirectoryPresenceDemand`), and at the two-minute backstop
   * otherwise. For clients whose directory reads are costly: a device-key
   * signature and a radio wakeup each. Omitted, the normal cadence always
   * applies.
   */
  readonly demandDrivenDirectoryRefresh?: boolean;
  /**
   * Ask the account subscription to prove it is alive now (a ping with a short
   * bound) because something suggests it may not be: a relay request has gone
   * unanswered unusually long. A dead connection then fails through the
   * subscription's own loss path; nothing is published from here.
   */
  readonly probeHubSubscription?: () => void;
  readonly resetRelayAttemptFactory: () => void;
  readonly relayUrl: () => string;
  /**
   * Preparation awaited before each relay ticket/grant request: native public
   * trust preparation, or the web tier loading its handshake code. A rejection
   * fails the attempt before any ticket is spent.
   */
  readonly prepareRelaySocketContext?: () => Promise<unknown>;
  readonly issueRelayAttempt?: (input: {
    readonly nodeId: string;
    readonly generation: number;
    readonly preparedSocketContext: unknown;
  }) => Promise<{
    readonly ticket: string;
    readonly expiresAt: number;
    readonly preparedSocketContext: unknown;
  }>;
  readonly disposeRelaySocketContext?: (context: unknown) => void;
  /**
   * Native only: start the relay upgrade beside the ticket request. See
   * {@link HostedEarlyRelaySocket}.
   */
  readonly openEarlyRelaySocket?: () => HostedEarlyRelaySocket | undefined;
  /**
   * Whether the account session can open a relay channel the Hub authenticates itself (Hub
   * session version 2), so the attempt needs no HTTP ticket. Platforms without the account
   * session omit it and keep buying tickets.
   */
  readonly serverAuthenticatedRelayAvailable?: () => boolean;
  /** Open such a channel; required beside {@link serverAuthenticatedRelayAvailable}. */
  readonly createServerAuthenticatedRelaySocket?: (
    input: HostedServerAuthenticatedRelayInput,
  ) => unknown;
  readonly createRelaySocket: (input: {
    readonly url: string;
    /** The node this attempt's ticket was issued for. */
    readonly nodeId?: string;
    readonly ticket: string;
    readonly ticketExpiresAt: number;
    readonly earlySocket?: HostedEarlyRelaySocket;
    readonly preparedSocketContext?: unknown;
    /** Whether this attempt may use relay payload compression (§4.6). */
    readonly relayCompression?: boolean;
    readonly callbacks: {
      readonly onTransportStatus: (status: HostedRelayTransportStatus) => void;
      readonly onSessionStatus: (status: HostedRycoSessionStatus) => void;
      readonly onRole: (role: RelayEffectiveRole | null) => void;
      readonly onFailure: (failure: HostedRelayFailure) => void;
    };
  }) => unknown;
}

let configuration: HostedRuntimeConfiguration | null = null;
let api: HostedHubApi | null = null;
let lazyConfigurator: (() => void) | null = null;

/**
 * Register a one-shot configurator the runtime runs the first time it is
 * genuinely used. The app registers a closure at import that wires its platform
 * adapters, so importing the controller/store for their bindings has no import
 * side effect on those adapters (which lets suites mock them), while first use
 * still configures deterministically.
 */
export function setHostedRuntimeConfigurator(configure: () => void): void {
  lazyConfigurator = configure;
}

function ensureConfigured(): void {
  if (configuration || !lazyConfigurator) return;
  const configure = lazyConfigurator;
  lazyConfigurator = null;
  configure();
}

export function configureHostedRuntime(
  next: HostedRuntimeConfiguration,
  apiOverride?: HostedHubApi,
): void {
  lazyConfigurator = null;
  configuration = next;
  api = apiOverride ?? new HostedHubApi(next);
}

export function getHostedRuntimeConfiguration(): HostedRuntimeConfiguration {
  ensureConfigured();
  if (!configuration) throw new Error("Hosted runtime has not been configured.");
  return configuration;
}

/** The configured environment session mode; `single` while the runtime is unconfigured. */
export function hostedEnvironmentSessionsMode(): HostedEnvironmentSessionsMode {
  ensureConfigured();
  return configuration?.environmentSessions ?? "single";
}

export function getHostedHubApi(): HostedHubApi {
  ensureConfigured();
  if (!api) throw new Error("Hosted runtime has not been configured.");
  return api;
}
