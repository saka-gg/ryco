import { readFileSync } from "node:fs";

import { hostedHubStore } from "@ryco/client-runtime/authorization";
import { relayE2eeUnresolvedAttemptFailure, type RelayE2eeHost } from "@ryco/client-runtime/relay";
import { parseSync } from "vite-plus";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const { warmE2eePrimitives } = vi.hoisted(() => ({ warmE2eePrimitives: vi.fn() }));
vi.mock("@ryco/shared/relayE2eeKeys", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@ryco/shared/relayE2eeKeys")>()),
  warmE2eePrimitives,
}));

import {
  isWebRelayE2eeLoadedForTests,
  loadWebRelayE2ee,
  prepareWebRelayE2ee,
  resetWebRelayE2eeForTests,
  resolveWebRelayE2eeProvider,
  watchWebHostedSessionForE2ee,
} from "./e2eeAttempt";

const account = {
  id: "acct_aaaaaaaaaaaaaaaaaaaaaa",
  displayName: "Ada",
  role: "owner" as const,
  createdAt: 1,
  disabledAt: null,
};

const originalIsSecureContext = Object.getOwnPropertyDescriptor(globalThis, "isSecureContext");
const originalWindow = globalThis.window;

function setSecureContext(value: boolean): void {
  Object.defineProperty(globalThis, "isSecureContext", { configurable: true, value });
  // The §14.5 check runs at startup; re-run it under the context set here.
  resetWebRelayE2eeForTests();
}

// The handshake code is module state that, once loaded, stays loaded for the
// file; these cases run in order and the first ones assert it is not loaded.
describe("web relay E2EE code loading and warm-up", () => {
  afterEach(() => {
    if (originalIsSecureContext) {
      Object.defineProperty(globalThis, "isSecureContext", originalIsSecureContext);
    } else {
      Reflect.deleteProperty(globalThis, "isSecureContext");
    }
    Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
    resetWebRelayE2eeForTests();
    hostedHubStore.setState(hostedHubStore.getInitialState(), true);
    warmE2eePrimitives.mockClear();
    vi.useRealTimers();
  });

  it("neither loads nor warms the handshake where the startup check refused E2EE", async () => {
    vi.useFakeTimers();
    setSecureContext(false);
    watchWebHostedSessionForE2ee();
    hostedHubStore.setState({ accountStatus: "authenticated", account });
    await expect(prepareWebRelayE2ee()).resolves.toBeUndefined();
    await vi.runAllTimersAsync();
    expect(isWebRelayE2eeLoadedForTests()).toBe(false);
    expect(warmE2eePrimitives).not.toHaveBeenCalled();
  });

  it("closes a channel it cannot negotiate yet, retryably and without plaintext", async () => {
    setSecureContext(true);
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { location: { origin: "https://hub.example.test" } },
    });
    hostedHubStore.setState({
      accountStatus: "authenticated",
      account,
      selectedNode: { id: "node_aaaaaaaaaaaaaaaaaaaaaa" } as never,
    });
    expect(isWebRelayE2eeLoadedForTests()).toBe(false);

    const provider = resolveWebRelayE2eeProvider();
    expect(provider).toBeTypeOf("function");
    const close = vi.fn();
    const channel = provider!({ close } as unknown as RelayE2eeHost);
    expect(close).toHaveBeenCalledWith(relayE2eeUnresolvedAttemptFailure());
    expect(channel.submit(new Uint8Array(1) as never)).toBe(false);
    // The retry that close asks for finds the code loaded.
    await loadWebRelayE2ee();
    expect(isWebRelayE2eeLoadedForTests()).toBe(true);
  });

  it("warms the handshake primitives off the critical path once an account authenticates", async () => {
    vi.useFakeTimers();
    setSecureContext(true);
    hostedHubStore.setState({ accountStatus: "signed-out" });
    watchWebHostedSessionForE2ee();
    await vi.runAllTimersAsync();
    expect(warmE2eePrimitives).not.toHaveBeenCalled();

    hostedHubStore.setState({ accountStatus: "authenticated", account });
    // Deferred to an idle period (or the next task), never run inside the patch.
    expect(warmE2eePrimitives).not.toHaveBeenCalled();
    await prepareWebRelayE2ee();
    await vi.runAllTimersAsync();
    expect(warmE2eePrimitives).toHaveBeenCalledOnce();

    // Later patches of an authenticated account schedule nothing more.
    hostedHubStore.setState({ directoryStatus: "ready" });
    await vi.runAllTimersAsync();
    expect(warmE2eePrimitives).toHaveBeenCalledOnce();
  });
});

describe("web relay E2EE code placement", () => {
  it("reaches the handshake code only through the lazy load, never a static import", () => {
    const file = new URL("./e2eeAttempt.ts", import.meta.url);
    const { module } = parseSync("e2eeAttempt.ts", readFileSync(file, "utf8"));
    const valueImports = module.staticImports.flatMap((declaration) =>
      declaration.entries
        .filter((entry) => !entry.isType)
        .map((entry) => `${declaration.moduleRequest.value} ${entry.localName.value}`),
    );
    // The initiator, the curves behind it, and the warm-up are what the
    // hosted boot path must not carry.
    expect(
      valueImports.filter((entry) =>
        /(?:relay\/e2ee|relayE2eeKeys|relayE2eeInitiator|@noble\/)|makeRelayE2eeInitiator|warmE2eePrimitives/u.test(
          entry,
        ),
      ),
    ).toEqual([]);
    expect(module.dynamicImports.length).toBeGreaterThan(0);
  });
});
