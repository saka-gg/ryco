import type {
  DpopSignerService,
  EndpointService,
  HttpClientService,
  NativeAuthorizationService,
  PasskeyCeremonyService,
  SessionCredentialsService,
} from "../platform/index.ts";
import { HostedHubApi } from "./api.ts";
import type { HostedHubNode } from "./types.ts";
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
}

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
  readonly timers: HostedRuntimeTimers;
  readonly isForeground: () => boolean;
  readonly subscribeForeground: (listener: () => void) => () => void;
  readonly hasPendingRelayRequests: () => boolean;
  /** A live account subscription pushes directory changes independently of node channels. */
  readonly hasLiveHubSubscription?: () => boolean;
  readonly resetRelayAttemptFactory: () => void;
  readonly relayUrl: () => string;
  /** Native-only public trust preparation before the atomic ticket/grant request. */
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
  readonly createRelaySocket: (input: {
    readonly url: string;
    readonly ticket: string;
    readonly ticketExpiresAt: number;
    readonly preparedSocketContext?: unknown;
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

export function getHostedHubApi(): HostedHubApi {
  ensureConfigured();
  if (!api) throw new Error("Hosted runtime has not been configured.");
  return api;
}
