import "../index.css";

import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";

// Rendered outside a `RouterProvider`: the header's back button navigates.
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => vi.fn(async () => undefined),
}));
// The desktop app: only it shows the account prompt.
vi.mock("../env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../env")>()),
  isElectron: true,
}));

import { NoActiveThreadState } from "./NoActiveThreadState";
import { SidebarProvider } from "./ui/sidebar";

const launchConfig = (hostedIdentitySupported: boolean) =>
  vi.fn().mockResolvedValue({
    enabled: false,
    origin: "https://app.ryco.space",
    nodeName: null,
    allowFileSecretStore: false,
    fileSecretStoreFallbackSupported: true,
    hostedIdentitySupported,
  });

let mounted: Awaited<ReturnType<typeof render>> | undefined;
const originalBridge = window.desktopBridge;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
  Object.defineProperty(window, "desktopBridge", { configurable: true, value: originalBridge });
});

async function renderEmptyState() {
  mounted = await render(
    <SidebarProvider>
      <NoActiveThreadState />
    </SidebarProvider>,
  );
  await expect.element(page.getByText("Pick a thread to continue")).toBeVisible();
}

describe("NoActiveThreadState", () => {
  it("shows the desktop account prompt once its code and the bridge's answer arrive", async () => {
    const getHubLaunchConfig = launchConfig(true);
    Object.defineProperty(window, "desktopBridge", {
      configurable: true,
      value: { connectHostedIdentity: vi.fn(), getHubLaunchConfig },
    });

    await renderEmptyState();

    await expect
      .element(page.getByRole("button", { name: "Connect Ryco account", exact: true }))
      .toBeVisible();
    await expect.element(page.getByRole("button", { name: "Connection settings" })).toBeVisible();
    expect(getHubLaunchConfig).toHaveBeenCalledOnce();
  });

  it("keeps the prompt hidden where native account setup cannot run", async () => {
    const getHubLaunchConfig = launchConfig(false);
    Object.defineProperty(window, "desktopBridge", {
      configurable: true,
      value: { connectHostedIdentity: vi.fn(), getHubLaunchConfig },
    });

    await renderEmptyState();

    await vi.waitFor(() => expect(getHubLaunchConfig).toHaveBeenCalledOnce());
    expect(document.body.textContent).not.toContain("Connect Ryco account");
  });
});
