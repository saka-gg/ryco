import { once } from "node:events";
import type { IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";

import { EARLY_RELAY_SOCKET_TICKET_WAIT_MS } from "@ryco/client-runtime/relay/earlyRelaySocket";
import { EnvironmentId } from "@ryco/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { WebSocketServer } from "ws";

import {
  bytesFromRawData,
  DESKTOP_WORKSPACE_MAX_RPC_FRAME_BYTES,
  DesktopWorkspaceRelayManager,
  RELAY_COMPRESSION_RETRY_AFTER_MS,
  type DesktopWorkspaceRelayAuthority,
  type DesktopWorkspaceTransportEvent,
} from "./desktopWorkspaceRelay.ts";

function unavailableAuthority(): DesktopWorkspaceRelayAuthority {
  return {
    resolveTarget: vi.fn().mockResolvedValue(null),
    prepareE2ee: vi.fn(),
    handshake: vi.fn(),
    issueTicket: vi.fn(),
    authorizeUpgrade: vi.fn(),
  };
}

/** A stand-in for the `ws` socket the relay upgrade opens, driven through `addEventListener`. */
class FakeUpgradeSocket {
  binaryType = "blob";
  readyState = 0;
  bufferedAmount = 0;
  readonly closes: Array<{ readonly code?: number; readonly reason?: string }> = [];
  readonly send = vi.fn();
  readonly #listeners = new Map<string, Array<(event: never) => void>>();

  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;

  constructor(url: string, headers: Readonly<Record<string, string>>) {
    this.url = url;
    this.headers = headers;
  }

  addEventListener = (type: string, listener: (event: never) => void) => {
    this.#listeners.set(type, [...(this.#listeners.get(type) ?? []), listener]);
  };

  close = (code?: number, reason?: string) => {
    this.closes.push({
      ...(code === undefined ? {} : { code }),
      ...(reason === undefined ? {} : { reason }),
    });
    this.readyState = 3;
  };

  emit(type: string, event: object = {}): void {
    if (type === "open") this.readyState = 1;
    if (type === "close") this.readyState = 3;
    for (const listener of this.#listeners.get(type) ?? []) listener(event as never);
  }
}

function upgradeSockets() {
  const sockets: FakeUpgradeSocket[] = [];
  const createUpgradeSocket = vi.fn(
    (url: string, headers: Readonly<Record<string, string>>): never => {
      const socket = new FakeUpgradeSocket(url, headers);
      sockets.push(socket);
      return socket as never;
    },
  );
  return { sockets, createUpgradeSocket };
}

/** The handshake service as the relay manager uses it: cleanup owner and security helper hold. */
function fakeHandshake() {
  const release = vi.fn();
  const holdForRelay = vi.fn(() => release);
  const destroy = vi.fn();
  return { handshake: { destroy, holdForRelay } as never, destroy, holdForRelay, release };
}

describe("Desktop workspace relay manager", () => {
  it("bounds prepared opaque handles and never derives them from environment ids", () => {
    const manager = new DesktopWorkspaceRelayManager({
      authority: unavailableAuthority(),
      emit: vi.fn(),
    });
    const ids = Array.from({ length: 8 }, (_, index) =>
      manager.prepare(EnvironmentId.make(`environment-${index}`)),
    );

    expect(new Set(ids).size).toBe(8);
    expect(ids.every((id) => /^[A-Za-z0-9_-]{32}$/u.test(id))).toBe(true);
    expect(ids.some((id) => id.includes("environment"))).toBe(false);
    expect(() => manager.prepare(EnvironmentId.make("environment-9"))).toThrow(
      "Desktop workspace transport capacity is unavailable.",
    );
  });

  it("expires unused handles before admitting another transport", () => {
    let now = 100;
    const manager = new DesktopWorkspaceRelayManager({
      authority: unavailableAuthority(),
      emit: vi.fn(),
      now: () => now,
    });
    for (let index = 0; index < 8; index += 1) {
      manager.prepare(EnvironmentId.make(`environment-${index}`));
    }

    now += 30_001;
    expect(() => manager.prepare(EnvironmentId.make("environment-new"))).not.toThrow();
  });

  it("fails an unavailable exact target closed without exposing authority material", async () => {
    const events: DesktopWorkspaceTransportEvent[] = [];
    const authority = unavailableAuthority();
    const manager = new DesktopWorkspaceRelayManager({
      authority,
      emit: (event) => events.push(event),
    });
    const transportId = manager.prepare(EnvironmentId.make("environment-1"));

    await expect(manager.activate(transportId)).rejects.toThrow(
      "Desktop workspace relay activation failed.",
    );
    expect(authority.resolveTarget).toHaveBeenCalledWith("environment-1", false);
    expect(authority.issueTicket).not.toHaveBeenCalled();
    expect(events).toEqual([
      { type: "close", transportId, code: 4401, reason: "Relay unavailable", retryable: true },
    ]);
    expect(() => manager.send(transportId, Uint8Array.of(1))).toThrow(
      "Desktop workspace transport is unavailable.",
    );
  });

  it("marks verification transports as pairing-only at every authority boundary", async () => {
    const authority = unavailableAuthority();
    const manager = new DesktopWorkspaceRelayManager({
      authority,
      emit: vi.fn(),
    });
    const transportId = manager.prepareVerification(EnvironmentId.make("environment-1"));

    await expect(manager.activate(transportId)).rejects.toThrow(
      "Desktop workspace relay activation failed.",
    );
    expect(authority.resolveTarget).toHaveBeenCalledWith("environment-1", true);
  });

  it("does not issue the legacy ticket request for an account-trusted target", async () => {
    const events: DesktopWorkspaceTransportEvent[] = [];
    const authority = unavailableAuthority();
    vi.mocked(authority.resolveTarget).mockResolvedValue({
      accountId: `acct_${"a".repeat(22)}`,
      nodeId: `node_${"n".repeat(22)}`,
      environmentId: EnvironmentId.make("environment-1"),
      relayUrl: "wss://hub.example.test/v1/relay/client",
      nativeTrust: "account-trusted",
    });
    vi.mocked(authority.prepareE2ee).mockResolvedValue({
      kind: "update-required",
    });
    vi.mocked(authority.authorizeUpgrade).mockResolvedValue({});
    vi.mocked(authority.handshake).mockResolvedValue(fakeHandshake().handshake);
    const manager = new DesktopWorkspaceRelayManager({
      authority,
      emit: (event) => events.push(event),
      createUpgradeSocket: upgradeSockets().createUpgradeSocket,
    });

    await expect(
      manager.activate(manager.prepare(EnvironmentId.make("environment-1"))),
    ).rejects.toThrow("Desktop workspace relay activation failed.");
    expect(authority.issueTicket).not.toHaveBeenCalled();
    expect(events.at(-1)).toMatchObject({
      type: "close",
      code: 4406,
      reason: "Update required",
    });
  });

  it("uses a pairing ticket when independently verifying an account-trusted target", async () => {
    const authority = unavailableAuthority();
    const environmentId = EnvironmentId.make("environment-1");
    vi.mocked(authority.resolveTarget).mockResolvedValue({
      accountId: `acct_${"a".repeat(22)}`,
      nodeId: `node_${"n".repeat(22)}`,
      environmentId,
      relayUrl: "wss://hub.example.test/v1/relay/client",
      nativeTrust: "account-trusted",
    });
    vi.mocked(authority.prepareE2ee).mockResolvedValue({
      kind: "native",
      pairingOnly: true,
      attemptHandle: "a".repeat(43),
      suiteId: 1,
      credentials: { tier: "native" },
    } as never);
    vi.mocked(authority.issueTicket).mockResolvedValue({
      ticket: "pairing-ticket",
      expiresAt: Date.now() + 60_000,
    });
    vi.mocked(authority.authorizeUpgrade).mockResolvedValue({});
    vi.mocked(authority.handshake).mockResolvedValue(fakeHandshake().handshake);
    const socketFactory = vi.fn(() => ({ send: vi.fn(), close: vi.fn() }));
    const manager = new DesktopWorkspaceRelayManager({
      authority,
      emit: vi.fn(),
      socketFactory,
      createUpgradeSocket: upgradeSockets().createUpgradeSocket,
    });

    await manager.activate(manager.prepareVerification(environmentId));

    expect(authority.prepareE2ee).toHaveBeenCalledWith(
      expect.objectContaining({ nativeTrust: "account-trusted" }),
      true,
    );
    expect(authority.issueTicket).toHaveBeenCalledOnce();
    expect(socketFactory).toHaveBeenCalledWith(
      expect.objectContaining({ ticket: "pairing-ticket" }),
    );
  });

  it("invalidates every native workspace when an account enrollment is revoked", async () => {
    const onAccountAuthorizationRevoked = vi.fn();
    const authority = {
      ...unavailableAuthority(),
      onAccountAuthorizationRevoked,
    };
    vi.mocked(authority.resolveTarget).mockResolvedValue({
      accountId: `acct_${"a".repeat(22)}`,
      nodeId: `node_${"n".repeat(22)}`,
      environmentId: EnvironmentId.make("environment-1"),
      relayUrl: "wss://hub.example.test/v1/relay/client",
      nativeTrust: "account-trusted",
    });
    vi.mocked(authority.prepareE2ee).mockResolvedValue({
      kind: "native",
      pairingOnly: false,
      attemptHandle: "a".repeat(43),
      suiteId: 2,
      credentials: { tier: "native" },
      relayTicket: { ticket: "t".repeat(43), expiresAt: Date.now() + 60_000 },
    } as never);
    vi.mocked(authority.authorizeUpgrade).mockResolvedValue({});
    vi.mocked(authority.handshake).mockResolvedValue(fakeHandshake().handshake);
    let callbacks:
      | Parameters<
          NonNullable<
            ConstructorParameters<typeof DesktopWorkspaceRelayManager>[0]["socketFactory"]
          >
        >[0]["callbacks"]
      | undefined;
    const close = vi.fn();
    const manager = new DesktopWorkspaceRelayManager({
      authority,
      emit: vi.fn(),
      createUpgradeSocket: upgradeSockets().createUpgradeSocket,
      socketFactory: (input) => {
        callbacks = input.callbacks;
        return { send: vi.fn(), close };
      },
    });
    await manager.activate(manager.prepare(EnvironmentId.make("environment-1")));

    callbacks?.onFailure({
      kind: "revoked",
      retryable: false,
      enrollmentRevoked: { enrollmentId: "enrollment-test", enrollmentRevision: 1 },
    });
    await Promise.resolve();

    expect(onAccountAuthorizationRevoked).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function relayFixture(options: { readonly now?: () => number } = {}) {
  const environmentId = EnvironmentId.make("environment-1");
  const target = {
    accountId: "account",
    nodeId: "node",
    environmentId,
    relayUrl: "wss://hub.example.test/v1/relay/client",
    nativeTrust: "account-trusted" as const,
  };
  const preparation = {
    kind: "native",
    pairingOnly: false,
    attemptHandle: "a".repeat(43),
    suiteId: 2,
    credentials: { tier: "native" },
    relayTicket: { ticket: "ticket", expiresAt: Date.now() + 60_000 },
  } as const;
  const { handshake, destroy, holdForRelay, release } = fakeHandshake();
  const { sockets, createUpgradeSocket } = upgradeSockets();
  const authority = { ...unavailableAuthority(), onAccountAuthorizationRevoked: vi.fn() };
  vi.mocked(authority.resolveTarget).mockResolvedValue(target);
  vi.mocked(authority.prepareE2ee).mockResolvedValue(preparation as never);
  vi.mocked(authority.handshake).mockResolvedValue(handshake);
  vi.mocked(authority.authorizeUpgrade).mockResolvedValue({ Authorization: "DPoP token" });
  const close = vi.fn();
  const socketFactory = vi.fn(
    (
      _input: Parameters<
        NonNullable<ConstructorParameters<typeof DesktopWorkspaceRelayManager>[0]["socketFactory"]>
      >[0],
    ) => ({ send: vi.fn(), close }),
  );
  const emit = vi.fn();
  const manager = new DesktopWorkspaceRelayManager({
    authority,
    socketFactory,
    createUpgradeSocket,
    emit,
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  return {
    environmentId,
    target,
    preparation,
    destroy,
    holdForRelay,
    release,
    sockets,
    createUpgradeSocket,
    authority,
    close,
    socketFactory,
    emit,
    manager,
  };
}

describe("desktop relay attempt ownership", () => {
  it.each(["close", "dispose"] as const)(
    "does not open after %s during target resolution",
    async (operation) => {
      const f = relayFixture();
      const target = deferred<typeof f.target>();
      vi.mocked(f.authority.resolveTarget).mockReturnValue(target.promise);
      const id = f.manager.prepare(f.environmentId);
      const activation = f.manager.activate(id);
      if (operation === "close") f.manager.close(id);
      else f.manager.dispose();
      f.emit.mockClear();
      target.resolve(f.target);
      await activation;
      expect(f.socketFactory).not.toHaveBeenCalled();
      expect(f.authority.prepareE2ee).not.toHaveBeenCalled();
      expect(f.emit).not.toHaveBeenCalled();
    },
  );

  it("destroys preparation that arrives after disposal", async () => {
    const f = relayFixture();
    const preparation = deferred<typeof f.preparation>();
    vi.mocked(f.authority.prepareE2ee).mockReturnValue(preparation.promise as never);
    const activation = f.manager.activate(f.manager.prepare(f.environmentId));
    await vi.waitFor(() => expect(f.authority.prepareE2ee).toHaveBeenCalledOnce());
    f.manager.dispose();
    f.emit.mockClear();
    preparation.resolve(f.preparation);
    await activation;
    expect(f.socketFactory).not.toHaveBeenCalled();
    expect(f.destroy).toHaveBeenCalledExactlyOnceWith(f.preparation.attemptHandle);
    expect(f.emit).not.toHaveBeenCalled();
  });

  it("destroys late native preparation after a sibling authority request fails", async () => {
    const f = relayFixture();
    const preparation = deferred<typeof f.preparation>();
    vi.mocked(f.authority.resolveTarget).mockResolvedValue({
      ...f.target,
      nativeTrust: "verified",
    });
    vi.mocked(f.authority.prepareE2ee).mockReturnValue(preparation.promise as never);
    vi.mocked(f.authority.issueTicket).mockRejectedValue(new Error("unavailable"));
    await expect(f.manager.activate(f.manager.prepare(f.environmentId))).rejects.toThrow(
      "activation failed",
    );
    preparation.resolve(f.preparation);
    await preparation.promise;
    expect(f.destroy).toHaveBeenCalledExactlyOnceWith(f.preparation.attemptHandle);
    expect(f.socketFactory).not.toHaveBeenCalled();
  });

  it("admits only one activation and ignores callbacks after cancellation", async () => {
    const f = relayFixture();
    const id = f.manager.prepare(f.environmentId);
    const activation = f.manager.activate(id);
    await expect(f.manager.activate(id)).rejects.toThrow("unavailable");
    await activation;
    const input = f.socketFactory.mock.calls[0]![0];
    f.manager.close(id);
    expect(f.emit).toHaveBeenCalledExactlyOnceWith({
      type: "close",
      transportId: id,
      code: 1000,
      reason: "Workspace closed",
      retryable: false,
    });
    f.emit.mockClear();
    input.events.open();
    input.events.message(Uint8Array.of(1));
    input.events.close(1006, "lost");
    input.callbacks.onFailure({
      kind: "revoked",
      retryable: false,
      enrollmentRevoked: { enrollmentId: "enrollment-test", enrollmentRevision: 1 },
    });
    await Promise.resolve();
    expect(f.emit).not.toHaveBeenCalled();
    expect(f.authority.onAccountAuthorizationRevoked).not.toHaveBeenCalled();
    expect(f.close).toHaveBeenCalledOnce();
    expect(f.destroy).toHaveBeenCalledOnce();
  });

  it("preserves retry hints without interpreting one node's refusal as account revocation", async () => {
    const f = relayFixture();
    const id = f.manager.prepare(f.environmentId);
    await f.manager.activate(id);
    const input = f.socketFactory.mock.calls[0]![0];
    input.callbacks.onFailure({ kind: "rate-limited", retryable: true, retryAfterMs: 90_000 });
    input.events.error();
    input.events.close(4429, "Try later");
    expect(f.emit).toHaveBeenCalledExactlyOnceWith({
      type: "close",
      transportId: id,
      code: 4429,
      reason: "Try later",
      retryable: true,
      retryAfterMs: 90_000,
    });
    expect(f.destroy).toHaveBeenCalledOnce();
    expect(f.authority.onAccountAuthorizationRevoked).not.toHaveBeenCalled();
  });

  it("leaves other nodes connected when only one node revokes access", async () => {
    const f = relayFixture();
    await f.manager.activate(f.manager.prepare(f.environmentId));
    f.socketFactory.mock.calls[0]![0].callbacks.onFailure({ kind: "revoked", retryable: false });
    await Promise.resolve();
    expect(f.authority.onAccountAuthorizationRevoked).not.toHaveBeenCalled();
    expect(f.close).not.toHaveBeenCalled();
    f.manager.dispose();
  });

  it("runs later attempts for an environment without compression after a compression failure", async () => {
    const f = relayFixture();
    const first = f.manager.prepare(f.environmentId);
    await f.manager.activate(first);
    expect(f.socketFactory.mock.calls[0]![0].relayCompression).toBe(true);
    const input = f.socketFactory.mock.calls[0]![0];
    input.callbacks.onFailure({
      kind: "protocol",
      retryable: true,
      closeReason: "channel_rejected",
      compressionFailed: true,
    });
    input.events.close(4000, "protocol");
    expect(f.emit).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: "close", transportId: first, retryable: true }),
    );
    await f.manager.activate(f.manager.prepare(f.environmentId));
    expect(f.socketFactory.mock.calls[1]![0].relayCompression).toBe(false);
    f.manager.dispose();
  });

  it("re-enables compression after the retry window, and on a fresh manager session", async () => {
    let now = 1_000;
    const f = relayFixture({ now: () => now });
    await f.manager.activate(f.manager.prepare(f.environmentId));
    f.socketFactory.mock.calls[0]![0].callbacks.onFailure({
      kind: "protocol",
      retryable: true,
      closeReason: "channel_rejected",
      compressionFailed: true,
    });
    await f.manager.activate(f.manager.prepare(f.environmentId));
    expect(f.socketFactory.mock.calls[1]![0].relayCompression).toBe(false);
    now += RELAY_COMPRESSION_RETRY_AFTER_MS - 1;
    await f.manager.activate(f.manager.prepare(f.environmentId));
    expect(f.socketFactory.mock.calls[2]![0].relayCompression).toBe(false);
    now += 1;
    await f.manager.activate(f.manager.prepare(f.environmentId));
    expect(f.socketFactory.mock.calls[3]![0].relayCompression).toBe(true);

    // A further failure, then an account or session change: back on at once.
    f.socketFactory.mock.calls[3]![0].callbacks.onFailure({
      kind: "protocol",
      retryable: true,
      closeReason: "channel_rejected",
      compressionFailed: true,
    });
    f.manager.dispose();
    await f.manager.activate(f.manager.prepare(f.environmentId));
    expect(f.socketFactory.mock.calls[4]![0].relayCompression).toBe(true);
    f.manager.dispose();
  });
});

/** A target that asks the Hub for a ticket, so the ticket request is in flight beside the upgrade. */
function useTicketRequest(f: ReturnType<typeof relayFixture>) {
  vi.mocked(f.authority.resolveTarget).mockResolvedValue({ ...f.target, nativeTrust: "verified" });
  vi.mocked(f.authority.prepareE2ee).mockResolvedValue({
    kind: "native",
    pairingOnly: false,
    attemptHandle: "a".repeat(43),
    suiteId: 1,
    credentials: { tier: "native" },
  } as never);
  const ticket = deferred<{ readonly ticket: string; readonly expiresAt: number }>();
  vi.mocked(f.authority.issueTicket).mockReturnValue(ticket.promise);
  return ticket;
}

describe("desktop relay early upgrade", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts the upgrade before the ticket resolves and hands that socket to the relay socket", async () => {
    const f = relayFixture();
    const ticket = useTicketRequest(f);
    const activation = f.manager.activate(f.manager.prepare(f.environmentId));
    await vi.advanceTimersByTimeAsync(0);

    expect(f.authority.issueTicket).toHaveBeenCalledOnce();
    expect(f.createUpgradeSocket).toHaveBeenCalledExactlyOnceWith(f.target.relayUrl, {
      Authorization: "DPoP token",
    });
    expect(f.socketFactory).not.toHaveBeenCalled();
    // The upgrade authorization is requested ahead of the requests that share
    // the security helper with it.
    const authorizeOrder = vi.mocked(f.authority.authorizeUpgrade).mock.invocationCallOrder[0]!;
    expect(authorizeOrder).toBeLessThan(
      vi.mocked(f.authority.prepareE2ee).mock.invocationCallOrder[0]!,
    );
    expect(authorizeOrder).toBeLessThan(
      vi.mocked(f.authority.issueTicket).mock.invocationCallOrder[0]!,
    );

    f.sockets[0]!.emit("open");
    ticket.resolve({ ticket: "ticket", expiresAt: Date.now() + 60_000 });
    await activation;

    expect(f.socketFactory).toHaveBeenCalledOnce();
    expect(f.socketFactory.mock.calls[0]![0]).toMatchObject({
      ticket: "ticket",
      upgrade: { socket: f.sockets[0] },
    });
    expect(f.authority.authorizeUpgrade).toHaveBeenCalledOnce();
    expect(f.createUpgradeSocket).toHaveBeenCalledOnce();
    expect(f.sockets[0]!.closes).toEqual([]);
    f.manager.dispose();
  });

  it("opens the upgrade beside the E2EE preparation for an account-trusted target without a ticket request", async () => {
    const f = relayFixture();
    const preparation = deferred<typeof f.preparation>();
    vi.mocked(f.authority.prepareE2ee).mockReturnValue(preparation.promise as never);
    const activation = f.manager.activate(f.manager.prepare(f.environmentId));
    await vi.advanceTimersByTimeAsync(0);

    expect(f.createUpgradeSocket).toHaveBeenCalledOnce();
    expect(f.socketFactory).not.toHaveBeenCalled();
    preparation.resolve(f.preparation);
    await activation;

    expect(f.authority.issueTicket).not.toHaveBeenCalled();
    expect(f.socketFactory.mock.calls[0]![0]).toMatchObject({
      ticket: "ticket",
      upgrade: { socket: f.sockets[0] },
    });
    f.manager.dispose();
  });

  it("discards the early socket when preparation fails", async () => {
    const f = relayFixture();
    const preparation = deferred<typeof f.preparation>();
    vi.mocked(f.authority.prepareE2ee).mockReturnValue(preparation.promise as never);
    const activation = f.manager.activate(f.manager.prepare(f.environmentId));
    const failed = expect(activation).rejects.toThrow("activation failed");
    await vi.advanceTimersByTimeAsync(0);
    expect(f.sockets).toHaveLength(1);

    preparation.reject(new Error("unavailable"));
    await failed;

    expect(f.sockets[0]!.closes).toEqual([{ code: 1000, reason: "closed" }]);
    expect(f.socketFactory).not.toHaveBeenCalled();
    expect(f.release).toHaveBeenCalledOnce();
  });

  it("adopts the early socket only after the prepared attempt passes every check", async () => {
    const f = relayFixture();
    const preparation = deferred<typeof f.preparation>();
    vi.mocked(f.authority.prepareE2ee).mockReturnValue(preparation.promise as never);
    const activation = f.manager.activate(f.manager.prepare(f.environmentId));
    const failed = expect(activation).rejects.toThrow("activation failed");
    await vi.advanceTimersByTimeAsync(0);
    f.sockets[0]!.emit("open");

    preparation.resolve({ ...f.preparation, pairingOnly: true } as never);
    await failed;

    expect(f.socketFactory).not.toHaveBeenCalled();
    expect(f.sockets[0]!.closes).toEqual([{ code: 1000, reason: "closed" }]);
    expect(f.release).toHaveBeenCalledOnce();
  });

  it.each(["close", "dispose"] as const)(
    "discards the early socket when the transport is superseded by %s",
    async (operation) => {
      const f = relayFixture();
      const preparation = deferred<typeof f.preparation>();
      vi.mocked(f.authority.prepareE2ee).mockReturnValue(preparation.promise as never);
      const id = f.manager.prepare(f.environmentId);
      const activation = f.manager.activate(id);
      await vi.advanceTimersByTimeAsync(0);
      expect(f.sockets).toHaveLength(1);

      if (operation === "close") f.manager.close(id);
      else f.manager.dispose();
      expect(f.sockets[0]!.closes).toEqual([{ code: 1000, reason: "closed" }]);

      preparation.resolve(f.preparation);
      await activation;
      expect(f.socketFactory).not.toHaveBeenCalled();
      expect(f.release).toHaveBeenCalledOnce();
    },
  );

  it("opens a fresh socket with a new authorization when the early one waited too long for its ticket", async () => {
    const f = relayFixture();
    vi.mocked(f.authority.authorizeUpgrade)
      .mockResolvedValueOnce({ Authorization: "DPoP first" })
      .mockResolvedValueOnce({ Authorization: "DPoP second" });
    const preparation = deferred<typeof f.preparation>();
    vi.mocked(f.authority.prepareE2ee).mockReturnValue(preparation.promise as never);
    const activation = f.manager.activate(f.manager.prepare(f.environmentId));
    await vi.advanceTimersByTimeAsync(0);
    f.sockets[0]!.emit("open");

    await vi.advanceTimersByTimeAsync(EARLY_RELAY_SOCKET_TICKET_WAIT_MS);
    expect(f.sockets[0]!.closes).toEqual([{ code: 1000, reason: "closed" }]);

    preparation.resolve(f.preparation);
    await activation;

    expect(f.authority.authorizeUpgrade).toHaveBeenCalledTimes(2);
    expect(f.createUpgradeSocket).toHaveBeenCalledTimes(2);
    expect(f.createUpgradeSocket).toHaveBeenLastCalledWith(f.target.relayUrl, {
      Authorization: "DPoP second",
    });
    expect(f.socketFactory.mock.calls[0]![0].upgrade).toMatchObject({ socket: f.sockets[1] });
    expect(f.sockets[1]!.closes).toEqual([]);
    f.manager.dispose();
  });

  it.each(["close", "error"] as const)(
    "opens a fresh socket when the early one fails with %s before the attempt is ready",
    async (event) => {
      const f = relayFixture();
      vi.mocked(f.authority.authorizeUpgrade)
        .mockResolvedValueOnce({ Authorization: "DPoP first" })
        .mockResolvedValueOnce({ Authorization: "DPoP second" });
      const preparation = deferred<typeof f.preparation>();
      vi.mocked(f.authority.prepareE2ee).mockReturnValue(preparation.promise as never);
      const activation = f.manager.activate(f.manager.prepare(f.environmentId));
      await vi.advanceTimersByTimeAsync(0);
      f.sockets[0]!.emit("open");
      f.sockets[0]!.emit(event);

      preparation.resolve(f.preparation);
      await activation;

      expect(f.createUpgradeSocket).toHaveBeenLastCalledWith(f.target.relayUrl, {
        Authorization: "DPoP second",
      });
      expect(f.socketFactory.mock.calls[0]![0].upgrade).toMatchObject({ socket: f.sockets[1] });
      f.manager.dispose();
    },
  );

  it("discards the replacement socket when the transport is superseded while it is authorized", async () => {
    const f = relayFixture();
    const replacementHeaders = deferred<Readonly<Record<string, string>>>();
    vi.mocked(f.authority.authorizeUpgrade)
      .mockResolvedValueOnce({ Authorization: "DPoP first" })
      .mockReturnValueOnce(replacementHeaders.promise);
    const preparation = deferred<typeof f.preparation>();
    vi.mocked(f.authority.prepareE2ee).mockReturnValue(preparation.promise as never);
    const activation = f.manager.activate(f.manager.prepare(f.environmentId));
    await vi.advanceTimersByTimeAsync(0);
    f.sockets[0]!.emit("open");
    f.sockets[0]!.emit("close");
    preparation.resolve(f.preparation);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.authority.authorizeUpgrade).toHaveBeenCalledTimes(2);

    f.manager.dispose();
    replacementHeaders.resolve({ Authorization: "DPoP second" });
    await activation;

    expect(f.createUpgradeSocket).toHaveBeenCalledOnce();
    expect(f.socketFactory).not.toHaveBeenCalled();
    expect(f.release).toHaveBeenCalledOnce();
  });

  it("fails the attempt at once when the upgrade cannot be authorized", async () => {
    const f = relayFixture();
    // The ticket request never answers: only the failed authorization ends the attempt.
    useTicketRequest(f);
    vi.mocked(f.authority.authorizeUpgrade).mockRejectedValue(new Error("unavailable"));
    const id = f.manager.prepare(f.environmentId);

    await expect(f.manager.activate(id)).rejects.toThrow("activation failed");

    expect(f.authority.authorizeUpgrade).toHaveBeenCalledOnce();
    expect(f.createUpgradeSocket).not.toHaveBeenCalled();
    expect(f.socketFactory).not.toHaveBeenCalled();
    expect(f.emit).toHaveBeenCalledExactlyOnceWith({
      type: "close",
      transportId: id,
      code: 4401,
      reason: "Relay unavailable",
      retryable: true,
    });
    expect(f.destroy).toHaveBeenCalledExactlyOnceWith(f.preparation.attemptHandle);
    expect(f.release).toHaveBeenCalledOnce();
  });

  it("holds the security helper from activation until the transport ends", async () => {
    const f = relayFixture();
    const first = f.manager.prepare(f.environmentId);
    await f.manager.activate(first);
    expect(f.holdForRelay).toHaveBeenCalledOnce();
    expect(f.release).not.toHaveBeenCalled();

    f.socketFactory.mock.calls[0]![0].events.close(1006, "lost");
    expect(f.release).toHaveBeenCalledOnce();

    const second = f.manager.prepare(f.environmentId);
    await f.manager.activate(second);
    expect(f.holdForRelay).toHaveBeenCalledTimes(2);
    f.manager.close(second);
    expect(f.release).toHaveBeenCalledTimes(2);
    f.manager.dispose();
    expect(f.release).toHaveBeenCalledTimes(2);
  });
});

describe("desktop relay over a real socket", () => {
  it("sends the auth frame on the socket opened before the ticket resolved", async () => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await once(server, "listening");
    const upgrades: IncomingHttpHeaders[] = [];
    const frames: Buffer[] = [];
    const connected = deferred<void>();
    server.on("connection", (socket, request) => {
      upgrades.push(request.headers);
      connected.resolve();
      socket.on("message", (data) => frames.push(data as Buffer));
    });
    const { port } = server.address() as AddressInfo;
    const f = relayFixture();
    const relayUrl = `ws://127.0.0.1:${port}/v1/relay/client`;
    vi.mocked(f.authority.resolveTarget).mockResolvedValue({
      ...f.target,
      relayUrl,
      nativeTrust: "verified",
    });
    vi.mocked(f.authority.prepareE2ee).mockResolvedValue({
      kind: "native",
      pairingOnly: false,
      attemptHandle: "a".repeat(43),
      suiteId: 1,
      credentials: { tier: "native" },
    } as never);
    vi.mocked(f.authority.authorizeUpgrade).mockResolvedValue({ "x-upgrade-proof": "proof" });
    const ticket = deferred<{ readonly ticket: string; readonly expiresAt: number }>();
    vi.mocked(f.authority.issueTicket).mockReturnValue(ticket.promise);
    const events: DesktopWorkspaceTransportEvent[] = [];
    const manager = new DesktopWorkspaceRelayManager({
      authority: f.authority,
      emit: (event) => events.push(event),
    });
    try {
      const id = manager.prepare(f.environmentId);
      const activation = manager.activate(id);

      // The Hub has accepted the upgrade while the ticket is still outstanding.
      await connected.promise;
      expect(upgrades[0]?.["x-upgrade-proof"]).toBe("proof");
      expect(frames).toHaveLength(0);

      ticket.resolve({ ticket: "t".repeat(43), expiresAt: Date.now() + 60_000 });
      await activation;
      await vi.waitFor(() => expect(frames).toHaveLength(1));
      expect(f.authority.authorizeUpgrade).toHaveBeenCalledOnce();

      for (const client of server.clients) client.terminate();
      await vi.waitFor(() => expect(events.at(-1)).toMatchObject({ type: "close" }));
      expect(f.release).toHaveBeenCalledOnce();
    } finally {
      manager.dispose();
      server.close();
    }
  });
});

describe("inbound relay frame bytes", () => {
  it("wraps the ArrayBuffer ws delivers without copying it", () => {
    const frame = Uint8Array.of(1, 2, 3).buffer;
    const bytes = bytesFromRawData(frame);

    expect(bytes).toEqual(Uint8Array.of(1, 2, 3));
    expect(bytes?.buffer).toBe(frame);
  });

  it("joins fragments into a buffer of their own", () => {
    const first = Buffer.from([1, 2]);
    const second = Buffer.from([3]);
    const bytes = bytesFromRawData([first, second]);

    expect(bytes).toEqual(Uint8Array.of(1, 2, 3));
    bytes?.fill(0);
    expect([...first, ...second]).toEqual([1, 2, 3]);
  });

  it("copies a Buffer window so wiping the result leaves the shared chunk intact", () => {
    const chunk = Buffer.from([7, 1, 2, 3, 8]);
    const bytes = bytesFromRawData(chunk.subarray(1, 4));

    expect(bytes).toEqual(Uint8Array.of(1, 2, 3));
    expect(bytes?.buffer).not.toBe(chunk.buffer);
    bytes?.fill(0);
    expect([...chunk]).toEqual([7, 1, 2, 3, 8]);
  });

  it("refuses a Buffer or fragment set above the application frame limit", () => {
    const oversize = Buffer.alloc(DESKTOP_WORKSPACE_MAX_RPC_FRAME_BYTES + 1);

    expect(bytesFromRawData(oversize)).toBeNull();
    expect(bytesFromRawData([oversize])).toBeNull();
  });
});

describe("outbound relay frame bytes", () => {
  it("hands the caller's bytes to the transport as is", async () => {
    const f = relayFixture();
    const send = vi.fn();
    f.socketFactory.mockImplementation(() => ({ send, close: f.close }));
    const id = f.manager.prepare(f.environmentId);
    await f.manager.activate(id);

    const frame = Uint8Array.of(4, 5, 6);
    f.manager.send(id, frame);

    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0]?.[0]).toBe(frame);
    f.manager.dispose();
  });
});
