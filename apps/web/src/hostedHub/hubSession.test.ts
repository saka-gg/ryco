import { hostedHubController, hostedHubStore } from "@ryco/client-runtime/authorization";
import type { HostedHubSessionOptions } from "@ryco/client-runtime/relay";
import * as HostedIdentity from "@ryco/contracts/hosted-identity";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  createWebHubRelaySocket,
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
    }>,
);
vi.mock("@ryco/client-runtime/relay", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@ryco/client-runtime/relay")>()),
  HostedHubSession: class {
    start = vi.fn(() => this.options.onStatus?.("online"));
    dispose = vi.fn(() => this.options.onStatus?.("closed"));
    createSocket = vi.fn(() => ({}));
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
});
