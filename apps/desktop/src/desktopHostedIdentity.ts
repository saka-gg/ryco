import * as Crypto from "node:crypto";

import type {
  DesktopHostedIdentityActionResult,
  DesktopHostedIdentityState,
  DesktopWorkspaceStateProjection,
} from "@ryco/contracts";
import {
  HostedHubApi,
  HostedHubApiError,
  type HostedHubNode,
} from "@ryco/client-runtime/authorization";
import {
  createNativeE2eeEnrollmentCoordinator,
  createNativeE2eeTrustResolver,
  type NativeE2eeEnrollmentCoordinator,
  type NativeE2eeEnrollmentRecovery,
  type NativeE2eeEnrollmentState,
  type ResolveNativeE2eeTrustInput,
} from "@ryco/client-runtime/authorization/e2ee";
import type {
  DpopSignerService,
  HttpClientService,
  NativeAuthorizationService,
  NativeE2eePlatformService,
  PasskeyCeremonyService,
} from "@ryco/client-runtime/platform";
import { createDpopProofSigner } from "@ryco/client-runtime/relay";
import type { HostedRelayTicket } from "@ryco/client-runtime/authorization";

import {
  DesktopAutomaticNodeClaimError,
  runDesktopAutomaticNodeClaim,
} from "./automaticNodeClaim.ts";
import type { DesktopHubControlClient } from "./desktopHubControl.ts";
import { DesktopE2eeTrustStore } from "./desktopE2eeTrust.ts";
import type { DesktopHostedSessionCredentials } from "./hostedCredentials.ts";
import {
  runDesktopLocalTrustedIntroduction,
  type DesktopLocalIntroductionSecurity,
} from "./localTrustedIntroduction.ts";
import type { DesktopProtectedRecordStore } from "./protectedRecordStore.ts";

const unavailablePasskeys: PasskeyCeremonyService = {
  authenticate: async () => {
    throw new Error("Browser passkeys are unavailable in Desktop main.");
  },
  register: async () => {
    throw new Error("Browser passkeys are unavailable in Desktop main.");
  },
};

export async function createDesktopDpopSigner(
  security: DesktopLocalIntroductionSecurity,
): Promise<DpopSignerService> {
  const signingKey = await security.getSigningKey();
  return createDpopProofSigner(signingKey, {
    now: Date.now,
    randomJti: () => Crypto.randomUUID(),
    sha256: async (bytes) => Uint8Array.from(Crypto.createHash("sha256").update(bytes).digest()),
  });
}

export async function createDesktopHostedHubApi(input: {
  readonly origin: string;
  readonly credentials: DesktopHostedSessionCredentials;
  readonly security: DesktopLocalIntroductionSecurity;
  readonly nativeAuthorization: NativeAuthorizationService;
  readonly fetch?: typeof globalThis.fetch;
}): Promise<HostedHubApi> {
  const fetch = input.fetch ?? globalThis.fetch;
  const httpClient: HttpClientService = {
    fetch: (url, init) =>
      fetch(url, init === undefined ? undefined : (init as RequestInit)) as Promise<Response>,
  };
  const dpopSigner = await createDesktopDpopSigner(input.security);
  return new HostedHubApi({
    endpoint: {
      origin: () => input.origin,
      readPrimaryTarget: () => null,
      resolveHttpUrl: (pathname, searchParams) => {
        const url = new URL(pathname, input.origin);
        for (const [key, value] of Object.entries(searchParams ?? {})) {
          url.searchParams.set(key, value);
        }
        return url.toString();
      },
      resolveWsUrl: (url) => url,
    },
    httpClient,
    passkeyCeremony: unavailablePasskeys,
    sessionCredentials: input.credentials,
    dpopSigner,
    nativeAuthorization: input.nativeAuthorization,
  });
}

export type DesktopAccountE2eeState = NonNullable<DesktopWorkspaceStateProjection["accountE2ee"]>;

export type DesktopHostedIdentityStatus =
  | { readonly status: "signed-out" }
  | {
      readonly status: "ready";
      readonly accountId: string;
      readonly nodeId: string | null;
      readonly localNodeHandle: string | null;
      readonly accountE2eeReady?: true;
      readonly github?: NonNullable<DesktopHostedIdentityState["github"]>;
    }
  | { readonly status: "unavailable" };

export type DesktopHostedIdentitySetup = (input: {
  readonly accountId: string;
  /** The user asked for this run with Connect; a background resume did not. */
  readonly interactive: boolean;
}) => Promise<{
  readonly nodeId: string;
  readonly localNodeHandle: string;
}>;

export interface DesktopHostedGitHubActionResult {
  readonly outcome: DesktopHostedIdentityActionResult["outcome"];
  readonly github?: NonNullable<DesktopHostedIdentityState["github"]>;
  readonly signedOut: boolean;
}

export function shouldEnableDesktopHubConnectorForAccountSetup(input: {
  readonly hubOrigin: string | null;
  readonly connectorEnabled: boolean;
  readonly hasSessionMaterial: boolean;
}): boolean {
  return input.hubOrigin !== null && !input.connectorEnabled && input.hasSessionMaterial;
}

/** What one credential hydrate and session restore found; see `#restoreSession`. */
type DesktopSessionRestore =
  | { readonly kind: "unavailable" }
  | { readonly kind: "no-session" }
  | { readonly kind: "session-invalid" }
  | {
      readonly kind: "session";
      readonly session: Awaited<ReturnType<HostedHubApi["restoreSession"]>>;
    };

type DesktopGitHubState = NonNullable<DesktopHostedIdentityState["github"]>;

/**
 * The account-only work of a resume, started as soon as a prepared restore
 * found a session; see {@link DesktopHostedIdentityCoordinator.prepareResume}.
 */
interface DesktopPreparedAccountWork {
  readonly accountId: string;
  readonly flushed: Promise<void>;
  readonly github: Promise<DesktopGitHubState | undefined>;
  readonly enrollment: Promise<unknown> | undefined;
  /** Every part has settled; never rejects. */
  readonly settled: Promise<void>;
}

export class DesktopHostedIdentityCoordinator {
  readonly #origin: string;
  readonly #installationId: string;
  readonly #api: HostedHubApi;
  readonly #credentials: DesktopHostedSessionCredentials;
  readonly #control: DesktopHubControlClient;
  readonly #security: DesktopLocalIntroductionSecurity;
  readonly #records: DesktopProtectedRecordStore;
  readonly #trust: DesktopE2eeTrustStore;
  readonly #setup: DesktopHostedIdentitySetup;
  readonly #allowsBackgroundNodeClaim: () => boolean;
  readonly #beforeInteractiveNodeClaim: () => void | Promise<void>;
  readonly #relayDpopSigner: DpopSignerService | undefined;
  readonly #nativeE2eeEnrollment: NativeE2eeEnrollmentCoordinator | undefined;
  readonly #resolveNativeE2eeTrust: ReturnType<typeof createNativeE2eeTrustResolver> | undefined;
  #operation: Promise<DesktopHostedIdentityStatus> | undefined;
  #operationInteractive = false;
  /** A session restore started ahead of the backend; see {@link prepareResume}. */
  #preparedRestore: Promise<DesktopSessionRestore> | undefined;
  /** The account-only work that restore started; see {@link prepareResume}. */
  #preparedAccount: DesktopPreparedAccountWork | undefined;

  constructor(input: {
    readonly origin: string;
    readonly installationId: string;
    readonly api: HostedHubApi;
    readonly credentials: DesktopHostedSessionCredentials;
    readonly control: DesktopHubControlClient;
    readonly security: DesktopLocalIntroductionSecurity;
    readonly records: DesktopProtectedRecordStore;
    readonly trust?: DesktopE2eeTrustStore;
    readonly setup?: DesktopHostedIdentitySetup;
    /**
     * Whether a background resume may claim the colocated node. A claim puts
     * this machine on the Hub and wakes its connector, so without this only
     * the user's own Connect claims it. Desktop allows it only for a connector
     * the operator turned on, never for one launched in standby.
     */
    readonly allowsBackgroundNodeClaim?: () => boolean;
    /**
     * Runs once an interactive sign-in holds a durable session, before the
     * node claim. Desktop records the explicit connector enable here, so a
     * claimed node never comes back on a launch that leaves its connector off.
     * A failure skips the claim.
     */
    readonly beforeInteractiveNodeClaim?: () => void | Promise<void>;
    readonly relayDpopSigner?: DpopSignerService;
    readonly nativeE2eePlatform?: NativeE2eePlatformService;
    /**
     * The lifecycle the shared coordinator retries a failed enrollment on.
     * Without it, one transient Hub or keychain failure at sign-in leaves every
     * remote machine unverified until the next launch.
     */
    readonly nativeE2eeRecovery?: NativeE2eeEnrollmentRecovery;
  }) {
    this.#origin = input.origin;
    this.#allowsBackgroundNodeClaim = input.allowsBackgroundNodeClaim ?? (() => false);
    this.#beforeInteractiveNodeClaim = input.beforeInteractiveNodeClaim ?? (() => undefined);
    this.#installationId = input.installationId;
    this.#api = input.api;
    this.#credentials = input.credentials;
    this.#control = input.control;
    this.#security = input.security;
    this.#records = input.records;
    this.#trust = input.trust ?? new DesktopE2eeTrustStore(input.records);
    this.#relayDpopSigner = input.relayDpopSigner;
    this.#nativeE2eeEnrollment = input.nativeE2eePlatform
      ? createNativeE2eeEnrollmentCoordinator({
          platform: input.nativeE2eePlatform,
          api: input.api,
          hubOrigin: input.origin,
          // The Hub intersects this ceiling with the account's current node
          // role, as on mobile: owners need settings RPCs on their other
          // machines, and operator/viewer accounts keep their granted limits.
          requestedMaximumRole: "owner",
          requestedCapabilities: ["ryco.rpc"],
          refreshDirectory: async () => {
            await input.api.listNodes();
          },
          ...(input.nativeE2eeRecovery === undefined ? {} : { recovery: input.nativeE2eeRecovery }),
        })
      : undefined;
    this.#resolveNativeE2eeTrust = input.nativeE2eePlatform
      ? createNativeE2eeTrustResolver({
          api: input.api,
          platform: input.nativeE2eePlatform,
        })
      : undefined;
    this.#setup =
      input.setup ??
      (async ({ accountId, interactive }) => {
        // Claiming puts this machine on the Hub. A background resume does that
        // only for a connector the operator turned on; otherwise it waits for
        // the user's own Connect, and a prior local introduction stands in.
        if (!interactive && !this.#allowsBackgroundNodeClaim()) {
          return this.#retainedLocalNode(
            accountId,
            new DesktopAutomaticNodeClaimError("claim_unavailable"),
          );
        }
        try {
          if (interactive) await this.#beforeInteractiveNodeClaim();
          const claimed = await runDesktopAutomaticNodeClaim({
            api: this.#api,
            control: this.#control,
            installationId: this.#installationId,
            expectedHubOrigin: this.#origin,
            expectedAccountId: accountId,
          });
          const pin = await runDesktopLocalTrustedIntroduction({
            control: this.#control,
            security: this.#security,
            records: this.#records,
            trust: this.#trust,
            installationId: this.#installationId,
            expectedHubOrigin: this.#origin,
            claim: claimed.claim,
            result: claimed.result,
          });
          return {
            nodeId: claimed.result.node.id,
            localNodeHandle: pin.localNodeHandle,
          };
        } catch (cause) {
          return this.#retainedLocalNode(accountId, cause);
        }
      });
  }

  /**
   * Client identity is independent of node-connector uptime. A prior local
   * introduction remains the exact local tie-break when the node plane is
   * intentionally disabled, not claimed yet, or temporarily unavailable.
   */
  async #retainedLocalNode(
    accountId: string,
    cause: unknown,
  ): Promise<{ readonly nodeId: string; readonly localNodeHandle: string }> {
    const localPins = (await this.#trust.list(this.#origin, accountId)).filter(
      (pin) => pin.verificationMethod === "local-trusted-introduction-v1",
    );
    if (localPins.length !== 1) throw cause;
    return {
      nodeId: localPins[0]!.nodeId,
      localNodeHandle: localPins[0]!.localNodeHandle,
    };
  }

  resume(): Promise<DesktopHostedIdentityStatus> {
    return this.#serialize(false);
  }

  /**
   * Start a background resume's credential hydrate and Hub session restore
   * now, while the backend is still starting, so the resume that follows its
   * readiness adopts the answer instead of paying that round trip after it.
   * Once the restore finds a session, the rest of the work that needs only
   * that account session starts too: the credential flush, the account E2EE
   * enrollment and the GitHub link read. Only the node claim and local
   * introduction (`#setup`) need the backend, and they still run in the resume
   * itself. Nothing is published to the workspace here; a transient failure is
   * simply restored again by the resume.
   */
  prepareResume(): void {
    if (this.#operation !== undefined || this.#preparedRestore !== undefined) return;
    const prepared: Promise<DesktopSessionRestore> = this.#restoreSession().then((outcome) => {
      if (outcome.kind === "session" && this.#preparedRestore === prepared) {
        this.#preparedAccount = this.#startAccountWork(outcome.session.account.id);
      }
      return outcome;
    });
    this.#preparedRestore = prepared;
  }

  /** The resume steps that need only the account session, all started at once. */
  #startAccountWork(accountId: string): DesktopPreparedAccountWork {
    const flushed = this.#credentials.flush();
    const github = this.#readGitHubState();
    const enrollment = this.#nativeE2eeEnrollment?.ensure(accountId);
    return {
      accountId,
      flushed,
      github,
      enrollment,
      settled: Promise.allSettled([flushed, github, enrollment]).then(() => undefined),
    };
  }

  /**
   * The prepared account work for `accountId`, once. A second enrollment
   * `ensure()` after the first settled would repeat its Hub upsert, so the
   * resume must adopt this one rather than start its own.
   */
  #takePreparedAccount(accountId: string): DesktopPreparedAccountWork | undefined {
    const prepared = this.#preparedAccount;
    this.#preparedAccount = undefined;
    return prepared?.accountId === accountId ? prepared : undefined;
  }

  /** Every in-flight account operation, including a prepared restore, has settled. */
  async #idle(): Promise<void> {
    await Promise.all([
      this.#operation?.catch(() => undefined),
      this.#preparedRestore?.catch(() => undefined),
    ]);
    // Started by the prepared restore as it settled.
    await this.#preparedAccount?.settled;
  }

  /**
   * Hydrate the stored credentials and restore the Hub session with them.
   * Never rejects: every outcome is a value the resume decides on.
   */
  async #restoreSession(): Promise<DesktopSessionRestore> {
    try {
      await this.#credentials.hydrate();
    } catch {
      return { kind: "unavailable" };
    }
    if (!this.#api.hasSessionMaterial) return { kind: "no-session" };
    try {
      return { kind: "session", session: await this.#api.restoreSession() };
    } catch (cause) {
      return cause instanceof HostedHubApiError && cause.code === "session_invalid"
        ? { kind: "session-invalid" }
        : { kind: "unavailable" };
    }
  }

  /**
   * The prepared restore, if one was started, once it has settled — and only
   * when its answer is definite. A transient failure (offline at launch, a
   * busy Hub) is not carried into a resume that may run seconds later.
   */
  async #takePreparedRestore(): Promise<DesktopSessionRestore | undefined> {
    const prepared = this.#preparedRestore;
    if (prepared === undefined) return undefined;
    const outcome = await prepared;
    if (this.#preparedRestore === prepared) this.#preparedRestore = undefined;
    if (outcome.kind !== "session") this.#preparedAccount = undefined;
    return outcome.kind === "unavailable" ? undefined : outcome;
  }

  connect(): Promise<DesktopHostedIdentityStatus> {
    return this.#serialize(true);
  }

  /** Whether browser sign-in produced restorable, origin-scoped session material. */
  get hasSessionMaterial(): boolean {
    return this.#api.hasSessionMaterial;
  }

  async disconnect(): Promise<void> {
    await this.#idle();
    // A prepared restore answered for the credentials this clears; the next
    // resume must not adopt it (or its account work) as the signed-out
    // installation's session.
    this.#preparedRestore = undefined;
    this.#preparedAccount = undefined;
    this.#api.clearSessionMaterial();
    await this.#credentials.clear();
    await this.#nativeE2eeEnrollment?.invalidate("signed-out");
  }

  get nativeE2eeEnrollmentState(): NativeE2eeEnrollmentState | null {
    return this.#nativeE2eeEnrollment?.getState() ?? null;
  }

  /**
   * This installation's account enrollment for `accountId`, read live: recovery
   * can finish an enrollment long after the sign-in that started it, and the
   * handshake gates on this same state. Only `ready` makes remote unpinned
   * machines account-trusted.
   */
  accountE2eeState(accountId: string): DesktopAccountE2eeState {
    const state = this.#nativeE2eeEnrollment?.getState();
    if (state === undefined) return "unavailable";
    switch (state.status) {
      case "ready":
        return state.ready !== null &&
          state.ready.namespace.hubOrigin === this.#origin &&
          state.ready.namespace.accountId === accountId
          ? "ready"
          : "securing";
      case "idle":
      case "securing":
      case "retrying":
        return "securing";
      case "unavailable":
        return "unavailable";
      case "revoked":
        return "revoked";
    }
  }

  subscribeNativeE2eeEnrollment(listener: () => void): () => void {
    return this.#nativeE2eeEnrollment?.subscribe(listener) ?? (() => undefined);
  }

  async resolveNativeE2eeTrust(input: ResolveNativeE2eeTrustInput) {
    if (!this.#resolveNativeE2eeTrust) {
      throw new Error("Desktop native account E2EE is unavailable.");
    }
    return this.#resolveNativeE2eeTrust(input);
  }

  async invalidateNativeE2ee(reason: "account-switch" | "revoked" | "signed-out"): Promise<void> {
    await this.#nativeE2eeEnrollment?.invalidate(reason);
  }

  /** Directory projection for the native Desktop client; credentials stay in main. */
  async renameNode(nodeId: string, label: string): Promise<void> {
    await this.#idle();
    if (!this.#api.hasSessionMaterial) throw new Error("Sign in to rename a device.");
    await this.#api.renameNode(nodeId, label);
  }

  async listNodes(): Promise<ReadonlyArray<HostedHubNode>> {
    await this.#idle();
    if (!this.#api.hasSessionMaterial) return [];
    return this.#api.listNodes();
  }

  /** Main-process-only relay attempt material. Never return this through preload. */
  async issueRelayTicket(nodeId: string): Promise<HostedRelayTicket> {
    await this.#idle();
    if (!this.#api.hasSessionMaterial) throw new Error("Desktop Hub session is unavailable.");
    return this.#api.issueRelayTicket(nodeId);
  }

  /** Main-process-only DPoP upgrade headers for the origin-pinned relay URL. */
  async authorizeRelayUpgrade(url: string): Promise<Readonly<Record<string, string>>> {
    await this.#credentials.hydrate();
    const relayUrl = new URL("/v1/relay/client", this.#origin);
    relayUrl.protocol = relayUrl.protocol === "https:" ? "wss:" : "ws:";
    if (url !== relayUrl.toString()) throw new Error("Desktop relay URL is invalid.");
    const token = this.#credentials.readBearerToken?.() ?? null;
    if (!token || !this.#relayDpopSigner) throw new Error("Desktop Hub session is unavailable.");
    const proof = await this.#relayDpopSigner.sign({
      method: "GET",
      url,
      token,
    });
    return { Authorization: `DPoP ${token}`, DPoP: proof };
  }

  async connectGitHub(input?: {
    readonly totpCode?: string;
  }): Promise<DesktopHostedGitHubActionResult> {
    await this.#idle();
    if (!this.#api.hasSessionMaterial) {
      return { outcome: "unavailable", signedOut: true };
    }
    try {
      const identity = await this.#api.connectExternalIdentity("github", input);
      return {
        outcome: "committed",
        github: (await this.#readGitHubState()) ?? {
          linkAvailable: true,
          identity,
        },
        signedOut: false,
      };
    } catch (cause) {
      const github = await this.#readGitHubState();
      return {
        outcome: desktopGitHubActionOutcome(cause),
        ...(github === undefined ? {} : { github }),
        signedOut: false,
      };
    }
  }

  async disconnectGitHub(input?: {
    readonly totpCode?: string;
  }): Promise<DesktopHostedGitHubActionResult> {
    await this.#idle();
    if (!this.#api.hasSessionMaterial) {
      return { outcome: "unavailable", signedOut: true };
    }
    try {
      const result = await this.#api.disconnectExternalIdentity("github", input);
      if (result.signedOut) {
        await this.#credentials.clear();
        return { outcome: "committed", signedOut: true };
      }
      return {
        outcome: "committed",
        github: (await this.#readGitHubState()) ?? {
          linkAvailable: true,
          identity: null,
        },
        signedOut: false,
      };
    } catch (cause) {
      const github = await this.#readGitHubState();
      return {
        outcome: desktopGitHubActionOutcome(cause),
        ...(github === undefined ? {} : { github }),
        signedOut: false,
      };
    }
  }

  cancelGitHubConnection(): void {
    this.#api.cancelExternalIdentityConnection("github");
  }

  #serialize(interactive: boolean): Promise<DesktopHostedIdentityStatus> {
    const current = this.#operation;
    if (current !== undefined) {
      if (!interactive || this.#operationInteractive) return current;
      // A background resume may have left the node unclaimed on purpose; the
      // user's Connect is what claims it, so only a finished setup satisfies it.
      return current.then((status) =>
        status.status === "ready" && status.nodeId !== null ? status : this.#serialize(true),
      );
    }

    let operation: Promise<DesktopHostedIdentityStatus>;
    operation = this.#run(interactive).finally(() => {
      if (this.#operation === operation) {
        this.#operation = undefined;
        this.#operationInteractive = false;
      }
    });
    this.#operation = operation;
    this.#operationInteractive = interactive;
    return operation;
  }

  async #run(interactive: boolean): Promise<DesktopHostedIdentityStatus> {
    // A prepared restore always settles first, so two restores never run (and
    // rotate a native token) concurrently.
    const restored = (await this.#takePreparedRestore()) ?? (await this.#restoreSession());
    let session;
    if (restored.kind === "unavailable") return { status: "unavailable" };
    if (restored.kind === "session") {
      session = restored.session;
    } else {
      if (restored.kind === "session-invalid") {
        await this.#credentials.clear().catch(() => undefined);
      }
      if (!interactive) return { status: "signed-out" };
      try {
        session = await this.#api.signIn();
        await this.#credentials.flush();
      } catch {
        return { status: "unavailable" };
      }
    }

    // Started ahead of the backend by prepareResume when its restore found
    // this account's session.
    const prepared = this.#takePreparedAccount(session.account.id);
    try {
      // Restores may renew the native session too. A ready state must survive
      // the connector restart that completes desktop onboarding.
      await (prepared?.flushed ?? this.#credentials.flush());
      // Account sign-in and the colocated trusted introduction remain useful
      // during a staged Hub rollout. Wait for both operations so a rejected
      // enrollment cannot leave the node claim mutating in the background,
      // but only advertise account-grant trust when enrollment itself
      // succeeded. Remote unpinned nodes therefore remain unverified and
      // mutation-blocked; this is a compatibility fallback, not an E2EE
      // downgrade.
      // The GitHub link state needs only the account session, so it is read
      // beside the setup and enrollment rather than after both.
      const readingGitHub = prepared?.github ?? this.#readGitHubState();
      const [setupResult, enrollmentResult] = await Promise.allSettled([
        this.#setup({ accountId: session.account.id, interactive }),
        prepared === undefined
          ? this.#nativeE2eeEnrollment?.ensure(session.account.id)
          : prepared.enrollment,
      ]);
      // A local node can be offline or awaiting connector restart while this
      // device already has a valid account session. Remote trust still requires
      // successful native enrollment or an independently verified node pin.
      const setup = setupResult.status === "fulfilled" ? setupResult.value : null;
      const accountE2eeReady =
        this.#nativeE2eeEnrollment !== undefined && enrollmentResult.status === "fulfilled";
      const github = await readingGitHub;
      return {
        status: "ready",
        accountId: session.account.id,
        nodeId: setup?.nodeId ?? null,
        localNodeHandle: setup?.localNodeHandle ?? null,
        ...(accountE2eeReady ? { accountE2eeReady: true as const } : {}),
        ...(github === undefined ? {} : { github }),
      };
    } catch {
      return { status: "unavailable" };
    }
  }

  async #readGitHubState(): Promise<DesktopGitHubState | undefined> {
    try {
      const [configuration, security] = await Promise.all([
        this.#api.getExternalIdentityConfiguration(),
        this.#api.getAccountSecurity(),
      ]);
      const policy =
        configuration.providers.find((provider) => provider.provider === "github") ?? null;
      const identity =
        security.externalIdentities.find((entry) => entry.provider === "github") ?? null;
      if (policy === null && identity === null) return undefined;
      return { linkAvailable: policy?.link === true, identity };
    } catch {
      return undefined;
    }
  }
}

function desktopGitHubActionOutcome(cause: unknown): DesktopHostedIdentityActionResult["outcome"] {
  if (cause instanceof HostedHubApiError) {
    if (cause.code === "step_up_required") return "step-up-required";
    if (cause.code === "last_primary_credential") return "last-primary-credential";
    if (cause.code === "external_authorization_cancelled") return "cancelled";
  }
  if (cause instanceof Error && cause.name === "AbortError") return "cancelled";
  return "unavailable";
}
