import { EnvironmentId, ORCHESTRATION_WS_METHODS, WS_METHODS } from "@ryco/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type {
  EndpointService,
  HttpClientService,
  PasskeyCeremonyService,
  SessionCredentialsService,
} from "@ryco/client-runtime/platform";
import type { HostedEnvironmentSessionRecord } from "@ryco/client-runtime/authorization/hostedEnvironmentSessions";
import type { EarlySocketLike } from "@ryco/client-runtime/relay/earlyRelaySocket";
import type { HostedEnvironmentAttemptPorts } from "@ryco/client-runtime/relay/environmentAttemptBinding";

import {
  createHostedEnvironmentSessions,
  type HostedEnvironmentSessions,
} from "../authorization/hostedEnvironmentSessions.ts";
import {
  configureHostedRuntime,
  type HostedRuntimeConfiguration,
} from "../authorization/runtime.ts";
import { hostedHubController } from "../authorization/state.ts";
import type {
  HostedBrowserStatus,
  HostedHubNode,
  HostedRelayFailure,
} from "../authorization/types.ts";
import { encodeBase64Url } from "./base64url.ts";
import {
  createHostedEnvironmentAttemptFactory,
  type HostedEnvironmentSharedState,
} from "./environmentAttemptBinding.ts";

const RELAY_URL = "wss://hub.example.test/v1/relay/client";
const ENV_X = EnvironmentId.make("env_xxxxxxxxxxxxxxxxxxxxxx");
const ENV_Y = EnvironmentId.make("env_yyyyyyyyyyyyyyyyyyyyyy");

const dispatchCommand = { tag: ORCHESTRATION_WS_METHODS.dispatchCommand, stream: false } as const;
const subscribeShell = { tag: ORCHESTRATION_WS_METHODS.subscribeShell, stream: true } as const;

function hubNode(environmentId: EnvironmentId): HostedHubNode {
  const suffix = environmentId.slice(4);
  return {
    id: `node_${suffix}`,
    environmentId,
    label: `Node ${suffix.slice(0, 1)}`,
    platformOs: "linux",
    platformArch: "x64",
    clientVersion: "0.9.0",
    createdAt: 1,
    updatedAt: 1,
    lastAuthenticatedAt: 1,
    revokedAt: null,
    revocationReasonCode: null,
    grant: { id: `grant_${suffix}`, role: "operator" },
    effectiveRole: "operator",
    presence: { online: true, lastHeartbeatAt: 1 },
  };
}

const unusedService = new Proxy(
  {},
  {
    get() {
      throw new Error("platform service is not used by the environment binding tests");
    },
  },
);

function configureRuntime(overrides: Partial<HostedRuntimeConfiguration> = {}): void {
  configureHostedRuntime(
    {
      endpoint: unusedService as EndpointService,
      httpClient: unusedService as HttpClientService,
      passkeyCeremony: unusedService as PasskeyCeremonyService,
      sessionCredentials: unusedService as SessionCredentialsService,
      nodeLifecycle: unusedService as never,
      environmentSessions: "retained",
      timers: {
        now: () => Date.now(),
        setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
        clearTimeout: (timer) => globalThis.clearTimeout(timer),
        queueMicrotask: (callback) => globalThis.queueMicrotask(callback),
      },
      isForeground: () => true,
      subscribeForeground: () => () => undefined,
      hasPendingRelayRequests: () => false,
      resetRelayAttemptFactory: () => undefined,
      relayUrl: () => RELAY_URL,
      createRelaySocket: () => {
        throw new Error("every environment connection brings its own relay socket");
      },
      ...overrides,
    },
    unusedService as never,
  );
}

function sharedStore(initial: HostedEnvironmentSharedState) {
  let state = initial;
  const listeners = new Set<() => void>();
  return {
    read: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    set(patch: Partial<HostedEnvironmentSharedState>) {
      state = { ...state, ...patch };
      for (const listener of Array.from(listeners)) listener();
    },
  };
}

interface Callbacks {
  onTransportStatus(status: string): void;
  onSessionStatus(status: string): void;
  onRole(role: string | null): void;
  onFailure(failure: HostedRelayFailure): void;
}

let sessions: HostedEnvironmentSessions;
let shared: ReturnType<typeof sharedStore>;

function bind(
  environmentId: EnvironmentId,
  options: {
    readonly ports?: HostedEnvironmentAttemptPorts;
    readonly isDemanded?: () => boolean;
    readonly generation?: number;
  } = {},
) {
  return createHostedEnvironmentAttemptFactory({
    sessions,
    environmentId,
    nodeId: hubNode(environmentId).id,
    readShared: shared.read,
    subscribeShared: shared.subscribe,
    ports: options.ports ?? {},
    ...(options.isDemanded === undefined ? {} : { isDemanded: options.isDemanded }),
    ...(options.generation === undefined ? {} : { generation: options.generation }),
  });
}

/** Ask for the environment's connection and complete its own fresh attempt. */
function establish(environmentId: EnvironmentId): number {
  const { generation } = sessions.ensureRecord(hubNode(environmentId));
  sessions.markConnectRequested(environmentId, generation);
  sessions.transportStatus(environmentId, generation, "online");
  sessions.markSessionReady(environmentId, generation);
  return generation;
}

function record(environmentId: EnvironmentId): HostedEnvironmentSessionRecord {
  const current = sessions.read(environmentId);
  if (current === undefined) throw new Error("missing record");
  return current;
}

beforeEach(() => {
  configureRuntime();
  sessions = createHostedEnvironmentSessions({
    now: () => Date.now(),
    setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
    clearTimeout: (timer) => globalThis.clearTimeout(timer as ReturnType<typeof setTimeout>),
  });
  shared = sharedStore({
    accountStatus: "authenticated",
    directoryStatus: "ready",
    browserStatus: "current",
  });
});

afterEach(() => {
  sessions.clear();
});

describe("environment-bound relay attempts", () => {
  it("admits each environment's requests from its own session", () => {
    sessions.ensureRecord(hubNode(ENV_X));
    establish(ENV_Y);
    const x = bind(ENV_X).factory.lifecycleHandlers();
    const y = bind(ENV_Y).factory.lifecycleHandlers();

    expect(x.authorizeRequest?.(dispatchCommand)).toBe("awaiting-session");
    expect(x.authorizeRequest?.(subscribeShell)).toBe("allowed");
    expect(y.authorizeRequest?.(dispatchCommand)).toBe("allowed");
  });

  it("admits a ready environment while the browser only waits for the selected one", () => {
    sessions.ensureRecord(hubNode(ENV_X));
    establish(ENV_Y);
    const y = bind(ENV_Y).factory.lifecycleHandlers();
    shared.set({ browserStatus: "synchronizing" });
    expect(y.authorizeRequest?.(dispatchCommand)).toBe("allowed");

    for (const browserStatus of ["checking-access", "suspended", "offline", "stale"] as const) {
      shared.set({ browserStatus });
      expect(y.authorizeRequest?.(dispatchCommand)).not.toBe("allowed");
      expect(y.authorizeRequest?.(subscribeShell)).not.toBe("allowed");
    }
  });

  it("refuses everything once the record's generation is replaced", () => {
    establish(ENV_Y);
    const { factory, binding, generation } = bind(ENV_Y);
    const lifecycle = factory.lifecycleHandlers();
    expect(lifecycle.authorizeRequest?.(dispatchCommand)).toBe("allowed");
    expect(binding.shouldReconnect(generation)).toBe(true);

    sessions.renew(ENV_Y);
    const renewed = record(ENV_Y).generation;
    sessions.markConnectRequested(ENV_Y, renewed);
    sessions.transportStatus(ENV_Y, renewed, "online");
    sessions.markSessionReady(ENV_Y, renewed);

    expect(lifecycle.authorizeRequest?.(dispatchCommand)).toBe("forbidden");
    expect(lifecycle.authorizeRequest?.(subscribeShell)).toBe("forbidden");
    expect(binding.shouldReconnect(generation)).toBe(false);
    expect(binding.isCurrent(generation)).toBe(false);
    expect(binding.isCurrent(renewed)).toBe(false);
    expect(bind(ENV_Y, { generation }).binding.isCurrent(generation)).toBe(false);
    // A release forgets the environment altogether.
    sessions.release(ENV_Y);
    expect(bind(ENV_Y, { generation: renewed }).binding.authorizeRequest(dispatchCommand)).toBe(
      "forbidden",
    );
    expect(() => bind(ENV_Y)).toThrow("no session");
  });

  it("follows the record's role and the directory's freshness", () => {
    const generation = establish(ENV_Y);
    const { binding } = bind(ENV_Y);
    binding.role(generation, "viewer");
    expect(binding.authorizeRequest({ tag: WS_METHODS.terminalWrite, stream: false })).toBe(
      "forbidden",
    );
    shared.set({ directoryStatus: "stale" });
    expect(binding.authorizeRequest(subscribeShell)).not.toBe("allowed");
  });

  it("reconnects an environment that is not selected, unless it is suspended or no longer wanted", () => {
    establish(ENV_X);
    const generation = establish(ENV_Y);
    let demanded = true;
    const { binding } = bind(ENV_Y, { isDemanded: () => demanded });

    expect(binding.shouldReconnect(generation)).toBe(true);
    shared.set({ browserStatus: "synchronizing" });
    expect(binding.shouldReconnect(generation)).toBe(true);

    demanded = false;
    expect(binding.shouldReconnect(generation)).toBe(false);
    demanded = true;

    for (const patch of [
      { browserStatus: "suspended" as HostedBrowserStatus },
      { directoryStatus: "stale" as const },
      { accountStatus: "session-expired" as const },
    ]) {
      shared.set(patch);
      expect(binding.shouldReconnect(generation)).toBe(false);
      shared.set({
        accountStatus: "authenticated",
        directoryStatus: "ready",
        browserStatus: "current",
      });
    }

    binding.failure(generation, { kind: "incompatible", retryable: false });
    expect(binding.shouldReconnect(generation)).toBe(false);

    const suspended = establish(ENV_X);
    sessions.suspendAll();
    expect(bind(ENV_X, { generation: suspended }).binding.shouldReconnect(suspended)).toBe(false);
    const current = record(ENV_X).generation;
    expect(bind(ENV_X).binding.shouldReconnect(current)).toBe(false);
  });

  it("notifies admission changes from the shared state and the sessions", () => {
    establish(ENV_Y);
    const changed = vi.fn();
    const unsubscribe = bind(ENV_Y).factory.lifecycleHandlers().subscribeAdmissionChanges!(changed);
    shared.set({ browserStatus: "synchronizing" });
    expect(changed).toHaveBeenCalledTimes(1);
    sessions.markEnvironmentDeliveryUnknown(ENV_Y);
    expect(changed).toHaveBeenCalledTimes(2);
    unsubscribe();
    shared.set({ browserStatus: "current" });
    sessions.release(ENV_Y);
    expect(changed).toHaveBeenCalledTimes(2);
  });

  it("writes every relay callback to its own record and passes the node to the socket", async () => {
    const { generation } = sessions.ensureRecord(hubNode(ENV_Y));
    sessions.markConnectRequested(ENV_Y, generation);
    establish(ENV_X);
    const otherBefore = record(ENV_X);
    const created: Array<{ readonly nodeId: string; readonly callbacks: Callbacks }> = [];
    const onFailure = vi.fn();
    const ports: HostedEnvironmentAttemptPorts = {
      relayUrl: () => RELAY_URL,
      issueRelayAttempt: async (input) => ({
        ticket: encodeBase64Url(new Uint8Array(32).fill(3)),
        expiresAt: Date.now() + 60_000,
        preparedSocketContext: input.preparedSocketContext,
      }),
      createRelaySocket: (input) => {
        created.push({ nodeId: input.nodeId, callbacks: input.callbacks as Callbacks });
        return {};
      },
      onFailure,
    };
    const { factory } = bind(ENV_Y, { ports });

    factory.createSocket(await factory.nextUrl());
    expect(created[0]?.nodeId).toBe(hubNode(ENV_Y).id);
    const callbacks = created[0]!.callbacks;
    callbacks.onTransportStatus("online");
    callbacks.onSessionStatus("synchronizing");
    callbacks.onRole("owner");
    expect(record(ENV_Y)).toMatchObject({
      transportStatus: "online",
      transportReachedOnline: true,
      sessionStatus: "synchronizing",
      effectiveRole: "owner",
    });
    const failure = { kind: "offline", retryable: true } as const;
    callbacks.onFailure(failure);
    expect(onFailure).toHaveBeenCalledExactlyOnceWith(failure);
    expect(record(ENV_Y)).toMatchObject({ failure, transportStatus: "reconnecting" });
    expect(record(ENV_X)).toBe(otherBefore);
  });

  it("adopts its replacement channel after an unintentional close", async () => {
    const generation = establish(ENV_Y);
    const created: Callbacks[] = [];
    const { factory } = bind(ENV_Y, {
      ports: {
        relayUrl: () => RELAY_URL,
        issueRelayAttempt: async (input) => ({
          ticket: encodeBase64Url(new Uint8Array(32).fill(4)),
          expiresAt: Date.now() + 60_000,
          preparedSocketContext: input.preparedSocketContext,
        }),
        createRelaySocket: (input) => {
          created.push(input.callbacks as Callbacks);
          return {};
        },
      },
    });
    const lifecycle = factory.lifecycleHandlers();
    factory.createSocket(await factory.nextUrl());
    created[0]!.onTransportStatus("online");
    lifecycle.onClose?.({ code: 1006, reason: "" }, { intentional: false });
    expect(record(ENV_Y)).toMatchObject({ relayGap: true, transportStatus: "reconnecting" });

    factory.createSocket(await factory.nextUrl());
    created[1]!.onTransportStatus("online");
    expect(record(ENV_Y)).toMatchObject({
      relayGap: false,
      sessionEstablished: false,
      transportStatus: "online",
    });
    sessions.markSessionReady(ENV_Y, generation);
    expect(record(ENV_Y).sessionStatus).toBe("ready");
  });

  it("leaves the environment uncertain when it is released with a mutation in flight", () => {
    establish(ENV_Y);
    const { factory } = bind(ENV_Y);
    const lifecycle = factory.lifecycleHandlers();
    lifecycle.onRequestStart?.({ id: "1", ...dispatchCommand });
    expect(factory.hasPendingRequests()).toBe(true);
    sessions.release(ENV_Y);
    expect(sessions.getSnapshot().deliveryUnknown.has(ENV_Y)).toBe(true);
    expect(sessions.ensureRecord(hubNode(ENV_Y)).sessionStatus).toBe("delivery-unknown");
    lifecycle.onDispose?.();
  });

  it("hands the platform's own early socket to its attempt", async () => {
    establish(ENV_Y);
    const early = { discard: vi.fn() };
    const socket: EarlySocketLike = {
      binaryType: "blob",
      readyState: 0,
      close: () => undefined,
      addEventListener: () => undefined,
    };
    const createRelaySocket = vi.fn((input: { readonly earlySocket?: unknown }) => {
      expect(input.earlySocket).toBe(early);
      return socket;
    });
    const { factory } = bind(ENV_Y, {
      ports: {
        relayUrl: () => RELAY_URL,
        openEarlyRelaySocket: () => early,
        issueRelayAttempt: async (input) => ({
          ticket: encodeBase64Url(new Uint8Array(32).fill(5)),
          expiresAt: Date.now() + 60_000,
          preparedSocketContext: input.preparedSocketContext,
        }),
        createRelaySocket,
      },
    });
    expect(factory.createSocket(await factory.nextUrl())).toBe(socket);
    expect(createRelaySocket).toHaveBeenCalledOnce();
    expect(early.discard).not.toHaveBeenCalled();
  });

  it("falls back to the hosted runtime's relay ports for each one the platform omits", async () => {
    const prepared = { channel: "prepared by the runtime" };
    const issueRelayAttempt = vi.fn(async (input: { readonly preparedSocketContext: unknown }) => ({
      ticket: encodeBase64Url(new Uint8Array(32).fill(6)),
      expiresAt: Date.now() + 60_000,
      preparedSocketContext: input.preparedSocketContext,
    }));
    const sockets: Array<{ readonly nodeId?: string; readonly preparedSocketContext?: unknown }> =
      [];
    const disposeRelaySocketContext = vi.fn();
    const probeHubSubscription = vi.fn();
    configureRuntime({
      prepareRelaySocketContext: async () => prepared,
      issueRelayAttempt,
      disposeRelaySocketContext,
      probeHubSubscription,
      createRelaySocket: (input) => {
        sockets.push(input);
        return {};
      },
    });
    const revalidateSession = vi
      .spyOn(hostedHubController, "revalidateSession")
      .mockResolvedValue();
    const generation = establish(ENV_Y);
    const early = { discard: vi.fn() };
    // The platform brings only its early socket; that one wins over the runtime's.
    const { factory, binding } = bind(ENV_Y, { ports: { openEarlyRelaySocket: () => early } });

    factory.createSocket(await factory.nextUrl());

    expect(issueRelayAttempt).toHaveBeenCalledExactlyOnceWith({
      nodeId: hubNode(ENV_Y).id,
      generation,
      preparedSocketContext: prepared,
    });
    expect(sockets).toEqual([
      expect.objectContaining({
        url: RELAY_URL,
        nodeId: hubNode(ENV_Y).id,
        preparedSocketContext: prepared,
        earlySocket: early,
      }),
    ]);
    binding.disposeSocketContext?.(prepared);
    expect(disposeRelaySocketContext).toHaveBeenCalledExactlyOnceWith(prepared);
    binding.connectionSuspect?.();
    expect(probeHubSubscription).toHaveBeenCalledOnce();
    binding.revalidateSession?.();
    expect(revalidateSession).toHaveBeenCalledOnce();
    revalidateSession.mockRestore();
  });

  it("opens a Hub-authenticated channel through the runtime and hands a refused session back", async () => {
    const created: Array<{ readonly nodeId: string; readonly callbacks: Callbacks }> = [];
    configureRuntime({
      serverAuthenticatedRelayAvailable: () => true,
      createServerAuthenticatedRelaySocket: (input) => {
        created.push({ nodeId: input.nodeId, callbacks: input.callbacks as Callbacks });
        return {};
      },
    });
    const revalidateSession = vi
      .spyOn(hostedHubController, "revalidateSession")
      .mockResolvedValue();
    establish(ENV_Y);
    const { factory } = bind(ENV_Y);

    factory.createSocket(await factory.nextUrl());
    expect(created.map((entry) => entry.nodeId)).toEqual([hubNode(ENV_Y).id]);
    created[0]!.callbacks.onFailure({
      kind: "authentication",
      retryable: true,
      closeReason: "authentication_failed",
    });

    expect(revalidateSession).toHaveBeenCalledOnce();
    expect(record(ENV_Y).transportStatus).toBe("reconnecting");
    revalidateSession.mockRestore();
  });

  it("fails the record closed even when the platform's failure handler throws", () => {
    const generation = establish(ENV_Y);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { binding } = bind(ENV_Y, {
      ports: {
        onFailure: () => {
          throw new Error("broken handler");
        },
      },
    });

    expect(() =>
      binding.failure(generation, { kind: "authorization-removed", retryable: false }),
    ).not.toThrow();

    expect(record(ENV_Y)).toMatchObject({
      transportStatus: "terminal-failure",
      effectiveRole: null,
    });
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });
});
