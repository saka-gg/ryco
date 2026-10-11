import "../index.css";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";
import { DesktopAccountConnect } from "./DesktopAccountConnect";

const state = vi.hoisted(() => ({ status: "signed-out" }));
const launchConfig = (hostedIdentitySupported: boolean) =>
  vi.fn().mockResolvedValue({
    enabled: false,
    origin: "https://app.ryco.space",
    nodeName: null,
    allowFileSecretStore: false,
    fileSecretStoreFallbackSupported: true,
    hostedIdentitySupported,
  });
vi.mock("../platform/desktopWorkspace", () => ({ useDesktopWorkspaceState: () => state }));

let mounted: Awaited<ReturnType<typeof render>> | undefined;
const originalBridge = window.desktopBridge;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
  state.status = "signed-out";
  Object.defineProperty(window, "desktopBridge", { configurable: true, value: originalBridge });
});

describe("desktop account onboarding", () => {
  it("does not access credentials before the user chooses to connect", async () => {
    let resolve!: (state: { status: "unavailable" }) => void;
    const pending = new Promise<{ status: "unavailable" }>((finish) => {
      resolve = finish;
    });
    const connect = vi.fn(() => pending);
    Object.defineProperty(window, "desktopBridge", {
      configurable: true,
      value: { connectHostedIdentity: connect, getHubLaunchConfig: launchConfig(true) },
    });
    mounted = await render(<DesktopAccountConnect />);
    expect(connect).not.toHaveBeenCalled();
    await page.getByRole("button", { name: "Connect Ryco account", exact: true }).click();
    await expect.element(page.getByRole("button", { name: "Opening sign-in…" })).toBeDisabled();
    expect(connect).toHaveBeenCalledTimes(1);
    resolve({ status: "unavailable" });
    await expect
      .element(page.getByRole("status"))
      .toMatchTextContent("Account setup is temporarily unavailable");
    await expect
      .element(page.getByRole("button", { name: "Connect Ryco account", exact: true }))
      .toBeEnabled();
  });

  it("hides the sign-in prompt once the account is ready", async () => {
    state.status = "ready";
    const connect = vi.fn();
    Object.defineProperty(window, "desktopBridge", {
      configurable: true,
      value: { connectHostedIdentity: connect, getHubLaunchConfig: launchConfig(true) },
    });
    mounted = await render(<DesktopAccountConnect />);
    expect(document.querySelector("button")).toBeNull();
    expect(connect).not.toHaveBeenCalled();
  });

  it("hides the native sign-in prompt where account setup cannot run", async () => {
    const connect = vi.fn();
    const getHubLaunchConfig = launchConfig(false);
    Object.defineProperty(window, "desktopBridge", {
      configurable: true,
      value: { connectHostedIdentity: connect, getHubLaunchConfig },
    });
    mounted = await render(<DesktopAccountConnect />);
    await vi.waitFor(() => expect(getHubLaunchConfig).toHaveBeenCalledOnce());
    expect(document.querySelector("button")).toBeNull();
    expect(connect).not.toHaveBeenCalled();
  });
});
