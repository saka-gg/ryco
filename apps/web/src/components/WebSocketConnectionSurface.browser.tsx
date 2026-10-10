import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";
import { EnvironmentId } from "@ryco/contracts";
import {
  getWsConnectionStatus,
  recordWsConnectionAttempt,
  recordWsConnectionClosed,
  recordWsConnectionOpened,
  resetWsConnectionStateForTests,
  setBrowserOnlineStatus,
} from "@ryco/client-runtime/rpc";
import { AppAtomRegistryProvider } from "../rpc/atomRegistry";
import { WebSocketConnectionCoordinator } from "./WebSocketConnectionSurface";

const harness = vi.hoisted(() => ({ reconnect: vi.fn(async () => undefined), toast: vi.fn() }));
vi.mock("../rpc/wsConnectionState", async () => {
  const runtime = await import("@ryco/client-runtime/rpc");
  const { useAtomValue } = await import("@effect/atom-react");
  return { ...runtime, useWsConnectionStatus: () => useAtomValue(runtime.wsConnectionStatusAtom) };
});
vi.mock("../environments/runtime", () => ({
  getPrimaryEnvironmentConnection: () => ({ reconnect: harness.reconnect }),
}));
vi.mock("./ui/toast", () => ({
  toastManager: { add: harness.toast, update: harness.toast, close: vi.fn() },
  stackedThreadToast: (value: unknown) => value,
}));

afterEach(() => {
  resetWsConnectionStateForTests();
  vi.clearAllMocks();
});

describe("silent connection recovery", () => {
  it("retains workspace content and never publishes outage, retry or recovery toasts", async () => {
    recordWsConnectionOpened();
    const screen = await render(
      <AppAtomRegistryProvider>
        <WebSocketConnectionCoordinator recoveryOwner="hosted-lifecycle" />
        <textarea aria-label="Draft" defaultValue="Keep this unfinished message" />
      </AppAtomRegistryProvider>,
    );
    const draft = screen.getByRole("textbox", { name: "Draft" });
    for (let attempt = 0; attempt < 12; attempt += 1) {
      recordWsConnectionClosed({ code: 1006, reason: "Network lost" });
      setBrowserOnlineStatus(false);
      await expect.element(draft).toHaveValue("Keep this unfinished message");
      setBrowserOnlineStatus(true);
      recordWsConnectionAttempt("ws://test.invalid");
      window.dispatchEvent(new Event("online"));
      window.dispatchEvent(new Event("focus"));
      recordWsConnectionOpened();
      await expect.element(draft).toHaveValue("Keep this unfinished message");
    }
    expect(harness.toast).not.toHaveBeenCalled();
    expect(harness.reconnect).not.toHaveBeenCalled();
  });

  it("does not restart a healthy primary when a remote workspace disconnects", async () => {
    recordWsConnectionOpened({ connectionLabel: "Local" });
    await render(
      <AppAtomRegistryProvider>
        <WebSocketConnectionCoordinator />
      </AppAtomRegistryProvider>,
    );
    const metadata = {
      environmentId: EnvironmentId.make("remote"),
      recordGlobal: false,
    };
    recordWsConnectionOpened(metadata);
    recordWsConnectionClosed({ code: 1006 }, metadata);
    window.dispatchEvent(new Event("focus"));
    window.dispatchEvent(new Event("online"));
    expect(getWsConnectionStatus().phase).toBe("connected");
    expect(harness.reconnect).not.toHaveBeenCalled();
    expect(harness.toast).not.toHaveBeenCalled();
  });
});
