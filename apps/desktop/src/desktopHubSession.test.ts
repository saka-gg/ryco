import { describe, expect, it, vi } from "vite-plus/test";

import { startDesktopHubSession } from "./desktopHubSession.ts";

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function fakeSocket() {
  const listeners = new Map<string, Array<(event: unknown) => void>>();
  return {
    binaryType: "nodebuffer",
    bufferedAmount: 0,
    readyState: 0,
    send: vi.fn(),
    close: vi.fn(),
    addEventListener: (type: string, listener: (event: never) => void) => {
      listeners.set(type, [...(listeners.get(type) ?? []), listener as (event: unknown) => void]);
    },
  };
}

describe("the Mac's account session socket", () => {
  it("opens on a Hub that announced it, signed for the session URL, offering the subprotocol", async () => {
    let features: ReadonlyArray<string> = [];
    const featureListeners = new Set<() => void>();
    const authorizeRelayUpgrade = vi.fn(async (url: string) => ({
      Authorization: "DPoP token",
      DPoP: `proof for ${url}`,
    }));
    const openSocket = vi.fn(() => fakeSocket() as never);
    const session = startDesktopHubSession({
      identity: {
        hubFeatures: () => features,
        subscribeHubFeatures: (listener) => {
          featureListeners.add(listener);
          return () => featureListeners.delete(listener);
        },
        hubSessionUrl: () => "wss://hub.example.test/v1/relay/session",
        authorizeRelayUpgrade,
      },
      authority: () => "account-1",
      isForeground: () => true,
      onDirectoryInvalidated: vi.fn(),
      revalidateSession: vi.fn(),
      openSocket,
    });
    await settle();
    // An older Hub announced nothing: no socket.
    expect(openSocket).not.toHaveBeenCalled();
    features = ["native-session-v1"];
    for (const listener of featureListeners) listener();
    await settle();
    expect(authorizeRelayUpgrade).toHaveBeenCalledWith("wss://hub.example.test/v1/relay/session");
    expect(openSocket).toHaveBeenCalledOnce();
    const [url, protocols, headers] = openSocket.mock.calls[0]! as unknown as [
      string,
      readonly string[],
      Record<string, string>,
    ];
    expect(url).toBe("wss://hub.example.test/v1/relay/session");
    expect(protocols.some((protocol) => protocol.startsWith("ryco.hub-session.v"))).toBe(true);
    expect(headers).toEqual({
      Authorization: "DPoP token",
      DPoP: "proof for wss://hub.example.test/v1/relay/session",
    });
    // Not online yet: machine channels open their own sockets meanwhile.
    expect(session.manager.streamFactory()).toBeUndefined();
    session.stop();
  });
});
