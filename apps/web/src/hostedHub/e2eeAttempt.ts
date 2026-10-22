import { hostedHubStore } from "@ryco/client-runtime/authorization";
import type { EnvironmentId } from "@ryco/contracts";
import {
  HostedRelayPreparationError,
  relayE2eeUnresolvedAttemptFailure,
  type RelayE2eeChannel,
  type RelayE2eeHost,
  type RelayE2eeProvider,
} from "@ryco/client-runtime/relay";
// Type-only: the initiator's code is loaded through `./e2eeRuntime`, never here.
import type { RelayE2eeInitiatorAttempt } from "@ryco/client-runtime/relay/e2ee";
import { E2EE_SUITE_25519_CHACHAPOLY_SHA256 } from "@ryco/shared/relayE2eeWire";

import {
  acceptedWebE2eePolicyGeneration,
  clearWebE2eeLatches,
  isWebE2eeSelectionLatched,
  latchWebE2eeSelection,
  recordWebE2eePolicyGeneration,
  type WebE2eeSelection,
} from "./e2eeLatch";
import {
  beginWebE2eeChannelAttempt,
  clearWebE2eeLocalDiagnostics,
  lockWebE2eeChannelMode,
  publishWebE2eeVerificationCode,
  recordWebE2eePolicyGenerationRegression,
  resetWebE2eeSession,
} from "./e2eeSession";

// Where the WEB tier's §4.4 attempt is resolved — docs/relay-e2ee-protocol.md
// §4.4 (every selection guard evaluable before the channel receives any
// payload), §12.1/§12.1.1 (the in-memory latch and the degenerate web mapping),
// §8.1/§8.5 (NX, and the credentials the hello carries), §14.5 (the CSPRNG check
// that gates E2EE at all).
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THIS TIER'S RESOLUTION IS SYNCHRONOUS AND THE NATIVE ONE IS NOT
// ─────────────────────────────────────────────────────────────────────────────
// `createRelaySocket` is synchronous — the shared transport calls it the instant
// a ticket resolves — and §4.4 requires the latch guard to be answerable "before
// it has received any payload". `apps/mobile` cannot meet that inline: its
// guards live in a keychain and a secure store, so it resolves an attempt AHEAD
// of the socket and reads it from a slot. This tier has nothing to read. §12.1's
// latch is a bit in this process's memory, §12.1.1's web mapping is latched-or-
// legacy-eligible and nothing else, §8.5's NX credentials are the single literal
// `{ tier: "web" }`, and §13.1 gives web no pin. Every guard is therefore
// resolvable in the call itself, and there is no warm-up path, no slot, and no
// race between a decision and the channel it governs.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT IS DELIBERATELY ABSENT, AND WHY EACH ABSENCE IS THE CORRECT ANSWER
// ─────────────────────────────────────────────────────────────────────────────
//   * `verifiedPin` — §13.1: web holds no durable pin of any kind. Passing one
//     would be inventing a trust anchor for §8.3 elements 9 and 17.
//   * `onUnexpectedNode` — §12.1.1: "Web never produces an _unexpected_
//     selection, and consequently never raises §13.2.1." Rows K23/K24 are
//     unreachable here, so a handler for them would be a surface with no
//     reachable cause.
//   * `accountId` — §8.3 and §12.1.1: the account scope is a NATIVE resolution
//     input; "the web tier has none". It is still read here, because §12.1 keys
//     the latch on it — but the latch key is client-local state and element 10 of
//     the statement context is not, and conflating them would put a Hub-issued
//     value into the handshake context on a tier §8.3 defines without one.
// ─────────────────────────────────────────────────────────────────────────────
// `legacyPermitted` IS TRUE, AND IT IS NOT A CONVENIENCE
// ─────────────────────────────────────────────────────────────────────────────
// §12.1.1: "Strict mode is an opt-in, never automatic, and it is recorded per
// Hub origin… It MUST be recorded and evaluated under `hubOrigin` alone." Web has
// no durable store to record one in (§6.3, §13.1), so no opt-in can exist, so
// the policy this tier evaluates is the default — legacy permitted. `false` would
// not be a stricter reading of the same rule; it would be a strict mode nobody
// opted into, and the §11.2 P18/P19 guards would then make every genuinely
// un-upgraded node unreachable during exactly the compatibility window §12.3's
// default-`false` `requireE2EE` exists to protect.

/** §8.2: this client's fixed local suite-preference order. One suite is defined. */
const LOCAL_SUITE_PREFERENCE: readonly number[] = [E2EE_SUITE_25519_CHACHAPOLY_SHA256];

/**
 * §14.5, verified ONCE at module load — which on this tier is startup, because
 * the hosted runtime wiring is what imports this module.
 *
 * "A conforming implementation verifies the source at startup and refuses E2EE,
 * rather than discovering the absence mid-handshake." So the check gates the
 * PROVIDER, not a handshake step: with no CSPRNG or outside a secure context the
 * channel gets no §4.4 machine at all and runs the unchanged legacy path, which
 * every surface then labels legacy (§12.2). It is deliberately not a half-E2EE
 * mode, because a mode that negotiates without a trustworthy random source is
 * the one outcome §14.5 forbids naming as protected.
 */
function detectWebE2eeRandomness(): boolean {
  const scope = globalThis as {
    isSecureContext?: boolean;
    crypto?: { getRandomValues?: unknown };
  };
  if (scope.isSecureContext !== true) return false;
  return typeof scope.crypto?.getRandomValues === "function";
}

let randomnessUsable = detectWebE2eeRandomness();

type WebRelayE2ee = typeof import("./e2eeRuntime");

/**
 * The handshake code (`./e2eeRuntime`), once loaded.
 *
 * It is loaded rather than imported: the curves, hashes, cipher and CBOR
 * transcripts are the heaviest part of the hosted client, and nothing needs
 * them until a channel is accepted — at least the session, directory and ticket
 * round trips after an account authenticates, which is when the load starts.
 * The provider below is still resolved synchronously from local state; only
 * where the initiator's code comes from changed.
 */
let loadedE2ee: WebRelayE2ee | null = null;
let loadingE2ee: Promise<WebRelayE2ee> | null = null;

/** Start (or join) the handshake code load. A failed load is retried by the next caller. */
export function loadWebRelayE2ee(): Promise<WebRelayE2ee> {
  if (loadedE2ee) return Promise.resolve(loadedE2ee);
  if (loadingE2ee) return loadingE2ee;
  const pending = import("./e2eeRuntime").then((module) => {
    loadedE2ee = module;
    return module;
  });
  loadingE2ee = pending;
  pending.then(
    () => {
      if (loadingE2ee === pending) loadingE2ee = null;
    },
    () => {
      if (loadingE2ee === pending) loadingE2ee = null;
    },
  );
  return pending;
}

/**
 * The hosted runtime's `prepareRelaySocketContext`: resolves once a channel
 * this tier opens has the handshake code it may need, so
 * {@link resolveWebRelayE2eeProvider} — which the transport calls after this,
 * when the ticket it buys resolves — always finds it loaded. Nothing is
 * prepared where §14.5 refused E2EE. A failed load fails the attempt as a
 * retryable network failure, before any ticket is spent; it never yields a
 * channel without the machine.
 */
export function prepareWebRelayE2ee(): Promise<undefined> {
  if (!randomnessUsable) return Promise.resolve(undefined);
  return loadWebRelayE2ee().then(
    () => undefined,
    () => {
      throw new HostedRelayPreparationError({ kind: "network", retryable: true });
    },
  );
}

/**
 * The attempt this module last built, for the suite that asserts what it carries.
 *
 * Every field is a §4.4 guard or a §12.1.1 classification, and none of them is
 * observable through the provider the engine receives. It is the WHOLE attempt
 * rather than the bounded projection `apps/mobile` exposes, and that is the
 * point: this tier's credentials are `{ tier: "web" }` — there is no key, no
 * scalar, no transcript and no signature in it to withhold, and a test that can
 * read the entire value is what proves so.
 */
let lastAttempt: RelayE2eeInitiatorAttempt | null = null;

/**
 * The node a relay channel is opened to, and the environment whose §13
 * projection that channel publishes into.
 *
 * A channel's attempt is resolved for ITS OWN node and never for the selected
 * one: the hosted client keeps channels to several nodes, and a warm channel
 * reconnects whether or not its node is selected — or whether any node is. A
 * selection-bound attempt checked §5.2's statement and §12.1's latch against
 * whichever node happened to be selected, and closed every channel while none
 * was.
 */
export interface WebRelayE2eeTarget {
  readonly nodeId: string;
  readonly environmentId: EnvironmentId;
}

/**
 * The hosted selection a channel to `nodeId` is opened against, or `null`.
 *
 * `hubOrigin` is read from the document's own origin rather than from anything
 * the Hub sends: §12.1.1 calls it "the origin the client configured and is
 * actually connected to", and on this tier the page IS that origin. §5.2 step 4
 * checks every statement against it. The account is the signed-in one, and the
 * node is the channel's, so §12.1's latch key is always the channel's own triple.
 */
function selectionForNode(nodeId: string | undefined): WebE2eeSelection | null {
  const origin = globalThis.window?.location.origin;
  if (typeof origin !== "string" || origin.length === 0) return null;
  const state = hostedHubStore.getState();
  if (state.accountStatus !== "authenticated" || state.account === null || !nodeId) {
    return null;
  }
  return { hubOrigin: origin, accountId: state.account.id, nodeId };
}

/** The selected node as a channel target, for callers that name no node of their own. */
function selectedNodeTarget(): WebRelayE2eeTarget | null {
  const node = hostedHubStore.getState().selectedNode;
  return node === null ? null : { nodeId: node.id, environmentId: node.environmentId };
}

/**
 * The §4.4 attempt for one selection, resolved entirely from local state.
 *
 * Exported so the browser suite drives the REAL attempt — the real latch rule,
 * the real classification, the real absences — against a §16.3 fixture's Hub
 * origin, which is not the origin the test page is served from. §16.4 requires
 * the web-facing families to run in Chromium, and a suite that rebuilt this
 * shape by hand would be asserting its own copy.
 */
export function webRelayE2eeAttempt(selection: WebE2eeSelection): RelayE2eeInitiatorAttempt {
  const acceptedPolicyGeneration = acceptedWebE2eePolicyGeneration(selection);
  return {
    hubOrigin: selection.hubOrigin,
    // §12.1.1's web mapping, and the ONLY place a web selection is classified:
    // latched when §12.1's in-memory bit is set for this triple, legacy-eligible
    // otherwise. `unexpected` is unreachable and is not spelled anywhere here.
    selectionClass: isWebE2eeSelectionLatched(selection) ? "latched" : "legacy-eligible",
    legacyPermitted: true,
    // §13.2's ceremony is native-only: it pins a node identity, and web has
    // nowhere to keep one. A web attempt is never a pairing attempt.
    pairingOnly: false,
    localSuitePreference: LOCAL_SUITE_PREFERENCE,
    // §8.5: the NX tier carries no client identity, no prekey, and no signature.
    // The literal IS the credential set.
    credentials: { tier: "web" },
    // §5.7: an application-session high-water, advanced on validation below.
    // Absence is omitted rather than encoded as zero: zero would claim an
    // accepted generation when this session has validated none.
    ...(acceptedPolicyGeneration === undefined ? {} : { acceptedPolicyGeneration }),
    // §12.1's set condition, and the single most consequential line in this file.
    //
    // IT IS THE VALIDATION VERDICT AND NOT THE HANDSHAKE LOCK. §5.2 steps 0–7 are
    // what "validates" means, and every verdict that reached them carries the
    // decoded statement — including `unusable`, which §12.1 names explicitly:
    // "A statement that is valid but **unusable** under §5.2 step 8, §5.2 step 9,
    // or §8.2 has validated and therefore sets the latch, so such a channel takes
    // K2 (`P15`) rather than K3 and no buffered plaintext is flushed at
    // `T_ADV`." Latching from the lock instead would leave exactly that channel
    // unlatched, and a Hub that validates the statement and then stalls the
    // handshake would get the retry channel to flush plaintext at `T_ADV`.
    onStatement: (verification) => {
      if (
        verification.kind === "invalid" &&
        verification.reason === "policy_generation_regressed"
      ) {
        recordWebE2eePolicyGenerationRegression();
        return;
      }
      if (!("statement" in verification)) return;
      // The verifier input is a channel-accept snapshot. Another channel may
      // advance this selection while this one waits for its carrier, so the
      // awaited trust boundary re-checks live state before releasing hello.
      const accepted = acceptedWebE2eePolicyGeneration(selection);
      if (accepted !== undefined && verification.statement.policyGeneration < accepted) {
        recordWebE2eePolicyGenerationRegression();
        throw new Error("Web E2EE policy generation regressed.");
      }
      latchWebE2eeSelection(selection);
      recordWebE2eePolicyGeneration(selection, verification.statement.policyGeneration);
    },
    // §13.5, published only at the `e2ee` lock and only on this tier. The
    // machine derives it; this hands it to the projection and nothing else.
    // {@link resolveWebRelayE2eeProvider} binds each channel's copy to that
    // channel's own entry, so a code lands only where its session is current.
    onWebVerificationCode: (code) => publishWebE2eeVerificationCode(code),
  };
}

/**
 * A channel that closes without releasing anything (§11.2: "a client executing
 * FATAL-PRE sends nothing and closes").
 *
 * Reached when the channel's selection cannot be read at all — a sign-out that
 * lands between the ticket mint and this synchronous construction, or a node
 * that is no longer in the directory, so the channel has no environment to
 * project into. It is deliberately NOT a legacy channel: what is missing IS the
 * latch key, and §12.1.1 forbids treating unobtainable evidence as an unset
 * latch. Also reached, for the same reason, if the handshake code is not loaded
 * yet, which the hosted transport rules out by awaiting
 * {@link prepareWebRelayE2ee} before it buys a ticket: a channel this tier
 * cannot negotiate is not a plaintext one.
 *
 * The close is the RETRYABLE one, so a store that moved under a reconnect costs
 * one channel rather than the whole hosted session.
 */
function unresolvedAttemptChannel(host: RelayE2eeHost): RelayE2eeChannel {
  host.close(relayE2eeUnresolvedAttemptFailure());
  return {
    intercept: async () => ({ kind: "rejected" }),
    submit: () => false,
    beginClose: async () => "refused",
    dispose: () => undefined,
  };
}

/**
 * The `RelayE2eeProvider` the hosted socket is built with, resolved
 * synchronously at `createRelaySocket`.
 *
 * `target` is the channel's own node and environment. `null` says the channel's
 * node could not be resolved, and that channel closes; omitted, the selected
 * node is the target.
 *
 * `undefined` is the §14.5 answer and nothing else: no CSPRNG, or no secure
 * context, so this client has no E2EE at all and the engine runs the unchanged
 * legacy channel. Every other unresolved state closes.
 */
export function resolveWebRelayE2eeProvider(
  target?: WebRelayE2eeTarget | null,
): RelayE2eeProvider | undefined {
  // Before §14.5, because it is not an E2EE question: a channel with no
  // environment cannot be labelled anywhere, and §12.2 forbids an unlabelled
  // plaintext channel as firmly as §12.1.1 forbids an unkeyed latch.
  if (target === null) return unresolvedAttemptChannel;
  if (!randomnessUsable) {
    // §14.5 refused E2EE, so the engine locks `legacy` at `channel.accept` with
    // no machine in between — and §12.2 labels that channel like any other
    // fallback. It is published HERE because there is no §4.4 machine to publish
    // it from: a projection left at `unavailable` would render this channel
    // `Online` with no claim either way, which is the state that has no channel
    // rather than the one that locked plaintext. It is the TARGET's label: on
    // the displayed entry it would describe another node's channel.
    if (target === undefined) {
      lockWebE2eeChannelMode("legacy");
    } else {
      const channelIdentity = {};
      beginWebE2eeChannelAttempt(target.environmentId, channelIdentity);
      lockWebE2eeChannelMode("legacy", target.environmentId, channelIdentity);
    }
    return undefined;
  }
  const channelTarget = target ?? selectedNodeTarget();
  const selection = selectionForNode(channelTarget?.nodeId);
  if (channelTarget === null || selection === null) return unresolvedAttemptChannel;
  const e2ee = loadedE2ee;
  if (e2ee === null) {
    // The retry this close asks for finds the code loaded.
    void loadWebRelayE2ee().catch(() => undefined);
    return unresolvedAttemptChannel;
  }
  const { makeRelayE2eeInitiator } = e2ee;
  const { environmentId } = channelTarget;
  const attempt = webRelayE2eeAttempt(selection);
  lastAttempt = attempt;
  return (host) => {
    // §13's projection is PER CHANNEL, not per selection: a state earned by one
    // channel may not describe the next one, and §13.5's code is bound to a
    // single session by construction. Publishing `negotiating` here — which
    // claims nothing — is what keeps either from surviving the socket that
    // produced it. The identity makes this channel the entry's owner, and every
    // later write below applies only while it still is: a stale channel's lock,
    // code or teardown cannot touch the entry a successor took over.
    const channelIdentity = {};
    beginWebE2eeChannelAttempt(environmentId, channelIdentity);
    // THE LOCK IS OBSERVED AT `host.lockMode` AND NOT AFTER AN OPERATION, and
    // the difference is row K13. §4.4's mode lock is a state the machine holds
    // rather than a callback, so a projection synced after `intercept`/`emit`
    // learns about a lock only when the next payload arrives — and K13 locks
    // from the `T_ADV` TIMER, on a channel the node has said nothing on. Such a
    // channel is plaintext and stayed labelled `negotiating` forever, which is
    // exactly the honest-labeling duty of §12.2 going unmet. `lockMode` is the
    // release valve itself, so wrapping it catches every lock — K1/K5, K9 and
    // K13 alike — at the instant it happens.
    const channel = makeRelayE2eeInitiator({
      host: {
        ...host,
        lockMode: (mode) => {
          host.lockMode(mode);
          lockWebE2eeChannelMode(mode, environmentId, channelIdentity);
        },
      },
      attempt: {
        ...attempt,
        onWebVerificationCode: (code) =>
          publishWebE2eeVerificationCode(code, environmentId, channelIdentity),
      },
    });
    // …AND THE END OF THE CHANNEL IS OBSERVED THE SAME WAY. §4.4's machine is
    // "created when the channel is accepted and destroyed when it closes", and
    // `dispose` is the destruction. Relying on the SUCCESSOR channel's
    // `beginWebE2eeChannelAttempt` instead left `web-unsigned` and §13.5's code
    // standing for the whole of a reconnect backoff — seconds to minutes in
    // which the projection reports a live encrypted session, and a `WebSAS` for
    // a session that no longer exists. §13.5's entire security property is that
    // the string is session-bound, so an owner comparing a dead channel's value
    // against the node CLI's live one is comparing the one thing it may not be
    // compared against.
    return {
      ...channel,
      dispose: (options) => {
        channel.dispose(options);
        resetWebE2eeSession(environmentId, channelIdentity);
      },
    };
  };
}

export function readWebRelayE2eeAttemptForTests(): RelayE2eeInitiatorAttempt | null {
  return lastAttempt;
}

/** Test seam: whether the handshake code has been loaded in this module instance. */
export function isWebRelayE2eeLoadedForTests(): boolean {
  return loadedE2ee !== null;
}

let sessionWatch: (() => void) | undefined;

/**
 * §12.1: the web latch "MUST NOT persist beyond the application session", and a
 * sign-out ends it.
 *
 * The account scope is half of §12.1's key, so a session that ends takes its
 * latches and every environment's §13 projection with it — a standing
 * `web-unsigned` would otherwise describe a channel for an account that is no
 * longer signed in.
 *
 * NODE SELECTION IS DELIBERATELY NOT A TRIGGER. The latch is already keyed per
 * node within one session, so switching nodes needs no clearing — and clearing
 * would RELAX a guard rather than tighten one, since an unlatched selection is
 * legacy-eligible. A reversible `signing-out` transition is not a session end;
 * only the controller's terminal `signed-out` / `session-expired` states clear.
 */
export function watchWebHostedSessionForE2ee(): () => void {
  if (sessionWatch !== undefined) return sessionWatch;
  let applicationSessionActive = hostedHubStore.getState().accountStatus === "authenticated";
  if (applicationSessionActive) scheduleWebE2eeWarmUp();
  const unsubscribe = hostedHubStore.subscribe(() => {
    const status = hostedHubStore.getState().accountStatus;
    if (status === "authenticated") {
      if (!applicationSessionActive) scheduleWebE2eeWarmUp();
      applicationSessionActive = true;
      return;
    }
    if (!applicationSessionActive || (status !== "signed-out" && status !== "session-expired")) {
      return;
    }
    applicationSessionActive = false;
    clearWebE2eeLatches();
    clearWebE2eeLocalDiagnostics();
    resetWebE2eeSession();
  });
  sessionWatch = () => {
    sessionWatch = undefined;
    unsubscribe();
  };
  return sessionWatch;
}

/**
 * Load the handshake code once an account is authenticated, then warm its curve
 * primitives in an idle period: at least the directory, ticket and channel
 * round trips lie between that and the first `channel.accept`, and the first
 * handshake would otherwise wait on the download, or pay the curve library's
 * lazy setup on the main thread inside the connect. Skipped where §14.5 refused
 * E2EE; nothing the warm-up computes is used.
 */
function scheduleWebE2eeWarmUp(): void {
  if (!randomnessUsable) return;
  loadWebRelayE2ee().then(
    ({ warmE2eePrimitives }) => {
      const run = () => warmE2eePrimitives();
      if (typeof globalThis.requestIdleCallback === "function") {
        globalThis.requestIdleCallback(run, { timeout: 2_000 });
      } else {
        globalThis.setTimeout(run, 0);
      }
    },
    // The transport's preparation retries the load before a ticket is bought.
    () => undefined,
  );
}

/** Test seam: re-run the §14.5 startup check and drop the recorded attempt. */
export function resetWebRelayE2eeForTests(): void {
  randomnessUsable = detectWebE2eeRandomness();
  lastAttempt = null;
  sessionWatch?.();
}
