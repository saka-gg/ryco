import { networkInterfaces } from "node:os";

import type {
  HubConnectorFailureCode,
  HubConnectorStatus,
  HubEnrollmentCeremonyDetail,
  HubEnrollmentStartResult,
  HubIdentitySummary,
} from "@ryco/contracts";
import {
  RELAY_ACCOUNT_GRANT_MINOR,
  type RelayConnectorGeneration,
  type RelayE2eeDigest,
  type RelayE2eeEnrollmentRevokedFrame,
  type RelayErrorFrame,
  type RelayFrame,
} from "@ryco/contracts/relay";
import { formatNodePublicKeyFingerprint } from "@ryco/shared/nodeIdentity";
import { E2EE_MAX_CLOCK_SKEW } from "@ryco/shared/relayE2eeConstants";

import type { HubConnectorConfig } from "../config.ts";
import type { HubEnrollmentMetadata } from "../hubIdentity/HubEnrollmentClient.ts";
import type { HubIdentityProcessLock } from "../hubIdentity/HubIdentityProcessLock.ts";
import type { NodeE2eeAdvertisement } from "../hubIdentity/NodeE2eeCapabilityStatement.ts";
import type { E2eeAccountGrantNodeVerificationInput } from "@ryco/shared/relayE2eeHandshake";
import {
  classifyConnectorFailure,
  type ConnectorFailureKind,
  type HubConnectorE2eeSnapshot,
  HubConnectorE2eeStateMachine,
  HubConnectorStateMachine,
} from "./HubConnectorState.ts";
import { HubIdentityRuntimeError, type HubIdentityRuntimeShape } from "./HubIdentityRuntime.ts";
import type { HubRelayTransport } from "./HubRelayTransport.ts";
import {
  relayErrorKind,
  RelayConnectionError,
  RelayConnectionSession,
  type RelaySessionScheduler,
} from "./RelayConnectionSession.ts";
import {
  RelayChannelProtocolError,
  RelayChannelRegistry,
  type RelayChannelSessionFactory,
} from "./RelayChannelRegistry.ts";
import { resolveHubEnrollmentLabel } from "./HubEnrollmentLabel.ts";
import {
  reconnectDelay,
  type ReconnectPolicyConfig,
  slowRetryDelay,
  type SlowRetryPolicy,
} from "./ReconnectPolicy.ts";
import { RelaySendQueue } from "./RelaySendQueue.ts";
import {
  makeNodeAccountGrantVerifier,
  type NodeAccountGrantVerificationResult,
  type NodeAccountGrantVerifier,
} from "./NodeAccountGrantVerifier.ts";

export interface HubConnectorScheduler extends RelaySessionScheduler {
  readonly now: () => number;
  readonly random: () => number;
}

/**
 * The connector watches for the two events that silently kill an outbound
 * socket — the machine sleeping and the network changing — instead of waiting
 * out the Hub's 45-second heartbeat timeout after each.
 */
const LIVENESS_WATCH_INTERVAL_MS = 5_000;
/** A watch tick this late means the process was suspended: the machine slept. */
const LIVENESS_WATCH_WAKE_GAP_MS = 15_000;
/** How long a node-initiated ping may wait for its pong before the socket is declared dead. */
const LIVENESS_PROBE_TIMEOUT_MS = 5_000;
const RELAY_HEARTBEAT_NONCE_BYTES = 8;
/**
 * Republishing a capability statement the node could not build: soon, because
 * account-grant channels are refused until it is acknowledged, then less often.
 */
const E2EE_STATEMENT_UNAVAILABLE_RETRY: ReconnectPolicyConfig = {
  baseDelayMs: 30_000,
  maxDelayMs: 300_000,
  jitterRatio: 0.2,
};
/** Republishing after a refresh threw — usually a send queue that drains in moments. */
const E2EE_STATEMENT_FAILURE_RETRY: ReconnectPolicyConfig = {
  baseDelayMs: 1_000,
  maxDelayMs: 30_000,
  jitterRatio: 0.2,
};
/** Consecutive republish failures after which the connection is rebuilt. */
const E2EE_STATEMENT_REFRESH_FAILURE_LIMIT = 3;
/** The rolling window a slow-retry policy's `maxPerHour` counts over. */
const SLOW_RETRY_BUDGET_WINDOW_MS = 3_600_000;

/** The machine's external addresses; a change means the network moved under the socket. */
export function defaultNetworkFingerprint(): string {
  return Object.values(networkInterfaces())
    .flatMap((entries) => entries ?? [])
    .filter((entry) => !entry.internal)
    .map((entry) => entry.address)
    .toSorted()
    .join(",");
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

/**
 * Distinguish a custody read that may succeed later from one that cannot.
 *
 * A construction failure is latched into a stub whose every method throws for
 * the process lifetime, so `resume()` provably cannot repair it. Reporting both
 * as `identity_unavailable` would have the panel offer a Retry that does
 * nothing.
 */
/** Another local Ryco process holds this node identity's process lock. */
export class HubIdentityInUseError extends Error {
  constructor() {
    super("Hub identity is in use by another Ryco process.");
    this.name = "HubIdentityInUseError";
  }
}

const identityFailure = (error: unknown): "identity_unavailable" | "identity_store_unavailable" =>
  error instanceof HubIdentityRuntimeError && error.code === "identity_store_unavailable"
    ? "identity_store_unavailable"
    : "identity_unavailable";

const defaultScheduler: HubConnectorScheduler = {
  now: Date.now,
  random: Math.random,
  setTimeout: (callback, milliseconds) => setTimeout(callback, milliseconds),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export class HubConnector {
  readonly #config: HubConnectorConfig;
  readonly #identity: HubIdentityRuntimeShape;
  readonly #transport: HubRelayTransport;
  readonly #channels: RelayChannelSessionFactory;
  readonly #enrollmentMetadata: HubEnrollmentMetadata;
  readonly #scheduler: HubConnectorScheduler;
  readonly #state: HubConnectorStateMachine;
  readonly #e2eeState: HubConnectorE2eeStateMachine;
  readonly #accountGrantVerifier: NodeAccountGrantVerifier;
  readonly #onE2eeEnrollmentRevoked: (
    frame: RelayE2eeEnrollmentRevokedFrame,
  ) => void | Promise<void>;
  readonly #networkFingerprint: () => string;
  readonly #livenessWatchEnabled: boolean;
  readonly #processLock: HubIdentityProcessLock | undefined;
  /**
   * Whether this process owns the identity: it holds the process lock, or no
   * lock is configured. A lock that could not be used lets one use proceed
   * without making this true (`#takeIdentity`).
   */
  #ownsIdentity: boolean;
  readonly #beforeConnect: () => Promise<void>;
  #watchTimer: unknown;
  #watchLastTickAt: number | undefined;
  #watchLastNetwork: string | undefined;
  #probe:
    | { readonly generation: number; readonly nonce: Uint8Array; readonly timer: unknown }
    | undefined;
  #attempt = 0;
  #protocolViolations = 0;
  #staleProofRetries = 0;
  /**
   * Attempt counters for `slow_retry`, one per schedule rather than per reported
   * failure: a duplicate caught by the local lock and one the Hub displaced are
   * both reported as `connection_replaced`, and checking a lock file must not
   * stretch the gap before displacing a remote copy. Reset by stability or an
   * explicit resume.
   */
  readonly #slowAttempts = new Map<SlowRetryPolicy, number>();
  /**
   * When each capped slow retry was scheduled, for its rolling-hour budget.
   * Deliberately not reset by stability: two duplicates that swap every few
   * minutes each look stable in between.
   */
  readonly #slowRetryLog = new Map<SlowRetryPolicy, number[]>();
  /**
   * What `nudge` runs in place of the scheduled retry, or undefined when that
   * retry must keep its own schedule.
   */
  #retryNudge: (() => void) | undefined;
  #started = false;
  #stopping = false;
  #connecting = false;
  /**
   * The Hub-issued id of the identity this connector authenticates with.
   *
   * Cached from every identity read rather than fetched on demand: a channel
   * session that has to bind to it reads it synchronously, and it is exposed to
   * the registry as a getter so a channel opened before the read completes
   * still sees the value once it lands. Cleared whenever a read reports no
   * active node, so a later channel can never be handed the id of an
   * enrollment that no longer exists.
   */
  #nodeId: string | undefined;
  #session: RelayConnectionSession | undefined;
  #sendQueue: RelaySendQueue | undefined;
  #registry: RelayChannelRegistry | undefined;
  #retryTimer: unknown;
  #enrollmentTimer: unknown;
  #stableTimer: unknown;
  #heartbeatTimer: unknown;
  #drainTimer: unknown;
  #e2eeStatementTimer: unknown;
  /** Backoff position for republishing a statement this generation could not publish. */
  #e2eeStatementAttempt = 0;
  /** Consecutive republishes that threw, this generation; reset by a publish. */
  #e2eeStatementFailures = 0;
  #frameChain: Promise<void> = Promise.resolve();
  #e2eeRefreshChain: Promise<void> = Promise.resolve();

  constructor(options: {
    readonly config: HubConnectorConfig;
    readonly identity: HubIdentityRuntimeShape;
    readonly transport: HubRelayTransport;
    readonly channels: RelayChannelSessionFactory;
    readonly enrollmentMetadata: HubEnrollmentMetadata;
    readonly scheduler?: HubConnectorScheduler;
    readonly onE2eeEnrollmentRevoked?: (
      frame: RelayE2eeEnrollmentRevokedFrame,
    ) => void | Promise<void>;
    /** Injectable for tests; see `defaultNetworkFingerprint`. */
    readonly networkFingerprint?: () => string;
    /** Watch for wake and network changes; see `nudge`. On unless a test opts out. */
    readonly livenessWatch?: boolean;
    /** Keeps a second local process off this identity; see `HubIdentityProcessLock`. */
    readonly processLock?: HubIdentityProcessLock;
    /**
     * The caller already acquired `processLock` before it built the identity
     * runtime, as `HubConnectorLive` does so that a backend that loses the lock
     * defers its startup work. Otherwise the connector claims the lock itself,
     * when it first needs the identity.
     */
    readonly ownsIdentity?: boolean;
    /**
     * Awaited before every relay connection attempt opens its socket. The
     * server hands the process to the Hub here, which closes external Agent
     * Control integrations first. A failure ends the attempt like any other
     * connection failure, so the socket never opens without it.
     */
    readonly beforeConnect?: () => Promise<void>;
  }) {
    this.#config = options.config;
    this.#identity = options.identity;
    this.#transport = options.transport;
    this.#channels = options.channels;
    this.#enrollmentMetadata = options.enrollmentMetadata;
    this.#scheduler = options.scheduler ?? defaultScheduler;
    this.#state = new HubConnectorStateMachine(this.#scheduler.now);
    this.#e2eeState = new HubConnectorE2eeStateMachine(this.#scheduler.now);
    this.#accountGrantVerifier = makeNodeAccountGrantVerifier({
      state: this.#e2eeState,
      connectorGeneration: () => this.#state.generation,
      policy: () => this.#identity.e2eePolicy(),
      authorization: this.#identity.e2eeClientAuthorization,
    });
    this.#onE2eeEnrollmentRevoked = options.onE2eeEnrollmentRevoked ?? (() => undefined);
    this.#networkFingerprint = options.networkFingerprint ?? defaultNetworkFingerprint;
    this.#livenessWatchEnabled = options.livenessWatch ?? true;
    this.#processLock = options.processLock;
    this.#ownsIdentity = options.processLock === undefined || options.ownsIdentity === true;
    this.#beforeConnect = options.beforeConnect ?? (async () => undefined);
  }

  /**
   * Something suggests the Hub connection is dead, or newly possible: the
   * machine woke, or the network changed. An online connector proves its socket
   * with a ping it expects answered within `LIVENESS_PROBE_TIMEOUT_MS`; one
   * backing off retries now, with a fresh backoff, rather than when a timer
   * grown during the outage fires. Every other state is left alone — in
   * particular nothing here retries a failure that needs operator action, or
   * brings forward a slow retry whose spacing is the point of it (a duplicate
   * process, a refused proof).
   */
  nudge(): void {
    if (!this.#started || this.#stopping) return;
    const status = this.#state.snapshot();
    if (status.state === "online") {
      this.#probeLiveness(this.#state.generation);
      return;
    }
    const retry = this.#retryNudge;
    if (
      status.state === "degraded" &&
      status.degradedMode === "backing_off" &&
      this.#retryTimer !== undefined &&
      retry !== undefined
    ) {
      this.#clearTimer("retry");
      this.#attempt = 0;
      retry();
    }
  }

  #startLivenessWatch(): void {
    if (!this.#livenessWatchEnabled || this.#watchTimer !== undefined) return;
    this.#watchLastTickAt = this.#scheduler.now();
    this.#watchLastNetwork = this.#networkFingerprint();
    this.#watchTimer = this.#scheduler.setTimeout(
      () => this.#livenessWatchTick(),
      LIVENESS_WATCH_INTERVAL_MS,
    );
  }

  #livenessWatchTick(): void {
    this.#watchTimer = undefined;
    if (this.#stopping) return;
    const now = this.#scheduler.now();
    const woke =
      this.#watchLastTickAt !== undefined &&
      now - this.#watchLastTickAt > LIVENESS_WATCH_INTERVAL_MS + LIVENESS_WATCH_WAKE_GAP_MS;
    this.#watchLastTickAt = now;
    let networkChanged = false;
    try {
      const network = this.#networkFingerprint();
      networkChanged = this.#watchLastNetwork !== undefined && network !== this.#watchLastNetwork;
      this.#watchLastNetwork = network;
    } catch {
      // An unreadable interface list is not evidence of a change.
    }
    if (woke || networkChanged) this.nudge();
    this.#watchTimer = this.#scheduler.setTimeout(
      () => this.#livenessWatchTick(),
      LIVENESS_WATCH_INTERVAL_MS,
    );
  }

  #stopLivenessWatch(): void {
    if (this.#watchTimer !== undefined) this.#scheduler.clearTimeout(this.#watchTimer);
    this.#watchTimer = undefined;
    this.#watchLastTickAt = undefined;
    this.#watchLastNetwork = undefined;
  }

  #probeLiveness(generation: number): void {
    if (this.#probe !== undefined) return;
    const ready = this.#session?.ready;
    if (ready === undefined || this.#sendQueue === undefined) return;
    const nonce = crypto.getRandomValues(new Uint8Array(RELAY_HEARTBEAT_NONCE_BYTES));
    if (
      !this.#sendQueue.enqueueControl({
        type: "ping",
        protocolMajor: ready.protocolMajor,
        protocolMinor: ready.protocolMinor,
        nonce,
      })
    ) {
      void this.#handleFailure(generation, "internal_error");
      return;
    }
    const timer = this.#scheduler.setTimeout(() => {
      if (this.#probe?.timer !== timer) return;
      this.#probe = undefined;
      void this.#handleFailure(generation, "heartbeat_timeout");
    }, LIVENESS_PROBE_TIMEOUT_MS);
    this.#probe = { generation, nonce, timer };
    this.#flushAndScheduleDrain(generation);
  }

  #clearProbe(): void {
    if (this.#probe !== undefined) this.#scheduler.clearTimeout(this.#probe.timer);
    this.#probe = undefined;
  }

  status(): HubConnectorStatus {
    return this.#state.snapshot();
  }

  e2eeSnapshot(): HubConnectorE2eeSnapshot {
    return this.#e2eeState.snapshot();
  }

  /** Exact acknowledged statement selected by a minor-3 ticket context. */
  accountGrantAdvertisement(statementDigest: Uint8Array): NodeE2eeAdvertisement | undefined {
    return this.#e2eeState.accountGrantMaterial(this.#state.generation, statementDigest)
      ?.advertisement;
  }

  /** Synchronous row-N3 verification; performs no fetch and no durable mutation. */
  verifyAccountGrant(
    input: E2eeAccountGrantNodeVerificationInput,
  ): NodeAccountGrantVerificationResult {
    return this.#accountGrantVerifier.verify(input);
  }

  /** Republish after a committed identity, prekey, continuity, suite, or policy change. */
  refreshE2eeState(): Promise<void> {
    const generation = this.#state.generation;
    // The advertised inputs have already changed by the time an operator calls
    // this method. Withdraw the old acknowledgement synchronously, before the
    // first await, so a concurrently delivered channel cannot spend it while
    // the replacement statement is still being built.
    this.#e2eeState.clearStatement(generation);
    const refresh = this.#e2eeRefreshChain.then(() => this.#publishE2eeState(generation));
    this.#e2eeRefreshChain = refresh.catch(() => this.#e2eeRefreshFailed(generation));
    return refresh;
  }

  /**
   * A republish threw, whoever asked for it — an operator command or the
   * refresh timer.
   *
   * The statement was withdrawn before the attempt, so nothing is advertised
   * that should not be. What usually throws is a full send queue — the same
   * condition a channel burst produces and drains in moments — so it is retried
   * shortly rather than taken as a dead connection: rebuilding the connection
   * would close every live channel to republish one control frame. Only
   * failures that persist past the limit rebuild it.
   */
  #e2eeRefreshFailed(generation: number): void {
    if (!this.#state.isCurrent(generation) || this.#stopping) return;
    this.#e2eeStatementFailures += 1;
    if (this.#e2eeStatementFailures >= E2EE_STATEMENT_REFRESH_FAILURE_LIMIT) {
      void this.#handleFailure(generation, "internal_error");
      return;
    }
    this.#scheduleE2eeStatementRetry(generation, E2EE_STATEMENT_FAILURE_RETRY);
  }

  async start(): Promise<void> {
    if (this.#started || this.#stopping) return;
    this.#started = true;
    const generation = this.#state.generation;
    if (!this.#config.enabled) return;
    if (!this.#runsConnector()) {
      this.#state.transition("degraded", {
        degradedMode: "operator_action_required",
        failure: "configuration_invalid",
      });
      // A connector that cannot connect does not keep another copy that can
      // off the identity; an operation that needs it claims it for its length.
      await this.#handBackIdentity();
      return;
    }
    this.#startLivenessWatch();
    await this.#establish(generation);
  }

  /**
   * Retry now, on an operator's say-so.
   *
   * Clears any scheduled retry and the slow-retry budgets: an owner pressing
   * Retry after stopping a duplicate process, or unlocking a keychain, has
   * told the connector something its own schedule could not know. A
   * connection that is already up, or on its way up, is left alone.
   */
  async resume(): Promise<void> {
    if (!this.#started || this.#stopping || !this.#config.enabled) return;
    if (this.#state.snapshot().state === "revoked") return;
    if (this.#session !== undefined || this.#connecting) return;
    this.#clearTimer("retry");
    this.#slowAttempts.clear();
    this.#slowRetryLog.clear();
    // The free retry for a proof that outlived its challenge is part of the
    // same budget: a Retry after a slow keychain prompt gets it back.
    this.#staleProofRetries = 0;
    if (!this.#runsConnector()) {
      this.#state.transition("degraded", {
        degradedMode: "operator_action_required",
        failure: "configuration_invalid",
      });
      return;
    }
    await this.#establish(this.#state.generation);
  }

  /**
   * Read the identity this connector should authenticate as, and connect with
   * it — or land in the state that identity calls for.
   *
   * Shared by `start()`, `resume()`, and every slow retry. A custody read that
   * fails goes through the same classification as a failed connection, so a
   * keychain that is locked at launch is retried on its own schedule instead of
   * parking the node until someone runs `ryco hub resume`.
   */
  async #establish(generation: number): Promise<void> {
    if (!(await this.#claimIdentity(generation))) return;
    let identity;
    try {
      await this.#completeIdentityStartup();
      identity = await this.#identity.readState();
    } catch (error: unknown) {
      await this.#handleFailure(generation, identityFailure(error));
      return;
    }
    if (!this.#state.isCurrent(generation) || this.#stopping) return;
    if (identity.activeNode === null) {
      this.#state.transition(
        identity.pendingEnrollment === null ? "enrolling" : "awaiting_approval",
      );
      if (identity.pendingEnrollment !== null) this.#scheduleEnrollmentPoll(0);
      return;
    }
    if (identity.activeNode.hubOrigin !== this.#config.origin) {
      this.#state.transition("degraded", {
        degradedMode: "operator_action_required",
        failure: "identity_origin_mismatch",
      });
      return;
    }
    this.#nodeId = identity.activeNode.nodeId;
    await this.#connect();
  }

  /**
   * Take this identity's process lock before anything reads or uses it.
   *
   * A held lock is reported as `connection_replaced` — the condition it
   * prevents — and retried on a short local schedule, so the second copy takes
   * over on its own once the first one exits. False means the caller must stop.
   */
  async #claimIdentity(generation: number): Promise<boolean> {
    const claim = await this.#takeIdentity();
    if (this.#stopping) {
      // `stop()` handed the identity back while this claim was in flight.
      await this.#handBackIdentity();
      return false;
    }
    if (!this.#state.isCurrent(generation)) return false;
    if (claim === "held") {
      await this.#handleFailure(generation, "identity_in_use");
      return false;
    }
    return true;
  }

  /**
   * Make this process the identity's owner, unless another live one is.
   *
   * `claimed` means ownership was taken just now, so a caller whose connector
   * will not run can hand it back; ownership is recorded before any caller
   * looks at its own generation, so a superseded caller cannot leave the lock
   * file naming this process while the connector believes it does not.
   *
   * `unlocked` means the lock could not be used: the caller carries on, as the
   * lock's contract says, but ownership is not recorded, so the next caller
   * asks the lock again. Recording it would keep this process on the identity
   * for good after one failed read — while another process that read the same
   * file a moment later holds the lock.
   */
  async #takeIdentity(): Promise<"owned" | "claimed" | "unlocked" | "held"> {
    const lock = this.#processLock;
    if (lock === undefined || this.#ownsIdentity) return "owned";
    const result = await lock.acquire();
    if (result !== "acquired") return result === "held" ? "held" : "unlocked";
    this.#ownsIdentity = true;
    return "claimed";
  }

  /** Let another local copy take the identity without waiting for this process to exit. */
  async #handBackIdentity(): Promise<void> {
    if (this.#processLock === undefined) return;
    this.#ownsIdentity = false;
    await this.#processLock.release();
  }

  /**
   * Startup work the identity runtime deferred because another process owned
   * the identity when it was built — finishing an interrupted leave, retired-key
   * destruction, prekey and continuity repair, the launch policy commit. Run
   * once this process owns the identity, before anything else uses it; a no-op
   * once done, and for a runtime that never deferred.
   */
  async #completeIdentityStartup(): Promise<void> {
    await this.#identity.completeStartup?.();
  }

  /** Whether this connector is configured to connect, and so keeps a claim it takes. */
  #runsConnector(): boolean {
    return (
      this.#config.enabled &&
      this.#config.configurationIssue === undefined &&
      this.#config.origin !== undefined
    );
  }

  /** Mutating an identity another local process is connected with would pull it out from under it. */
  async #requireIdentityOwnership(): Promise<void> {
    if ((await this.#takeIdentity()) === "held") throw new HubIdentityInUseError();
    await this.#completeIdentityStartup();
  }

  /**
   * Run an operation that changes this identity's shared state, as its owner.
   *
   * For the surfaces outside the connector that write what the identity's
   * owner relies on: the desktop's native claim, which commits an active node;
   * the local trusted introduction, which approves a client; and the E2EE owner
   * commands, whose commit-then-sweep could otherwise commit here and sweep
   * nothing, leaving the owning process's live channels under authority that
   * was just withdrawn. Refused while another local process owns the identity.
   * A claim taken for an operation is kept when this connector runs — it will
   * use the identity next — and handed back afterwards when it does not.
   */
  async asIdentityOwner<A>(operation: () => Promise<A>): Promise<A> {
    if (this.#stopping) throw new Error("Hub identity is unavailable while stopping.");
    const claim = await this.#takeIdentity();
    if (claim === "held") throw new HubIdentityInUseError();
    try {
      await this.#completeIdentityStartup();
      return await operation();
    } finally {
      if (claim === "claimed" && (!this.#runsConnector() || this.#stopping)) {
        await this.#handBackIdentity();
      }
    }
  }

  async enroll(): Promise<HubEnrollmentStartResult> {
    const origin = this.#enrollmentOrigin();
    await this.#requireIdentityOwnership();
    const initialGeneration = this.#state.generation;
    const state = await this.#identity.readState();
    if (!this.#state.isCurrent(initialGeneration) || this.#stopping) {
      throw new Error("Hub enrollment start was superseded.");
    }
    if (state.activeNode !== null || state.pendingEnrollment !== null) {
      throw new Error("Hub enrollment cannot be started in the current state.");
    }
    const generation = this.#state.invalidateGeneration();
    this.#clearAllTimers();
    this.#state.transition("enrolling");
    let enrollmentStarted = false;
    try {
      const enrollmentMetadata: HubEnrollmentMetadata = {
        ...this.#enrollmentMetadata,
        label: resolveHubEnrollmentLabel({
          configuredNodeName: this.#config.nodeName,
          machineLabel: this.#enrollmentMetadata.label,
          environmentId: state.environmentId,
        }),
      };
      const started = await this.#identity.startEnrollment(origin, enrollmentMetadata);
      enrollmentStarted = true;
      if (!this.#state.isCurrent(generation) || this.#stopping) {
        throw new Error("Hub enrollment start was superseded.");
      }
      const fingerprint = formatNodePublicKeyFingerprint(started.publicKey.fingerprint);
      const expiresAt = new Date(started.expiresAt).toISOString();
      this.#state.transition("awaiting_approval");
      this.#scheduleEnrollmentPoll(started.pollIntervalMs);
      return {
        status: this.status(),
        deviceCode: started.deviceCode,
        fingerprint,
        label: enrollmentMetadata.label,
        platformOs: enrollmentMetadata.platformOs,
        platformArch: enrollmentMetadata.platformArch,
        clientVersion: enrollmentMetadata.clientVersion,
        algorithm: started.publicKey.algorithm,
        expiresAt,
        pollIntervalMs: started.pollIntervalMs,
      };
    } catch {
      if (enrollmentStarted) {
        this.#clearTimer("enrollment");
        await this.#identity.cancelEnrollment(origin).catch(() => undefined);
      }
      if (!this.#state.isCurrent(generation) || this.#stopping) {
        throw new Error("Hub enrollment start was superseded.");
      }
      this.#state.transition("degraded", {
        degradedMode: "operator_action_required",
        failure: "enrollment_unavailable",
      });
      throw new Error("Hub enrollment could not be started.");
    }
  }

  /**
   * Whether this node holds a Hub identity, independent of connector state.
   *
   * `status()` reports `disabled` both when nothing was ever enrolled and when an
   * identity exists with the connector switched off — `start()` returns before
   * reading identity state in both the disabled and misconfigured branches — so a
   * caller that must not offer to re-point an enrolled node cannot rely on it.
   *
   * A custody read that fails reports `unknown` rather than `none`: claiming "not
   * enrolled" because the keychain is locked would invite overwriting a real
   * identity.
   */
  /**
   * `fingerprint: false` answers from the state files alone. The fingerprint
   * is derived from the private key in key custody, which a caller that only
   * needs the enrollment state (such as a periodic probe) must not open.
   */
  async identitySummary(options?: { readonly fingerprint?: boolean }): Promise<HubIdentitySummary> {
    try {
      const state = await this.#identity.readState();
      // A committed teardown means the erase is under way: the keys it names may
      // already be gone. Reporting the surviving activeNode as "active" would
      // present an enrollment with nothing behind it, lock the Hub address, and
      // leave no in-panel way to correct it.
      if (state.pendingTeardown !== null) return { enrolled: "none" };
      if (state.activeNode !== null) {
        if (options?.fingerprint === false) return { enrolled: "active" };
        const fingerprint = await this.#identity.readActiveFingerprint?.();
        return {
          enrolled: "active",
          ...(fingerprint === null || fingerprint === undefined ? {} : { fingerprint }),
        };
      }
      if (state.pendingEnrollment !== null) return { enrolled: "pending" };
      return { enrolled: "none" };
    } catch {
      return { enrolled: "unknown" };
    }
  }

  /**
   * Re-read the pending ceremony so the comparison survives losing the start
   * response.
   *
   * Returns null when nothing is pending, and null when the ceremony predates
   * device-code persistence — an approver cannot act on a code we cannot show,
   * and reporting a partial ceremony would imply otherwise.
   */
  async readEnrollment(): Promise<HubEnrollmentCeremonyDetail | null> {
    const origin = this.#enrollmentOrigin();
    const pending = await this.#identity.readPendingEnrollment(origin);
    if (
      pending === null ||
      pending.deviceCode === null ||
      pending.expiresAt === null ||
      pending.pollIntervalMs === null
    ) {
      // Either nothing is pending, or the start response never committed. A
      // half-written ceremony is not one an approver can act on.
      return null;
    }
    return {
      deviceCode: pending.deviceCode,
      fingerprint: formatNodePublicKeyFingerprint(pending.fingerprint),
      label: pending.label ?? this.#enrollmentMetadata.label,
      platformOs: this.#enrollmentMetadata.platformOs,
      platformArch: this.#enrollmentMetadata.platformArch,
      clientVersion: this.#enrollmentMetadata.clientVersion,
      algorithm: pending.algorithm,
      expiresAt: new Date(pending.expiresAt).toISOString(),
      pollIntervalMs: pending.pollIntervalMs,
    };
  }

  async cancelEnrollment(): Promise<HubConnectorStatus> {
    const origin = this.#enrollmentOrigin();
    await this.#requireIdentityOwnership();
    const initialGeneration = this.#state.generation;
    const identity = await this.#identity.readState();
    if (!this.#state.isCurrent(initialGeneration) || this.#stopping) {
      throw new Error("Hub enrollment cancellation was superseded.");
    }
    if (identity.activeNode !== null || identity.pendingEnrollment === null) {
      throw new Error("Hub enrollment cannot be cancelled in the current state.");
    }
    const generation = this.#state.invalidateGeneration();
    this.#clearTimer("enrollment");
    try {
      await this.#identity.cancelEnrollment(origin);
    } catch {
      if (!this.#state.isCurrent(generation) || this.#stopping) {
        throw new Error("Hub enrollment cancellation was superseded.");
      }
      this.#state.transition("degraded", {
        degradedMode: "operator_action_required",
        failure: "enrollment_unavailable",
      });
      throw new Error("Hub enrollment could not be cancelled.");
    }
    if (!this.#state.isCurrent(generation) || this.#stopping) {
      throw new Error("Hub enrollment cancellation was superseded.");
    }
    this.#state.transition("enrolling");
    return this.status();
  }

  /**
   * Drop every connection-owned resource without marking the connector stopped.
   *
   * Shared by `stop()` and `leave()`. `stop()` additionally sets `#stopping`,
   * which is a one-way latch for the process lifetime; `leave()` must not set it,
   * or the node could never re-enroll without a relaunch.
   */
  async #teardownConnection(): Promise<void> {
    this.#state.invalidateGeneration();
    this.#e2eeState.clear();
    this.#clearAllTimers();
    const registry = this.#registry;
    this.#registry = undefined;
    await registry?.closeAll();
    this.#sendQueue?.close();
    this.#sendQueue = undefined;
    this.#session?.close();
    this.#session = undefined;
    await this.#frameChain.catch(() => undefined);
  }

  async stop(): Promise<void> {
    if (this.#stopping) return this.#frameChain;
    this.#stopping = true;
    this.#stopLivenessWatch();
    this.#state.invalidateGeneration();
    if (this.#state.snapshot().state !== "disabled") this.#state.transition("stopping");
    await this.#teardownConnection();
    await this.#handBackIdentity();
    this.#state.transition("disabled");
    this.#started = false;
  }

  /**
   * Erase this node's local Hub identity.
   *
   * The only exit from `revoked` and from a corrupt or orphaned identity:
   * `resume()` early-returns on `revoked`, and `enroll()` throws while an
   * `activeNode` exists, so without this a revoked node is stuck for good.
   *
   * Ordering is load-bearing. An authenticated relay session is never
   * revalidated against identity state, so deleting the key does not close it —
   * channels must be torn down *before* custody is mutated, or the connector
   * would keep serving relayed RPC under an identity that no longer exists.
   *
   * Deliberately not built on `stop()`: that latches `#stopping` forever, and a
   * node that just left must be able to enroll again in the same process.
   */
  async leave(): Promise<HubConnectorStatus> {
    if (this.#stopping) throw new Error("Hub identity cannot be erased while stopping.");
    // A connector that never started — switched off here, perhaps while another
    // copy runs with it on — has not claimed the identity yet. Claim it now, and
    // refuse rather than erase keys a running process is authenticating with.
    const claim = await this.#takeIdentity();
    if (claim === "held") throw new HubIdentityInUseError();
    // A connector that will not run afterwards hands the claim back, so a copy
    // that does run can take the identity — fresh or not — without waiting.
    const releaseLeaveClaim = async () => {
      if (claim === "claimed" && !this.#runsConnector()) await this.#handBackIdentity();
    };
    await this.#teardownConnection();
    this.#started = false;
    // Budgets earned by the identity being erased say nothing about the next one.
    this.#slowAttempts.clear();
    this.#slowRetryLog.clear();
    try {
      await this.#identity.leave();
    } catch (error: unknown) {
      this.#state.transition("degraded", {
        degradedMode: "operator_action_required",
        failure: identityFailure(error),
      });
      await releaseLeaveClaim();
      // The cause aids local diagnosis; it never reaches a caller, because the
      // route replaces this error with a bounded message.
      throw new Error("Hub identity could not be erased.", { cause: error });
    }
    this.#nodeId = undefined;
    // `disabled` is legal from every state and is literally true here: no
    // socket, timer, or channel survives the teardown above. `enrolling` is only
    // honest once the connector is actually configured to enroll.
    this.#state.transition("disabled");
    if (this.#runsConnector()) {
      this.#state.transition("enrolling");
      this.#started = true;
    }
    await releaseLeaveClaim();
    return this.status();
  }

  async #connect(): Promise<void> {
    if (this.#stopping || this.#connecting || this.#session !== undefined) return;
    const origin = this.#config.origin;
    if (origin === undefined) return;
    this.#connecting = true;
    const generation = this.#state.beginGeneration();
    const current = this.#state.snapshot().state;
    if (current !== "connecting") this.#state.transition("connecting");
    const session = new RelayConnectionSession({
      identity: this.#identity,
      transport: this.#transport,
      hubOrigin: origin,
      scheduler: this.#scheduler,
      now: this.#scheduler.now,
      onFrame: (frame) => {
        this.#frameChain = this.#frameChain
          .then(() => this.#handleFrame(generation, frame))
          .catch((error: unknown) =>
            this.#handleFailure(
              generation,
              error instanceof RelayChannelProtocolError ? "protocol_invalid" : "internal_error",
            ),
          );
      },
      onTerminal: (error) => {
        void this.#handleFailure(generation, error.kind, error.retryAfterMs);
      },
    });
    this.#session = session;
    this.#state.transition("authenticating");
    try {
      await this.#beforeConnect();
      if (!this.#state.isCurrent(generation) || this.#stopping) {
        session.close();
        return;
      }
      const ready = await session.authenticate();
      if (!this.#state.isCurrent(generation) || this.#stopping) {
        session.close();
        return;
      }
      const socket = session.socket;
      if (socket === undefined) throw new RelayConnectionError("internal_error");
      this.#e2eeStatementAttempt = 0;
      this.#e2eeStatementFailures = 0;
      this.#e2eeState.begin(generation, origin, {
        protocolMajor: ready.protocolMajor,
        protocolMinor: ready.protocolMinor,
      });
      const sendQueue = new RelaySendQueue(socket, ready.limits);
      const registry = new RelayChannelRegistry({
        limits: ready.limits,
        protocol: {
          protocolMajor: ready.protocolMajor,
          protocolMinor: ready.protocolMinor,
        },
        sendQueue,
        factory: this.#channels,
        onFatal: () => {
          void this.#handleFailure(generation, "internal_error");
        },
        onOutboundReady: () => {
          if (!this.#state.isCurrent(generation) || this.#stopping) return;
          this.#flushAndScheduleDrain(generation);
          this.#state.updateOnlineMetrics(registry.size, sendQueue.ownedBytes);
        },
        connection: () =>
          this.#nodeId === undefined ? undefined : { hubOrigin: origin, nodeId: this.#nodeId },
      });
      this.#sendQueue = sendQueue;
      this.#registry = registry;
      session.activateFrameDelivery();
      await this.#frameChain;
      if (!this.#state.isCurrent(generation) || this.#stopping) {
        session.close();
        return;
      }
      try {
        const authenticatedState = await this.#identity.readState();
        // Assigned unconditionally, including to undefined: a read that reports
        // no active node means this connector no longer has the identity it
        // last saw, and leaving the previous id in place would hand a later
        // channel the id of an enrollment that is gone.
        this.#nodeId = authenticatedState.activeNode?.nodeId;
        const rotation = authenticatedState.stagedRotation;
        if (rotation?.hubOrigin === origin && rotation.activatedAt !== null) {
          await this.#identity.confirmAuthenticatedKey(origin, rotation.newKeyId);
        }
      } catch (error: unknown) {
        // The Hub accepted the proof; it is local custody that failed, and
        // reporting it as a Hub rejection would point the owner at the wrong
        // thing and wait a quarter of an hour to retry a keychain read.
        throw new RelayConnectionError(identityFailure(error));
      }
      if (!this.#state.isCurrent(generation) || this.#stopping) {
        session.close();
        return;
      }
      await this.#publishE2eeState(generation);
      if (!this.#state.isCurrent(generation) || this.#stopping) {
        session.close();
        return;
      }
      this.#state.online(
        { protocolMajor: ready.protocolMajor, protocolMinor: ready.protocolMinor },
        registry.size,
        sendQueue.ownedBytes,
      );
      this.#scheduleStableReset(generation);
      this.#scheduleHeartbeatTimeout(generation, ready.limits.deadConnectionTimeoutMs);
    } catch (error: unknown) {
      if (!this.#state.isCurrent(generation) || this.#stopping) return;
      const failure =
        error instanceof RelayConnectionError ? error : new RelayConnectionError("internal_error");
      await this.#handleFailure(generation, failure.kind, failure.retryAfterMs);
    } finally {
      this.#connecting = false;
    }
  }

  #enrollmentOrigin(): string {
    if (
      !this.#started ||
      this.#stopping ||
      !this.#config.enabled ||
      this.#config.configurationIssue !== undefined ||
      this.#config.origin === undefined
    ) {
      throw new Error("Hub enrollment is unavailable.");
    }
    return this.#config.origin;
  }

  #scheduleEnrollmentPoll(milliseconds: number): void {
    this.#clearTimer("enrollment");
    const generation = this.#state.generation;
    this.#enrollmentTimer = this.#scheduler.setTimeout(() => {
      this.#enrollmentTimer = undefined;
      void this.#pollEnrollment(generation);
    }, milliseconds);
  }

  async #pollEnrollment(generation: number): Promise<void> {
    if (!this.#state.isCurrent(generation) || this.#stopping) return;
    const origin = this.#config.origin;
    if (origin === undefined) return;
    let result;
    try {
      result = await this.#identity.pollEnrollment(origin);
    } catch {
      if (!this.#state.isCurrent(generation) || this.#stopping) return;
      const decision = reconnectDelay(
        {
          baseDelayMs: this.#config.reconnectBaseMs,
          maxDelayMs: this.#config.reconnectMaxMs,
          jitterRatio: this.#config.reconnectJitterRatio,
        },
        this.#attempt,
        this.#scheduler.random(),
      );
      this.#attempt += 1;
      this.#state.transition("degraded", {
        degradedMode: "backing_off",
        failure: "network_unavailable",
        reconnectAttempt: decision.attempt,
        nextRetryAt: new Date(this.#scheduler.now() + decision.delayMs).toISOString(),
      });
      this.#scheduleEnrollmentPoll(decision.delayMs);
      return;
    }
    if (!this.#state.isCurrent(generation) || this.#stopping) return;
    if (result.status === "pending") {
      this.#attempt = 0;
      if (this.#state.snapshot().state !== "awaiting_approval") {
        this.#state.transition("awaiting_approval");
      }
      this.#scheduleEnrollmentPoll(result.retryAfterMs);
      return;
    }
    if (result.status === "unavailable") {
      // Expiry and denial need opposite operator instructions, so they must not
      // collapse into one code: an expired ceremony is simply restarted, a
      // denied one means a human said no and wants finding out why first.
      this.#state.transition("degraded", {
        degradedMode: "operator_action_required",
        failure: result.reason === "expired" ? "enrollment_expired" : "enrollment_unavailable",
      });
      return;
    }
    this.#attempt = 0;
    // The approval response is the first place this node learns its own id, and
    // it arrives before the connection that will carry the first channels.
    // Without this the first connect after approval publishes the registry
    // before any identity read has completed.
    this.#nodeId = result.nodeId;
    await this.#connect();
  }

  async #publishE2eeState(generation: number): Promise<void> {
    if (!this.#state.isCurrent(generation) || this.#stopping) return;
    const origin = this.#config.origin;
    const ready = this.#session?.ready;
    if (
      origin === undefined ||
      ready === undefined ||
      ready.protocolMinor < RELAY_ACCOUNT_GRANT_MINOR
    ) {
      return;
    }
    let result;
    try {
      result = await this.#identity.readE2eeAdvertisement(origin);
    } catch (error: unknown) {
      this.#e2eeState.clearStatement(generation);
      throw error;
    }
    if (!this.#state.isCurrent(generation) || this.#stopping) return;
    if (result.kind === "unavailable") {
      // Withdrawn at once, and retried rather than abandoned: the statement is
      // rebuilt from identity, prekey, and continuity reads that a locked
      // keychain fails for a while and then serves again, and without a retry
      // account-grant channels stay refused until the next reconnect — the
      // Hub drops a statement that is not renewed.
      this.#e2eeState.clearStatement(generation);
      this.#scheduleE2eeStatementRetry(generation, E2EE_STATEMENT_UNAVAILABLE_RETRY);
      return;
    }
    if (this.#e2eeState.publish(generation, result.advertisement) !== "accepted") {
      throw new RelayConnectionError("internal_error");
    }
    const queue = this.#sendQueue;
    if (
      queue === undefined ||
      !queue.enqueueControl({
        type: "node.e2ee.statement",
        protocolMajor: ready.protocolMajor,
        protocolMinor: ready.protocolMinor,
        connectorGeneration: generation as RelayConnectorGeneration,
        statement: Uint8Array.from(result.advertisement.statement),
        statementDigest: Uint8Array.from(result.advertisement.statementDigest) as RelayE2eeDigest,
        expiresAt: result.advertisement.expiresAt,
      })
    ) {
      throw new RelayConnectionError("internal_error");
    }
    this.#e2eeStatementAttempt = 0;
    this.#e2eeStatementFailures = 0;
    this.#flushAndScheduleDrain(generation);
    this.#scheduleE2eeStatementRefresh(generation, result.advertisement.expiresAt);
  }

  #scheduleE2eeStatementRefresh(generation: number, expiresAt: number): void {
    this.#clearTimer("e2eeStatement");
    const delay = Math.max(1, expiresAt - E2EE_MAX_CLOCK_SKEW - this.#scheduler.now());
    this.#e2eeStatementTimer = this.#scheduler.setTimeout(() => {
      this.#e2eeStatementTimer = undefined;
      this.#refreshE2eeStatementInBackground(generation);
    }, delay);
  }

  /** Try again later, in the same generation, on the given backoff; reset by a publish. */
  #scheduleE2eeStatementRetry(generation: number, policy: ReconnectPolicyConfig): void {
    this.#clearTimer("e2eeStatement");
    const decision = reconnectDelay(policy, this.#e2eeStatementAttempt, this.#scheduler.random());
    this.#e2eeStatementAttempt += 1;
    this.#e2eeStatementTimer = this.#scheduler.setTimeout(() => {
      this.#e2eeStatementTimer = undefined;
      this.#refreshE2eeStatementInBackground(generation);
    }, decision.delayMs);
  }

  /** A timer-driven republish; `refreshE2eeState` handles its failure. */
  #refreshE2eeStatementInBackground(generation: number): void {
    if (!this.#state.isCurrent(generation) || this.#stopping) return;
    void this.refreshE2eeState().catch(() => undefined);
  }

  async #handleFrame(generation: number, frame: RelayFrame): Promise<void> {
    if (!this.#state.isCurrent(generation) || this.#stopping) return;
    if (frame.type === "ping") {
      this.#scheduleHeartbeatTimeout(
        generation,
        this.#session?.ready?.limits.deadConnectionTimeoutMs ?? 45_000,
      );
      if (
        !this.#sendQueue?.enqueueControl({
          type: "pong",
          protocolMajor: frame.protocolMajor,
          protocolMinor: frame.protocolMinor,
          nonce: Uint8Array.from(frame.nonce),
        })
      ) {
        await this.#handleFailure(generation, "internal_error");
        return;
      }
    } else if (frame.type === "pong") {
      // Only the answer to this connector's own outstanding probe is valid; an
      // unsolicited pong stays the protocol violation it always was.
      const probe = this.#probe;
      if (probe === undefined || probe.generation !== generation) {
        throw new RelayChannelProtocolError();
      }
      if (!sameBytes(probe.nonce, frame.nonce)) throw new RelayChannelProtocolError();
      this.#clearProbe();
      this.#scheduleHeartbeatTimeout(
        generation,
        this.#session?.ready?.limits.deadConnectionTimeoutMs ?? 45_000,
      );
      return;
    } else if (frame.type === "error") {
      await this.#handleFailure(
        generation,
        relayErrorKind(frame as RelayErrorFrame),
        frame.retryAfterMs,
      );
      return;
    } else if (frame.type === "node.e2ee.statement.ack") {
      const result = this.#e2eeState.acknowledge(frame.connectorGeneration, frame.statementDigest);
      if (result === "invalid") throw new RelayChannelProtocolError();
      if (result === "stale") return;
    } else if (frame.type === "e2ee.verifier-keys") {
      const result = this.#e2eeState.replaceVerifierKeys(generation, frame);
      if (result === "invalid") throw new RelayChannelProtocolError();
      if (result === "stale") return;
    } else if (frame.type === "e2ee.enrollment-revoked") {
      const result = this.#e2eeState.acceptRevocation(generation, frame);
      if (result === "invalid") throw new RelayChannelProtocolError();
      if (result === "stale") return;
      await this.#onE2eeEnrollmentRevoked(frame);
    } else if (
      frame.type === "channel.open" ||
      frame.type === "data" ||
      frame.type === "flow.pause" ||
      frame.type === "flow.resume" ||
      frame.type === "channel.close"
    ) {
      const registry = this.#registry;
      if (registry === undefined) throw new RelayChannelProtocolError();
      await registry.handle(frame);
    } else {
      throw new RelayChannelProtocolError();
    }
    this.#flushAndScheduleDrain(generation);
    this.#state.updateOnlineMetrics(this.#registry?.size ?? 0, this.#sendQueue?.ownedBytes ?? 0);
  }

  async #handleFailure(
    generation: number,
    kind: ConnectorFailureKind,
    retryAfterMs?: number,
  ): Promise<void> {
    if (!this.#state.isCurrent(generation) || this.#stopping) return;
    this.#state.invalidateGeneration();
    this.#e2eeState.clear();
    this.#clearProbe();
    this.#clearTimer("stable");
    this.#clearTimer("heartbeat");
    this.#clearTimer("drain");
    this.#clearTimer("e2eeStatement");
    const registry = this.#registry;
    this.#registry = undefined;
    await registry?.closeAll();
    this.#sendQueue?.close();
    this.#sendQueue = undefined;
    this.#session?.close();
    this.#session = undefined;
    const disposition = classifyConnectorFailure(
      kind,
      this.#protocolViolations,
      this.#staleProofRetries,
    );
    if (kind === "protocol_invalid") this.#protocolViolations += 1;
    if (kind === "authentication_stale") this.#staleProofRetries += 1;
    if (disposition.action === "slow_retry") {
      this.#scheduleSlowRetry(disposition.failure, disposition.policy, disposition.nudgeable);
      return;
    }
    if (disposition.action === "operator") {
      if (disposition.terminalState !== undefined) {
        this.#state.transition(disposition.terminalState, { failure: disposition.failure });
      } else {
        this.#state.transition("degraded", {
          degradedMode: "operator_action_required",
          failure: disposition.failure,
        });
      }
      return;
    }
    const decision = reconnectDelay(
      {
        baseDelayMs: this.#config.reconnectBaseMs,
        maxDelayMs: this.#config.reconnectMaxMs,
        jitterRatio: this.#config.reconnectJitterRatio,
      },
      this.#attempt,
      this.#scheduler.random(),
      retryAfterMs,
    );
    this.#attempt += 1;
    const retryGeneration = this.#state.generation;
    this.#state.transition("degraded", {
      degradedMode: "backing_off",
      failure: disposition.failure,
      reconnectAttempt: decision.attempt,
      nextRetryAt: new Date(this.#scheduler.now() + decision.delayMs).toISOString(),
    });
    this.#retryNudge = () => void this.#connect();
    this.#retryTimer = this.#scheduler.setTimeout(() => {
      this.#retryTimer = undefined;
      if (!this.#state.isCurrent(retryGeneration) || this.#stopping) return;
      void this.#connect();
    }, decision.delayMs);
  }

  /**
   * Retry a usually-transient failure on its own long schedule.
   *
   * Reported as `backing_off` with the specific failure code, so status stays
   * honest about both facts: what went wrong, and that the connector is
   * handling it. A policy with an hourly budget that is spent stops for an
   * operator instead — the one case where retrying is itself the problem.
   *
   * The retry re-reads identity rather than reconnecting directly: the failure
   * may have been the identity read itself, and an identity that changed while
   * the connector waited must be revalidated before it is used.
   */
  #scheduleSlowRetry(
    failure: HubConnectorFailureCode,
    policy: SlowRetryPolicy,
    nudgeable: boolean,
  ): void {
    const now = this.#scheduler.now();
    if (policy.maxPerHour !== undefined) {
      const recent = (this.#slowRetryLog.get(policy) ?? []).filter(
        (scheduledAt) => now - scheduledAt < SLOW_RETRY_BUDGET_WINDOW_MS,
      );
      if (recent.length >= policy.maxPerHour) {
        this.#slowRetryLog.set(policy, recent);
        this.#state.transition("degraded", {
          degradedMode: "operator_action_required",
          failure,
        });
        return;
      }
      this.#slowRetryLog.set(policy, [...recent, now]);
    }
    const attempt = this.#slowAttempts.get(policy) ?? 0;
    this.#slowAttempts.set(policy, attempt + 1);
    const decision = slowRetryDelay(policy, attempt, this.#scheduler.random());
    const retryGeneration = this.#state.generation;
    this.#state.transition("degraded", {
      degradedMode: "backing_off",
      failure,
      reconnectAttempt: decision.attempt,
      nextRetryAt: new Date(now + decision.delayMs).toISOString(),
    });
    this.#retryNudge = nudgeable ? () => void this.#establish(retryGeneration) : undefined;
    this.#retryTimer = this.#scheduler.setTimeout(() => {
      this.#retryTimer = undefined;
      if (!this.#state.isCurrent(retryGeneration) || this.#stopping) return;
      void this.#establish(retryGeneration);
    }, decision.delayMs);
  }

  #scheduleStableReset(generation: number): void {
    this.#clearTimer("stable");
    this.#stableTimer = this.#scheduler.setTimeout(() => {
      this.#stableTimer = undefined;
      if (!this.#state.isCurrent(generation) || this.#state.snapshot().state !== "online") return;
      this.#attempt = 0;
      this.#protocolViolations = 0;
      this.#staleProofRetries = 0;
      this.#slowAttempts.clear();
    }, this.#config.reconnectStableMs);
  }

  #scheduleHeartbeatTimeout(generation: number, milliseconds: number): void {
    this.#clearTimer("heartbeat");
    this.#heartbeatTimer = this.#scheduler.setTimeout(() => {
      this.#heartbeatTimer = undefined;
      void this.#handleFailure(generation, "heartbeat_timeout");
    }, milliseconds);
  }

  #flushAndScheduleDrain(generation: number): void {
    try {
      this.#sendQueue?.flush();
    } catch {
      void this.#handleFailure(generation, "network");
      return;
    }
    if (
      this.#drainTimer !== undefined ||
      ((this.#sendQueue?.queuedBytes ?? 0) === 0 &&
        (this.#session?.socket?.bufferedAmount ?? 0) === 0 &&
        this.#registry?.needsFlowRefresh !== true)
    ) {
      return;
    }
    this.#drainTimer = this.#scheduler.setTimeout(() => {
      this.#drainTimer = undefined;
      if (!this.#state.isCurrent(generation) || this.#stopping) return;
      const registry = this.#registry;
      if (registry !== undefined) {
        void registry
          .refreshFlow()
          .then(() => this.#flushAndScheduleDrain(generation))
          .catch(() => this.#handleFailure(generation, "internal_error"));
      }
    }, 10);
  }

  #clearTimer(
    kind: "retry" | "enrollment" | "stable" | "heartbeat" | "drain" | "e2eeStatement",
  ): void {
    const current =
      kind === "retry"
        ? this.#retryTimer
        : kind === "enrollment"
          ? this.#enrollmentTimer
          : kind === "stable"
            ? this.#stableTimer
            : kind === "heartbeat"
              ? this.#heartbeatTimer
              : kind === "drain"
                ? this.#drainTimer
                : this.#e2eeStatementTimer;
    if (current !== undefined) this.#scheduler.clearTimeout(current);
    if (kind === "retry") this.#retryTimer = undefined;
    else if (kind === "enrollment") this.#enrollmentTimer = undefined;
    else if (kind === "stable") this.#stableTimer = undefined;
    else if (kind === "heartbeat") this.#heartbeatTimer = undefined;
    else if (kind === "drain") this.#drainTimer = undefined;
    else this.#e2eeStatementTimer = undefined;
  }

  #clearAllTimers(): void {
    this.#clearProbe();
    this.#clearTimer("retry");
    this.#clearTimer("enrollment");
    this.#clearTimer("stable");
    this.#clearTimer("heartbeat");
    this.#clearTimer("drain");
    this.#clearTimer("e2eeStatement");
  }
}
