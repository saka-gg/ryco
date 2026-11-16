import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vite-plus/test";

import {
  type HubEnrollmentPollResponse,
  type HubEnrollmentTransport,
  makeHubEnrollmentClient,
} from "./HubEnrollmentClient.ts";
import { makeLocalHubIdentityStateStore } from "./LocalHubIdentityState.ts";
import { makeNodeSigningIdentity } from "./NodeSigningIdentity.ts";
import type { ProtectedSecretStore } from "./ProtectedSecretStore.ts";

function memorySecretStore(): ProtectedSecretStore & {
  readonly values: Map<string, Uint8Array>;
  readonly removeFailures: Set<string>;
} {
  const values = new Map<string, Uint8Array>();
  const removeFailures = new Set<string>();
  return {
    backend: "permissioned-file",
    values,
    removeFailures,
    get: async (name) => {
      const value = values.get(name);
      return value === undefined ? null : Uint8Array.from(value);
    },
    create: async (name, value) => {
      if (values.has(name)) throw new Error("conflict");
      values.set(name, Uint8Array.from(value));
    },
    remove: async (name) => {
      if (removeFailures.has(name)) throw new Error("injected removal failure");
      values.delete(name);
    },
  };
}

async function harness(
  transport: HubEnrollmentTransport,
  options: {
    readonly now?: () => number;
    readonly sleep?: (milliseconds: number) => Promise<void>;
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "ryco-enrollment-client-"));
  const statePath = join(root, "identity.json");
  const stateStore = await makeLocalHubIdentityStateStore(statePath);
  const secretStore = memorySecretStore();
  const signingIdentity = makeNodeSigningIdentity(secretStore);
  const makeClient = () =>
    makeHubEnrollmentClient({
      transport,
      stateStore,
      secretStore,
      signingIdentity,
      ...options,
    });
  return { root, statePath, stateStore, secretStore, signingIdentity, makeClient };
}

const metadata = {
  label: "Build node",
  platformOs: "linux",
  platformArch: "x64",
  clientVersion: "0.1.8",
} as const;
const now = 1_784_160_000_000;
const pollingSecret = new Uint8Array(32).fill(0x73);
const approved: HubEnrollmentPollResponse = {
  status: "approved",
  nodeId: "node_AAAAAAAAAAAAAAAAAAAAAA",
  environmentId: "env_REPLACED_BY_TEST_VALUE",
  activeKeyId: "nkey_BBBBBBBBBBBBBBBBBBBBBB",
  enrolledAt: now + 10_000,
};

describe("Hub enrollment client", () => {
  it("generates locally, persists only protected references, and resumes approval", async () => {
    let capturedEnvironmentId = "";
    let capturedLabel = "";
    let capturedPublicKeyLength = 0;
    let polls = 0;
    const transport: HubEnrollmentTransport = {
      start: async (request) => {
        capturedEnvironmentId = request.environmentId;
        capturedLabel = request.label;
        capturedPublicKeyLength = request.publicKey.publicKey.byteLength;
        return {
          deviceCode: "ABCD-EFGH",
          pollingSecret,
          expiresAt: now + 600_000,
          pollIntervalMs: 5_000,
        };
      },
      poll: async () => {
        polls += 1;
        return polls === 1
          ? { status: "pending", retryAfterMs: 5_000 }
          : { ...approved, environmentId: capturedEnvironmentId };
      },
    };
    const test = await harness(transport, { now: () => now });
    const started = await test.makeClient().start("https://hub.example.com", metadata);
    expect(started.deviceCode).toBe("ABCD-EFGH");
    expect(started.environmentId).toBe(capturedEnvironmentId);
    expect(capturedLabel).toBe(metadata.label);
    expect(capturedPublicKeyLength).toBe(32);
    expect((await test.stateStore.readOrCreate()).pendingEnrollment?.label).toBe(metadata.label);
    expect(await test.makeClient().poll("https://hub.example.com")).toEqual({
      status: "pending",
      retryAfterMs: 5_000,
    });
    expect(await test.makeClient().poll("https://hub.example.com")).toEqual({
      ...approved,
      environmentId: capturedEnvironmentId,
    });

    const persisted = await readFile(test.statePath, "utf8");
    expect(persisted).not.toContain(Buffer.from(pollingSecret).toString("base64url"));
    expect(persisted).not.toContain(Buffer.from(pollingSecret).toString("hex"));
    expect(test.secretStore.values.size).toBe(1);

    const noNetworkClient = makeHubEnrollmentClient({
      transport: {
        start: async () => {
          throw new Error("unexpected network call");
        },
        poll: async () => {
          throw new Error("unexpected network call");
        },
      },
      stateStore: test.stateStore,
      secretStore: test.secretStore,
      signingIdentity: test.signingIdentity,
      now: () => now,
    });
    expect(await noNetworkClient.poll("https://hub.example.com")).toEqual({
      ...approved,
      environmentId: capturedEnvironmentId,
    });
  });

  it("allows clock skew against the Hub's ceremony expiry, and still expires locally", async () => {
    // The Hub stamps expiresAt on its own clock; this node's clock runs a minute ahead.
    const hubExpiresAt = now + 600_000;
    let clock = now;
    let polls = 0;
    const transport: HubEnrollmentTransport = {
      start: async () => ({
        deviceCode: "ABCD-EFGH",
        pollingSecret,
        expiresAt: hubExpiresAt,
        pollIntervalMs: 5_000,
      }),
      poll: async () => {
        polls += 1;
        return { status: "pending", retryAfterMs: 5_000 };
      },
    };
    const test = await harness(transport, { now: () => clock });
    await test.makeClient().start("https://hub.example.com", metadata);

    clock = hubExpiresAt + 60_000;
    expect(await test.makeClient().poll("https://hub.example.com")).toEqual({
      status: "pending",
      retryAfterMs: 5_000,
    });
    expect(polls).toBe(1);
    expect((await test.stateStore.readOrCreate()).pendingEnrollment).not.toBeNull();

    clock = hubExpiresAt + 60 * 60_000;
    expect(await test.makeClient().poll("https://hub.example.com")).toEqual({
      status: "unavailable",
      reason: "expired",
    });
    expect(polls).toBe(1);
    expect((await test.stateStore.readOrCreate()).pendingEnrollment).toBeNull();
  });

  it("recovers when the first approved poll response is lost", async () => {
    let environmentId = "";
    let pollAttempts = 0;
    const transport: HubEnrollmentTransport = {
      start: async (request) => {
        environmentId = request.environmentId;
        return {
          deviceCode: "2345-6789",
          pollingSecret,
          expiresAt: now + 600_000,
          pollIntervalMs: 5_000,
        };
      },
      poll: async () => {
        pollAttempts += 1;
        if (pollAttempts === 1) throw new Error("response lost after server commit");
        return { ...approved, environmentId };
      },
    };
    const test = await harness(transport, { now: () => now });
    const client = test.makeClient();
    await client.start("https://hub.example.com", metadata);
    await expect(client.poll("https://hub.example.com")).rejects.toMatchObject({
      code: "enrollment_transport_failed",
    });
    expect(await test.makeClient().poll("https://hub.example.com")).toEqual({
      ...approved,
      environmentId,
    });
  });

  it("accepts the full canonical relay NodeId length range", async () => {
    let environmentId = "";
    const longNodeId = `node_${"A".repeat(43)}`;
    const transport: HubEnrollmentTransport = {
      start: async (request) => {
        environmentId = request.environmentId;
        return {
          deviceCode: "ABCD-EFGH",
          pollingSecret,
          expiresAt: now + 600_000,
          pollIntervalMs: 5_000,
        };
      },
      poll: async () => ({ ...approved, nodeId: longNodeId, environmentId }),
    };
    const test = await harness(transport, { now: () => now });
    await test.makeClient().start("https://hub.example.com", metadata);
    expect(await test.makeClient().poll("https://hub.example.com")).toMatchObject({
      status: "approved",
      nodeId: longNodeId,
    });
  });

  it("cancels locally without creating a server cancellation path", async () => {
    const transport: HubEnrollmentTransport = {
      start: async () => ({
        deviceCode: "ABCD-EFGH",
        pollingSecret,
        expiresAt: now + 600_000,
        pollIntervalMs: 5_000,
      }),
      poll: async () => ({ status: "pending", retryAfterMs: 5_000 }),
    };
    const test = await harness(transport, { now: () => now });
    const client = test.makeClient();
    await client.start("https://hub.example.com", metadata);
    expect(test.secretStore.values.size).toBe(2);
    await client.cancel("https://hub.example.com");
    expect(test.secretStore.values.size).toBe(0);
    expect((await test.stateStore.readOrCreate()).pendingEnrollment).toBeNull();
  });

  it("retains retryable cleanup references across removal failure and restart", async () => {
    let environmentId = "";
    const transport: HubEnrollmentTransport = {
      start: async (request) => {
        environmentId = request.environmentId;
        return {
          deviceCode: "ABCD-EFGH",
          pollingSecret,
          expiresAt: now + 600_000,
          pollIntervalMs: 5_000,
        };
      },
      poll: async () => ({ ...approved, environmentId }),
    };
    const test = await harness(transport, { now: () => now });
    const client = test.makeClient();
    await client.start("https://hub.example.com", metadata);
    const pending = (await test.stateStore.readOrCreate()).pendingEnrollment;
    expect(pending).not.toBeNull();
    test.secretStore.removeFailures.add(pending!.pollingSecretName);
    expect(await client.poll("https://hub.example.com")).toMatchObject({ status: "approved" });
    expect((await test.stateStore.readOrCreate()).activeNode?.cleanupPollingSecretName).toBe(
      pending!.pollingSecretName,
    );

    test.secretStore.removeFailures.clear();
    const resumed = test.makeClient();
    expect(await resumed.poll("https://hub.example.com")).toMatchObject({ status: "approved" });
    expect((await test.stateStore.readOrCreate()).activeNode?.cleanupPollingSecretName).toBeNull();
    expect(test.secretStore.values.has(pending!.pollingSecretName)).toBe(false);
  });

  it("does not clear pending state until cancellation credentials are deleted", async () => {
    const transport: HubEnrollmentTransport = {
      start: async () => ({
        deviceCode: "ABCD-EFGH",
        pollingSecret,
        expiresAt: now + 600_000,
        pollIntervalMs: 5_000,
      }),
      poll: async () => ({ status: "pending", retryAfterMs: 5_000 }),
    };
    const test = await harness(transport, { now: () => now });
    const client = test.makeClient();
    await client.start("https://hub.example.com", metadata);
    const pending = (await test.stateStore.readOrCreate()).pendingEnrollment!;
    test.secretStore.removeFailures.add(pending.pollingSecretName);
    await expect(client.cancel("https://hub.example.com")).rejects.toMatchObject({
      code: "enrollment_local_state_failed",
    });
    expect((await test.stateStore.readOrCreate()).pendingEnrollment).not.toBeNull();
    test.secretStore.removeFailures.clear();
    await test.makeClient().cancel("https://hub.example.com");
    expect((await test.stateStore.readOrCreate()).pendingEnrollment).toBeNull();
  });

  it("applies bounded poll backoff until terminal", async () => {
    let environmentId = "";
    let polls = 0;
    const delays: number[] = [];
    const transport: HubEnrollmentTransport = {
      start: async (request) => {
        environmentId = request.environmentId;
        return {
          deviceCode: "ABCD-EFGH",
          pollingSecret,
          expiresAt: now + 600_000,
          pollIntervalMs: 5_000,
        };
      },
      poll: async () => {
        polls += 1;
        return polls < 3
          ? { status: "pending", retryAfterMs: polls * 5_000 }
          : { ...approved, environmentId };
      },
    };
    const test = await harness(transport, {
      now: () => now,
      sleep: async (delay) => {
        delays.push(delay);
      },
    });
    const client = test.makeClient();
    await client.start("https://hub.example.com", metadata);
    expect(await client.pollUntilTerminal("https://hub.example.com")).toMatchObject({
      status: "approved",
    });
    expect(delays).toEqual([5_000, 10_000]);
  });

  it("rejects malformed responses without reflecting bearer values", async () => {
    const canary = new TextEncoder().encode("polling-secret-canary-value-1234");
    const transport: HubEnrollmentTransport = {
      start: async () => ({
        deviceCode: "invalid-device-code",
        pollingSecret: canary,
        expiresAt: now + 600_000,
        pollIntervalMs: 5_000,
      }),
      poll: async () => ({ status: "unavailable", reason: "rejected" }),
    };
    const test = await harness(transport, { now: () => now });
    let error: unknown;
    try {
      await test.makeClient().start("https://hub.example.com", metadata);
    } catch (cause) {
      error = cause;
    }
    expect(String(error)).not.toContain(new TextDecoder().decode(canary));
    expect(JSON.stringify(error)).not.toContain(new TextDecoder().decode(canary));
    expect(test.secretStore.values.size).toBe(0);
  });
});
