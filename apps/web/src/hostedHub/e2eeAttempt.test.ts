import { hostedHubStore } from "@ryco/client-runtime/authorization";
import type { RelayE2eeChannel, RelayE2eeHost } from "@ryco/client-runtime/relay";
import { EnvironmentId } from "@ryco/contracts";
import { T_ADV } from "@ryco/shared/relayE2eeConstants";
import { decodeNodeE2eeCapabilityStatement } from "@ryco/shared/relayE2eeTranscripts";
import { deriveE2eeWebSas } from "@ryco/shared/relayE2eeVerificationDisplay";
import { stripRelayCompressionAdvertisement } from "@ryco/shared/relayPayloadCompression";
import {
  classifyPostStripPayload,
  encodeE2eeCapabilityCarrier,
  E2EE_SUITE_25519_CHACHAPOLY_SHA256,
  E2EE_SUITE_ACCOUNT_GRANT_25519_CHACHAPOLY_SHA256,
} from "@ryco/shared/relayE2eeWire";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  authenticateRelay,
  createRelayHarness,
  deliverRelayPayload,
  fixtureStatement,
  FIXTURE_ACCOUNT_ID,
  FIXTURE_HUB_ORIGIN,
  FIXTURE_NODE_ID,
  FIXTURE_NOW,
  outboundRelayPayloads,
  relayCloseReasons,
  respondAsNode,
  settleRelay,
  USABLE_STATEMENT_CASE,
} from "../../test/maliciousRelay";
import {
  loadWebRelayE2ee,
  readWebRelayE2eeAttemptForTests,
  resetWebRelayE2eeForTests,
  resolveWebRelayE2eeProvider,
  webRelayE2eeAttempt,
} from "./e2eeAttempt";
import {
  acceptedWebE2eePolicyGeneration,
  clearWebE2eeLatches,
  isWebE2eeSelectionLatched,
  latchWebE2eeSelection,
  recordWebE2eePolicyGeneration,
} from "./e2eeLatch";
import {
  beginWebE2eeChannelAttempt,
  clearWebE2eeLocalDiagnostics,
  lockWebE2eeChannelMode,
  publishWebE2eeVerificationCode,
  resetWebE2eeSession,
  setDisplayedWebE2eeEnvironment,
  webE2eeLocalDiagnostics,
  webE2eeSessionState,
  webE2eeSessionStateFor,
} from "./e2eeSession";

/** The §7.6 element 5 key, for the §13.5 derivation the node would also run. */
function decodeStatementIdentityKey(statement: Uint8Array): Uint8Array {
  const decoded = decodeNodeE2eeCapabilityStatement(statement);
  if (decoded.kind !== "ok") throw new Error("fixture statement did not decode");
  return decoded.value.identityPublicKey;
}

// docs/relay-e2ee-protocol.md §4.4's attempt, as THIS TIER resolves it — and
// mostly a suite about what the attempt does not carry.
//
// §8.3, §12.1.1, §13.1 and §13.2 each remove something from the web attempt that
// the native one has, and none of those absences is observable through the
// provider the engine receives: a caller that started passing an `accountId`, a
// pin, or a pairing flag would change what goes into the §8.3 context and what
// §4.4's rows do, while every behavioural assertion in the browser suites stayed
// green. So they are asserted directly, on the value.

const HUB_ORIGIN = "https://hub.example.test";
const ACCOUNT_ID = "acct_0123456789";
const NODE_ID = "node_AAAAAAAAAAAAAAAAAAAAAA";
const SELECTION = {
  hubOrigin: HUB_ORIGIN,
  accountId: ACCOUNT_ID,
  nodeId: NODE_ID,
} as const;

const originalWindow = globalThis.window;
const originalIsSecureContext = Object.getOwnPropertyDescriptor(globalThis, "isSecureContext");
const originalCrypto = Object.getOwnPropertyDescriptor(globalThis, "crypto");

function defineGlobal(name: string, value: unknown): void {
  Object.defineProperty(globalThis, name, { configurable: true, value });
}

function restoreGlobal(name: string, descriptor: PropertyDescriptor | undefined): void {
  if (descriptor) Object.defineProperty(globalThis, name, descriptor);
  else Reflect.deleteProperty(globalThis, name);
}

/** The one environment §14.5 admits: a secure context with a real CSPRNG. */
function installSecureContext(): void {
  defineGlobal("window", { location: { origin: HUB_ORIGIN } });
  defineGlobal("isSecureContext", true);
  if (typeof globalThis.crypto?.getRandomValues !== "function") {
    defineGlobal("crypto", { getRandomValues: (array: Uint8Array) => array });
  }
  resetWebRelayE2eeForTests();
}

function signIn(): void {
  hostedHubStore.setState({
    accountStatus: "authenticated",
    account: { id: ACCOUNT_ID } as never,
    selectedNode: { id: NODE_ID } as never,
  });
}

function signOut(): void {
  hostedHubStore.setState({
    accountStatus: "signed-out",
    account: null,
    selectedNode: null,
  });
}

// The hosted transport loads the handshake code before it buys a ticket (see
// `prepareWebRelayE2ee`); these suites drive the provider directly, after it.
beforeAll(async () => {
  await loadWebRelayE2ee();
});

beforeEach(() => {
  clearWebE2eeLatches();
  clearWebE2eeLocalDiagnostics();
  installSecureContext();
  signIn();
});

afterEach(() => {
  signOut();
  clearWebE2eeLatches();
  clearWebE2eeLocalDiagnostics();
  setDisplayedWebE2eeEnvironment(null);
  resetWebE2eeSession();
  restoreGlobal("isSecureContext", originalIsSecureContext);
  restoreGlobal("crypto", originalCrypto);
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: originalWindow,
  });
  resetWebRelayE2eeForTests();
  vi.restoreAllMocks();
});

describe("§4.4 the web attempt is resolved synchronously, before any payload", () => {
  it("is complete the instant createRelaySocket's expression evaluates", () => {
    expect(readWebRelayE2eeAttemptForTests()).toBeNull();
    // Exactly the expression `runtime.ts` builds the socket from. §4.4 requires
    // every selection guard to be evaluable "before it has received any
    // payload"; on this tier there is nothing to await, so the attempt exists
    // before the socket does — not merely before the first frame.
    const harness = createRelayHarness({ e2ee: resolveWebRelayE2eeProvider() });
    const attempt = readWebRelayE2eeAttemptForTests();
    expect(attempt).not.toBeNull();
    expect(attempt!.hubOrigin).toBe(HUB_ORIGIN);
    expect(harness.socket.sent).toHaveLength(0);
  });

  it("classifies only as latched or legacy-eligible, never as unexpected", () => {
    // §12.1.1's web mapping is degenerate by design: "Web never produces an
    // _unexpected_ selection, and consequently never raises §13.2.1." The two
    // reachable values are asserted over the only input that moves them.
    expect(webRelayE2eeAttempt(SELECTION).selectionClass).toBe("legacy-eligible");
    latchWebE2eeSelection(SELECTION);
    expect(webRelayE2eeAttempt(SELECTION).selectionClass).toBe("latched");
  });

  it("carries the current policy-generation high-water and omits an absent one", () => {
    const first = webRelayE2eeAttempt(SELECTION);
    expect(first.acceptedPolicyGeneration).toBeUndefined();
    expect("acceptedPolicyGeneration" in first).toBe(false);

    recordWebE2eePolicyGeneration(SELECTION, 7);
    expect(webRelayE2eeAttempt(SELECTION).acceptedPolicyGeneration).toBe(7);
    recordWebE2eePolicyGeneration(SELECTION, 6);
    expect(webRelayE2eeAttempt(SELECTION).acceptedPolicyGeneration).toBe(7);
  });
});

describe("§8.3/§12.1.1/§13.1 what the web attempt carries and what it must not", () => {
  it("carries exactly the NX credentials and no client identifier at all", () => {
    const attempt = webRelayE2eeAttempt(SELECTION);
    // §8.5: "THE CLEAR WRAPPER CARRIES NO CLIENT IDENTIFIER." On NX there is no
    // client identity key, no prekey, and no signature to carry either, so the
    // literal IS the credential set — asserted as a whole value rather than
    // field by field, because a field added later is exactly the defect.
    expect(attempt.credentials).toEqual({ tier: "web" });
    expect(Object.keys(attempt.credentials)).toEqual(["tier"]);
  });

  it("forwards no accountId onto the attempt, though the latch is keyed on one", () => {
    // §8.3 and §12.1.1: the account scope is a native resolution input and "the
    // web tier has none". It is still half of §12.1's latch key — client-local
    // state — and the two must not be conflated, or a Hub-issued value ends up
    // in the §8.3 context of a tier defined without one.
    const attempt = webRelayE2eeAttempt(SELECTION);
    expect(attempt.accountId).toBeUndefined();
    expect("accountId" in attempt).toBe(false);

    latchWebE2eeSelection({ ...SELECTION, accountId: "acct_other" });
    expect(webRelayE2eeAttempt(SELECTION).selectionClass).toBe("legacy-eligible");
    latchWebE2eeSelection(SELECTION);
    expect(webRelayE2eeAttempt(SELECTION).selectionClass).toBe("latched");
  });

  it("carries no pin, raises no unexpected-node surface, and is never pairing-only", () => {
    const attempt = webRelayE2eeAttempt(SELECTION);
    // §13.1: web holds no durable pin, so §8.3 elements 9 and 17 have no anchor
    // other than the statement itself.
    expect(attempt.verifiedPin).toBeUndefined();
    expect("verifiedPin" in attempt).toBe(false);
    // §12.1.1: rows K23/K24 are unreachable on web, so a handler for them would
    // be a surface with no reachable cause.
    expect(attempt.onUnexpectedNode).toBeUndefined();
    expect("onUnexpectedNode" in attempt).toBe(false);
    // §13.2's ceremony pins an identity; this tier has nowhere to keep one.
    expect(attempt.pairingOnly).toBe(false);
    expect(attempt.localSuitePreference).toEqual([E2EE_SUITE_25519_CHACHAPOLY_SHA256]);
    expect(attempt.localSuitePreference).not.toContain(
      E2EE_SUITE_ACCOUNT_GRANT_25519_CHACHAPOLY_SHA256,
    );
  });

  it("cannot serialize native account-grant authorization from the Web tier", () => {
    const attempt = webRelayE2eeAttempt(SELECTION);
    const serialized = JSON.stringify({
      credentials: attempt.credentials,
      localSuitePreference: attempt.localSuitePreference,
    });
    expect(serialized).not.toMatch(/account|grant|identityPublicKey|agreementPublicKey/iu);
    expect(serialized).not.toContain(String(E2EE_SUITE_ACCOUNT_GRANT_25519_CHACHAPOLY_SHA256));
  });

  it("permits legacy, because §12.1.1's strict mode is an opt-in web cannot record", () => {
    // §12.1.1: strict mode "MUST be recorded and evaluated under `hubOrigin`
    // alone" and "MUST NOT be a silent consequence of the first verified pin".
    // Web has no durable store, so no opt-in exists — and `false` here would be
    // a strict mode nobody chose, making every un-upgraded node unreachable
    // through the P18/P19 guards during the §12.3 compatibility window.
    expect(webRelayE2eeAttempt(SELECTION).legacyPermitted).toBe(true);
    latchWebE2eeSelection(SELECTION);
    expect(webRelayE2eeAttempt(SELECTION).legacyPermitted).toBe(true);
  });
});

describe("§14.5 the startup randomness check gates the provider, not a handshake step", () => {
  it("supplies no provider at all outside a secure context", () => {
    defineGlobal("isSecureContext", false);
    resetWebRelayE2eeForTests();
    expect(resolveWebRelayE2eeProvider()).toBeUndefined();
  });

  it("supplies no provider at all with no crypto.getRandomValues", () => {
    defineGlobal("crypto", {});
    resetWebRelayE2eeForTests();
    expect(resolveWebRelayE2eeProvider()).toBeUndefined();
  });

  it("is evaluated at startup and not per channel", () => {
    // §14.5: "A conforming implementation verifies the source at startup and
    // refuses E2EE, rather than discovering the absence mid-handshake." The
    // check is therefore a value this module already holds, and removing the
    // API afterwards cannot turn a running session into a degraded mode.
    expect(resolveWebRelayE2eeProvider()).toBeTypeOf("function");
    defineGlobal("crypto", {});
    expect(resolveWebRelayE2eeProvider()).toBeTypeOf("function");
  });

  it("falls back to a provider-less engine that runs the unchanged legacy channel", async () => {
    defineGlobal("isSecureContext", false);
    resetWebRelayE2eeForTests();
    resetWebE2eeSession();
    const harness = createRelayHarness({ e2ee: resolveWebRelayE2eeProvider() });
    authenticateRelay(harness.socket);
    harness.facade.send(new TextEncoder().encode('{"first":1}'));
    await settleRelay();

    // Plainly legacy: the submission went out as plaintext immediately, no
    // negotiation record was produced, and the channel was not closed. §12.2's
    // honest labeling then applies to it — which is the point of failing closed
    // to LEGACY rather than to a half-E2EE mode nothing could describe.
    const payloads = outboundRelayPayloads(harness.socket);
    expect(payloads).toHaveLength(1);
    expect(new TextDecoder().decode(stripRelayCompressionAdvertisement(payloads[0]!))).toBe(
      '{"first":1}',
    );
    expect(relayCloseReasons(harness.socket)).toEqual([]);

    // …and the projection SAYS legacy, because §12.2 applies to this channel as
    // much as to row K13's. There is no §4.4 machine here to publish it, so a
    // projection left at `unavailable` would render it `Online` with no claim —
    // the state that has no channel, not the one that locked plaintext.
    expect(webE2eeSessionState()).toEqual({
      status: "legacy",
      verificationCode: null,
    });
    resetWebE2eeSession();
  });
});

describe("§4 the production wiring establishes an NX session end to end", () => {
  it("goes negotiating → web-unsigned, publishes §13.5's code, and latches the selection", async () => {
    // The whole slice, through the path `runtime.ts` actually builds: the store
    // selection, `resolveWebRelayE2eeProvider()`, the §4.4 machine, the §12.1
    // latch set from the statement's validation, and the §13 projection.
    //
    // The Hub origin is the committed corpus's, because §5.2 step 4 checks every
    // statement against the origin the client is connected to — so the fake
    // window here is not a convenience, it is the input under test.
    vi.spyOn(Date, "now").mockReturnValue(FIXTURE_NOW);
    defineGlobal("window", { location: { origin: FIXTURE_HUB_ORIGIN } });
    resetWebRelayE2eeForTests();
    resetWebE2eeSession();
    hostedHubStore.setState({
      accountStatus: "authenticated",
      account: { id: FIXTURE_ACCOUNT_ID } as never,
      selectedNode: { id: FIXTURE_NODE_ID } as never,
    });

    const harness = createRelayHarness({ e2ee: resolveWebRelayE2eeProvider() });
    expect(webE2eeSessionState().status).toBe("unavailable");
    authenticateRelay(harness.socket);
    // §4.4: the machine is built at `channel.accept`, and `negotiating` claims
    // nothing about the channel either way.
    expect(webE2eeSessionState()).toEqual({
      status: "negotiating",
      verificationCode: null,
    });

    const statement = fixtureStatement(USABLE_STATEMENT_CASE);
    deliverRelayPayload(harness.socket, encodeE2eeCapabilityCarrier(statement));
    await settleRelay();
    // §12.1: set on the statement's VALIDATION, before any handshake completed.
    expect(
      isWebE2eeSelectionLatched({
        hubOrigin: FIXTURE_HUB_ORIGIN,
        accountId: FIXTURE_ACCOUNT_ID,
        nodeId: FIXTURE_NODE_ID,
      }),
    ).toBe(true);
    const fixtureSelection = {
      hubOrigin: FIXTURE_HUB_ORIGIN,
      accountId: FIXTURE_ACCOUNT_ID,
      nodeId: FIXTURE_NODE_ID,
    };
    const generation = decodeNodeE2eeCapabilityStatement(statement);
    expect(generation.kind).toBe("ok");
    if (generation.kind !== "ok") return;
    expect(acceptedWebE2eePolicyGeneration(fixtureSelection)).toBe(
      generation.value.policyGeneration,
    );

    const hello = outboundRelayPayloads(harness.socket).at(-1);
    expect(hello).toBeDefined();
    const accept = respondAsNode(Uint8Array.from(hello!));
    expect(accept.kind).toBe("accepted");
    if (accept.kind !== "accepted") return;
    deliverRelayPayload(harness.socket, accept.record, 1);
    await settleRelay();

    // §2.2's *Web, unsigned ephemeral* row — NEVER `verified`, which would claim
    // the native guarantee from a client whose JavaScript the Hub serves.
    const state = webE2eeSessionState();
    expect(state.status).toBe("web-unsigned");
    expect(state.verificationCode).toBe(
      deriveE2eeWebSas({
        nodeIdentityPublicKey: decodeStatementIdentityKey(statement),
        webEphemeralPublicKey: accept.peerEphemeralPublicKey,
        sessionBindingHash: accept.sessionBindingHash,
      }).display,
    );

    // Application traffic now leaves as envelopes and never as plaintext.
    harness.facade.send(new TextEncoder().encode('{"after":1}'));
    await settleRelay();
    for (const payload of outboundRelayPayloads(harness.socket).slice(1)) {
      expect(classifyPostStripPayload(payload).kind).toBe("envelope");
    }

    // …AND IT ENDS WITH THE CHANNEL. §13.5's string is session-bound — "it
    // changes on every channel" — so a socket drop that left it standing would
    // give the owner a dead session's value to compare against the node CLI's
    // live one, for the whole of a reconnect backoff. Nothing else observes the
    // close: relying on the SUCCESSOR channel's `beginWebE2eeChannelAttempt` is
    // what left `web-unsigned` and the code standing until one arrived.
    harness.socket.drop();
    await settleRelay();
    expect(webE2eeSessionState()).toEqual({
      status: "unavailable",
      verificationCode: null,
    });
    resetWebE2eeSession();
  });

  it("retains the validated generation across a stalled handshake and reconnect", async () => {
    vi.spyOn(Date, "now").mockReturnValue(FIXTURE_NOW);
    defineGlobal("window", { location: { origin: FIXTURE_HUB_ORIGIN } });
    resetWebRelayE2eeForTests();
    hostedHubStore.setState({
      accountStatus: "authenticated",
      account: { id: FIXTURE_ACCOUNT_ID } as never,
      selectedNode: { id: FIXTURE_NODE_ID } as never,
    });

    const statement = fixtureStatement(USABLE_STATEMENT_CASE);
    const decoded = decodeNodeE2eeCapabilityStatement(statement);
    expect(decoded.kind).toBe("ok");
    if (decoded.kind !== "ok") return;
    const first = createRelayHarness({ e2ee: resolveWebRelayE2eeProvider() });
    authenticateRelay(first.socket);
    deliverRelayPayload(first.socket, encodeE2eeCapabilityCarrier(statement));
    await settleRelay();

    // The node never answers hello. Validation already advanced §5.7, and a
    // reconnect in the same application session must enforce it immediately.
    first.socket.drop();
    await settleRelay();
    resolveWebRelayE2eeProvider();
    expect(readWebRelayE2eeAttemptForTests()?.acceptedPolicyGeneration).toBe(
      decoded.value.policyGeneration,
    );
  });

  it("accepts a newer generation and then the repeated high-water", async () => {
    vi.spyOn(Date, "now").mockReturnValue(FIXTURE_NOW);
    defineGlobal("window", { location: { origin: FIXTURE_HUB_ORIGIN } });
    resetWebRelayE2eeForTests();
    hostedHubStore.setState({
      accountStatus: "authenticated",
      account: { id: FIXTURE_ACCOUNT_ID } as never,
      selectedNode: { id: FIXTURE_NODE_ID } as never,
    });
    const selection = {
      hubOrigin: FIXTURE_HUB_ORIGIN,
      accountId: FIXTURE_ACCOUNT_ID,
      nodeId: FIXTURE_NODE_ID,
    };
    const statement = fixtureStatement(USABLE_STATEMENT_CASE);
    const decoded = decodeNodeE2eeCapabilityStatement(statement);
    expect(decoded.kind).toBe("ok");
    if (decoded.kind !== "ok") return;
    latchWebE2eeSelection(selection);
    recordWebE2eePolicyGeneration(selection, decoded.value.policyGeneration - 1);

    const newer = createRelayHarness({ e2ee: resolveWebRelayE2eeProvider() });
    authenticateRelay(newer.socket);
    deliverRelayPayload(newer.socket, encodeE2eeCapabilityCarrier(statement));
    await settleRelay();
    expect(outboundRelayPayloads(newer.socket)).toHaveLength(1);
    expect(acceptedWebE2eePolicyGeneration(selection)).toBe(decoded.value.policyGeneration);
    newer.socket.drop();
    await settleRelay();

    const repeated = createRelayHarness({
      e2ee: resolveWebRelayE2eeProvider(),
    });
    authenticateRelay(repeated.socket);
    deliverRelayPayload(repeated.socket, encodeE2eeCapabilityCarrier(statement));
    await settleRelay();
    expect(outboundRelayPayloads(repeated.socket)).toHaveLength(1);
    expect(acceptedWebE2eePolicyGeneration(selection)).toBe(decoded.value.policyGeneration);
  });

  it("rejects a valid but lower-generation statement before sending hello", async () => {
    vi.spyOn(Date, "now").mockReturnValue(FIXTURE_NOW);
    defineGlobal("window", { location: { origin: FIXTURE_HUB_ORIGIN } });
    resetWebRelayE2eeForTests();
    hostedHubStore.setState({
      accountStatus: "authenticated",
      account: { id: FIXTURE_ACCOUNT_ID } as never,
      selectedNode: { id: FIXTURE_NODE_ID } as never,
    });
    const selection = {
      hubOrigin: FIXTURE_HUB_ORIGIN,
      accountId: FIXTURE_ACCOUNT_ID,
      nodeId: FIXTURE_NODE_ID,
    };
    const statement = fixtureStatement(USABLE_STATEMENT_CASE);
    const decoded = decodeNodeE2eeCapabilityStatement(statement);
    expect(decoded.kind).toBe("ok");
    if (decoded.kind !== "ok") return;
    latchWebE2eeSelection(selection);
    recordWebE2eePolicyGeneration(selection, decoded.value.policyGeneration + 1);

    const harness = createRelayHarness({ e2ee: resolveWebRelayE2eeProvider() });
    authenticateRelay(harness.socket);
    deliverRelayPayload(harness.socket, encodeE2eeCapabilityCarrier(statement));
    await settleRelay();

    expect(outboundRelayPayloads(harness.socket)).toEqual([]);
    expect(relayCloseReasons(harness.socket)).toHaveLength(1);
    expect(webE2eeLocalDiagnostics()).toEqual(["e2ee_policy_generation_regressed"]);
    expect(acceptedWebE2eePolicyGeneration(selection)).toBe(decoded.value.policyGeneration + 1);
  });

  it("re-checks live state before an overlapping stale attempt sends hello", async () => {
    vi.spyOn(Date, "now").mockReturnValue(FIXTURE_NOW);
    defineGlobal("window", { location: { origin: FIXTURE_HUB_ORIGIN } });
    resetWebRelayE2eeForTests();
    hostedHubStore.setState({
      accountStatus: "authenticated",
      account: { id: FIXTURE_ACCOUNT_ID } as never,
      selectedNode: { id: FIXTURE_NODE_ID } as never,
    });
    const selection = {
      hubOrigin: FIXTURE_HUB_ORIGIN,
      accountId: FIXTURE_ACCOUNT_ID,
      nodeId: FIXTURE_NODE_ID,
    };
    const statement = fixtureStatement(USABLE_STATEMENT_CASE);
    const decoded = decodeNodeE2eeCapabilityStatement(statement);
    expect(decoded.kind).toBe("ok");
    if (decoded.kind !== "ok") return;

    const stale = createRelayHarness({ e2ee: resolveWebRelayE2eeProvider() });
    authenticateRelay(stale.socket);
    latchWebE2eeSelection(selection);
    recordWebE2eePolicyGeneration(selection, decoded.value.policyGeneration + 1);
    deliverRelayPayload(stale.socket, encodeE2eeCapabilityCarrier(statement));
    await settleRelay();

    expect(outboundRelayPayloads(stale.socket)).toEqual([]);
    expect(relayCloseReasons(stale.socket)).toEqual(["channel_rejected"]);
    expect(webE2eeLocalDiagnostics()).toEqual(["e2ee_policy_generation_regressed"]);
    expect(acceptedWebE2eePolicyGeneration(selection)).toBe(decoded.value.policyGeneration + 1);
  });

  it("projects `legacy` when the carrier never arrives on a legacy-eligible selection", async () => {
    // §12.2's honest labeling needs an input, and this is it: row K13 locks the
    // channel to plaintext, and the projection says so rather than staying at
    // `negotiating` — which claims nothing but also warns nothing.
    defineGlobal("window", { location: { origin: FIXTURE_HUB_ORIGIN } });
    resetWebRelayE2eeForTests();
    resetWebE2eeSession();
    hostedHubStore.setState({
      accountStatus: "authenticated",
      account: { id: FIXTURE_ACCOUNT_ID } as never,
      selectedNode: { id: FIXTURE_NODE_ID } as never,
    });

    const harness = createRelayHarness({ e2ee: resolveWebRelayE2eeProvider() });
    authenticateRelay(harness.socket);
    harness.facade.send(new TextEncoder().encode('{"buffered":1}'));
    await new Promise((resolve) => globalThis.setTimeout(resolve, T_ADV + 250));

    expect(webE2eeSessionState()).toEqual({
      status: "legacy",
      verificationCode: null,
    });
    const flushed = outboundRelayPayloads(harness.socket);
    expect(flushed).toHaveLength(1);
    expect(classifyPostStripPayload(flushed[0]!).kind).toBe("legacy-json");
    resetWebE2eeSession();
  });
});

describe("§12.1.1 an unreadable selection fails closed, never to plaintext", () => {
  it("closes the channel when no selection can be read at all", async () => {
    signOut();
    const provider = resolveWebRelayE2eeProvider();
    expect(provider).toBeTypeOf("function");

    const built: RelayE2eeChannel[] = [];
    const harness = createRelayHarness({
      e2ee: (host: RelayE2eeHost) => {
        const channel = provider!(host);
        built.push(channel);
        return channel;
      },
    });
    authenticateRelay(harness.socket);
    await settleRelay();

    // §12.1.1 forbids treating unobtainable evidence as an unset latch, so the
    // absent selection is NOT the legacy-eligible class: the channel closes at
    // `channel.accept` and never becomes writable, so no application payload can
    // even be submitted to it, let alone flushed as plaintext.
    expect(built).toHaveLength(1);
    expect(outboundRelayPayloads(harness.socket)).toEqual([]);
    expect(harness.handlers.onFailure).toHaveBeenCalled();
    expect(() => harness.facade.send(new TextEncoder().encode('{"first":1}'))).toThrow(
      "Relay channel is not open.",
    );
    expect(outboundRelayPayloads(harness.socket)).toEqual([]);

    // §11.5: the close is the RETRYABLE disposition, so a store that moved under
    // a reconnect costs one channel rather than the whole hosted session.
    const failure = harness.handlers.onFailure.mock.calls.at(-1)?.[0] as {
      readonly retryable?: boolean;
    };
    expect(failure.retryable).toBe(true);
  });
});

describe("§12.1/§13 every channel is resolved for its own node", () => {
  const NODE_B = "node_BBBBBBBBBBBBBBBBBBBBBB";
  const ENVIRONMENT_A = EnvironmentId.make("env_aaaaaaaaaaaaaaaaaaaaaa");
  const ENVIRONMENT_B = EnvironmentId.make("env_bbbbbbbbbbbbbbbbbbbbbb");
  const TARGET_B = { nodeId: NODE_B, environmentId: ENVIRONMENT_B } as const;
  const SELECTION_B = { ...SELECTION, nodeId: NODE_B } as const;

  function selectNodeA(): void {
    hostedHubStore.setState({
      selectedNode: { id: NODE_ID, environmentId: ENVIRONMENT_A } as never,
    });
    setDisplayedWebE2eeEnvironment(ENVIRONMENT_A);
  }

  it("classifies a channel to node B against B's latch while node A is selected", () => {
    // §5.2's statement check and §12.1's latch are the CHANNEL's node's. Read
    // from the selection, a reconnect of B's channel while A is selected would
    // carry A's classification into B's §4.4 rows.
    selectNodeA();
    latchWebE2eeSelection(SELECTION_B);
    resolveWebRelayE2eeProvider(TARGET_B);
    expect(readWebRelayE2eeAttemptForTests()?.selectionClass).toBe("latched");

    clearWebE2eeLatches();
    latchWebE2eeSelection(SELECTION);
    resolveWebRelayE2eeProvider(TARGET_B);
    expect(readWebRelayE2eeAttemptForTests()?.selectionClass).toBe("legacy-eligible");
  });

  it("takes row K13 or K14 on B's channel by B's latch alone", async () => {
    // A withheld carrier locks plaintext (K13) on a legacy-eligible selection and
    // closes (K14) on a latched one. With A selected and latched, B's channel
    // must still take the row B's own latch decides.
    selectNodeA();
    latchWebE2eeSelection(SELECTION);
    const unlatched = createRelayHarness({ e2ee: resolveWebRelayE2eeProvider(TARGET_B) });
    expect(readWebRelayE2eeAttemptForTests()?.selectionClass).toBe("legacy-eligible");
    clearWebE2eeLatches();
    latchWebE2eeSelection(SELECTION_B);
    const latched = createRelayHarness({ e2ee: resolveWebRelayE2eeProvider(TARGET_B) });
    expect(readWebRelayE2eeAttemptForTests()?.selectionClass).toBe("latched");

    authenticateRelay(unlatched.socket);
    authenticateRelay(latched.socket);
    unlatched.facade.send(new TextEncoder().encode('{"buffered":1}'));
    latched.facade.send(new TextEncoder().encode('{"buffered":2}'));
    await new Promise((resolve) => globalThis.setTimeout(resolve, T_ADV + 250));

    const flushed = outboundRelayPayloads(unlatched.socket);
    expect(flushed).toHaveLength(1);
    expect(classifyPostStripPayload(flushed[0]!).kind).toBe("legacy-json");
    expect(relayCloseReasons(unlatched.socket)).toEqual([]);
    expect(outboundRelayPayloads(latched.socket)).toEqual([]);
    expect(relayCloseReasons(latched.socket)).toEqual(["channel_rejected"]);
    // Neither channel wrote into the displayed environment's entry.
    expect(webE2eeSessionState().status).toBe("unavailable");
    unlatched.socket.drop();
    await settleRelay();
  });

  it("builds a warm channel's attempt with no node selected at all", async () => {
    // Returning to the directory clears the selection and keeps the channels;
    // a selection-bound attempt closed every one of them on reconnect.
    hostedHubStore.setState({ selectedNode: null });
    const provider = resolveWebRelayE2eeProvider(TARGET_B);
    expect(provider).toBeTypeOf("function");
    expect(readWebRelayE2eeAttemptForTests()).toMatchObject({
      hubOrigin: HUB_ORIGIN,
      selectionClass: "legacy-eligible",
      credentials: { tier: "web" },
    });

    const harness = createRelayHarness({ e2ee: provider });
    authenticateRelay(harness.socket);
    await settleRelay();
    expect(relayCloseReasons(harness.socket)).toEqual([]);
    expect(harness.handlers.onFailure).not.toHaveBeenCalled();
    expect(webE2eeSessionStateFor(ENVIRONMENT_B)).toEqual({
      status: "negotiating",
      verificationCode: null,
    });
    // Nothing is displayed, so the session-wide surfaces show nothing.
    expect(webE2eeSessionState().status).toBe("unavailable");

    harness.socket.drop();
    await settleRelay();
    expect(webE2eeSessionStateFor(ENVIRONMENT_B).status).toBe("unavailable");
  });

  it("projects each channel into its own environment and ends it with that channel", async () => {
    selectNodeA();
    const channelA = createRelayHarness({
      e2ee: resolveWebRelayE2eeProvider({ nodeId: NODE_ID, environmentId: ENVIRONMENT_A }),
    });
    authenticateRelay(channelA.socket);
    const channelB = createRelayHarness({ e2ee: resolveWebRelayE2eeProvider(TARGET_B) });
    authenticateRelay(channelB.socket);
    await settleRelay();
    expect(webE2eeSessionStateFor(ENVIRONMENT_A).status).toBe("negotiating");
    expect(webE2eeSessionStateFor(ENVIRONMENT_B).status).toBe("negotiating");

    // B's channel ending takes B's entry and leaves the displayed one alone.
    channelB.socket.drop();
    await settleRelay();
    expect(webE2eeSessionStateFor(ENVIRONMENT_B).status).toBe("unavailable");
    expect(webE2eeSessionState().status).toBe("negotiating");
    channelA.socket.drop();
    await settleRelay();
  });

  it("lets a reconnected channel keep its entry when the stale one finishes late", async () => {
    // The successor can reach `channel.accept` before the previous engine is
    // done tearing down; the loser's dispose must not erase the winner's entry.
    const stale = createRelayHarness({ e2ee: resolveWebRelayE2eeProvider(TARGET_B) });
    authenticateRelay(stale.socket);
    const current = createRelayHarness({ e2ee: resolveWebRelayE2eeProvider(TARGET_B) });
    authenticateRelay(current.socket);
    await settleRelay();

    stale.socket.drop();
    await settleRelay();
    expect(webE2eeSessionStateFor(ENVIRONMENT_B)).toEqual({
      status: "negotiating",
      verificationCode: null,
    });
    current.socket.drop();
    await settleRelay();
    expect(webE2eeSessionStateFor(ENVIRONMENT_B).status).toBe("unavailable");
  });

  it("labels the target's entry legacy when §14.5 refused E2EE, not the displayed one", () => {
    selectNodeA();
    const channelA = {};
    beginWebE2eeChannelAttempt(ENVIRONMENT_A, channelA);
    publishWebE2eeVerificationCode("AAAA-BBBB", ENVIRONMENT_A, channelA);
    lockWebE2eeChannelMode("e2ee", ENVIRONMENT_A, channelA);
    defineGlobal("isSecureContext", false);
    resetWebRelayE2eeForTests();

    expect(resolveWebRelayE2eeProvider(TARGET_B)).toBeUndefined();
    expect(webE2eeSessionStateFor(ENVIRONMENT_B)).toEqual({
      status: "legacy",
      verificationCode: null,
    });
    expect(webE2eeSessionState()).toEqual({
      status: "web-unsigned",
      verificationCode: "AAAA-BBBB",
    });
  });

  it.each([
    ["with E2EE available", true],
    ["when §14.5 refused E2EE", false],
  ])("closes a channel whose node could not be resolved, %s", async (_label, secure) => {
    // The node is not in the directory: there is no latch key to classify by and
    // no environment to label the channel in, so it never opens as plaintext.
    if (!secure) {
      defineGlobal("isSecureContext", false);
      resetWebRelayE2eeForTests();
    }
    const provider = resolveWebRelayE2eeProvider(null);
    expect(provider).toBeTypeOf("function");
    const harness = createRelayHarness({ e2ee: provider });
    authenticateRelay(harness.socket);
    await settleRelay();

    expect(outboundRelayPayloads(harness.socket)).toEqual([]);
    const failure = harness.handlers.onFailure.mock.calls.at(-1)?.[0] as {
      readonly retryable?: boolean;
    };
    expect(failure.retryable).toBe(true);
    expect(webE2eeSessionState().status).toBe("unavailable");
  });
});
