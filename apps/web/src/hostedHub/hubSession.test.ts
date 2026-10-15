import { hostedHubController, hostedHubStore } from "@ryco/client-runtime/authorization";
import type { HostedHubSessionOptions } from "@ryco/client-runtime/relay";
import * as HostedIdentity from "@ryco/contracts/hosted-identity";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  createWebHubRelaySocket,
  createWebHubServerAuthenticatedRelaySocket,
  isWebHubServerAuthenticatedRelayAvailable,
  isWebHubSessionOnline,
  subscribeWebHubInvalidation,
  watchWebHostedHubSession,
} from "./hubSession";

const created = vi.hoisted(
  () =>
    [] as Array<{
      options: HostedHubSessionOptions;
      start: ReturnType<typeof vi.fn>;
      dispose: ReturnType<typeof vi.fn>;
      createSocket: ReturnType<typeof vi.fn>;
      serverMintedOpenAvailable: ReturnType<typeof vi.fn>;
    }>,
);
vi.mock("@ryco/client-runtime/relay", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@ryco/client-runtime/relay")>()),
  HostedHubSession: class {
    start = vi.fn(() => this.options.onStatus?.("online"));
    dispose = vi.fn(() => this.options.onStatus?.("closed"));
    createSocket = vi.fn(() => ({}));
    serverMintedOpenAvailable = vi.fn(() => true);
    constructor(readonly options: HostedHubSessionOptions) {
      created.push(this);
    }
  },
}));

const account = {
  id: "account-a",
  displayName: "A",
  role: "owner" as const,
  createdAt: 1,
  disabledAt: null,
};
const session = {
  id: "session-a",
  accountId: account.id,
  createdAt: 1,
  expiresAt: 9999999999999,
  lastSeenAt: 1,
  revokedAt: null,
  revocationReasonCode: null,
};
let stop: (() => void) | undefined;
beforeEach(() => {
  created.length = 0;
  hostedHubStore.setState(hostedHubStore.getInitialState(), true);
  vi.spyOn(hostedHubController, "notifyDirectoryInvalidated").mockImplementation(() => undefined);
});
afterEach(() => {
  stop?.();
  stop = undefined;
  hostedHubStore.setState(hostedHubStore.getInitialState(), true);
  vi.restoreAllMocks();
});
function authenticate() {
  hostedHubStore.setState({ accountStatus: "authenticated", account, session });
}

describe("browser Hub connection ownership", () => {
  it("opens before selecting a node and retains the physical session across navigation", () => {
    stop = watchWebHostedHubSession();
    expect(created).toHaveLength(0);
    authenticate();
    expect(created).toHaveLength(1);
    expect(created[0]!.start).toHaveBeenCalledOnce();
    expect(isWebHubSessionOnline()).toBe(true);
    hostedHubStore.setState({ generation: 10, browserStatus: "synchronizing" });
    createWebHubRelaySocket();
    hostedHubStore.setState({ generation: 11, transportStatus: "connecting" });
    createWebHubRelaySocket();
    expect(created).toHaveLength(1);
    expect(created[0]!.createSocket).toHaveBeenCalledTimes(2);
    expect(created[0]!.dispose).not.toHaveBeenCalled();
  });

  it("closes on sign-out and prevents stale callbacks from reaching a later account", () => {
    authenticate();
    stop = watchWebHostedHubSession();
    const old = created[0]!;
    hostedHubStore.setState({ accountStatus: "signed-out", account: null, session: null });
    expect(old.dispose).toHaveBeenCalledOnce();
    expect(isWebHubSessionOnline()).toBe(false);
    expect(() => createWebHubRelaySocket()).toThrow("authenticated");
    authenticate();
    const listener = vi.fn();
    const unsubscribe = subscribeWebHubInvalidation(listener);
    old.options.onInvalidate?.({ directory: true, threadCache: true });
    old.options.onStatus?.("closed");
    expect(listener).not.toHaveBeenCalled();
    expect(hostedHubController.notifyDirectoryInvalidated).not.toHaveBeenCalled();
    expect(isWebHubSessionOnline()).toBe(true);
    created[1]!.options.onInvalidate?.({ directory: true, threadCache: true });
    expect(listener).toHaveBeenCalledOnce();
    expect(hostedHubController.notifyDirectoryInvalidated).toHaveBeenCalledOnce();
    unsubscribe();
  });

  it("rotates on credential identity changes, not ordinary state or access refresh", () => {
    authenticate();
    stop = watchWebHostedHubSession();
    hostedHubStore.setState({ accountStatus: "unavailable" });
    authenticate();
    expect(created).toHaveLength(1);
    hostedHubStore.setState({ session: { ...session, id: "session-b" } });
    expect(created[0]!.dispose).toHaveBeenCalledOnce();
    expect(created).toHaveLength(2);
  });

  it("expires rejected authentication through the credential-clearing owner", () => {
    const expire = vi.spyOn(hostedHubController, "expireSession").mockResolvedValue();
    authenticate();
    stop = watchWebHostedHubSession();
    created[0]!.options.onFailure?.({ kind: "authentication", retryable: false });
    expect(expire).toHaveBeenCalledOnce();
  });

  it("rotates the subscription on a same-session Space change and fences old invalidations", () => {
    authenticate();
    stop = watchWebHostedHubSession();
    const old = created[0]!;
    hostedHubStore.setState({
      session: {
        ...session,
        activeSpaceId: HostedIdentity.HubSpaceId.make("space_aaaaaaaaaaaaaaaaaaaaaa"),
      },
    });
    expect(old.dispose).toHaveBeenCalledOnce();
    expect(created).toHaveLength(2);
    old.options.onInvalidate?.({ directory: true, threadCache: true });
    expect(hostedHubController.notifyDirectoryInvalidated).not.toHaveBeenCalled();
    expect(isWebHubSessionOnline()).toBe(true);
  });

  it("publishes terminal protocol failure without granting or expiring account authority", () => {
    const failure = vi.spyOn(hostedHubController, "failure").mockImplementation(() => undefined);
    const expire = vi.spyOn(hostedHubController, "expireSession").mockResolvedValue();
    authenticate();
    stop = watchWebHostedHubSession();
    created[0]!.options.onFailure?.({ kind: "protocol", retryable: false });
    expect(failure).toHaveBeenCalledExactlyOnceWith(hostedHubStore.getState().generation, {
      kind: "protocol",
      retryable: false,
    });
    expect(expire).not.toHaveBeenCalled();
  });

  it("disposes account watching and physical connection together", () => {
    authenticate();
    stop = watchWebHostedHubSession();
    stop();
    stop = undefined;
    expect(created[0]!.dispose).toHaveBeenCalledOnce();
    authenticate();
    expect(created).toHaveLength(1);
    expect(isWebHubSessionOnline()).toBe(false);
  });

  it("offers server-authenticated channels only from an authenticated version 2 session", () => {
    stop = watchWebHostedHubSession();
    expect(isWebHubServerAuthenticatedRelayAvailable()).toBe(false);
    authenticate();
    expect(isWebHubServerAuthenticatedRelayAvailable()).toBe(true);
    created[0]!.serverMintedOpenAvailable.mockReturnValue(false);
    expect(isWebHubServerAuthenticatedRelayAvailable()).toBe(false);
    created[0]!.serverMintedOpenAvailable.mockReturnValue(true);
    hostedHubStore.setState({ accountStatus: "signed-out", account: null, session: null });
    expect(isWebHubServerAuthenticatedRelayAvailable()).toBe(false);
  });

  it("opens a server-minted stream for a valid node id and refuses anything else", () => {
    authenticate();
    stop = watchWebHostedHubSession();
    const nodeId = `node_${"a".repeat(22)}`;
    createWebHubServerAuthenticatedRelaySocket({ nodeId, protocolMinor: 3 });
    expect(created[0]!.createSocket).toHaveBeenCalledExactlyOnceWith({
      serverMinted: { nodeId, protocolMinor: 3 },
    });
    expect(() =>
      createWebHubServerAuthenticatedRelaySocket({ nodeId: "node_bad", protocolMinor: 3 }),
    ).toThrow("Invalid hosted node id");
    expect(created[0]!.createSocket).toHaveBeenCalledOnce();
  });

  it("offers the session's subprotocols on the browser socket", () => {
    const sockets: { url: string; protocols: unknown }[] = [];
    vi.stubGlobal(
      "WebSocket",
      class {
        binaryType = "blob";
        constructor(url: string, protocols?: unknown) {
          sockets.push({ url, protocols });
        }
        addEventListener() {}
      },
    );
    vi.stubGlobal("window", { location: { origin: "https://hub.example.test" } });
    try {
      authenticate();
      stop = watchWebHostedHubSession();
      created[0]!.options.createSocket(["ryco.hub-session.v2"]);
      expect(sockets).toEqual([
        { url: "wss://hub.example.test/v1/relay/session", protocols: ["ryco.hub-session.v2"] },
      ]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("binds server-minted streams to the restored identity and revalidates on a mismatch", () => {
    const resume = vi.spyOn(hostedHubController, "revalidateSession").mockResolvedValue();
    authenticate();
    stop = watchWebHostedHubSession();
    expect(created[0]!.options.expectedIdentity).toEqual({
      accountId: account.id,
      sessionId: session.id,
    });
    created[0]!.options.onIdentityMismatch?.();
    expect(resume).toHaveBeenCalledOnce();
    // A superseded session's late mismatch reaches nobody.
    hostedHubStore.setState({ session: { ...session, id: "session-b" } });
    created[0]!.options.onIdentityMismatch?.();
    expect(resume).toHaveBeenCalledOnce();
    expect(created[1]!.options.expectedIdentity?.sessionId).toBe("session-b");
  });
});
