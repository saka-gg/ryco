import { createPublicKey, verify } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { encodeNodeKeyRotationTranscript } from "@ryco/shared/nodeIdentity";
import { validateNodeE2eeContinuityChain } from "@ryco/shared/relayE2eeTranscripts";
import { describe, expect, it } from "vite-plus/test";

import {
  type HubKeyRotationChallenge,
  type HubKeyRotationStatus,
  type HubKeyRotationTransport,
  makeHubKeyRotationClient,
} from "./HubKeyRotationClient.ts";
import {
  type LocalHubIdentityStateStore,
  makeLocalHubIdentityStateStore,
  type NodeRotationContinuityMode,
} from "./LocalHubIdentityState.ts";
import { makeNodeContinuityAnchor } from "./NodeContinuityAnchor.ts";
import {
  decodeContinuityEntries,
  makeNodeIdentityContinuityStore,
} from "./NodeIdentityContinuityStore.ts";
import {
  makeNodeIdentityKeyRetirementStore,
  type NodeIdentityKeyRetirementStore,
} from "./NodeIdentityKeyRetirementStore.ts";
import { makeNodeSigningIdentity, type NodeSigningIdentity } from "./NodeSigningIdentity.ts";
import type { ProtectedSecretStore } from "./ProtectedSecretStore.ts";

function memorySecretStore(): ProtectedSecretStore & { readonly values: Map<string, Uint8Array> } {
  const values = new Map<string, Uint8Array>();
  return {
    backend: "permissioned-file",
    values,
    get: async (name) => {
      const value = values.get(name);
      return value === undefined ? null : Uint8Array.from(value);
    },
    create: async (name, value) => {
      if (values.has(name))
        throw Object.assign(new Error("conflict"), { code: "protected_store_conflict" });
      values.set(name, Uint8Array.from(value));
    },
    remove: async (name) => {
      values.delete(name);
    },
  };
}

const now = 1_784_160_000_000;
const hubOrigin = "https://hub.example.com";
const nodeId = "node_AAAAAAAAAAAAAAAAAAAAAA";
const oldKeyId = "nkey_BBBBBBBBBBBBBBBBBBBBBB";
const newKeyId = "nkey_DDDDDDDDDDDDDDDDDDDDDD";
const rotationRequestId = "nrot_CCCCCCCCCCCCCCCCCCCCCC";
const challengeBytes = new Uint8Array(32).fill(0xa5);

function challenge(value = challengeBytes): HubKeyRotationChallenge {
  return {
    rotationRequestId,
    newKeyId,
    protocolMajor: 1,
    protocolMinor: 1,
    challenge: Uint8Array.from(value),
    challengeExpiresAt: now + 30_000,
  };
}

function spki(publicKey: Uint8Array): Buffer {
  return Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), publicKey]);
}

async function harness(transport: HubKeyRotationTransport) {
  const root = await mkdtemp(join(tmpdir(), "ryco-rotation-client-"));
  const statePath = join(root, "identity.json");
  const stateStore = await makeLocalHubIdentityStateStore(statePath);
  const retirementPath = join(root, "identity-retirement.json");
  const retirement = await makeNodeIdentityKeyRetirementStore({ path: retirementPath });
  const secretStore = memorySecretStore();
  const signingIdentity = makeNodeSigningIdentity(secretStore);
  const initial = await stateStore.readOrCreate();
  const oldDescriptor = await signingIdentity.generate("node-key.active");
  await stateStore.update((current) => ({
    ...current,
    revision: current.revision + 1,
    activeNode: {
      hubOrigin,
      nodeId,
      activeKeyId: oldKeyId,
      activeKeySecretName: "node-key.active",
      cleanupPollingSecretName: null,
      enrolledAt: now - 100_000,
    },
  }));
  /**
   * Records what the promotion asked of the §7.5 chain, and — crucially —
   * whether the outgoing key was still in custody at the moment it asked.
   */
  const continuityCalls: Array<{
    readonly kind: "issue" | "break";
    readonly oldKeyPresent: boolean;
  }> = [];
  let continuityFailure: Error | null = null;
  const continuity = {
    issue: async () => {
      continuityCalls.push({
        kind: "issue",
        oldKeyPresent: secretStore.values.has("node-key.active"),
      });
      if (continuityFailure !== null) throw continuityFailure;
    },
    break: async () => {
      continuityCalls.push({
        kind: "break",
        oldKeyPresent: secretStore.values.has("node-key.active"),
      });
      if (continuityFailure !== null) throw continuityFailure;
    },
  };
  const makeClient = (overrides?: {
    readonly signingIdentity?: NodeSigningIdentity;
    readonly stateStore?: LocalHubIdentityStateStore;
    readonly retirement?: NodeIdentityKeyRetirementStore;
  }) =>
    makeHubKeyRotationClient({
      transport,
      stateStore: overrides?.stateStore ?? stateStore,
      retirement: overrides?.retirement ?? retirement,
      signingIdentity: overrides?.signingIdentity ?? signingIdentity,
      continuity,
      now: () => now,
    });
  return {
    initial,
    statePath,
    stateStore,
    retirement,
    retirementPath,
    secretStore,
    signingIdentity,
    oldDescriptor,
    makeClient,
    continuityCalls,
    failContinuity: (error: Error) => {
      continuityFailure = error;
    },
  };
}

/** A rotation staged, proved, and activated by the Hub, ready for promotion. */
async function activatedRotation(
  options: { readonly continuity: NodeRotationContinuityMode } = { continuity: "continue" },
) {
  let status: HubKeyRotationStatus = { status: "awaiting_owner" };
  const test = await harness({
    begin: async () => challenge(),
    prove: async () => status,
    status: async () => status,
  });
  const client = test.makeClient();
  await client.stage(hubOrigin, options);
  status = { status: "activated", activatedAt: now + 20_000 };
  await client.resume(hubOrigin);
  // Staging and promoting are the only two steps; the continuity disposition
  // must have survived the gap between them without being asked for again.
  expect(test.continuityCalls).toEqual([]);
  return test;
}

describe("Hub key rotation client", () => {
  it("proves with the old key, selects the activated new key, and deletes old custody after proof", async () => {
    let newPublicKey: Uint8Array | undefined;
    let proofChallenge: Uint8Array | undefined;
    let proofSignature: Uint8Array | undefined;
    let status: HubKeyRotationStatus = { status: "awaiting_owner" };
    const transport: HubKeyRotationTransport = {
      begin: async (request) => {
        newPublicKey = Uint8Array.from(request.newKey.publicKey);
        return challenge();
      },
      prove: async (request) => {
        proofChallenge = Uint8Array.from(request.challenge);
        proofSignature = Uint8Array.from(request.signature);
        return { status: "awaiting_owner" };
      },
      status: async () => status,
    };
    const stateful = await harness(transport);
    const client = stateful.makeClient();
    expect(await client.stage(hubOrigin, { continuity: "continue" })).toEqual({
      status: "awaiting_owner",
    });
    const transcript = encodeNodeKeyRotationTranscript({
      hubOrigin,
      protocolMajor: 1,
      protocolMinor: 1,
      rotationRequestId,
      nodeId,
      oldActiveKeyId: oldKeyId,
      newKeyId,
      newKey: { algorithm: "ed25519", publicKey: newPublicKey ?? new Uint8Array() },
      challengeExpiresAt: now + 30_000,
      challenge: challengeBytes,
    });
    expect(
      verify(
        null,
        transcript,
        createPublicKey({
          key: spki(stateful.oldDescriptor.publicKey),
          format: "der",
          type: "spki",
        }),
        proofSignature ?? new Uint8Array(),
      ),
    ).toBe(true);
    expect(proofChallenge).toEqual(challengeBytes);
    expect(await client.authenticationKey(hubOrigin)).toEqual({
      keyId: oldKeyId,
      secretName: "node-key.active",
    });

    status = { status: "activated", activatedAt: now + 20_000 };
    expect(await stateful.makeClient().resume(hubOrigin)).toEqual(status);
    const selected = await client.authenticationKey(hubOrigin);
    expect(selected.keyId).toBe(newKeyId);
    expect(selected.secretName).not.toBe("node-key.active");
    expect(stateful.secretStore.values.has("node-key.active")).toBe(true);

    await client.confirmNewKeyAuthenticated(hubOrigin, newKeyId);
    expect(stateful.secretStore.values.has("node-key.active")).toBe(false);
    expect((await stateful.stateStore.readOrCreate()).stagedRotation).toBeNull();
    expect((await stateful.stateStore.readOrCreate()).activeNode?.activeKeyId).toBe(newKeyId);
  });

  it("proves a challenge whatever the skew between this clock and the Hub's", async () => {
    // The Hub stamps challengeExpiresAt on its own clock: 90 s in this node's past when the
    // node runs ahead, 10 min in its future when the node runs behind.
    for (const challengeExpiresAt of [now - 60_000, now + 600_000]) {
      const proved: Array<number> = [];
      const test = await harness({
        begin: async () => ({ ...challenge(), challengeExpiresAt }),
        prove: async () => {
          proved.push(challengeExpiresAt);
          return { status: "awaiting_owner" };
        },
        status: async () => ({ status: "awaiting_owner" }),
      });
      expect(await test.makeClient().stage(hubOrigin, { continuity: "continue" })).toEqual({
        status: "awaiting_owner",
      });
      expect(proved).toEqual([challengeExpiresAt]);
    }
  });

  it("still refuses a challenge without a usable expiry", async () => {
    for (const challengeExpiresAt of [0, 1.5, Number.NaN]) {
      const test = await harness({
        begin: async () => ({ ...challenge(), challengeExpiresAt }),
        prove: async () => ({ status: "awaiting_owner" }),
        status: async () => ({ status: "awaiting_owner" }),
      });
      await expect(
        test.makeClient().stage(hubOrigin, { continuity: "continue" }),
      ).rejects.toMatchObject({ code: "rotation_response_invalid" });
    }
  });

  it("keeps the old key and deletes a rejected staged key", async () => {
    const transport: HubKeyRotationTransport = {
      begin: async () => challenge(),
      prove: async () => ({ status: "rejected" }),
      status: async () => ({ status: "rejected" }),
    };
    const test = await harness(transport);
    expect(await test.makeClient().stage(hubOrigin, { continuity: "continue" })).toEqual({
      status: "rejected",
    });
    expect((await test.stateStore.readOrCreate()).stagedRotation).toBeNull();
    expect(test.secretStore.values.has("node-key.active")).toBe(true);
    expect(test.secretStore.values.size).toBe(1);
  });

  it("resumes cleanly after a committed proof response is lost", async () => {
    let proveAttempts = 0;
    const transport: HubKeyRotationTransport = {
      begin: async () => challenge(),
      prove: async () => {
        proveAttempts += 1;
        throw new Error("response lost after proof commit");
      },
      status: async () => ({ status: "awaiting_owner" }),
    };
    const test = await harness(transport);
    await expect(
      test.makeClient().stage(hubOrigin, { continuity: "continue" }),
    ).rejects.toMatchObject({
      code: "rotation_transport_failed",
    });
    expect((await test.stateStore.readOrCreate()).stagedRotation?.rotationRequestId).toBe(
      rotationRequestId,
    );
    expect(await test.makeClient().resume(hubOrigin)).toEqual({ status: "awaiting_owner" });
    expect(proveAttempts).toBe(1);
  });

  it("obtains a fresh challenge when an interrupted proof was not committed", async () => {
    let beginCount = 0;
    let proveCount = 0;
    const transport: HubKeyRotationTransport = {
      begin: async () => {
        beginCount += 1;
        return challenge(new Uint8Array(32).fill(beginCount));
      },
      prove: async () => {
        proveCount += 1;
        if (proveCount === 1) throw new Error("request never committed");
        return { status: "awaiting_owner" };
      },
      status: async () => ({ status: "proof_required" }),
    };
    const test = await harness(transport);
    await expect(
      test.makeClient().stage(hubOrigin, { continuity: "continue" }),
    ).rejects.toMatchObject({
      code: "rotation_transport_failed",
    });
    expect(await test.makeClient().resume(hubOrigin)).toEqual({ status: "awaiting_owner" });
    expect(beginCount).toBe(2);
    expect(proveCount).toBe(2);
  });

  it("gives concurrent staging attempts one local winner", async () => {
    const transport: HubKeyRotationTransport = {
      begin: async () => challenge(),
      prove: async () => ({ status: "awaiting_owner" }),
      status: async () => ({ status: "awaiting_owner" }),
    };
    const test = await harness(transport);
    const results = await Promise.allSettled([
      test.makeClient().stage(hubOrigin, { continuity: "continue" }),
      test.makeClient().stage(hubOrigin, { continuity: "continue" }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect((await test.stateStore.readOrCreate()).stagedRotation).not.toBeNull();
    expect(test.secretStore.values.size).toBe(2);
  });

  it("issues the §7.5 certificate while the outgoing key is still in custody", async () => {
    const test = await activatedRotation();
    // Nothing to report: a carried chain is issued before the promotion, so its
    // failure aborts the promotion rather than being deferred.
    expect(await test.makeClient().confirmNewKeyAuthenticated(hubOrigin, newKeyId)).toEqual({
      continuityBreak: null,
    });
    // The ordering §7.5 fixes: signed and durable BEFORE the outgoing key is
    // destroyed, so a crash can never leave a rotation with no link and no key.
    expect(test.continuityCalls).toEqual([{ kind: "issue", oldKeyPresent: true }]);
    expect(test.secretStore.values.has("node-key.active")).toBe(false);
  });

  it("aborts the promotion, keeping the outgoing key, when the certificate cannot be retained", async () => {
    const test = await activatedRotation();
    test.failContinuity(new Error("continuity record unavailable"));
    await expect(
      test.makeClient().confirmNewKeyAuthenticated(hubOrigin, newKeyId),
    ).rejects.toThrow();
    // Fail closed with nothing lost: the outgoing key is intact, the promotion
    // did not happen, and the operator can retry or re-stage as a break.
    expect(test.secretStore.values.has("node-key.active")).toBe(true);
    const state = await test.stateStore.readOrCreate();
    expect(state.activeNode?.activeKeyId).toBe(oldKeyId);
    expect(state.stagedRotation?.newKeyId).toBe(newKeyId);
  });

  it("reports a break it could not record, rather than failing a committed promotion", async () => {
    const test = await activatedRotation({ continuity: "break" });
    test.failContinuity(new Error("continuity anchor unreadable"));
    const promotion = await test.makeClient().confirmNewKeyAuthenticated(hubOrigin, newKeyId);
    // The break is the only post-commit step that could throw, and it must not:
    // the promotion is durable by the time it runs, so an operator told the
    // rotation failed would retry one that already happened. The outcome is
    // returned instead — self-healing, because the §7.5 startup cross-check
    // finds a chain that reaches no key in custody and records the same break,
    // but still a fact an operator surface can show rather than infer.
    expect(promotion).toEqual({ continuityBreak: "deferred" });
    const state = await test.stateStore.readOrCreate();
    expect(state.activeNode?.activeKeyId).toBe(newKeyId);
    expect(state.stagedRotation).toBeNull();
    expect(test.secretStore.values.has("node-key.active")).toBe(false);
  });

  it("breaks the chain instead of issuing when the operator staged a deliberate break", async () => {
    const test = await activatedRotation({ continuity: "break" });
    expect(await test.makeClient().confirmNewKeyAuthenticated(hubOrigin, newKeyId)).toEqual({
      continuityBreak: "recorded",
    });
    // The mirror of the issue ordering: the break lands AFTER the promotion has
    // committed, so the outgoing key is already gone by the time it runs. A
    // break recorded first would spend the chain on a rotation that could still
    // fail, leaving the old key live and every pinned client re-verifying a
    // rotation that never happened.
    expect(test.continuityCalls).toEqual([{ kind: "break", oldKeyPresent: false }]);
    expect((await test.stateStore.readOrCreate()).activeNode?.activeKeyId).toBe(newKeyId);
  });

  it("keeps the chain when a promotion fails before it commits", async () => {
    const test = await activatedRotation({ continuity: "break" });
    // The promotion cannot commit. Nothing may have been spent on it: the chain
    // is still the only evidence a pinned client can re-anchor against, and the
    // identity it authenticates has not changed.
    const failing = test.makeClient({
      stateStore: {
        ...test.stateStore,
        update: async () => {
          throw new Error("state store unavailable");
        },
      },
    });
    await expect(failing.confirmNewKeyAuthenticated(hubOrigin, newKeyId)).rejects.toThrow();
    expect(test.continuityCalls).toEqual([]);
    expect((await test.stateStore.readOrCreate()).activeNode?.activeKeyId).toBe(oldKeyId);
    // And the outgoing key is still in custody, which is what makes the retry
    // possible at all.
    expect(test.secretStore.values.has("node-key.active")).toBe(true);
  });

  it("commits the promotion before destroying the outgoing key, and queues what it could not destroy", async () => {
    const test = await activatedRotation({ continuity: "break" });
    // The destruction fails — a credential store that is briefly unavailable,
    // or a crash at exactly this point. Under the reverse ordering this is the
    // unrecoverable state: the key gone, the record still naming it active, no
    // way forward and no way back. Here it is merely outstanding work.
    let deletable = false;
    const flaky = test.makeClient({
      signingIdentity: {
        ...test.signingIdentity,
        delete: async (secretName: string) => {
          if (!deletable) throw new Error("credential store unavailable");
          await test.signingIdentity.delete(secretName);
        },
      },
    });
    await flaky.confirmNewKeyAuthenticated(hubOrigin, newKeyId);

    const promoted = await test.stateStore.readOrCreate();
    expect(promoted.activeNode?.activeKeyId).toBe(newKeyId);
    expect(promoted.stagedRotation).toBeNull();
    // The one durable handle on a key nothing else names any more: the
    // protected store has no listing, so losing it would orphan the key. It is
    // kept in a record of its own, because the identity state's parser drops
    // fields an older binary does not know and a downgrade would delete it.
    expect(await test.retirement.names()).toEqual(["node-key.active"]);
    expect(test.secretStore.values.has("node-key.active")).toBe(true);
    // The promotion is whole, so the break is recorded exactly once.
    expect(test.continuityCalls).toEqual([{ kind: "break", oldKeyPresent: true }]);

    // Resumable: the next drain — a later promotion, or the next start —
    // finishes the destruction and clears the queue.
    deletable = true;
    await test.makeClient().destroyRetiredKeys();
    expect(test.secretStore.values.has("node-key.active")).toBe(false);
    expect(await test.retirement.names()).toEqual([]);
  });

  it("queues the outgoing key before the promotion commits, and never drains it early", async () => {
    const test = await activatedRotation({ continuity: "break" });
    // The queue and the identity state are two records now, so the enqueue
    // happens BEFORE the commit: the reverse order leaves a window in which the
    // outgoing key is named by nothing at all. The crash lands here.
    const failing = test.makeClient({
      stateStore: {
        ...test.stateStore,
        update: async () => {
          throw new Error("state store unavailable");
        },
      },
    });
    await expect(failing.confirmNewKeyAuthenticated(hubOrigin, newKeyId)).rejects.toThrow();
    expect(await test.retirement.names()).toEqual(["node-key.active"]);

    // What that costs: a queued name that the state still calls active. A drain
    // that destroyed it would erase the key the node authenticates with, and one
    // that dequeued it would orphan that key the moment the retry committed. So
    // it is skipped and left exactly where it is.
    await test.makeClient().destroyRetiredKeys();
    expect(test.secretStore.values.has("node-key.active")).toBe(true);
    expect(await test.retirement.names()).toEqual(["node-key.active"]);
    expect((await test.stateStore.readOrCreate()).activeNode?.activeKeyId).toBe(oldKeyId);

    // The retry re-queues (a no-op), commits, and only then destroys.
    await test.makeClient().confirmNewKeyAuthenticated(hubOrigin, newKeyId);
    expect((await test.stateStore.readOrCreate()).activeNode?.activeKeyId).toBe(newKeyId);
    expect(test.secretStore.values.has("node-key.active")).toBe(false);
    expect(await test.retirement.names()).toEqual([]);
  });

  it("aborts the promotion when the destroy queue cannot record the outgoing key", async () => {
    const test = await activatedRotation({ continuity: "break" });
    const failing = test.makeClient({
      retirement: {
        ...test.retirement,
        enqueue: async () => {
          throw new Error("destroy queue unavailable");
        },
      },
    });
    // Fail closed with nothing spent: a promotion that committed here would
    // leave the outgoing key with no durable name, which is the one state this
    // queue exists to make impossible.
    await expect(failing.confirmNewKeyAuthenticated(hubOrigin, newKeyId)).rejects.toThrow();
    const state = await test.stateStore.readOrCreate();
    expect(state.activeNode?.activeKeyId).toBe(oldKeyId);
    expect(state.stagedRotation?.newKeyId).toBe(newKeyId);
    expect(test.secretStore.values.has("node-key.active")).toBe(true);
  });

  it("keeps the destroy queue out of the state file a downgrade rewrites", async () => {
    const test = await activatedRotation({ continuity: "break" });
    const failing = test.makeClient({
      signingIdentity: {
        ...test.signingIdentity,
        delete: async () => {
          throw new Error("credential store unavailable");
        },
      },
    });
    await failing.confirmNewKeyAuthenticated(hubOrigin, newKeyId);

    // A binary older than this feature rewrites `hub-identity.json` from the
    // fields it knows and deletes the rest, which for this name would be
    // permanent: the protected store has no listing, so nothing could ever name
    // the key again. It is therefore not in that file — it is in a record no
    // already released binary writes.
    const identityFile = await readFile(test.statePath, "utf8");
    expect(identityFile).not.toContain("node-key.active");
    expect(identityFile).not.toContain("retiringSecretNames");
    expect(await readFile(test.retirementPath, "utf8")).toContain("node-key.active");
  });

  it("keeps a key queued when its deletion keeps failing, and never twice over", async () => {
    const test = await activatedRotation({ continuity: "break" });
    const failing = test.makeClient({
      signingIdentity: {
        ...test.signingIdentity,
        delete: async () => {
          throw new Error("credential store unavailable");
        },
      },
    });
    await failing.confirmNewKeyAuthenticated(hubOrigin, newKeyId);
    await failing.destroyRetiredKeys();
    await failing.destroyRetiredKeys();
    expect(await test.retirement.names()).toEqual(["node-key.active"]);
  });

  it("reads a rotation staged before the disposition existed as a deliberate break", async () => {
    const test = await activatedRotation();
    // §7.5 fail-closed: a binary that did not record the operator's choice must
    // not have its silence read as consent to issue a link.
    const state = await test.stateStore.readOrCreate();
    const { continuityMode: _dropped, ...legacy } = state.stagedRotation ?? {};
    await writeFile(
      test.statePath,
      `${JSON.stringify({ ...state, revision: state.revision + 1, stagedRotation: legacy })}\n`,
      { mode: 0o600 },
    );
    expect((await test.stateStore.readOrCreate()).stagedRotation?.continuityMode).toBe("break");
    await test.makeClient().confirmNewKeyAuthenticated(hubOrigin, newKeyId);
    expect(test.continuityCalls).toEqual([{ kind: "break", oldKeyPresent: false }]);
  });

  it("produces a chain the Phase 1 validator accepts, end to end through the real store", async () => {
    const root = await mkdtemp(join(tmpdir(), "ryco-rotation-continuity-"));
    const stateStore = await makeLocalHubIdentityStateStore(join(root, "identity.json"));
    const retirement = await makeNodeIdentityKeyRetirementStore({
      path: join(root, "identity-retirement.json"),
    });
    const secretStore = memorySecretStore();
    const signingIdentity = makeNodeSigningIdentity(secretStore);
    const continuityStore = await makeNodeIdentityContinuityStore({
      path: join(root, "hub-continuity.json"),
      anchor: await makeNodeContinuityAnchor({ path: join(root, "anchor", "hub-continuity.json") }),
    });
    const oldDescriptor = await signingIdentity.generate("node-key.active");
    await stateStore.readOrCreate();
    await stateStore.update((current) => ({
      ...current,
      revision: current.revision + 1,
      activeNode: {
        hubOrigin,
        nodeId,
        activeKeyId: oldKeyId,
        activeKeySecretName: "node-key.active",
        cleanupPollingSecretName: null,
        enrolledAt: now - 100_000,
      },
    }));
    const resolution = await continuityStore.resolveContinuityId();
    if (resolution.status !== "resolved") throw new Error("unreachable");

    // The adapter `HubIdentityRuntime` installs, exercised with real key custody
    // and the real §7.2 encoder rather than a recording double.
    const continuity = {
      issue: async (input: {
        readonly hubOrigin: string;
        readonly oldKeyId: string;
        readonly oldKeySecretName: string;
        readonly newKeyId: string;
        readonly newKeySecretName: string;
      }) => {
        const oldKey = await signingIdentity.getPublicDescriptor(input.oldKeySecretName);
        const newKey = await signingIdentity.getPublicDescriptor(input.newKeySecretName);
        await continuityStore.append({
          hubOrigin: input.hubOrigin,
          continuityId: resolution.continuityId,
          oldKeyId: input.oldKeyId,
          oldPublicKey: oldKey.publicKey,
          newKeyId: input.newKeyId,
          newPublicKey: newKey.publicKey,
          createdAt: now,
          sign: (transcript) => signingIdentity.sign(input.oldKeySecretName, transcript),
        });
      },
      break: async () => undefined,
    };
    let status: HubKeyRotationStatus = { status: "awaiting_owner" };
    const client = makeHubKeyRotationClient({
      transport: {
        begin: async () => challenge(),
        prove: async () => status,
        status: async () => status,
      },
      stateStore,
      retirement,
      signingIdentity,
      continuity,
      now: () => now,
    });
    await client.stage(hubOrigin, { continuity: "continue" });
    status = { status: "activated", activatedAt: now + 20_000 };
    await client.resume(hubOrigin);
    const newDescriptor = await signingIdentity.getPublicDescriptor(
      (await stateStore.readOrCreate()).stagedRotation?.newKeySecretName ?? "",
    );
    await client.confirmNewKeyAuthenticated(hubOrigin, newKeyId);

    const record = await continuityStore.read();
    expect(record.chain).toHaveLength(1);
    expect(record.generationHighWater).toBe(1);
    const validated = validateNodeE2eeContinuityChain({
      chain: decodeContinuityEntries(record.chain),
      hubOrigin,
      continuityId: resolution.continuityId,
      identityPublicKey: newDescriptor.publicKey,
      // The pin a client held before the rotation: §13.3's silent pin update
      // requires the chain to walk from it to the node's current key.
      pinnedIdentityFingerprint: oldDescriptor.fingerprint,
    });
    expect(validated).toMatchObject({ kind: "ok", pinnedFingerprintUnchanged: false });
    // The outgoing key is gone, and the certificate it signed outlives it —
    // which is the entire point of signing before the deletion.
    expect(secretStore.values.has("node-key.active")).toBe(false);
  });
});
