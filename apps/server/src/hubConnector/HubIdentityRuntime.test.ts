import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { E2EE_PREKEY_ROTATION_OVERLAP } from "@ryco/shared/relayE2eeConstants";
import { deriveE2eeAgreementPublicKey } from "@ryco/shared/relayE2eeKeys";
import { describe, expect, it } from "vite-plus/test";

import { makeNodeContinuityAnchor } from "../hubIdentity/NodeContinuityAnchor.ts";
import { NODE_E2EE_FAIL_CLOSED_POLICY } from "../hubIdentity/NodeE2eePolicyStore.ts";
import { makeNodeE2eePrekeyStore } from "../hubIdentity/NodeE2eePrekeyStore.ts";
import { makeNodeIdentityContinuityStore } from "../hubIdentity/NodeIdentityContinuityStore.ts";
import { makeNodeIdentityKeyRetirementStore } from "../hubIdentity/NodeIdentityKeyRetirementStore.ts";
import { makeNodeSigningIdentity } from "../hubIdentity/NodeSigningIdentity.ts";
import {
  type ProtectedSecretStore,
  type ProtectedSecretStoreBackend,
  ProtectedSecretStoreError,
} from "../hubIdentity/ProtectedSecretStore.ts";
import {
  HubIdentityRuntimeError,
  HubRelayAuthenticationError,
  hubIdentityHoldsKeyMaterial,
  makeHubIdentityRuntime,
} from "./HubIdentityRuntime.ts";

const nodeId = `node_${"A".repeat(22)}`;
const activeKeyId = `nkey_${"B".repeat(22)}`;

function makeMemoryStore(
  backend: ProtectedSecretStoreBackend = "keytar",
): ProtectedSecretStore & { readonly values: Map<string, Uint8Array> } {
  const values = new Map<string, Uint8Array>();
  return {
    backend,
    values,
    get: async (name) => {
      const value = values.get(name);
      return value === undefined ? null : Uint8Array.from(value);
    },
    create: async (name, value) => {
      if (values.has(name)) throw new Error("conflict");
      values.set(name, Uint8Array.from(value));
    },
    remove: async (name) => {
      values.delete(name);
    },
  };
}

const enrollmentFetch = async (input: string | URL | Request) => {
  if (String(input).endsWith("/api/node/enrollments")) {
    return Response.json({
      deviceCode: "ABCD-EFGH",
      pollingSecret: Buffer.from(new Uint8Array(32).fill(0x51)).toString("base64url"),
      expiresAt: 160_000,
      pollIntervalMs: 1_000,
    });
  }
  throw new Error("unexpected route");
};

async function writeLegacyActiveState(
  statePath: string,
  options?: {
    readonly staged?: boolean;
    readonly nodeId?: string;
    /** Set to make the staged rotation one the Hub has already activated. */
    readonly activatedAt?: number;
    readonly continuityMode?: "continue" | "break";
  },
) {
  await mkdir(dirname(statePath), { recursive: true, mode: 0o700 });
  await writeFile(
    statePath,
    JSON.stringify({
      version: 1,
      revision: 4,
      environmentId: `env_${"E".repeat(22)}`,
      pendingEnrollment: null,
      activeNode: {
        hubOrigin: "https://relay.example",
        nodeId: options?.nodeId ?? `node_${"N".repeat(22)}`,
        activeKeyId: `nkey_${"K".repeat(22)}`,
        activeKeySecretName: "node-key.active",
        cleanupPollingSecretName: null,
        enrolledAt: 1,
      },
      stagedRotation: options?.staged
        ? {
            hubOrigin: "https://relay.example",
            rotationRequestId: `nrot_${"R".repeat(22)}`,
            newKeyId: `nkey_${"Q".repeat(22)}`,
            newKeySecretName: "node-key.staged",
            ...(options.continuityMode === undefined
              ? {}
              : { continuityMode: options.continuityMode }),
            stagedAt: 2,
            activatedAt: options.activatedAt ?? null,
          }
        : null,
      pendingTeardown: null,
    }),
    { mode: 0o600 },
  );
}

describe("HubIdentityRuntime", () => {
  it("enrolls, survives restart, and creates a fresh canonical proof without exporting keys", async () => {
    const root = await mkdtemp(join(tmpdir(), "ryco-hub-identity-runtime-"));
    const store = makeMemoryStore();
    let environmentId = "";
    let challengeRequests = 0;
    let challengeUnavailable = false;
    const fetchImplementation = async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/node/enrollments")) {
        const body = JSON.parse(String(init?.body)) as { environmentId: string };
        environmentId = body.environmentId;
        return Response.json({
          deviceCode: "ABCD-EFGH",
          pollingSecret: Buffer.from(new Uint8Array(32).fill(0x51)).toString("base64url"),
          expiresAt: 160_000,
          pollIntervalMs: 1_000,
        });
      }
      if (url.endsWith("/api/node/enrollments/poll")) {
        return Response.json({
          status: "approved",
          nodeId,
          environmentId,
          activeKeyId,
          enrolledAt: 101_000,
        });
      }
      if (url.endsWith("/api/node/auth/challenges")) {
        challengeRequests += 1;
        if (challengeUnavailable) {
          return new Response("PROOF-PREFLIGHT-RESPONSE-CANARY", { status: 503 });
        }
        return Response.json({
          protocolMajor: 1,
          protocolMinor: 2,
          challenge: Buffer.from(new Uint8Array(32).fill(challengeRequests)).toString("base64url"),
          challengeExpiresAt: 120_000,
        });
      }
      throw new Error("unexpected route");
    };
    const options = {
      statePath: join(root, "hub-identity.json"),
      fileSecretRoot: join(root, "secrets"),
      allowFileFallback: false,
      secretStore: store,
      fetch: fetchImplementation,
      now: () => 100_000,
    } as const;

    const runtime = await makeHubIdentityRuntime(options);
    const started = await runtime.startEnrollment("https://relay.example", {
      label: "Ryco node",
      platformOs: "linux",
      platformArch: "x64",
      clientVersion: "0.1.8",
    });
    expect(started.deviceCode).toBe("ABCD-EFGH");
    expect((await runtime.pollEnrollment("https://relay.example")).status).toBe("approved");
    const state = await runtime.readState();
    expect(state.activeNode).toMatchObject({ nodeId, activeKeyId });
    expect(JSON.stringify(state)).not.toContain("private");
    expect(JSON.stringify(state)).not.toContain("UVFRUVFR");

    const restarted = await makeHubIdentityRuntime(options);
    const localIntroduction = await restarted.localIntroduction.descriptor();
    expect(localIntroduction).toMatchObject({
      hubOrigin: "https://relay.example",
      environmentId,
      nodeId,
      nodePolicyGeneration: 1,
    });
    expect(localIntroduction.nodeIdentityPublicKey).toEqual(started.publicKey.publicKey);
    expect(localIntroduction.nodeIdentityFingerprint).toHaveLength(32);
    expect(localIntroduction.nodeContinuityId).toMatch(/^nct_[A-Za-z0-9_-]{22}$/);
    const first = await restarted.createRelayAuthenticationFrame("https://relay.example", {
      protocolMajor: 1,
      protocolMinor: 2,
    });
    const second = await restarted.createRelayAuthenticationFrame("https://relay.example", {
      protocolMajor: 1,
      protocolMinor: 2,
    });
    expect(first.nodeId).toBe(nodeId);
    expect(first.signature).toHaveLength(64);
    expect(first.nonce).not.toEqual(second.nonce);
    expect(challengeRequests).toBe(2);
    expect("secretStore" in restarted).toBe(false);

    challengeUnavailable = true;
    let error: unknown;
    try {
      await restarted.createRelayAuthenticationFrame("https://relay.example", {
        protocolMajor: 1,
        protocolMinor: 2,
      });
    } catch (cause) {
      error = cause;
    }
    expect(error).toBeInstanceOf(HubRelayAuthenticationError);
    expect(error).toMatchObject({ failure: "server_draining" });
    expect(String(error)).not.toContain("CANARY");
    expect(JSON.stringify(error)).not.toContain("CANARY");
  });

  it("re-reads a pending ceremony across a restart and recomputes its fingerprint", async () => {
    const root = await mkdtemp(join(tmpdir(), "ryco-hub-identity-pending-read-"));
    const store = makeMemoryStore();
    const fetchImplementation = async (input: string | URL | Request) => {
      if (String(input).endsWith("/api/node/enrollments")) {
        return Response.json({
          deviceCode: "ABCD-EFGH",
          pollingSecret: Buffer.from(new Uint8Array(32).fill(0x51)).toString("base64url"),
          expiresAt: 160_000,
          pollIntervalMs: 1_000,
        });
      }
      throw new Error("unexpected route");
    };
    const options = {
      statePath: join(root, "hub-identity.json"),
      fileSecretRoot: join(root, "secrets"),
      allowFileFallback: false,
      secretStore: store,
      fetch: fetchImplementation,
      now: () => 100_000,
    } as const;

    const runtime = await makeHubIdentityRuntime(options);
    const started = await runtime.startEnrollment("https://relay.example", {
      label: "Ryco node",
      platformOs: "linux",
      platformArch: "x64",
      clientVersion: "0.1.8",
    });

    // A fresh process: nothing from the start response is in memory any more.
    const restarted = await makeHubIdentityRuntime(options);
    const pending = await restarted.readPendingEnrollment("https://relay.example");

    expect(pending).not.toBeNull();
    expect(pending?.deviceCode).toBe("ABCD-EFGH");
    expect(pending?.label).toBe("Ryco node");
    expect(pending?.expiresAt).toBe(160_000);
    expect(pending?.pollIntervalMs).toBe(1_000);
    // The security property: the fingerprint is derived from the key actually in
    // custody, not read back from the state file, so it cannot be tampered into
    // disagreeing with what will sign the authentication transcript.
    expect(pending?.fingerprint).toEqual(started.publicKey.fingerprint);
    expect(pending?.algorithm).toBe("ed25519");

    // A different Hub must not see this node's pending ceremony.
    expect(await restarted.readPendingEnrollment("https://other.example")).toBeNull();

    await restarted.cancelEnrollment("https://relay.example");
    expect(await restarted.readPendingEnrollment("https://relay.example")).toBeNull();
  });

  it("erases every owned secret, mints a fresh EnvironmentId, and is idempotent", async () => {
    const root = await mkdtemp(join(tmpdir(), "ryco-hub-identity-leave-"));
    const store = makeMemoryStore();
    const options = {
      statePath: join(root, "hub-identity.json"),
      fileSecretRoot: join(root, "secrets"),
      allowFileFallback: false,
      secretStore: store,
      fetch: async (input: string | URL | Request) => {
        if (String(input).endsWith("/api/node/enrollments")) {
          return Response.json({
            deviceCode: "ABCD-EFGH",
            pollingSecret: Buffer.from(new Uint8Array(32).fill(0x51)).toString("base64url"),
            expiresAt: 160_000,
            pollIntervalMs: 1_000,
          });
        }
        throw new Error("unexpected route");
      },
      now: () => 100_000,
    } as const;

    const runtime = await makeHubIdentityRuntime(options);
    const before = await runtime.readState();
    await runtime.startEnrollment("https://relay.example", {
      label: "Ryco node",
      platformOs: "linux",
      platformArch: "x64",
      clientVersion: "0.1.8",
    });
    const pending = (await runtime.readState()).pendingEnrollment;
    expect(pending).not.toBeNull();

    await runtime.leave();

    const after = await runtime.readState();
    expect(after.pendingEnrollment).toBeNull();
    expect(after.activeNode).toBeNull();
    expect(after.stagedRotation).toBeNull();
    expect(after.pendingTeardown).toBeNull();
    // A fresh identifier is what lets the node rejoin the same Hub: the service
    // binds one node record per environment id, and that binding outlives
    // revocation.
    expect(after.environmentId).not.toBe(before.environmentId);
    // No key material may survive the erase.
    expect(await store.get(pending!.keySecretName)).toBeNull();
    expect(await store.get(pending!.pollingSecretName)).toBeNull();

    // Idempotent: the panel may retry a leave whose response was lost.
    await runtime.leave();
    expect((await runtime.readState()).environmentId).toBe(after.environmentId);
  });

  it("erases an identity key still queued for destruction, and drops the queue with it", async () => {
    const root = await mkdtemp(join(tmpdir(), "ryco-hub-identity-leave-queued-"));
    const store = makeMemoryStore();
    const statePath = join(root, "hub-identity.json");
    const runtime = await makeHubIdentityRuntime({
      statePath,
      fileSecretRoot: join(root, "secrets"),
      allowFileFallback: false,
      secretStore: store,
      fetch: enrollmentFetch,
      now: () => 100_000,
    });
    await runtime.startEnrollment("https://relay.example", {
      label: "Ryco node",
      platformOs: "linux",
      platformArch: "x64",
      clientVersion: "0.1.8",
    });

    // A promotion committed and its destruction did not: the key is out of
    // service and the only thing naming it is the durable queue, which lives in
    // a record of its own so a downgrade cannot delete that name.
    const retirement = await makeNodeIdentityKeyRetirementStore({
      path: join(root, "hub-identity-retirement.json"),
    });
    await store.create("node-key.retired", new Uint8Array(32).fill(0x7a));
    await retirement.enqueue("node-key.retired");

    await runtime.leave();

    // A leave that skipped it would orphan a live identity private key in the
    // credential store, where nothing could ever name it again.
    expect(await store.get("node-key.retired")).toBeNull();
    expect(await retirement.names()).toEqual([]);
  });

  it("finishes an interrupted leave on the next start, even with the keys already gone", async () => {
    const root = await mkdtemp(join(tmpdir(), "ryco-hub-identity-leave-resume-"));
    const store = makeMemoryStore();
    const statePath = join(root, "hub-identity.json");
    const options = {
      statePath,
      fileSecretRoot: join(root, "secrets"),
      allowFileFallback: false,
      secretStore: store,
      now: () => 100_000,
    } as const;

    // A state file that crashed between phase one and phase three: the teardown
    // marker is committed and the key it names is already deleted. Without the
    // resume this is unstartable, because start-up validation reads custody for
    // an activeNode whose key no longer exists.
    await writeFile(
      statePath,
      JSON.stringify({
        version: 1,
        revision: 4,
        environmentId: `env_${"E".repeat(22)}`,
        pendingEnrollment: null,
        activeNode: {
          hubOrigin: "https://relay.example",
          nodeId: `node_${"N".repeat(22)}`,
          activeKeyId: `nkey_${"K".repeat(22)}`,
          activeKeySecretName: "node-key.gone",
          cleanupPollingSecretName: null,
          enrolledAt: 1,
        },
        stagedRotation: null,
        pendingTeardown: { secretNames: ["node-key.gone"], requestedAt: 99_000 },
      }),
      { mode: 0o600 },
    );

    const runtime = await makeHubIdentityRuntime(options);
    const state = await runtime.readState();

    expect(state.activeNode).toBeNull();
    expect(state.pendingTeardown).toBeNull();
    expect(state.environmentId).not.toBe(`env_${"E".repeat(22)}`);
  });

  it("leaves startup's writes to a process that owns the identity when asked to defer", async () => {
    const root = await mkdtemp(join(tmpdir(), "ryco-hub-identity-deferred-start-"));
    const statePath = join(root, "hub-identity.json");
    await writeFile(
      statePath,
      JSON.stringify({
        version: 1,
        revision: 4,
        environmentId: `env_${"E".repeat(22)}`,
        pendingEnrollment: null,
        activeNode: null,
        stagedRotation: null,
        pendingTeardown: { secretNames: ["node-key.gone"], requestedAt: 99_000 },
      }),
      { mode: 0o600 },
    );
    const options = {
      statePath,
      fileSecretRoot: join(root, "secrets"),
      allowFileFallback: false,
      secretStore: makeMemoryStore(),
      now: () => 100_000,
    } as const;

    // Another backend owns this identity: it may be the one finishing that
    // leave, and a policy committed here could not close its channels.
    const waiting = await makeHubIdentityRuntime({ ...options, deferStartup: true });
    expect((await waiting.readState()).pendingTeardown).not.toBeNull();
    expect(waiting.e2eeGeneration()).toBe(0);
    expect(waiting.e2eePolicy()).toEqual(NODE_E2EE_FAIL_CLOSED_POLICY);

    // It exited; this one owns the identity now.
    await Promise.all([waiting.completeStartup!(), waiting.completeStartup!()]);
    expect((await waiting.readState()).pendingTeardown).toBeNull();
    expect(waiting.e2eeGeneration()).toBeGreaterThan(0);
  });

  it("reports key material from state files alone", async () => {
    const root = await mkdtemp(join(tmpdir(), "ryco-hub-identity-material-"));
    const fresh = join(root, "fresh", "hub-identity.json");
    await mkdir(dirname(fresh), { recursive: true, mode: 0o700 });
    expect(await hubIdentityHoldsKeyMaterial({ statePath: fresh })).toBe(false);

    const enrolled = join(root, "enrolled", "hub-identity.json");
    await writeLegacyActiveState(enrolled);
    expect(await hubIdentityHoldsKeyMaterial({ statePath: enrolled })).toBe(true);
  });

  it("builds key custody for an identity-less node without touching the OS store", async () => {
    // A Desktop standby connector builds this runtime on every launch; it must
    // not raise a credential-store prompt before anyone asks to enroll.
    const root = await mkdtemp(join(tmpdir(), "ryco-hub-identity-standby-"));
    const touched: string[] = [];
    const osStore = makeMemoryStore("keytar");
    const runtime = await makeHubIdentityRuntime({
      statePath: join(root, "state", "hub-identity.json"),
      fileSecretRoot: join(root, "secrets"),
      allowFileFallback: false,
      makeOsSecretStore: async () => ({
        backend: osStore.backend,
        get: async (name) => {
          touched.push(`get:${name}`);
          return osStore.get(name);
        },
        create: async (name, value) => {
          touched.push(`create:${name}`);
          await osStore.create(name, value);
        },
        remove: async (name) => {
          touched.push(`remove:${name}`);
          await osStore.remove(name);
        },
      }),
      fetch: enrollmentFetch,
      now: () => 100_000,
    });
    const state = await runtime.readState();
    expect(state.activeNode).toBeNull();
    expect(state.pendingEnrollment).toBeNull();
    expect(touched).toEqual([]);
  });

  it("keeps a file-backed identity on files when the OS store later becomes available", async () => {
    const root = await mkdtemp(join(tmpdir(), "ryco-hub-identity-file-affinity-"));
    const fileStore = makeMemoryStore("permissioned-file");
    let initialOsAttempts = 0;
    const options = {
      statePath: join(root, "hub-identity.json"),
      fileSecretRoot: join(root, "secrets"),
      allowFileFallback: true,
      makeOsSecretStore: async () => {
        initialOsAttempts += 1;
        throw new ProtectedSecretStoreError("protected_store_unavailable");
      },
      makeFileSecretStore: async () => fileStore,
      fetch: enrollmentFetch,
      now: () => 100_000,
    } as const;

    const runtime = await makeHubIdentityRuntime(options);
    await runtime.startEnrollment("https://relay.example", {
      label: "Ryco node",
      platformOs: "linux",
      platformArch: "x64",
      clientVersion: "0.1.8",
    });
    expect((await runtime.readState()).protectedStoreBackend).toBe("permissioned-file");
    expect(initialOsAttempts).toBe(1);

    let restartedOsAttempts = 0;
    const restarted = await makeHubIdentityRuntime({
      ...options,
      makeOsSecretStore: async () => {
        restartedOsAttempts += 1;
        return makeMemoryStore("keytar");
      },
    });

    expect(restarted.backend).toBe("permissioned-file");
    expect(restartedOsAttempts).toBe(0);
    expect(await restarted.readPendingEnrollment("https://relay.example")).not.toBeNull();
  });

  it("never falls through from an OS-backed identity to the file store", async () => {
    const root = await mkdtemp(join(tmpdir(), "ryco-hub-identity-os-affinity-"));
    const osStore = makeMemoryStore("keytar");
    const fileStore = makeMemoryStore("permissioned-file");
    const options = {
      statePath: join(root, "hub-identity.json"),
      fileSecretRoot: join(root, "secrets"),
      allowFileFallback: true,
      makeOsSecretStore: async () => osStore,
      makeFileSecretStore: async () => fileStore,
      fetch: enrollmentFetch,
      now: () => 100_000,
    } as const;

    const runtime = await makeHubIdentityRuntime(options);
    await runtime.startEnrollment("https://relay.example", {
      label: "Ryco node",
      platformOs: "linux",
      platformArch: "x64",
      clientVersion: "0.1.8",
    });
    expect((await runtime.readState()).protectedStoreBackend).toBe("os");

    let fileAttempts = 0;
    await expect(
      makeHubIdentityRuntime({
        ...options,
        makeOsSecretStore: async () => {
          throw new ProtectedSecretStoreError("protected_store_unavailable");
        },
        makeFileSecretStore: async () => {
          fileAttempts += 1;
          return fileStore;
        },
      }),
    ).rejects.toMatchObject({ code: "identity_store_unavailable" });
    expect(fileAttempts).toBe(0);
  });

  it("requires the explicit fallback permission for a file-backed identity", async () => {
    const root = await mkdtemp(join(tmpdir(), "ryco-hub-identity-file-permission-"));
    const fileStore = makeMemoryStore("permissioned-file");
    const options = {
      statePath: join(root, "hub-identity.json"),
      fileSecretRoot: join(root, "secrets"),
      allowFileFallback: true,
      makeOsSecretStore: async () => {
        throw new ProtectedSecretStoreError("protected_store_unavailable");
      },
      makeFileSecretStore: async () => fileStore,
      fetch: enrollmentFetch,
      now: () => 100_000,
    } as const;

    const runtime = await makeHubIdentityRuntime(options);
    await runtime.startEnrollment("https://relay.example", {
      label: "Ryco node",
      platformOs: "linux",
      platformArch: "x64",
      clientVersion: "0.1.8",
    });

    await expect(
      makeHubIdentityRuntime({ ...options, allowFileFallback: false }),
    ).rejects.toMatchObject({ code: "identity_store_unavailable" });
  });

  it("issues, re-signs, and erases the E2EE agreement prekey alongside the identity", async () => {
    const root = await mkdtemp(join(tmpdir(), "ryco-hub-identity-e2ee-prekey-"));
    const statePath = join(root, "hub-identity.json");
    const prekeyStatePath = join(root, "hub-e2ee-prekey.json");
    const store = makeMemoryStore();
    await makeNodeSigningIdentity(store).generate("node-key.active");
    await writeLegacyActiveState(statePath);
    let clock = 1_700_000_000_000;
    const options = {
      statePath,
      prekeyStatePath,
      continuityStatePath: join(root, "hub-continuity.json"),
      continuityAnchorPath: join(root, "anchor", "hub-continuity.json"),
      fileSecretRoot: join(root, "secrets"),
      allowFileFallback: false,
      secretStore: store,
      now: () => clock,
    } as const;
    const readPrekeys = async () =>
      (await makeNodeE2eePrekeyStore({ path: prekeyStatePath })).read();

    // §6.4: the node validates its own prekey certificate at startup, which for
    // a node that has never had one means issuing the first.
    const runtime = await makeHubIdentityRuntime(options);
    const issued = await runtime.readE2eePrekeyCertificate("https://relay.example");
    const first = (await readPrekeys()).e2eePrekey!;
    expect(first.prekeyId).toBe(issued.prekeyId);
    expect(first.createdAt).toBe(clock);
    // Public material in the record; the scalar only in the protected store.
    expect(store.values.get(first.secretName)).toHaveLength(32);
    expect(
      Buffer.from(deriveE2eeAgreementPublicKey(store.values.get(first.secretName)!)).toString(
        "base64url",
      ),
    ).toBe(first.agreementPublicKey);
    expect(JSON.stringify(await readPrekeys())).not.toContain(
      Buffer.from(store.values.get(first.secretName)!).toString("base64url"),
    );
    // And not in the identity record at all: a binary older than this feature
    // reconstructs that file from its known keys, which would drop the only
    // handle the node has on a live agreement key.
    expect(JSON.stringify(await runtime.readState())).not.toContain(first.secretName);

    // A restart inside the rotation overlap re-signs, and the displaced key
    // stays alive for the overlap window.
    clock = issued.expiresAt - E2EE_PREKEY_ROTATION_OVERLAP;
    const restarted = await makeHubIdentityRuntime(options);
    const renewed = (await readPrekeys()).e2eePrekey!;
    const outgoing = (await readPrekeys()).outgoingE2eePrekey!;
    expect(renewed.prekeyId).not.toBe(first.prekeyId);
    expect(outgoing.prekeyId).toBe(first.prekeyId);
    expect(store.values.has(outgoing.secretName)).toBe(true);

    // The forced rotation §6.4 requires of the CLI.
    const forced = await restarted.rotateE2eePrekey("https://relay.example");
    expect(forced.prekeyId).not.toBe(renewed.prekeyId);
    const borrowed = await restarted.withE2eePrekeySecret(
      "https://relay.example",
      forced.prekeyId,
      (secretKey) => Buffer.from(deriveE2eeAgreementPublicKey(secretKey)).toString("hex"),
    );
    expect(borrowed).toBe(Buffer.from(forced.agreementPublicKey).toString("hex"));

    // A leave must erase both agreement keys. Omitting either from the owned
    // set would orphan key material in the credential store forever.
    const finalPrekeys = await readPrekeys();
    const agreementNames = [
      finalPrekeys.e2eePrekey!.secretName,
      finalPrekeys.outgoingE2eePrekey!.secretName,
    ];
    await restarted.leave();
    for (const name of agreementNames) expect(await store.get(name)).toBeNull();
    expect(await store.get("node-key.active")).toBeNull();
    const cleared = await readPrekeys();
    expect(cleared.e2eePrekey).toBeNull();
    expect(cleared.outgoingE2eePrekey).toBeNull();
  });

  it("re-issues the prekey when a rotation activates, without waiting for a restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "ryco-hub-identity-e2ee-rebind-"));
    const statePath = join(root, "hub-identity.json");
    const prekeyStatePath = join(root, "hub-e2ee-prekey.json");
    const store = makeMemoryStore();
    const signing = makeNodeSigningIdentity(store);
    await signing.generate("node-key.active");
    await signing.generate("node-key.staged");
    await writeLegacyActiveState(statePath, { staged: true });
    const now = 1_700_000_000_000;
    const newKeyId = `nkey_${"Q".repeat(22)}`;
    const runtime = await makeHubIdentityRuntime({
      statePath,
      prekeyStatePath,
      continuityStatePath: join(root, "hub-continuity.json"),
      continuityAnchorPath: join(root, "anchor", "hub-continuity.json"),
      fileSecretRoot: join(root, "secrets"),
      allowFileFallback: false,
      secretStore: store,
      now: () => now,
      fetch: async (input: string | URL | Request) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.endsWith("/api/node/key-rotations/status")) {
          return Response.json({ status: "activated", activatedAt: now });
        }
        throw new Error("unexpected route");
      },
    });

    const before = await runtime.readE2eePrekeyCertificate("https://relay.example");
    expect(before.identityKeyId).toBe(`nkey_${"K".repeat(22)}`);

    // Activation is the moment the authentication-key selector starts returning
    // the incoming key, so it is the moment §7.3 element 4 stops matching. The
    // certificate has to be re-issued here rather than at the next restart:
    // under effective `requireE2EE` a node with no advertisable prekey is a
    // fatal pre-key condition on every channel (§11.2), for as long as it runs.
    const status = await runtime.resumeKeyRotation("https://relay.example");
    expect(status.status).toBe("activated");

    const after = await runtime.readE2eePrekeyCertificate("https://relay.example");
    expect(after.identityKeyId).toBe(newKeyId);
    expect(after.prekeyId).not.toBe(before.prekeyId);
    const record = await (await makeNodeE2eePrekeyStore({ path: prekeyStatePath })).read();
    expect(record.e2eePrekey?.identityKeyId).toBe(newKeyId);
    // The displaced prekey keeps its §6.4 overlap: a channel that already
    // advertised it must still be able to complete against it.
    expect(record.outgoingE2eePrekey?.prekeyId).toBe(before.prekeyId);
  });

  it("keeps one continuity lineage across restarts, and across a leave", async () => {
    const root = await mkdtemp(join(tmpdir(), "ryco-hub-identity-continuity-"));
    // Laid out the way the connector lays it out: everything the operator
    // restores under one state directory, and the §5.7 anchor outside it.
    const statePath = join(root, "userdata", "hub-identity.json");
    const continuityStatePath = join(root, "userdata", "hub-continuity.json");
    const continuityAnchorPath = join(root, "anchors", "userdata", "hub-continuity.json");
    const store = makeMemoryStore();
    await makeNodeSigningIdentity(store).generate("node-key.active");
    await writeLegacyActiveState(statePath);
    const options = {
      statePath,
      continuityStatePath,
      continuityAnchorPath,
      prekeyStatePath: join(root, "userdata", "hub-e2ee-prekey.json"),
      fileSecretRoot: join(root, "secrets"),
      allowFileFallback: false,
      secretStore: store,
      now: () => 1_700_000_000_000,
    } as const;
    const anchor = await makeNodeContinuityAnchor({ path: continuityAnchorPath });

    const runtime = await makeHubIdentityRuntime(options);
    const first = await runtime.readE2eeContinuity("https://relay.example");
    expect(first).toMatchObject({ status: "advertisable", chain: [], generation: 0, repair: null });
    if (first.status !== "advertisable") throw new Error("unreachable");
    expect(first.continuityId).toMatch(/^nct_[A-Za-z0-9_-]{22}$/);
    // §5.7 property (b): the anchor lives OUTSIDE the state directory, which is
    // the half of §7.5 an operator restore of that directory cannot roll back.
    expect(continuityAnchorPath.startsWith(dirname(statePath))).toBe(false);
    expect((await anchor.read())?.continuityId).toBe(first.continuityId);

    const restarted = await makeHubIdentityRuntime(options);
    const second = await restarted.readE2eeContinuity("https://relay.example");
    expect(second).toMatchObject({
      status: "advertisable",
      continuityId: first.continuityId,
      repair: null,
    });

    // A leave erases the Hub identity and deliberately breaks the chain, but it
    // is not allowed to erase the lineage: keeping the id is what leaves the
    // §13.3 re-verification path reachable for a client pinned to the old key.
    await restarted.leave();
    expect(await store.get("node-key.active")).toBeNull();
    expect((await anchor.read())?.continuityId).toBe(first.continuityId);
    const continuity = await makeNodeIdentityContinuityStore({
      path: continuityStatePath,
      anchor,
    });
    const record = await continuity.read();
    expect(record.continuityId).toBe(first.continuityId);
    expect(record.chain).toEqual([]);
    expect(record.lastBreak).toMatchObject({ reason: "left_hub" });
  });

  it("completes a promotion whose certificate was already retained, with the outgoing key gone", async () => {
    const root = await mkdtemp(join(tmpdir(), "ryco-hub-identity-promotion-retry-"));
    const statePath = join(root, "hub-identity.json");
    const continuityStatePath = join(root, "hub-continuity.json");
    const continuityAnchorPath = join(root, "anchor", "hub-continuity.json");
    const store = makeMemoryStore();
    const signing = makeNodeSigningIdentity(store);
    const outgoing = await signing.generate("node-key.active");
    const incoming = await signing.generate("node-key.staged");
    await writeLegacyActiveState(statePath, {
      staged: true,
      activatedAt: 3,
      continuityMode: "continue",
    });
    const options = {
      statePath,
      continuityStatePath,
      continuityAnchorPath,
      prekeyStatePath: join(root, "hub-e2ee-prekey.json"),
      fileSecretRoot: join(root, "secrets"),
      allowFileFallback: false,
      secretStore: store,
      now: () => 1_700_000_000_000,
    } as const;

    const runtime = await makeHubIdentityRuntime(options);
    const lineage = await runtime.readE2eeContinuity("https://relay.example");
    if (lineage.status !== "advertisable") throw new Error("unreachable");

    // The state a promotion is left in when it retained its §7.5 certificate and
    // then failed: the link exists, the promotion does not. `append` is
    // idempotent precisely so the operator can retry from here.
    const continuity = await makeNodeIdentityContinuityStore({
      path: continuityStatePath,
      anchor: await makeNodeContinuityAnchor({ path: continuityAnchorPath }),
    });
    await continuity.append({
      hubOrigin: "https://relay.example",
      continuityId: lineage.continuityId,
      oldKeyId: `nkey_${"K".repeat(22)}`,
      oldPublicKey: outgoing.publicKey,
      newKeyId: `nkey_${"Q".repeat(22)}`,
      newPublicKey: incoming.publicKey,
      createdAt: 1_700_000_000_000,
      sign: (transcript) => signing.sign("node-key.active", transcript),
    });
    // ...and the outgoing key is already gone, which is the case that used to
    // wedge: resolving its public half through the credential store fails, so
    // the retry never reached the idempotent append that exists to make it safe.
    await store.remove("node-key.active");

    await runtime.confirmAuthenticatedKey("https://relay.example", `nkey_${"Q".repeat(22)}`);

    const promoted = await runtime.readState();
    expect(promoted.activeNode?.activeKeyId).toBe(`nkey_${"Q".repeat(22)}`);
    expect(promoted.stagedRotation).toBeNull();
    // Exactly one certificate: a second one for the same rotation would be a
    // chain whose links no longer meet.
    const record = await continuity.read();
    expect(record.chain).toHaveLength(1);
    expect(record.generationHighWater).toBe(1);
    expect(await runtime.readE2eeContinuity("https://relay.example")).toMatchObject({
      status: "advertisable",
      continuityId: lineage.continuityId,
      generation: 1,
      chainBreak: null,
    });
  });

  it("reports a chain that reaches no key in custody, rather than throwing", async () => {
    const root = await mkdtemp(join(tmpdir(), "ryco-hub-identity-lost-key-"));
    const statePath = join(root, "hub-identity.json");
    const store = makeMemoryStore();
    await makeNodeSigningIdentity(store).generate("node-key.active");
    await writeLegacyActiveState(statePath);
    const runtime = await makeHubIdentityRuntime({
      statePath,
      continuityStatePath: join(root, "hub-continuity.json"),
      continuityAnchorPath: join(root, "anchor", "hub-continuity.json"),
      prekeyStatePath: join(root, "hub-e2ee-prekey.json"),
      fileSecretRoot: join(root, "secrets"),
      allowFileFallback: false,
      secretStore: store,
      now: () => 1_700_000_000_000,
    });
    const before = await runtime.readE2eeContinuity("https://relay.example");
    if (before.status !== "advertisable") throw new Error("unreachable");

    // The identity record names a key the node no longer holds. §7.5 has an
    // answer for that — the chain reaches nothing in custody, so it is broken —
    // and the caller of this operation has only `advertisable` and `unavailable`
    // to act on, so a raw signing error would be an answer it cannot use.
    await store.remove("node-key.active");
    const after = await runtime.readE2eeContinuity("https://relay.example");
    expect(after).toMatchObject({
      status: "advertisable",
      continuityId: before.continuityId,
      chain: [],
    });
  });

  it("declines to advertise, rather than minting, when two values claim the lineage", async () => {
    const root = await mkdtemp(join(tmpdir(), "ryco-hub-identity-continuity-conflict-"));
    const statePath = join(root, "hub-identity.json");
    const continuityStatePath = join(root, "hub-continuity.json");
    const continuityAnchorPath = join(root, "anchor", "hub-continuity.json");
    const store = makeMemoryStore();
    await makeNodeSigningIdentity(store).generate("node-key.active");
    await writeLegacyActiveState(statePath);
    const options = {
      statePath,
      continuityStatePath,
      continuityAnchorPath,
      prekeyStatePath: join(root, "hub-e2ee-prekey.json"),
      fileSecretRoot: join(root, "secrets"),
      allowFileFallback: false,
      secretStore: store,
    } as const;

    const runtime = await makeHubIdentityRuntime(options);
    const resolved = await runtime.readE2eeContinuity("https://relay.example");
    if (resolved.status !== "advertisable") throw new Error("unreachable");

    // An anchor that disagrees with the stored value: §5.5 U2. The node has no
    // conforming statement to build, and minting one would be a fleet-wide
    // re-verification event it must not cause by itself.
    await (
      await makeNodeContinuityAnchor({ path: continuityAnchorPath })
    ).setContinuityId(`nct_${"Y".repeat(22)}`);
    const conflicted = await (
      await makeHubIdentityRuntime(options)
    ).readE2eeContinuity("https://relay.example");
    expect(conflicted).toMatchObject({ status: "unavailable", reason: "anchor_disagrees" });
    // Startup is unaffected: whether a node that cannot advertise may still
    // relay is a policy decision, not a custody failure.
    expect((await runtime.readState()).activeNode?.activeKeySecretName).toBe("node-key.active");

    // The explicit recovery: re-adopt the value the operator confirms.
    const readopted = await runtime.adoptE2eeContinuityId(resolved.continuityId);
    expect(readopted).toBe(resolved.continuityId);
    expect(await runtime.readE2eeContinuity("https://relay.example")).toMatchObject({
      status: "advertisable",
      continuityId: resolved.continuityId,
    });

    // The other outcome mints a fresh lineage, deliberately.
    const reminted = await runtime.remintE2eeContinuityId();
    expect(reminted).not.toBe(resolved.continuityId);
    expect(await runtime.readE2eeContinuity("https://relay.example")).toMatchObject({
      status: "advertisable",
      continuityId: reminted,
    });
  });

  it("starts without E2EE rather than failing when no prekey can be issued", async () => {
    const root = await mkdtemp(join(tmpdir(), "ryco-hub-identity-e2ee-unserviceable-"));
    const statePath = join(root, "hub-identity.json");
    const store = makeMemoryStore();
    await makeNodeSigningIdentity(store).generate("node-key.active");
    await writeLegacyActiveState(statePath, { nodeId: `node_${"L".repeat(30)}` });

    // A Hub-minted node id longer than the §7.1 identifier format admits cannot
    // be encoded into a §7.3 transcript. That decides whether this node can SERVE
    // E2EE, not whether it can run.
    const prekeyStatePath = join(root, "hub-e2ee-prekey.json");
    const runtime = await makeHubIdentityRuntime({
      statePath,
      prekeyStatePath,
      continuityStatePath: join(root, "hub-continuity.json"),
      continuityAnchorPath: join(root, "anchor", "hub-continuity.json"),
      fileSecretRoot: join(root, "secrets"),
      allowFileFallback: false,
      secretStore: store,
    });
    expect(
      (await (await makeNodeE2eePrekeyStore({ path: prekeyStatePath })).read()).e2eePrekey,
    ).toBeNull();
    await expect(runtime.readE2eePrekeyCertificate("https://relay.example")).rejects.toMatchObject({
      code: "e2ee_prekey_unavailable",
    });
    // The relay path is unaffected.
    expect((await runtime.readState()).activeNode?.activeKeySecretName).toBe("node-key.active");
  });

  it("migrates a legacy file identity only when exactly one store owns its keys", async () => {
    const root = await mkdtemp(join(tmpdir(), "ryco-hub-identity-legacy-file-"));
    const statePath = join(root, "hub-identity.json");
    const osStore = makeMemoryStore("keytar");
    const fileStore = makeMemoryStore("permissioned-file");
    await makeNodeSigningIdentity(fileStore).generate("node-key.active");
    await writeLegacyActiveState(statePath);

    const runtime = await makeHubIdentityRuntime({
      statePath,
      fileSecretRoot: join(root, "secrets"),
      allowFileFallback: true,
      makeOsSecretStore: async () => osStore,
      makeFileSecretStore: async () => fileStore,
    });

    expect(runtime.backend).toBe("permissioned-file");
    expect((await runtime.readState()).protectedStoreBackend).toBe("permissioned-file");
  });

  it("fails closed for absent, ambiguous, or split legacy key custody", async () => {
    const makeLegacyOptions = async (
      label: string,
      configure: (
        osStore: ReturnType<typeof makeMemoryStore>,
        fileStore: ReturnType<typeof makeMemoryStore>,
      ) => Promise<void>,
      staged = false,
    ) => {
      const root = await mkdtemp(join(tmpdir(), `ryco-hub-identity-legacy-${label}-`));
      const statePath = join(root, "hub-identity.json");
      const osStore = makeMemoryStore("keytar");
      const fileStore = makeMemoryStore("permissioned-file");
      await configure(osStore, fileStore);
      await writeLegacyActiveState(statePath, { staged });
      return {
        statePath,
        fileSecretRoot: join(root, "secrets"),
        allowFileFallback: true,
        makeOsSecretStore: async () => osStore,
        makeFileSecretStore: async () => fileStore,
      } as const;
    };

    await expect(
      makeHubIdentityRuntime(await makeLegacyOptions("absent", async () => undefined)),
    ).rejects.toMatchObject({ code: "identity_store_unavailable" });

    await expect(
      makeHubIdentityRuntime(
        await makeLegacyOptions("ambiguous", async (osStore, fileStore) => {
          await makeNodeSigningIdentity(osStore).generate("node-key.active");
          await makeNodeSigningIdentity(fileStore).generate("node-key.active");
        }),
      ),
    ).rejects.toMatchObject({ code: "identity_store_unavailable" });

    await expect(
      makeHubIdentityRuntime(
        await makeLegacyOptions(
          "split",
          async (osStore, fileStore) => {
            await makeNodeSigningIdentity(osStore).generate("node-key.active");
            await makeNodeSigningIdentity(fileStore).generate("node-key.staged");
          },
          true,
        ),
      ),
    ).rejects.toMatchObject({ code: "identity_store_unavailable" });
  });

  it("bounds a legacy custody inspection failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "ryco-hub-identity-legacy-locked-"));
    const statePath = join(root, "hub-identity.json");
    const osStore = {
      ...makeMemoryStore("keytar"),
      get: async () => {
        throw new ProtectedSecretStoreError("protected_store_unavailable");
      },
    };
    await writeLegacyActiveState(statePath);

    await expect(
      makeHubIdentityRuntime({
        statePath,
        fileSecretRoot: join(root, "secrets"),
        allowFileFallback: false,
        makeOsSecretStore: async () => osStore,
      }),
    ).rejects.toMatchObject({ code: "identity_store_unavailable" });
  });

  it("fails restart with a bounded error when enrolled key custody is missing", async () => {
    const root = await mkdtemp(join(tmpdir(), "ryco-hub-identity-missing-"));
    const store = makeMemoryStore();
    let environmentId = "";
    const fetchImplementation = async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/node/enrollments")) {
        environmentId = (JSON.parse(String(init?.body)) as { environmentId: string }).environmentId;
        return Response.json({
          deviceCode: "ABCD-EFGH",
          pollingSecret: Buffer.from(new Uint8Array(32).fill(7)).toString("base64url"),
          expiresAt: 160_000,
          pollIntervalMs: 1_000,
        });
      }
      return Response.json({
        status: "approved",
        nodeId,
        environmentId,
        activeKeyId,
        enrolledAt: 101_000,
      });
    };
    const options = {
      statePath: join(root, "hub-identity.json"),
      fileSecretRoot: join(root, "secrets"),
      allowFileFallback: false,
      secretStore: store,
      fetch: fetchImplementation,
      now: () => 100_000,
    } as const;
    const runtime = await makeHubIdentityRuntime(options);
    await runtime.startEnrollment("https://relay.example", {
      label: "Ryco node",
      platformOs: "linux",
      platformArch: "x64",
      clientVersion: "0.1.8",
    });
    await runtime.pollEnrollment("https://relay.example");
    store.values.clear();

    let error: unknown;
    try {
      await makeHubIdentityRuntime(options);
    } catch (cause) {
      error = cause;
    }
    expect(error).toBeInstanceOf(HubIdentityRuntimeError);
    expect(error).toMatchObject({ code: "identity_unavailable" });
    expect(String(error)).not.toContain(nodeId);
    expect(JSON.stringify(error)).not.toContain(nodeId);
  });
});
