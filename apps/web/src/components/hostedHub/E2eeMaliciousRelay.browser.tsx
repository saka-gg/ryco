import type { RelayE2eeHost } from "@ryco/client-runtime/relay";
import { makeRelayE2eeInitiator } from "@ryco/client-runtime/relay/e2ee";
import { E2EE_ENVELOPE_DISCRIMINATOR, T_ADV, T_HANDSHAKE } from "@ryco/shared/relayE2eeConstants";
import { decodeE2eeClientHello, encodeE2eeClientHello } from "@ryco/shared/relayE2eeHandshake";
import { encodeE2eeCapabilityCarrier, type E2eeSuiteId } from "@ryco/shared/relayE2eeWire";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  authenticateRelay,
  createRelayHarness,
  deliverRelayPayload,
  fixtureBytes,
  fixtureCase,
  fixtureStatement,
  FIXTURE_ACCOUNT_ID,
  FIXTURE_HUB_ORIGIN,
  FIXTURE_NODE_ID,
  FIXTURE_NOW,
  F07,
  USABLE_STATEMENT_CASE,
  outboundRelayPayloads,
  relayCloseReasons,
  respondAsNode,
  settleRelay,
} from "../../../test/maliciousRelay";
import { webRelayE2eeAttempt } from "../../hostedHub/e2eeAttempt";
import { clearWebE2eeLatches, latchWebE2eeSelection } from "../../hostedHub/e2eeLatch";

// THE HOSTILE RELAY, in Chromium — docs/relay-e2ee-protocol.md §4.4's client
// rows driven by a peer that is trying to make this client release plaintext.
//
// The whole file is written from the Hub's side of the seam: every case is a
// thing a Hub can do to a conforming client without breaking any relay rule —
// withhold the advertisement, deliver plaintext at the wrong moment, stall,
// forge, or substitute the node's own static key. The client's answer is
// asserted as BYTES ON THE SOCKET, because §4.4's send-buffering rule is a
// statement about the relay and an assertion about an internal queue would pass
// on an implementation that emptied it onto the wire.
//
// AND IT IS STILL NOT A CLAIM AGAINST THE HUB. §2.4: the Hub serves the
// JavaScript that runs every one of these checks. What the cases below pin is
// that the SHIPPED code fails closed — which is worth having against wrong-node
// routing and non-Hub interposition, and is worth nothing against a Hub that
// simply ships different code (§2.2, §2.3, §12.1's web threat scope).

const SELECTION = {
  hubOrigin: FIXTURE_HUB_ORIGIN,
  accountId: FIXTURE_ACCOUNT_ID,
  nodeId: FIXTURE_NODE_ID,
} as const;

const LEGACY_RPC = new TextEncoder().encode('{"_tag":"Request","id":1}');

beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(FIXTURE_NOW);
  clearWebE2eeLatches();
});

afterEach(() => {
  clearWebE2eeLatches();
  vi.restoreAllMocks();
});

function openChannel() {
  const attempt = webRelayE2eeAttempt(SELECTION);
  const diagnostics: string[] = [];
  const harness = createRelayHarness({
    e2ee: (host: RelayE2eeHost) =>
      makeRelayE2eeInitiator({
        host,
        attempt: { ...attempt, onDiagnostic: (entry) => void diagnostics.push(entry.row) },
      }),
  });
  authenticateRelay(harness.socket);
  return { ...harness, attempt, diagnostics };
}

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => globalThis.setTimeout(resolve, ms));

/** Drive rows K1 and the node's §8.6 response, and hand back both halves. */
async function reachServerAccept(options: { readonly agreementSecretKey?: Uint8Array } = {}) {
  const channel = openChannel();
  deliverRelayPayload(
    channel.socket,
    encodeE2eeCapabilityCarrier(fixtureStatement(USABLE_STATEMENT_CASE)),
  );
  await settleRelay();
  const hello = outboundRelayPayloads(channel.socket).at(-1);
  if (hello === undefined) throw new Error("the client emitted no hello");
  const accept = respondAsNode(Uint8Array.from(hello), options);
  return { channel, hello: Uint8Array.from(hello), accept };
}

describe("a Hub that withholds the advertisement", () => {
  it("cannot make a latched selection flush anything at T_ADV", async () => {
    // §12.1.1: "otherwise a Hub that simply withholds or delays the carrier past
    // `T_ADV` makes every guard evaluate as 'not latched' and every conforming
    // client flushes plaintext." Row K14 / §11.2 P19 is the answer.
    latchWebE2eeSelection(SELECTION);
    const channel = openChannel();
    channel.facade.send(LEGACY_RPC);
    await wait(T_ADV + 250);

    expect(outboundRelayPayloads(channel.socket)).toEqual([]);
    expect(channel.diagnostics).toEqual(["P19"]);
    expect(relayCloseReasons(channel.socket)).toEqual(["channel_rejected"]);
  });
});

describe("a Hub that injects plaintext at the wrong moment", () => {
  it("takes P18 on non-carrier legacy JSON after a hello has been sent", async () => {
    // Row K10 / §11.2 P18. §4.4: a client that let one plaintext frame escape
    // after its own hello would be answering "a silent legacy lock of a channel
    // that was about to go E2EE" — the downgrade a Hub can otherwise just ask
    // for. The guard here is `helloSent`, not the latch.
    const { channel } = await reachServerAccept();
    const beforeInjection = outboundRelayPayloads(channel.socket).length;

    deliverRelayPayload(channel.socket, LEGACY_RPC, 1);
    await settleRelay();

    expect(channel.diagnostics).toEqual(["P18"]);
    expect(outboundRelayPayloads(channel.socket)).toHaveLength(beforeInjection);
    expect(relayCloseReasons(channel.socket)).toEqual(["channel_rejected"]);
    // Nothing was delivered to the application: a P18 channel parses no RPC, so
    // the injected message reaches the transport as a failure and never as data.
    expect(channel.handlers.onFailure).toHaveBeenCalled();
  });

  it("takes P5 on an envelope delivered before establishment", async () => {
    // Row K11 / §11.2 P5. No session keys exist yet, so the disposition is
    // FATAL-PRE and the envelope is never handed to a record layer that could
    // try to authenticate it.
    const channel = openChannel();
    const envelope = new Uint8Array(64);
    envelope[0] = E2EE_ENVELOPE_DISCRIMINATOR;
    deliverRelayPayload(channel.socket, envelope);
    await settleRelay();

    expect(channel.diagnostics).toEqual(["P5"]);
    expect(outboundRelayPayloads(channel.socket)).toEqual([]);
    expect(relayCloseReasons(channel.socket)).toEqual(["channel_rejected"]);
  });

  it("takes P6 on a payload with an unknown first byte", async () => {
    // Row K12 / §11.2 P6. §3.4 enumerates this rather than leaving it to a
    // catch-all precisely so no implementation treats it as a benign no-op.
    const channel = openChannel();
    deliverRelayPayload(channel.socket, Uint8Array.from([0xff, 0x00, 0x01]));
    await settleRelay();

    expect(channel.diagnostics).toEqual(["P6"]);
    expect(relayCloseReasons(channel.socket)).toEqual(["channel_rejected"]);
  });
});

describe("a Hub that stalls, forges, or substitutes the accept", () => {
  it("never falls back to legacy when the accept simply never arrives", async () => {
    // Row K15 / §11.2 P20. §4.4 admits NO legacy fallback after a hello: a Hub
    // that swallowed the accept would otherwise get a plaintext channel by doing
    // nothing at all.
    const { channel } = await reachServerAccept();
    channel.facade.send(LEGACY_RPC);
    const afterHello = outboundRelayPayloads(channel.socket).length;

    await wait(T_HANDSHAKE + 250);

    expect(channel.diagnostics).toEqual(["P20"]);
    expect(outboundRelayPayloads(channel.socket)).toHaveLength(afterHello);
    expect(relayCloseReasons(channel.socket)).toEqual(["channel_rejected"]);
  });

  it("refuses a forged accept and emits no record of its own", async () => {
    // Row K6 / §11.2 P16, and §11.2's "a client executing FATAL-PRE sends
    // nothing and closes" — the client has no reject record to emit, so a
    // forgery costs the attacker one channel and yields no oracle (§11.5).
    const { channel, accept } = await reachServerAccept();
    expect(accept.kind).toBe("accepted");
    if (accept.kind !== "accepted") return;

    const forged = Uint8Array.from(accept.record);
    // The last byte of the §8.7 `serverConfirmation`, flipped: a sound record in
    // every other respect, which is what makes this a check on the confirmation
    // rather than on the decoder.
    forged.set([(forged.at(-1)! ^ 0x01) & 0xff], forged.length - 1);
    const beforeInjection = outboundRelayPayloads(channel.socket).length;
    deliverRelayPayload(channel.socket, forged, 1);
    await settleRelay();

    expect(channel.diagnostics).toEqual(["P16"]);
    expect(outboundRelayPayloads(channel.socket)).toHaveLength(beforeInjection);
    expect(relayCloseReasons(channel.socket)).toEqual(["channel_rejected"]);
  });

  it("refuses a sound accept whose Noise static is not the advertised prekey", async () => {
    // §16.3 F7's responder-static case, run live rather than replayed: "The
    // node's context, accept payload, and confirmation are all built from the
    // ADVERTISED prekey, so every other check passes; only the Noise static the
    // client learns from message 2 differs."
    const entry = fixtureCase(F07, "nx-responder-static-must-equal-the-advertised-prekey");
    expect(entry.expected.row).toBe("P16");
    expect(entry.expected.clientEmitsNoRecord).toBe(true);

    const { channel, accept } = await reachServerAccept({
      agreementSecretKey: fixtureBytes(entry.inputs.testOnlySubstitutedAgreementSecretKey),
    });
    expect(accept.kind).toBe("accepted");
    if (accept.kind !== "accepted") return;

    const beforeInjection = outboundRelayPayloads(channel.socket).length;
    deliverRelayPayload(channel.socket, accept.record, 1);
    await settleRelay();

    expect(channel.diagnostics).toEqual(["P16"]);
    expect(outboundRelayPayloads(channel.socket)).toHaveLength(beforeInjection);
    expect(relayCloseReasons(channel.socket)).toEqual(["channel_rejected"]);
  });
});

describe("§16.3 F7 — the node half refuses a nonempty NX message-1 payload", () => {
  it("rejects a hello whose Noise message 1 carries a payload", async () => {
    // §8.5: the NX message-1 payload MUST be zero-length, and §8.10 is why it is
    // a rule rather than a convention — message 1 of NX is unencrypted and
    // unauthenticated, so anything smuggled into it is in the clear.
    //
    // The client this suite drives never produces one, so the case is built by
    // taking its REAL hello and extending the Noise message, which is exactly
    // the shape a modified client would emit.
    const entry = fixtureCase(F07, "nx-message-1-payload-must-be-empty");
    expect(entry.expected.row).toBe("P10");
    expect(entry.expected.reason).toBe("nx_payload_not_empty");

    const { hello } = await reachServerAccept();
    const decoded = decodeE2eeClientHello(hello);
    expect(decoded.kind).toBe("ok");
    if (decoded.kind !== "ok") return;
    expect(decoded.value.tier).toBe("web");

    const smuggled = fixtureBytes(entry.inputs.message1PayloadPlaintext);
    const message1 = new Uint8Array(decoded.value.noiseMessage1.byteLength + smuggled.byteLength);
    message1.set(decoded.value.noiseMessage1);
    message1.set(smuggled, decoded.value.noiseMessage1.byteLength);

    const tampered = encodeE2eeClientHello({
      tier: decoded.value.tier,
      selectedSuite: decoded.value.selectedSuite as E2eeSuiteId,
      offeredSuites: decoded.value.offeredSuites,
      clientNonce: decoded.value.clientNonce,
      contextCommitment: decoded.value.contextCommitment,
      noiseMessage1: message1,
    });

    const refused = respondAsNode(tampered);
    expect(refused.kind).toBe("fatal");
    if (refused.kind !== "fatal") return;
    expect(refused.reason).toBe("nx_payload_not_empty");
    expect(refused.row).toBe("P10");
  });
});
