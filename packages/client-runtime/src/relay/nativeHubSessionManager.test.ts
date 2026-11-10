import type { HostedHubSessionStatus } from "./hostedHubSession.ts";
import type { RelaySocket } from "./relayEngine.ts";
import { describe, expect, it, vi } from "vite-plus/test";

import { createHubSessionManager, type ManagedHubSession } from "./nativeHubSessionManager.ts";

function stream() {
  const closeListeners: Array<() => void> = [];
  const socket = {
    bufferedAmount: 0,
    readyState: 1,
    send: () => undefined,
    close: () => undefined,
    onOpen: () => undefined,
    onBinaryMessage: () => undefined,
    onClose: (listener: () => void) => closeListeners.push(listener),
    onError: () => undefined,
  } satisfies RelaySocket;
  return { socket, end: () => closeListeners.forEach((listener) => listener()) };
}

function harness() {
  const state = { authority: "account-1" as string | null, announced: true, foreground: true };
  const sessions: Array<
    ManagedHubSession & {
      disposed: boolean;
      events: {
        onStatus: (status: HostedHubSessionStatus) => void;
        onDirectoryInvalidated: () => void;
        onFailure: (failure: { kind: string; retryable: boolean }) => void;
      };
      streams: Array<ReturnType<typeof stream>>;
    }
  > = [];
  const invalidated = vi.fn();
  const revalidate = vi.fn(async () => undefined);
  const clock = { now: 0 };
  const manager = createHubSessionManager({
    authority: () => state.authority,
    announced: () => state.announced,
    isForeground: () => state.foreground,
    create: (events) => {
      const created = {
        disposed: false,
        events,
        streams: [] as Array<ReturnType<typeof stream>>,
        start: vi.fn(),
        dispose: () => {
          created.disposed = true;
        },
        probe: vi.fn(),
        resume: vi.fn(),
        createSocket: () => {
          const next = stream();
          created.streams.push(next);
          return next.socket;
        },
      };
      sessions.push(created);
      return created;
    },
    onDirectoryInvalidated: invalidated,
    revalidateSession: revalidate,
    now: () => clock.now,
  });
  return { state, sessions, manager, invalidated, revalidate, clock };
}

describe("a native app's account session manager", () => {
  it("opens only for a signed-in account, in the foreground, on a Hub that announced it", () => {
    const h = harness();
    h.state.announced = false;
    h.manager.sync();
    expect(h.sessions).toHaveLength(0);
    h.state.announced = true;
    h.state.foreground = false;
    h.manager.sync();
    expect(h.sessions).toHaveLength(0);
    h.state.foreground = true;
    h.manager.sync();
    h.manager.sync();
    expect(h.sessions).toHaveLength(1);
    expect(h.sessions[0]!.start).toHaveBeenCalledOnce();
    // Signed out, or a Hub that stops announcing it: closed.
    h.state.authority = null;
    h.manager.sync();
    expect(h.sessions[0]!.disposed).toBe(true);
  });

  it("hands out streams only while online, and forwards directory invalidations", () => {
    const h = harness();
    h.manager.sync();
    expect(h.manager.streamFactory()).toBeUndefined();
    h.sessions[0]!.events.onStatus("online");
    expect(h.manager.isOnline()).toBe(true);
    expect(h.manager.streamFactory()).toBeDefined();
    h.sessions[0]!.events.onDirectoryInvalidated();
    expect(h.invalidated).toHaveBeenCalledOnce();
    h.sessions[0]!.events.onStatus("reconnecting");
    expect(h.manager.streamFactory()).toBeUndefined();
  });

  it("stays in the background while a channel rides it, and closes with the last one", () => {
    const h = harness();
    h.manager.sync();
    h.sessions[0]!.events.onStatus("online");
    h.manager.streamFactory()!();
    h.manager.streamFactory()!();
    h.state.foreground = false;
    h.manager.sync();
    expect(h.sessions[0]!.disposed).toBe(false);
    h.sessions[0]!.streams[0]!.end();
    expect(h.sessions[0]!.disposed).toBe(false);
    h.sessions[0]!.streams[1]!.end();
    expect(h.sessions[0]!.disposed).toBe(true);
    // Not reopened until the app is back in the foreground.
    expect(h.sessions).toHaveLength(1);
    h.state.foreground = true;
    h.manager.sync();
    expect(h.sessions).toHaveLength(2);
  });

  it("closes at once in the background when nothing rides it", () => {
    const h = harness();
    h.manager.sync();
    h.state.foreground = false;
    h.manager.sync();
    expect(h.sessions[0]!.disposed).toBe(true);
  });

  it("replaces the session for another account, and hands a refused one back to its owner", () => {
    const h = harness();
    h.manager.sync();
    h.state.authority = "account-2";
    h.manager.sync();
    expect(h.sessions[0]!.disposed).toBe(true);
    expect(h.sessions).toHaveLength(2);
    h.sessions[1]!.events.onFailure({ kind: "authentication", retryable: false });
    expect(h.sessions[1]!.disposed).toBe(true);
    expect(h.revalidate).toHaveBeenCalledOnce();
    // A stale session's events change nothing.
    h.sessions[0]!.events.onDirectoryInvalidated();
    expect(h.invalidated).not.toHaveBeenCalled();
  });

  it("opens again after a refusal at most once a minute for the same account", async () => {
    const h = harness();
    h.manager.sync();
    h.sessions[0]!.events.onFailure({ kind: "authentication", retryable: false });
    await Promise.resolve();
    await Promise.resolve();
    // Revalidated, but refused a moment ago: not reopened yet.
    expect(h.sessions).toHaveLength(1);
    h.clock.now = 60_000;
    h.manager.sync();
    expect(h.sessions).toHaveLength(2);
    // Another account opens at once.
    h.sessions[1]!.events.onFailure({ kind: "authentication", retryable: false });
    h.state.authority = "account-2";
    h.manager.sync();
    expect(h.sessions).toHaveLength(3);
  });
});
