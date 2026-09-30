import { generateKeyPairSync } from "node:crypto";

import { describe, expect, it } from "vite-plus/test";

import {
  RELAY_INITIAL_LIMITS,
  type RelayChannelId,
  type RelayFrame,
  type RelayNodeAuthHandshake,
} from "@ryco/contracts/relay";
import { decodeRelayFrame, encodeRelayFrame } from "@ryco/shared/relayCodec";
import { e2eeSha256 } from "@ryco/shared/relayE2eeKeys";
import { stripRelayChunkCapabilityPrelude } from "@ryco/shared/relayMessageChunks";

import { DEFAULT_HUB_CONNECTOR_CONFIG, type HubConnectorConfig } from "../config.ts";
import type { NodeE2eeAdvertisement } from "../hubIdentity/NodeE2eeCapabilityStatement.ts";
import { NODE_E2EE_FAIL_CLOSED_POLICY } from "../hubIdentity/NodeE2eePolicyStore.ts";
import { HubRelayAuthenticationError, type HubIdentityRuntimeShape } from "./HubIdentityRuntime.ts";
import {
  stubCrossDeviceApprovalService,
  stubIdentityE2eeAdmin,
  stubNativeNodeClaimService,
} from "./testUtils/e2eeOperatorStub.ts";
import type { HubRelaySocket, HubRelaySocketEventMap } from "./HubRelayTransport.ts";
import { HubConnector, type HubConnectorScheduler } from "./HubConnector.ts";
import type { RelayChannelSendHandle } from "./RelayChannelRegistry.ts";

class FakeSocket implements HubRelaySocket {
  bufferedAmount = 0;
  readyState = 0;
  readonly sent: Uint8Array[] = [];
  readonly listeners = new Map<string, Set<(event: never) => void>>();
  closeCalls = 0;

  send(bytes: Uint8Array): void {
    this.sent.push(Uint8Array.from(bytes));
  }
  close(): void {
    this.closeCalls += 1;
  }
  addEventListener<K extends keyof HubRelaySocketEventMap>(
    type: K,
    listener: (event: HubRelaySocketEventMap[K]) => void,
  ): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener as (event: never) => void);
    this.listeners.set(type, set);
  }
  removeEventListener<K extends keyof HubRelaySocketEventMap>(
    type: K,
    listener: (event: HubRelaySocketEventMap[K]) => void,
  ): void {
    this.listeners.get(type)?.delete(listener as (event: never) => void);
  }
  emit<K extends keyof HubRelaySocketEventMap>(type: K, event: HubRelaySocketEventMap[K]): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event as never);
  }
}

function encoded(frame: RelayFrame): Uint8Array {
  const result = encodeRelayFrame(frame);
  if (!result.ok) throw new Error(result.error.code);
  return result.value;
}

function ed25519PublicKey(): Uint8Array {
  const key = generateKeyPairSync("ed25519").publicKey.export({ format: "der", type: "spki" });
  return Uint8Array.from(key.subarray(key.byteLength - 32));
}

function e2eeAdvertisement(statementByte: number, expiresAt: number): NodeE2eeAdvertisement {
  const statement = Uint8Array.of(statementByte);
  return {
    hubOrigin: "https://relay.example",
    statement,
    statementDigest: e2eeSha256(statement),
    expiresAt,
  } as NodeE2eeAdvertisement;
}

function identity(overrides: Partial<HubIdentityRuntimeShape> = {}): HubIdentityRuntimeShape {
  return {
    backend: "keytar",
    localIntroduction: {
      descriptor: async () => {
        throw new Error("unused");
      },
      complete: async () => {
        throw new Error("unused");
      },
    },
    nativeNodeClaim: stubNativeNodeClaimService(),
    crossDeviceApproval: stubCrossDeviceApprovalService(),
    readPendingEnrollment: async () => null,
    leave: async () => undefined,
    readState: async () => ({
      version: 1,
      revision: 1,
      environmentId: `env_${"E".repeat(22)}`,
      protectedStoreBackend: "os" as const,
      pendingEnrollment: null,
      activeNode: {
        hubOrigin: "https://relay.example",
        nodeId: `node_${"N".repeat(22)}`,
        activeKeyId: `nkey_${"K".repeat(22)}`,
        activeKeySecretName: "node-key.fixture",
        cleanupPollingSecretName: null,
        enrolledAt: 1,
      },
      stagedRotation: null,
      pendingTeardown: null,
    }),
    startEnrollment: async () => {
      throw new Error("unused");
    },
    pollEnrollment: async () => {
      throw new Error("unused");
    },
    cancelEnrollment: async () => undefined,
    createRelayAuthenticationFrame: async () =>
      ({
        type: "auth",
        peer: "node",
        protocolMajor: 1,
        protocolMinor: 2,
        nodeId: `node_${"N".repeat(22)}`,
        nonce: new Uint8Array(32).fill(1),
        signature: new Uint8Array(64).fill(2),
      }) as RelayNodeAuthHandshake,
    stageKeyRotation: async () => ({ status: "awaiting_owner" }),
    resumeKeyRotation: async () => ({ status: "awaiting_owner" }),
    confirmAuthenticatedKey: async () => ({ continuityBreak: null }),
    readE2eePrekeyCertificate: async () => {
      throw new Error("unused");
    },
    readStoredE2eePrekey: async () => null,
    rotateE2eePrekey: async () => {
      throw new Error("unused");
    },
    withE2eePrekeySecret: async () => {
      throw new Error("unused");
    },
    readE2eeContinuity: async () => {
      throw new Error("unused");
    },
    breakE2eeContinuity: async () => undefined,
    adoptE2eeContinuityId: async () => {
      throw new Error("unused");
    },
    remintE2eeContinuityId: async () => {
      throw new Error("unused");
    },
    e2eePolicy: () => NODE_E2EE_FAIL_CLOSED_POLICY,
    e2eeAuthorizationAdmin: stubIdentityE2eeAdmin(),
    e2eeGeneration: () => 0,
    applyE2eePolicy: async () => {
      throw new Error("unused");
    },
    previewE2eePolicy: () => ({
      policy: NODE_E2EE_FAIL_CLOSED_POLICY,
      withdrawal: false,
      changed: false,
      counts: { legacy: 0, nxE2ee: 0, suiteWithdrawn: 0, abortedHandshakes: 0 },
    }),
    recoverE2eeGeneration: async () => {
      throw new Error("unused");
    },
    resetE2eeFallbackState: async () => {
      throw new Error("unused");
    },
    readE2eeAdvertisement: async () => ({
      kind: "unavailable" as const,
      reason: "identity_unavailable" as const,
    }),
    recordE2eeFallback: async () => undefined,
    stopE2eeInstrumentation: async () => undefined,
    readE2eeFallbackState: () => ({
      windowStartedAt: undefined,
      classes: {
        "peer-legacy": { occurrences: 0, ringOverflows: 0, lastOccurrenceAt: undefined },
        "advertisement-unavailable": {
          occurrences: 0,
          ringOverflows: 0,
          lastOccurrenceAt: undefined,
        },
      },
      ring: [],
    }),
    registerE2eeChannel: () => ({
      selectHandshake: () => ({
        establish: () => ({ kind: "entered" as const, established: () => undefined }),
      }),
      lockLegacy: () => ({ kind: "entered" as const }),
      release: () => undefined,
    }),
    e2eeClientAuthorization: {
      lookupClientAuthorization: () => undefined,
      reReadAuthorization: () => undefined,
      registerInFlightHandshake: () => ({
        establish: () => ({ kind: "refused" as const, reason: "authorization_withdrawn" as const }),
        release: () => undefined,
      }),
      // No record set, so §13.2 step 3 has no slot to admit one into.
      evaluatePairingAdmission: () => ({
        kind: "refused" as const,
        reason: "pending_cap_global" as const,
        spentPairingWindow: undefined,
      }),
      commitPairingAdmission: async () => undefined,
    },
    ...overrides,
  };
}

const enrollmentMetadata = {
  label: "Test node",
  platformOs: "darwin" as const,
  platformArch: "arm64" as const,
  clientVersion: "0.1.8",
};

function scheduler() {
  let now = 1_000_000;
  let nextId = 0;
  const timers = new Map<number, { callback: () => void; due: number }>();
  const value: HubConnectorScheduler = {
    now: () => now,
    random: () => 0.5,
    setTimeout: (callback, milliseconds) => {
      const id = ++nextId;
      timers.set(id, { callback, due: now + milliseconds });
      return id;
    },
    clearTimeout: (handle) => {
      timers.delete(handle as number);
    },
  };
  const advance = async (milliseconds: number) => {
    now += milliseconds;
    const due = [...timers.entries()]
      .filter(([, timer]) => timer.due <= now)
      .toSorted((left, right) => left[1].due - right[1].due);
    for (const [id, timer] of due) {
      timers.delete(id);
      timer.callback();
      await Promise.resolve();
      await Promise.resolve();
    }
  };
  return { value, timers, advance };
}

const enabledConfig: HubConnectorConfig = {
  ...DEFAULT_HUB_CONNECTOR_CONFIG,
  enabled: true,
  origin: "https://relay.example",
};

const settle = async (turns = 10) => {
  for (let index = 0; index < turns; index += 1) await Promise.resolve();
};

describe("HubConnector", () => {
  it("does no network work while disabled", async () => {
    let opens = 0;
    const connector = new HubConnector({
      config: DEFAULT_HUB_CONNECTOR_CONFIG,
      identity: identity(),
      transport: {
        open: () => {
          opens += 1;
          return new FakeSocket();
        },
      },
      channels: {
        open: async () => {
          throw new Error("unused");
        },
      },
      enrollmentMetadata,
      livenessWatch: false,
    });
    await connector.start();
    expect(connector.status().state).toBe("disabled");
    expect(opens).toBe(0);
    await connector.stop();
  });

  it("authenticates one socket, answers heartbeat, backs off once, and shuts down cleanly", async () => {
    const clock = scheduler();
    const sockets: FakeSocket[] = [];
    const connector = new HubConnector({
      config: enabledConfig,
      identity: identity(),
      transport: {
        open: () => {
          const socket = new FakeSocket();
          sockets.push(socket);
          return socket;
        },
      },
      channels: {
        open: async () => {
          throw new Error("unused");
        },
      },
      enrollmentMetadata,
      livenessWatch: false,
      scheduler: clock.value,
    });
    const starting = connector.start();
    await settle();
    expect(sockets).toHaveLength(1);
    sockets[0]!.emit("open", {} as Event);
    sockets[0]!.emit("message", {
      data: encoded({
        type: "ready",
        protocolMajor: 1,
        protocolMinor: 2,
        limits: RELAY_INITIAL_LIMITS,
      }),
    } as MessageEvent);
    await starting;
    expect(connector.status()).toMatchObject({ state: "online", activeChannels: 0 });
    expect(sockets[0]!.sent).toHaveLength(1);

    sockets[0]!.emit("message", {
      data: encoded({
        type: "ping",
        protocolMajor: 1,
        protocolMinor: 2,
        nonce: new Uint8Array(8).fill(4),
      }),
    } as MessageEvent);
    await Promise.resolve();
    await Promise.resolve();
    expect(sockets[0]!.sent).toHaveLength(2);
    const pong = decodeRelayFrame(sockets[0]!.sent[1]!);
    expect(pong.ok && pong.value.type).toBe("pong");

    sockets[0]!.emit("close", {} as CloseEvent);
    await Promise.resolve();
    await Promise.resolve();
    expect(connector.status()).toMatchObject({
      state: "degraded",
      degradedMode: "backing_off",
      failure: "network_unavailable",
    });
    expect(clock.timers.size).toBe(1);
    await clock.advance(1_000);
    expect(sockets).toHaveLength(2);

    await connector.stop();
    expect(connector.status().state).toBe("disabled");
    expect(clock.timers.size).toBe(0);
    expect([...sockets[0]!.listeners.values()].every((set) => set.size === 0)).toBe(true);
  });

  it("publishes and gates minor-3 E2EE state by exact generation, digest, and verifier keys", async () => {
    const clock = scheduler();
    const socket = new FakeSocket();
    let currentAdvertisement = e2eeAdvertisement(1, 2_000_000);
    const revocations: RelayFrame[] = [];
    const activeIdentity = identity();
    const connector = new HubConnector({
      config: enabledConfig,
      identity: identity({
        createRelayAuthenticationFrame: async () => {
          const frame = await activeIdentity.createRelayAuthenticationFrame(
            "https://relay.example",
            { protocolMajor: 1, protocolMinor: 3 },
          );
          return { ...frame, protocolMinor: 3 } as RelayNodeAuthHandshake;
        },
        readE2eeAdvertisement: async () => ({
          kind: "available" as const,
          advertisement: currentAdvertisement,
        }),
      }),
      transport: { open: () => socket },
      channels: { open: async () => Promise.reject(new Error("unused")) },
      enrollmentMetadata,
      livenessWatch: false,
      scheduler: clock.value,
      onE2eeEnrollmentRevoked: (frame) => {
        revocations.push(frame);
      },
    });
    const starting = connector.start();
    await settle();
    socket.emit("open", {} as Event);
    socket.emit("message", {
      data: encoded({
        type: "ready",
        protocolMajor: 1,
        protocolMinor: 3,
        limits: RELAY_INITIAL_LIMITS,
      }),
    } as MessageEvent);
    // The Hub sends its verifier keyset immediately after `ready`. The
    // connector must retain this frame until its generation-scoped E2EE state
    // and channel registry are installed.
    socket.emit("message", {
      data: encoded({
        type: "e2ee.verifier-keys",
        protocolMajor: 1,
        protocolMinor: 3,
        generation: 1,
        keys: [
          {
            keyId: `hgk_${"K".repeat(22)}`,
            publicKey: ed25519PublicKey(),
            notBefore: 900_000,
            notAfter: 1_100_000,
          },
        ],
      } as unknown as RelayFrame),
    } as MessageEvent);
    await starting;

    const published = socket.sent
      .map((bytes) => decodeRelayFrame(bytes))
      .find((result) => Boolean(result.ok && result.value.type === "node.e2ee.statement"));
    expect(published).toMatchObject({
      ok: true,
      value: {
        type: "node.e2ee.statement",
        protocolMinor: 3,
        statement: currentAdvertisement.statement,
        statementDigest: currentAdvertisement.statementDigest,
      },
    });
    const connectorGeneration = connector.e2eeSnapshot().connectorGeneration!;
    expect(connector.e2eeSnapshot().accountGrantReady).toBe(false);

    socket.emit("message", {
      data: encoded({
        type: "node.e2ee.statement.ack",
        protocolMajor: 1,
        protocolMinor: 3,
        connectorGeneration: connectorGeneration - 1,
        statementDigest: currentAdvertisement.statementDigest,
      } as unknown as RelayFrame),
    } as MessageEvent);
    await settle();
    expect(connector.e2eeSnapshot().acknowledgedStatementDigest).toBeUndefined();

    socket.emit("message", {
      data: encoded({
        type: "node.e2ee.statement.ack",
        protocolMajor: 1,
        protocolMinor: 3,
        connectorGeneration,
        statementDigest: currentAdvertisement.statementDigest,
      } as unknown as RelayFrame),
    } as MessageEvent);
    await settle();
    expect(connector.e2eeSnapshot().accountGrantReady).toBe(true);

    currentAdvertisement = e2eeAdvertisement(2, 2_100_000);
    await connector.refreshE2eeState();
    expect(connector.e2eeSnapshot()).toMatchObject({
      accountGrantReady: false,
      acknowledgedStatementDigest: undefined,
      currentStatementDigest: currentAdvertisement.statementDigest,
    });

    socket.emit("message", {
      data: encoded({
        type: "e2ee.enrollment-revoked",
        protocolMajor: 1,
        protocolMinor: 3,
        enrollmentId: `enr_${"E".repeat(22)}`,
        enrollmentRevision: 1,
        accountAuthEpoch: 1,
        deviceAuthEpoch: 2,
      } as unknown as RelayFrame),
    } as MessageEvent);
    await settle();
    expect(revocations).toHaveLength(1);
    await connector.stop();
    expect(connector.e2eeSnapshot().accountGrantReady).toBe(false);
  });

  it("retries a transient proof preflight with fresh material and one timer", async () => {
    const clock = scheduler();
    const activeIdentity = identity();
    const sockets: FakeSocket[] = [];
    let proofAttempts = 0;
    const connector = new HubConnector({
      config: enabledConfig,
      identity: {
        ...activeIdentity,
        createRelayAuthenticationFrame: async (...input) => {
          proofAttempts += 1;
          if (proofAttempts === 1) throw new HubRelayAuthenticationError("server_draining");
          const frame = await activeIdentity.createRelayAuthenticationFrame(...input);
          if (frame.peer !== "node") throw new Error("unexpected authentication peer");
          return { ...frame, nonce: new Uint8Array(32).fill(proofAttempts) };
        },
      },
      transport: {
        open: () => {
          const socket = new FakeSocket();
          sockets.push(socket);
          return socket;
        },
      },
      channels: { open: async () => Promise.reject(new Error("unused")) },
      enrollmentMetadata,
      livenessWatch: false,
      scheduler: clock.value,
    });

    const starting = connector.start();
    await settle();
    expect(connector.status()).toMatchObject({
      state: "degraded",
      degradedMode: "backing_off",
      failure: "server_draining",
    });
    expect(proofAttempts).toBe(1);
    expect(sockets).toHaveLength(0);
    expect(clock.timers.size).toBe(1);

    await clock.advance(1_000);
    await settle();
    expect(proofAttempts).toBe(2);
    expect(sockets).toHaveLength(1);
    sockets[0]!.emit("open", {} as Event);
    const auth = decodeRelayFrame(sockets[0]!.sent[0]!);
    expect(
      auth.ok && auth.value.type === "auth" && auth.value.peer === "node" && auth.value.nonce,
    ).toEqual(new Uint8Array(32).fill(2));
    sockets[0]!.emit("message", {
      data: encoded({
        type: "ready",
        protocolMajor: 1,
        protocolMinor: 2,
        limits: RELAY_INITIAL_LIMITS,
      }),
    } as MessageEvent);
    await starting;
    await settle();
    expect(connector.status().state).toBe("online");
    expect(clock.timers.size).toBe(2);
    await connector.stop();
    expect(clock.timers.size).toBe(0);
  });

  it("flushes asynchronous channel output without waiting for another inbound frame", async () => {
    const socket = new FakeSocket();
    const channelId = `ch_${"W".repeat(22)}` as RelayChannelId;
    let sendChannelBytes: RelayChannelSendHandle | undefined;
    const connector = new HubConnector({
      config: enabledConfig,
      identity: identity(),
      transport: { open: () => socket },
      channels: {
        open: async ({ send }) => {
          sendChannelBytes = send;
          return {
            receive: async () => true,
            queuedBytes: async () => 0,
            supportsChunkedMessages: () => false,
            close: async () => undefined,
          };
        },
      },
      enrollmentMetadata,
      livenessWatch: false,
    });
    const starting = connector.start();
    await settle();
    socket.emit("open", {} as Event);
    socket.emit("message", {
      data: encoded({
        type: "ready",
        protocolMajor: 1,
        protocolMinor: 2,
        limits: RELAY_INITIAL_LIMITS,
      }),
    } as MessageEvent);
    await starting;
    socket.emit("message", {
      data: encoded({
        type: "channel.open",
        protocolMajor: 1,
        protocolMinor: 2,
        channelId,
        capability: "ryco.rpc",
        effectiveRole: "operator",
      }),
    } as MessageEvent);
    await settle();
    expect(decodeRelayFrame(socket.sent.at(-1)!)).toMatchObject({
      ok: true,
      value: { type: "channel.accept", channelId },
    });

    expect(sendChannelBytes?.(Uint8Array.of(0, 255, 7))).toEqual({ accepted: true });
    await Promise.resolve();
    const output = decodeRelayFrame(socket.sent.at(-1)!);
    expect(output).toMatchObject({
      ok: true,
      value: { type: "data", channelId, sequence: 0 },
    });
    expect(
      output.ok &&
        output.value.type === "data" &&
        stripRelayChunkCapabilityPrelude(output.value.payload).message,
    ).toEqual(Uint8Array.of(0, 255, 7));
    await connector.stop();
  });

  it("puts a channel's last record on the wire before the outer channel.close", async () => {
    // The ordering §10.3-style close protocols depend on, asserted through the
    // production wiring rather than a test hook: the registry drains the
    // channel itself, so this holds however the connector schedules flushes.
    const socket = new FakeSocket();
    const channelId = `ch_${"F".repeat(22)}` as RelayChannelId;
    let sendChannelBytes: ((bytes: Uint8Array) => boolean) | undefined;
    let closeChannel: ((reason: "channel_rejected") => void) | undefined;
    const connector = new HubConnector({
      config: enabledConfig,
      identity: identity(),
      transport: { open: () => socket },
      channels: {
        open: async ({ send, close }) => {
          sendChannelBytes = (bytes) => send(bytes).accepted;
          closeChannel = close;
          return {
            receive: async () => true,
            queuedBytes: async () => 0,
            supportsChunkedMessages: () => false,
            close: async () => undefined,
          };
        },
      },
      enrollmentMetadata,
      livenessWatch: false,
    });
    const starting = connector.start();
    await settle();
    socket.emit("open", {} as Event);
    socket.emit("message", {
      data: encoded({
        type: "ready",
        protocolMajor: 1,
        protocolMinor: 2,
        limits: RELAY_INITIAL_LIMITS,
      }),
    } as MessageEvent);
    await starting;
    socket.emit("message", {
      data: encoded({
        type: "channel.open",
        protocolMajor: 1,
        protocolMinor: 2,
        channelId,
        capability: "ryco.rpc",
        effectiveRole: "operator",
      }),
    } as MessageEvent);
    await settle();
    socket.sent.length = 0;

    expect(sendChannelBytes?.(Uint8Array.of(0xff, 0x03))).toBe(true);
    closeChannel?.("channel_rejected");
    await settle();

    const frames = socket.sent.map((bytes) => {
      const decoded = decodeRelayFrame(bytes);
      if (!decoded.ok) throw new Error(decoded.error.code);
      return decoded.value;
    });
    expect(frames.map((frame) => frame.type)).toEqual(["data", "channel.close"]);
    expect(
      frames[0]?.type === "data" && stripRelayChunkCapabilityPrelude(frames[0].payload).message,
    ).toEqual(Uint8Array.of(0xff, 0x03));
    expect(frames[1]).toMatchObject({ channelId, reason: "channel_rejected" });
    await connector.stop();
  });

  it("gives the first channel after enrollment approval a connection identity", async () => {
    // The first connect after approval publishes the registry before its
    // post-authentication identity read completes, so a channel opened in that
    // window used to be handed no Hub origin and no node id — for its entire
    // lifetime, since the value was captured once at open.
    const clock = scheduler();
    const socket = new FakeSocket();
    const channelId = `ch_${"E".repeat(22)}` as RelayChannelId;
    const nodeId = `node_${"N".repeat(22)}`;
    let pending = false;
    let readCalls = 0;
    let releaseIdentityRead: (() => void) | undefined;
    const identityRead = new Promise<void>((resolve) => {
      releaseIdentityRead = resolve;
    });
    let connection:
      | (() => { readonly hubOrigin: string; readonly nodeId: string } | undefined)
      | undefined;
    const connector = new HubConnector({
      config: enabledConfig,
      identity: identity({
        readState: async () => {
          readCalls += 1;
          // The post-authentication read, and only that one, is held open.
          if (readCalls > 2) await identityRead;
          return {
            version: 1,
            revision: 1,
            environmentId: `env_${"E".repeat(22)}`,
            protectedStoreBackend: "os" as const,
            pendingEnrollment: pending
              ? {
                  hubOrigin: "https://relay.example",
                  keySecretName: "node-key.fixture",
                  pollingSecretName: "enrollment-poll.fixture",
                  label: "Test node",
                  deviceCode: "ABCD-EFGH",
                  createdAt: 1,
                  expiresAt: 2_000_000,
                  pollIntervalMs: 1_000,
                  cleanupRequested: false,
                }
              : null,
            activeNode:
              readCalls > 2
                ? {
                    hubOrigin: "https://relay.example",
                    nodeId,
                    activeKeyId: `nkey_${"K".repeat(22)}`,
                    activeKeySecretName: "node-key.fixture",
                    cleanupPollingSecretName: null,
                    enrolledAt: 1,
                  }
                : null,
            stagedRotation: null,
            pendingTeardown: null,
          };
        },
        startEnrollment: async () => {
          pending = true;
          return {
            deviceCode: "ABCD-EFGH",
            expiresAt: 2_000_000,
            pollIntervalMs: 1_000,
            environmentId: `env_${"E".repeat(22)}`,
            publicKey: {
              algorithm: "ed25519" as const,
              publicKey: new Uint8Array(32),
              fingerprint: new Uint8Array(32),
            },
          };
        },
        pollEnrollment: async () => ({
          status: "approved" as const,
          nodeId,
          environmentId: `env_${"E".repeat(22)}`,
          activeKeyId: `nkey_${"K".repeat(22)}`,
          enrolledAt: 1,
        }),
      }),
      transport: { open: () => socket },
      channels: {
        open: async (input) => {
          connection = input.connection;
          return {
            receive: async () => true,
            queuedBytes: async () => 0,
            supportsChunkedMessages: () => false,
            close: async () => undefined,
          };
        },
      },
      enrollmentMetadata,
      livenessWatch: false,
      scheduler: clock.value,
    });
    await connector.start();
    await connector.enroll();
    await clock.advance(1_000);
    await settle();
    socket.emit("open", {} as Event);
    socket.emit("message", {
      data: encoded({
        type: "ready",
        protocolMajor: 1,
        protocolMinor: 2,
        limits: RELAY_INITIAL_LIMITS,
      }),
    } as MessageEvent);
    await Promise.resolve();
    socket.emit("message", {
      data: encoded({
        type: "channel.open",
        protocolMajor: 1,
        protocolMinor: 2,
        channelId,
        capability: "ryco.rpc",
        effectiveRole: "operator",
      }),
    } as MessageEvent);
    await settle();

    // The channel is live while the identity read is still outstanding, and it
    // already knows who this connection is.
    expect(connector.status().state).toBe("authenticating");
    expect(connection?.()).toEqual({ hubOrigin: "https://relay.example", nodeId });

    releaseIdentityRead?.();
    await settle();
    expect(connector.status()).toMatchObject({ state: "online", activeChannels: 1 });
    // Still read live, not captured at open.
    expect(connection?.()).toEqual({ hubOrigin: "https://relay.example", nodeId });
    await connector.stop();
  });

  it("handles a channel opened immediately after ready while identity confirmation is pending", async () => {
    const socket = new FakeSocket();
    const channelId = `ch_${"I".repeat(22)}` as RelayChannelId;
    const activeIdentity = identity();
    let readCalls = 0;
    let releaseIdentityRead: (() => void) | undefined;
    const identityRead = new Promise<void>((resolve) => {
      releaseIdentityRead = resolve;
    });
    const connector = new HubConnector({
      config: enabledConfig,
      identity: {
        ...activeIdentity,
        readState: async () => {
          readCalls += 1;
          if (readCalls > 1) await identityRead;
          return activeIdentity.readState();
        },
      },
      transport: { open: () => socket },
      channels: {
        open: async () => ({
          receive: async () => true,
          queuedBytes: async () => 0,
          supportsChunkedMessages: () => false,
          close: async () => undefined,
        }),
      },
      enrollmentMetadata,
      livenessWatch: false,
    });
    const starting = connector.start();
    await settle();
    socket.emit("open", {} as Event);
    socket.emit("message", {
      data: encoded({
        type: "ready",
        protocolMajor: 1,
        protocolMinor: 2,
        limits: RELAY_INITIAL_LIMITS,
      }),
    } as MessageEvent);
    await Promise.resolve();
    socket.emit("message", {
      data: encoded({
        type: "channel.open",
        protocolMajor: 1,
        protocolMinor: 2,
        channelId,
        capability: "ryco.rpc",
        effectiveRole: "operator",
      }),
    } as MessageEvent);
    await settle();

    expect(connector.status().state).toBe("authenticating");
    expect(decodeRelayFrame(socket.sent.at(-1)!)).toMatchObject({
      ok: true,
      value: { type: "channel.accept", channelId },
    });

    releaseIdentityRead?.();
    await starting;
    expect(connector.status()).toMatchObject({ state: "online", activeChannels: 1 });
    await connector.stop();
  });

  it("fails closed on a directionally inappropriate post-authentication frame", async () => {
    const socket = new FakeSocket();
    const connector = new HubConnector({
      config: enabledConfig,
      identity: identity(),
      transport: { open: () => socket },
      channels: { open: async () => Promise.reject(new Error("unused")) },
      enrollmentMetadata,
      livenessWatch: false,
    });
    const starting = connector.start();
    await settle();
    socket.emit("open", {} as Event);
    socket.emit("message", {
      data: encoded({
        type: "ready",
        protocolMajor: 1,
        protocolMinor: 2,
        limits: RELAY_INITIAL_LIMITS,
      }),
    } as MessageEvent);
    await starting;

    socket.emit("message", {
      data: encoded({
        type: "pong",
        protocolMajor: 1,
        protocolMinor: 2,
        nonce: new Uint8Array(8).fill(3),
      }),
    } as MessageEvent);
    await settle();

    expect(socket.closeCalls).toBe(1);
    expect(connector.status()).toMatchObject({ state: "degraded", failure: "protocol_invalid" });
    await connector.stop();
  });

  describe("liveness watch", () => {
    // Timers run on process uptime, which stops while the machine sleeps, so a
    // wake shows up only as the wall clock jumping ahead of the timers.
    function sleepingScheduler() {
      const clock = scheduler();
      let slept = 0;
      return {
        ...clock,
        value: { ...clock.value, now: () => clock.value.now() + slept },
        sleep: (milliseconds: number) => {
          slept += milliseconds;
        },
      };
    }

    async function onlineConnector(options: { readonly network?: () => string } = {}) {
      const clock = sleepingScheduler();
      const sockets: FakeSocket[] = [];
      const connector = new HubConnector({
        config: enabledConfig,
        identity: identity(),
        transport: {
          open: () => {
            const socket = new FakeSocket();
            sockets.push(socket);
            return socket;
          },
        },
        channels: { open: async () => Promise.reject(new Error("unused")) },
        enrollmentMetadata,
        scheduler: clock.value,
        networkFingerprint: options.network ?? (() => "192.168.1.2"),
      });
      const starting = connector.start();
      await settle();
      sockets[0]!.emit("open", {} as Event);
      sockets[0]!.emit("message", {
        data: encoded({
          type: "ready",
          protocolMajor: 1,
          protocolMinor: 2,
          limits: RELAY_INITIAL_LIMITS,
        }),
      } as MessageEvent);
      await starting;
      return { clock, sockets, connector };
    }

    const sentFrames = (socket: FakeSocket) =>
      socket.sent.map((bytes) => decodeRelayFrame(bytes)).flatMap((r) => (r.ok ? [r.value] : []));

    it("proves the socket with a ping after the machine wakes", async () => {
      const { clock, sockets, connector } = await onlineConnector();
      clock.sleep(10 * 60_000);
      await clock.advance(5_000);
      await settle();

      const ping = sentFrames(sockets[0]!).find((frame) => frame.type === "ping");
      expect(ping).toBeDefined();
      if (ping?.type !== "ping") throw new Error("expected a ping");
      sockets[0]!.emit("message", {
        data: encoded({ type: "pong", protocolMajor: 1, protocolMinor: 2, nonce: ping.nonce }),
      } as MessageEvent);
      await settle();
      await clock.advance(5_000);
      await settle();

      expect(connector.status().state).toBe("online");
      await connector.stop();
      expect(clock.timers.size).toBe(0);
    });

    it("reconnects at once when the probe goes unanswered", async () => {
      const { clock, sockets, connector } = await onlineConnector();
      clock.sleep(10 * 60_000);
      await clock.advance(5_000);
      await settle();
      await clock.advance(5_000);
      await settle();

      expect(connector.status()).toMatchObject({
        state: "degraded",
        failure: "heartbeat_timeout",
      });
      await clock.advance(1_000);
      await settle();
      expect(sockets).toHaveLength(2);
      await connector.stop();
    });

    it("retries immediately when the network changes while backing off", async () => {
      let network = "192.168.1.2";
      const { clock, sockets, connector } = await onlineConnector({ network: () => network });
      // Grow the backoff: every attempt fails before authenticating.
      sockets[0]!.emit("close", {} as CloseEvent);
      await settle();
      for (let attempt = 0; attempt < 5; attempt += 1) {
        await clock.advance(60_000);
        await settle();
        sockets.at(-1)!.emit("close", {} as CloseEvent);
        await settle();
      }
      const attemptsBefore = sockets.length;
      expect(connector.status()).toMatchObject({ state: "degraded", degradedMode: "backing_off" });

      network = "10.0.0.7";
      await clock.advance(5_000);
      await settle();

      expect(sockets.length).toBe(attemptsBefore + 1);
      await connector.stop();
    });
  });

  it("times out a missing heartbeat and resets backoff only after stability", async () => {
    const clock = scheduler();
    const sockets: FakeSocket[] = [];
    const connector = new HubConnector({
      config: { ...enabledConfig, reconnectStableMs: 5_000 },
      identity: identity(),
      transport: {
        open: () => {
          const socket = new FakeSocket();
          sockets.push(socket);
          return socket;
        },
      },
      channels: { open: async () => Promise.reject(new Error("unused")) },
      enrollmentMetadata,
      livenessWatch: false,
      scheduler: clock.value,
    });
    const starting = connector.start();
    await settle();
    sockets[0]!.emit("open", {} as Event);
    sockets[0]!.emit("message", {
      data: encoded({
        type: "ready",
        protocolMajor: 1,
        protocolMinor: 2,
        limits: RELAY_INITIAL_LIMITS,
      }),
    } as MessageEvent);
    await starting;

    sockets[0]!.emit("close", {} as CloseEvent);
    await settle();
    expect(connector.status().reconnectAttempt).toBe(0);
    await clock.advance(1_000);
    await settle();
    sockets[1]!.emit("open", {} as Event);
    sockets[1]!.emit("message", {
      data: encoded({
        type: "ready",
        protocolMajor: 1,
        protocolMinor: 2,
        limits: RELAY_INITIAL_LIMITS,
      }),
    } as MessageEvent);
    await settle();
    await clock.advance(5_000);
    sockets[1]!.emit("close", {} as CloseEvent);
    await settle();
    expect(connector.status()).toMatchObject({
      state: "degraded",
      failure: "network_unavailable",
      reconnectAttempt: 0,
    });

    await clock.advance(1_000);
    await settle();
    sockets[2]!.emit("open", {} as Event);
    sockets[2]!.emit("message", {
      data: encoded({
        type: "ready",
        protocolMajor: 1,
        protocolMinor: 2,
        limits: RELAY_INITIAL_LIMITS,
      }),
    } as MessageEvent);
    await settle();
    await clock.advance(RELAY_INITIAL_LIMITS.deadConnectionTimeoutMs);
    await settle();
    expect(connector.status()).toMatchObject({
      state: "degraded",
      failure: "heartbeat_timeout",
    });
    await connector.stop();
    expect(clock.timers.size).toBe(0);
  });

  it("confirms an activated staged key only after the replacement key authenticates", async () => {
    const socket = new FakeSocket();
    const confirmed: string[] = [];
    const activeState = {
      version: 1 as const,
      revision: 2,
      environmentId: `env_${"E".repeat(22)}`,
      protectedStoreBackend: "os" as const,
      pendingEnrollment: null,
      activeNode: {
        hubOrigin: "https://relay.example",
        nodeId: `node_${"N".repeat(22)}`,
        activeKeyId: `nkey_${"K".repeat(22)}`,
        activeKeySecretName: "node-key.old",
        cleanupPollingSecretName: null,
        enrolledAt: 1,
      },
      stagedRotation: {
        hubOrigin: "https://relay.example",
        rotationRequestId: `rot_${"R".repeat(22)}`,
        newKeyId: `nkey_${"Q".repeat(22)}`,
        newKeySecretName: "node-key.new",
        continuityMode: "continue" as const,
        stagedAt: 2,
        activatedAt: 3,
      },
      pendingTeardown: null,
    };
    const connector = new HubConnector({
      config: enabledConfig,
      identity: identity({
        readState: async () => activeState,
        confirmAuthenticatedKey: async (_origin, keyId) => {
          confirmed.push(keyId);
          return { continuityBreak: null };
        },
      }),
      transport: { open: () => socket },
      channels: { open: async () => Promise.reject(new Error("unused")) },
      enrollmentMetadata,
      livenessWatch: false,
    });
    const starting = connector.start();
    await settle();
    socket.emit("open", {} as Event);
    socket.emit("message", {
      data: encoded({
        type: "ready",
        protocolMajor: 1,
        protocolMinor: 2,
        limits: RELAY_INITIAL_LIMITS,
      }),
    } as MessageEvent);
    await starting;
    expect(confirmed).toEqual([activeState.stagedRotation.newKeyId]);
    await connector.stop();
  });

  it("requires operator action for fresh-proof authentication failure", async () => {
    const socket = new FakeSocket();
    const connector = new HubConnector({
      config: enabledConfig,
      identity: identity(),
      transport: { open: () => socket },
      channels: {
        open: async () => {
          throw new Error("unused");
        },
      },
      enrollmentMetadata,
      livenessWatch: false,
    });
    const starting = connector.start();
    await settle();
    socket.emit("open", {} as Event);
    socket.emit("message", {
      data: encoded({
        type: "error",
        protocolMajor: 1,
        protocolMinor: 2,
        code: "authentication_failed",
        fatal: true,
      }),
    } as MessageEvent);
    await starting;
    expect(connector.status()).toMatchObject({
      state: "degraded",
      degradedMode: "operator_action_required",
      failure: "authentication_failed",
    });
    await connector.stop();
  });

  it("revalidates identity origin before an operator-triggered resume", async () => {
    const clock = scheduler();
    const socket = new FakeSocket();
    let changedOrigin = false;
    const activeIdentity = identity();
    const connector = new HubConnector({
      config: enabledConfig,
      identity: {
        ...activeIdentity,
        readState: async () => {
          const state = await activeIdentity.readState();
          return changedOrigin && state.activeNode !== null
            ? {
                ...state,
                activeNode: { ...state.activeNode, hubOrigin: "https://other.example" },
              }
            : state;
        },
      },
      transport: { open: () => socket },
      channels: { open: async () => Promise.reject(new Error("unused")) },
      enrollmentMetadata,
      livenessWatch: false,
      scheduler: clock.value,
    });
    const starting = connector.start();
    await settle();
    socket.emit("open", {} as Event);
    socket.emit("message", {
      data: encoded({
        type: "ready",
        protocolMajor: 1,
        protocolMinor: 2,
        limits: RELAY_INITIAL_LIMITS,
      }),
    } as MessageEvent);
    await starting;
    socket.emit("close", {} as CloseEvent);
    await settle();

    changedOrigin = true;
    await connector.resume();
    expect(connector.status()).toMatchObject({
      state: "degraded",
      degradedMode: "operator_action_required",
      failure: "identity_origin_mismatch",
    });
    expect(clock.timers.size).toBe(0);
    await connector.stop();
  });

  it("starts enrollment, polls approval, and authenticates without exposing polling material", async () => {
    const clock = scheduler();
    const socket = new FakeSocket();
    let pending = false;
    let polls = 0;
    let proposedLabel = "";
    const connector = new HubConnector({
      config: enabledConfig,
      identity: identity({
        readState: async () => ({
          version: 1,
          revision: 1,
          environmentId: `env_${"E".repeat(22)}`,
          protectedStoreBackend: "os" as const,
          pendingEnrollment: pending
            ? {
                hubOrigin: "https://relay.example",
                keySecretName: "node-key.fixture",
                pollingSecretName: "enrollment-poll.fixture",
                label: proposedLabel,
                deviceCode: "ABCD-EFGH",
                createdAt: 1,
                expiresAt: 2_000_000,
                pollIntervalMs: 1_000,
                cleanupRequested: false,
              }
            : null,
          activeNode: null,
          stagedRotation: null,
          pendingTeardown: null,
        }),
        startEnrollment: async (_origin, metadata) => {
          proposedLabel = metadata.label;
          pending = true;
          return {
            deviceCode: "ABCD-EFGH",
            expiresAt: 2_000_000,
            pollIntervalMs: 1_000,
            environmentId: `env_${"E".repeat(22)}`,
            publicKey: {
              algorithm: "ed25519",
              publicKey: new Uint8Array(32),
              fingerprint: new Uint8Array(32),
            },
          };
        },
        pollEnrollment: async () => {
          polls += 1;
          if (polls === 1) return { status: "pending", retryAfterMs: 1_000 };
          return {
            status: "approved",
            nodeId: `node_${"N".repeat(22)}`,
            environmentId: `env_${"E".repeat(22)}`,
            activeKeyId: `nkey_${"K".repeat(22)}`,
            enrolledAt: 1,
          };
        },
      }),
      transport: { open: () => socket },
      channels: {
        open: async () => {
          throw new Error("unused");
        },
      },
      enrollmentMetadata,
      livenessWatch: false,
      scheduler: clock.value,
    });
    await connector.start();
    const started = await connector.enroll();
    expect(started).toMatchObject({
      deviceCode: "ABCD-EFGH",
      fingerprint: `SHA256:${"A".repeat(43)}`,
      label: proposedLabel,
      pollIntervalMs: 1_000,
      status: { state: "awaiting_approval" },
    });
    expect(proposedLabel).toMatch(/^Test node · [0-9A-HJKMNP-TV-Z]{4}$/);
    // Canary: the enroll response carries exactly the fields an approver
    // compares, and nothing else. Widening this set is a deliberate act — it
    // must stay in step with the approval screen, and it must never grow to
    // include the polling secret, the public key, or the Hub origin.
    expect(Object.keys(started).toSorted()).toEqual([
      "algorithm",
      "clientVersion",
      "deviceCode",
      "expiresAt",
      "fingerprint",
      "label",
      "platformArch",
      "platformOs",
      "pollIntervalMs",
      "status",
    ]);

    await clock.advance(1_000);
    expect(connector.status().state).toBe("awaiting_approval");
    await clock.advance(1_000);
    await settle();
    socket.emit("open", {} as Event);
    socket.emit("message", {
      data: encoded({
        type: "ready",
        protocolMajor: 1,
        protocolMinor: 2,
        limits: RELAY_INITIAL_LIMITS,
      }),
    } as MessageEvent);
    await settle();
    expect(connector.status().state).toBe("online");
    await connector.stop();
  });

  it("fails enrollment closed when the generated fingerprint is malformed", async () => {
    const clock = scheduler();
    let cancellations = 0;
    let polls = 0;
    const connector = new HubConnector({
      config: enabledConfig,
      identity: identity({
        readState: async () => ({
          version: 1,
          revision: 1,
          environmentId: `env_${"E".repeat(22)}`,
          protectedStoreBackend: "os" as const,
          pendingEnrollment: null,
          activeNode: null,
          stagedRotation: null,
          pendingTeardown: null,
        }),
        startEnrollment: async () => ({
          deviceCode: "ABCD-EFGH",
          expiresAt: 2_000_000,
          pollIntervalMs: 1_000,
          environmentId: `env_${"E".repeat(22)}`,
          publicKey: {
            algorithm: "ed25519",
            publicKey: new Uint8Array(32),
            fingerprint: new Uint8Array(31),
          },
        }),
        pollEnrollment: async () => {
          polls += 1;
          return { status: "pending", retryAfterMs: 1_000 };
        },
        cancelEnrollment: async () => {
          cancellations += 1;
        },
      }),
      transport: { open: () => new FakeSocket() },
      channels: { open: async () => Promise.reject(new Error("unused")) },
      enrollmentMetadata,
      livenessWatch: false,
      scheduler: clock.value,
    });
    await connector.start();
    await expect(connector.enroll()).rejects.toThrow("Hub enrollment could not be started.");
    expect(connector.status()).toMatchObject({
      state: "degraded",
      degradedMode: "operator_action_required",
      failure: "enrollment_unavailable",
    });
    expect(clock.timers.size).toBe(0);
    await clock.advance(1_000);
    expect(cancellations).toBe(1);
    expect(polls).toBe(0);
    await connector.stop();
  });

  it("uses the configured node name as the exact enrollment proposal", async () => {
    let proposedLabel = "";
    const connector = new HubConnector({
      config: { ...enabledConfig, nodeName: "Configured node" },
      identity: identity({
        readState: async () => ({
          version: 1,
          revision: 1,
          environmentId: `env_${"E".repeat(22)}`,
          protectedStoreBackend: "os" as const,
          pendingEnrollment: null,
          activeNode: null,
          stagedRotation: null,
          pendingTeardown: null,
        }),
        startEnrollment: async (_origin, metadata) => {
          proposedLabel = metadata.label;
          return {
            deviceCode: "ABCD-EFGH",
            expiresAt: 2_000_000,
            pollIntervalMs: 1_000,
            environmentId: `env_${"E".repeat(22)}`,
            publicKey: {
              algorithm: "ed25519",
              publicKey: new Uint8Array(32),
              fingerprint: new Uint8Array(32),
            },
          };
        },
      }),
      transport: { open: () => new FakeSocket() },
      channels: { open: async () => Promise.reject(new Error("unused")) },
      enrollmentMetadata,
      livenessWatch: false,
    });

    await connector.start();
    expect((await connector.enroll()).label).toBe("Configured node");
    expect(proposedLabel).toBe("Configured node");
    await connector.stop();
  });

  it("resumes pending enrollment after restart and cancels without leaving a poll timer", async () => {
    const clock = scheduler();
    let cancelled = 0;
    let polls = 0;
    const pendingState = {
      version: 1 as const,
      revision: 1,
      environmentId: `env_${"E".repeat(22)}`,
      protectedStoreBackend: "os" as const,
      pendingEnrollment: {
        hubOrigin: "https://relay.example",
        keySecretName: "node-key.fixture",
        pollingSecretName: "enrollment-poll.fixture",
        label: "Persisted proposal",
        deviceCode: "ABCD-EFGH",
        createdAt: 1,
        expiresAt: 2_000_000,
        pollIntervalMs: 1_000,
        cleanupRequested: false,
      },
      activeNode: null,
      stagedRotation: null,
      pendingTeardown: null,
    };
    const connector = new HubConnector({
      config: enabledConfig,
      identity: identity({
        readState: async () => pendingState,
        readPendingEnrollment: async () => ({
          deviceCode: "ABCD-EFGH",
          label: "Persisted proposal",
          fingerprint: new Uint8Array(32),
          algorithm: "ed25519",
          expiresAt: 2_000_000,
          pollIntervalMs: 1_000,
        }),
        pollEnrollment: async () => {
          polls += 1;
          return { status: "pending", retryAfterMs: 1_000 };
        },
        cancelEnrollment: async () => {
          cancelled += 1;
        },
      }),
      transport: { open: () => new FakeSocket() },
      channels: {
        open: async () => {
          throw new Error("unused");
        },
      },
      enrollmentMetadata,
      livenessWatch: false,
      scheduler: clock.value,
    });
    await connector.start();
    expect(connector.status().state).toBe("awaiting_approval");
    expect(await connector.readEnrollment()).toMatchObject({
      deviceCode: "ABCD-EFGH",
      label: "Persisted proposal",
    });
    await clock.advance(0);
    expect(polls).toBe(1);
    await connector.cancelEnrollment();
    expect(cancelled).toBe(1);
    expect(connector.status().state).toBe("enrolling");
    expect(clock.timers.size).toBe(0);
    await connector.stop();
  });

  it("uses the pre-feature machine label for a legacy pending ceremony", async () => {
    const connector = new HubConnector({
      config: { ...enabledConfig, nodeName: "New configured name" },
      identity: identity({
        readState: async () => ({
          version: 1,
          revision: 1,
          environmentId: `env_${"E".repeat(22)}`,
          protectedStoreBackend: "os" as const,
          pendingEnrollment: {
            hubOrigin: "https://relay.example",
            keySecretName: "node-key.fixture",
            pollingSecretName: "enrollment-poll.fixture",
            label: null,
            deviceCode: "ABCD-EFGH",
            createdAt: 1,
            expiresAt: 2_000_000,
            pollIntervalMs: 1_000,
            cleanupRequested: false,
          },
          activeNode: null,
          stagedRotation: null,
          pendingTeardown: null,
        }),
        readPendingEnrollment: async () => ({
          deviceCode: "ABCD-EFGH",
          label: null,
          fingerprint: new Uint8Array(32),
          algorithm: "ed25519",
          expiresAt: 2_000_000,
          pollIntervalMs: 1_000,
        }),
      }),
      transport: { open: () => new FakeSocket() },
      channels: { open: async () => Promise.reject(new Error("unused")) },
      enrollmentMetadata,
      livenessWatch: false,
    });

    await connector.start();
    expect(await connector.readEnrollment()).toMatchObject({ label: "Test node" });
    await connector.stop();
  });

  it("fails closed when local enrollment cancellation cannot erase custody", async () => {
    const clock = scheduler();
    const connector = new HubConnector({
      config: enabledConfig,
      identity: identity({
        readState: async () => ({
          version: 1,
          revision: 1,
          environmentId: `env_${"E".repeat(22)}`,
          protectedStoreBackend: "os" as const,
          pendingEnrollment: {
            hubOrigin: "https://relay.example",
            keySecretName: "node-key.fixture",
            pollingSecretName: "enrollment-poll.fixture",
            label: "Persisted proposal",
            deviceCode: "ABCD-EFGH",
            createdAt: 1,
            expiresAt: 2_000_000,
            pollIntervalMs: 1_000,
            cleanupRequested: false,
          },
          activeNode: null,
          stagedRotation: null,
          pendingTeardown: null,
        }),
        cancelEnrollment: async () => Promise.reject(new Error("custody unavailable")),
      }),
      transport: { open: () => new FakeSocket() },
      channels: { open: async () => Promise.reject(new Error("unused")) },
      enrollmentMetadata,
      livenessWatch: false,
      scheduler: clock.value,
    });
    await connector.start();
    await expect(connector.cancelEnrollment()).rejects.toThrow(
      "Hub enrollment could not be cancelled.",
    );
    expect(connector.status()).toMatchObject({
      state: "degraded",
      degradedMode: "operator_action_required",
      failure: "enrollment_unavailable",
    });
    expect(clock.timers.size).toBe(0);
    await connector.stop();
  });

  it("stops polling and requires operator action after enrollment denial or expiry", async () => {
    const clock = scheduler();
    const connector = new HubConnector({
      config: enabledConfig,
      identity: identity({
        readState: async () => ({
          version: 1,
          revision: 1,
          environmentId: `env_${"E".repeat(22)}`,
          protectedStoreBackend: "os" as const,
          pendingEnrollment: {
            hubOrigin: "https://relay.example",
            keySecretName: "node-key.fixture",
            pollingSecretName: "enrollment-poll.fixture",
            label: "Persisted proposal",
            deviceCode: "ABCD-EFGH",
            createdAt: 1,
            expiresAt: 2_000_000,
            pollIntervalMs: 1_000,
            cleanupRequested: false,
          },
          activeNode: null,
          stagedRotation: null,
          pendingTeardown: null,
        }),
        pollEnrollment: async () => ({ status: "unavailable", reason: "rejected" }),
      }),
      transport: { open: () => new FakeSocket() },
      channels: {
        open: async () => {
          throw new Error("unused");
        },
      },
      enrollmentMetadata,
      livenessWatch: false,
      scheduler: clock.value,
    });
    await connector.start();
    await clock.advance(0);
    expect(connector.status()).toMatchObject({
      state: "degraded",
      degradedMode: "operator_action_required",
      failure: "enrollment_unavailable",
    });
    expect(clock.timers.size).toBe(0);
    await connector.stop();
  });

  it("ignores an enrollment start that completes after shutdown", async () => {
    let finishEnrollment:
      | ((result: Awaited<ReturnType<HubIdentityRuntimeShape["startEnrollment"]>>) => void)
      | undefined;
    const pendingStart = new Promise<
      Awaited<ReturnType<HubIdentityRuntimeShape["startEnrollment"]>>
    >((resolve) => {
      finishEnrollment = resolve;
    });
    const connector = new HubConnector({
      config: enabledConfig,
      identity: identity({
        readState: async () => ({
          version: 1,
          revision: 1,
          environmentId: `env_${"E".repeat(22)}`,
          protectedStoreBackend: "os" as const,
          pendingEnrollment: null,
          activeNode: null,
          stagedRotation: null,
          pendingTeardown: null,
        }),
        startEnrollment: async () => pendingStart,
      }),
      transport: { open: () => new FakeSocket() },
      channels: {
        open: async () => {
          throw new Error("unused");
        },
      },
      enrollmentMetadata,
      livenessWatch: false,
    });
    await connector.start();
    const enrolling = connector.enroll();
    await settle();
    await connector.stop();
    finishEnrollment?.({
      deviceCode: "ABCD-EFGH",
      expiresAt: 2_000_000,
      pollIntervalMs: 1_000,
      environmentId: `env_${"E".repeat(22)}`,
      publicKey: {
        algorithm: "ed25519",
        publicKey: new Uint8Array(32),
        fingerprint: new Uint8Array(32),
      },
    });
    await expect(enrolling).rejects.toThrow("superseded");
    expect(connector.status().state).toBe("disabled");
  });
  it("closes the relay socket before erasing custody, and stays enrollable after", async () => {
    const clock = scheduler();
    const socket = new FakeSocket();
    const order: string[] = [];
    const connector = new HubConnector({
      config: enabledConfig,
      identity: identity({
        leave: async () => {
          order.push("custody-erased");
        },
      }),
      transport: { open: () => socket },
      channels: {
        open: async () => {
          throw new Error("unused");
        },
      },
      enrollmentMetadata,
      livenessWatch: false,
      scheduler: clock.value,
    });
    const socketClose = socket.close.bind(socket);
    socket.close = () => {
      order.push("socket-closed");
      socketClose();
    };

    const starting = connector.start();
    await settle();
    socket.emit("open", {} as Event);
    socket.emit("message", {
      data: encoded({
        type: "ready",
        protocolMajor: 1,
        protocolMinor: 2,
        limits: RELAY_INITIAL_LIMITS,
      }),
    } as MessageEvent);
    await starting;
    expect(connector.status().state).toBe("online");

    const status = await connector.leave();

    // An authenticated relay session is never revalidated against identity
    // state, so deleting the key does not close it. The socket must be gone
    // before custody is mutated, or the connector would keep serving relayed RPC
    // under an identity that no longer exists.
    expect(socket.closeCalls).toBe(1);
    expect(order).toEqual(["socket-closed", "custody-erased"]);
    expect([...socket.listeners.values()].every((set) => set.size === 0)).toBe(true);
    expect(clock.timers.size).toBe(0);

    // Leave must not latch `#stopping` the way `stop()` does, or the node could
    // never enroll again without a relaunch.
    expect(status.state).toBe("enrolling");
  });

  it("reports a bounded failure and does not claim success when custody erase fails", async () => {
    const connector = new HubConnector({
      config: enabledConfig,
      identity: identity({
        leave: async () => {
          throw new Error("keychain locked: /Users/someone/Library/Keychains");
        },
      }),
      transport: { open: () => new FakeSocket() },
      channels: {
        open: async () => {
          throw new Error("unused");
        },
      },
      enrollmentMetadata,
      livenessWatch: false,
      scheduler: scheduler().value,
    });

    await expect(connector.leave()).rejects.toThrow("Hub identity could not be erased.");
    expect(connector.status()).toMatchObject({
      state: "degraded",
      degradedMode: "operator_action_required",
      failure: "identity_unavailable",
    });
    // The bounded message must not carry the underlying filesystem detail.
    await expect(connector.leave()).rejects.not.toThrow("Keychains");
  });

  it("leaves a disabled connector disabled rather than claiming it is enrolling", async () => {
    const connector = new HubConnector({
      config: DEFAULT_HUB_CONNECTOR_CONFIG,
      identity: identity(),
      transport: {
        open: () => {
          throw new Error("unused");
        },
      },
      channels: {
        open: async () => {
          throw new Error("unused");
        },
      },
      enrollmentMetadata,
      livenessWatch: false,
    });
    await connector.start();
    const status = await connector.leave();
    expect(status.state).toBe("disabled");
  });

  it("does not report a half-erased identity as enrolled", async () => {
    const connector = new HubConnector({
      config: enabledConfig,
      identity: identity({
        readState: async () => ({
          version: 1,
          revision: 9,
          environmentId: `env_${"E".repeat(22)}`,
          protectedStoreBackend: "os" as const,
          pendingEnrollment: null,
          // A leave that committed its marker and deleted the secrets, then
          // crashed before clearing state. The keys are gone.
          activeNode: {
            hubOrigin: "https://relay.example",
            nodeId: `node_${"N".repeat(22)}`,
            activeKeyId: `nkey_${"K".repeat(22)}`,
            activeKeySecretName: "node-key.gone",
            cleanupPollingSecretName: null,
            enrolledAt: 1,
          },
          stagedRotation: null,
          pendingTeardown: { secretNames: ["node-key.gone"], requestedAt: 1 },
        }),
      }),
      transport: { open: () => new FakeSocket() },
      channels: {
        open: async () => {
          throw new Error("unused");
        },
      },
      enrollmentMetadata,
      livenessWatch: false,
    });

    expect(await connector.identitySummary()).toEqual({ enrolled: "none" });
  });

  it("reports only the canonical active fingerprint for local recovery", async () => {
    const fingerprint = `SHA256:${"A".repeat(43)}`;
    const connector = new HubConnector({
      config: enabledConfig,
      identity: identity({ readActiveFingerprint: async () => fingerprint }),
      transport: { open: () => new FakeSocket() },
      channels: {
        open: async () => {
          throw new Error("unused");
        },
      },
      enrollmentMetadata,
      livenessWatch: false,
    });

    expect(await connector.identitySummary()).toEqual({ enrolled: "active", fingerprint });
    expect(JSON.stringify(await connector.identitySummary())).not.toContain("publicKey");
    expect(JSON.stringify(await connector.identitySummary())).not.toContain("secretName");
  });
});
