import "../../index.css";

import { page } from "vite-plus/test/browser";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { render } from "vitest-browser-react";

import {
  applyWebE2eeChannelStatus,
  RETIRED_HOSTED_RELAY_TRUST_SENTENCE,
} from "../../../test/hostedConnectionVocabulary";
import { resetWebE2eeSession } from "../../hostedHub/e2eeSession";
import { HostedRelayTrustNotice } from "./HostedRelayTrustNotice";
import { hostedRelayTrustDisclosure } from "./HostedRelayTrustNotice.logic";

describe("HostedRelayTrustNotice disclosure variant", () => {
  afterEach(() => {
    resetWebE2eeSession();
  });

  it("folds the claim behind a neutral row and expands to the unabridged body", async () => {
    resetWebE2eeSession();
    const screen = await render(<HostedRelayTrustNotice variant="disclosure" />);

    const toggle = page.getByRole("button", { name: "How this connection works" });
    await expect.element(toggle).toHaveAttribute("aria-expanded", "false");
    // Folded, nothing of the claim is on the page — and in particular no
    // shortened version of it standing in for the whole.
    expect(screen.container.textContent).toBe("How this connection works");

    await toggle.click();
    await expect.element(toggle).toHaveAttribute("aria-expanded", "true");
    const region = page.getByRole("region", { name: "How this connection works" });
    await expect.element(region).toBeVisible();
    await expect
      .element(page.getByText(hostedRelayTrustDisclosure("unavailable").body))
      .toBeVisible();
    await expect.element(page.getByText(/Cloud history keeps a readable copy/)).toBeVisible();

    await toggle.click();
    await expect.element(region).not.toBeInTheDocument();
  });

  it("tracks the live channel while expanded, tone included", async () => {
    await render(<HostedRelayTrustNotice variant="disclosure" />);
    await page.getByRole("button", { name: "How this connection works" }).click();

    for (const status of ["negotiating", "web-unsigned", "legacy"] as const) {
      applyWebE2eeChannelStatus(status);
      const { body, tone } = hostedRelayTrustDisclosure(status);
      await expect.element(page.getByText(body)).toBeVisible();
      const notice = document.querySelector<HTMLElement>("[data-hosted-relay-trust-notice]");
      expect(notice?.dataset.e2eeStatus, status).toBe(status);
      expect(notice?.dataset.tone, status).toBe(tone);
      expect(document.body.textContent, status).not.toContain(RETIRED_HOSTED_RELAY_TRUST_SENTENCE);
    }
  });
});
