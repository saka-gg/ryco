import { decodeBase64Url, encodeBase64Url } from "@ryco/client-runtime/relay";
import type { NodeE2eeCapabilityVerification } from "@ryco/shared/relayE2eeCapabilityVerify";
import { e2eeKeyFingerprint, formatE2eeKeyFingerprint } from "@ryco/shared/relayE2eeKeys";
import type { NodeE2eeCapabilityStatement } from "@ryco/shared/relayE2eeTranscripts";
import { deriveE2eeSafetyNumber } from "@ryco/shared/relayE2eeVerificationDisplay";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

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

import { E2EE_TRUST_DOCUMENT_KEY, type E2eeSecureStore } from "./e2eeSecureStore";
import {
  isE2eeVerifiedPinRecord,
  resolveE2eeTrustStatementOutcome,
  resolveE2eeUnexpectedNodeSituation,
  type E2eeTrustSelection,
  type E2eeVerifiedPinRecord,
} from "./e2eeTrustModel";
import {
  makeMobileE2eeTrustStore,
  MobileE2eeTrustStoreError,
  mintE2eeOwnerLegacyConsentDecision,
  mintE2eeOwnerStrictLegacyDecision,
  mintE2eeOwnerUnresolvedLegacyConsentDecision,
  mintE2eeOwnerVerificationDecision,
  type E2eeOwnerVerificationDecision,
  type MobileE2eeTrustStore,
} from "./e2eeTrustStore";

const HUB = "https://hub.example.com";
const OTHER_HUB = "https://other.example.com";
const ACCOUNT = "acct_0123456789";
const OTHER_ACCOUNT = "acct_9876543210";

function bytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let index = 0; index < out.byteLength; index += 1) {
    out[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return out;
}

// Deterministic §16.1-style material, shared with the §13.4 suite. TEST ONLY.
const NODE_PUBLIC_KEY = bytes("03a107bff3ce10be1d70dd18e74bc09967e4d6309ba50d5f1ddc8664125531b8");
const ROTATED_NODE_FINGERPRINT = "SHA256:rotated-node-key";
const CLIENT_PUBLIC_KEY = bytes(
  "047a593180860c4037c83c12749845c8ee1424dd297fadcb895e358255d2c7d2" +
    "b2a8ca25580f2626fe579062ff1b99ff91c24a0da06fb32b5be20148c9249f5650",
);

/** The stored form of `NODE_PUBLIC_KEY` — §13.1's record keeps the key, not the number. */
const NODE_PUBLIC_KEY_B64 = encodeBase64Url(NODE_PUBLIC_KEY);
const ROTATED_NODE_PUBLIC_KEY = bytes(
  "5866666666666666666666666666666666666666666666666666666666666666",
);

function safetyNumber(hubOrigin: string, accountId: string): string {
  return deriveE2eeSafetyNumber({
    nodeIdentityPublicKey: NODE_PUBLIC_KEY,
    clientIdentityPublicKey: CLIENT_PUBLIC_KEY,
    hubOrigin,
    accountId,
  }).display;
}

// The §13.1 pin bytes and the §13.1 approval state, DERIVED HERE from the fixture
// keys rather than copied out of the implementation. The pin is the one value
// §13.3 compares a rotated identity against and §13.4 displays to the owner, so a
// build that pinned this device's own client key, a constant, or the wrong
// domain-separated fingerprint must not be able to ship green.
const NODE_FINGERPRINT = formatE2eeKeyFingerprint(
  e2eeKeyFingerprint("node-identity", NODE_PUBLIC_KEY),
);
const CLIENT_FINGERPRINT = formatE2eeKeyFingerprint(
  e2eeKeyFingerprint("client-identity", CLIENT_PUBLIC_KEY),
);

const SEEDED_INDEX = { hubOrigin: HUB, accountId: ACCOUNT, localNodeHandle: "h" };

/** A durable document holding one verified pin and no latch, as §13.1's migration case does. */
function verifiedDocument(): string {
  return JSON.stringify({
    version: 1,
    records: [
      {
        ...SEEDED_INDEX,
        state: "verified",
        nodeIdHints: [],
        verifiedFingerprint: NODE_FINGERPRINT,
        verifiedIdentityPublicKey: NODE_PUBLIC_KEY_B64,
        recordedContinuityId: "continuity-1",
        acceptedPolicyGeneration: 4,
        approvedClientFingerprint: CLIENT_FINGERPRINT,
        approvedAt: 1,
      },
    ],
    verifiedMarkerOrigins: [HUB],
  });
}

interface Harness {
  readonly entries: Map<string, string>;
  readonly log: string[];
  readonly failures: {
    get: boolean;
    set: boolean;
    remove: boolean;
    setPending: Promise<void> | null;
    setAfterWritePending: Promise<void> | null;
  };
  readonly secureStore: E2eeSecureStore;
  readonly create: () => MobileE2eeTrustStore;
}

function harness(seed?: string): Harness {
  const entries = new Map<string, string>();
  if (seed !== undefined) entries.set(E2EE_TRUST_DOCUMENT_KEY, seed);
  const log: string[] = [];
  const failures = {
    get: false,
    set: false,
    remove: false,
    setPending: null as Promise<void> | null,
    setAfterWritePending: null as Promise<void> | null,
  };
  let handle = 0;
  const secureStore: E2eeSecureStore = {
    get: async (key) => {
      log.push(`get:${key}`);
      if (failures.get) throw new Error("keychain unavailable");
      return entries.get(key) ?? null;
    },
    set: async (key, value) => {
      log.push(`set:${key}`);
      if (failures.setPending !== null) await failures.setPending;
      if (failures.set) throw new Error("keychain unavailable");
      entries.set(key, value);
      if (failures.setAfterWritePending !== null) await failures.setAfterWritePending;
    },
    remove: async (key) => {
      log.push(`remove:${key}`);
      if (failures.remove) throw new Error("keychain unavailable");
      entries.delete(key);
    },
    destroy: async () => {
      log.push("destroy");
      entries.clear();
    },
  };
  return {
    entries,
    log,
    failures,
    secureStore,
    create: () =>
      makeMobileE2eeTrustStore({
        store: secureStore,
        randomBytes: (length) => {
          handle += 1;
          return new Uint8Array(length).fill(handle);
        },
      }),
  };
}

function decisionFor(
  index: { hubOrigin: string; accountId: string; localNodeHandle: string },
  overrides: {
    readonly continuityId?: string;
    readonly acceptedPolicyGeneration?: number;
    readonly approvedAt?: number;
    readonly decidedAt?: number;
  } = {},
): E2eeOwnerVerificationDecision {
  return mintE2eeOwnerVerificationDecision({
    index,
    nodeIdentityPublicKey: NODE_PUBLIC_KEY,
    clientIdentityPublicKey: CLIENT_PUBLIC_KEY,
    comparedSafetyNumber: safetyNumber(index.hubOrigin, index.accountId),
    continuityId: overrides.continuityId ?? "continuity-1",
    acceptedPolicyGeneration: overrides.acceptedPolicyGeneration ?? 4,
    ...(overrides.approvedAt === undefined ? {} : { approvedAt: overrides.approvedAt }),
    decidedAt: overrides.decidedAt ?? 1_000,
  });
}

async function pairAndVerify(
  store: MobileE2eeTrustStore,
  input: {
    readonly hubOrigin?: string;
    readonly accountId?: string;
    readonly nodeId?: string;
    readonly environmentId?: string;
    readonly continuityId?: string;
    readonly acceptedPolicyGeneration?: number;
  } = {},
) {
  const index = await store.beginPairing({
    hubOrigin: input.hubOrigin ?? HUB,
    accountId: input.accountId ?? ACCOUNT,
    ...(input.nodeId === undefined ? {} : { nodeId: input.nodeId }),
    ...(input.environmentId === undefined ? {} : { environmentId: input.environmentId }),
  });
  await store.promote(
    decisionFor(index, {
      ...(input.continuityId === undefined ? {} : { continuityId: input.continuityId }),
      ...(input.acceptedPolicyGeneration === undefined
        ? {}
        : { acceptedPolicyGeneration: input.acceptedPolicyGeneration }),
    }),
  );
  return index;
}

function handleSelection(index: {
  hubOrigin: string;
  accountId: string;
  localNodeHandle: string;
}): E2eeTrustSelection {
  return { kind: "handle", ...index };
}

function verifiedPin(
  store: MobileE2eeTrustStore,
  index: { hubOrigin: string; accountId: string; localNodeHandle: string },
): E2eeVerifiedPinRecord {
  const record = store.resolve(handleSelection(index));
  if (record === null || !isE2eeVerifiedPinRecord(record)) throw new Error("not a verified pin");
  return record;
}

let context: Harness;

beforeEach(() => {
  context = harness();
});

describe("hydration and the cold start", () => {
  it("classifies a latched selection as unexpected before the load completes", async () => {
    // THE TRAP. §4.4: "a client … MUST NOT treat unobtainable evidence as an
    // unset latch or an unset marker." A store that answered from an empty
    // in-memory default would put the first channel after every app restart on
    // the legacy branch for a node the owner latched.
    const seeded = context.create();
    await seeded.hydrate();
    const index = await pairAndVerify(seeded);

    const cold = context.create();
    const before = await cold.classify(handleSelection(index));

    expect(before).toEqual({ class: "unexpected", clause: "unobtainable" });
    expect(cold.marker(HUB)).toEqual({ kind: "unobtainable" });
    expect(cold.strictLegacyPolicy(HUB)).toEqual({ kind: "unobtainable" });
    expect(cold.resolve(handleSelection(index))).toBeNull();

    await cold.hydrate();
    expect(await cold.classify(handleSelection(index))).toEqual({ class: "latched" });
  });

  it("never lets a latched selection reach legacy-eligible on a cold start", async () => {
    const seeded = context.create();
    await seeded.hydrate();
    const index = await pairAndVerify(seeded, { nodeId: "node-1" });

    const cold = context.create();
    const selections: readonly E2eeTrustSelection[] = [
      handleSelection(index),
      { kind: "node-id-hint", hubOrigin: HUB, accountId: ACCOUNT, nodeId: "node-1" },
      { kind: "handle", hubOrigin: HUB, accountId: OTHER_ACCOUNT, localNodeHandle: "invented" },
    ];

    for (const selection of selections) {
      expect((await cold.classify(selection)).class).toBe("unexpected");
    }
  });

  it("treats a store that will not answer as unobtainable, and retries the load", async () => {
    const seeded = context.create();
    await seeded.hydrate();
    const index = await pairAndVerify(seeded);

    const store = context.create();
    context.failures.get = true;
    await store.hydrate();
    expect(await store.classify(handleSelection(index))).toEqual({
      class: "unexpected",
      clause: "unobtainable",
    });

    context.failures.get = false;
    await store.hydrate();
    expect(await store.classify(handleSelection(index))).toEqual({ class: "latched" });
  });

  it("treats an unparseable document as unobtainable, not as a fresh install", async () => {
    const store = harness("{not json").create();
    await store.hydrate();

    expect(
      await store.classify({
        kind: "handle",
        hubOrigin: HUB,
        accountId: ACCOUNT,
        localNodeHandle: "any",
      }),
    ).toEqual({ class: "unexpected", clause: "unobtainable" });
  });

  it("refuses a document whose verified record is missing a promoted field", async () => {
    // §13.1 makes every promoted field the product of the owner's decision. A
    // record claiming `verified` without them describes no decision, and quietly
    // demoting it to `unverified` would invent one.
    const store = harness(
      JSON.stringify({
        version: 1,
        records: [
          {
            hubOrigin: HUB,
            accountId: ACCOUNT,
            localNodeHandle: "h",
            state: "verified",
            nodeIdHints: [],
            verifiedFingerprint: "SHA256:aaaa",
          },
        ],
      }),
    ).create();
    await store.hydrate();

    expect(
      await store.classify({
        kind: "handle",
        hubOrigin: HUB,
        accountId: ACCOUNT,
        localNodeHandle: "h",
      }),
    ).toEqual({ class: "unexpected", clause: "unobtainable" });
  });
});

describe("§13.1 marker reconciliation", () => {
  it("runs before the classification it would change, on a document that predates it", async () => {
    // The migration case §13.1 names: pins written by a build that had no marker.
    // Reconciliation has to run FIRST, or a selection under a second account scope
    // classifies "fresh" and takes the legacy branch — exactly the account-remint
    // hole the marker exists to close.
    const pinsOnly = harness(
      JSON.stringify({
        version: 1,
        records: [
          {
            hubOrigin: HUB,
            accountId: ACCOUNT,
            localNodeHandle: "h",
            state: "verified",
            nodeIdHints: [],
            verifiedFingerprint: "SHA256:aaaa",
            verifiedIdentityPublicKey: NODE_PUBLIC_KEY_B64,
            recordedContinuityId: "continuity-1",
            acceptedPolicyGeneration: 4,
            approvedClientFingerprint: "SHA256:cccc",
            approvedAt: 1,
            latchedAt: 1,
          },
        ],
      }),
    );
    const store = pinsOnly.create();
    await store.hydrate();
    expect(store.marker(HUB)).toEqual({ kind: "unset" });
    pinsOnly.log.length = 0;

    const classification = await store.classify({
      kind: "handle",
      hubOrigin: HUB,
      accountId: OTHER_ACCOUNT,
      localNodeHandle: "second-account",
    });

    expect(classification).toEqual({ class: "unexpected", clause: "iii" });
    // The reconciling write is the only store call the classification made, and
    // it landed before the verdict was produced.
    expect(pinsOnly.log).toEqual([`set:${E2EE_TRUST_DOCUMENT_KEY}`]);
    expect(store.marker(HUB)).toEqual({ kind: "set" });
    expect(pinsOnly.entries.get(E2EE_TRUST_DOCUMENT_KEY)).toContain(HUB);
  });

  it("only ever sets, and only where a verified pin exists", async () => {
    const store = context.create();
    await store.hydrate();
    await store.beginPairing({ hubOrigin: HUB, accountId: ACCOUNT });
    context.log.length = 0;

    await store.reconcileMarker(HUB);

    expect(store.marker(HUB)).toEqual({ kind: "unset" });
    expect(context.log).toEqual([]);
  });

  it("writes nothing when the marker is already set", async () => {
    const store = context.create();
    await store.hydrate();
    const index = await pairAndVerify(store);
    context.log.length = 0;

    await store.classify(handleSelection(index));
    await store.classify(handleSelection(index));

    expect(context.log).toEqual([]);
  });
});

describe("§13.2 step 5 promotion", () => {
  it("is the only path to a verified record, and sets the pin and the marker together", async () => {
    const store = context.create();
    await store.hydrate();
    const index = await store.beginPairing({ hubOrigin: HUB, accountId: ACCOUNT });

    const pairing = store.resolve(handleSelection(index));
    expect(pairing?.state).toBe("unverified");
    // §13.1: between step 2 and step 5 the record "holds **no** verified
    // fingerprint, **no** recorded continuity id, no accepted policy generation,
    // no latch, and no approval state". There is no field to hold them in.
    expect(Object.keys(pairing ?? {}).toSorted()).toEqual([
      "environmentId",
      "index",
      "legacyConsent",
      "nodeIdHints",
      "state",
    ]);
    expect(store.marker(HUB)).toEqual({ kind: "unset" });

    await store.promote(decisionFor(index));

    const promoted = verifiedPin(store, index);
    // §13.2 step 5 writes the pin the owner compared, and every other promoted
    // field, from the decision alone. The two fingerprints are DERIVED in this test
    // from the fixture keys and the §7.1 domain separation, so pinning the client
    // key, a constant, or the other domain fails here rather than downstream.
    expect(promoted.verifiedFingerprint).toBe(NODE_FINGERPRINT);
    expect(promoted.approval).toEqual({
      clientIdentityFingerprint: CLIENT_FINGERPRINT,
      approvedAt: 1_000,
    });
    expect(promoted.recordedContinuityId).toBe("continuity-1");
    expect(promoted.acceptedPolicyGeneration).toBe(4);
    expect(promoted.latch).toEqual({ kind: "set", setAt: 1_000 });
    expect(store.marker(HUB)).toEqual({ kind: "set" });
    expect(await store.classify(handleSelection(index))).toEqual({ class: "latched" });
  });

  it("mints a client-anchored handle of the full width, one per selection", async () => {
    // §12.1.1: the handle is "client-generated at §13.2 pairing, never Hub-supplied,
    // never derived from `nodeId`" — it is the index the whole selection-resolution
    // argument rests on, so its width is asserted rather than assumed.
    const draws: number[] = [];
    const store = makeMobileE2eeTrustStore({
      store: context.secureStore,
      randomBytes: (length) => {
        draws.push(length);
        return Uint8Array.from({ length }, (_, offset) => offset + draws.length);
      },
    });
    await store.hydrate();

    const first = await store.beginPairing({ hubOrigin: HUB, accountId: ACCOUNT });
    const second = await store.beginPairing({ hubOrigin: HUB, accountId: ACCOUNT });

    expect(draws).toEqual([16, 16]);
    expect(decodeBase64Url(first.localNodeHandle).byteLength).toBe(16);
    expect(first.localNodeHandle).not.toBe(second.localNodeHandle);
  });

  it("leaves NEITHER the pin nor the marker applied when the write crashes", async () => {
    const store = context.create();
    await store.hydrate();
    const index = await store.beginPairing({ hubOrigin: HUB, accountId: ACCOUNT });
    const durableBefore = context.entries.get(E2EE_TRUST_DOCUMENT_KEY);

    context.failures.set = true;
    await expect(store.promote(decisionFor(index))).rejects.toBeInstanceOf(
      MobileE2eeTrustStoreError,
    );
    context.failures.set = false;

    expect(store.resolve(handleSelection(index))?.state).toBe("unverified");
    expect(store.marker(HUB)).toEqual({ kind: "unset" });
    expect(context.entries.get(E2EE_TRUST_DOCUMENT_KEY)).toBe(durableBefore);

    // And the reload sees the same thing: one document, one write, no interval in
    // which the pin was verified and the marker was not.
    const reloaded = context.create();
    await reloaded.hydrate();
    expect(reloaded.resolve(handleSelection(index))?.state).toBe("unverified");
    expect(reloaded.marker(HUB)).toEqual({ kind: "unset" });
  });

  it("records node-attested approval time separately from the local scan latch", async () => {
    const store = context.create();
    await store.hydrate();
    const index = await store.beginPairing({ hubOrigin: HUB, accountId: ACCOUNT });
    await store.promote(decisionFor(index, { approvedAt: 800, decidedAt: 1_000 }));

    const promoted = verifiedPin(store, index);
    expect(promoted.approval.approvedAt).toBe(800);
    expect(promoted.latch).toEqual({ kind: "set", setAt: 1_000 });
  });

  it("refuses a node approval time later than the local owner decision", () => {
    expect(() => decisionFor(SEEDED_INDEX, { approvedAt: 1_001, decidedAt: 1_000 })).toThrow(
      MobileE2eeTrustStoreError,
    );
  });

  it("refuses a decision whose compared safety number is not the one this device derives", () => {
    // The decision cannot be built from statement material: the §13.4 value is
    // over BOTH identity keys and the namespace, and a statement carries only the
    // node's key.
    expect(() =>
      mintE2eeOwnerVerificationDecision({
        index: { hubOrigin: HUB, accountId: ACCOUNT, localNodeHandle: "h" },
        nodeIdentityPublicKey: NODE_PUBLIC_KEY,
        clientIdentityPublicKey: CLIENT_PUBLIC_KEY,
        comparedSafetyNumber: safetyNumber(HUB, OTHER_ACCOUNT),
        continuityId: "continuity-1",
        acceptedPolicyGeneration: 4,
        decidedAt: 1,
      }),
    ).toThrow(MobileE2eeTrustStoreError);
  });

  it("does not make strict mode a silent consequence of the first verified pin", async () => {
    const store = context.create();
    await store.hydrate();

    await pairAndVerify(store);

    expect(store.strictLegacyPolicy(HUB)).toEqual({ kind: "permitted" });
  });
});

describe("§12.1 latch set condition", () => {
  it("is set by a completed ceremony", async () => {
    const store = context.create();
    await store.hydrate();

    const index = await pairAndVerify(store);

    expect(verifiedPin(store, index).latch).toEqual({ kind: "set", setAt: 1_000 });
  });

  it("is re-armed by authenticating a statement to an already-verified pin", async () => {
    // §12.1's OTHER native set condition, observable only on a verified pin that
    // is not already latched — which a promotion never leaves behind. A document
    // written without `latchedAt` is that state, and it is the one §13.1.1 warns
    // about: without the re-arm the selection classifies unexpected clause (i)
    // forever, and with a recorded consent it classifies legacy-eligible branch
    // (b) — a permanent plaintext downgrade on a node the owner verified.
    const restored = harness(verifiedDocument()).create();
    await restored.hydrate();
    expect(verifiedPin(restored, SEEDED_INDEX).latch).toEqual({ kind: "unset" });

    await restored.recordAuthenticatedStatement({
      index: SEEDED_INDEX,
      anchor: "pin-unchanged",
      identityPublicKey: NODE_PUBLIC_KEY,
      identityFingerprint: NODE_FINGERPRINT,
      policyGeneration: 4,
      observedAt: 2_000,
    });

    expect(verifiedPin(restored, SEEDED_INDEX).latch).toEqual({ kind: "set", setAt: 2_000 });
    expect(await restored.classify(handleSelection(SEEDED_INDEX))).toEqual({ class: "latched" });
  });

  it("is not set by validating a self-signed first-contact statement", async () => {
    const store = context.create();
    await store.hydrate();
    const index = await store.beginPairing({ hubOrigin: HUB, accountId: ACCOUNT });

    // §12.1: "Merely validating a self-signed first-contact statement MUST NOT
    // set the latch, exactly as it MUST NOT set a trusted pin." An unverified
    // record has no anchor a statement could have authenticated against, so the
    // call has no record to write into.
    await expect(
      store.recordAuthenticatedStatement({
        index,
        anchor: "pin-unchanged",
        identityPublicKey: NODE_PUBLIC_KEY,
        identityFingerprint: "SHA256:aaaa",
        policyGeneration: 4,
        observedAt: 2_000,
      }),
    ).rejects.toBeInstanceOf(MobileE2eeTrustStoreError);
    expect(store.resolve(handleSelection(index))?.state).toBe("unverified");
  });

  it("is not set by a matching continuity id alone", async () => {
    const store = context.create();
    await store.hydrate();
    const pairing = await store.beginPairing({ hubOrigin: HUB, accountId: ACCOUNT });
    context.log.length = 0;

    // The id a first-contact statement carries, offered for the selection the
    // owner is still pairing. §12.1: "A matching continuity id (§7.5) never
    // satisfies this condition."
    const initial = {
      class: "unexpected",
      clause: "i",
      record: "unverified",
      scope: { kind: "fresh" },
    } as const;
    const tightened = await store.tightenWithContinuityId({
      hubOrigin: HUB,
      accountId: ACCOUNT,
      continuityId: "continuity-1",
      initial,
    });

    // It is a read: nothing was written, no record was promoted, and no class
    // moved to latched.
    expect(context.log).toEqual([]);
    expect(tightened).toEqual(initial);
    expect(store.resolve(handleSelection(pairing))?.state).toBe("unverified");
  });

  it("is reached by a late continuity id that matches the id the ceremony recorded", async () => {
    // The positive half of §12.1.1's late resolution: the anchor it matches
    // against is the id the promotion recorded, so a Hub that suppresses the
    // node-id hint still cannot keep a latched pin unresolved.
    const store = context.create();
    await store.hydrate();
    await pairAndVerify(store, { continuityId: "continuity-7" });

    expect(
      await store.tightenWithContinuityId({
        hubOrigin: HUB,
        accountId: ACCOUNT,
        continuityId: "continuity-7",
        initial: { class: "legacy-eligible", branch: "a" },
      }),
    ).toEqual({ class: "latched" });
    // And an id the ceremony never recorded resolves nothing.
    expect(
      await store.tightenWithContinuityId({
        hubOrigin: HUB,
        accountId: ACCOUNT,
        continuityId: "continuity-8",
        initial: { class: "legacy-eligible", branch: "a" },
      }),
    ).toEqual({ class: "unexpected", clause: "ii" });
  });
});

describe("§13.3 rotation and re-verification", () => {
  it("updates the pin silently, carrying the latch, the generation and the approval", async () => {
    const store = context.create();
    await store.hydrate();
    const index = await pairAndVerify(store, { acceptedPolicyGeneration: 4 });
    const before = verifiedPin(store, index);
    expect(before.verifiedFingerprint).toBe(NODE_FINGERPRINT);

    await store.recordAuthenticatedStatement({
      index,
      anchor: "pin-updated",
      identityPublicKey: ROTATED_NODE_PUBLIC_KEY,
      identityFingerprint: ROTATED_NODE_FINGERPRINT,
      policyGeneration: 6,
      observedAt: 3_000,
    });

    const after = verifiedPin(store, index);
    expect(after.verifiedFingerprint).toBe(ROTATED_NODE_FINGERPRINT);
    expect(after.latch).toEqual({ kind: "set", setAt: 1_000 });
    expect(after.approval).toEqual({
      clientIdentityFingerprint: CLIENT_FINGERPRINT,
      approvedAt: 1_000,
    });
    expect(after.recordedContinuityId).toBe("continuity-1");
    expect(after.acceptedPolicyGeneration).toBe(6);
    // The channel stays latched, and no surface is raised: §13.3's whole point is
    // that a legitimate rotation "MUST NOT surface a re-verification prompt".
    expect(await store.classify(handleSelection(index))).toEqual({ class: "latched" });
    expect(
      resolveE2eeUnexpectedNodeSituation({ class: "latched" }, { kind: "first-contact-statement" }),
    ).toBeNull();
  });

  it("never lowers the remembered policy generation", async () => {
    const store = context.create();
    await store.hydrate();
    const index = await pairAndVerify(store, { acceptedPolicyGeneration: 9 });

    await store.recordAuthenticatedStatement({
      index,
      anchor: "pin-unchanged",
      identityPublicKey: NODE_PUBLIC_KEY,
      identityFingerprint: NODE_FINGERPRINT,
      policyGeneration: 2,
      observedAt: 3_000,
    });

    expect(verifiedPin(store, index).acceptedPolicyGeneration).toBe(9);
  });

  it("leaves the pin alone under the unchanged anchor, whatever fingerprint arrives", async () => {
    // §13.3's anchor is what decides a re-pin, and only `pin-updated` verified a
    // chain to the new key. A statement's carried fingerprint under `pin-unchanged`
    // is a value the §5.2 verdict never anchored to this record, so it must not
    // reach the pin the owner compared.
    const store = context.create();
    await store.hydrate();
    const index = await pairAndVerify(store);

    await store.recordAuthenticatedStatement({
      index,
      anchor: "pin-unchanged",
      identityPublicKey: NODE_PUBLIC_KEY,
      identityFingerprint: ROTATED_NODE_FINGERPRINT,
      policyGeneration: 5,
      observedAt: 3_000,
    });

    expect(verifiedPin(store, index).verifiedFingerprint).toBe(NODE_FINGERPRINT);
  });

  it("persists the accepted policy generation across a restart", async () => {
    const store = context.create();
    await store.hydrate();
    const index = await pairAndVerify(store, { acceptedPolicyGeneration: 7 });

    // A round trip through the durable document, not an in-memory field: §5.7's
    // rollback resistance is worth nothing if it dies with the process.
    const restarted = context.create();
    await restarted.hydrate();

    const record = verifiedPin(restarted, index);
    expect(record.acceptedPolicyGeneration).toBe(7);
    // The whole promoted record survives the round trip, not only the generation.
    expect(record.verifiedFingerprint).toBe(NODE_FINGERPRINT);
    expect(record.recordedContinuityId).toBe("continuity-1");
    expect(record.approval).toEqual({
      clientIdentityFingerprint: CLIENT_FINGERPRINT,
      approvedAt: 1_000,
    });
  });

  it("updates no pin on a chain failure, and neither prompts nor re-verifies on a regression", async () => {
    const store = context.create();
    await store.hydrate();
    const index = await pairAndVerify(store, { acceptedPolicyGeneration: 5 });
    const before = store.resolve(handleSelection(index));
    context.log.length = 0;

    // What the §4.4 mode machine will do with a §5.2 verdict. Only the two
    // anchors that authenticated to the pin have a store mutator to reach; the
    // §13.3 identity event and the §5.7 regression have none, which is the point.
    const apply = async (verification: NodeE2eeCapabilityVerification) => {
      const outcome = resolveE2eeTrustStatementOutcome(verification);
      if (outcome.kind === "pin-authenticated" || outcome.kind === "pin-rotated") {
        await store.recordAuthenticatedStatement({
          index,
          anchor: outcome.kind === "pin-rotated" ? "pin-updated" : "pin-unchanged",
          identityPublicKey: ROTATED_NODE_PUBLIC_KEY,
          identityFingerprint: ROTATED_NODE_FINGERPRINT,
          policyGeneration: 1,
          observedAt: 4_000,
        });
      }
      return outcome;
    };

    // §13.3: a chain failure is channel-fatal and surfaces the re-verification
    // UI, and "requires a fresh §13.2 ceremony before any application payload
    // flows to the new identity" — it does not re-pin.
    expect(
      await apply({
        kind: "identity-event",
        event: { reason: "continuity_chain", failure: "pin_not_reached" },
        statement: {} as NodeE2eeCapabilityStatement,
      }),
    ).toEqual({
      kind: "re-verification-required",
      event: { reason: "continuity_chain", failure: "pin_not_reached" },
    });

    // §13.3: "A **policy-generation** regression is deliberately _not_ on this
    // list … because a Hub can replay a genuine older statement on demand."
    expect(await apply({ kind: "invalid", reason: "policy_generation_regressed" })).toEqual({
      kind: "diagnostic-only",
      diagnostic: "e2ee_policy_generation_regressed",
    });

    expect(context.log).toEqual([]);
    expect(store.resolve(handleSelection(index))).toEqual(before);
  });

  it("exposes no generation, latch, or rotated pin before the durable write settles", async () => {
    const local = harness(verifiedDocument());
    const store = local.create();
    await store.hydrate();
    const before = verifiedPin(store, SEEDED_INDEX);
    expect(before.latch).toEqual({ kind: "unset" });

    let release!: () => void;
    local.failures.setPending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const mutation = store.recordAuthenticatedStatement({
      index: SEEDED_INDEX,
      anchor: "pin-updated",
      identityPublicKey: ROTATED_NODE_PUBLIC_KEY,
      identityFingerprint: ROTATED_NODE_FINGERPRINT,
      policyGeneration: 6,
      observedAt: 3_000,
    });
    await Promise.resolve();

    expect(verifiedPin(store, SEEDED_INDEX)).toEqual(before);
    const coldDuringWrite = local.create();
    await coldDuringWrite.hydrate();
    expect(verifiedPin(coldDuringWrite, SEEDED_INDEX)).toEqual(before);

    release();
    await mutation;
    const after = verifiedPin(store, SEEDED_INDEX);
    expect(after).toMatchObject({
      verifiedFingerprint: ROTATED_NODE_FINGERPRINT,
      acceptedPolicyGeneration: 6,
      latch: { kind: "set", setAt: 3_000 },
    });
    const restarted = local.create();
    await restarted.hydrate();
    expect(verifiedPin(restarted, SEEDED_INDEX)).toEqual(after);
  });

  it("keeps the previous complete generation, latch, and pin when the write rejects", async () => {
    const local = harness(verifiedDocument());
    const store = local.create();
    await store.hydrate();
    const before = verifiedPin(store, SEEDED_INDEX);
    local.failures.set = true;

    await expect(
      store.recordAuthenticatedStatement({
        index: SEEDED_INDEX,
        anchor: "pin-updated",
        identityPublicKey: ROTATED_NODE_PUBLIC_KEY,
        identityFingerprint: ROTATED_NODE_FINGERPRINT,
        policyGeneration: 6,
        observedAt: 3_000,
      }),
    ).rejects.toMatchObject({ code: "trust_store_unavailable" });

    expect(verifiedPin(store, SEEDED_INDEX)).toEqual(before);
    const restarted = local.create();
    await restarted.hydrate();
    expect(verifiedPin(restarted, SEEDED_INDEX)).toEqual(before);
  });

  it("recovers the durable generation and pin after a crash before in-memory adoption", async () => {
    const local = harness(verifiedDocument());
    const store = local.create();
    await store.hydrate();
    const before = verifiedPin(store, SEEDED_INDEX);

    let release!: () => void;
    local.failures.setAfterWritePending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const mutation = store.recordAuthenticatedStatement({
      index: SEEDED_INDEX,
      anchor: "pin-updated",
      identityPublicKey: ROTATED_NODE_PUBLIC_KEY,
      identityFingerprint: ROTATED_NODE_FINGERPRINT,
      policyGeneration: 6,
      observedAt: 3_000,
    });
    await vi.waitFor(() => {
      expect(local.entries.get(E2EE_TRUST_DOCUMENT_KEY)).not.toBe(verifiedDocument());
    });

    // The secure-store write has landed, but its promise has not returned to
    // `commit`, so this process has not adopted the replacement document.
    expect(verifiedPin(store, SEEDED_INDEX)).toEqual(before);
    const restarted = local.create();
    await restarted.hydrate();
    expect(verifiedPin(restarted, SEEDED_INDEX)).toMatchObject({
      verifiedFingerprint: ROTATED_NODE_FINGERPRINT,
      acceptedPolicyGeneration: 6,
      latch: { kind: "set", setAt: 3_000 },
    });

    release();
    await mutation;
  });

  it("keeps authenticated trust advances isolated to their durable selection", async () => {
    const store = context.create();
    await store.hydrate();
    const first = await pairAndVerify(store, {
      nodeId: "node-a",
      acceptedPolicyGeneration: 4,
    });
    const second = await pairAndVerify(store, {
      nodeId: "node-b",
      acceptedPolicyGeneration: 9,
    });
    const secondBefore = verifiedPin(store, second);

    await store.recordAuthenticatedStatement({
      index: first,
      anchor: "pin-updated",
      identityPublicKey: ROTATED_NODE_PUBLIC_KEY,
      identityFingerprint: ROTATED_NODE_FINGERPRINT,
      policyGeneration: 6,
      observedAt: 3_000,
    });

    expect(verifiedPin(store, first)).toMatchObject({
      verifiedFingerprint: ROTATED_NODE_FINGERPRINT,
      acceptedPolicyGeneration: 6,
    });
    expect(verifiedPin(store, second)).toEqual(secondBefore);
    const restarted = context.create();
    await restarted.hydrate();
    expect(verifiedPin(restarted, first).verifiedFingerprint).toBe(ROTATED_NODE_FINGERPRINT);
    expect(verifiedPin(restarted, second)).toEqual(secondBefore);
  });

  it("clears the whole selection and the marker on the owner-initiated re-pair", async () => {
    const store = context.create();
    await store.hydrate();
    const first = await pairAndVerify(store);
    const second = await pairAndVerify(store, { accountId: OTHER_ACCOUNT });

    await store.clearSelection(first);
    // §13.3: the marker stays set "while any other verified pin remains".
    expect(store.marker(HUB)).toEqual({ kind: "set" });
    expect(store.resolve(handleSelection(first))).toBeNull();

    await store.clearSelection(second);
    expect(store.marker(HUB)).toEqual({ kind: "unset" });
  });
});

describe("§12.1.1 owner legacy consent", () => {
  it("is never recorded by a repeated classification, a retry, or a timeout", async () => {
    const store = context.create();
    await store.hydrate();
    const index = await store.beginPairing({ hubOrigin: HUB, accountId: ACCOUNT });
    context.log.length = 0;

    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(await store.classify(handleSelection(index))).toEqual({
        class: "unexpected",
        clause: "i",
        record: "unverified",
        scope: { kind: "fresh" },
      });
    }

    expect(context.log).toEqual([]);
    expect(store.resolve(handleSelection(index))?.legacyConsent).toEqual({ kind: "absent" });
  });

  it("is refused for a latched pin", async () => {
    const store = context.create();
    await store.hydrate();
    const index = await pairAndVerify(store);

    await expect(
      store.recordLegacyConsent(mintE2eeOwnerLegacyConsentDecision({ index, decidedAt: 9 })),
    ).rejects.toMatchObject({ code: "trust_store_selection_latched" });
  });

  it("is durable and applies to one selection only", async () => {
    const store = context.create();
    await store.hydrate();
    const consented = await store.beginPairing({ hubOrigin: HUB, accountId: ACCOUNT });
    const other = await store.beginPairing({ hubOrigin: HUB, accountId: ACCOUNT });

    await store.recordLegacyConsent(
      mintE2eeOwnerLegacyConsentDecision({ index: consented, decidedAt: 9 }),
    );

    const restarted = context.create();
    await restarted.hydrate();
    expect(await restarted.classify(handleSelection(consented))).toEqual({
      class: "legacy-eligible",
      branch: "b",
    });
    expect(await restarted.classify(handleSelection(other))).toEqual({
      class: "unexpected",
      clause: "i",
      record: "unverified",
      scope: { kind: "fresh" },
    });
  });

  it("records the consent on §13.1's no-pin record when the selection has none", async () => {
    // §13.2.1 situation 1's second resolution, for the selections that raise it
    // most often: §12.1.1 clauses (ii) and (iii) resolve to no record at all.
    // §13.1's third shape is what it writes — "a record may also exist with no pin
    // at all — holding only the handle, the hints, and an owner legacy consent" —
    // rather than a pairing record for a §13.2 ceremony the owner did not start.
    const store = context.create();
    await store.hydrate();
    await pairAndVerify(store);

    const index = await store.recordUnresolvedLegacyConsent(
      mintE2eeOwnerUnresolvedLegacyConsentDecision({
        hubOrigin: HUB,
        accountId: OTHER_ACCOUNT,
        nodeId: "node-9",
        decidedAt: 12,
      }),
    );

    expect(store.resolve(handleSelection(index))).toEqual({
      index,
      state: "none",
      nodeIdHints: ["node-9"],
      legacyConsent: { kind: "recorded", recordedAt: 12 },
      environmentId: null,
    });
    // It is durable, and it claims §12.1.1 branch (b) for that selection alone —
    // the owner's own handle, never the id the Hub presented.
    const restarted = context.create();
    await restarted.hydrate();
    expect(await restarted.classify(handleSelection(index))).toEqual({
      class: "legacy-eligible",
      branch: "b",
    });
    expect(
      await restarted.classify({
        kind: "node-id-hint",
        hubOrigin: HUB,
        accountId: OTHER_ACCOUNT,
        nodeId: "node-9",
      }),
    ).toEqual({
      class: "unexpected",
      clause: "i",
      record: "unpinned",
      scope: { kind: "origin-verified" },
    });
  });
});

describe("§13.2 step 2 for a selection that already has a record", () => {
  it("moves a legacy consent's no-pin record into pairing, keeping what the owner recorded", async () => {
    const store = context.create();
    await store.hydrate();
    const index = await store.recordUnresolvedLegacyConsent(
      mintE2eeOwnerUnresolvedLegacyConsentDecision({
        hubOrigin: HUB,
        accountId: ACCOUNT,
        nodeId: "node-9",
        environmentId: "env-9",
        decidedAt: 12,
      }),
    );

    await store.beginPairingForRecord(index);

    // The same handle, so the session's index stays valid, and §13.1's
    // pairing shape: no fingerprint, no continuity id, no latch, no approval.
    expect(store.resolve(handleSelection(index))).toEqual({
      index,
      state: "unverified",
      nodeIdHints: ["node-9"],
      legacyConsent: { kind: "recorded", recordedAt: 12 },
      environmentId: "env-9",
    });
    expect(store.marker(HUB)).toEqual({ kind: "unset" });
    const restarted = context.create();
    await restarted.hydrate();
    expect(restarted.resolve(handleSelection(index))?.state).toBe("unverified");
  });

  it("leaves a record already in pairing untouched", async () => {
    const store = context.create();
    await store.hydrate();
    const index = await store.beginPairing({ hubOrigin: HUB, accountId: ACCOUNT });
    const revision = store.revision();
    context.log.length = 0;

    await store.beginPairingForRecord(index);

    expect(context.log).toEqual([]);
    expect(store.revision()).toBe(revision);
  });

  it("never moves a verified pin back into pairing", async () => {
    const store = context.create();
    await store.hydrate();
    const index = await pairAndVerify(store);

    await expect(store.beginPairingForRecord(index)).rejects.toMatchObject({
      code: "trust_store_selection_verified",
    });
    expect(verifiedPin(store, index).latch.kind).toBe("set");
  });
});

describe("§12.1.1 strict legacy policy", () => {
  it("is recorded and evaluated under the Hub origin alone", async () => {
    const store = context.create();
    await store.hydrate();
    await pairAndVerify(store, { accountId: OTHER_ACCOUNT });

    await store.setStrictLegacyPolicy(
      mintE2eeOwnerStrictLegacyDecision({ hubOrigin: HUB, policy: "forbid", decidedAt: 11 }),
    );

    expect(store.strictLegacyPolicy(HUB)).toEqual({ kind: "forbidden", recordedAt: 11 });
    expect(store.strictLegacyPolicy(OTHER_HUB)).toEqual({ kind: "permitted" });

    // It survives a restart, and it is not keyed on an account scope: there is no
    // account-scoped read to lose it to.
    const restarted = context.create();
    await restarted.hydrate();
    expect(restarted.strictLegacyPolicy(HUB)).toEqual({ kind: "forbidden", recordedAt: 11 });

    await restarted.setStrictLegacyPolicy(
      mintE2eeOwnerStrictLegacyDecision({ hubOrigin: HUB, policy: "permit", decidedAt: 12 }),
    );
    expect(restarted.strictLegacyPolicy(HUB)).toEqual({ kind: "permitted" });
  });
});

describe("§13.2.1 substituted-node surfaces", () => {
  it("presents a first-contact statement under an account holding a verified pin as situation 2", async () => {
    const store = context.create();
    await store.hydrate();
    await pairAndVerify(store);

    const classification = await store.classify({
      kind: "handle",
      hubOrigin: HUB,
      accountId: ACCOUNT,
      localNodeHandle: "presented-by-the-hub",
    });

    expect(classification).toEqual({ class: "unexpected", clause: "ii" });
    expect(
      resolveE2eeUnexpectedNodeSituation(classification, { kind: "first-contact-statement" }),
    ).toBe(2);
  });

  it("presents an unseen account scope on a verified Hub origin as situation 3", async () => {
    const store = context.create();
    await store.hydrate();
    await pairAndVerify(store);

    const classification = await store.classify({
      kind: "handle",
      hubOrigin: HUB,
      accountId: OTHER_ACCOUNT,
      localNodeHandle: "second-account",
    });

    expect(classification).toEqual({ class: "unexpected", clause: "iii" });
    expect(
      resolveE2eeUnexpectedNodeSituation(classification, { kind: "first-contact-statement" }),
    ).toBe(3);
  });
});

describe("§13.1.1 durable trust loss", () => {
  it("reconstructs nothing from anything the Hub supplies", async () => {
    const seeded = context.create();
    await seeded.hydrate();
    const index = await pairAndVerify(seeded, {
      nodeId: "node-1",
      continuityId: "continuity-1",
      environmentId: "env-a",
    });

    // §6.3's purge: the device-only namespace is gone. Everything §13.1 made
    // durable went with it.
    await context.secureStore.destroy();
    const store = context.create();
    await store.hydrate();
    await store.reconcileMarker(HUB);

    expect(store.marker(HUB)).toEqual({ kind: "unset" });
    expect(store.resolve(handleSelection(index))).toBeNull();

    const hubSupplied: readonly E2eeTrustSelection[] = [
      handleSelection(index),
      { kind: "node-id-hint", hubOrigin: HUB, accountId: ACCOUNT, nodeId: "node-1" },
      { kind: "handle", hubOrigin: HUB, accountId: OTHER_ACCOUNT, localNodeHandle: "anything" },
    ];
    for (const selection of hubSupplied) {
      // §13.1.1: it "behaves as a fresh install: every selection classifies as
      // genuine first contact" — which is branch (a), and only branch (a).
      expect(await store.classify(selection)).toEqual({ class: "legacy-eligible", branch: "a" });
    }

    // Not even the continuity id it recorded before the loss re-anchors anything.
    expect(
      await store.tightenWithContinuityId({
        hubOrigin: HUB,
        accountId: ACCOUNT,
        continuityId: "continuity-1",
        initial: { class: "legacy-eligible", branch: "a" },
      }),
    ).toEqual({ class: "legacy-eligible", branch: "a" });
  });
});

describe("owner-driven cleanup", () => {
  it("clears every record, latch, consent, marker and policy under a Hub origin", async () => {
    const store = context.create();
    await store.hydrate();
    const kept = await pairAndVerify(store, { hubOrigin: OTHER_HUB });
    const cleared = await pairAndVerify(store);
    const consented = await store.beginPairing({ hubOrigin: HUB, accountId: OTHER_ACCOUNT });
    await store.recordLegacyConsent(
      mintE2eeOwnerLegacyConsentDecision({ index: consented, decidedAt: 3 }),
    );
    await store.setStrictLegacyPolicy(
      mintE2eeOwnerStrictLegacyDecision({ hubOrigin: HUB, policy: "forbid", decidedAt: 4 }),
    );

    await store.forgetHubOrigin(HUB);

    expect(store.resolve(handleSelection(cleared))).toBeNull();
    expect(store.resolve(handleSelection(consented))).toBeNull();
    expect(store.marker(HUB)).toEqual({ kind: "unset" });
    expect(store.strictLegacyPolicy(HUB)).toEqual({ kind: "permitted" });
    // The other Hub origin is untouched.
    expect(store.marker(OTHER_HUB)).toEqual({ kind: "set" });
    expect(await store.classify(handleSelection(kept))).toEqual({ class: "latched" });
  });

  it("clears the records the owner forgot a node by, and the marker they backed", async () => {
    const store = context.create();
    await store.hydrate();
    const forgotten = await pairAndVerify(store, { environmentId: "env-a" });
    const kept = await pairAndVerify(store, { accountId: OTHER_ACCOUNT, environmentId: "env-b" });

    await store.forgetEnvironment("env-a");

    expect(store.resolve(handleSelection(forgotten))).toBeNull();
    expect(store.marker(HUB)).toEqual({ kind: "set" });

    await store.forgetEnvironment("env-b");
    expect(store.resolve(handleSelection(kept))).toBeNull();
    expect(store.marker(HUB)).toEqual({ kind: "unset" });
  });

  it("refuses to discard state it merely could not read", async () => {
    const store = context.create();
    context.failures.get = true;
    await store.hydrate();

    await expect(store.forgetHubOrigin(HUB)).rejects.toMatchObject({
      code: "trust_store_unavailable",
    });
    await expect(store.destroyUnreadableTrustState()).rejects.toMatchObject({
      code: "trust_store_unavailable",
    });
    expect(context.log).not.toContain(`remove:${E2EE_TRUST_DOCUMENT_KEY}`);
  });

  it("writes nothing when no record was recorded under the environment", async () => {
    const store = context.create();
    await store.hydrate();
    await pairAndVerify(store, { environmentId: "env-a" });
    context.log.length = 0;

    await store.forgetEnvironment("env-b");

    expect(context.log).toEqual([]);
  });

  it("never widens a scoped forget into a whole-namespace wipe", async () => {
    // The chain this closes: an unreadable document (a truncated keychain value,
    // or one field the writer let through), then the ordinary "forget this node"
    // action. Removing the document whole clears the `anyNodeVerified` marker for
    // every Hub origin — including origins the owner never named — and §13.1 clears
    // it only by "the explicit owner action that removes the last verified pin
    // under that `hubOrigin`". Losing it returns every selection on the device to
    // legacy-eligible branch (a), which is row K13's plaintext flush.
    const corrupted = harness("{not json");
    const store = corrupted.create();
    await store.hydrate();

    await expect(store.forgetEnvironment("env-a")).rejects.toMatchObject({
      code: "trust_store_unavailable",
    });
    await expect(store.forgetHubOrigin(HUB)).rejects.toMatchObject({
      code: "trust_store_unavailable",
    });

    expect(corrupted.log).not.toContain(`remove:${E2EE_TRUST_DOCUMENT_KEY}`);
    expect(corrupted.entries.get(E2EE_TRUST_DOCUMENT_KEY)).toBe("{not json");
    // The device stays fail-closed until the owner asks for the destruction in as
    // many words: §4.4's `unobtainable`, never a fresh install.
    expect(await store.classify(handleSelection(SEEDED_INDEX))).toEqual({
      class: "unexpected",
      clause: "unobtainable",
    });

    await store.destroyUnreadableTrustState();

    expect(corrupted.entries.has(E2EE_TRUST_DOCUMENT_KEY)).toBe(false);
    expect(await store.classify(handleSelection(SEEDED_INDEX))).toEqual({
      class: "legacy-eligible",
      branch: "a",
    });
  });
});

describe("§13.1 node-id hints", () => {
  it("keeps at most the specified number, oldest first, and authorizes nothing", async () => {
    const store = context.create();
    await store.hydrate();
    const index = await pairAndVerify(store, { nodeId: "node-0" });

    for (let seq = 1; seq <= 10; seq += 1) {
      await store.recordNodeIdHint(index, `node-${seq}`);
    }

    const record = store.resolve(handleSelection(index));
    expect(record?.nodeIdHints).toEqual([
      "node-3",
      "node-4",
      "node-5",
      "node-6",
      "node-7",
      "node-8",
      "node-9",
      "node-10",
    ]);
    // An evicted hint stops resolving, which lands the channel in the unexpected
    // class — §12.1.1's "a Hub that suppresses a hint produces _no_ resolution".
    expect(
      await store.classify({
        kind: "node-id-hint",
        hubOrigin: HUB,
        accountId: ACCOUNT,
        nodeId: "node-0",
      }),
    ).toEqual({ class: "unexpected", clause: "ii" });
  });

  it("records the id the pairing started under, and resolves a selection by it", async () => {
    const store = context.create();
    await store.hydrate();
    const index = await pairAndVerify(store, { nodeId: "node-0" });

    expect(store.resolve(handleSelection(index))?.nodeIdHints).toEqual(["node-0"]);
    expect(
      await store.classify({
        kind: "node-id-hint",
        hubOrigin: HUB,
        accountId: ACCOUNT,
        nodeId: "node-0",
      }),
    ).toEqual({ class: "latched" });
  });

  it("does not let a repeated id evict the hints already recorded", async () => {
    // A Hub re-sending one id would otherwise fill the whole ring with copies of
    // it and evict every other hint on the record, so a later selection by a
    // genuine id stops resolving.
    const store = context.create();
    await store.hydrate();
    const index = await pairAndVerify(store, { nodeId: "node-0" });
    await store.recordNodeIdHint(index, "node-1");
    context.log.length = 0;

    for (let repeat = 0; repeat < 10; repeat += 1) {
      await store.recordNodeIdHint(index, "node-1");
    }

    expect(context.log).toEqual([]);
    expect(store.resolve(handleSelection(index))?.nodeIdHints).toEqual(["node-0", "node-1"]);
  });
});

describe("§13.1 the durable document's own bounds", () => {
  it("refuses a document whose version this build does not know", async () => {
    const store = harness(JSON.stringify({ version: 2, records: [] })).create();
    await store.hydrate();

    expect(await store.classify(handleSelection(SEEDED_INDEX))).toEqual({
      class: "unexpected",
      clause: "unobtainable",
    });
  });

  it("refuses a record carrying a field past the length its reader accepts", async () => {
    const store = harness(
      JSON.stringify({
        version: 1,
        records: [{ ...SEEDED_INDEX, accountId: "a".repeat(513), state: "none", nodeIdHints: [] }],
      }),
    ).create();
    await store.hydrate();

    expect(await store.classify(handleSelection(SEEDED_INDEX))).toEqual({
      class: "unexpected",
      clause: "unobtainable",
    });
  });

  it("never writes a document its own reader would refuse", async () => {
    // The Hub issues `accountId` and `nodeId` (§12.1.1), and one out-of-bounds
    // value written here would fail the WHOLE document on the next cold start:
    // every pin, latch, consent and `anyNodeVerified` marker on the device gone to
    // `unobtainable`, permanently, with `forgetHubOrigin` the only way out.
    const store = context.create();
    await store.hydrate();
    const kept = await pairAndVerify(store);
    const durable = context.entries.get(E2EE_TRUST_DOCUMENT_KEY);
    context.log.length = 0;

    await expect(
      store.beginPairing({ hubOrigin: HUB, accountId: "a".repeat(513) }),
    ).rejects.toMatchObject({ code: "trust_store_input_invalid" });
    await expect(store.beginPairing({ hubOrigin: "", accountId: ACCOUNT })).rejects.toMatchObject({
      code: "trust_store_input_invalid",
    });
    await expect(
      store.beginPairing({ hubOrigin: HUB, accountId: ACCOUNT, environmentId: "e".repeat(513) }),
    ).rejects.toMatchObject({ code: "trust_store_input_invalid" });
    for (const policyGeneration of [Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53, -1]) {
      await expect(
        store.recordAuthenticatedStatement({
          index: kept,
          anchor: "pin-unchanged",
          identityPublicKey: NODE_PUBLIC_KEY,
          identityFingerprint: NODE_FINGERPRINT,
          policyGeneration,
          observedAt: 5,
        }),
      ).rejects.toMatchObject({ code: "trust_store_input_invalid" });
    }
    await expect(
      store.recordAuthenticatedStatement({
        index: kept,
        anchor: "pin-updated",
        identityPublicKey: ROTATED_NODE_PUBLIC_KEY,
        identityFingerprint: "f".repeat(513),
        policyGeneration: 5,
        observedAt: 5,
      }),
    ).rejects.toMatchObject({ code: "trust_store_input_invalid" });

    // Nothing reached the store, and the document still parses on a cold start.
    expect(context.log).toEqual([]);
    expect(context.entries.get(E2EE_TRUST_DOCUMENT_KEY)).toBe(durable);
    const restarted = context.create();
    await restarted.hydrate();
    expect(await restarted.classify(handleSelection(kept))).toEqual({ class: "latched" });
  });

  it("refuses the write when a value no boundary owns would not read back", async () => {
    // The backstop, driven through the one input the boundaries above cannot bound
    // for themselves: a §14.5 source that answers with more bytes than were asked
    // for produces a handle past the reader's field bound. The document is refused
    // rather than written, which is the difference between one failed pairing and
    // a device whose every pin is `unobtainable` from the next launch on.
    const store = makeMobileE2eeTrustStore({
      store: context.secureStore,
      randomBytes: () => new Uint8Array(600).fill(7),
    });
    await store.hydrate();

    await expect(store.beginPairing({ hubOrigin: HUB, accountId: ACCOUNT })).rejects.toMatchObject({
      code: "trust_store_input_invalid",
    });
    expect(context.log).not.toContain(`set:${E2EE_TRUST_DOCUMENT_KEY}`);
  });

  it("drops an out-of-bounds node id instead of refusing the record it hints at", async () => {
    // §13.1 makes the id an untrusted resolution hint that "authorizes nothing and
    // releases nothing", so a Hub presenting an oversized one must not be able to
    // block a pairing the owner started — and must not be able to reach the
    // document either. A hint that never lands only costs a resolution.
    const store = context.create();
    await store.hydrate();
    const index = await store.beginPairing({
      hubOrigin: HUB,
      accountId: ACCOUNT,
      nodeId: "n".repeat(513),
    });
    await store.recordNodeIdHint(index, "n".repeat(513));

    expect(store.resolve(handleSelection(index))?.nodeIdHints).toEqual([]);
    const restarted = context.create();
    await restarted.hydrate();
    expect(restarted.resolve(handleSelection(index))?.state).toBe("unverified");
  });

  it("refuses a new record at the local bound rather than evicting one", async () => {
    // §13.1's oldest-first eviction is for HINTS. Applying it to records would
    // silently drop a latched pin, and writing past the bound would produce a
    // document `parseDocument` refuses whole on the next launch.
    const store = context.create();
    await store.hydrate();
    const first = await pairAndVerify(store);
    for (let count = 1; count < 64; count += 1) {
      await store.beginPairing({ hubOrigin: HUB, accountId: ACCOUNT });
    }
    context.log.length = 0;

    await expect(store.beginPairing({ hubOrigin: HUB, accountId: ACCOUNT })).rejects.toMatchObject({
      code: "trust_store_capacity_exceeded",
    });

    expect(context.log).toEqual([]);
    const restarted = context.create();
    await restarted.hydrate();
    expect(await restarted.classify(handleSelection(first))).toEqual({ class: "latched" });
  });
});

describe("concurrent owner actions", () => {
  it("serializes two mutators, so neither is absent from the winner's document", async () => {
    // Both are reachable at once in the app: the bootstrap hydrates while the
    // settings screen can drive a forget and the pairing UI drives a promotion. A
    // read-modify-write that overlapped would drop the loser's record — and with a
    // promotion, the `anyNodeVerified` marker written atomically with it.
    const store = context.create();
    await store.hydrate();
    const existing = await store.beginPairing({ hubOrigin: HUB, accountId: ACCOUNT });

    const promotion = store.promote(decisionFor(existing));
    const second = store.beginPairing({ hubOrigin: HUB, accountId: OTHER_ACCOUNT });
    await Promise.all([promotion, second]);

    const added = await second;
    expect(verifiedPin(store, existing).verifiedFingerprint).toBe(NODE_FINGERPRINT);
    expect(store.resolve(handleSelection(added))?.state).toBe("unverified");
    const restarted = context.create();
    await restarted.hydrate();
    expect(await restarted.classify(handleSelection(existing))).toEqual({ class: "latched" });
    expect(restarted.resolve(handleSelection(added))?.state).toBe("unverified");
    expect(restarted.marker(HUB)).toEqual({ kind: "set" });
  });
});
