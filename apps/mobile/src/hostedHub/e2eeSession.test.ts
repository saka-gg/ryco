import type { NodeE2eeCapabilityVerification } from "@ryco/shared/relayE2eeCapabilityVerify";
import { e2eeKeyFingerprint, formatE2eeKeyFingerprint } from "@ryco/shared/relayE2eeKeys";
import type { NodeE2eeCapabilityStatement } from "@ryco/shared/relayE2eeTranscripts";
import { deriveE2eeSafetyNumber } from "@ryco/shared/relayE2eeVerificationDisplay";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import type { E2eeTrustClassification } from "../platform/e2eeTrustModel";
import {
  attachMobileE2eeLocalNodeHandle,
  beginMobileE2eeChannel,
  beginMobileE2eeChannelAttempt,
  beginMobileE2eeFailClosedSelection,
  clearMobileE2eeTrustEvent,
  getMobileE2eeSessionState,
  lockMobileE2eeChannelMode,
  markMobileE2eeKeyCustodyUnavailable,
  observeMobileE2eeStatement,
  raiseMobileE2eeUnexpectedNode,
  recordMobileE2eeInitiatorDiagnostic,
  resetMobileE2eeSession,
  resetMobileE2eeSessionForTests,
  subscribeMobileE2eeSession,
} from "./e2eeSession";

const HUB = "https://hub.example.com";
const ACCOUNT = "acct_0123456789";

function bytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let index = 0; index < out.byteLength; index += 1) {
    out[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return out;
}

const NODE_PUBLIC_KEY = bytes("03a107bff3ce10be1d70dd18e74bc09967e4d6309ba50d5f1ddc8664125531b8");
const ROTATED_PUBLIC_KEY = bytes(
  "5866666666666666666666666666666666666666666666666666666666666666",
);
const CLIENT_PUBLIC_KEY = bytes(
  "047a593180860c4037c83c12749845c8ee1424dd297fadcb895e358255d2c7d2" +
    "b2a8ca25580f2626fe579062ff1b99ff91c24a0da06fb32b5be20148c9249f5650",
);

/**
 * Only the fields the projection reads. The verifier's other members are its
 * business, and inventing plausible values for them here would be a fixture that
 * looks like evidence and is not.
 */
function statement(identityPublicKey: Uint8Array): NodeE2eeCapabilityStatement {
  return {
    identityPublicKey,
    continuityId: "continuity-1",
    policyGeneration: 4,
  } as unknown as NodeE2eeCapabilityStatement;
}

const UNEXPECTED_FRESH: E2eeTrustClassification = {
  class: "unexpected",
  clause: "i",
  record: "unpinned",
  scope: { kind: "fresh" },
};

function begin(
  overrides: {
    readonly classification?: E2eeTrustClassification;
    readonly pinVerified?: boolean;
    readonly trustSource?: "locally-verified" | "account-enrolled";
  } = {},
): void {
  beginMobileE2eeChannel({
    selection: {
      hubOrigin: HUB,
      accountId: ACCOUNT,
      nodeId: "node_1",
      nodeLabel: "Studio",
      environmentId: "env_1",
      localNodeHandle: null,
      localRecordState: null,
      clientIdentityPublicKey: CLIENT_PUBLIC_KEY,
    },
    classification: overrides.classification ?? UNEXPECTED_FRESH,
    legacyPermitted: true,
    markerSet: false,
    pinVerified: overrides.pinVerified ?? false,
    previouslyVerified: null,
    ...(overrides.trustSource === undefined ? {} : { trustSource: overrides.trustSource }),
  });
}

beforeEach(() => {
  resetMobileE2eeSessionForTests();
});

describe("the channel's claim", () => {
  it("keeps concurrent node trust projections independent by environment", () => {
    beginMobileE2eeChannel({
      selection: {
        hubOrigin: HUB,
        accountId: ACCOUNT,
        nodeId: "node_a",
        nodeLabel: "A",
        environmentId: "env_a",
        localNodeHandle: null,
        localRecordState: null,
        clientIdentityPublicKey: CLIENT_PUBLIC_KEY,
      },
      classification: { class: "latched" },
      legacyPermitted: false,
      markerSet: true,
      pinVerified: true,
      previouslyVerified: null,
    });
    beginMobileE2eeChannel({
      selection: {
        hubOrigin: HUB,
        accountId: ACCOUNT,
        nodeId: "node_b",
        nodeLabel: "B",
        environmentId: "env_b",
        localNodeHandle: null,
        localRecordState: null,
        clientIdentityPublicKey: CLIENT_PUBLIC_KEY,
      },
      classification: UNEXPECTED_FRESH,
      legacyPermitted: false,
      markerSet: true,
      pinVerified: false,
      previouslyVerified: null,
    });
    lockMobileE2eeChannelMode("e2ee", "env_a");
    lockMobileE2eeChannelMode("e2ee", "env_b");
    attachMobileE2eeLocalNodeHandle("handle-b", "unverified", "env_b");

    expect(getMobileE2eeSessionState("env_a")).toMatchObject({
      channel: "verified",
      selection: { nodeId: "node_a", localNodeHandle: null },
    });
    expect(getMobileE2eeSessionState("env_b")).toMatchObject({
      channel: "unverified",
      selection: { nodeId: "node_b", localNodeHandle: "handle-b", localRecordState: "unverified" },
    });
  });

  it("keeps unexpected trust context without fabricating unavailable credential material", () => {
    beginMobileE2eeFailClosedSelection({
      selection: {
        hubOrigin: HUB,
        accountId: ACCOUNT,
        nodeId: "node_unexpected",
        nodeLabel: "Studio",
        environmentId: "env_1",
        localNodeHandle: null,
        localRecordState: null,
      },
      classification: { class: "unexpected", clause: "ii" },
      legacyPermitted: true,
      markerSet: true,
      pinVerified: false,
    });

    const state = getMobileE2eeSessionState();
    expect(state).toMatchObject({
      channel: "unavailable",
      selection: { nodeId: "node_unexpected", clientIdentityPublicKey: null },
      classification: { class: "unexpected", clause: "ii" },
      event: { kind: "unexpected-node", situation: 1, evidence: "none" },
    });
    expect(state.presented).toBeNull();
  });

  it("starts negotiating and claims nothing", () => {
    begin();
    expect(getMobileE2eeSessionState().channel).toBe("negotiating");
  });

  it("separates an e2ee channel with a verified pin from one without", () => {
    begin({ pinVerified: true });
    lockMobileE2eeChannelMode("e2ee");
    expect(getMobileE2eeSessionState().channel).toBe("verified");
    resetMobileE2eeSessionForTests();
    begin({ pinVerified: false });
    // docs/relay-e2ee-protocol.md §13.1's release gate: an `e2ee` channel with no
    // verified pin is the ceremony, and is never spelled the way §2.2's bottom
    // row is spelled.
    lockMobileE2eeChannelMode("e2ee");
    expect(getMobileE2eeSessionState().channel).toBe("unverified");
  });

  it("labels account-authorized E2EE without marking it locally verified", () => {
    begin({ trustSource: "account-enrolled", pinVerified: false });
    lockMobileE2eeChannelMode("e2ee");
    expect(getMobileE2eeSessionState()).toMatchObject({
      channel: "account-trusted",
      trustSource: "account-enrolled",
      pinVerified: false,
    });
  });

  it("never reports the shared vocabulary's web row, from any publisher", () => {
    // §8.1's role/tier matrix gives this app a static agreement key and the IK
    // pattern, so `web-unsigned` — §2.2's *Web, unsigned ephemeral* row — is a
    // state it cannot occupy. The shared union carries the member because the
    // web tier needs a word that is not `Encrypted`; this asserts that adding it
    // there left the native projection alone, rather than opening a path by
    // which a signed channel could be labelled the unsigned way.
    //
    // EVERY EXPORTED PUBLISHER, NOT THE TWO A LOCK NEEDS. `channel` is written
    // by five of them and preserved by the rest, and a property proved over
    // `beginMobileE2eeChannel` and `lockMobileE2eeChannelMode` alone would say
    // nothing about the key-custody path, the per-channel restart, or the reset
    // state — which is also the only place `unavailable` is sampled.
    const reported = new Set<string>();
    const sample = () => reported.add(getMobileE2eeSessionState().channel);
    for (const pinVerified of [true, false]) {
      for (const mode of ["e2ee", "legacy"] as const) {
        resetMobileE2eeSessionForTests();
        sample();
        begin({ pinVerified });
        sample();
        // Everything that publishes without owning `channel`: each one spreads
        // the current state, so a value introduced here would be one carried in
        // rather than one written.
        observeMobileE2eeStatement({
          kind: "verified",
          statement: statement(NODE_PUBLIC_KEY),
          selectedSuite: 1,
          anchor: "pin-unchanged",
        });
        sample();
        attachMobileE2eeLocalNodeHandle("node-handle-1", "unverified");
        sample();
        recordMobileE2eeInitiatorDiagnostic({ phase: "pre_key", row: "P14" });
        sample();
        raiseMobileE2eeUnexpectedNode("none");
        sample();
        clearMobileE2eeTrustEvent();
        sample();
        // …and every publisher that does own it.
        beginMobileE2eeChannelAttempt();
        sample();
        lockMobileE2eeChannelMode(mode);
        sample();
        markMobileE2eeKeyCustodyUnavailable();
        sample();
        resetMobileE2eeSession();
        sample();
      }
    }
    expect([...reported].toSorted()).toEqual([
      "legacy",
      "negotiating",
      "unavailable",
      "unverified",
      "verified",
    ]);
  });

  it("labels a fallback legacy whether or not a pin resolved", () => {
    for (const pinVerified of [true, false]) {
      resetMobileE2eeSessionForTests();
      begin({ pinVerified });
      lockMobileE2eeChannelMode("legacy");
      expect(getMobileE2eeSessionState().channel).toBe("legacy");
    }
  });

  it("returns every later channel of the same selection to negotiating", () => {
    // §2.2: the claim belongs to the channel that earned it. Publishing it per
    // PREPARATION left a verified label standing over every later channel of the
    // same selection, including one closing FATAL-PRE under a §13.3 substitution.
    begin({ pinVerified: true });
    lockMobileE2eeChannelMode("e2ee");
    expect(getMobileE2eeSessionState().channel).toBe("verified");
    beginMobileE2eeChannelAttempt();
    expect(getMobileE2eeSessionState().channel).toBe("negotiating");
    // …and the context the ceremony needs is not thrown away with the claim.
    expect(getMobileE2eeSessionState().selection?.nodeId).toBe("node_1");
    expect(getMobileE2eeSessionState().pinVerified).toBe(true);
  });

  it("labels a device with no key material legacy from the start", () => {
    // §6.3: "a device that cannot hold the key simply has no E2EE". The channel
    // runs, unencrypted, and §12.2 requires it to be labeled so.
    markMobileE2eeKeyCustodyUnavailable();
    expect(getMobileE2eeSessionState().channel).toBe("legacy");
    expect(getMobileE2eeSessionState().selection).toBeNull();
  });
});

describe("§13.3: the three arms of a §5.2 verdict", () => {
  it("surfaces NO prompt for a legitimate rotation with a verifying chain", () => {
    begin();
    const verification: NodeE2eeCapabilityVerification = {
      kind: "verified",
      statement: statement(ROTATED_PUBLIC_KEY),
      selectedSuite: 1,
      anchor: "pin-updated",
    };
    observeMobileE2eeStatement(verification);
    const state = getMobileE2eeSessionState();
    // §13.3: "Legitimate node identity rotation MUST NOT surface a
    // re-verification prompt."
    expect(state.event).toBeNull();
    expect(state.diagnostics).toEqual([]);
    // The pin followed the chain, so the display material is the NEW identity.
    expect(state.presented?.display.fingerprint).toBe(
      formatE2eeKeyFingerprint(e2eeKeyFingerprint("node-identity", ROTATED_PUBLIC_KEY)),
    );
  });

  it("surfaces no prompt for a statement that authenticated unchanged", () => {
    begin();
    observeMobileE2eeStatement({
      kind: "verified",
      statement: statement(NODE_PUBLIC_KEY),
      selectedSuite: 1,
      anchor: "pin-unchanged",
    });
    expect(getMobileE2eeSessionState().event).toBeNull();
  });

  it("raises the re-verification UI on a chain failure, with the new pair", () => {
    begin();
    observeMobileE2eeStatement({
      kind: "identity-event",
      event: { reason: "pinned_continuity_id" },
      statement: statement(ROTATED_PUBLIC_KEY),
    });
    const state = getMobileE2eeSessionState();
    expect(state.event).toEqual({ kind: "identity-change" });
    // §13.3: the client "displays the new fingerprint and safety number".
    expect(state.presented?.display.fingerprint).toBe(
      formatE2eeKeyFingerprint(e2eeKeyFingerprint("node-identity", ROTATED_PUBLIC_KEY)),
    );
    expect(state.presented?.display.safetyNumber).toBe(
      deriveE2eeSafetyNumber({
        nodeIdentityPublicKey: ROTATED_PUBLIC_KEY,
        clientIdentityPublicKey: CLIENT_PUBLIC_KEY,
        hubOrigin: HUB,
        accountId: ACCOUNT,
      }).display,
    );
    // And nothing has been released: the channel never locked a mode.
    expect(state.channel).toBe("negotiating");
  });

  it("raises NEITHER surface for a policy-generation regression", () => {
    begin();
    observeMobileE2eeStatement({ kind: "invalid", reason: "policy_generation_regressed" });
    const state = getMobileE2eeSessionState();
    // §11.4 / §5.7: local-only, and it "MUST NOT by itself launch the §13.2
    // ceremony or the §13.3 re-verification UI".
    expect(state.event).toBeNull();
    expect(state.diagnostics).toEqual([{ id: "e2ee_policy_generation_regressed", row: "local" }]);
  });

  it("raises neither surface, and no diagnostic, for any other invalid statement", () => {
    begin();
    observeMobileE2eeStatement({ kind: "invalid", reason: "identity_signature_invalid" });
    const state = getMobileE2eeSessionState();
    expect(state.event).toBeNull();
    expect(state.diagnostics).toEqual([]);
  });
});

describe("§13.2.1: which situation the surface raises", () => {
  it("picks situation 1 for a fresh selection with no evidence", () => {
    begin();
    raiseMobileE2eeUnexpectedNode("none");
    expect(getMobileE2eeSessionState().event).toEqual({
      kind: "unexpected-node",
      situation: 1,
      evidence: "none",
    });
  });

  it("picks situation 2 under an account that already holds a verified pin", () => {
    begin({ classification: { class: "unexpected", clause: "ii" } });
    raiseMobileE2eeUnexpectedNode("first-contact-statement");
    expect(getMobileE2eeSessionState().event).toMatchObject({ situation: 2 });
  });

  it("picks situation 3 for an account scope with no pin on a marked Hub origin", () => {
    begin({ classification: { class: "unexpected", clause: "iii" } });
    raiseMobileE2eeUnexpectedNode("first-contact-statement");
    expect(getMobileE2eeSessionState().event).toMatchObject({ situation: 3 });
  });

  it("raises nothing for a selection that is not unexpected", () => {
    begin({ classification: { class: "latched" } });
    raiseMobileE2eeUnexpectedNode("none");
    expect(getMobileE2eeSessionState().event).toBeNull();
  });

  it("clears the event without changing the channel's label or claim", () => {
    begin();
    lockMobileE2eeChannelMode("legacy");
    raiseMobileE2eeUnexpectedNode("none");
    const before = getMobileE2eeSessionState();
    clearMobileE2eeTrustEvent();
    const after = getMobileE2eeSessionState();
    // §13.1.1: "dismissing it MUST NOT change any channel's label or unlock any
    // guarantee."
    expect(after.event).toBeNull();
    expect(after.channel).toBe(before.channel);
    expect(after.markerSet).toBe(before.markerSet);
    expect(after.classification).toEqual(before.classification);
  });
});

describe("§11.4 diagnostics", () => {
  it("keeps a bounded, oldest-evicted list carrying only a row label", () => {
    begin();
    for (let index = 0; index < 12; index += 1) {
      recordMobileE2eeInitiatorDiagnostic({ phase: "pre_key", row: `K${index}` });
    }
    const { diagnostics } = getMobileE2eeSessionState();
    expect(diagnostics.length).toBe(8);
    expect(diagnostics[0]).toEqual({ id: "pre_key_local", row: "K4" });
    for (const diagnostic of diagnostics) {
      expect(Object.keys(diagnostic).toSorted()).toEqual(["id", "row"]);
    }
  });
});

describe("subscribers", () => {
  it("publishes once per change and never for a no-op clear", () => {
    let published = 0;
    const unsubscribe = subscribeMobileE2eeSession(() => {
      published += 1;
    });
    begin();
    expect(published).toBe(1);
    clearMobileE2eeTrustEvent();
    expect(published).toBe(1);
    raiseMobileE2eeUnexpectedNode("none");
    expect(published).toBe(2);
    unsubscribe();
  });
});
