import { EnvironmentId } from "@ryco/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  DesktopWorkspaceRelayManager,
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
    vi.mocked(authority.handshake).mockResolvedValue({} as never);
    const manager = new DesktopWorkspaceRelayManager({
      authority,
      emit: (event) => events.push(event),
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
    vi.mocked(authority.handshake).mockResolvedValue({} as never);
    const socketFactory = vi.fn(() => ({ send: vi.fn(), close: vi.fn() }));
    const manager = new DesktopWorkspaceRelayManager({
      authority,
      emit: vi.fn(),
      socketFactory,
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
    vi.mocked(authority.handshake).mockResolvedValue({
      destroy: vi.fn(),
    } as never);
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
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function relayFixture() {
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
  const destroy = vi.fn();
  const authority = { ...unavailableAuthority(), onAccountAuthorizationRevoked: vi.fn() };
  vi.mocked(authority.resolveTarget).mockResolvedValue(target);
  vi.mocked(authority.prepareE2ee).mockResolvedValue(preparation as never);
  vi.mocked(authority.handshake).mockResolvedValue({ destroy } as never);
  vi.mocked(authority.authorizeUpgrade).mockResolvedValue({});
  const close = vi.fn();
  const socketFactory = vi.fn(
    (
      _input: Parameters<
        NonNullable<ConstructorParameters<typeof DesktopWorkspaceRelayManager>[0]["socketFactory"]>
      >[0],
    ) => ({ send: vi.fn(), close }),
  );
  const emit = vi.fn();
  const manager = new DesktopWorkspaceRelayManager({ authority, socketFactory, emit });
  return {
    environmentId,
    target,
    preparation,
    destroy,
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
    vi.mocked(f.authority.prepareE2ee).mockReturnValue(preparation.promise as never);
    vi.mocked(f.authority.authorizeUpgrade).mockRejectedValue(new Error("unavailable"));
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
});
