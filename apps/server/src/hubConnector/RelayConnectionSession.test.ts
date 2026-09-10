import { describe, expect, it } from "vite-plus/test";

import {
  RELAY_INITIAL_LIMITS,
  type RelayErrorFrame,
  type RelayFrame,
  type RelayNodeAuthHandshake,
} from "@ryco/contracts/relay";
import { decodeRelayFrame, encodeRelayFrame } from "@ryco/shared/relayCodec";

import { HubRelayAuthenticationError, type HubIdentityRuntimeShape } from "./HubIdentityRuntime.ts";
import {
  stubCrossDeviceApprovalService,
  stubIdentityE2eeAdmin,
  stubNativeNodeClaimService,
} from "./testUtils/e2eeOperatorStub.ts";
import { NODE_E2EE_FAIL_CLOSED_POLICY } from "../hubIdentity/NodeE2eePolicyStore.ts";
import type { HubRelaySocket, HubRelaySocketEventMap } from "./HubRelayTransport.ts";
import {
  relayErrorKind,
  RelayConnectionError,
  RelayConnectionSession,
  type RelaySessionScheduler,
} from "./RelayConnectionSession.ts";

class FakeSocket implements HubRelaySocket {
  bufferedAmount = 0;
  readyState = 0;
  readonly sent: Uint8Array[] = [];
  readonly listeners = new Map<string, Set<(event: never) => void>>();
  closeCalls = 0;

  send(data: Uint8Array): void {
    this.sent.push(Uint8Array.from(data));
  }

  close(): void {
    this.closeCalls += 1;
  }

  addEventListener<K extends keyof HubRelaySocketEventMap>(
    type: K,
    listener: (event: HubRelaySocketEventMap[K]) => void,
  ): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener as (event: never) => void);
    this.listeners.set(type, listeners);
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

function identity(): HubIdentityRuntimeShape {
  let challenge = 0;
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
    readState: async () => {
      throw new Error("unused");
    },
    startEnrollment: async () => {
      throw new Error("unused");
    },
    pollEnrollment: async () => {
      throw new Error("unused");
    },
    cancelEnrollment: async () => undefined,
    createRelayAuthenticationFrame: async () => {
      challenge += 1;
      return {
        type: "auth",
        peer: "node",
        protocolMajor: 1,
        protocolMinor: 2,
        nodeId: `node_${"A".repeat(22)}`,
        nonce: new Uint8Array(32).fill(challenge),
        signature: new Uint8Array(64).fill(0x53),
      } as RelayNodeAuthHandshake;
    },
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
  };
}

function identityAtMinor(protocolMinor: 2 | 3): HubIdentityRuntimeShape {
  return {
    ...identity(),
    createRelayAuthenticationFrame: async () =>
      ({
        type: "auth",
        peer: "node",
        protocolMajor: 1,
        protocolMinor,
        nodeId: `node_${"A".repeat(22)}`,
        nonce: new Uint8Array(32).fill(1),
        signature: new Uint8Array(64).fill(2),
      }) as RelayNodeAuthHandshake,
  };
}

describe("RelayConnectionSession", () => {
  it("maps canonical replacement, draining, revocation, and version errors", () => {
    const frame = (code: RelayErrorFrame["code"]): RelayErrorFrame =>
      ({
        type: "error",
        protocolMajor: 1,
        protocolMinor: 2,
        code,
        fatal: true,
      }) as RelayErrorFrame;
    expect(relayErrorKind(frame("connection_replaced"))).toBe("connection_replaced");
    expect(relayErrorKind(frame("server_draining"))).toBe("server_draining");
    expect(relayErrorKind(frame("node_revoked"))).toBe("revoked");
    expect(relayErrorKind(frame("protocol_unsupported"))).toBe("version_incompatible");
  });

  it("buffers post-ready frames until the connector activates ordered delivery", async () => {
    const socket = new FakeSocket();
    const routed: RelayFrame[] = [];
    const terminal: RelayConnectionError[] = [];
    const session = new RelayConnectionSession({
      identity: identity(),
      transport: { open: () => socket },
      hubOrigin: "https://relay.example",
      onFrame: (frame) => routed.push(frame),
      onTerminal: (error) => terminal.push(error),
    });
    const authenticating = session.authenticate();
    await Promise.resolve();
    socket.emit("open", {} as Event);
    expect(socket.sent).toHaveLength(1);
    const auth = decodeRelayFrame(socket.sent[0]!);
    expect(auth.ok && auth.value.type).toBe("auth");
    socket.emit("message", {
      data: encoded({
        type: "ready",
        protocolMajor: 1,
        protocolMinor: 2,
        limits: RELAY_INITIAL_LIMITS,
      }),
    } as MessageEvent);
    const ping = {
      type: "ping",
      protocolMajor: 1,
      protocolMinor: 2,
      nonce: new Uint8Array(8).fill(7),
    } as const;
    socket.emit("message", { data: encoded(ping) } as MessageEvent);
    expect(routed).toHaveLength(0);

    await expect(authenticating).resolves.toMatchObject({ type: "ready" });
    session.activateFrameDelivery();
    expect(routed).toHaveLength(1);
    expect(routed[0]).toMatchObject({ type: "ping" });
    expect(routed[0]?.type === "ping" && routed[0].nonce).toEqual(new Uint8Array(8).fill(7));
    expect(terminal).toHaveLength(0);
  });

  it("fails closed when the bounded post-ready frame buffer overflows", async () => {
    const socket = new FakeSocket();
    const terminal: RelayConnectionError[] = [];
    const session = new RelayConnectionSession({
      identity: identity(),
      transport: { open: () => socket },
      hubOrigin: "https://relay.example",
      onFrame: () => undefined,
      onTerminal: (error) => terminal.push(error),
    });
    const authenticating = session.authenticate();
    await Promise.resolve();
    socket.emit("open", {} as Event);
    socket.emit("message", {
      data: encoded({
        type: "ready",
        protocolMajor: 1,
        protocolMinor: 2,
        limits: RELAY_INITIAL_LIMITS,
      }),
    } as MessageEvent);
    await authenticating;

    for (let index = 0; index < 17; index += 1) {
      socket.emit("message", {
        data: encoded({
          type: "ping",
          protocolMajor: 1,
          protocolMinor: 2,
          nonce: new Uint8Array(8).fill(index),
        }),
      } as MessageEvent);
    }

    expect(terminal).toHaveLength(1);
    expect(terminal[0]?.kind).toBe("protocol_invalid");
    expect(socket.closeCalls).toBe(1);
    expect(() => session.activateFrameDelivery()).toThrow("Hub relay connection failed.");
  });

  it("negotiates minor 2 when a minor-3 node meets an older Hub", async () => {
    const socket = new FakeSocket();
    const routed: RelayFrame[] = [];
    const session = new RelayConnectionSession({
      identity: identityAtMinor(3),
      transport: { open: () => socket },
      hubOrigin: "https://relay.example",
      onFrame: (frame) => routed.push(frame),
      onTerminal: () => undefined,
    });
    const authenticating = session.authenticate();
    await Promise.resolve();
    socket.emit("open", {} as Event);
    socket.emit("message", {
      data: encoded({
        type: "ready",
        protocolMajor: 1,
        protocolMinor: 2,
        limits: RELAY_INITIAL_LIMITS,
      }),
    } as MessageEvent);
    await expect(authenticating).resolves.toMatchObject({ protocolMinor: 2 });
    session.activateFrameDelivery();

    socket.emit("message", {
      data: encoded({
        type: "ping",
        protocolMajor: 1,
        protocolMinor: 2,
        nonce: new Uint8Array(8),
      }),
    } as MessageEvent);
    expect(routed).toHaveLength(1);
  });

  it("refuses a ready minor newer than the node's signed offer", async () => {
    const socket = new FakeSocket();
    const session = new RelayConnectionSession({
      identity: identityAtMinor(2),
      transport: { open: () => socket },
      hubOrigin: "https://relay.example",
      onFrame: () => undefined,
      onTerminal: () => undefined,
    });
    const authenticating = session.authenticate();
    await Promise.resolve();
    socket.emit("open", {} as Event);
    socket.emit("message", {
      data: encoded({
        type: "ready",
        protocolMajor: 1,
        protocolMinor: 3,
        limits: RELAY_INITIAL_LIMITS,
      }),
    } as MessageEvent);
    await expect(authenticating).rejects.toMatchObject({ kind: "version_incompatible" });
  });

  it("preserves opaque data bytes after wiping the transport buffer", async () => {
    const socket = new FakeSocket();
    const routed: RelayFrame[] = [];
    const session = new RelayConnectionSession({
      identity: identity(),
      transport: { open: () => socket },
      hubOrigin: "https://relay.example",
      onFrame: (frame) => routed.push(frame),
      onTerminal: () => undefined,
    });
    const authenticating = session.authenticate();
    await Promise.resolve();
    socket.emit("open", {} as Event);
    socket.emit("message", {
      data: encoded({
        type: "ready",
        protocolMajor: 1,
        protocolMinor: 2,
        limits: RELAY_INITIAL_LIMITS,
      }),
    } as MessageEvent);
    await authenticating;
    session.activateFrameDelivery();

    socket.emit("message", {
      data: encoded({
        type: "data",
        protocolMajor: 1,
        protocolMinor: 2,
        channelId: `ch_${"D".repeat(22)}` as never,
        sequence: 0 as never,
        payload: Uint8Array.of(0, 255, 128, 7),
      }),
    } as MessageEvent);

    expect(routed).toHaveLength(1);
    expect(routed[0]?.type === "data" && routed[0].payload).toEqual(Uint8Array.of(0, 255, 128, 7));
  });

  it("enforces the five-second authentication timeout and removes every listener", async () => {
    const socket = new FakeSocket();
    const callbacks = new Map<number, () => void>();
    let nextHandle = 0;
    const scheduler: RelaySessionScheduler = {
      setTimeout: (callback, milliseconds) => {
        expect(milliseconds).toBe(5_000);
        const handle = ++nextHandle;
        callbacks.set(handle, callback);
        return handle;
      },
      clearTimeout: (handle) => {
        callbacks.delete(handle as number);
      },
    };
    const session = new RelayConnectionSession({
      identity: identity(),
      transport: { open: () => socket },
      hubOrigin: "https://relay.example",
      scheduler,
      onFrame: () => undefined,
      onTerminal: () => undefined,
    });
    const authenticating = session.authenticate();
    await Promise.resolve();
    socket.emit("open", {} as Event);
    [...callbacks.values()][0]?.();
    await expect(authenticating).rejects.toMatchObject({ kind: "authentication_timeout" });
    expect(socket.closeCalls).toBe(1);
    expect([...socket.listeners.values()].every((listeners) => listeners.size === 0)).toBe(true);
  });

  it("times out a socket that never opens so the connector can retry", async () => {
    const socket = new FakeSocket();
    const callbacks = new Set<() => void>();
    const session = new RelayConnectionSession({
      identity: identity(),
      transport: { open: () => socket },
      hubOrigin: "https://relay.example",
      scheduler: {
        setTimeout: (callback, milliseconds) => {
          expect(milliseconds).toBe(5_000);
          callbacks.add(callback);
          return callback;
        },
        clearTimeout: (handle) => callbacks.delete(handle as () => void),
      },
      onFrame: () => undefined,
      onTerminal: () => undefined,
    });
    const authenticating = session.authenticate();
    await Promise.resolve();
    expect(callbacks.size).toBe(1);
    [...callbacks][0]?.();
    await expect(authenticating).rejects.toMatchObject({ kind: "network" });
    expect(socket.closeCalls).toBe(1);
    expect(socket.sent).toHaveLength(0);
    expect(callbacks.size).toBe(0);
    expect([...socket.listeners.values()].every((listeners) => listeners.size === 0)).toBe(true);
  });

  it.each(["opening", "authenticating"] as const)(
    "settles cancelled authentication while the socket is %s",
    async (phase) => {
      const socket = new FakeSocket();
      const session = new RelayConnectionSession({
        identity: identity(),
        transport: { open: () => socket },
        hubOrigin: "https://relay.example",
        onFrame: () => undefined,
        onTerminal: () => {
          throw new Error("Cancellation must not report a second terminal failure.");
        },
      });
      let outcome = "pending";
      const authenticating = session.authenticate().then(
        () => {
          outcome = "ready";
        },
        (error: unknown) => {
          outcome = error instanceof RelayConnectionError ? error.kind : "unknown";
        },
      );
      await Promise.resolve();
      if (phase === "authenticating") socket.emit("open", {} as Event);
      session.close();
      await Promise.resolve();
      await Promise.resolve();
      expect(outcome).toBe("network");
      await authenticating;
      expect(socket.closeCalls).toBe(1);
      expect([...socket.listeners.values()].every((listeners) => listeners.size === 0)).toBe(true);
    },
  );

  it("maps bounded fatal errors without retaining remote material", async () => {
    const socket = new FakeSocket();
    const session = new RelayConnectionSession({
      identity: identity(),
      transport: { open: () => socket },
      hubOrigin: "https://relay.example",
      onFrame: () => undefined,
      onTerminal: () => undefined,
    });
    const authenticating = session.authenticate();
    await Promise.resolve();
    socket.emit("open", {} as Event);
    socket.emit("message", {
      data: encoded({
        type: "error",
        protocolMajor: 1,
        protocolMinor: 2,
        code: "rate_limited",
        fatal: true,
        retryAfterMs: 30_000,
      }),
    } as MessageEvent);
    let error: unknown;
    try {
      await authenticating;
    } catch (cause) {
      error = cause;
    }
    expect(error).toMatchObject({ kind: "rate_limited", retryAfterMs: 30_000 });
    expect(String(error)).toBe("RelayConnectionError: Hub relay connection failed.");
  });

  it("does not open a socket when shutdown wins the proof-preflight race", async () => {
    let releaseProof: ((frame: RelayNodeAuthHandshake) => void) | undefined;
    const proof = new Promise<RelayNodeAuthHandshake>((resolve) => {
      releaseProof = resolve;
    });
    const frame = {
      type: "auth",
      peer: "node",
      protocolMajor: 1,
      protocolMinor: 2,
      nodeId: `node_${"A".repeat(22)}`,
      nonce: new Uint8Array(32).fill(7),
      signature: new Uint8Array(64).fill(8),
    } as RelayNodeAuthHandshake;
    let opens = 0;
    const session = new RelayConnectionSession({
      identity: { ...identity(), createRelayAuthenticationFrame: async () => proof },
      transport: {
        open: () => {
          opens += 1;
          return new FakeSocket();
        },
      },
      hubOrigin: "https://relay.example",
      onFrame: () => undefined,
      onTerminal: () => undefined,
    });
    const authenticating = session.authenticate();
    let cancelled = false;
    void authenticating.catch(() => {
      cancelled = true;
    });
    session.close();
    await Promise.resolve();
    await Promise.resolve();
    expect(cancelled).toBe(true);
    releaseProof?.(frame);
    await expect(authenticating).rejects.toMatchObject({ kind: "network" });
    expect(opens).toBe(0);
    expect(frame.nonce.every((byte) => byte === 0)).toBe(true);
    expect(frame.signature.every((byte) => byte === 0)).toBe(true);
  });

  it("bounds proof failures without reflecting sensitive causes", async () => {
    const canary = "PRIVATE-KEY-SIGNATURE-PAYLOAD-CANARY";
    const session = new RelayConnectionSession({
      identity: {
        ...identity(),
        createRelayAuthenticationFrame: async () => {
          throw new Error(canary);
        },
      },
      transport: {
        open: () => {
          throw new Error("socket must not open");
        },
      },
      hubOrigin: "https://relay.example",
      onFrame: () => undefined,
      onTerminal: () => undefined,
    });
    let error: unknown;
    try {
      await session.authenticate();
    } catch (cause) {
      error = cause;
    }
    expect(String(error)).toBe("RelayConnectionError: Hub relay connection failed.");
    expect(JSON.stringify(error)).not.toContain(canary);
  });

  it("preserves a bounded transient proof-preflight reason without opening a socket", async () => {
    let opens = 0;
    const session = new RelayConnectionSession({
      identity: {
        ...identity(),
        createRelayAuthenticationFrame: async () => {
          throw new HubRelayAuthenticationError("server_draining");
        },
      },
      transport: {
        open: () => {
          opens += 1;
          return new FakeSocket();
        },
      },
      hubOrigin: "https://relay.example",
      onFrame: () => undefined,
      onTerminal: () => undefined,
    });
    await expect(session.authenticate()).rejects.toMatchObject({ kind: "server_draining" });
    expect(opens).toBe(0);
  });
});
