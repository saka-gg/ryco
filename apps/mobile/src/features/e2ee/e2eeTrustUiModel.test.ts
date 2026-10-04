/// <reference types="node" />
import { createPrivateKey, sign as signBytes } from "node:crypto";

import { HOSTED_E2EE_CHANNEL_STATUSES } from "@ryco/client-runtime/authorization";
import {
  E2EE_SAFETY_NUMBER_DIGITS,
  E2EE_SAFETY_NUMBER_MIN_DISPLAYED_BITS,
} from "@ryco/shared/relayE2eeConstants";
import {
  encodeCrossDeviceApprovalQr,
  encodeCrossDeviceApprovalTbs,
} from "@ryco/shared/relayE2eeCrossDeviceApproval";
import { e2eeKeyFingerprint, formatE2eeKeyFingerprint } from "@ryco/shared/relayE2eeKeys";
import { deriveE2eeSafetyNumber } from "@ryco/shared/relayE2eeVerificationDisplay";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

// The trust store reaches SecureStore, the plain KV, and `react-native`'s
// `Platform`. None of that belongs in a model suite.
vi.mock("expo-secure-store", () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 0xd,
  getItemAsync: async () => null,
  setItemAsync: async () => {},
  deleteItemAsync: async () => {},
}));
vi.mock("react-native", () => ({ Platform: { OS: "ios" } }));
vi.mock("expo-sqlite/kv-store", () => ({
  default: { getItem: async () => null, setItem: async () => {}, removeItem: async () => {} },
}));

import type {
  MobileE2eeIdentityDisplay,
  MobileE2eeSessionState,
} from "../../hostedHub/e2eeSession";
import type { E2eeTrustClassification } from "../../platform/e2eeTrustModel";
import {
  cancelE2eeApprovalRequest,
  CHANNEL_LABELS,
  CHANNEL_MESSAGES,
  createE2eeVerificationDraft,
  confirmE2eeApprovalQr,
  deriveE2eeApprovalComparison,
  deriveE2eeApprovalRequestStatus,
  deriveE2eeSecurityView,
  deriveE2eeVerificationView,
  e2eeSafetyNumberGroups,
  isE2eeApprovalRequested,
  isE2eeSafetyNumberDisplay,
  E2EE_APPROVAL_AWAITING_NODE_MESSAGE,
  E2EE_APPROVAL_AWAITING_NUMBER_MESSAGE,
  E2EE_APPROVAL_CANCEL_UNAVAILABLE,
  E2EE_APPROVAL_INTRO_MESSAGE,
  E2EE_APPROVAL_REQUESTED_MESSAGE,
  E2EE_APPROVAL_SAFETY_NUMBER_CAPTION,
  E2EE_COMPARISON_AFFIRMATION,
  E2EE_ENROLLMENT_FINGERPRINT_MISMATCH,
  E2EE_IDENTITY_CHANGE_MESSAGE,
  E2EE_IDENTITY_CHANGE_TITLE,
  E2EE_LEGACY_CONSENT_MESSAGE,
  E2EE_LEGACY_CONSENT_TITLE,
  E2EE_NO_KEY_CUSTODY_MESSAGE,
  E2EE_REPAIR_MESSAGE,
  E2EE_REPAIR_TITLE,
  E2EE_SAFETY_NUMBER_CAPTION,
  E2EE_TRUST_SITUATION_MESSAGES,
  E2EE_UNEXPECTED_NODE_MESSAGES,
  E2EE_UNEXPECTED_NODE_TITLES,
  E2EE_VERIFICATION_UNAVAILABLE,
  requestE2eeApproval,
  shouldShowE2eeApprovalScanner,
  type E2eeTrustAction,
  type E2eeVerificationDraft,
} from "./e2eeTrustUiModel";
import { CLAIM_SYMBOLS } from "./e2eeTrustSymbols";
import { mobileE2eeTrustStore } from "../../platform/e2eeTrustStore";

const HUB = "https://hub.example.com";
const ACCOUNT = "acct_0123456789";

function bytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let index = 0; index < out.byteLength; index += 1) {
    out[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return out;
}

// The §16.1-style deterministic material the trust-store suite uses. TEST ONLY.
const NODE_PUBLIC_KEY = bytes("03a107bff3ce10be1d70dd18e74bc09967e4d6309ba50d5f1ddc8664125531b8");
const OTHER_NODE_PUBLIC_KEY = bytes(
  "5866666666666666666666666666666666666666666666666666666666666666",
);
const CLIENT_PUBLIC_KEY = bytes(
  "047a593180860c4037c83c12749845c8ee1424dd297fadcb895e358255d2c7d2" +
    "b2a8ca25580f2626fe579062ff1b99ff91c24a0da06fb32b5be20148c9249f5650",
);
const NODE_PRIVATE_KEY = createPrivateKey({
  key: Buffer.concat([
    Buffer.from("302e020100300506032b657004220420", "hex"),
    Buffer.from(Uint8Array.from({ length: 32 }, (_, index) => index)),
  ]),
  format: "der",
  type: "pkcs8",
});

function approvalQr(now = 2_000): string {
  const state = session({
    selection: {
      ...session().selection!,
      nodeId: `node_${"N".repeat(22)}`,
    },
    presented: {
      ...session().presented!,
      continuityId: `nct_${"C".repeat(22)}`,
    },
  });
  const tbs = encodeCrossDeviceApprovalTbs({
    hubOrigin: HUB,
    accountId: ACCOUNT,
    nodeId: state.selection!.nodeId,
    nodeIdentityPublicKey: NODE_PUBLIC_KEY,
    clientIdentityFingerprint: e2eeKeyFingerprint("client-identity", CLIENT_PUBLIC_KEY),
    maxRole: "owner",
    capabilitySet: ["ryco.rpc"],
    nodeContinuityId: state.presented!.continuityId,
    nodePolicyGeneration: state.presented!.policyGeneration,
    approvedAt: now - 1_000,
    approvalId: new Uint8Array(32).fill(0x5a),
    issuedAt: now - 500,
    expiresAt: now + 299_500,
  });
  return encodeCrossDeviceApprovalQr({
    tbs,
    signature: Uint8Array.from(signBytes(null, tbs, NODE_PRIVATE_KEY)),
  });
}

function display(nodeKey: Uint8Array): MobileE2eeIdentityDisplay {
  return {
    fingerprint: formatE2eeKeyFingerprint(e2eeKeyFingerprint("node-identity", nodeKey)),
    safetyNumber: deriveE2eeSafetyNumber({
      nodeIdentityPublicKey: nodeKey,
      clientIdentityPublicKey: CLIENT_PUBLIC_KEY,
      hubOrigin: HUB,
      accountId: ACCOUNT,
    }).display,
  };
}

const PRESENTED = display(NODE_PUBLIC_KEY);
const PREVIOUS = display(OTHER_NODE_PUBLIC_KEY);

const UNEXPECTED_FRESH: E2eeTrustClassification = {
  class: "unexpected",
  clause: "i",
  record: "unpinned",
  scope: { kind: "fresh" },
};

function session(overrides: Partial<MobileE2eeSessionState> = {}): MobileE2eeSessionState {
  return {
    channel: "negotiating",
    trustSource: "locally-verified",
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
    classification: UNEXPECTED_FRESH,
    legacyPermitted: true,
    markerSet: false,
    pinVerified: false,
    presented: {
      nodeIdentityPublicKey: NODE_PUBLIC_KEY,
      display: PRESENTED,
      continuityId: "continuity-1",
      policyGeneration: 4,
    },
    previouslyVerified: null,
    event: null,
    keyCustodyUnavailable: false,
    diagnostics: [],
    ...overrides,
  };
}

function verificationView(
  state: MobileE2eeSessionState,
  draft: E2eeVerificationDraft = createE2eeVerificationDraft(),
) {
  let held = draft;
  const view = deriveE2eeVerificationView({
    session: state,
    draft,
    onDraftChange: (next) => {
      held = next;
    },
    onCompleted: () => undefined,
    now: () => 1_000,
  });
  return { view, read: () => held };
}

function securityView(state: MobileE2eeSessionState, overrides: { unreadable?: boolean } = {}) {
  return deriveE2eeSecurityView({
    session: state,
    hostedModeAvailable: true,
    trustStateUnreadable: overrides.unreadable ?? false,
    onOpenVerification: () => undefined,
    now: () => 1_000,
  });
}

/**
 * Every string any §13 surface can render, so a claim cannot hide in a branch
 * the spot checks below did not visit.
 *
 * The channel dimension is the runtime's own exhaustive enumeration and never a
 * hand-written list: `HOSTED_E2EE_CHANNEL_STATUSES` is `satisfies
 * Record<HostedE2eeChannelStatus, true>`, so a member added to the shared union
 * enters this scan — and the §2.2/§2.3 forbidden-string check it feeds — rather
 * than skipping it. A copied array is how `web-unsigned` was added to the union
 * without any of the three sweeps in this file noticing.
 */
function everyRenderedString(): readonly string[] {
  const strings: string[] = [];
  const collect = (value: unknown) => {
    if (typeof value === "string") strings.push(value);
    else if (Array.isArray(value)) for (const entry of value) collect(entry);
    else if (value !== null && typeof value === "object") {
      for (const entry of Object.values(value)) collect(entry);
    }
  };
  for (const channel of HOSTED_E2EE_CHANNEL_STATUSES) {
    for (const markerSet of [true, false, null]) {
      for (const legacyPermitted of [true, false]) {
        for (const event of [
          null,
          { kind: "identity-change" } as const,
          { kind: "unexpected-node", situation: 1, evidence: "none" } as const,
          { kind: "unexpected-node", situation: 2, evidence: "first-contact-statement" } as const,
          { kind: "unexpected-node", situation: 3, evidence: "first-contact-statement" } as const,
        ]) {
          const state = session({
            channel,
            markerSet,
            legacyPermitted,
            event,
            previouslyVerified: PREVIOUS,
          });
          collect(securityView(state, { unreadable: true }));
          collect(
            verificationView(state, {
              ...createE2eeVerificationDraft(),
              enteredFingerprint: PRESENTED.fingerprint,
              comparisonAcknowledged: true,
            }).view,
          );
          collect(verificationView(state).view);
        }
      }
    }
  }
  return strings;
}

/* -------------------------------------------------------------------------- */

describe("§13.4 safety number rendering", () => {
  it("renders 12 groups of 5 zero-padded digits, in derivation order", () => {
    const groups = e2eeSafetyNumberGroups(PRESENTED.safetyNumber);
    expect(groups.length).toBe(E2EE_SAFETY_NUMBER_DIGITS.groups);
    expect(groups.length).toBe(12);
    for (const group of groups) {
      expect(group.length).toBe(E2EE_SAFETY_NUMBER_DIGITS.digitsPerGroup);
      expect(group.length).toBe(5);
      expect(group).toMatch(/^\d{5}$/);
    }
    // Derivation order: re-joining reproduces the shared renderer's output
    // exactly, so no surface can reflow, sort, or reverse it.
    expect(groups.join(E2EE_SAFETY_NUMBER_DIGITS.separator)).toBe(PRESENTED.safetyNumber);
  });

  it("refuses anything that is not the exact §13.4 display format", () => {
    expect(isE2eeSafetyNumberDisplay(PRESENTED.safetyNumber)).toBe(true);
    for (const wrong of [
      "",
      "1234",
      PRESENTED.safetyNumber.replaceAll(" ", ""),
      `${PRESENTED.safetyNumber} 00000`,
      PRESENTED.safetyNumber.slice(0, -1),
      PRESENTED.safetyNumber.replace(/\d$/u, "x"),
    ]) {
      expect(isE2eeSafetyNumberDisplay(wrong), wrong).toBe(false);
      expect(e2eeSafetyNumberGroups(wrong)).toEqual([]);
    }
  });

  it("quotes its entropy floor from the constant rather than a stale sentence", () => {
    expect(E2EE_SAFETY_NUMBER_CAPTION).toContain(String(E2EE_SAFETY_NUMBER_DIGITS.groups));
    expect(E2EE_SAFETY_NUMBER_CAPTION).toContain(String(E2EE_SAFETY_NUMBER_MIN_DISPLAYED_BITS));
  });

  it("never lets a rendered string carry the number itself", () => {
    // §13.4: the value "never travels in any protocol message, log, or analytics
    // surface". The complement of that — it MAY be displayed — is exactly the
    // safety-number card, which receives the groups. No message, title, caption,
    // or error may embed it, or a copied diagnostic would carry it out.
    const number = PRESENTED.safetyNumber;
    const rendered = everyRenderedString().filter(
      (value) => value !== number && !number.split(" ").includes(value),
    );
    for (const value of rendered) {
      expect(value.includes(number), value).toBe(false);
    }
  });
});

describe("§13.2 first contact, enrollment-fingerprint first", () => {
  it("removes the alternative QR path once comparison starts", () => {
    expect(shouldShowE2eeApprovalScanner("enrollment-fingerprint")).toBe(true);
    expect(shouldShowE2eeApprovalScanner("compare")).toBe(false);
    expect(shouldShowE2eeApprovalScanner("no-evidence")).toBe(false);
  });

  it("shows no safety number until the entered fingerprint matches the advertised one", () => {
    const { view } = verificationView(session());
    expect(view.stage).toBe("enrollment-fingerprint");
    expect(view.safetyNumberGroups).toEqual([]);
    // And no promotion is reachable from here at all.
    expect(view.confirm).toBeNull();
  });

  it("refuses a fingerprint that is not the one this channel advertised", () => {
    const { view } = verificationView(session(), {
      ...createE2eeVerificationDraft(),
      enteredFingerprint: PREVIOUS.fingerprint,
    });
    expect(view.stage).toBe("enrollment-fingerprint");
    expect(view.confirm).toBeNull();
  });

  it("advances to the comparison once it matches, ignoring whitespace only", () => {
    const { view } = verificationView(session(), {
      ...createE2eeVerificationDraft(),
      enteredFingerprint: `  ${PRESENTED.fingerprint}\n`,
    });
    expect(view.stage).toBe("compare");
    expect(view.safetyNumberGroups.length).toBe(12);
  });

  it("has no ceremony at all on a channel that advertised nothing (rows K23/K24)", () => {
    const { view } = verificationView(session({ presented: null }));
    expect(view.stage).toBe("no-evidence");
    expect(view.confirm).toBeNull();
    expect(view.safetyNumberGroups).toEqual([]);
  });
});

describe("the explicit user act (§13.2 step 5)", () => {
  it("offers no promotion until the owner says they compared the number", () => {
    const matched = {
      ...createE2eeVerificationDraft(),
      enteredFingerprint: PRESENTED.fingerprint,
    };
    // ABSENT, not disabled: there is no action object to fire by any route.
    expect(verificationView(session(), matched).view.confirm).toBeNull();
    expect(
      verificationView(session(), { ...matched, comparisonAcknowledged: true }).view.confirm,
    ).not.toBeNull();
  });

  it("keeps the acknowledgement a value the owner sets, never a default", () => {
    expect(createE2eeVerificationDraft().comparisonAcknowledged).toBe(false);
    const { view, read } = verificationView(session(), {
      ...createE2eeVerificationDraft(),
      enteredFingerprint: PRESENTED.fingerprint,
    });
    view.onAcknowledgeComparison(true);
    expect(read().comparisonAcknowledged).toBe(true);
  });
});

describe("§13.2.1 and §13.3: four situations, four messages", () => {
  it("gives all four distinct copy", () => {
    expect(new Set(E2EE_TRUST_SITUATION_MESSAGES).size).toBe(4);
    expect(E2EE_TRUST_SITUATION_MESSAGES).toContain(E2EE_IDENTITY_CHANGE_MESSAGE);
  });

  it("never words situation 3 as an identity change", () => {
    const situation3 = E2EE_UNEXPECTED_NODE_MESSAGES[3];
    // §13.2.1: "It MUST NOT be worded as an identity change" — nothing is being
    // contradicted, and the copy says so in as many words.
    expect(situation3).not.toContain("different identity");
    expect(situation3.toLowerCase()).not.toContain("identity changed");
    expect(situation3).toContain("contradicted");
    // §13.3's message is the one that reports a contradiction.
    expect(E2EE_IDENTITY_CHANGE_MESSAGE).toContain("different identity");
  });

  it("renders each situation's own message on the ceremony surface", () => {
    for (const situation of [1, 2, 3] as const) {
      const { view } = verificationView(
        session({ event: { kind: "unexpected-node", situation, evidence: "none" } }),
      );
      expect(view.message).toBe(E2EE_UNEXPECTED_NODE_MESSAGES[situation]);
    }
    const changed = verificationView(session({ event: { kind: "identity-change" } })).view;
    expect(changed.message).toBe(E2EE_IDENTITY_CHANGE_MESSAGE);
  });

  it("shows the previously verified pair beside the new one in situation 2, and only there", () => {
    const withPrevious = (situation: 1 | 2 | 3) =>
      verificationView(
        session({
          previouslyVerified: PREVIOUS,
          event: { kind: "unexpected-node", situation, evidence: "first-contact-statement" },
        }),
      ).view;
    const two = withPrevious(2);
    expect(two.previouslyVerified).toEqual(PREVIOUS);
    expect(two.presented).toEqual(PRESENTED);
    // Both halves are present BEFORE any pairing step: the stage is still the
    // fingerprint entry, and no promotion exists.
    expect(two.stage).toBe("enrollment-fingerprint");
    expect(two.confirm).toBeNull();
    // §13.2.1 situation 3: "no previously verified fingerprint is being
    // contradicted, so displaying one would be misleading."
    expect(withPrevious(3).previouslyVerified).toBeNull();
    expect(withPrevious(1).previouslyVerified).toBeNull();
  });
});

describe("§13.2.1: exactly two resolutions, neither of them a default", () => {
  it("offers pairing and the consent resolution where policy permits legacy", () => {
    const view = securityView(
      session({ event: { kind: "unexpected-node", situation: 1, evidence: "none" } }),
    );
    expect(view.resolutions.map((action) => action.id)).toEqual([
      "start-pairing",
      "record-legacy-consent",
    ]);
    // Neither is a default: both are actions the owner has to press, and the
    // destructive one carries its own confirmation.
    expect(view.resolutions[1]?.confirm).toBeDefined();
    expect(view.resolutions[1]?.destructive).toBe(true);
  });

  it("withholds the consent resolution where local policy forbids legacy", () => {
    const view = securityView(
      session({
        legacyPermitted: false,
        event: { kind: "unexpected-node", situation: 1, evidence: "none" },
      }),
    );
    // §12.1.1 / §13.2.1: "the consent resolution is unavailable, not defaulted".
    expect(view.resolutions.map((action) => action.id)).toEqual(["start-pairing"]);
  });

  it("never offers a latched pin the consent resolution", () => {
    const view = securityView(
      session({
        classification: { class: "latched" },
        legacyPermitted: true,
        event: { kind: "unexpected-node", situation: 1, evidence: "none" },
      }),
    );
    expect(view.resolutions.map((action) => action.id)).toEqual(["start-pairing"]);
  });

  it("offers no resolution at all where no surface was raised", () => {
    expect(securityView(session({ event: null })).resolutions).toEqual([]);
  });

  it("has no dismissal that could stand in for either resolution", () => {
    const view = securityView(
      session({ event: { kind: "unexpected-node", situation: 1, evidence: "none" } }),
    );
    const ids = Object.values(view).flatMap((value) =>
      Array.isArray(value)
        ? value.map((entry: { readonly id?: string }) => entry.id)
        : value !== null && typeof value === "object" && "id" in value
          ? [(value as { readonly id: string }).id]
          : [],
    );
    expect(ids).not.toContain("dismiss");
  });
});

describe("§13.1.1: the persistent unverified-Hub indication", () => {
  it("shows it whenever the marker is unset after reconciliation", () => {
    expect(securityView(session({ markerSet: false })).unverifiedHub).toBe(true);
  });

  it("shows it when the marker is unobtainable, and never reads that as verified", () => {
    // §4.4 forbids treating unobtainable as unset in a GUARD; for the owner-
    // visible fact the two are the same — this device can point at no verified
    // node on this Hub either way.
    expect(securityView(session({ markerSet: null })).unverifiedHub).toBe(true);
  });

  it("drops it only when the marker is genuinely set", () => {
    expect(securityView(session({ markerSet: true })).unverifiedHub).toBe(false);
  });

  it("offers no dismiss for it, in any state", () => {
    for (const markerSet of [true, false, null]) {
      const view = securityView(session({ markerSet }));
      expect("dismissUnverifiedHub" in view).toBe(false);
      expect(view.pair?.id).not.toBe("dismiss");
    }
  });

  it("keeps the §13.2 entry point beside it", () => {
    expect(securityView(session({ markerSet: false })).pair?.id).toBe("open-verification");
  });
});

describe("§13.1's release gate and §12.2's honest labelling", () => {
  it("claims nothing for an unverified pin, and names the ceremony as the whole channel", () => {
    const view = securityView(session({ channel: "unverified" }));
    expect(view.claim).toBe("pairing-only");
    expect(view.channelLabel).toBe("Not verified");
    expect(view.channelMessage.toLowerCase()).toContain("pairing ceremony and nothing else");
  });

  it("exposes no action that releases application payload from the ceremony surface", () => {
    // The UI half of the §13.1 release gate: with an `unverified` pin the app is
    // restricted to the ceremony, and the model's whole action vocabulary is
    // pairing, verifying, consenting, forgetting, and closing.
    const state = session({ channel: "unverified", event: { kind: "identity-change" } });
    const ids = [
      ...securityView(state).resolutions.map((action) => action.id),
      securityView(state).pair?.id,
      securityView(state).rePair?.id,
      verificationView(state).view.dismiss.id,
      verificationView(state, {
        ...createE2eeVerificationDraft(),
        enteredFingerprint: PRESENTED.fingerprint,
        comparisonAcknowledged: true,
      }).view.confirm?.id,
    ].filter((id) => id !== undefined);
    for (const id of ids) {
      expect([
        "start-pairing",
        "confirm-verification",
        "record-legacy-consent",
        "re-pair",
        "destroy-unreadable-trust-state",
        "open-verification",
        "dismiss",
      ]).toContain(id);
    }
  });

  it("labels a fallback channel legacy and makes no E2EE claim for it", () => {
    const view = securityView(session({ channel: "legacy" }));
    expect(view.claim).toBe("legacy");
    expect(view.channelLabel).toBe("Legacy connection");
    expect(view.channelMessage).toContain("legacy");
    expect(view.channelMessage.toLowerCase()).toContain("not encrypting");
  });

  it("makes the E2EE claim only for a verified channel", () => {
    const claims = HOSTED_E2EE_CHANNEL_STATUSES.map((channel) =>
      securityView(session({ channel })),
    );
    for (const view of claims) {
      if (view.channelMessage.includes("encrypted end to end")) {
        expect(view.claim).toBe("verified");
      }
    }
    // The POSITIVE direction too: the guard above is a conditional whose
    // antecedent is the very sentence it protects, so deleting the sentence
    // satisfied it vacuously.
    const verified = securityView(session({ channel: "verified" }));
    expect(verified.claim).toBe("verified");
    expect(verified.channelLabel).toBe("Encrypted · Verified locally");
    expect(verified.channelMessage).toContain("encrypted end to end");
    expect(verified.channelMessage).toContain("cannot read");
  });

  it("answers §2.2's web row with the claim that carries no E2EE assertion", () => {
    // The arm `claimFor` was forced to grow when `web-unsigned` entered the
    // shared union. This app is the IK initiator (§8.1) and cannot occupy the
    // row, and `e2eeSession.test.ts` proves no publisher here emits it — but
    // unreachable is not the same as unasserted: the arm answered `none` and
    // nothing said so, so changing it to `verified` — the app's strongest §2.2
    // claim — left the whole suite green.
    const view = securityView(session({ channel: "web-unsigned" }));
    expect(view.claim).toBe("none");
    // And the surface says nothing about an encrypted channel or an active-Hub
    // guarantee for it, which is the property the claim is a proxy for.
    expect(view.channelMessage).not.toContain("encrypted end to end");
    expect(view.channelMessage).not.toContain("cannot read");
    expect(view.channelLabel).not.toBe(CHANNEL_LABELS.verified);
    // WHAT `none` ACTUALLY RENDERS, pinned as the literal strings and the
    // symbol rather than as "the same as `unavailable`". `none` is not a
    // neutral value — it asserts DISCONNECTION, which is why the shared
    // vocabulary refused to fold this row into `unverified` for reporting "the
    // session unusable". Pinning the words is what makes the choice reviewable
    // instead of a name nobody expands.
    expect(view.channelLabel).toBe("No connection");
    expect(view.channelMessage).toBe("There is no node connection to describe yet.");
    expect(CLAIM_SYMBOLS[view.claim]).toBe("lock");
    // It reads exactly as the states this tier genuinely has nothing to say
    // about, and never as the pairing ceremony or a §12.2 fallback.
    expect(view.channelLabel).toBe(securityView(session({ channel: "unavailable" })).channelLabel);
    expect(view.channelMessage).toBe(
      securityView(session({ channel: "unavailable" })).channelMessage,
    );
  });

  it("describes automatic account trust without claiming local verification", () => {
    const view = securityView(
      session({ channel: "account-trusted", trustSource: "account-enrolled" }),
    );
    expect(view.claim).toBe("account-trusted");
    expect(view.channelLabel).toBe("Encrypted · Account trusted");
    expect(view.channelMessage).toContain("signed-in Ryco account");
    expect(view.channelMessage).toContain("active Hub");
    expect(view.channelMessage).not.toContain("cannot read");
  });

  it("gives every claim its own word and its own sentence", () => {
    // §2.2 forbids "a stronger claim for a weaker configuration"; two claims
    // sharing a message is that, and two sharing a label is `Encrypted` beside a
    // plaintext channel. The two legacy claims deliberately share the §12.2 WORD
    // — "legacy" is the label §12.2 mandates for both — and nothing else.
    const claims = Object.keys(CHANNEL_MESSAGES) as (keyof typeof CHANNEL_MESSAGES)[];
    expect(new Set(Object.values(CHANNEL_MESSAGES)).size).toBe(claims.length);
    expect(new Set(Object.values(CHANNEL_LABELS)).size).toBe(claims.length - 1);
    expect(CHANNEL_LABELS.legacy).toBe(CHANNEL_LABELS["legacy-no-custody"]);
    for (const claim of claims) {
      expect(CHANNEL_LABELS[claim].length).toBeGreaterThan(0);
      expect(CHANNEL_MESSAGES[claim].length).toBeGreaterThan(0);
    }
  });

  it("withholds the E2EE claim while a §13.2.1 or §13.3 surface is unresolved", () => {
    // The channel that earned the claim is closed and its pin is exactly what is
    // in question. A green "Encrypted" over an open substitution warning is the
    // strongest form of the §2.2 overclaim.
    for (const event of [
      { kind: "identity-change" },
      { kind: "unexpected-node", situation: 2, evidence: "first-contact-statement" },
    ] as const) {
      expect(securityView(session({ channel: "verified", event })).claim).not.toBe("verified");
    }
  });

  it("does not promise pairing to a device that cannot hold the §6.3 key", () => {
    const view = securityView(session({ channel: "legacy", keyCustodyUnavailable: true }));
    expect(view.claim).toBe("legacy-no-custody");
    // §12.2's word is still there…
    expect(view.channelLabel).toBe("Legacy connection");
    expect(view.channelMessage.toLowerCase()).toContain("not encrypting");
    // …and the remedy that cannot work is not.
    expect(view.channelMessage).toBe(E2EE_NO_KEY_CUSTODY_MESSAGE);
    expect(view.channelMessage).not.toContain("Pair the node to change that");
  });
});

describe("key loss (§13.1.1) and honest labelling (§2.2, §2.3, §12.2)", () => {
  it("claims no active-Hub guarantee anywhere while no node is verified", () => {
    // Every channel state the shared union carries EXCEPT the one whose whole
    // definition is a verified pin, from the enumeration rather than a copied
    // list — a member added to the union has to be answered here.
    for (const channel of HOSTED_E2EE_CHANNEL_STATUSES.filter((value) => value !== "verified")) {
      const view = securityView(session({ channel, markerSet: false, previouslyVerified: null }));
      expect(view.claim).not.toBe("verified");
      expect(view.channelMessage).not.toContain("cannot read");
      expect(view.unverifiedHub).toBe(true);
    }
  });

  it("says the state does not survive reinstall, restore, or transfer", () => {
    // §2.3: "Disclosure text MUST NOT describe native downgrade resistance as
    // surviving reinstall, restore, or device transfer."
    const message = securityView(session({ markerSet: false })).unverifiedHubMessage;
    expect(message.toLowerCase()).toContain("reinstalling ryco");
    expect(message.toLowerCase()).toContain("restoring a backup");
    expect(message.toLowerCase()).toContain("new phone");
  });

  it("makes no claim any rendered string is forbidden to make", () => {
    const forbidden = [
      // §2.3's survival claim, in the shapes a copywriter reaches for.
      /surviv\w* (a )?(reinstall|restore|backup|transfer)/i,
      /stays? verified (across|after) (a )?(reinstall|restore|transfer)/i,
      // The unmeetable explanation §11.2 forbids.
      /(because|why)[^.]{0,40}(the node|your node) (rejected|refused|declined)/i,
      /(not approved|revoked|rate limited|clock is wrong)/i,
    ];
    for (const value of everyRenderedString()) {
      for (const pattern of forbidden) {
        expect(pattern.test(value), `"${value}" matched ${String(pattern)}`).toBe(false);
      }
      // §2.2: no stronger claim for a weaker configuration. The positive claim
      // and a weak label may never occupy the same string — a negative sentence
      // about a legacy channel ("Ryco is not encrypting it end to end") is
      // exactly what §12.2 asks for and is not caught here.
      if (/\bis encrypted end[- ]to[- ]end\b/i.test(value)) {
        expect(/legacy|not verified|unencrypted/i.test(value), value).toBe(false);
      }
    }
  });

  it("is honest that a pairing attempt's outcome is not reported to this app", () => {
    const { view } = verificationView(session());
    expect(view.outcomeMessage).toContain("not told why");
  });
});

describe("§11.4 diagnostics", () => {
  it("renders each sender-local diagnostic and says none of it left the device", () => {
    const view = securityView(
      session({
        diagnostics: [
          { id: "e2ee_message_too_large", row: "local" },
          { id: "e2ee_send_unavailable", row: "local" },
          { id: "e2ee_prekey_expired", row: "local" },
          { id: "e2ee_policy_generation_regressed", row: "local" },
        ],
      }),
    );
    expect(view.diagnostics.length).toBe(4);
    expect(new Set(view.diagnostics.map((row) => row.label)).size).toBe(4);
    expect(view.diagnostics.every((row) => row.count === 1)).toBe(true);
    expect(view.diagnosticsCaption).toContain("None of it is sent anywhere");
    // And none of them names a cause the node supplied — there is none.
    for (const row of view.diagnostics) {
      expect(row.label).not.toContain("node rejected");
    }
  });

  it("renders an unknown diagnostic id as the neutral line, never as the id", () => {
    // A genuinely UNRECOGNISED id, so the `??` arm runs. `pre_key_local` is a
    // key of the table, so feeding it exercised the lookup and left the fallback
    // — the arm §11.4's bounded-copy rule exists for — unreached.
    const view = securityView(
      session({
        diagnostics: [{ id: "e2ee_unknown_future_code" as never, row: "K23" }],
      }),
    );
    const label = view.diagnostics[0]?.label ?? "";
    expect(label).toBe("This device ended a connection attempt before any key was agreed.");
    expect(label).not.toContain("e2ee_unknown_future_code");
    expect(label).not.toContain("K23");
  });

  it("maps a recognised id to its own line", () => {
    const view = securityView(session({ diagnostics: [{ id: "pre_key_local", row: "K23" }] }));
    expect(view.diagnostics[0]?.label).not.toContain("K23");
    expect(view.diagnostics[0]?.id).toContain("pre_key_local");
  });

  it("groups repeated diagnostics instead of rendering a wall of duplicate rows", () => {
    const view = securityView(
      session({
        diagnostics: Array.from({ length: 8 }, () => ({
          id: "pre_key_local" as const,
          row: "K23",
        })),
      }),
    );

    expect(view.diagnostics).toHaveLength(1);
    expect(view.diagnostics[0]).toMatchObject({
      label: "This device ended a connection attempt before any key was agreed.",
      count: 8,
    });
  });
});

describe("§13.2 step 5 actually promotes the pin", () => {
  /**
   * The only sanctioned call site of `mintE2eeOwnerVerificationDecision`, DRIVEN.
   *
   * Asserting the action object's presence proves the gate; it does not prove
   * the action does anything. `return null;` as the first statement of
   * `confirmE2eeVerification` left the whole suite green: the draft reset, the
   * event cleared and the screen popped as if the ceremony had succeeded, while
   * no pin was ever recorded and every later channel stayed release-gated.
   */
  /** Run every queued continuation of the action's fire-and-forget chain. */
  const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

  function ceremony(promote: (decision: unknown) => Promise<void>) {
    const completed = vi.fn();
    let draft: E2eeVerificationDraft = {
      ...createE2eeVerificationDraft(),
      enteredFingerprint: PRESENTED.fingerprint,
      comparisonAcknowledged: true,
    };
    const beginPairing = vi
      .spyOn(mobileE2eeTrustStore, "beginPairing")
      .mockResolvedValue({ hubOrigin: HUB, accountId: ACCOUNT, localNodeHandle: "handle-1" });
    const promoteSpy = vi.spyOn(mobileE2eeTrustStore, "promote").mockImplementation(promote);
    const render = () =>
      deriveE2eeVerificationView({
        session: session(),
        draft,
        onDraftChange: (next) => {
          draft = next;
        },
        onCompleted: completed,
        now: () => 5_000,
      });
    return {
      completed,
      beginPairing,
      promote: promoteSpy,
      run: () => render().confirm?.run(),
      draft: () => draft,
    };
  }

  it("mints a decision for the presented identity and records it", async () => {
    const test = ceremony(async () => undefined);
    test.run();
    await settle();

    expect(test.promote).toHaveBeenCalledTimes(1);
    const decision = test.promote.mock.calls[0]?.[0] as {
      readonly verifiedFingerprint: string;
      readonly verifiedIdentityPublicKey: Uint8Array;
      readonly acceptedPolicyGeneration: number;
      readonly continuityId: string;
    };
    // The key the owner compared, and the §7.1 fingerprint DERIVED from it —
    // never a value copied out of a statement field.
    expect([...decision.verifiedIdentityPublicKey]).toEqual([...NODE_PUBLIC_KEY]);
    expect(decision.verifiedFingerprint).toBe(PRESENTED.fingerprint);
    expect(decision.acceptedPolicyGeneration).toBe(4);
    expect(decision.continuityId).toBe("continuity-1");
    expect(test.completed).toHaveBeenCalledTimes(1);
    // The draft is reset, so a second press cannot re-run a completed ceremony.
    expect(test.draft().comparisonAcknowledged).toBe(false);
    vi.restoreAllMocks();
  });

  it("reports one bounded failure and completes nothing when the store refuses", async () => {
    const test = ceremony(async () => {
      throw new Error("refused");
    });
    test.run();
    await settle();

    expect(test.draft().errorMessage).toBe(E2EE_VERIFICATION_UNAVAILABLE);
    expect(test.draft().busy).toBe(false);
    expect(test.completed).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });
});

describe("one-scan cross-device approval", () => {
  const qrSession = () =>
    session({
      selection: {
        ...session().selection!,
        nodeId: `node_${"N".repeat(22)}`,
      },
      presented: {
        ...session().presented!,
        continuityId: `nct_${"C".repeat(22)}`,
      },
    });

  it("requests a pairing-only reconnect by creating only an unverified local record", async () => {
    const beginPairing = vi.spyOn(mobileE2eeTrustStore, "beginPairing").mockResolvedValue({
      hubOrigin: HUB,
      accountId: ACCOUNT,
      localNodeHandle: "handle-qr",
    });
    const promote = vi.spyOn(mobileE2eeTrustStore, "promote");
    await expect(requestE2eeApproval(qrSession())).resolves.toBeNull();
    expect(beginPairing).toHaveBeenCalledWith({
      hubOrigin: HUB,
      accountId: ACCOUNT,
      nodeId: `node_${"N".repeat(22)}`,
      environmentId: "env_1",
    });
    expect(promote).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it("promotes only a node-signed QR bound to this exact phone and current statement", async () => {
    const beginPairing = vi.spyOn(mobileE2eeTrustStore, "beginPairing").mockResolvedValue({
      hubOrigin: HUB,
      accountId: ACCOUNT,
      localNodeHandle: "handle-qr",
    });
    const promote = vi.spyOn(mobileE2eeTrustStore, "promote").mockResolvedValue();
    await expect(
      confirmE2eeApprovalQr({ session: qrSession(), payload: approvalQr(), decidedAt: 2_000 }),
    ).resolves.toBeNull();
    expect(beginPairing).toHaveBeenCalledTimes(1);
    expect(promote).toHaveBeenCalledTimes(1);
    expect(promote.mock.calls[0]?.[0]).toMatchObject({
      verifiedFingerprint: PRESENTED.fingerprint,
      approvedAt: 1_000,
      decidedAt: 2_000,
      acceptedPolicyGeneration: 4,
      continuityId: `nct_${"C".repeat(22)}`,
    });
    vi.restoreAllMocks();
  });

  it("shows nothing to compare before approval is requested", () => {
    expect(deriveE2eeApprovalComparison(qrSession())).toBeNull();
  });

  it("shows the full §13.4 number once approval is requested, never a fingerprint tail", () => {
    const requested = session({
      selection: {
        ...session().selection!,
        localNodeHandle: "handle-qr",
        localRecordState: "unverified",
      },
    });
    const comparison = deriveE2eeApprovalComparison(requested);

    // Exactly the number the node lists for this phone's pending row: the same
    // derivation over (node key, this phone's key, Hub origin, account).
    const nodeSide = deriveE2eeSafetyNumber({
      nodeIdentityPublicKey: NODE_PUBLIC_KEY,
      clientIdentityPublicKey: CLIENT_PUBLIC_KEY,
      hubOrigin: HUB,
      accountId: ACCOUNT,
    }).display;
    expect(comparison?.value).toBe(nodeSide);
    expect(comparison?.groups).toHaveLength(E2EE_SAFETY_NUMBER_DIGITS.groups);
    expect(comparison?.groups.join("")).toHaveLength(
      E2EE_SAFETY_NUMBER_DIGITS.groups * E2EE_SAFETY_NUMBER_DIGITS.digitsPerGroup,
    );
    expect(comparison?.caption).toBe(E2EE_APPROVAL_SAFETY_NUMBER_CAPTION);
    expect(comparison?.caption).not.toContain(PRESENTED.fingerprint.slice(-8));
  });

  it("withholds the number without an identity to derive it from, or once verified", () => {
    const requested = session({
      selection: {
        ...session().selection!,
        localNodeHandle: "handle-qr",
        localRecordState: "unverified",
      },
    });
    expect(deriveE2eeApprovalComparison({ ...requested, presented: null })).toBeNull();
    expect(
      deriveE2eeApprovalComparison({
        ...requested,
        selection: { ...requested.selection!, clientIdentityPublicKey: null },
      }),
    ).toBeNull();
    expect(deriveE2eeApprovalComparison({ ...requested, pinVerified: true })).toBeNull();
    // A malformed number is not shortened into something comparable.
    expect(
      deriveE2eeApprovalComparison({
        ...requested,
        presented: {
          ...requested.presented!,
          display: { ...PRESENTED, safetyNumber: "12345 67890" },
        },
      }),
    ).toBeNull();
  });

  it("warns against approving while a request waits for the node's identity", () => {
    // Request approval bumps the trust revision and the re-prepared channel
    // starts with nothing presented, so the ceremony is at `no-evidence` until
    // the node's statement validates again, and stays there for as long as the
    // node is offline or the Hub withholds it (rows K23/K24). The scanner card is
    // hidden at that stage; the request's status must not be.
    const waiting = session({
      selection: {
        ...session().selection!,
        localNodeHandle: "handle-qr",
        localRecordState: "unverified",
      },
      presented: null,
    });
    const stage = verificationView(waiting).view.stage;
    expect(stage).toBe("no-evidence");
    expect(shouldShowE2eeApprovalScanner(stage)).toBe(false);

    const status = deriveE2eeApprovalRequestStatus({
      session: waiting,
      stage,
      approvalRequested: true,
    });
    expect(status.message).toBe(E2EE_APPROVAL_AWAITING_NUMBER_MESSAGE);
    expect(status.message).toMatch(/do not approve/i);
    expect(status.message).not.toBe(E2EE_APPROVAL_INTRO_MESSAGE);
    expect(status.tone).toBe("warning");
    expect(status.comparison).toBeNull();
  });

  it("invites no approval before the node has presented an identity to request against", () => {
    const unpresented = session({ presented: null });
    const status = deriveE2eeApprovalRequestStatus({
      session: unpresented,
      stage: verificationView(unpresented).view.stage,
      approvalRequested: false,
    });
    expect(status.message).toBe(E2EE_APPROVAL_AWAITING_NODE_MESSAGE);
    expect(status.message).toMatch(/do not approve/i);
    expect(status.comparison).toBeNull();
  });

  it("offers the request, then names the full number to match once it is made", () => {
    const before = qrSession();
    expect(
      deriveE2eeApprovalRequestStatus({
        session: before,
        stage: verificationView(before).view.stage,
        approvalRequested: false,
      }),
    ).toEqual({ message: E2EE_APPROVAL_INTRO_MESSAGE, tone: "neutral", comparison: null });

    const requested = session({
      selection: {
        ...session().selection!,
        localNodeHandle: "handle-qr",
        localRecordState: "unverified",
      },
    });
    const status = deriveE2eeApprovalRequestStatus({
      session: requested,
      stage: verificationView(requested).view.stage,
      approvalRequested: true,
    });
    expect(status.message).toBe(E2EE_APPROVAL_REQUESTED_MESSAGE);
    expect(status.tone).toBe("success");
    expect(status.comparison).not.toBeNull();
    expect(status.comparison).toEqual(deriveE2eeApprovalComparison(requested));
  });

  it("claims no request for a handle whose record never sent a pairing hello", () => {
    // A legacy consent's no-pin record and a verified pin carry a handle too.
    // Neither is on Desktop's pending list, so neither may say approval was
    // requested or show a number to match against a row that does not exist.
    const legacy = session({
      selection: {
        ...session().selection!,
        localNodeHandle: "handle-legacy",
        localRecordState: "unpinned",
      },
    });
    const changedPin = session({
      selection: {
        ...session().selection!,
        localNodeHandle: "handle-pin",
        localRecordState: "verified",
      },
      pinVerified: true,
      presented: null,
      event: { kind: "identity-change" },
    });
    for (const state of [legacy, changedPin]) {
      expect(isE2eeApprovalRequested(state)).toBe(false);
      expect(deriveE2eeApprovalComparison(state)).toBeNull();
      const status = deriveE2eeApprovalRequestStatus({
        session: state,
        stage: verificationView(state).view.stage,
        approvalRequested: isE2eeApprovalRequested(state),
      });
      expect(status.message).not.toBe(E2EE_APPROVAL_REQUESTED_MESSAGE);
      expect(status.message).not.toBe(E2EE_APPROVAL_AWAITING_NUMBER_MESSAGE);
    }

    const pending = session({
      selection: {
        ...session().selection!,
        localNodeHandle: "handle-qr",
        localRecordState: "unverified",
      },
    });
    expect(isE2eeApprovalRequested(pending)).toBe(true);
  });

  it("moves a legacy consent's no-pin record into pairing when approval is requested", async () => {
    const beginPairing = vi.spyOn(mobileE2eeTrustStore, "beginPairing");
    const intoPairing = vi.spyOn(mobileE2eeTrustStore, "beginPairingForRecord").mockResolvedValue();
    const legacy = qrSession();
    await expect(
      requestE2eeApproval({
        ...legacy,
        selection: {
          ...legacy.selection!,
          localNodeHandle: "handle-legacy",
          localRecordState: "unpinned",
        },
      }),
    ).resolves.toBeNull();
    expect(intoPairing).toHaveBeenCalledWith({
      hubOrigin: HUB,
      accountId: ACCOUNT,
      localNodeHandle: "handle-legacy",
    });
    expect(beginPairing).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it("writes nothing for a request already pending, and refuses a verified pin", async () => {
    const beginPairing = vi.spyOn(mobileE2eeTrustStore, "beginPairing");
    const intoPairing = vi.spyOn(mobileE2eeTrustStore, "beginPairingForRecord");
    const base = qrSession();
    const withRecord = (localRecordState: "unverified" | "verified") => ({
      ...base,
      selection: { ...base.selection!, localNodeHandle: "handle-qr", localRecordState },
    });
    await expect(requestE2eeApproval(withRecord("unverified"))).resolves.toBeNull();
    await expect(requestE2eeApproval(withRecord("verified"))).resolves.toBe(
      E2EE_VERIFICATION_UNAVAILABLE,
    );
    expect(beginPairing).not.toHaveBeenCalled();
    expect(intoPairing).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it("withdraws only a pending request, by the selection's own handle", async () => {
    const cancelPairing = vi.spyOn(mobileE2eeTrustStore, "cancelPairing").mockResolvedValue();
    const base = qrSession();
    const withRecord = (localRecordState: "unverified" | "unpinned") => ({
      ...base,
      selection: { ...base.selection!, localNodeHandle: "handle-qr", localRecordState },
    });

    await expect(cancelE2eeApprovalRequest(withRecord("unverified"))).resolves.toBeNull();
    expect(cancelPairing).toHaveBeenCalledWith({
      hubOrigin: HUB,
      accountId: ACCOUNT,
      localNodeHandle: "handle-qr",
    });

    cancelPairing.mockClear();
    await expect(cancelE2eeApprovalRequest(withRecord("unpinned"))).resolves.toBe(
      E2EE_APPROVAL_CANCEL_UNAVAILABLE,
    );
    await expect(cancelE2eeApprovalRequest(base)).resolves.toBe(E2EE_APPROVAL_CANCEL_UNAVAILABLE);
    expect(cancelPairing).not.toHaveBeenCalled();

    cancelPairing.mockRejectedValue(new Error("refused"));
    await expect(cancelE2eeApprovalRequest(withRecord("unverified"))).resolves.toBe(
      E2EE_APPROVAL_CANCEL_UNAVAILABLE,
    );
    vi.restoreAllMocks();
  });

  it("rejects a copied code for another phone or stale statement before any trust write", async () => {
    const beginPairing = vi.spyOn(mobileE2eeTrustStore, "beginPairing");
    const promote = vi.spyOn(mobileE2eeTrustStore, "promote");
    const mismatched = qrSession();
    const failure = await confirmE2eeApprovalQr({
      session: {
        ...mismatched,
        presented: { ...mismatched.presented!, policyGeneration: 5 },
      },
      payload: approvalQr(),
      decidedAt: 2_000,
    });
    expect(failure).toContain("does not match this phone, node, account");
    expect(beginPairing).not.toHaveBeenCalled();
    expect(promote).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });
});

describe("the owner-facing confirmations say what they are confirming", () => {
  function confirmations(): readonly E2eeTrustAction[] {
    const state = session({
      selection: {
        ...session().selection!,
        localNodeHandle: "handle-1",
        localRecordState: "unverified",
      },
      event: { kind: "unexpected-node", situation: 1, evidence: "none" },
    });
    const view = securityView(state, { unreadable: true });
    return [...view.resolutions, view.rePair, view.destroyUnreadable].filter(
      (action): action is E2eeTrustAction => action !== null && action?.confirm !== undefined,
    );
  }

  it("gives each destructive action its own non-empty dialog", () => {
    const actions = confirmations();
    expect(actions.length).toBe(3);
    const titles = actions.map((action) => action.confirm!.title);
    const messages = actions.map((action) => action.confirm!.message);
    const confirmTexts = actions.map((action) => action.confirm!.confirmText);
    // Swapping one dialog for its sibling — "Forget this node's identity?" over
    // the button that consents to permanent plaintext — survived a presence
    // check. Distinctness and content are what catch it.
    expect(new Set(titles).size).toBe(3);
    expect(new Set(messages).size).toBe(3);
    for (const value of [...titles, ...messages, ...confirmTexts]) {
      expect(value.trim().length).toBeGreaterThan(0);
    }
  });

  it("names unencrypted sending, and the Hub reading it, on the consent dialog", () => {
    const consent = confirmations().find((action) => action.id === "record-legacy-consent");
    expect(consent?.confirm?.title).toBe(E2EE_LEGACY_CONSENT_TITLE);
    expect(consent?.confirm?.message).toBe(E2EE_LEGACY_CONSENT_MESSAGE);
    // §12.1.1's consent is per selection and remembered; the dialog says both,
    // plus what it costs.
    expect(E2EE_LEGACY_CONSENT_MESSAGE).toContain("unencrypted");
    expect(E2EE_LEGACY_CONSENT_MESSAGE).toContain("Hub can read it");
    expect(E2EE_LEGACY_CONSENT_MESSAGE).toContain("this node only");
  });

  it("names clearing the pin on the §13.3 re-pair dialog", () => {
    const rePair = confirmations().find((action) => action.id === "re-pair");
    expect(rePair?.confirm?.title).toBe(E2EE_REPAIR_TITLE);
    expect(rePair?.confirm?.message).toBe(E2EE_REPAIR_MESSAGE);
    expect(E2EE_REPAIR_MESSAGE).toContain("pinned identity");
    expect(E2EE_REPAIR_MESSAGE).toContain("pair it again");
  });
});

describe("§13.2.1: the resolutions are never offered without the copy that distinguishes them", () => {
  it("names the selection and the situation on the same surface as the resolutions", () => {
    for (const situation of [1, 2, 3] as const) {
      const view = securityView(
        session({ event: { kind: "unexpected-node", situation, evidence: "none" } }),
      );
      expect(view.resolutions.length).toBeGreaterThan(0);
      // §13.2.1: "MUST then show the owner an explicit surface naming the
      // selection", and "the presentation MUST distinguish the three underlying
      // situations in its copy".
      expect(view.situationTitle).toBe(E2EE_UNEXPECTED_NODE_TITLES[situation]);
      expect(view.situationMessage).toBe(E2EE_UNEXPECTED_NODE_MESSAGES[situation]);
      expect(view.nodeLabel).toBe("Studio");
    }
    const changed = securityView(session({ event: { kind: "identity-change" } }));
    expect(changed.situationTitle).toBe(E2EE_IDENTITY_CHANGE_TITLE);
    expect(changed.situationMessage).toBe(E2EE_IDENTITY_CHANGE_MESSAGE);
  });

  it("gives the four situations four headings, and never words situation 3 as a change", () => {
    const titles = [
      E2EE_UNEXPECTED_NODE_TITLES[1],
      E2EE_UNEXPECTED_NODE_TITLES[2],
      E2EE_UNEXPECTED_NODE_TITLES[3],
      E2EE_IDENTITY_CHANGE_TITLE,
    ];
    expect(new Set(titles).size).toBe(4);
    for (const title of titles) expect(title.trim().length).toBeGreaterThan(0);
    expect(E2EE_UNEXPECTED_NODE_TITLES[3].toLowerCase()).not.toContain("changed");
    expect(E2EE_UNEXPECTED_NODE_TITLES[3].toLowerCase()).not.toContain("different identity");
  });

  it("says nothing about a situation where no surface was raised", () => {
    const quiet = securityView(session({ event: null }));
    expect(quiet.situationTitle).toBeNull();
    expect(quiet.situationMessage).toBeNull();
  });
});

describe("§13.2's enrollment fingerprint, mid-entry", () => {
  it("stays silent while a correct fingerprint is still being typed", () => {
    // The mismatch sentence means "you may be talking to a node you did not mean
    // to reach". Showing it from the first keystroke of a CORRECT entry shows it
    // on every successful ceremony too, which trains reading past it.
    for (let length = 1; length < PRESENTED.fingerprint.length; length += 1) {
      const { view } = verificationView(session(), {
        ...createE2eeVerificationDraft(),
        enteredFingerprint: PRESENTED.fingerprint.slice(0, length),
      });
      expect(view.fingerprintError, `prefix of length ${length}`).toBeNull();
    }
  });

  it("says so once a complete entry disagrees", () => {
    const { view } = verificationView(session(), {
      ...createE2eeVerificationDraft(),
      enteredFingerprint: PREVIOUS.fingerprint,
    });
    expect(view.stage).toBe("enrollment-fingerprint");
    expect(view.fingerprintError).toBe(E2EE_ENROLLMENT_FINGERPRINT_MISMATCH);
  });

  it("carries no mismatch once the entry matches", () => {
    const { view } = verificationView(session(), {
      ...createE2eeVerificationDraft(),
      enteredFingerprint: PRESENTED.fingerprint,
    });
    expect(view.stage).toBe("compare");
    expect(view.fingerprintError).toBeNull();
  });
});

describe("the ceremony's own affirmation", () => {
  it("says the owner compared every group against the node's own surface", () => {
    // The sentence whose acknowledgement is the ONLY precondition for the action
    // that mints a §13.2 step 5 decision. It lived in a `.tsx` the node runner
    // cannot load, so a future edit weakening it was invisible to every test.
    expect(E2EE_COMPARISON_AFFIRMATION).toContain("every group");
    expect(E2EE_COMPARISON_AFFIRMATION.toLowerCase()).toContain("my node shows");
    expect(E2EE_COMPARISON_AFFIRMATION.toLowerCase()).toContain("the same");
  });
});

describe("the surface with no hosted plane", () => {
  it("renders nothing about E2EE at all", () => {
    const view = deriveE2eeSecurityView({
      session: session(),
      hostedModeAvailable: false,
      trustStateUnreadable: true,
      onOpenVerification: () => undefined,
      now: () => 0,
    });
    expect(view.available).toBe(false);
    expect(view.unverifiedHub).toBe(false);
    expect(view.pair).toBeNull();
    expect(view.resolutions).toEqual([]);
    expect(view.rePair).toBeNull();
    expect(view.destroyUnreadable).toBeNull();
  });
});

describe("§13.3's owner-initiated re-pair", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("is offered only for a selection this device already has a record for", () => {
    expect(securityView(session()).rePair).toBeNull();
    const withHandle = session({
      selection: {
        ...session().selection!,
        localNodeHandle: "handle-1",
        localRecordState: "unverified",
      },
    });
    const action = securityView(withHandle).rePair;
    expect(action?.id).toBe("re-pair");
    expect(action?.destructive).toBe(true);
    expect(action?.confirm?.destructive).toBe(true);
  });
});
