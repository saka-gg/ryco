import type { RelayE2eeHost } from "@ryco/client-runtime/relay";
import { makeRelayE2eeInitiator } from "@ryco/client-runtime/relay/e2ee";
import { verifyNodeE2eeCapabilityStatement } from "@ryco/shared/relayE2eeCapabilityVerify";
import {
  E2eeClientHandshake,
  E2eeNodeHandshake,
  decodeE2eeClientHello,
  decodeE2eeServerAccept,
} from "@ryco/shared/relayE2eeHandshake";
import { E2eeRecordSession, deriveE2eeAeadKey } from "@ryco/shared/relayE2eeSession";
import {
  E2EE_WEB_SAS_HKDF_BYTES,
  E2EE_WEB_SAS_MIN_DISPLAYED_BITS,
  T_ADV,
} from "@ryco/shared/relayE2eeConstants";
import { decodeNodeE2eeCapabilityStatement } from "@ryco/shared/relayE2eeTranscripts";
import { deriveE2eeWebSas } from "@ryco/shared/relayE2eeVerificationDisplay";
import {
  E2EE_DIRECTION_CLIENT_TO_NODE,
  E2EE_DIRECTION_NODE_TO_CLIENT,
  E2EE_INNER_TYPE_RPC,
  classifyPostStripPayload,
  decodeE2eeNegotiationRecord,
  encodeE2eeCapabilityCarrier,
  E2EE_NEGOTIATION_TYPE_CLIENT_HELLO,
} from "@ryco/shared/relayE2eeWire";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  authenticateRelay,
  createRelayHarness,
  deliverRelayPayload,
  fixtureBytes,
  fixtureCase,
  fixtureCasesMatching,
  fixtureStatement,
  FIXTURE_ACCOUNT_ID,
  FIXTURE_HUB_ORIGIN,
  FIXTURE_NODE_ID,
  FIXTURE_NOW,
  F03,
  F07,
  F14,
  hexOf,
  outboundRelayPayloads,
  relayCloseReasons,
  respondAsNode,
  settleRelay,
  USABLE_STATEMENT_CASE,
  type MockWebSocket,
} from "../../../test/maliciousRelay";
import { protectOneRecord } from "../../../test/e2eeCorpus";
import { webRelayE2eeAttempt } from "../../hostedHub/e2eeAttempt";
import {
  acceptedWebE2eePolicyGeneration,
  clearWebE2eeLatches,
  isWebE2eeSelectionLatched,
  latchWebE2eeSelection,
  recordWebE2eePolicyGeneration,
} from "../../hostedHub/e2eeLatch";
import {
  beginWebE2eeChannelAttempt,
  clearWebE2eeLocalDiagnostics,
  resetWebE2eeSession,
  webE2eeLocalDiagnostics,
  webE2eeSessionState,
} from "../../hostedHub/e2eeSession";

// docs/relay-e2ee-protocol.md §16.4: the web-facing families "MUST also run in
// the web browser test suite". This file carries the WEB-TIER-SPECIFIC half of
// that obligation — F3's admitted-pattern cases, F7's NX rules as this tier
// reaches them, F10's web mapping, and the `WebSAS` half of F14 — driven through
// the real `BrowserHostedRelaySocket` under Chromium.
//
// NOT "against Chromium WebCrypto": no E2EE path in this repository calls
// `crypto.subtle` at all. The `WebSAS` derivation is `@noble/hashes` HKDF over
// SHA-256 (`packages/shared/src/relayE2eeVerificationDisplay.ts`), the record
// AEAD is `@noble/ciphers`, and the curves are `@noble/curves` — the same JS on
// both runtimes. The genuinely browser-supplied behaviour these files exercise
// is the DOM, `WebSocket`, `JSON.parse`, and `TextDecoder`.
//
// The RUNTIME-PARITY half of the same obligation — F1, F2, F8, F16's NX cases
// and F17's P-256 cases — lives in `E2eeCodecParity.browser.tsx` and
// `E2eeRecordProtection.browser.tsx`; see `docs/relay-e2ee-web-browser-vectors.md`.
//
// WHAT THIS FILE MAY NOT BE READ AS SAYING. Every case below passes on a client
// whose JavaScript a malicious Hub serves, because that Hub can complete a
// genuine handshake and then exfiltrate the plaintext it just decrypted (§2.2,
// §2.3, §2.4). None of these assertions is evidence of operator-proof
// protection, and the §12.1 latch they exercise "buys nothing against the Hub
// under any keying".

const SELECTION = {
  hubOrigin: FIXTURE_HUB_ORIGIN,
  accountId: FIXTURE_ACCOUNT_ID,
  nodeId: FIXTURE_NODE_ID,
} as const;

/** The §5.3 carrier for one committed F03 statement, framed here. */
function carrier(name: string): Uint8Array {
  return encodeE2eeCapabilityCarrier(fixtureStatement(name));
}

/** Every negotiation record type this client actually put on the relay (§3.4). */
function negotiationRecordTypes(socket: MockWebSocket): number[] {
  return outboundRelayPayloads(socket).flatMap((payload) => {
    if (classifyPostStripPayload(payload).kind !== "negotiation") return [];
    const decoded = decodeE2eeNegotiationRecord(payload);
    return decoded.kind === "error" ? [] : [decoded.value.recordType];
  });
}

/**
 * Statement validity is a §5.2 step 3 check against the CLIENT's clock, and the
 * committed corpus fixes both ends of that window. `Date` alone is frozen —
 * `setTimeout` stays real, because `T_ADV` is what decides half these rows and a
 * faked scheduler would decide them for the machine.
 */
beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(FIXTURE_NOW);
  clearWebE2eeLatches();
  clearWebE2eeLocalDiagnostics();
  resetWebE2eeSession();
});

afterEach(() => {
  clearWebE2eeLatches();
  clearWebE2eeLocalDiagnostics();
  // §13's projection is module state and outlives a case that locked it.
  resetWebE2eeSession();
  vi.restoreAllMocks();
});

/**
 * One channel, opened to `channel.accept` against the CURRENT latch state.
 *
 * The attempt is the production one — `webRelayE2eeAttempt` — with only a §11.4
 * diagnostic sink added: §11.5 makes the wire observable uniform on purpose, so
 * the §11.2 row a case expects is not readable from the frames, and the
 * client-local diagnostic is the operator's side of the same event.
 */
function openChannel() {
  const attempt = webRelayE2eeAttempt(SELECTION);
  const diagnostics: string[] = [];
  const harness = createRelayHarness({
    e2ee: (host: RelayE2eeHost) =>
      makeRelayE2eeInitiator({
        host,
        attempt: {
          ...attempt,
          onDiagnostic: (entry) => void diagnostics.push(entry.row),
        },
      }),
  });
  authenticateRelay(harness.socket);
  return { ...harness, attempt, diagnostics };
}

const waitPastTAdv = (): Promise<void> =>
  new Promise((resolve) => globalThis.setTimeout(resolve, T_ADV + 250));

describe("§16.3 F3 admitted patterns — NX tier confusion (§5.2 step 9, §7.6 element 14)", () => {
  it("drives the require-approved statement whose encoder admits only IK", async () => {
    const entry = fixtureCase(F03, "admitted-pattern-set-under-require-approved-client-e2ee");
    expect(entry.inputs.requireApprovedClientE2EE).toBe(true);
    expect(entry.expected.admittedPatterns).toEqual(["IK"]);
    const statement = fixtureBytes(entry.expected.statement);
    const decoded = decodeNodeE2eeCapabilityStatement(statement);
    expect(decoded.kind).toBe("ok");
    if (decoded.kind !== "ok") return;
    expect(decoded.value.admittedPatterns).toEqual(["IK"]);

    latchWebE2eeSelection(SELECTION);
    const channel = openChannel();
    channel.facade.send(new TextEncoder().encode('{"buffered":true}'));
    deliverRelayPayload(channel.socket, encodeE2eeCapabilityCarrier(statement));
    await settleRelay();
    expect(channel.diagnostics).toEqual(["P15"]);
    expect(outboundRelayPayloads(channel.socket)).toEqual([]);
    expect(relayCloseReasons(channel.socket)).toEqual(["channel_rejected"]);
  });

  it("evaluates the identical IK-only statement on the native tier as K1", () => {
    const entry = fixtureCase(F03, "admitted-pattern-set-ik-only-evaluated-as-native");
    const result = verifyNodeE2eeCapabilityStatement({
      statement: fixtureBytes(entry.inputs.statement),
      connectedHubOrigin: FIXTURE_HUB_ORIGIN,
      tier: "native",
      localSuitePreference: entry.inputs.localSuitePreference as readonly number[],
      now: FIXTURE_NOW,
    });
    expect(result.kind).toBe("verified");
    if (result.kind !== "verified") return;
    expect(result.selectedSuite).toBe(1);
    expect(result.statement.admittedPatterns).toEqual(["IK"]);
    expect(entry.expected.selection).toEqual({ kind: "usable", selectedSuite: 1 });
    expect(entry.expected.helloMayBeBuilt).toBe(true);
    expect(entry.expected.row).toBe("K1");
  });

  it("takes P15 on an IK-only statement while latched, flushing no buffered send", async () => {
    // The REACHABLE version-1 configuration: §12.1 sets the web latch on the
    // statement's own validation and step 9 runs after it, so a web client
    // against a node running `requireApprovedClientE2EE` takes K2/P15.
    const entry = fixtureCase(F03, "admitted-pattern-set-ik-only-evaluated-as-web-latched");
    expect(entry.inputs.tier).toBe("web");
    expect(entry.inputs.advertisedAdmittedPatterns).toEqual(["IK"]);
    expect(entry.expected.row).toBe("K2");
    expect(entry.expected.fatal).toBe("P15");

    latchWebE2eeSelection(SELECTION);
    const channel = openChannel();
    expect(channel.attempt.selectionClass).toBe("latched");

    // §16.3 F3: this run "MUST be run with the channel's buffered sends
    // **non-empty**, asserting that none was flushed as plaintext".
    channel.facade.send(new TextEncoder().encode('{"buffered":1}'));
    channel.facade.send(new TextEncoder().encode('{"buffered":2}'));
    expect(outboundRelayPayloads(channel.socket)).toEqual([]);

    deliverRelayPayload(channel.socket, carrier(entry.name));
    await settleRelay();

    expect(channel.diagnostics).toEqual(["P15"]);
    const decoded = decodeNodeE2eeCapabilityStatement(fixtureStatement(entry.name));
    expect(decoded.kind).toBe("ok");
    if (decoded.kind !== "ok") return;
    expect(acceptedWebE2eePolicyGeneration(SELECTION)).toBe(decoded.value.policyGeneration);
    // Nothing at all left this client: no hello, and — the whole point — not one
    // of the two buffered application sends.
    expect(outboundRelayPayloads(channel.socket)).toEqual([]);
    expect(negotiationRecordTypes(channel.socket)).toEqual([]);
    expect(relayCloseReasons(channel.socket)).toEqual(["channel_rejected"]);
    expect(entry.expected.ticketSpentOnAHello).toBe(false);
  });

  it("takes K3 on the identical bytes while NOT latched — a rule-level case, not a web one", async () => {
    // §16.3 F3 labels this explicitly: it "pins the K3 branch of the same guard
    // for the first future tier whose latch is unset", and asserting it does not
    // claim a conforming version-1 web client can occupy this state. On this
    // tier §12.1 latches from the same statement's validation, so a real session
    // reaches the case above instead.
    const entry = fixtureCase(F03, "admitted-pattern-set-ik-only-evaluated-as-web-unlatched");
    expect(entry.expected.row).toBe("K3");
    expect(entry.expected.evidenceTreatment).toBe("absent-evidence");
    expect(String(entry.note)).toMatch(/RULE-LEVEL case, not a reachable web one/i);

    const channel = openChannel();
    expect(channel.attempt.selectionClass).toBe("legacy-eligible");

    deliverRelayPayload(channel.socket, carrier(entry.name));
    await settleRelay();

    expect(channel.diagnostics).toEqual(["K3"]);
    // Unusable evidence: no hello may be built on it, and the `T_ADV` rows still
    // decide the channel.
    expect(negotiationRecordTypes(channel.socket)).toEqual([]);
    expect(entry.expected.ticketSpentOnAHello).toBe(false);
    expect(relayCloseReasons(channel.socket)).toEqual([]);
  });

  it("takes K1 when element 14 admits NX", async () => {
    const entry = fixtureCase(F03, "admitted-pattern-set-ik-and-nx-evaluated-as-web");
    expect(entry.inputs.advertisedAdmittedPatterns).toEqual(["IK", "NX"]);
    expect(entry.expected.row).toBe("K1");

    const channel = openChannel();
    deliverRelayPayload(channel.socket, carrier(entry.name));
    await settleRelay();

    // The membership test passed, so the ticket IS spent on a hello here — which
    // is what makes the two cases above a check on element 14 rather than on the
    // set's length or its first entry.
    expect(negotiationRecordTypes(channel.socket)).toEqual([E2EE_NEGOTIATION_TYPE_CLIENT_HELLO]);
    expect(channel.diagnostics).toEqual([]);
    // §12.1: the statement validated, so the selection is latched from here on.
    expect(isWebE2eeSelectionLatched(SELECTION)).toBe(true);
  });
});

describe("§5.7 web policy-generation rollback", () => {
  it("rejects G-1 with the stable local diagnostic and no hello", async () => {
    const statement = fixtureStatement(USABLE_STATEMENT_CASE);
    const decoded = decodeNodeE2eeCapabilityStatement(statement);
    expect(decoded.kind).toBe("ok");
    if (decoded.kind !== "ok") return;
    latchWebE2eeSelection(SELECTION);
    recordWebE2eePolicyGeneration(SELECTION, decoded.value.policyGeneration + 1);

    const channel = openChannel();
    deliverRelayPayload(channel.socket, encodeE2eeCapabilityCarrier(statement));
    await settleRelay();

    expect(outboundRelayPayloads(channel.socket)).toEqual([]);
    expect(channel.diagnostics).toEqual(["P15"]);
    expect(webE2eeLocalDiagnostics()).toEqual(["e2ee_policy_generation_regressed"]);
    expect(acceptedWebE2eePolicyGeneration(SELECTION)).toBe(decoded.value.policyGeneration + 1);
  });
});

describe("§12.1.1 the degenerate web mapping, evaluated at channel.accept", () => {
  it("locks legacy at T_ADV before the first validated statement (K13) and closes after one (K14)", async () => {
    // §12.1: "Before the first validated statement of a session, and in every
    // fresh session, web has no downgrade resistance at all." The two halves of
    // that sentence are one session narrative, so they are one case.

    // (a) Fresh session, carrier withheld past `T_ADV`: row K13. The selection is
    // legacy-eligible, so the buffered send is flushed AS PLAINTEXT — the
    // explicitly retained downgrade exposure of §12.2, not a defect.
    const first = openChannel();
    expect(first.attempt.selectionClass).toBe("legacy-eligible");
    first.facade.send(new TextEncoder().encode('{"buffered":1}'));
    expect(outboundRelayPayloads(first.socket)).toEqual([]);
    await waitPastTAdv();
    const flushed = outboundRelayPayloads(first.socket);
    expect(flushed).toHaveLength(1);
    expect(new TextDecoder().decode(flushed[0]!)).toBe('{"buffered":1}');
    expect(relayCloseReasons(first.socket)).toEqual([]);

    // (b) The session's first validated statement, on its own channel.
    const second = openChannel();
    deliverRelayPayload(second.socket, carrier(USABLE_STATEMENT_CASE));
    await settleRelay();
    expect(isWebE2eeSelectionLatched(SELECTION)).toBe(true);

    // (c) The same withheld carrier, now against a latched selection: row K14 /
    // §11.2 P19. Nothing is flushed and the channel closes. The latch is the only
    // thing that changed between (a) and (c).
    const third = openChannel();
    expect(third.attempt.selectionClass).toBe("latched");
    third.facade.send(new TextEncoder().encode('{"buffered":2}'));
    await waitPastTAdv();
    expect(outboundRelayPayloads(third.socket)).toEqual([]);
    expect(third.diagnostics).toEqual(["P19"]);
    expect(relayCloseReasons(third.socket)).toEqual(["channel_rejected"]);
  });

  it("fixes the classification at channel.accept, so a later latch cannot change it", async () => {
    // §12.1.1: the guards "must be answerable at `channel.accept`, before any
    // payload arrives — otherwise a Hub that simply withholds or delays the
    // carrier past `T_ADV` makes every guard evaluate as 'not latched'". The
    // classification is therefore a VALUE on the attempt and not a callback the
    // machine could re-evaluate at row time.
    const channel = openChannel();
    expect(channel.attempt.selectionClass).toBe("legacy-eligible");

    // A latch set on the running session, after the accept, mid-negotiation.
    latchWebE2eeSelection(SELECTION);
    expect(isWebE2eeSelectionLatched(SELECTION)).toBe(true);
    expect(channel.attempt.selectionClass).toBe("legacy-eligible");

    channel.facade.send(new TextEncoder().encode('{"buffered":1}'));
    await waitPastTAdv();
    // Still row K13: this channel was classified before any payload, and the
    // late latch governs the NEXT one.
    expect(outboundRelayPayloads(channel.socket)).toHaveLength(1);
    expect(webRelayE2eeAttempt(SELECTION).selectionClass).toBe("latched");
  });

  it("writes no latch or generation byte to localStorage, sessionStorage, or indexedDB", async () => {
    // §12.1/§5.7's application-session state and §6.3's storage prohibition,
    // checked against the real browser APIs across a whole session rather than
    // against a comment.
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const removeItem = vi.spyOn(Storage.prototype, "removeItem");
    const clearStorage = vi.spyOn(Storage.prototype, "clear");
    const openDatabase = vi.spyOn(IDBFactory.prototype, "open");

    const channel = openChannel();
    deliverRelayPayload(channel.socket, carrier(USABLE_STATEMENT_CASE));
    await settleRelay();
    expect(isWebE2eeSelectionLatched(SELECTION)).toBe(true);
    expect(acceptedWebE2eePolicyGeneration(SELECTION)).toBeTypeOf("number");

    const second = openChannel();
    expect(second.attempt.selectionClass).toBe("latched");
    await waitPastTAdv();

    expect(setItem).not.toHaveBeenCalled();
    expect(removeItem).not.toHaveBeenCalled();
    expect(clearStorage).not.toHaveBeenCalled();
    expect(openDatabase).not.toHaveBeenCalled();
  });
});

/** One logged argument, flattened as far as it can be, for a string scan. */
function serializedForLeakScan(argument: unknown): string {
  if (typeof argument === "string") return argument;
  let serialized = "";
  try {
    serialized = JSON.stringify(argument) ?? "";
  } catch {
    // Cyclic or non-serializable; `String()` below is the whole scan for it.
  }
  return `${String(argument)} ${serialized}`;
}

/**
 * One complete NX session against the real §8.6 node half, to the `e2ee` lock.
 *
 * Shared by the two cases below because the second one — §13.5's storage and
 * logging prohibition — is only worth anything if the spies are installed while
 * the code is actually published, and that is the instant this function reaches.
 *
 * THE PRODUCTION SINK IS CALLED, NOT REPLACED. `webRelayE2eeAttempt` wires
 * `onWebVerificationCode` to `publishWebE2eeVerificationCode`, and a case that
 * substituted its own collector would run the handshake with the real publish
 * path switched off — so a write or a log added inside that function would be
 * unobserved by the very spies installed to catch it. The collector wraps the
 * production callback instead of standing in for it.
 *
 * `beginWebE2eeChannelAttempt` is what `resolveWebRelayE2eeProvider` does at
 * factory time, and it is done by hand here for the same reason
 * `webRelayE2eeAttempt` is exported: §12.1.1 reads `hubOrigin` off the document,
 * and the §16.3 fixture's origin is not the one this page is served from, so the
 * real provider cannot resolve a selection in this suite. Without it the §13.5
 * publish would hit the module's `unavailable` refusal and never land.
 */
async function completeNxSession() {
  const statement = fixtureStatement(USABLE_STATEMENT_CASE);
  const decoded = decodeNodeE2eeCapabilityStatement(statement);
  if (decoded.kind !== "ok") throw new Error("the committed statement no longer decodes");

  const codes: string[] = [];
  const attempt = webRelayE2eeAttempt(SELECTION);
  beginWebE2eeChannelAttempt();
  const harness = createRelayHarness({
    e2ee: (host: RelayE2eeHost) =>
      makeRelayE2eeInitiator({
        host,
        attempt: {
          ...attempt,
          onWebVerificationCode: (code) => {
            codes.push(code);
            attempt.onWebVerificationCode?.(code);
          },
        },
      }),
  });
  authenticateRelay(harness.socket);

  // A submission made while `negotiating` is buffered, never written in the
  // clear — and it is the byte that proves the flush went out ENCRYPTED.
  harness.facade.send(new TextEncoder().encode('{"buffered":1}'));
  expect(outboundRelayPayloads(harness.socket)).toEqual([]);

  deliverRelayPayload(harness.socket, encodeE2eeCapabilityCarrier(statement));
  await settleRelay();
  const hello = outboundRelayPayloads(harness.socket).at(-1);
  expect(hello).toBeDefined();

  const accept = respondAsNode(Uint8Array.from(hello!));
  if (accept.kind !== "accepted") throw new Error("the node half refused the hello");
  deliverRelayPayload(harness.socket, accept.record, 1);
  await settleRelay();

  return {
    harness,
    codes,
    accept,
    nodeIdentityPublicKey: decoded.value.identityPublicKey,
  };
}

describe("§8 the NX handshake completes in Chromium and yields §13.5's code", () => {
  it("locks e2ee, renders the WebSAS the node would show, and stops writing plaintext", async () => {
    // The one case that proves this tier is actually ON: a real NX handshake
    // against a real §8.6 node half, in the runtime that ships it.
    //
    // §13.5's claim is a COMPARISON — the browser shows the string, the node CLI
    // shows the string, the owner compares them out of band — so the assertion
    // is that the client's rendered code equals the one derived from the NODE's
    // view of the same ephemeral (`peerEphemeralPublicKey`, read off message 1).
    const { harness, codes, accept, nodeIdentityPublicKey } = await completeNxSession();

    // §13.5: once, and only at the `e2ee` lock.
    expect(codes).toHaveLength(1);
    expect(codes[0]).toBe(
      deriveE2eeWebSas({
        nodeIdentityPublicKey,
        webEphemeralPublicKey: accept.peerEphemeralPublicKey,
        sessionBindingHash: accept.sessionBindingHash,
      }).display,
    );
    // …and it reached the §13 projection, which is the only thing a surface can
    // read. The production `onWebVerificationCode` is the sink, so this is the
    // whole path from the Noise ephemeral to the value a UI would render.
    expect(webE2eeSessionState().verificationCode).toBe(codes[0]);

    // Everything after the hello is an envelope: the buffered submission was
    // flushed protected, and no plaintext RPC ever reached the relay.
    const afterHello = outboundRelayPayloads(harness.socket).slice(1);
    expect(afterHello.length).toBeGreaterThan(0);
    for (const payload of afterHello) {
      expect(classifyPostStripPayload(payload).kind).toBe("envelope");
    }
    expect(relayCloseReasons(harness.socket)).toEqual([]);
  });

  it("writes and logs nothing while §13.5's code is published", async () => {
    // §13.5: the `WebSAS` "is ephemeral display state: never logged, never
    // persisted, never sent to analytics". The latch case above installs the
    // same storage spies but never reaches the `e2ee` lock, so no code is ever
    // published while they are watching — a `sessionStorage.setItem` or a
    // `console.info` on the publish path was unobserved by every suite.
    //
    // The console sinks are spied ALONGSIDE storage because a display string
    // leaks through either, and §13.5 names both.
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const removeItem = vi.spyOn(Storage.prototype, "removeItem");
    const clearStorage = vi.spyOn(Storage.prototype, "clear");
    const openDatabase = vi.spyOn(IDBFactory.prototype, "open");
    const sinks = (["debug", "error", "info", "log", "trace", "warn"] as const).map((name) =>
      vi.spyOn(console, name).mockImplementation(() => undefined),
    );

    const { codes } = await completeNxSession();

    // The sweep is not vacuous: a code WAS published through the production sink
    // inside the spied window, and the projection is holding it.
    expect(codes).toHaveLength(1);
    const code = codes[0]!;
    expect(webE2eeSessionState().verificationCode).toBe(code);
    expect(setItem).not.toHaveBeenCalled();
    expect(removeItem).not.toHaveBeenCalled();
    expect(clearStorage).not.toHaveBeenCalled();
    expect(openDatabase).not.toHaveBeenCalled();
    for (const sink of sinks) {
      for (const call of sink.mock.calls) {
        // Every argument, SERIALIZED and not merely `String()`-ed: the code
        // reaching a sink nested in an object is the same disclosure as passing
        // it bare, and `String({ code })` is `[object Object]`.
        expect(call.map(serializedForLeakScan).join(" ")).not.toContain(code);
      }
    }
  });
});

describe("§16.4 F7 exact NX trace in Chromium", () => {
  it("reconstructs both handshake halves, every secret, implicit finish, and first records", async () => {
    const entry = fixtureCase(F07, "nx-handshake-complete-trace");
    const expected = entry.expected;
    const material = F07.testKeyMaterial;
    const channelMaterial = material.channel as Readonly<Record<string, unknown>>;
    const now = entry.inputs.now as number;
    const channel = {
      hubOrigin: entry.inputs.hubOrigin as string,
      channelId: entry.inputs.channelId as string,
      relayProtocolMajor: channelMaterial.relayProtocolMajor as number,
      relayProtocolMinor: channelMaterial.relayProtocolMinor as number,
      channelOpenCapability: channelMaterial.channelOpenCapability as string,
      channelOpenEffectiveRole: channelMaterial.channelOpenEffectiveRole as string,
    } as const;
    const advertised = {
      nodeId: entry.inputs.nodeId as string,
      nodeIdentityFingerprint: fixtureBytes(material.nodeIdentityFingerprint),
      prekeyId: entry.inputs.prekeyId as string,
      agreementPublicKey: fixtureBytes(material.nodeAgreementPublicKey),
      continuityChainTranscripts: [],
      continuityId: entry.inputs.continuityId as string,
    } as const;

    const client = new E2eeClientHandshake({
      channel,
      advertised,
      selectedSuite: 1,
      offeredSuites: entry.inputs.offeredSuites as readonly number[],
      credentials: { tier: "web" },
      intendedCapability: channel.channelOpenCapability,
      intendedRole: channel.channelOpenEffectiveRole,
      testOnlyClientNonce: fixtureBytes(material.testOnlyClientNonce),
      testOnlyEphemeralSecretKey: fixtureBytes(material.testOnlyClientEphemeralSecretKey),
    });
    const hello = client.createHello(now);
    expect(hello.kind).toBe("hello");
    if (hello.kind !== "hello") return;

    expect(hexOf(hello.contextBlock)).toBe(hexOf(fixtureBytes(expected.contextBlock)));
    expect(hello.contextBlock.byteLength).toBe(expected.contextBlockBytes);
    expect(hexOf(hello.contextCommitment)).toBe(hexOf(fixtureBytes(expected.contextCommitment)));
    expect(hexOf(hello.prologue)).toBe(hexOf(fixtureBytes(expected.prologue)));
    expect(hexOf(hello.record)).toBe(hexOf(fixtureBytes(expected.clientHello)));
    expect(hello.record.byteLength).toBe(expected.clientHelloBytes);
    const decodedHello = decodeE2eeClientHello(hello.record);
    expect(decodedHello.kind).toBe("ok");
    if (decodedHello.kind !== "ok") return;
    expect(hexOf(decodedHello.value.noiseMessage1)).toBe(
      hexOf(fixtureBytes(expected.noiseMessage1)),
    );
    expect(fixtureBytes(expected.message1PayloadPlaintext)).toHaveLength(0);
    expect(expected.message1PayloadPlaintextBytes).toBe(0);
    expect(expected.message1PayloadIsEmpty).toBe(true);

    const node = new E2eeNodeHandshake({
      channel,
      advertised,
      advertisedVersionMin: 1,
      advertisedVersionMax: 1,
      agreementSecretKey: fixtureBytes(material.testOnlyNodeAgreementSecretKey),
      advertisementEmittedAt: now,
      readPolicy: () => ({ requireApprovedClientE2EE: false, suiteRegistry: [1] }),
      testOnlyEphemeralSecretKey: fixtureBytes(material.testOnlyNodeEphemeralSecretKey),
    });
    const accepted = node.receiveHello(hello.record, now);
    expect(accepted.kind).toBe("accepted");
    if (accepted.kind !== "accepted") return;
    expect(accepted.tier).toBe("web");
    expect(accepted.trustSource).toBe("web-unsigned");
    expect(accepted.admittedAuthority).toBeUndefined();
    expect(expected.admittedAuthority).toBeNull();
    expect(hexOf(accepted.contextBlock)).toBe(hexOf(fixtureBytes(expected.contextBlock)));
    expect(hexOf(accepted.contextCommitment)).toBe(hexOf(fixtureBytes(expected.contextCommitment)));
    expect(hexOf(accepted.serverAcceptTbs)).toBe(hexOf(fixtureBytes(expected.serverAcceptTbs)));
    expect(hexOf(accepted.confirmationTranscript)).toBe(
      hexOf(fixtureBytes(expected.confirmationTranscript)),
    );
    expect(hexOf(accepted.record)).toBe(hexOf(fixtureBytes(expected.serverAccept)));
    expect(accepted.record.byteLength).toBe(expected.serverAcceptBytes);

    const decodedAccept = decodeE2eeServerAccept(accepted.record);
    expect(decodedAccept.kind).toBe("ok");
    if (decodedAccept.kind !== "ok") return;
    expect(hexOf(decodedAccept.value.noiseMessage2)).toBe(
      hexOf(fixtureBytes(expected.noiseMessage2)),
    );
    expect(hexOf(decodedAccept.value.serverConfirmation)).toBe(
      hexOf(fixtureBytes(expected.serverConfirmation)),
    );

    const established = client.receiveServerAccept(accepted.record, now);
    expect(established.kind).toBe("established");
    if (established.kind !== "established") return;
    expect(established.trustSource).toBe("web-unsigned");
    expect(hexOf(established.sessionBindingHash)).toBe(
      hexOf(fixtureBytes(expected.sessionBindingHash)),
    );
    expect(hexOf(established.secrets.epochSecretC2N)).toBe(
      hexOf(fixtureBytes(expected.epochSecretC2N)),
    );
    expect(hexOf(established.secrets.epochSecretN2C)).toBe(
      hexOf(fixtureBytes(expected.epochSecretN2C)),
    );
    expect(hexOf(established.secrets.exporterSecret)).toBe(
      hexOf(fixtureBytes(expected.exporterSecret)),
    );
    expect(hexOf(established.secrets.serverConfirmationKey)).toBe(
      hexOf(fixtureBytes(expected.serverConfirmationKey)),
    );
    expect(
      hexOf(deriveE2eeAeadKey(established.secrets.epochSecretC2N, E2EE_DIRECTION_CLIENT_TO_NODE)),
    ).toBe(hexOf(fixtureBytes(expected.aeadKeyC2NEpoch0)));
    expect(
      hexOf(deriveE2eeAeadKey(established.secrets.epochSecretN2C, E2EE_DIRECTION_NODE_TO_CLIENT)),
    ).toBe(hexOf(fixtureBytes(expected.aeadKeyN2CEpoch0)));
    expect(expected.bothEndpointsDerivedIdenticalSecrets).toBe(
      hexOf(accepted.secrets.epochSecretC2N) === hexOf(established.secrets.epochSecretC2N) &&
        hexOf(accepted.secrets.epochSecretN2C) === hexOf(established.secrets.epochSecretN2C) &&
        hexOf(accepted.secrets.exporterSecret) === hexOf(established.secrets.exporterSecret),
    );

    const clientRecords = new E2eeRecordSession({
      secrets: established.secrets,
      suite: 1,
      sessionBindingHash: established.sessionBindingHash,
      sendDirection: E2EE_DIRECTION_CLIENT_TO_NODE,
      plaintextCeiling: 1_024,
    });
    const nodeRecords = new E2eeRecordSession({
      secrets: accepted.secrets,
      suite: 1,
      sessionBindingHash: accepted.sessionBindingHash,
      sendDirection: E2EE_DIRECTION_NODE_TO_CLIENT,
      plaintextCeiling: 1_024,
    });
    try {
      const envelopes = expected.firstProtectedEnvelopes as Readonly<Record<string, unknown>>;
      const c2n = envelopes.clientToNode as Readonly<Record<string, unknown>>;
      expect(node.mayInvokeRpcHandler).toBe(false);
      expect(node.mayEmitApplicationRpc).toBe(false);
      const protectedPing = await protectOneRecord(clientRecords, {
        innerType: E2EE_INNER_TYPE_RPC,
        body: fixtureBytes(c2n.innerBody),
      });
      expect(protectedPing.result.kind).toBe("protected");
      expect(hexOf(protectedPing.envelope!)).toBe(hexOf(fixtureBytes(c2n.envelope)));
      const openedPing = nodeRecords.unprotect(protectedPing.envelope!);
      expect(openedPing.kind).toBe("authenticated");
      if (openedPing.kind !== "authenticated") return;
      expect(openedPing.body.byteLength).toBe(
        (c2n.receivedByNode as Readonly<Record<string, unknown>>).bodyBytes,
      );
      expect(node.authenticateImplicitFinish({ now })).toEqual({ kind: "finished" });
      expect(node.mayInvokeRpcHandler).toBe(true);
      expect(node.mayEmitApplicationRpc).toBe(true);
      const implicit = envelopes.implicitFinish as Readonly<Record<string, unknown>>;
      expect(implicit.deadlineAt).toBe(accepted.implicitFinishDeadlineAt);

      const n2c = envelopes.nodeToClient as Readonly<Record<string, unknown>>;
      const protectedPong = await protectOneRecord(nodeRecords, {
        innerType: E2EE_INNER_TYPE_RPC,
        body: fixtureBytes(n2c.innerBody),
      });
      expect(protectedPong.result.kind).toBe("protected");
      expect(hexOf(protectedPong.envelope!)).toBe(hexOf(fixtureBytes(n2c.envelope)));
      const openedPong = clientRecords.unprotect(protectedPong.envelope!);
      expect(openedPong.kind).toBe("authenticated");
      if (openedPong.kind !== "authenticated") return;
      expect(openedPong.body.byteLength).toBe(
        (n2c.receivedByClient as Readonly<Record<string, unknown>>).bodyBytes,
      );
    } finally {
      clientRecords.erase();
      nodeRecords.erase();
    }
  });
});

describe("§16.3 F14 — the WebSAS derived in Chromium matches the committed corpus", () => {
  it("reproduces every WebSAS intermediate and rendering byte for byte", () => {
    // §16.4: "A vector that produces different bytes on any supported runtime is
    // a release-blocking defect." The Node gate already runs these; this is the
    // browser half, and it is the runtime that actually draws the string.
    for (const entry of fixtureCasesMatching(F14, /^web-sas-session-/, 2)) {
      const derived = deriveE2eeWebSas({
        nodeIdentityPublicKey: fixtureBytes(entry.inputs.nodeIdentityPublicKey),
        webEphemeralPublicKey: fixtureBytes(entry.inputs.webEphemeralPublicKey),
        sessionBindingHash: fixtureBytes(entry.inputs.sessionBindingHash),
      });
      expect(hexOf(derived.input), entry.name).toBe(hexOf(fixtureBytes(entry.expected.inputArray)));
      expect(hexOf(derived.prk), entry.name).toBe(hexOf(fixtureBytes(entry.expected.prk)));
      expect(hexOf(derived.output), entry.name).toBe(
        hexOf(fixtureBytes(entry.expected.hkdfOutput)),
      );
      expect(derived.display, entry.name).toBe(entry.expected.display);

      // §3.2.1 S11: the displayed entropy is what the owner actually compares.
      expect(entry.expected.satisfiesS11, entry.name).toBe(true);
      expect(entry.expected.displayedEntropyBits as number, entry.name).toBeGreaterThanOrEqual(
        entry.expected.minimumDisplayedEntropyBits as number,
      );
      expect(E2EE_WEB_SAS_HKDF_BYTES * 8).toBeGreaterThanOrEqual(E2EE_WEB_SAS_MIN_DISPLAYED_BITS);
    }
  });

  it("changes with the session binding, which is why it is per session", () => {
    // Pinned rather than filtered: `new Set(displays).size === displays.length`
    // is TRUE of the empty set and of a single case, so an unpinned filter here
    // would report distinctness over a corpus it had stopped reading.
    const displays = fixtureCasesMatching(F14, /^web-sas-session-/, 2).map(
      (entry) => entry.expected.display,
    );
    expect(new Set(displays).size).toBe(displays.length);
    expect(fixtureCase(F14, "web-sas-changes-every-session").expected.differs).toBe(true);
  });
});
