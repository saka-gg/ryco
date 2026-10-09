// Production CSS is part of the behavior under test: header layout and the
// phone tier variants drive the collision and pill assertions.
import "../../index.css";

import { EnvironmentId, type ResolvedKeybindingsConfig } from "@ryco/contracts";
import { page, userEvent } from "vite-plus/test/browser";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

const navigate = vi.fn(async () => undefined);
// These suites render the hosted root outside a `RouterProvider`. The toast
// host the entry surfaces now mount reads route params to scope thread-scoped
// toasts, which is neither what these suites exercise nor reachable here, so
// the read is stubbed alongside the navigation that was already stubbed.
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => navigate,
  useParams: () => undefined,
}));

// Deliberately NOT mocked into hosted mode, unlike the other hosted browser
// suites. The desktop menu, the phone sheet and the pill all gate on
// `selectedNode` rather than on the mode; the one thing under this file that
// reads `isHostedHubMode()` is §13.5's session code, choosing which length to
// draw, and the standard-client answer is the one that needs no role at all —
// `HostedE2eeVerificationHosted.browser.tsx` is where the hosted role gate is
// pinned. Meanwhile the
// header layout test mounts `ChatHeader` inside a `SidebarProvider`, and in
// hosted mode that composition reaches
// `createPrimaryEnvironmentClient` -> `HostedRelayAttemptFactory.nextUrl()`,
// which finds no relay session in this harness and answers `expireSession()` ->
// `clearAccount()`. The seeded `selectedNode` is gone before the first
// assertion, and every control under test unmounts with it. Verified by
// execution. Flipping the mode here would buy no coverage and cost the suite.

import {
  resetPrimaryEnvironmentDescriptorForTests,
  writePrimaryEnvironmentDescriptor,
} from "../../environments/primary";
import { resetPointerEmulation, setCoarsePointerEmulation } from "../../../test/browserPointer";
import {
  deriveHostedConnectionStatusIndicator,
  deriveHostedConnectionStatusText,
  HOSTED_CONNECTION_STATUS_INDICATORS,
} from "../../hostedHub/connectionStatus";
import {
  applyWebE2eeChannelStatus,
  applyWebE2eeVerificationCode,
  hostedConnectionConnectedByGateOrder,
  hostedConnectionGuaranteeByGateOrder,
  hostedConnectionStatusRepresentatives,
  RETIRED_HOSTED_RELAY_TRUST_SENTENCE,
  WEB_HOSTED_E2EE_CHANNEL_STATUSES,
} from "../../../test/hostedConnectionVocabulary";
import { hostedConnectionStatusPresentation } from "./HostedConnectionControls.logic";
import { E2EE_WEB_SAS_DETAIL } from "./HostedE2eeVerification.logic";
import { resetWebE2eeSession } from "../../hostedHub/e2eeSession";
import { hostedHubController, useHostedHubStore } from "../../hostedHub/state";
import { resetHubRoutesForTests } from "../../hostedHub/hubRoutes";
import { useSettingsDialogStore } from "../../settingsDialogStore";
import type { HostedHubNode } from "../../hostedHub/types";
import { syncDocumentPresentationTier } from "../../lib/presentationTier";
import {
  applyAppearancePreferencesToDocument,
  resetAppearancePreference,
  setAppearancePreference,
} from "../../themes/appearancePreferences";
import { SidebarProvider } from "../ui/sidebar";
import { ChatHeader } from "../chat/ChatHeader";
import {
  HostedConnectionPill,
  HostedConnectionSheet,
  HostedNodeMenu,
} from "./HostedConnectionControls";

const account = {
  id: "acct_aaaaaaaaaaaaaaaaaaaaaa",
  displayName: "Ada",
  role: "owner" as const,
  createdAt: 1,
  disabledAt: null,
};
const session = {
  id: "sess_aaaaaaaaaaaaaaaaaaaaaa",
  accountId: account.id,
  createdAt: 1,
  expiresAt: 2,
  lastSeenAt: 1,
  revokedAt: null,
  revocationReasonCode: null,
};

function node(id: string, label: string, online = true): HostedHubNode {
  return {
    id,
    environmentId: EnvironmentId.make(`env_${id.slice(5).padEnd(22, "a").slice(0, 22)}`),
    label,
    platformOs: "linux",
    platformArch: "x64",
    clientVersion: "0.9.0",
    createdAt: 1,
    updatedAt: 1,
    lastAuthenticatedAt: 1,
    revokedAt: null,
    revocationReasonCode: null,
    grant: { id: `grant_${id.slice(5)}`, role: "operator" },
    effectiveRole: "operator",
    presence: { online, lastHeartbeatAt: online ? 1 : null },
  };
}

const selectedNode = node("node_aaaaaaaaaaaaaaaaaaaaaa", "Studio node");
const otherNode = node("node_bbbbbbbbbbbbbbbbbbbbbb", "Second node");

/** A well-formed §13.5 rendering (`E2EE_WEB_SAS_CHARS`: 8 Crockford, 4-4). */
const MENU_WEB_SAS = "5TCV-8M2N";

function seedConnectedState() {
  useHostedHubStore.setState({
    accountStatus: "authenticated",
    account,
    session,
    directoryStatus: "ready",
    browserStatus: "current",
    nodes: [selectedNode, otherNode],
    selectedNode,
    selectionStatus: "online",
    effectiveRole: "operator",
    transportStatus: "online",
    sessionStatus: "ready",
    sessionEstablished: true,
  });
}

/**
 * Walks outward from a point until the hit test stops resolving to the
 * control. `getBoundingClientRect` cannot see an `::after` hit slop, so only
 * this proves the effective target — see `ui/toggle.browser.tsx`.
 */
function hitReach(
  element: HTMLElement,
  fromX: number,
  fromY: number,
  stepX: number,
  stepY: number,
  limit = 200,
): number {
  for (let distance = 1; distance <= limit; distance += 1) {
    const target = document.elementFromPoint(fromX + stepX * distance, fromY + stepY * distance);
    if (!target || (target !== element && !element.contains(target))) {
      return distance - 1;
    }
  }
  return limit;
}

function rectsIntersect(a: DOMRect, b: DOMRect): boolean {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

/** The alpha channel of a computed colour, in whichever syntax it serialises. */
function computedAlpha(color: string): number {
  const numbers = color.match(/[\d.]+/gu)?.map(Number) ?? [];
  return numbers.length === 4 ? numbers[3]! : 1;
}

let mounted: Awaited<ReturnType<typeof render>> | null = null;

describe("hosted connection controls", () => {
  beforeAll(() => {
    syncDocumentPresentationTier();
  });

  beforeEach(() => {
    localStorage.clear();
    hostedHubController.resetForTests();
    resetHubRoutesForTests();
    useSettingsDialogStore.setState({ open: false, section: "general" });
    navigate.mockClear();
  });

  afterEach(async () => {
    await mounted?.unmount();
    mounted = null;
    hostedHubController.resetForTests();
    resetHubRoutesForTests();
    useSettingsDialogStore.setState({ open: false, section: "general" });
    resetPrimaryEnvironmentDescriptorForTests();
    // The §13 projection is module state, not store state, so
    // `resetForTests()` does not reach it and a channel left locked would
    // rename every later case's status.
    resetWebE2eeSession();
    vi.restoreAllMocks();
    document.body.innerHTML = "";
    await page.viewport(1_280, 720);
  });

  it("renders inside the workspace header without a fixed overlay or control overlap at supported widths", async () => {
    seedConnectedState();
    writePrimaryEnvironmentDescriptor({
      environmentId: selectedNode.environmentId,
      label: selectedNode.label,
      platform: { os: "linux", arch: "x64" },
      serverVersion: "0.9.0",
      capabilities: {
        repositoryIdentity: false,
        threadSettlement: false,
        threadPriorityRanking: false,
      },
    });

    mounted = await render(
      <SidebarProvider>
        <header className="w-full border-b border-border px-5">
          <ChatHeader
            activeThreadEnvironmentId={selectedNode.environmentId}
            activeThreadTitle="Phone shell implementation"
            activeProjectName="Ryco"
            isGitRepo
            openInCwd="/repo/project"
            activeProjectScripts={[
              {
                id: "build",
                name: "Build",
                command: "bun run build",
                icon: "build",
                runOnWorktreeCreate: false,
              },
            ]}
            preferredScriptId={null}
            keybindings={{} as ResolvedKeybindingsConfig}
            availableEditors={["vscode"]}
            worktreeBranch="feat/phone-shell"
            worktreeTitle="Phone shell"
            worktreeOrigin="manual"
            workspacePanelOpen={false}
            liveAgentCount={0}
            onToggleWorkspacePanel={vi.fn()}
            overviewSidebarOpen={false}
            onToggleOverviewSidebar={vi.fn()}
            onRunProjectScript={vi.fn()}
            onAddProjectScript={vi.fn()}
            onUpdateProjectScript={vi.fn()}
            onDeleteProjectScript={vi.fn()}
          />
        </header>
      </SidebarProvider>,
    );

    for (const [width, height] of [
      [1_280, 720],
      [1_024, 720],
      [820, 720],
    ] as const) {
      await page.viewport(width, height);
      const summary = document.querySelector<HTMLElement>("details > summary");
      expect(summary, `connection control missing at ${width}px`).not.toBeNull();

      // The legacy fixed overlay is gone: no positioned ancestor of the
      // connection control is fixed, and it lives inside the header flow.
      let ancestor: HTMLElement | null = summary;
      while (ancestor) {
        expect(getComputedStyle(ancestor).position).not.toBe("fixed");
        ancestor = ancestor.parentElement;
      }
      expect(summary!.closest("header")).not.toBeNull();

      const summaryRect = summary!.getBoundingClientRect();
      expect(summaryRect.width).toBeGreaterThan(0);
      const otherControls = [
        document.querySelector('button[aria-label="Toggle overview panel"]'),
        document.querySelector('button[aria-label="Toggle workspace panel"]'),
        document.querySelector('[aria-label="Project scripts"]'),
        document.querySelector('[aria-label="Subscription actions"]'),
      ];
      for (const control of otherControls) {
        expect(control, `header control missing at ${width}px`).not.toBeNull();
        const controlRect = (control as HTMLElement).getBoundingClientRect();
        expect(controlRect.width).toBeGreaterThan(0);
        expect(
          rectsIntersect(summaryRect, controlRect),
          `connection control overlaps a header control at ${width}px`,
        ).toBe(false);
      }
      // Everything stays inside the viewport (no horizontal overflow).
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
    }
  });

  it("offers the All nodes return action from the desktop menu", async () => {
    seedConnectedState();
    // A status distinct from the node-presence badges keeps the summary
    // locator unambiguous.
    useHostedHubStore.setState({ transportStatus: "reconnecting", sessionStatus: "stale" });
    const returnToDirectory = vi
      .spyOn(hostedHubController, "returnToDirectory")
      .mockResolvedValue();
    mounted = await render(<HostedNodeMenu />);

    await page.getByText("Unavailable", { exact: true }).click();
    await page.getByRole("button", { name: "All nodes" }).click();
    // No hosted history is installed in this suite, so the control falls back
    // to the router navigation plus the controller primitive.
    await vi.waitFor(() => expect(returnToDirectory).toHaveBeenCalledOnce());
    expect(navigate).toHaveBeenCalledWith({ to: "/", replace: true });
  });

  it("closes the desktop menu before navigating to security details", async () => {
    // The phone twin closes its sheet before leaving for account settings and
    // says why. The desktop menu did not, so the settings surface opened on top
    // of a still-open disclosure: two owners of one dismissal, and an Escape
    // that returns focus into a popover the user believes they already left.
    // The destination is a Hub page now rather than a modal dialog; the menu
    // must still close before the navigation.
    seedConnectedState();
    useHostedHubStore.setState({ transportStatus: "reconnecting", sessionStatus: "stale" });
    mounted = await render(<HostedNodeMenu />);

    await page.getByText("Unavailable", { exact: true }).click();
    const disclosure = document.querySelector<HTMLDetailsElement>("details");
    expect(disclosure, "no desktop menu rendered").not.toBeNull();
    expect(disclosure!.open, "the menu did not open, so this proves nothing").toBe(true);

    await page.getByRole("button", { name: "Security details" }).click();
    expect(window.location.pathname).toBe("/account/security");
    expect(disclosure!.open, "the menu stayed open behind the account page").toBe(false);
  });

  it("opens the phone connection sheet from the pill with the full bounded control set", async () => {
    await page.viewport(390, 844);
    seedConnectedState();
    const refreshDirectory = vi.spyOn(hostedHubController, "refreshDirectory").mockResolvedValue();
    mounted = await render(<HostedConnectionPill />);

    const pill = page.getByTestId("hosted-connection-pill");
    await expect.element(pill).toBeVisible();
    const pillElement = pill.element() as HTMLElement;
    // Collapsed indicator: the state as text (with icon), and node identity in
    // the accessible name rather than in pixels the app-bar title needs.
    expect(pillElement.textContent).toContain("Online");
    expect(pillElement.getAttribute("aria-label")).toBe("Connection: Studio node, Online");
    expect(pillElement.querySelector("svg")).not.toBeNull();
    // The pill renders on the `chip` material tier: at the Glass step it is
    // translucent and blurred, with the tier's own (smaller) blur radius. The
    // contrast that makes this safe is asserted in `GlassSurface.browser.tsx`.
    setAppearancePreference("surfaceTransparency", "glass");
    applyAppearancePreferencesToDocument();
    const pillStyle = getComputedStyle(pillElement);
    expect(pillStyle.backdropFilter).toContain("blur(14px)");
    expect(computedAlpha(pillStyle.backgroundColor)).toBeLessThan(1);
    resetAppearancePreference("surfaceTransparency");
    applyAppearancePreferencesToDocument();

    await pill.click();
    const sheet = document.querySelector<HTMLElement>('[data-slot="sheet-popup"]');
    expect(sheet).not.toBeNull();
    // The full-width bottom sheet pads the landscape side insets itself and
    // honors reduced motion on its transition.
    expect(sheet!.className).toContain("pl-safe");
    expect(sheet!.className).toContain("pr-safe");
    expect(sheet!.className).toContain("motion-reduce:transition-none");
    // Node identity, effective role, and status render as bounded text.
    await expect.element(page.getByText(/operator · Online/)).toBeVisible();
    // Polite live region for connection state changes.
    const liveRegion = sheet!.querySelector('[aria-live="polite"]');
    expect(liveRegion?.textContent).toContain("Studio node");
    // Full control set.
    await expect.element(page.getByRole("button", { name: "All nodes" })).toBeVisible();
    await expect.element(page.getByRole("button", { name: /Second node/ })).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Refresh nodes" })).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Sign out" })).toBeVisible();
    // Detailed security prose lives in Settings, not the compact node switcher.
    await expect.element(page.getByRole("button", { name: "Security details" })).toBeVisible();
    expect(document.querySelector("[data-hosted-relay-trust-notice]")).toBeNull();
    expect(document.body.textContent).not.toContain(RETIRED_HOSTED_RELAY_TRUST_SENTENCE);
    // Focus is trapped inside the sheet while it is open.
    expect(sheet!.contains(document.activeElement)).toBe(true);

    await page.getByRole("button", { name: "Refresh nodes" }).click();
    expect(refreshDirectory).toHaveBeenCalled();

    // Escape closes the sheet and focus returns to the pill.
    await userEvent.keyboard("{Escape}");
    await vi.waitFor(() => {
      expect(document.querySelector('[data-slot="sheet-popup"]')).toBeNull();
    });
    await vi.waitFor(() => {
      expect(document.activeElement).toBe(pillElement);
    });
  });

  it("applies the directory's fail-closed rules inside the sheet while sign-out stays available", async () => {
    await page.viewport(390, 844);
    seedConnectedState();
    useHostedHubStore.setState({ directoryStatus: "stale" });
    mounted = await render(<HostedConnectionSheet open onOpenChange={() => undefined} />);

    const switchButton = page.getByRole("button", { name: /Second node/ });
    await expect.element(switchButton).toBeDisabled();
    await expect.element(page.getByRole("button", { name: "Sign out" })).toBeEnabled();

    // Suspended browser state also disables switching.
    useHostedHubStore.setState({ directoryStatus: "ready", browserStatus: "suspended" });
    await expect.element(switchButton).toBeDisabled();
    await expect.element(page.getByText(/operator · Stale/)).toBeVisible();

    // Recovered: switching re-enables.
    useHostedHubStore.setState({ browserStatus: "current" });
    await expect.element(switchButton).toBeEnabled();
  });

  it("keeps the delivery-unknown acknowledgment gated on session replay in the sheet", async () => {
    await page.viewport(390, 844);
    seedConnectedState();
    useHostedHubStore.setState({
      sessionStatus: "delivery-unknown",
      sessionRecoveredAfterUnknown: false,
    });
    const acknowledge = vi.spyOn(hostedHubController, "acknowledgeDeliveryUnknown");
    mounted = await render(<HostedConnectionSheet open onOpenChange={() => undefined} />);

    await expect.element(page.getByText(/did not resend it automatically/)).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Synchronizing…" })).toBeDisabled();

    useHostedHubStore.setState({ sessionRecoveredAfterUnknown: true });
    const ackButton = page.getByRole("button", { name: "Acknowledge" });
    await expect.element(ackButton).toBeEnabled();
    await ackButton.click();
    expect(acknowledge).toHaveBeenCalled();
  });

  it("announces every bounded status change politely from the pill while the sheet is closed", async () => {
    await page.viewport(390, 844);
    seedConnectedState();
    mounted = await render(<HostedConnectionPill />);

    const announcer = () =>
      document.querySelector<HTMLElement>('[data-testid="hosted-connection-status-announcer"]');
    // The region exists while the sheet is closed and is polite, so status
    // changes never interrupt the user mid-task.
    const region = announcer();
    expect(region).not.toBeNull();
    expect(region!.getAttribute("aria-live")).toBe("polite");
    expect(region!.closest('[data-slot="sheet-popup"]')).toBeNull();
    expect(region!.textContent).toContain("Studio node");
    expect(region!.textContent).toContain("Online");

    // Every derived status change re-renders the region content, which is
    // what triggers a live-region announcement.
    useHostedHubStore.setState({ transportStatus: "reconnecting" });
    await vi.waitFor(() => {
      expect(announcer()!.textContent).toContain("Unavailable");
    });
    useHostedHubStore.setState({ browserStatus: "synchronizing" });
    await vi.waitFor(() => {
      expect(announcer()!.textContent).toContain("Synchronizing");
    });
    useHostedHubStore.setState({ browserStatus: "offline" });
    await vi.waitFor(() => {
      expect(announcer()!.textContent).toContain("Offline");
    });
    useHostedHubStore.setState({ browserStatus: "current", transportStatus: "online" });
    await vi.waitFor(() => {
      expect(announcer()!.textContent).toContain("Online");
    });

    // While the sheet is open its own polite region covers the status, so
    // the pill's announcer unmounts — no double announcement.
    await page.getByTestId("hosted-connection-pill").click();
    await vi.waitFor(() => {
      expect(document.querySelector('[data-slot="sheet-popup"]')).not.toBeNull();
      expect(announcer()).toBeNull();
    });
    const politeStatusRegions = [
      ...document.querySelectorAll<HTMLElement>('[aria-live="polite"]'),
    ].filter((region) => region.textContent?.includes("Studio node"));
    expect(politeStatusRegions).toHaveLength(1);

    // Closing the sheet restores the pill's announcer.
    await userEvent.keyboard("{Escape}");
    await vi.waitFor(() => {
      expect(document.querySelector('[data-slot="sheet-popup"]')).toBeNull();
      expect(announcer()).not.toBeNull();
    });
  });

  it("renders every bounded status as its own short label and an agreeing icon at 320px", async () => {
    await page.viewport(320, 568);
    seedConnectedState();
    mounted = await render(
      // A 320px app bar, so every state is measured where the space is
      // tightest rather than in an unconstrained container.
      <div className="flex items-center gap-1.5 px-3">
        <h1 className="min-w-0 flex-1 truncate text-base font-semibold">Threads</h1>
        <HostedConnectionPill />
      </div>,
    );

    const representatives = hostedConnectionStatusRepresentatives();
    // 18 before the §4.4 channel dimension, and the three states that dimension
    // alone can reach: `Encrypted web`, `Legacy connection`, and `Securing`. The exact
    // count is asserted, not a floor, because the whole failure this sweep
    // exists to catch is a status the shipped app can produce and no render
    // suite ever draws.
    expect(representatives.size).toBe(21);
    for (const text of ["Encrypted web", "Legacy connection", "Securing"] as const) {
      expect([...representatives.keys()], `${text} is reachable in the shipped app`).toContain(
        text,
      );
    }

    const chip = () =>
      document.querySelector<HTMLElement>('[data-testid="hosted-connection-pill"]')!;
    const statusPart = () =>
      document.querySelector<HTMLElement>('[data-slot="mobile-status-chip-status"]')!;
    const icon = () =>
      document.querySelector<HTMLElement>('[data-testid="hosted-connection-icon"]')!;
    const rendered = new Set<string>();

    for (const [text, input] of representatives) {
      const { shortLabel, connected, guarantee } = HOSTED_CONNECTION_STATUS_INDICATORS[text];
      useHostedHubStore.setState({
        browserStatus: input.browserStatus,
        sessionStatus: input.sessionStatus,
        selectionStatus: input.selectionStatus,
        transportStatus: input.transportStatus,
      });
      // §12.2's honest-labeling duty is only met if the pill READS the §13
      // projection. It is driven through the real publishers, so a surface that
      // stopped subscribing renders the previous state and fails below.
      applyWebE2eeChannelStatus(input.e2eeStatus ?? "unavailable");
      await vi.waitFor(() => {
        expect(statusPart().textContent, `collapsed label for "${text}"`).toBe(shortLabel);
      });
      rendered.add(shortLabel);

      // Text AND icon in every state — never colour alone.
      expect(chip().querySelector("svg"), `icon for "${text}"`).not.toBeNull();
      // The glyph agrees with the state, judged from the raw inputs in the
      // derivation's own gate order rather than from the transport alone.
      expect(icon().getAttribute("data-connected"), `glyph for "${text}"`).toBe(
        String(hostedConnectionConnectedByGateOrder(input)),
      );
      expect(connected, `indicator connectedness for "${text}"`).toBe(
        hostedConnectionConnectedByGateOrder(input),
      );
      // §2.2: the claim the state is entitled to, restated from the raw inputs.
      // `e2ee` is unreachable from this tier by construction, so what this pins
      // is that a fallen-back channel claims `legacy` and an NX one claims the
      // weaker `web` row — never the native word.
      expect(guarantee, `§2.2 guarantee for "${text}"`).toBe(
        hostedConnectionGuaranteeByGateOrder(input),
      );
      // …and the DRAWN glyph follows that claim rather than connectedness. Both
      // `legacy` and `web-unsigned` are usable sessions, so keyed on `connected`
      // this element was the identical green wifi for a §12.2 plaintext
      // downgrade and for a locked channel.
      expect(icon().getAttribute("data-guarantee"), `drawn claim for "${text}"`).toBe(guarantee);
      expect(icon().getAttribute("data-glyph"), `glyph for "${text}"`).toBe(
        hostedConnectionStatusPresentation(HOSTED_CONNECTION_STATUS_INDICATORS[text]).glyph,
      );

      // The label is never truncated at the narrowest phone. This only means
      // something because the sweep reaches the long states — measured, the
      // full text would run to 118px for `Authorization removed` and 126px for
      // `authenticating` against a chip that caps at 136px.
      expect(statusPart().scrollWidth, `truncation of "${shortLabel}"`).toBeLessThanOrEqual(
        statusPart().clientWidth,
      );
      expect(chip().getBoundingClientRect().width, `chip width for "${text}"`).toBeLessThanOrEqual(
        136.5,
      );
      // …and the title keeps the larger share of the bar in every state.
      const titleWidth = document.querySelector("h1")!.getBoundingClientRect().width;
      expect(titleWidth, `title width beside "${shortLabel}"`).toBeGreaterThan(
        chip().getBoundingClientRect().width,
      );
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(320);

      // The accessible label keeps node identity AND the complete bounded
      // state — which the collapsed label deliberately no longer spells out.
      const label = chip().getAttribute("aria-label") ?? "";
      expect(label, `accessible label for "${text}"`).toContain(selectedNode.label);
      expect(label, `accessible label for "${text}"`).toContain(text);
      // Bounded vocabulary only: no raw identifier, ticket, or payload.
      expect(label).not.toContain(selectedNode.id);
      expect(label).not.toContain(selectedNode.environmentId);
    }

    // Every state rendered a label no other state renders, so no two states
    // are told apart by colour alone. No case folding: `Online` and `online`
    // are different states and merging them is the defect this pins.
    expect(rendered.size, "two states rendered the same collapsed label").toBe(
      representatives.size,
    );
  });

  it("never shows a connected glyph while the ryco session is not ready", async () => {
    // The three states the transport-only glyph rule got wrong. Each is
    // reachable with the relay transport online, which is exactly why the
    // glyph cannot be chosen from the transport.
    await page.viewport(320, 568);
    seedConnectedState();
    mounted = await render(<HostedConnectionPill />);

    const icon = () =>
      document.querySelector<HTMLElement>('[data-testid="hosted-connection-icon"]')!;
    const statusPart = () =>
      document.querySelector<HTMLElement>('[data-slot="mobile-status-chip-status"]')!;

    for (const [patch, label] of [
      [{ sessionStatus: "delivery-unknown", selectionStatus: "online" }, "Unconfirmed"],
      [{ sessionStatus: "stale", selectionStatus: "authorization-removed" }, "No access"],
      [{ sessionStatus: "closed", selectionStatus: "online" }, "Not ready"],
    ] as const) {
      // Every field is restated: the store merges partials, so an omitted one
      // would carry the previous case's state into this one.
      useHostedHubStore.setState({ browserStatus: "current", transportStatus: "online", ...patch });
      await vi.waitFor(() => {
        expect(statusPart().textContent).toBe(label);
      });
      expect(useHostedHubStore.getState().transportStatus, "the transport is up").toBe("online");
      expect(icon().getAttribute("data-connected"), `glyph beside "${label}"`).toBe("false");
    }

    // …and the connected glyph is still reachable, so the assertion above is
    // not passing by never being connected.
    seedConnectedState();
    await vi.waitFor(() => {
      expect(statusPart().textContent).toBe("Online");
    });
    expect(icon().getAttribute("data-connected")).toBe("true");
  });

  it("never draws a §12.2 fallback the way it draws a locked channel", async () => {
    // The §2.2 defect this slice closes, on the shipped surface. Both states are
    // usable sessions and both were `connected: true`, so with the glyph keyed
    // on connectedness the plaintext downgrade and the NX channel rendered the
    // identical green wifi — "a stronger claim for a weaker configuration",
    // arrived at through an icon.
    await page.viewport(320, 568);
    seedConnectedState();
    mounted = await render(<HostedConnectionPill />);

    const icon = () =>
      document.querySelector<HTMLElement>('[data-testid="hosted-connection-icon"]')!;
    const drawn = async (status: "legacy" | "web-unsigned" | "unavailable") => {
      applyWebE2eeChannelStatus(status);
      await vi.waitFor(() => {
        expect(icon().getAttribute("data-guarantee")).toBe(
          status === "legacy" ? "legacy" : status === "web-unsigned" ? "web" : "none",
        );
      });
      const element = icon();
      return {
        glyph: element.getAttribute("data-glyph"),
        connected: element.getAttribute("data-connected"),
        colour: getComputedStyle(element).color,
        outline: element.querySelector("path,line,circle")?.getAttribute("d") ?? null,
      };
    };

    const legacy = await drawn("legacy");
    const web = await drawn("web-unsigned");
    const plain = await drawn("unavailable");

    // All three are usable sessions — which is exactly why connectedness cannot
    // be what tells them apart.
    expect([legacy.connected, web.connected, plain.connected]).toEqual(["true", "true", "true"]);
    // Different glyph, different rendered colour, different drawn path.
    expect(new Set([legacy.glyph, web.glyph, plain.glyph]).size).toBe(3);
    expect(new Set([legacy.colour, web.colour, plain.colour]).size).toBe(3);
    expect(new Set([legacy.outline, web.outline, plain.outline]).size).toBe(3);
    // And the browser row is never the native verified presentation, which this
    // tier cannot reach at all (`connectionStatus.ts` fences it out).
    expect(web.glyph).not.toBe(
      hostedConnectionStatusPresentation({
        shortLabel: "Encrypted",
        connected: true,
        guarantee: "e2ee",
      }).glyph,
    );
  });

  it.each([
    ["the desktop menu", "menu"],
    ["the phone connection sheet", "sheet"],
  ] as const)("keeps detailed security prose out of %s", async (_name, surface) => {
    seedConnectedState();
    if (surface === "menu") {
      mounted = await render(<HostedNodeMenu />);
      // The menu keeps its disclosure inside a `<details>`; opened directly
      // rather than by click, which is asserted by its own case above.
      const disclosure = document.querySelector<HTMLDetailsElement>("details");
      expect(disclosure, "no desktop menu rendered").not.toBeNull();
      disclosure!.open = true;
    } else {
      await page.viewport(390, 844);
      mounted = await render(<HostedConnectionSheet open onOpenChange={() => undefined} />);
    }

    for (const status of WEB_HOSTED_E2EE_CHANNEL_STATUSES) {
      applyWebE2eeChannelStatus(status);
      await vi.waitFor(() => {
        expect(document.querySelectorAll("[data-hosted-relay-trust-notice]").length, status).toBe(
          0,
        );
      });
      expect(document.body.textContent, status).not.toContain(RETIRED_HOSTED_RELAY_TRUST_SENTENCE);
    }
    await expect.element(page.getByRole("button", { name: "Security details" })).toBeVisible();
  });

  it.each([
    ["the desktop menu", "menu"],
    ["the phone connection sheet", "sheet"],
  ] as const)("labels the live channel on the status line of %s", async (_name, surface) => {
    // §12.2: "A client that falls back MUST label the channel **legacy** in
    // every user-facing surface". Only the pill was ever swept across channel
    // states, so both of these could have pinned `e2eeStatus` to `unavailable`
    // in their `statusInput` and rendered `operator · Online` beside a plaintext
    // fallback with the whole suite green. The source regex in the node test
    // catches a DROPPED field; nothing caught a substituted one.
    seedConnectedState();
    if (surface === "menu") {
      mounted = await render(<HostedNodeMenu />);
      const disclosure = document.querySelector<HTMLDetailsElement>("details");
      expect(disclosure, "no desktop menu rendered").not.toBeNull();
      disclosure!.open = true;
    } else {
      await page.viewport(390, 844);
      mounted = await render(<HostedConnectionSheet open onOpenChange={() => undefined} />);
    }

    const store = useHostedHubStore.getState();
    const statusLine = () =>
      surface === "menu"
        ? document.querySelector<HTMLElement>("details > div > p.capitalize")
        : document.querySelector<HTMLElement>('[data-slot="mobile-sheet-description"]');
    const glyph = () =>
      document.querySelector<HTMLElement>(
        surface === "menu" ? "details > summary svg[data-guarantee]" : "svg[data-guarantee]",
      );

    for (const status of WEB_HOSTED_E2EE_CHANNEL_STATUSES) {
      applyWebE2eeChannelStatus(status);
      const expected = deriveHostedConnectionStatusText({
        browserStatus: store.browserStatus,
        sessionStatus: store.sessionStatus,
        selectionStatus: store.selectionStatus,
        transportStatus: store.transportStatus,
        e2eeStatus: status,
      });
      await vi.waitFor(() => {
        expect(statusLine()?.textContent, `status line for ${status}`).toBe(
          `${store.effectiveRole} · ${expected}`,
        );
      });
      // The polite live region carries the same words, so a screen reader is
      // told about the downgrade too.
      const live = [...document.querySelectorAll<HTMLElement>('[aria-live="polite"]')].filter(
        (region) => region.textContent?.includes(selectedNode.label),
      );
      expect(live, `live region for ${status}`).toHaveLength(1);
      expect(live[0]!.textContent, `live region for ${status}`).toContain(expected);
      // …and the glyph beside it carries §2.2's claim rather than reachability.
      const indicator = deriveHostedConnectionStatusIndicator({
        browserStatus: store.browserStatus,
        sessionStatus: store.sessionStatus,
        selectionStatus: store.selectionStatus,
        transportStatus: store.transportStatus,
        e2eeStatus: status,
      });
      expect(glyph()?.getAttribute("data-guarantee"), `drawn claim for ${status}`).toBe(
        indicator.guarantee,
      );
      expect(glyph()?.getAttribute("data-glyph"), `glyph for ${status}`).toBe(
        hostedConnectionStatusPresentation(indicator).glyph,
      );
    }

    // The sweep is only worth anything if it reached the states the defect hid
    // in: `Legacy` and `Browser encrypted` must both have been drawn above.
    expect([...WEB_HOSTED_E2EE_CHANNEL_STATUSES]).toContain("legacy");
    expect([...WEB_HOSTED_E2EE_CHANNEL_STATUSES]).toContain("web-unsigned");
  });

  it("shows the code without disclosure prose in the desktop menu, and only on a locked channel", async () => {
    // §13.5: "Shown in the web UI for the active session … the owner compares
    // the two out of band", and the accompanying text "MUST state that the
    // comparison … cannot protect against the Hub operator".
    seedConnectedState();
    mounted = await render(<HostedNodeMenu />);
    const disclosure = document.querySelector<HTMLDetailsElement>("details");
    expect(disclosure, "no desktop menu rendered").not.toBeNull();
    disclosure!.open = true;

    const verification = () =>
      document.querySelector<HTMLElement>('[data-testid="hosted-e2ee-verification"]');

    // Nothing is drawn for a channel that has not locked, and nothing for one
    // that fell back (§12.2 forbids any E2EE claim for it).
    for (const status of ["unavailable", "negotiating", "legacy"] as const) {
      applyWebE2eeChannelStatus(status);
      await vi.waitFor(() => {
        expect(verification(), status).toBeNull();
      });
    }

    applyWebE2eeVerificationCode(MENU_WEB_SAS);
    await vi.waitFor(() => {
      expect(verification()).not.toBeNull();
    });
    expect(verification()!.textContent).toContain(MENU_WEB_SAS);
    expect(verification()!.querySelectorAll("p")).toHaveLength(2);
    expect(verification()!.textContent).toContain("Copy");
    expect(document.body.textContent).toContain("Security details");
    expect(document.body.textContent).not.toContain(E2EE_WEB_SAS_DETAIL);
    expect(verification()!.querySelector("details")).toBeNull();
  });

  it("keeps both live regions mounted while the indicator is collapsed", async () => {
    await page.viewport(320, 568);
    seedConnectedState();
    useHostedHubStore.setState({ sessionStatus: "delivery-unknown" });
    mounted = await render(<HostedConnectionPill />);

    // Pinned to the specific regions and their `aria-live` values: a bare
    // `[aria-live]` or `[role=alert]` query passes against any other region on
    // the page and would not fail if the indicator dropped its own.
    const polite = await vi.waitFor(() => {
      const element = document.querySelector<HTMLElement>(
        '[data-testid="hosted-connection-status-announcer"]',
      );
      expect(element, "the polite connection-state region").not.toBeNull();
      return element!;
    });
    expect(polite.getAttribute("aria-live")).toBe("polite");
    expect(polite.getAttribute("role")).toBe("status");
    expect(polite.textContent).toContain(selectedNode.label);
    expect(polite.textContent).toContain("Delivery unknown");

    const assertive = [...document.querySelectorAll<HTMLElement>('[role="alert"]')].filter(
      (element) => element.textContent?.includes("Delivery unknown"),
    );
    expect(assertive, "the assertive delivery-unknown region").toHaveLength(1);
    // `role="alert"` carries an implicit `aria-live: assertive`; assert the
    // computed value so an override cannot silently downgrade it.
    expect(
      assertive[0]!.getAttribute("aria-live") ?? "assertive",
      "the delivery-unknown region stays assertive",
    ).toBe("assertive");

    // Both are mounted while the indicator is COLLAPSED — no sheet is open.
    expect(document.querySelector('[data-slot="sheet-popup"]')).toBeNull();
    expect(polite.closest('[data-slot="sheet-popup"]')).toBeNull();
    expect(assertive[0]!.closest('[data-slot="sheet-popup"]')).toBeNull();
    // …and neither lives inside the chip, so shrinking the chip cannot take
    // them with it.
    const chip = document.querySelector<HTMLElement>('[data-testid="hosted-connection-pill"]')!;
    expect(chip.contains(polite)).toBe(false);
    expect(chip.contains(assertive[0]!)).toBe(false);
  });

  it("measures at least 44px by hit test at collapsed size on a coarse phone", async () => {
    await page.viewport(320, 568);
    await setCoarsePointerEmulation(true);
    try {
      seedConnectedState();
      mounted = await render(
        // The clipping ancestors a phone app bar puts around the indicator: a
        // `::after` hit slop would be inert inside either of these, which is
        // why the chip sizes its real border box instead.
        <div className="flex h-screen items-center overflow-hidden px-3">
          <h1 className="min-w-0 flex-1 truncate text-base font-semibold">Threads</h1>
          <div className="flex min-w-0 items-center overflow-x-auto">
            <HostedConnectionPill />
          </div>
        </div>,
      );

      const chip = page.getByTestId("hosted-connection-pill").element() as HTMLElement;
      const rect = chip.getBoundingClientRect();
      const centreX = rect.left + rect.width / 2;
      const centreY = rect.top + rect.height / 2;
      expect(document.elementFromPoint(centreX, centreY)?.closest("button")).toBe(chip);

      const up = hitReach(chip, centreX, centreY, 0, -1);
      const down = hitReach(chip, centreX, centreY, 0, 1);
      const left = hitReach(chip, centreX, centreY, -1, 0);
      const right = hitReach(chip, centreX, centreY, 1, 0);
      expect(up + down + 1, "hit-tested vertical target").toBeGreaterThanOrEqual(44);
      expect(left + right + 1, "hit-tested horizontal target").toBeGreaterThanOrEqual(44);

      // The audited pill measured 176px wide and pushed the title out of a
      // 320px bar. The collapsed chip has to leave the title the larger share.
      const titleWidth = document.querySelector("h1")!.getBoundingClientRect().width;
      expect(rect.width, "collapsed indicator width").toBeLessThan(titleWidth);
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(320);
    } finally {
      await resetPointerEmulation();
    }
  });

  it("announces delivery-unknown assertively while the connection sheet is closed", async () => {
    await page.viewport(390, 844);
    seedConnectedState();
    mounted = await render(<HostedConnectionPill />);

    expect(document.querySelector('[role="alert"]')).toBeNull();
    useHostedHubStore.setState({ sessionStatus: "delivery-unknown" });
    // Mounting a role=alert element announces assertively on arrival; the
    // explicit acknowledgment flow stays in the connection sheet.
    const alert = await vi.waitFor(() => {
      const element = document.querySelector<HTMLElement>('[role="alert"]');
      expect(element).not.toBeNull();
      return element!;
    });
    expect(alert.textContent).toContain("Delivery unknown");
    expect(alert.closest('[data-slot="sheet-popup"]')).toBeNull();

    // While the sheet is open its acknowledgment block is the single alert;
    // the pill's copy unmounts so the arrival never announces twice.
    await page.getByTestId("hosted-connection-pill").click();
    await vi.waitFor(() => {
      expect(document.querySelector('[data-slot="sheet-popup"]')).not.toBeNull();
    });
    await vi.waitFor(() => {
      const alerts = [...document.querySelectorAll<HTMLElement>('[role="alert"]')];
      expect(alerts).toHaveLength(1);
      expect(alerts[0]!.closest('[data-slot="sheet-popup"]')).not.toBeNull();
    });

    await userEvent.keyboard("{Escape}");
    await vi.waitFor(() => {
      expect(document.querySelector('[data-slot="sheet-popup"]')).toBeNull();
    });
    useHostedHubStore.setState({ sessionStatus: "ready" });
    await vi.waitFor(() => {
      expect(document.querySelector('[role="alert"]')).toBeNull();
    });
  });
});
