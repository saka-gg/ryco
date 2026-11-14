// The app's `tsconfig` is the react-native one, which resolves no Node builtins;
// this test runs under Node, so it pulls the types in for itself.
/// <reference types="node" />
import { readFileSync } from "node:fs";
import type { E2eeAgreementKeyPair } from "@ryco/shared/relayE2eeKeys";
import type { E2eeNoiseSessionKeys } from "@ryco/shared/relayE2eeNoise";
import type { E2eeUnprotectResult } from "@ryco/shared/relayE2eeSession";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

// `extra` is per-test data here: the dev hook's gate reads `appVariant` off it.
const constantsHolder = vi.hoisted(() => ({ extra: {} as Record<string, unknown> }));
vi.mock("expo-constants", () => ({
  default: {
    get expoConfig() {
      return { extra: constantsHolder.extra };
    },
  },
}));

/**
 * The seam for the checks' NEGATIVE branches — the rejected tamper, the rejected
 * forgery, the roles that must agree — which are the runner's entire security
 * value and which no vector can drive, because they only fire when a primitive
 * lies. Every flag below is off by default and each mock passes straight through,
 * so the positive cases run against the real implementations.
 */
const seam = vi.hoisted(() => ({
  corruptReadIndex: undefined as number | undefined,
  corruptSplitKey: undefined as "epochSecretC2N" | "epochSecretN2C" | "exporterSecret" | undefined,
  acceptTamper: false,
  corruptPlaintext: false,
  verifyVerdict: undefined as boolean | undefined,
  mismatchedKeyPair: false,
  handshakes: 0,
  reads: 0,
  splits: 0,
  keyPairs: 0,
}));

vi.mock("@ryco/shared/relayE2eeNoise", async (importOriginal) => {
  const original = await importOriginal<typeof import("@ryco/shared/relayE2eeNoise")>();
  class SeamHandshake extends original.E2eeNoiseHandshake {
    constructor(...args: ConstructorParameters<typeof original.E2eeNoiseHandshake>) {
      super(...args);
      seam.handshakes += 1;
    }

    override readMessage(message: Uint8Array): Uint8Array {
      const payload = super.readMessage(message);
      const index = seam.reads;
      seam.reads += 1;
      return seam.corruptReadIndex === index ? new Uint8Array(payload.length) : payload;
    }

    override split(): E2eeNoiseSessionKeys {
      const keys = super.split();
      seam.splits += 1;
      // The responder's outputs only: the case is the two roles DISAGREEING.
      if (seam.corruptSplitKey !== undefined && seam.splits === 2) {
        const key = keys[seam.corruptSplitKey]!;
        key[0] = key[0]! ^ 0x01;
      }
      return keys;
    }
  }
  return { ...original, E2eeNoiseHandshake: SeamHandshake };
});

vi.mock("@ryco/shared/relayE2eeSession", async (importOriginal) => {
  const original = await importOriginal<typeof import("@ryco/shared/relayE2eeSession")>();
  class SeamSession extends original.E2eeRecordSession {
    override unprotect(payload: Uint8Array): E2eeUnprotectResult {
      const result = super.unprotect(payload);
      // Only the verdict the check reads is fabricated; nothing else is needed to
      // make a deleted `tamper` branch visible.
      if (seam.acceptTamper && result.kind === "fatal") {
        return { kind: "authenticated" } as E2eeUnprotectResult;
      }
      if (seam.corruptPlaintext && result.kind === "authenticated") {
        return { ...result, body: new Uint8Array(result.body.length) };
      }
      return result;
    }
  }
  return { ...original, E2eeRecordSession: SeamSession };
});

vi.mock("@ryco/shared/relayE2eeKeys", async (importOriginal) => {
  const original = await importOriginal<typeof import("@ryco/shared/relayE2eeKeys")>();
  return {
    ...original,
    verifyE2eeSignature: (input: Parameters<typeof original.verifyE2eeSignature>[0]): boolean =>
      seam.verifyVerdict ?? original.verifyE2eeSignature(input),
    generateE2eeAgreementKeyPair: (): E2eeAgreementKeyPair => {
      seam.keyPairs += 1;
      const pair = original.generateE2eeAgreementKeyPair();
      return seam.mismatchedKeyPair
        ? { ...pair, publicKey: new Uint8Array(pair.publicKey.length) }
        : pair;
    },
  };
});

import { e2eeGlobalProvenance } from "../../polyfills";
import {
  E2EE_VECTOR_RUNNER_GLOBAL,
  E2EE_VECTOR_SUITE_CASES,
  installE2eeVectorRunnerDevHook,
  runE2eeVectorSuite,
  testOnlyChecks,
  testOnlyEmbeddedVectors,
  type E2eeVectorSet,
} from "./e2eeVectorRunner";

/**
 * The corpus is deliberately NOT bundled (844 KB), so the runner carries a
 * transcribed subset. Read the real fixture families here — this file runs under
 * Node, where `node:fs` is available and the Metro bundle is not involved — and
 * prove every transcribed value is still the corpus's.
 */
const FIXTURE_ROOT = new URL("../../../../packages/shared/fixtures/e2ee/v1/", import.meta.url);

interface CorpusBytes {
  readonly $bytes: string;
}

interface CorpusFamily {
  readonly cases: readonly {
    readonly name: string;
    readonly inputs: Record<string, unknown>;
    readonly expected: Record<string, unknown>;
  }[];
}

function readFamily(file: string): CorpusFamily {
  return JSON.parse(
    new TextDecoder().decode(readFileSync(new URL(file, FIXTURE_ROOT))),
  ) as CorpusFamily;
}

function findCase(family: CorpusFamily, name: string): CorpusFamily["cases"][number] {
  const entry = family.cases.find((candidate) => candidate.name === name);
  if (entry === undefined) throw new Error(`missing corpus case ${name}`);
  return entry;
}

/** §16.2 byte strings are `{"$bytes": "<lowercase hex>"}` and nothing else. */
function corpusHex(value: unknown): string {
  const wrapper = value as CorpusBytes;
  expect(Object.keys(wrapper)).toEqual(["$bytes"]);
  expect(wrapper.$bytes).toMatch(/^(?:[\da-f]{2})*$/);
  return wrapper.$bytes;
}

/** Off between cases: every mock passes through unless a case says otherwise. */
beforeEach(() => {
  seam.corruptReadIndex = undefined;
  seam.corruptSplitKey = undefined;
  seam.acceptTamper = false;
  seam.corruptPlaintext = false;
  seam.verifyVerdict = undefined;
  seam.mismatchedKeyPair = false;
  seam.handshakes = 0;
  seam.reads = 0;
  seam.splits = 0;
  seam.keyPairs = 0;
});

/** Asserts `run` fails at exactly `rejection`, whether it throws or rejects. */
async function expectRejection(run: () => void | Promise<void>, rejection: string): Promise<void> {
  await expect(Promise.resolve().then(run)).rejects.toThrow(new RegExp(`^${rejection}$`));
}

/** The names the suite reported `false`, in report order. */
async function failingCases(): Promise<readonly string[]> {
  const result = await runE2eeVectorSuite();
  expect(result.ok).toBe(false);
  return result.checks.filter((check) => !check.ok).map((check) => check.name);
}

/**
 * Run `body` with the AMBIENT source replaced by one that fills with `value`.
 *
 * The pinned primitives capture the crypto OBJECT at import and read the method
 * off it per draw, so swapping the method is what a running noble sees. The
 * descriptor is restored around the whole awaited body, not around its first
 * suspension.
 */
async function withGlobalRandomFill<T>(value: number, body: () => Promise<T>): Promise<T> {
  const source = globalThis.crypto as { getRandomValues: unknown };
  const previous = Object.getOwnPropertyDescriptor(source, "getRandomValues");
  Object.defineProperty(source, "getRandomValues", {
    configurable: true,
    writable: true,
    value: (array: Uint8Array) => array.fill(value),
  });
  try {
    return await body();
  } finally {
    if (previous === undefined) Reflect.deleteProperty(source, "getRandomValues");
    else Object.defineProperty(source, "getRandomValues", previous);
  }
}

describe("mobile on-device E2EE vector runner", () => {
  beforeEach(() => {
    constantsHolder.extra = {};
    Reflect.deleteProperty(globalThis, E2EE_VECTOR_RUNNER_GLOBAL);
  });

  it("passes every case it carries", async () => {
    const result = await runE2eeVectorSuite();
    expect(result.checks.map((check) => check.name)).toEqual([...E2EE_VECTOR_SUITE_CASES]);
    expect(result.checks.filter((check) => !check.ok)).toEqual([]);
    expect(result.ok).toBe(true);
    // The provenance is the load-bearing line of the device report (README step
    // 5); it is the install-time record and not a value this function composes.
    expect(result.globals).toBe(e2eeGlobalProvenance);
  });

  it("reports a bounded verdict rather than throwing when a case fails", async () => {
    const result = await runE2eeVectorSuite({
      crypto: undefined,
      TextEncoder: undefined,
      TextDecoder: undefined,
    });
    expect(result.ok).toBe(false);
    // The failing case names itself and carries nothing else — no bytes, no cause.
    const failed = result.checks.find((check) => !check.ok);
    expect(failed).toEqual({ name: E2EE_VECTOR_SUITE_CASES[0], ok: false });
    expect(Object.keys(failed!)).toEqual(["name", "ok"]);
  });

  it("refuses every later case, unrun, once the §14.5 preflight fails", async () => {
    // §14.5 is fail-closed: "no key generation, no handshake". A runner that
    // reported four green checks on a runtime it had just condemned would be
    // performing both on that source.
    const result = await runE2eeVectorSuite({
      crypto: undefined,
      TextEncoder: undefined,
      TextDecoder: undefined,
    });

    expect(result.checks).toEqual(E2EE_VECTOR_SUITE_CASES.map((name) => ({ name, ok: false })));
    expect(seam.handshakes).toBe(0);
    expect(seam.keyPairs).toBe(0);
  });

  it("preflights the real globals when no host is given", async () => {
    // On a device the runner is invoked with no argument, so the default binding
    // is the only §14.5 source ever validated. A stub standing in for it would
    // report a runtime that was never examined.
    const result = await withGlobalRandomFill(0, async () => await runE2eeVectorSuite());

    expect(result.checks[0]).toEqual({ name: E2EE_VECTOR_SUITE_CASES[0], ok: false });
  });

  it("reports the F15 case, and only it, when the two roles disagree on a split output", async () => {
    seam.corruptSplitKey = "epochSecretC2N";

    expect(await failingCases()).toEqual([E2EE_VECTOR_SUITE_CASES[1]]);
  });

  it("reports the F6 case, and only it, when a tampered record is accepted", async () => {
    // Also the only asynchronous case: a dropped `await` would let this rejection
    // escape the loop and report the broken record path as `ok: true`.
    seam.acceptTamper = true;

    expect(await failingCases()).toEqual([E2EE_VECTOR_SUITE_CASES[2]]);
  });

  it("reports the F4 case, and only it, when a forged signature verifies", async () => {
    seam.verifyVerdict = true;

    expect(await failingCases()).toEqual([E2EE_VECTOR_SUITE_CASES[3]]);
  });

  it("reports the keygen case, and only it, when the source repeats a draw", async () => {
    // A constant source passes the preflight — the bytes are not zero — and is
    // caught only by the two-draw comparison inside the keygen case.
    const failed = await withGlobalRandomFill(7, async () => await failingCases());

    expect(failed).toEqual([E2EE_VECTOR_SUITE_CASES[4]]);
  });

  it("installs the dev hook only for the development variant", () => {
    const host: Record<string, unknown> = {};

    constantsHolder.extra = { appVariant: "production" };
    installE2eeVectorRunnerDevHook(host);
    expect(host[E2EE_VECTOR_RUNNER_GLOBAL]).toBeUndefined();

    constantsHolder.extra = { appVariant: "preview" };
    installE2eeVectorRunnerDevHook(host);
    expect(host[E2EE_VECTOR_RUNNER_GLOBAL]).toBeUndefined();

    constantsHolder.extra = {};
    installE2eeVectorRunnerDevHook(host);
    expect(host[E2EE_VECTOR_RUNNER_GLOBAL]).toBeUndefined();

    constantsHolder.extra = { appVariant: "development" };
    installE2eeVectorRunnerDevHook(host);
    expect(host[E2EE_VECTOR_RUNNER_GLOBAL]).toBe(runE2eeVectorSuite);
    expect(Object.keys(host)).toEqual([]);
  });
});

/**
 * Every check signals a failure by throwing, so a deleted comparison makes the
 * runner strictly MORE permissive and its five green ticks strictly less true.
 * The cases below drive each comparison to its rejection and name the one that
 * must fire, so a deletion stops the throw — or moves it — and fails here.
 */
describe("each check rejects what it exists to reject", () => {
  const vectors = testOnlyEmbeddedVectors;

  /** One flipped bit of an EXPECTED value, leaving every input untouched. */
  const flipHex = (hex: string): string =>
    (Number.parseInt(hex.slice(0, 1), 16) ^ 1).toString(16) + hex.slice(1);

  const perturbations: readonly {
    readonly rejects: string;
    readonly vectors: E2eeVectorSet;
    readonly check: (vectors: E2eeVectorSet) => void | Promise<void>;
  }[] = [
    {
      rejects: "message 1",
      check: testOnlyChecks.noiseIk,
      vectors: {
        ...vectors,
        f15Ik: {
          ...vectors.f15Ik,
          handshakeMessages: [
            flipHex(vectors.f15Ik.handshakeMessages[0]!),
            vectors.f15Ik.handshakeMessages[1]!,
          ],
        },
      },
    },
    {
      rejects: "message 2",
      check: testOnlyChecks.noiseIk,
      vectors: {
        ...vectors,
        f15Ik: {
          ...vectors.f15Ik,
          handshakeMessages: [
            vectors.f15Ik.handshakeMessages[0]!,
            flipHex(vectors.f15Ik.handshakeMessages[1]!),
          ],
        },
      },
    },
    {
      rejects: "handshake hash",
      check: testOnlyChecks.noiseIk,
      vectors: {
        ...vectors,
        f15Ik: { ...vectors.f15Ik, handshakeHash: flipHex(vectors.f15Ik.handshakeHash) },
      },
    },
    {
      rejects: "confirmation key",
      check: testOnlyChecks.recordProtection,
      vectors: {
        ...vectors,
        f6Ik: {
          ...vectors.f6Ik,
          serverConfirmationKey: flipHex(vectors.f6Ik.serverConfirmationKey),
        },
      },
    },
    {
      rejects: "envelope",
      check: testOnlyChecks.recordProtection,
      vectors: {
        ...vectors,
        f6Ik: {
          ...vectors.f6Ik,
          clientToNode: {
            ...vectors.f6Ik.clientToNode,
            envelope: flipHex(vectors.f6Ik.clientToNode.envelope),
          },
        },
      },
    },
    {
      rejects: "aad",
      check: testOnlyChecks.recordProtection,
      vectors: {
        ...vectors,
        f6Ik: {
          ...vectors.f6Ik,
          clientToNode: {
            ...vectors.f6Ik.clientToNode,
            aad: flipHex(vectors.f6Ik.clientToNode.aad),
          },
        },
      },
    },
    {
      rejects: "transcript size",
      check: testOnlyChecks.nodePrekeyCertificate,
      vectors: {
        ...vectors,
        f4NodePrekey: {
          ...vectors.f4NodePrekey,
          transcriptBytes: vectors.f4NodePrekey.transcriptBytes + 1,
        },
      },
    },
    {
      rejects: "fingerprint",
      check: testOnlyChecks.nodePrekeyCertificate,
      vectors: {
        ...vectors,
        f4NodePrekey: {
          ...vectors.f4NodePrekey,
          identityFingerprint: flipHex(vectors.f4NodePrekey.identityFingerprint),
        },
      },
    },
    {
      rejects: "fingerprint display",
      check: testOnlyChecks.nodePrekeyCertificate,
      vectors: {
        ...vectors,
        f13NodeIdentity: { ...vectors.f13NodeIdentity, fingerprintDisplay: "SHA256:not-this-key" },
      },
    },
    {
      rejects: "verify",
      check: testOnlyChecks.nodePrekeyCertificate,
      vectors: {
        ...vectors,
        f4NodePrekey: {
          ...vectors.f4NodePrekey,
          crossSignature: flipHex(vectors.f4NodePrekey.crossSignature),
        },
      },
    },
    {
      rejects: "derivation",
      check: testOnlyChecks.agreementKeygen,
      vectors: {
        ...vectors,
        f4NodePrekey: {
          ...vectors.f4NodePrekey,
          agreementPublicKey: flipHex(vectors.f4NodePrekey.agreementPublicKey),
        },
      },
    },
  ];

  it.each(perturbations)("rejects a perturbed vector at $rejects", async (perturbation) => {
    await expectRejection(() => perturbation.check(perturbation.vectors), perturbation.rejects);
  });

  it("rejects a payload either role decrypts to the wrong bytes", async () => {
    // Each role reads the VECTOR's bytes rather than the ones just written, and
    // these are the two comparisons that make that meaningful.
    for (const [index, rejects] of [
      [0, "payload 1"],
      [1, "payload 2"],
    ] as const) {
      seam.reads = 0;
      seam.corruptReadIndex = index;
      await expectRejection(() => testOnlyChecks.noiseIk(), rejects);
    }
  });

  it("rejects a split output the two roles do not agree on", async () => {
    for (const [key, rejects] of [
      ["epochSecretC2N", "split c2n"],
      ["epochSecretN2C", "split n2c"],
      ["exporterSecret", "split exporter"],
    ] as const) {
      seam.splits = 0;
      seam.corruptSplitKey = key;
      await expectRejection(() => testOnlyChecks.noiseIk(), rejects);
    }
  });

  it("rejects a record whose plaintext is not the one the vector pins", async () => {
    seam.corruptPlaintext = true;

    await expectRejection(async () => await testOnlyChecks.recordProtection(), "plaintext");
  });

  it("rejects a one-byte tamper that the record path authenticates (§9.2)", async () => {
    seam.acceptTamper = true;

    await expectRejection(async () => await testOnlyChecks.recordProtection(), "tamper");
  });

  it("rejects a forged Ed25519 signature that verifies (§7.1)", async () => {
    seam.verifyVerdict = true;

    await expectRejection(() => testOnlyChecks.nodePrekeyCertificate(), "forgery accepted");
  });

  it("rejects a key pair whose public half is not its secret half's", async () => {
    seam.mismatchedKeyPair = true;

    await expectRejection(() => testOnlyChecks.agreementKeygen(), "keypair");
  });

  it("rejects two draws that repeat, which is a stubbed-out source", async () => {
    await withGlobalRandomFill(7, async () => {
      await expectRejection(() => testOnlyChecks.agreementKeygen(), "repeated draw");
    });
  });
});

describe("embedded vectors match the checked-in corpus", () => {
  it("F15 cacophony Noise_IK_25519_ChaChaPoly_SHA256", () => {
    const vector = testOnlyEmbeddedVectors.f15Ik;
    const { inputs, expected } = findCase(
      readFamily("f15-noise-core-vectors.json"),
      "cacophony/Noise_IK_25519_ChaChaPoly_SHA256",
    );
    expect(inputs.pattern).toBe("IK");
    expect(corpusHex(inputs.initiatorPrologue)).toBe(vector.prologue);
    expect(corpusHex(inputs.responderPrologue)).toBe(vector.prologue);
    expect(corpusHex(inputs.testOnlyInitiatorStaticSecretKey)).toBe(
      vector.initiatorStaticSecretKey,
    );
    expect(corpusHex(inputs.testOnlyInitiatorEphemeralSecretKey)).toBe(
      vector.initiatorEphemeralSecretKey,
    );
    expect(corpusHex(inputs.testOnlyInitiatorRemoteStaticPublicKey)).toBe(
      vector.initiatorRemoteStaticPublicKey,
    );
    expect(corpusHex(inputs.testOnlyResponderStaticSecretKey)).toBe(
      vector.responderStaticSecretKey,
    );
    expect(corpusHex(inputs.testOnlyResponderEphemeralSecretKey)).toBe(
      vector.responderEphemeralSecretKey,
    );
    expect((inputs.handshakePayloads as unknown[]).map(corpusHex)).toEqual([
      ...vector.handshakePayloads,
    ]);
    expect((expected.handshakeMessages as unknown[]).map(corpusHex)).toEqual([
      ...vector.handshakeMessages,
    ]);
    expect(corpusHex(expected.handshakeHash)).toBe(vector.handshakeHash);
  });

  it("F6 ik-handshake-complete-trace", () => {
    const vector = testOnlyEmbeddedVectors.f6Ik;
    const { expected } = findCase(
      readFamily("f06-ik-handshake.json"),
      "ik-handshake-complete-trace",
    );
    expect(corpusHex(expected.sessionBindingHash)).toBe(vector.sessionBindingHash);
    expect(corpusHex(expected.epochSecretC2N)).toBe(vector.epochSecretC2N);
    expect(corpusHex(expected.epochSecretN2C)).toBe(vector.epochSecretN2C);
    expect(corpusHex(expected.exporterSecret)).toBe(vector.exporterSecret);
    expect(corpusHex(expected.serverConfirmationKey)).toBe(vector.serverConfirmationKey);

    const envelopes = expected.firstProtectedEnvelopes as Record<string, Record<string, unknown>>;
    for (const [key, embedded] of [
      ["clientToNode", vector.clientToNode],
      ["nodeToClient", vector.nodeToClient],
    ] as const) {
      expect(corpusHex(envelopes[key]!.innerBody)).toBe(embedded.innerBody);
      expect(corpusHex(envelopes[key]!.envelope)).toBe(embedded.envelope);
      expect(corpusHex(envelopes[key]!.aad)).toBe(embedded.aad);
    }
  });

  it("F4 valid-node-agreement-prekey-certificate", () => {
    const vector = testOnlyEmbeddedVectors.f4NodePrekey;
    const { inputs, expected } = findCase(
      readFamily("f04-prekey-certificates.json"),
      "valid-node-agreement-prekey-certificate",
    );
    expect(inputs.hubOrigin).toBe(vector.hubOrigin);
    expect(inputs.nodeId).toBe(vector.nodeId);
    expect(inputs.identityKeyId).toBe(vector.identityKeyId);
    expect(inputs.prekeyId).toBe(vector.prekeyId);
    expect(inputs.createdAt).toBe(vector.createdAt);
    expect(inputs.expiresAt).toBe(vector.expiresAt);
    expect(corpusHex(inputs.identityPublicKey)).toBe(vector.identityPublicKey);
    expect(corpusHex(inputs.agreementPublicKey)).toBe(vector.agreementPublicKey);
    expect(expected.transcriptBytes).toBe(vector.transcriptBytes);
    expect(corpusHex(expected.identityFingerprint)).toBe(vector.identityFingerprint);
    expect(corpusHex(expected.crossSignature)).toBe(vector.crossSignature);
  });

  it("F13 node-identity-key-fingerprint and the shared agreement secret", () => {
    const vector = testOnlyEmbeddedVectors.f13NodeIdentity;
    const family = readFamily("f13-fingerprints.json");
    expect(findCase(family, "node-identity-key-fingerprint").expected.display).toBe(
      vector.fingerprintDisplay,
    );
    const material = (
      JSON.parse(
        new TextDecoder().decode(readFileSync(new URL("f13-fingerprints.json", FIXTURE_ROOT))),
      ) as { readonly testKeyMaterial: Record<string, unknown> }
    ).testKeyMaterial;
    expect(corpusHex(material.testOnlyNodeAgreementSecretKey)).toBe(vector.agreementSecretKey);
    expect(corpusHex(material.nodeAgreementPublicKey)).toBe(
      testOnlyEmbeddedVectors.f4NodePrekey.agreementPublicKey,
    );
  });
});
