import { describe, expect, it } from "vite-plus/test";

import { RELAY_INITIAL_LIMITS, type RelayLimits } from "@ryco/contracts/relay";
import { verifyNodeE2eeCapabilityStatement } from "@ryco/shared/relayE2eeCapabilityVerify";
import {
  E2EE_ENVELOPE_OVERHEAD_BYTES,
  e2eeChannelSizeBudget,
} from "@ryco/shared/relayE2eeConstants";
import { E2eeClientHandshake } from "@ryco/shared/relayE2eeHandshake";
import { deriveE2eeAgreementPublicKey, e2eeKeyFingerprint } from "@ryco/shared/relayE2eeKeys";
import {
  E2EE_NOISE_PATTERN_IK,
  E2EE_NOISE_PATTERN_NX,
  decodeCanonicalE2eeCbor,
  encodeCanonicalE2eeCbor,
} from "@ryco/shared/relayE2eeTranscripts";
import {
  deriveE2eeSafetyNumber,
  deriveE2eeWebSas,
} from "@ryco/shared/relayE2eeVerificationDisplay";
import {
  E2EE_INNER_TYPE_RPC,
  E2EE_NEGOTIATION_TYPE_CLIENT_HELLO,
  E2EE_SUITE_25519_CHACHAPOLY_SHA256,
  classifyPostStripPayload,
  decodeE2eeNegotiationRecord,
  encodeE2eeNegotiationRecord,
} from "@ryco/shared/relayE2eeWire";
import { prepareRelayMessage } from "@ryco/shared/relayMessageChunks";

import { nodeE2eeChannelPlaintextCeiling } from "./NodeE2eeRelayChannel.ts";
import {
  CAPABILITY,
  CLIENT_IDENTITY_PUBLIC,
  HUB_ORIGIN,
  NOW,
  ROLE,
  authorizationFor,
  clientChannel,
  clientReceive,
  clientSend,
  establish,
  harness,
  nativeCredentials,
  stripPrelude,
  utf8,
} from "./testUtils/nodeE2eeChannelHarness.ts";

// THE ENDPOINT INTEROPERABILITY MATRIX — docs/relay-e2ee-protocol.md §8, §4.5, §5.2.
//
// WHAT THIS IS AND WHAT IT IS NOT. Every cell below drives a REAL ENDPOINT PAIR:
// a real `NodeE2eeChannelSession` behind a real `RelayChannelRegistry` and a
// real `RelaySendQueue`, against Phase 1's real client handshake and record
// session, with every payload crossing as a relay `data` frame through the real
// chunk assembler. Nothing here calls a module function and calls it interop.
//
// IT IS A SAME-RUNTIME MATRIX AND THAT IS ITS BIGGEST LIMIT. Both endpoints run
// in ONE Node process, on one build of `packages/shared`, under one set of
// primitives. It therefore proves the two ENDPOINT IMPLEMENTATIONS agree; it
// proves nothing about two RUNTIMES agreeing. Specifically NOT covered here, and
// §16.4 is the obligation that covers them:
//
//   • no browser runtime participates — the web tier's cells run the web tier's
//     CODE PATH (NX, no client identity, no §8.3 account scope) on Node, not in
//     a browser, so nothing here would catch a `SubtleCrypto` or a
//     `TextEncoder` difference;
//   • no device runtime participates — Hermes and the React Native adapters of
//     §14.5 are absent, so a native-tier cell is the native tier's code path on
//     Node;
//   • no second IMPLEMENTATION participates — this is one codebase talking to
//     itself. The independent-implementation check is the §16.3 F15 Noise
//     vectors transcoded from cacophony and snow, which is a different
//     obligation and lives in `packages/shared`;
//   • no wire-level adversary participates — tampering, reordering, replay and
//     truncation are the attacker-relay suite's subject
//     (`relayE2eeAttackerRelay.test.ts`), not this file's. Every relay here is
//     honest, because the question here is "do the two ends agree when nothing
//     goes wrong", and a matrix that also modelled an attacker would answer
//     neither question clearly.
//
// THE AXES ARE THE ONES THAT ACTUALLY VARY between two conforming endpoints:
//
//   1. THE NOISE PATTERN, which is not a free choice — §8.1 ties it to the tier.
//      The native tier runs `Noise_IK_25519_ChaChaPoly_SHA256` and carries a
//      §7.4 client certificate inside the encrypted hello; the web tier runs
//      `Noise_NX_25519_ChaChaPoly_SHA256` and carries no client identity at all.
//   2. THE TIER'S CLIENT against the one node responder, which is the same axis
//      seen from the other side: the two tiers reach DIFFERENT §8.3 authorization
//      contexts and different §13 verification displays, and both must establish
//      the same §8.8 session binding hash as the node.
//   3. THE SUITE REGISTRY, driven through the real §5.2 verifier over the real
//      statement this node advertised — including the negative direction, a
//      client whose local preference shares no suite with the registry.
//   4. THE NEGOTIATED LIMITS, which move the §4.5 plaintext ceiling. The relay's
//      asserted `maxDataChunkBytes`/`maxRpcMessageBytes` are per-connection, so
//      two endpoints on one channel must compute the SAME ceiling from them or
//      one of them will emit a record the other's chunk layer refuses.

/**
 * The §4.5 axis: one default connection and one deliberately narrowed one.
 *
 * `maxQueuedBytes` is what MOVES the ceiling — §4.5 derives it from
 * `maxQueuedBytes − maxControlFrameBytes` against `RELAY_MAX_RPC_MESSAGE_BYTES` —
 * and `maxDataChunkBytes` decides how many chunks a ceiling-sized record is cut
 * into. The narrowed cell moves both, so the cell exercises a different ceiling
 * AND a genuinely chunked record rather than one or the other.
 */
const LIMIT_CELLS: readonly { readonly label: string; readonly limits: RelayLimits }[] = [
  { label: "relay defaults", limits: RELAY_INITIAL_LIMITS },
  {
    label: "narrowed queue and chunk limits",
    limits: {
      ...RELAY_INITIAL_LIMITS,
      // Above `E2EE_ADVERTISEMENT_MIN_CHUNK_BYTES` (8,192), so the node can still
      // put its §5.3 carrier on the channel and §5.5 U1 does not fire.
      maxDataChunkBytes: 16_384,
      maxQueuedBytes: 327_680,
    },
  },
];

/**
 * Protect one record and split it exactly as a real sender would.
 *
 * The split goes through `prepareRelayMessage` under the CHANNEL's asserted
 * limits — not through a local loop — because the property under test is that
 * the sender's chunking and the receiver's reassembly agree on one connection's
 * limits, and a second copy of the split rule here would test this file instead.
 */
async function protectAndSplit(
  client: Awaited<ReturnType<typeof establish>>,
  body: Uint8Array,
  limits: RelayLimits,
): Promise<readonly Uint8Array[]> {
  let envelope: Uint8Array | undefined;
  const result = await client.record.protect({
    innerType: E2EE_INNER_TYPE_RPC,
    body,
    admit: () => true,
    transmit: (bytes) => {
      envelope = Uint8Array.from(bytes);
      return { kind: "sent" };
    },
  });
  expect(result.kind).toBe("protected");
  if (envelope === undefined) throw new Error("no envelope was transmitted");
  const prepared = prepareRelayMessage(envelope, {
    maxChunkBytes: limits.maxDataChunkBytes,
    maxMessageBytes: limits.maxQueuedBytes,
    peerSupportsChunking: true,
  });
  expect(prepared.kind).toBe("ready");
  if (prepared.kind !== "ready") throw new Error("message did not prepare");
  return prepared.payloads;
}

/** The §8.1 axis: the tier fixes the pattern, so one label names both. */
const TIER_CELLS = [
  { tier: "native" as const, pattern: E2EE_NOISE_PATTERN_IK },
  { tier: "web" as const, pattern: E2EE_NOISE_PATTERN_NX },
];

describe("§16 endpoint interoperability matrix (same runtime)", () => {
  for (const cell of TIER_CELLS) {
    for (const limitCell of LIMIT_CELLS) {
      it(`establishes and carries traffic: ${cell.tier} client (${cell.pattern}) · ${limitCell.label}`, async () => {
        const node = await harness({
          // The web tier has no client identity to authorize (§8.3), so its
          // Branch A record is absent; the native tier keeps the harness's
          // approved record. Passing the wrong one is what makes the two cells
          // different rather than the same test run twice — a native cell run
          // against an absent record never reaches `e2ee` at all.
          ...(cell.tier === "web" ? { authorization: authorizationFor(undefined) } : {}),
          maxDataChunkBytes: limitCell.limits.maxDataChunkBytes,
          maxQueuedBytes: limitCell.limits.maxQueuedBytes,
        });
        const advertisement = await node.open();
        // §4.5 makes `e2eeChannelSizeBudget` the ONE derivation of the ceiling,
        // so the client is given the ceiling this channel's own asserted limits
        // produce rather than a constant. That is the interop claim: both ends
        // compute the same number from the same limits.
        const budget = e2eeChannelSizeBudget(limitCell.limits);
        expect(budget.establishable).toBe(true);
        const client = await establish(
          node,
          cell.tier,
          advertisement,
          undefined,
          undefined,
          budget.plaintextCeiling,
        );
        expect(node.session().mode()).toBe("e2ee");

        // ── the §8.8 binding both ends must agree on ────────────────────────
        //
        // Nothing else in this file means anything if this fails: the binding
        // hash is what every AAD and every §13 display is derived from, so two
        // ends that disagree here would still "work" until the first record.
        expect(client.sessionBindingHash.byteLength).toBe(32);

        // ── traffic in both directions, across the real chunk layer ─────────
        const before = node.deliveredToParser.length;
        await clientSend(node, client, E2EE_INNER_TYPE_RPC, utf8('{"_tag":"Ping"}'));
        expect(node.deliveredToParser).toHaveLength(before + 1);
        expect(new TextDecoder().decode(node.deliveredToParser[before]!)).toBe('{"_tag":"Ping"}');

        const sentBefore = node.dataPayloads().length;
        expect(await node.session().emit(utf8('{"_tag":"Pong"}'))).toBe("sent");
        node.flush();
        const emitted = node.dataPayloads().slice(sentBefore);
        expect(emitted).toHaveLength(1);
        expect(classifyPostStripPayload(stripPrelude(emitted[0]!)).kind).toBe("envelope");
        const authenticated = clientReceive(client, emitted[0]!);
        expect(authenticated.innerType).toBe(E2EE_INNER_TYPE_RPC);
        expect(new TextDecoder().decode(authenticated.body)).toBe('{"_tag":"Pong"}');

        // ── the §4.5 ceiling, computed independently on each side ───────────
        //
        // §4.5 makes `e2eeChannelSizeBudget` the single derivation, and this is
        // the cell where a second copy of the arithmetic would show: the node's
        // ceiling is read off the connector, the budget is recomputed here from
        // the SAME asserted limits, and the two must agree exactly.
        expect(nodeE2eeChannelPlaintextCeiling(limitCell.limits)).toBe(budget.plaintextCeiling);
        expect(budget.plaintextCeiling).toBe(
          budget.effectiveMessageCeiling - E2EE_ENVELOPE_OVERHEAD_BYTES,
        );

        // …and a record AT the ceiling really crosses, which is the part a
        // number alone does not establish. The envelope is far past one data
        // frame in both cells, so this is the CHUNKED path end to end: the
        // client splits with the same `prepareRelayMessage` a real sender uses
        // and the node reassembles with the same `RelayMessageAssembler`.
        const atCeiling = new Uint8Array(budget.plaintextCeiling).fill(0x41);
        const parserBefore = node.deliveredToParser.length;
        const chunks = await protectAndSplit(client, atCeiling, limitCell.limits);
        expect(chunks.length).toBeGreaterThan(1);
        for (const chunk of chunks) await node.deliver(chunk);
        expect(node.deliveredToParser).toHaveLength(parserBefore + 1);
        expect(node.deliveredToParser[parserBefore]!.byteLength).toBe(budget.plaintextCeiling);

        // …and one byte past the ceiling is refused BY THE SENDER, which is what
        // makes the two ends' agreement load-bearing rather than incidental: the
        // client never emits a record the node's chunk layer would drop.
        const overCeiling = await client.record.protect({
          innerType: E2EE_INNER_TYPE_RPC,
          body: new Uint8Array(budget.plaintextCeiling + 1),
          admit: () => true,
          transmit: () => ({ kind: "sent" }),
        });
        expect(overCeiling.kind).toBe("refused");

        await node.closeFromPeer();
      });
    }
  }

  it("moves the §4.5 ceiling with the negotiated limits rather than pinning a constant", () => {
    // The two cells above would both pass against an implementation that ignored
    // the asserted limits and used one hardcoded ceiling. This is the assertion
    // that makes the axis real: the ceilings must DIFFER, and the narrower
    // connection must be the smaller of the two.
    const wide = e2eeChannelSizeBudget(LIMIT_CELLS[0]!.limits);
    const narrow = e2eeChannelSizeBudget(LIMIT_CELLS[1]!.limits);
    expect(wide.establishable && narrow.establishable).toBe(true);
    expect(narrow.plaintextCeiling).toBeLessThan(wide.plaintextCeiling);
    expect(nodeE2eeChannelPlaintextCeiling(LIMIT_CELLS[1]!.limits)).toBeLessThan(
      nodeE2eeChannelPlaintextCeiling(LIMIT_CELLS[0]!.limits),
    );
  });

  it("verifies the node's own advertised statement through the real §5.2 client verifier", async () => {
    // THE SUITE REGISTRY AXIS, driven across the pair rather than beside it: the
    // statement is the one THIS node built and signed and put on the channel,
    // and the verifier is the one a client runs before it will send a hello.
    const node = await harness();
    const advertisement = await node.open();

    for (const tier of ["native", "web"] as const) {
      const verdict = verifyNodeE2eeCapabilityStatement({
        statement: advertisement.statement,
        connectedHubOrigin: HUB_ORIGIN,
        tier,
        localSuitePreference: [E2EE_SUITE_25519_CHACHAPOLY_SHA256],
        now: NOW,
        accountId: tier === "native" ? "acct_0123456789" : undefined,
      });
      // First contact: no pin, so §5.2 step 6 has nothing to reach and the
      // verdict is `verified` with the `none` anchor rather than an identity
      // event. Both tiers select the one registered suite.
      expect(verdict.kind, tier).toBe("verified");
      if (verdict.kind !== "verified") return;
      expect(verdict.selectedSuite, tier).toBe(E2EE_SUITE_25519_CHACHAPOLY_SHA256);
      expect(verdict.anchor, tier).toBe("none");
      expect(verdict.statement.suiteRegistry, tier).toEqual([E2EE_SUITE_25519_CHACHAPOLY_SHA256]);
      // …and the statement really describes the key the handshake will run
      // against, which is the part that ties the verifier to the endpoint pair.
      expect(Buffer.from(verdict.statement.identityFingerprint).toString("hex"), tier).toBe(
        Buffer.from(
          e2eeKeyFingerprint("node-identity", advertisement.nodeIdentityPublicKey),
        ).toString("hex"),
      );
    }
  });

  it("refuses the pair when the client's local preference shares no suite with the registry", async () => {
    // The negative direction of the same axis. §8.2 selects from the
    // intersection, and an empty intersection is `unusable` — a statement that
    // VALIDATED and is still unusable, which is a different verdict from an
    // invalid one and the reason both exist.
    const node = await harness();
    const advertisement = await node.open();
    const verdict = verifyNodeE2eeCapabilityStatement({
      statement: advertisement.statement,
      connectedHubOrigin: HUB_ORIGIN,
      tier: "native",
      // A registered-but-different id: §3.4 reserves everything except 0x01, so
      // no conforming registry carries this and the intersection is empty.
      localSuitePreference: [0x7f],
      now: NOW,
      accountId: "acct_0123456789",
    });
    expect(verdict.kind).toBe("unusable");
    if (verdict.kind !== "unusable") return;
    expect(verdict.statement.suiteRegistry).toEqual([E2EE_SUITE_25519_CHACHAPOLY_SHA256]);
  });

  it("gives each tier the §13 display its own pattern defines, over one node", async () => {
    // The two tiers do not merely both work — they reach DIFFERENT verification
    // ceremonies over the same node identity, and the NODE's own §13 output is
    // read on both sides here rather than inferred. What makes each half a pair
    // check is the node value: the web session's registered code is compared
    // against a WebSAS this test derives from the client's real Noise ephemeral,
    // so a node feeding the wrong input produces a different string; the native
    // session's ABSENCE of a per-session code is asserted for the same reason,
    // because §13.4's value is a property of the identity pair and lives on the
    // Branch A record rather than on the session.
    const nativeRegistrations: { readonly verificationCode: string | undefined }[] = [];
    const nativeNode = await harness({
      registerSession: (session) => {
        nativeRegistrations.push({ verificationCode: session.verificationCode });
        return () => undefined;
      },
    });
    const nativeAdvertisement = await nativeNode.open();
    const nativeClient = await establish(nativeNode, "native", nativeAdvertisement);
    // §13.4: the native tier's ceremony is the safety number over both identity
    // keys under the channel's namespace, which exists only because the native
    // tier has a client identity at all. It is NOT a session value, and the node
    // publishing one here would be publishing a §13.5 code for a tier that has
    // no ceremony for it.
    const safety = deriveE2eeSafetyNumber({
      hubOrigin: HUB_ORIGIN,
      accountId: "acct_0123456789",
      nodeIdentityPublicKey: nativeAdvertisement.nodeIdentityPublicKey,
      clientIdentityPublicKey: CLIENT_IDENTITY_PUBLIC,
    });
    expect(safety.display.length).toBeGreaterThan(0);
    expect(nativeClient.sessionBindingHash.byteLength).toBe(32);
    expect(nativeRegistrations).toHaveLength(1);
    expect(nativeRegistrations[0]?.verificationCode).toBeUndefined();

    const webRegistrations: {
      readonly tier: string;
      readonly verificationCode: string | undefined;
    }[] = [];
    const webNode = await harness({
      authorization: authorizationFor(undefined),
      registerSession: (session) => {
        webRegistrations.push({ tier: session.tier, verificationCode: session.verificationCode });
        return () => undefined;
      },
    });
    const webAdvertisement = await webNode.open();
    const webEphemeral = new Uint8Array(32).fill(0x3d);
    // Derived BEFORE `establish`: §9.5's erasure reaches the injected buffer,
    // which is this array, so reading it afterwards reads zeroes.
    const webEphemeralPublicKey = deriveE2eeAgreementPublicKey(webEphemeral);
    const webClient = await establish(webNode, "web", webAdvertisement, webEphemeral);
    // §13.5: the web tier has no client identity, so its ceremony is the session
    // WebSAS over the node identity, the WEB CLIENT's Noise ephemeral, and the
    // §8.8 binding hash — a per-session code, not a per-pair number.
    const sas = deriveE2eeWebSas({
      nodeIdentityPublicKey: webAdvertisement.nodeIdentityPublicKey,
      webEphemeralPublicKey,
      sessionBindingHash: webClient.sessionBindingHash,
    });
    expect(sas.display.length).toBeGreaterThan(0);
    // THE PAIR CHECK. The node derived its code from the ephemeral it read out
    // of the Noise handshake and from the binding hash it computed itself; this
    // side derived the same code from the ephemeral it injected and the binding
    // hash the client computed. Substituting any other 32-byte point — the
    // node's own §6.4 prekey, say, which `validateE2eeAgreementPublicKey`
    // accepts as readily — fails here rather than passing a shape check.
    expect(webRegistrations).toHaveLength(1);
    expect(webRegistrations[0]?.tier).toBe("web");
    expect(webRegistrations[0]?.verificationCode).toBe(sas.display);
    expect(
      deriveE2eeWebSas({
        nodeIdentityPublicKey: webAdvertisement.nodeIdentityPublicKey,
        webEphemeralPublicKey: webAdvertisement.material.agreementPublicKey,
        sessionBindingHash: webClient.sessionBindingHash,
      }).display,
    ).not.toBe(webRegistrations[0]?.verificationCode);
    // The two ceremonies are not interchangeable: a safety number is a property
    // of the identity pair and a WebSAS is a property of one session, so the two
    // strings must not collide even over the same node.
    expect(sas.display).not.toBe(safety.display);
  });

  it("refuses a native client whose hello offers a suite the node does not admit", async () => {
    // The suite axis, driven at the HANDSHAKE rather than at the verifier: the
    // node's §12.4 policy carries one registry, and a hello selecting outside it
    // is refused with §11.2's single indistinguishable observable.
    const node = await harness();
    const advertisement = await node.open();
    const client = new E2eeClientHandshake({
      channel: clientChannel,
      advertised: advertisement.material,
      selectedSuite: E2EE_SUITE_25519_CHACHAPOLY_SHA256,
      offeredSuites: [E2EE_SUITE_25519_CHACHAPOLY_SHA256],
      credentials: nativeCredentials(),
      intendedCapability: CAPABILITY,
      intendedRole: ROLE,
    });
    const hello = client.createHello(NOW);
    expect(hello.kind).toBe("hello");
    if (hello.kind !== "hello") return;
    // REBUILD the §8.5 body with an unregistered `selectedSuite`, rather than
    // corrupting bytes. The body is
    // `[e2eeVersion, tier, selectedSuite, offeredSuites, clientNonce,
    //   contextCommitment, noiseMessage1]` and `selectedSuite` is element 3, so
    // flipping a trailing byte would land in the Noise message-1 AEAD tag and
    // exercise tamper detection — which is the attacker-relay suite's subject,
    // not this file's — while never reaching §8.6 step 2 at all. §3.4 registers
    // exactly one suite id, so 0x7f is outside every conforming registry; the
    // hello is otherwise byte-for-byte what this client produced.
    const decodedRecord = decodeE2eeNegotiationRecord(hello.record);
    expect(decodedRecord.kind).toBe("ok");
    if (decodedRecord.kind !== "ok") return;
    expect(decodedRecord.value.recordType).toBe(E2EE_NEGOTIATION_TYPE_CLIENT_HELLO);
    const decodedBody = decodeCanonicalE2eeCbor(decodedRecord.value.body);
    expect(decodedBody.kind).toBe("ok");
    if (decodedBody.kind !== "ok") return;
    const fields = decodedBody.value as unknown[];
    expect(fields).toHaveLength(7);
    expect(fields[2]).toBe(E2EE_SUITE_25519_CHACHAPOLY_SHA256);
    const UNREGISTERED_SUITE = 0x7f;
    fields[2] = UNREGISTERED_SUITE;
    // §8.6 step 2 also requires `offeredSuites` to contain the selection, so the
    // offer moves with it: otherwise the hello fails a DIFFERENT clause of the
    // same check and the cell stops being about the registry.
    fields[3] = [UNREGISTERED_SUITE];
    const rewritten = encodeE2eeNegotiationRecord(
      E2EE_NEGOTIATION_TYPE_CLIENT_HELLO,
      encodeCanonicalE2eeCbor(fields),
    );
    const before = node.dataPayloads().length;
    await node.deliver(rewritten);
    node.flush();
    const answered = node.dataPayloads().slice(before);
    // §11.2: every pre-key failure is the same 64-byte reject, or nothing at
    // all. What must never happen is establishment.
    expect(node.session().mode()).not.toBe("e2ee");
    for (const payload of answered) {
      expect(classifyPostStripPayload(stripPrelude(payload)).kind).toBe("negotiation");
    }
    // …and the node refused at the WRAPPER, before any Noise state existed. The
    // §11.4 row is node-local diagnostic state and is the only thing that
    // distinguishes this rejection from the AEAD failure a trailing-byte flip
    // produces (P10), which is what makes the cell about the suite registry
    // rather than about tamper detection.
    expect(node.rows()).toEqual(["P9"]);
  });
});
