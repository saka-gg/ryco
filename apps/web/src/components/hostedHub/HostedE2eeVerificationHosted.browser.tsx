// docs/relay-e2ee-protocol.md §13.5's session code in HOSTED mode, where the
// section its pointer names is not everyone's to open.
//
// THE FILE EXISTS BECAUSE THE MODE IS READ AT MODULE SCOPE. `isHostedHubMode()`
// answers a build-time flag, so a suite cannot hold both answers at once and the
// hoisted `vi.mock` below applies to the whole file — the same reason
// `NodeSecuritySettingsHosted.browser.tsx` is its own file. The sibling
// `HostedE2eeVerification.browser.tsx` runs as the standard client, where there
// is no hosted role gate and the short form is always correct.
//
// What is pinned here: the short form's second sentence is a promise about the
// reader's OWN settings dialog — "Settings → Devices → this node → Security explains
// what else this tab cannot check" — and a node's Security in Settings is owner-only in hosted mode
// (`settingsSections.logic.ts`), while this component draws for whoever holds a
// locked `web-unsigned` channel. A viewer, an operator, or an owner whose role
// snapshot has gone stale must therefore never be sent there, and must not lose
// §2.2's no-pin reason — which only the long form states — in the process.
import "../../index.css";

import { E2EE_WEB_SAS_CHARS } from "@ryco/shared/relayE2eeConstants";
import { page } from "vite-plus/test/browser";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

// Hosted mode, which no browser test gets by default: there is no `.env` in this
// harness, so `isHostedHubMode()` answers false and every hosted gate runs as
// the standard client.
vi.mock("../../env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../env")>()),
  readRycoClientMode: () => "hosted-hub" as const,
  isHostedHubMode: () => true,
}));

import { applyWebE2eeVerificationCode } from "../../../test/hostedConnectionVocabulary";
import { resetWebE2eeSession } from "../../hostedHub/e2eeSession";
import { useHostedHubStore } from "../../hostedHub/state";
import {
  E2EE_WEB_SAS_ADVISORY,
  E2EE_WEB_SAS_COMPARE,
  E2EE_WEB_SAS_DETAIL,
  E2EE_WEB_SAS_MORE,
} from "./HostedE2eeVerification.logic";
import { HostedE2eeVerification } from "./HostedE2eeVerification";

/** A well-formed §13.5 rendering, built from the constants rather than typed. */
const CODE = ["3QRT", "9KZ0"].join(E2EE_WEB_SAS_CHARS.separator);

let mounted: Awaited<ReturnType<typeof render>> | null = null;

afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
  resetWebE2eeSession();
  useHostedHubStore.setState({
    effectiveRole: null,
    directoryStatus: "idle",
    transportStatus: "idle",
  });
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

/** The reader's hosted grant, as the settings navs read it. */
function seedRole(
  effectiveRole: "viewer" | "operator" | "owner" | null,
  { fresh = true }: { readonly fresh?: boolean } = {},
): void {
  useHostedHubStore.setState({
    effectiveRole,
    // "stale" and "reconnecting" are the reconnect window: the role value is
    // still there and is exactly the kind the gates must not act on.
    directoryStatus: fresh ? "ready" : "stale",
    transportStatus: fresh ? "online" : "reconnecting",
  });
}

const section = () =>
  document.querySelector<HTMLElement>('[data-testid="hosted-e2ee-verification"]');

async function drawn(): Promise<HTMLElement> {
  return await vi.waitFor(() => {
    const found = section();
    expect(found, "the session code did not render").not.toBeNull();
    return found!;
  });
}

describe("§13.5 the code is drawn for every hosted role", () => {
  it("gives an owner the code and no disclosure prose", async () => {
    await page.viewport(1_280, 720);
    seedRole("owner");
    applyWebE2eeVerificationCode(CODE);
    mounted = await render(<HostedE2eeVerification />);

    const block = await drawn();
    expect(block.getAttribute("data-form")).toBe("inline");
    expect(block.textContent).toContain(CODE);
    expect(block.textContent).not.toContain(E2EE_WEB_SAS_ADVISORY);
    expect(block.textContent).not.toContain(E2EE_WEB_SAS_MORE);
    // The long account belongs to the page the pointer leads to; drawing it here
    // as well would restore the block of prose this length exists to remove.
    expect(document.body.textContent).not.toContain(E2EE_WEB_SAS_DETAIL);
  });

  it.each([["viewer"], ["operator"]] as const)(
    "never points a %s at a section their settings list does not have",
    async (role) => {
      await page.viewport(1_280, 720);
      seedRole(role);
      applyWebE2eeVerificationCode(CODE);
      mounted = await render(<HostedE2eeVerification />);

      const block = await drawn();
      // The menu never grows disclosure prose for a different role.
      expect(block.getAttribute("data-form")).toBe("settings");
      expect(document.body.textContent).not.toContain(E2EE_WEB_SAS_MORE);
      expect(document.body.textContent).not.toContain("Settings → Devices");
      expect(block.textContent).toContain(CODE);
      expect(block.textContent).not.toContain(E2EE_WEB_SAS_DETAIL);
      expect(block.textContent).not.toContain(E2EE_WEB_SAS_COMPARE);
      expect(block.textContent).not.toContain("pins no node identity");
    },
  );

  it("treats an owner whose role snapshot is stale the same way", async () => {
    // The settings navs fail closed while the directory or the transport is not
    // current, which is exactly the reconnect window in which an owner is most
    // likely to be inspecting the channel. The pointer has to fail closed with
    // them, or it names a section that is missing from the dialog it opens.
    await page.viewport(1_280, 720);
    seedRole("owner", { fresh: false });
    applyWebE2eeVerificationCode(CODE);
    mounted = await render(<HostedE2eeVerification />);

    const block = await drawn();
    expect(block.getAttribute("data-form")).toBe("settings");
    expect(document.body.textContent).not.toContain(E2EE_WEB_SAS_MORE);
    expect(block.textContent).not.toContain(E2EE_WEB_SAS_DETAIL);
  });
});
