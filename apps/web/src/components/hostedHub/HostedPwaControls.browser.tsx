import "../../index.css";

import { page } from "vite-plus/test/browser";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

import type { HostedPwaLifecycle, HostedPwaSnapshot } from "../../pwa/lifecycle";
import {
  applyWebE2eeChannelStatus,
  RETIRED_HOSTED_RELAY_TRUST_SENTENCE,
} from "../../../test/hostedConnectionVocabulary";
import { resetWebE2eeSession } from "../../hostedHub/e2eeSession";
import { HostedPwaControls } from "./HostedPwaControls";
import { hostedRelayTrustDisclosure } from "./HostedRelayTrustNotice.logic";

function lifecycle(snapshot: HostedPwaSnapshot): HostedPwaLifecycle {
  return {
    activateUpdate: vi.fn(),
    dismissInstall: vi.fn(),
    getSnapshot: () => snapshot,
    promptInstall: vi.fn(async () => undefined),
    reloadApp: vi.fn(),
    start: vi.fn(async () => undefined),
    stop: vi.fn(),
    subscribe: () => () => undefined,
  };
}

const baseSnapshot: HostedPwaSnapshot = {
  errorMessage: null,
  installState: "manual-available",
  platform: "ios",
  registrationState: "ready",
  updateState: "idle",
};

describe("HostedPwaControls", () => {
  afterEach(() => {
    resetWebE2eeSession();
  });

  it("shows iOS installation steps and the relay trust boundary", async () => {
    resetWebE2eeSession();
    render(<HostedPwaControls lifecycle={lifecycle(baseSnapshot)} />);
    await page.getByRole("button", { name: "How to install" }).click();

    await expect.element(page.getByText(/Add to Home Screen/)).toBeVisible();
    await expect
      .element(page.getByText(hostedRelayTrustDisclosure("unavailable").body))
      .toBeVisible();
    expect(document.body.textContent).not.toContain(RETIRED_HOSTED_RELAY_TRUST_SENTENCE);
    await page.getByRole("button", { name: "Close install instructions" }).click();
    await expect.element(page.getByText(/Add to Home Screen/)).not.toBeInTheDocument();
  });

  it("re-states the disclosure at the claim the live channel earns", async () => {
    // The fifth mount site, and the one furthest from the connection surfaces —
    // it is inside the install instructions. `docs/relay-e2ee-protocol.md`
    // §12.2's duty is on EVERY user-facing surface, so this one tracks the
    // channel like the other four rather than holding a constant.
    render(<HostedPwaControls lifecycle={lifecycle(baseSnapshot)} />);
    await page.getByRole("button", { name: "How to install" }).click();

    for (const status of ["negotiating", "web-unsigned", "legacy"] as const) {
      applyWebE2eeChannelStatus(status);
      await expect.element(page.getByText(hostedRelayTrustDisclosure(status).body)).toBeVisible();
      expect(document.body.textContent, status).not.toContain(RETIRED_HOSTED_RELAY_TRUST_SENTENCE);
    }
  });

  it("invokes the browser-owned native prompt", async () => {
    const native = lifecycle({
      ...baseSnapshot,
      installState: "native-available",
      platform: "other",
    });
    render(<HostedPwaControls lifecycle={native} />);

    await page.getByRole("button", { name: "Install Ryco" }).click();
    expect(native.promptInstall).toHaveBeenCalledOnce();
  });

  it("hides install guidance in standalone mode", async () => {
    render(
      <HostedPwaControls lifecycle={lifecycle({ ...baseSnapshot, installState: "installed" })} />,
    );
    await expect
      .element(page.getByRole("region", { name: "Ryco app installation" }))
      .not.toBeInTheDocument();
  });

  it("activates a waiting update only from the explicit action", async () => {
    const update = lifecycle({ ...baseSnapshot, installState: "installed", updateState: "ready" });
    render(<HostedPwaControls lifecycle={update} />);

    expect(update.activateUpdate).not.toHaveBeenCalled();
    await page.getByRole("button", { name: "Update ready" }).click();
    expect(update.activateUpdate).toHaveBeenCalledOnce();
  });
});
