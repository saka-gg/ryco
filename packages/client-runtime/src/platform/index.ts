import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import * as Tracer from "effect/Tracer";
import type * as NativeE2eeContract from "@ryco/contracts/native-e2ee";

import type { KnownEnvironmentConnectionTarget } from "../knownEnvironment.ts";
import type { KnownEnvironmentSource } from "../knownEnvironment.ts";

export interface PrimaryEnvironmentTarget {
  readonly source: KnownEnvironmentSource;
  readonly target: KnownEnvironmentConnectionTarget;
}

/** Platform-owned primary endpoint resolution. */
export interface EndpointService {
  readonly origin: () => string;
  readonly readPrimaryTarget: () => PrimaryEnvironmentTarget | null;
  readonly resolveHttpUrl: (
    pathname: string,
    searchParams?: Readonly<Record<string, string>>,
  ) => string;
  readonly resolveWsUrl: (wsBaseUrl: string) => string;
}

export class Endpoint extends Context.Service<Endpoint, EndpointService>()(
  "@ryco/client-runtime/platform/Endpoint",
) {}

/** The WebSocket-constructor seam used by Effect socket layers and the relay. */
export interface SocketService {
  readonly webSocketConstructor: (
    url: string,
    protocols?: string | ReadonlyArray<string>,
  ) => unknown;
}

export class Socket extends Context.Service<Socket, SocketService>()(
  "@ryco/client-runtime/platform/Socket",
) {}

export type AppLifecycleEvent = "background" | "foreground" | "offline" | "online" | "resume";

/** Foreground/background, connectivity, and resume signals. */
export interface AppLifecycleService {
  readonly isForeground: () => boolean;
  readonly isOnline: () => boolean;
  readonly subscribe: (listener: (event: AppLifecycleEvent) => void) => () => void;
}

export class AppLifecycle extends Context.Service<AppLifecycle, AppLifecycleService>()(
  "@ryco/client-runtime/platform/AppLifecycle",
) {}

/** Plain asynchronous key-value storage for non-secret client state. */
export interface KVService {
  readonly getItem: (key: string) => Promise<string | null>;
  readonly setItem: (key: string, value: string) => Promise<void>;
  readonly removeItem: (key: string) => Promise<void>;
}

export class KV extends Context.Service<KV, KVService>()("@ryco/client-runtime/platform/KV") {}

/** Separate storage for bearer tokens and other secrets. */
export interface SecretKVService {
  readonly get: (key: string) => Promise<string | null>;
  /** Returns false when the platform could not persist the secret. */
  readonly set: (key: string, value: string) => Promise<boolean>;
  readonly remove: (key: string) => Promise<void>;
}

export class SecretKV extends Context.Service<SecretKV, SecretKVService>()(
  "@ryco/client-runtime/platform/SecretKV",
) {}

/** Minimal platform HTTP seam; runtime code never reads a global fetch implementation. */
export interface HttpResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly json: () => Promise<unknown>;
  readonly text: () => Promise<string>;
}

export interface HttpRequestInit {
  readonly method?: string;
  readonly headers?: unknown;
  readonly body?: string;
  readonly credentials?: "include" | "omit" | "same-origin";
  readonly cache?: "no-store";
  readonly signal?: AbortSignal;
}

export interface HttpClientService {
  readonly fetch: (url: string, init?: HttpRequestInit) => Promise<HttpResponse>;
}

export interface AuthenticationResponseJson {
  readonly id: string;
  readonly rawId: string;
  readonly response: {
    readonly clientDataJSON: string;
    readonly authenticatorData: string;
    readonly signature: string;
    readonly userHandle?: string;
  };
  readonly type: "public-key";
  readonly clientExtensionResults: unknown;
  readonly authenticatorAttachment?: "platform" | "cross-platform";
}

export interface RegistrationResponseJson {
  readonly id: string;
  readonly rawId: string;
  readonly response: {
    readonly clientDataJSON: string;
    readonly attestationObject: string;
    readonly transports?: ReadonlyArray<string>;
    readonly publicKeyAlgorithm?: number;
    readonly publicKey?: string | null;
    readonly authenticatorData?: string;
  };
  readonly type: "public-key";
  readonly clientExtensionResults: unknown;
  readonly authenticatorAttachment?: "platform" | "cross-platform";
}

/** Native/browser passkey ceremony; shared code validates options before calling it. */
export interface PasskeyCeremonyService {
  readonly authenticate: (
    options: unknown,
    signal?: unknown,
  ) => Promise<AuthenticationResponseJson>;
  readonly register: (options: unknown, signal?: unknown) => Promise<RegistrationResponseJson>;
}

export class PasskeyCeremony extends Context.Service<PasskeyCeremony, PasskeyCeremonyService>()(
  "@ryco/client-runtime/platform/PasskeyCeremony",
) {}

/**
 * Cookie or bearer session policy. Cookie adapters hold only the in-memory CSRF
 * token; bearer (native/DPoP) adapters additionally hold the native session
 * token behind `readBearerToken`/`writeBearerToken`. The bearer accessors are
 * optional so cookie adapters (web) stay untouched; a `mode:"bearer"` adapter
 * that omits them is a configuration error the hosted API rejects on
 * construction.
 */
export interface SessionCredentialsService {
  readonly mode: "bearer" | "cookie";
  readonly readCsrfToken: () => string | null;
  readonly writeCsrfToken: (token: string | null) => void;
  /** Bearer mode only: the persisted native session token (never a cookie). */
  readonly readBearerToken?: () => string | null;
  readonly writeBearerToken?: (token: string | null) => void;
}

export class SessionCredentials extends Context.Service<
  SessionCredentials,
  SessionCredentialsService
>()("@ryco/client-runtime/platform/SessionCredentials") {}

/**
 * The per-request DPoP proof input the hosted API hands the signer. `token` is
 * present on authenticated requests (the proof carries `ath`) and absent on the
 * login/mint ceremony (the proof carries no `ath`); the branch is driven purely
 * by whether a native session token is bound yet.
 */
export interface DpopProofInput {
  readonly method: string;
  readonly url: string;
  readonly token?: string;
}

/**
 * Platform DPoP signer seam (RFC 9449). Returns a compact-JWS proof for the
 * request. The mobile app supplies a Secure-Enclave/StrongBox-backed
 * implementation (the private key never enters the runtime); web never
 * instantiates it. Build one from a hardware key with `createDpopProofSigner`
 * (`@ryco/client-runtime/relay`) so the proof-construction and asym-alg
 * allow-list live in one shared place rather than being reimplemented.
 */
export interface DpopSignerService {
  readonly sign: (input: DpopProofInput) => Promise<string>;
}

export class DpopSigner extends Context.Service<DpopSigner, DpopSignerService>()(
  "@ryco/client-runtime/platform/DpopSigner",
) {}

export interface NativeE2eeIdentityDescriptor {
  /** X9.63 uncompressed P-256 public key. The private key never crosses this seam. */
  readonly publicKey: Uint8Array;
  readonly fingerprint: Uint8Array;
  readonly backing: NativeE2eeContract.NativeE2eeUsableKeyBacking;
}

export interface NativeE2eePrekeyDescriptor {
  readonly agreementPublicKey: Uint8Array;
  readonly agreementFingerprint: Uint8Array;
  readonly transcript: Uint8Array;
  readonly signature: Uint8Array;
  /** Exact public §7.4 certificate carrier. */
  readonly certificate: Uint8Array;
  readonly certificateDigest: Uint8Array;
  readonly expiresAt: number;
}

export interface NativeE2eeEnrollmentNamespace {
  readonly hubOrigin: string;
  readonly accountId: string;
}

/** Public continuity metadata learned through a valid account grant; never a verified pin. */
export interface NativeE2eeAccountTrustedNode {
  readonly hubOrigin: string;
  readonly accountId: string;
  readonly nodeId: string;
  readonly identityPublicKey: Uint8Array;
  readonly identityFingerprint: Uint8Array;
  readonly agreementFingerprint: Uint8Array;
  readonly continuityId: string;
  readonly acceptedPolicyGeneration: number;
  readonly firstTrustedAt: number;
  readonly lastTrustedAt: number;
  /** Bounded public audit trail; it is account-authorized continuity, never a verified pin. */
  readonly identityChanges: readonly NativeE2eeAccountTrustIdentityChange[];
}

export interface NativeE2eeAccountTrustIdentityChange {
  readonly previousIdentityFingerprint: Uint8Array;
  readonly nextIdentityFingerprint: Uint8Array;
  readonly changedAt: number;
}

/**
 * Native-only custody for automatic account enrollment. Browser adapters must not implement this.
 * Every secret borrow is bounded to one callback and must be zeroized by the platform on settlement.
 */
export interface NativeE2eePlatformService {
  readonly platform: NativeE2eeContract.NativeE2eePlatform;
  readonly appVersion: string;
  readonly deviceLabel: () => string;
  readonly randomBytes: (length: number) => Promise<Uint8Array>;
  readonly ensureIdentity: () => Promise<NativeE2eeIdentityDescriptor>;
  readonly ensureClientPrekey: (
    namespace: NativeE2eeEnrollmentNamespace,
  ) => Promise<NativeE2eePrekeyDescriptor>;
  readonly getOrCreateEnrollmentId: () => Promise<string>;
  readonly clearEnrollment: (namespace: NativeE2eeEnrollmentNamespace) => Promise<void>;
  readonly withAgreementSecret: <A>(use: (secretKey: Uint8Array) => Promise<A> | A) => Promise<A>;
  readonly readAccountTrustedNode: (scope: {
    readonly hubOrigin: string;
    readonly accountId: string;
    readonly nodeId: string;
  }) => Promise<NativeE2eeAccountTrustedNode | null>;
  readonly writeAccountTrustedNode: (record: NativeE2eeAccountTrustedNode) => Promise<void>;
}

export type NativeAuthorizationBrowserResult =
  | { readonly type: "success"; readonly url: string }
  | { readonly type: "cancel" | "dismiss" | "locked" };

/**
 * Platform primitives for the native system-browser authorization handoff.
 *
 * The shared runtime owns PKCE, state, callback validation, and credential
 * adoption. A platform adapter supplies only non-exportable primitives and the
 * browser presentation; it never receives or stores the resulting session
 * token.
 */
export interface NativeAuthorizationService {
  /** One of the exact callback URIs supported by the public handoff contract. */
  readonly callbackUri: () => string;
  /** A short, user-recognizable device label sent to the browser consent view. */
  readonly deviceLabel: () => string;
  readonly randomBytes: (length: number) => Promise<Uint8Array>;
  readonly sha256: (value: Uint8Array) => Promise<Uint8Array>;
  readonly openSystemBrowser: (
    authorizationUrl: string,
    callbackUri: string,
    signal?: AbortSignal,
  ) => Promise<NativeAuthorizationBrowserResult>;
}

/**
 * Reads a pairing credential once and atomically destroys its source before returning it.
 * Implementations must never leave the credential available through history or a deep link.
 */
export interface PairingCredentialSourceService {
  readonly take: () => Promise<string | null>;
}

export class PairingCredentialSource extends Context.Service<
  PairingCredentialSource,
  PairingCredentialSourceService
>()("@ryco/client-runtime/platform/PairingCredentialSource") {}

export type ComposerAttachment =
  | {
      readonly id: string;
      readonly mime: string;
      readonly size: number;
      readonly bytes: Uint8Array;
    }
  | {
      readonly id: string;
      readonly mime: string;
      readonly size: number;
      readonly uri: string;
    };

/** Converts a platform attachment to and from the neutral composer attachment value. */
export interface AttachmentCodecService {
  readonly encode: (attachment: unknown) => Promise<ComposerAttachment>;
  readonly decode: (attachment: ComposerAttachment) => Promise<unknown>;
}

export class AttachmentCodec extends Context.Service<AttachmentCodec, AttachmentCodecService>()(
  "@ryco/client-runtime/platform/AttachmentCodec",
) {}

export interface ClockService {
  readonly now: () => number;
}

export class Clock extends Context.Service<Clock, ClockService>()(
  "@ryco/client-runtime/platform/Clock",
) {}

export interface FrameSchedulerService {
  readonly scheduleFrame: (callback: () => void) => void;
}

export class FrameScheduler extends Context.Service<FrameScheduler, FrameSchedulerService>()(
  "@ryco/client-runtime/platform/FrameScheduler",
) {}

export interface ObservabilityService {
  readonly tracingLayer: Layer.Layer<never, never, never>;
  /**
   * Cheap gate consulted before building performance payloads so inert
   * observability adds no work to hot paths.
   */
  readonly performanceEnabled: () => boolean;
  readonly recordPerformance: (
    label: string,
    value?: unknown,
    record?: { readonly count?: number; readonly durationMs?: number },
  ) => void;
}

const noopTracer = Tracer.make({
  span(options) {
    return new Tracer.NativeSpan(options);
  },
});

/** The default emits no telemetry and records no performance payloads. */
export const NOOP_OBSERVABILITY: ObservabilityService = {
  tracingLayer: Layer.succeed(Tracer.Tracer, noopTracer),
  performanceEnabled: () => false,
  recordPerformance: () => undefined,
};

export const Observability = Context.Reference<ObservabilityService>(
  "@ryco/client-runtime/platform/Observability",
  { defaultValue: () => NOOP_OBSERVABILITY },
);

export type ClientMode = "hosted-hub" | "standard";

/** Bootstrap configuration replacing ambient import.meta.env reads. */
export interface ClientRuntimeConfigService {
  readonly clientMode: ClientMode;
  readonly httpBaseUrl?: string;
  readonly wsBaseUrl?: string;
  readonly hostedAppUrl?: string;
  readonly devServerUrl?: string;
  readonly perfProfile?: string;
}

export class ClientRuntimeConfig extends Context.Service<
  ClientRuntimeConfig,
  ClientRuntimeConfigService
>()("@ryco/client-runtime/platform/ClientRuntimeConfig") {}
