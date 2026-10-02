// Consolidated phone/tablet acceptance matrix (focused mobile workspace
// design, delivery step 10).
//
// The spec's Verification matrix — viewports 320×568, 390×844, 844×390
// (coarse landscape), a rotating 600–800px viewport (tier-flip state
// preservation), 768×1024, and the desktop baseline, across the hosted entry
// surfaces, Home, thread/composer, approvals, diff, files, terminal,
// settings, and the connection controls — is proven by the per-step suites
// plus the gap-fill sweeps in this file.
//
// This narrative is a reading aid. The AUTHORITATIVE mapping is the
// `PROVING_TESTS` array at the foot of this file, and the "executable cell →
// proving-test mapping" suite there asserts — against each suite's real
// source — that every referenced proving test still exists and that every
// phone-primitive suite is represented. Rename or delete a proving test and
// this file fails, which a doc-block-only mapping could never do. The tests
// below cover only cells no per-step suite already proves (no duplicate
// re-testing).
//
// The full cell -> proving-test mapping, its file-alias legend, and the
// supporting-suite list are the executable `PROVING_TESTS`, `SUITE_FILES`, and
// `SUPPORTING_SUITES` bindings at the foot of this file. They are asserted
// against each suite's real source there, so nothing in this header can
// silently drift.
//
// Production CSS is part of the behavior under test for every sweep below.
import "../index.css";

import { EnvironmentId } from "@ryco/contracts";
import { page, userEvent } from "vite-plus/test/browser";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

const navigate = vi.fn(async () => undefined);
// This suite renders the hosted root outside a `RouterProvider`. The toast host
// the entry surfaces now mount reads route params to scope thread-scoped
// toasts, which is neither what this suite exercises nor reachable here, so the
// read is stubbed alongside the navigation that was already stubbed.
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => navigate,
  useParams: () => undefined,
}));

import { hostedHubController, useHostedHubStore } from "../hostedHub/state";
import { installHostedNodeHistory, resetHostedNodeRoutesForTests } from "../hostedHub/nodeRoutes";
import { navigateHub, resetHubRoutesForTests } from "../hostedHub/hubRoutes";
import type { HostedHubNode } from "../hostedHub/types";
import { syncDocumentPresentationTier } from "../lib/presentationTier";
import {
  cdpSession,
  resetPointerEmulation,
  setCoarsePointerEmulation,
} from "../../test/browserPointer";
import { SUITE_SOURCES } from "./AcceptanceMatrix.sources";
import { HostedConnectionPill } from "./hostedHub/HostedConnectionControls";
import { HostedHubRoot } from "./hostedHub/HostedHubRoot";

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

/**
 * Every pre-session hosted surface as a store recipe plus a visibility
 * marker, so the sweeps below can iterate the whole entry funnel at any
 * viewport. Recipes mirror the per-step HostedHubRoot suite exactly.
 */
interface EntrySurface {
  readonly name: string;
  readonly seed: () => void;
  /** Marker asserted visible before the geometry checks run. */
  readonly marker: () => Promise<HTMLElement>;
  /** Primary action asserted against the 44px phone touch-target floor. */
  readonly primaryAction?: () => HTMLElement | null;
  /** Extra in-surface navigation after mount (e.g. opening the form). */
  readonly prepare?: () => Promise<void>;
}

async function waitForVisibleByText(pattern: RegExp | string): Promise<HTMLElement> {
  return vi.waitFor(() => {
    const match = [...document.querySelectorAll<HTMLElement>("h1, h2, p")].find((element) =>
      typeof pattern === "string"
        ? element.textContent?.includes(pattern)
        : pattern.test(element.textContent ?? ""),
    );
    expect(match, `Surface marker ${String(pattern)} not found.`).not.toBeUndefined();
    return match!;
  });
}

function findButtonByText(label: string): HTMLElement | null {
  return (
    [...document.querySelectorAll<HTMLElement>("button")].find(
      (button) => button.textContent?.trim() === label,
    ) ?? null
  );
}

const ENTRY_SURFACES: readonly EntrySurface[] = [
  {
    name: "sign-in",
    seed: () => {
      useHostedHubStore.setState({ bootstrapAvailable: true });
    },
    marker: () => waitForVisibleByText("Connect to your Ryco nodes"),
    primaryAction: () => findButtonByText("Sign in with passkey"),
  },
  {
    name: "invitation",
    seed: () => {
      useHostedHubStore.setState({ bootstrapAvailable: true });
    },
    prepare: async () => {
      await page.getByRole("button", { name: "Redeem invitation" }).click();
      await expect.element(page.getByLabelText("Invitation code")).toBeVisible();
    },
    // Each ceremony is its own Hub page with its own heading now. It used to be
    // a form appended below the sign-in page's copy, which is why this marker
    // was the sign-in headline.
    marker: () => waitForVisibleByText("Redeem your invitation"),
    primaryAction: () => findButtonByText("Create account and passkey"),
  },
  {
    name: "recovery-codes",
    seed: () => {
      useHostedHubStore.setState({
        accountStatus: "authenticated",
        account,
        session,
        recoveryCodes: ["recovery-matrix-browser-canary"],
      });
    },
    marker: () => waitForVisibleByText("Save your recovery codes"),
    primaryAction: () => findButtonByText("I saved the codes"),
  },
  {
    name: "node-directory",
    seed: () => {
      navigateHub({ kind: "nodes" }, { replace: true });
      useHostedHubStore.setState({
        accountStatus: "authenticated",
        account,
        session,
        directoryStatus: "ready",
        browserStatus: "current",
        nodes: [selectedNode, otherNode],
      });
    },
    marker: () => waitForVisibleByText("Your nodes"),
    primaryAction: () =>
      [...document.querySelectorAll<HTMLElement>("button")].find((button) =>
        button.textContent?.includes("Studio node"),
      ) ?? null,
  },
  {
    name: "connecting",
    seed: () => {
      window.history.replaceState(window.history.state, "", `/node/${selectedNode.id}`);
      installHostedNodeHistory();
      useHostedHubStore.setState({
        accountStatus: "authenticated",
        account,
        session,
        directoryStatus: "ready",
        nodes: [selectedNode],
        selectedNode,
        transportStatus: "online",
        sessionEstablished: false,
      });
    },
    marker: () => waitForVisibleByText(/Connecting to Studio node/),
  },
  {
    name: "failure",
    seed: () => {
      window.history.replaceState(window.history.state, "", `/node/${selectedNode.id}`);
      installHostedNodeHistory();
      useHostedHubStore.setState({
        accountStatus: "authenticated",
        account,
        session,
        directoryStatus: "ready",
        nodes: [selectedNode],
        selectedNode,
        transportStatus: "terminal-failure",
        errorMessage: "The hosted authentication attempt expired or was rejected.",
      });
    },
    marker: () => waitForVisibleByText(/Unable to connect to Studio node/),
  },
];

function expectNoDocumentHorizontalOverflow(width: number): void {
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
  expect(document.body.scrollWidth).toBeLessThanOrEqual(width);
}

async function waitForTierAttribute(tier: "phone" | "desktop"): Promise<void> {
  await vi.waitFor(() => {
    expect(document.documentElement.getAttribute("data-tier")).toBe(tier);
  });
}

let mounted: Awaited<ReturnType<typeof render>> | null = null;

async function sweepEntrySurfaces(options: {
  width: number;
  tier: "phone" | "desktop";
  surfaces?: readonly string[];
}): Promise<void> {
  const surfaces = ENTRY_SURFACES.filter(
    (surface) => !options.surfaces || options.surfaces.includes(surface.name),
  );
  expect(surfaces.length).toBeGreaterThan(0);
  for (const surface of surfaces) {
    hostedHubController.resetForTests();
    resetHostedNodeRoutesForTests();
    resetHubRoutesForTests();
    surface.seed();
    mounted = await render(<HostedHubRoot />);
    await surface.prepare?.();
    await surface.marker();
    await waitForTierAttribute(options.tier);
    expectNoDocumentHorizontalOverflow(options.width);
    if (surface.primaryAction) {
      const action = await vi.waitFor(() => {
        const element = surface.primaryAction!();
        expect(element, `Primary action missing on ${surface.name}.`).not.toBeNull();
        return element!;
      });
      const box = action.getBoundingClientRect();
      expect(box.left, `${surface.name} action off-screen left`).toBeGreaterThanOrEqual(0);
      expect(box.right, `${surface.name} action off-screen right`).toBeLessThanOrEqual(
        options.width,
      );
      if (options.tier === "phone") {
        // The 44px floor is met either by the tier-variant box itself or by
        // the shared coarse-pointer ::after hit-area expansion (both sweeps
        // that reach here emulate a coarse pointer).
        if (box.height < 44) {
          const hitArea = getComputedStyle(action, "::after");
          expect(hitArea.position, `${surface.name} action lacks a coarse hit area`).toBe(
            "absolute",
          );
          expect(
            Number.parseFloat(hitArea.height),
            `${surface.name} action hit area below the 44px floor`,
          ).toBeGreaterThanOrEqual(44);
          expect(
            Number.parseFloat(hitArea.width),
            `${surface.name} action hit area below the 44px floor`,
          ).toBeGreaterThanOrEqual(44);
        }
      }
    }
    await mounted.unmount();
    mounted = null;
  }
}

describe("acceptance matrix — hosted entry surfaces and connection controls", () => {
  beforeAll(() => {
    // Mirrors main.tsx: the single document-level tier sync drives the
    // `phone:` CSS variants the sweeps assert against.
    syncDocumentPresentationTier();
  });

  beforeEach(async () => {
    await resetPointerEmulation();
    localStorage.clear();
    sessionStorage.clear();
    hostedHubController.resetForTests();
    resetHostedNodeRoutesForTests();
    resetHubRoutesForTests();
    navigate.mockClear();
  });

  afterEach(async () => {
    await mounted?.unmount();
    mounted = null;
    hostedHubController.resetForTests();
    resetHostedNodeRoutesForTests();
    resetHubRoutesForTests();
    vi.restoreAllMocks();
    document.body.innerHTML = "";
    await resetPointerEmulation();
    await page.viewport(1_280, 720);
  });

  it("contains every hosted entry surface on a coarse landscape phone", async () => {
    // 844×390 needs the coarse-pointer clause to classify as a phone; the
    // entry funnel must stay overflow-free with 44px primary actions there.
    await page.viewport(844, 390);
    await setCoarsePointerEmulation(true);
    try {
      await sweepEntrySurfaces({ width: 844, tier: "phone" });
    } finally {
      await setCoarsePointerEmulation(false);
    }
  });

  it("contains the invitation, recovery, connecting, and failure surfaces at 320 CSS pixels", async () => {
    // Sign-in and the directory are proven at 320 by the HostedHubRoot
    // suite; this sweep completes the funnel's remaining surfaces. The
    // coarse pointer matches a real narrow phone and activates the shared
    // hit-area expansion the touch-target floor may rely on.
    await page.viewport(320, 568);
    await setCoarsePointerEmulation(true);
    try {
      await sweepEntrySurfaces({
        width: 320,
        tier: "phone",
        surfaces: ["invitation", "recovery-codes", "connecting", "failure"],
      });
    } finally {
      await setCoarsePointerEmulation(false);
      await page.viewport(1_280, 720);
    }
  });

  it("keeps the hosted entry surfaces on the desktop tier at 768×1024", async () => {
    // 768px is the first desktop-tier width: entry surfaces keep desktop
    // density (no 44px phone floor) and remain overflow-free.
    await page.viewport(768, 1_024);
    try {
      await sweepEntrySurfaces({
        width: 768,
        tier: "desktop",
        surfaces: ["sign-in", "node-directory"],
      });
      // Desktop-density guard: the phone-only 44px floor must not leak into
      // the desktop tier (size="lg" resolves below 44px there).
      hostedHubController.resetForTests();
      resetHubRoutesForTests();
      useHostedHubStore.setState({ bootstrapAvailable: true });
      mounted = await render(<HostedHubRoot />);
      const signIn = await vi.waitFor(() => {
        const button = findButtonByText("Sign in with passkey");
        expect(button).not.toBeNull();
        return button!;
      });
      expect(signIn.getBoundingClientRect().height).toBeLessThan(44);
    } finally {
      await page.viewport(1_280, 720);
    }
  });

  it("preserves invitation form input across a mid-size rotation tier flip", async () => {
    // Rotating a mid-size device across the 768px boundary flips the tier;
    // the entry surfaces restyle via CSS variants only, so typed form state
    // must survive both flips untouched.
    await page.viewport(700, 900);
    try {
      useHostedHubStore.setState({ bootstrapAvailable: true });
      mounted = await render(<HostedHubRoot />);
      await waitForTierAttribute("phone");
      await page.getByRole("button", { name: "Redeem invitation" }).click();
      await page.getByLabelText("Invitation code").fill("rotation-invitation-probe");
      await page.getByLabelText("Display name").fill("Rotation Ada");

      await page.viewport(780, 700);
      await waitForTierAttribute("desktop");
      await expect
        .element(page.getByLabelText("Invitation code"))
        .toHaveValue("rotation-invitation-probe");
      await expect.element(page.getByLabelText("Display name")).toHaveValue("Rotation Ada");
      expectNoDocumentHorizontalOverflow(780);

      await page.viewport(700, 900);
      await waitForTierAttribute("phone");
      await expect
        .element(page.getByLabelText("Invitation code"))
        .toHaveValue("rotation-invitation-probe");
      await expect.element(page.getByLabelText("Display name")).toHaveValue("Rotation Ada");
      expectNoDocumentHorizontalOverflow(700);
    } finally {
      await page.viewport(1_280, 720);
    }
  });

  it("survives 200% text scaling on the sign-in and node directory surfaces", async () => {
    // The entry layout is rem-based; doubling the root font size emulates
    // 200% browser text scaling. Controls must stay visible and the page
    // free of document-level horizontal overflow.
    await page.viewport(390, 844);
    const previousFontSize = document.documentElement.style.fontSize;
    document.documentElement.style.fontSize = "32px";
    try {
      useHostedHubStore.setState({ bootstrapAvailable: true });
      mounted = await render(<HostedHubRoot />);
      const signIn = await vi.waitFor(() => {
        const button = findButtonByText("Sign in with passkey");
        expect(button).not.toBeNull();
        return button!;
      });
      const signInBox = signIn.getBoundingClientRect();
      expect(signInBox.left).toBeGreaterThanOrEqual(0);
      expect(signInBox.right).toBeLessThanOrEqual(390);
      expectNoDocumentHorizontalOverflow(390);
      await mounted.unmount();
      mounted = null;
      hostedHubController.resetForTests();
      resetHubRoutesForTests();
      navigateHub({ kind: "nodes" }, { replace: true });

      useHostedHubStore.setState({
        accountStatus: "authenticated",
        account,
        session,
        directoryStatus: "ready",
        browserStatus: "current",
        nodes: [selectedNode],
      });
      mounted = await render(<HostedHubRoot />);
      const row = await vi.waitFor(() => {
        const element =
          [...document.querySelectorAll<HTMLElement>("button")].find((button) =>
            button.textContent?.includes("Studio node"),
          ) ?? null;
        expect(element).not.toBeNull();
        return element!;
      });
      const rowBox = row.getBoundingClientRect();
      expect(rowBox.left).toBeGreaterThanOrEqual(0);
      expect(rowBox.right).toBeLessThanOrEqual(390);
      expectNoDocumentHorizontalOverflow(390);
    } finally {
      document.documentElement.style.fontSize = previousFontSize;
      await page.viewport(1_280, 720);
    }
  });

  it("contains the connection sheet at 320px and on a coarse landscape phone with reduced motion honored", async () => {
    const seedConnectedState = () => {
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
    };
    const sheetPopup = () => document.querySelector<HTMLElement>('[data-slot="sheet-popup"]');
    const assertSheetContained = async (width: number) => {
      const sheet = await vi.waitFor(() => {
        const element = sheetPopup();
        expect(element).not.toBeNull();
        return element!;
      });
      await vi.waitFor(() => {
        const rect = sheet.getBoundingClientRect();
        expect(rect.left).toBeGreaterThanOrEqual(-0.5);
        expect(rect.right).toBeLessThanOrEqual(width + 0.5);
      });
      expectNoDocumentHorizontalOverflow(width);
      // The bounded control set stays reachable with 44px rows.
      for (const label of ["All nodes", "Refresh nodes", "Sign out"] as const) {
        const control = await vi.waitFor(() => {
          const element = findButtonByText(label);
          expect(element, `Missing sheet control ${label}.`).not.toBeNull();
          return element!;
        });
        expect(control.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
        expect(control.getBoundingClientRect().right).toBeLessThanOrEqual(width + 0.5);
      }
      return sheet;
    };

    // 320×568 portrait: the sheet and its controls fit the narrowest phone.
    await page.viewport(320, 568);
    seedConnectedState();
    mounted = await render(<HostedConnectionPill />);
    const pill = page.getByTestId("hosted-connection-pill");
    await expect.element(pill).toBeVisible();
    expect((pill.element() as HTMLElement).getBoundingClientRect().right).toBeLessThanOrEqual(320);
    await pill.click();
    await assertSheetContained(320);
    await userEvent.keyboard("{Escape}");
    await vi.waitFor(() => {
      expect(sheetPopup()).toBeNull();
    });
    await mounted.unmount();
    mounted = null;
    hostedHubController.resetForTests();
    resetHubRoutesForTests();

    // 844×390 coarse landscape: the pill grows to the coarse 44px floor and
    // the sheet stays contained; with reduced motion emulated, the popup's
    // transition is disabled (motion-reduce holds behaviorally).
    await page.viewport(844, 390);
    await setCoarsePointerEmulation(true);
    try {
      await cdpSession().send("Emulation.setEmulatedMedia", {
        features: [{ name: "prefers-reduced-motion", value: "reduce" }],
      });
      await vi.waitFor(() => {
        expect(window.matchMedia("(prefers-reduced-motion: reduce)").matches).toBe(true);
      });
      seedConnectedState();
      mounted = await render(<HostedConnectionPill />);
      const landscapePill = page.getByTestId("hosted-connection-pill");
      await expect.element(landscapePill).toBeVisible();
      await vi.waitFor(() => {
        expect(
          (landscapePill.element() as HTMLElement).getBoundingClientRect().height,
        ).toBeGreaterThanOrEqual(44);
      });
      await landscapePill.click();
      const sheet = await assertSheetContained(844);
      expect(sheet.className).toContain("motion-reduce:transition-none");
      expect(getComputedStyle(sheet).transitionProperty).toBe("none");
      await userEvent.keyboard("{Escape}");
      await vi.waitFor(() => {
        expect(sheetPopup()).toBeNull();
      });
    } finally {
      await cdpSession().send("Emulation.setEmulatedMedia", {
        features: [{ name: "prefers-reduced-motion", value: "" }],
      });
      await setCoarsePointerEmulation(false);
    }
  });
});

// ── Executable cell → proving-test mapping ───────────────────────────────
//
// The doc block at the top of this file reads as complete even when a proving
// test has been renamed or deleted — a coverage claim that cannot fail. This
// is the executable form of that mapping: every cell names its suite and a
// distinctive substring of the proving test's name, and the tests below assert
// against each suite's real source (loaded with `?raw`, never executed) that
// the referenced name still exists. That makes a rename a suite failure.
//
// `SUITE_SOURCES` is globbed from a sibling module because `import.meta.glob`
// excludes its own caller; see `AcceptanceMatrix.sources.ts`.

// alias → path in glob-key form (relative to this file). The code map replaces
// the comment legend so an alias cannot drift from the file it points at.
const SUITE_FILES = {
  AM: "./AcceptanceMatrix.browser.tsx",
  CVNavigation: "./ChatView.Navigation.browser.tsx",
  CVConversation: "./ChatView.Conversation.browser.tsx",
  CVComposer: "./ChatView.Composer.browser.tsx",
  CVWorkspace: "./ChatView.Workspace.browser.tsx",
  CVPhoneSurfaces: "./ChatView.PhoneSurfaces.browser.tsx",
  CVPhoneComposer: "./ChatView.PhoneComposer.browser.tsx",
  HR: "./hostedHub/HostedHubRoot.browser.tsx",
  HN: "./hostedHub/HostedNodeRoutes.browser.tsx",
  HC: "./hostedHub/HostedConnectionControls.browser.tsx",
  HP: "./hostedHub/HostedPwaControls.browser.tsx",
  HES: "./hostedHub/HostedEntrySurfaces.browser.tsx",
  PRP: "./auth/PairingRouteSurface.browser.tsx",
  PT: "./PresentationTier.browser.tsx",
  PH: "./shell/phone/PhoneHome.browser.tsx",
  PA: "./shell/phone/PhoneThreadAppBar.browser.tsx",
  PS: "./shell/phone/PhoneSettingsSurface.browser.tsx",
  PRC: "./shell/phone/PhoneReachability.browser.tsx",
  CS: "./shell/phone/ContextMenuActionSheetHost.browser.tsx",
  AC: "./chat/ApprovalCard.browser.tsx",
  MT: "./chat/MessageTouchActions.browser.tsx",
  CB: "./chat/ComposerBannerStack.browser.tsx",
  WP: "./ThreadWorkspacePanel.browser.tsx",
  TD: "./ThreadTerminalDrawer.browser.tsx",
  DP: "./DiffPanel.browser.tsx",
  SH: "./ui/sheet.browser.tsx",
  SP: "./settings/SettingsPanels.browser.tsx",
  MSHEET: "./mobile/MobileSheet.browser.tsx",
  MSEL: "./mobile/MobileSelectSheet.browser.tsx",
  MSEG: "./mobile/MobileSegmentedControl.browser.tsx",
  MSTAT: "./mobile/MobileStatusChip.browser.tsx",
  GS: "./mobile/GlassSurface.browser.tsx",
  MLROW: "./mobile/MobileListRow.browser.tsx",
  MDOCK: "./mobile/MobileDock.browser.tsx",
  MCSTRIP: "./mobile/MobileContextStrip.browser.tsx",
} as const;
type SuiteAlias = keyof typeof SUITE_FILES;

const TEST_DECLARATION_SOURCE =
  "\\b(?:it|test)(?:\\.(?:fails|skip|only|each))?\\s*\\(\\s*([\"'`])((?:\\\\.|(?!\\1).)*)\\1";

/** The real `it`/`test` names declared in a suite, read from its source. */
function testNamesIn(alias: SuiteAlias): readonly string[] {
  const source = SUITE_SOURCES[SUITE_FILES[alias]];
  if (source === undefined) {
    throw new Error(`No globbed source for ${alias} (${SUITE_FILES[alias]}).`);
  }
  // Fresh RegExp per call: /g carries a stateful lastIndex and this runs per
  // alias. The `s` flag lets a multi-line (backtick) test name match.
  const pattern = new RegExp(TEST_DECLARATION_SOURCE, "gs");
  const names: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    const name = match[2];
    if (name !== undefined) {
      names.push(name.replace(/\s+/g, " ").trim());
    }
  }
  return names;
}

interface ProvingCell {
  /** Human label for the spec cell or cross-cutting property. */
  readonly cell: string;
  readonly file: SuiteAlias;
  /**
   * A distinctive substring of the proving test's name — a substring, not the
   * exact name, so a template-literal name like `…at ${w}px` maps on its static
   * prefix. Still falsifiable: renaming the test drops the substring.
   */
  readonly test: string;
}

const PROVING_TESTS: readonly ProvingCell[] = [
  // ── Surface × viewport (focused mobile workspace) ──────────────────────
  {
    cell: "sign-in @320",
    file: "HR",
    test: "contains hosted admission and node selection at 320 CSS pixels",
  },
  {
    cell: "sign-in @390 screen-reader",
    file: "HR",
    test: "keeps sign-in and node-selection screen-reader traversal named",
  },
  {
    cell: "sign-in @390 200%",
    file: "AM",
    test: "survives 200% text scaling on the sign-in and node directory surfaces",
  },
  {
    cell: "sign-in coarse landscape",
    file: "AM",
    test: "contains every hosted entry surface on a coarse landscape phone",
  },
  {
    cell: "sign-in rotation",
    file: "AM",
    test: "preserves invitation form input across a mid-size rotation tier flip",
  },
  {
    cell: "sign-in @768",
    file: "AM",
    test: "keeps the hosted entry surfaces on the desktop tier at 768",
  },
  {
    cell: "sign-in desktop",
    file: "HR",
    test: "provides keyboard-labelled authentication and registration controls",
  },
  {
    cell: "invitation @320",
    file: "AM",
    test: "contains the invitation, recovery, connecting, and failure surfaces at 320 CSS pixels",
  },
  {
    cell: "invitation desktop bootstrap",
    file: "HR",
    test: "submits first-owner bootstrap without retaining its credential in the form",
  },
  {
    cell: "recovery codes desktop",
    file: "HR",
    test: "keeps one-time recovery material out of browser storage",
  },
  {
    cell: "node directory desktop route",
    file: "HN",
    test: "selects a node by navigating into its node-scoped route",
  },
  {
    cell: "node directory route back",
    file: "HN",
    test: "returns to the directory when history navigates back from a node route",
  },
  {
    cell: "node directory no-secret-in-url",
    file: "HN",
    test: "keeps session and account material out of the URL, history, and browser storage",
  },
  {
    cell: "home @320 + coarse landscape",
    file: "PH",
    test: "contains the Home surface at 320px and on a coarse landscape phone",
  },
  {
    cell: "home navigation",
    file: "CVPhoneSurfaces",
    test: "navigates the phone stack from the thread app bar to Home",
  },
  {
    cell: "thread @320",
    file: "CVComposer",
    test: "contains the active chat and composer at 320 CSS pixels",
  },
  {
    cell: "thread keyboard",
    file: "CVPhoneComposer",
    test: "keeps the composer and send action above a stubbed software keyboard on phones",
  },
  {
    cell: "thread coarse landscape single action",
    file: "CVPhoneComposer",
    test: "shows exactly one set of pending-answer actions on a coarse landscape phone",
  },
  {
    cell: "thread keyboard insets rotation",
    file: "CVPhoneComposer",
    test: "tracks keyboard insets across orientation changes and removes them when closed",
  },
  {
    cell: "thread rotation state",
    file: "CVPhoneComposer",
    test: "preserves route, draft, and panel search state across a mid-size rotation tier flip",
  },
  {
    cell: "thread desktop no keyboard vars",
    file: "CVPhoneComposer",
    test: "publishes no keyboard variables and changes no composer geometry without an inset",
  },
  {
    cell: "approval @320",
    file: "CVPhoneComposer",
    test: "renders the full approval detail scrollable with all actions visible on a phone",
  },
  { cell: "approval @320 keyboard", file: "AC", test: "stays readable and actionable at " },
  {
    cell: "approval @390 arrival",
    file: "CVPhoneComposer",
    test: "keeps approval actions visible when an approval arrives while the phone composer is expanded",
  },
  {
    cell: "approval expand sheet",
    file: "AC",
    test: "expands long detail into a bottom sheet with the single action set moved into it",
  },
  {
    cell: "approval desktop",
    file: "AC",
    test: "keeps the expand affordance off the desktop tier and renders a single inline action set",
  },
  {
    cell: "diff @320",
    file: "CVPhoneSurfaces",
    test: "renders desktop-shaped workspace links full-screen at 320px with contained diff scrolling and a files push",
  },
  {
    cell: "diff @390 full-screen",
    file: "CVPhoneSurfaces",
    test: "promotes the workspace panel to a full-screen phone surface with history-coherent back",
  },
  {
    cell: "diff/files coarse landscape",
    file: "CVPhoneSurfaces",
    test: "contains the review and files surfaces on a coarse landscape phone",
  },
  {
    cell: "diff rotation",
    file: "CVPhoneSurfaces",
    test: "preserves the open review surface across a mid-size rotation tier flip",
  },
  {
    cell: "diff desktop wrap default",
    file: "DP",
    test: "keeps the settings-driven wrap default on desktop presentations",
  },
  {
    cell: "files desktop geometry",
    file: "WP",
    test: "stretches its root to the full right-panel width",
  },
  {
    cell: "terminal @320 + coarse landscape",
    file: "CVPhoneSurfaces",
    test: "contains the terminal surface at 320px and on a coarse landscape phone",
  },
  {
    cell: "terminal @390 toolbar",
    file: "CVPhoneSurfaces",
    test: "renders the terminal surface full-screen with a 44px toolbar above a stubbed keyboard",
  },
  {
    cell: "terminal desktop",
    file: "TD",
    test: "uses the drawer surface colors for the terminal theme",
  },
  { cell: "settings @320", file: "PS", test: "lists every section as a labeled 44px row at 320px" },
  {
    cell: "settings @320 200%",
    file: "PS",
    test: "survives 200% text scaling at 320px without hiding controls or page overflow",
  },
  {
    cell: "settings @390 from Home",
    file: "CVPhoneSurfaces",
    test: "presents phone settings full-screen from Home with the labeled section list",
  },
  {
    cell: "settings coarse landscape",
    file: "PS",
    test: "keeps the settings surface full-screen on a coarse landscape phone",
  },
  {
    cell: "settings rotation",
    file: "CVPhoneSurfaces",
    test: "preserves open settings across a mid-size rotation tier flip",
  },
  {
    cell: "settings desktop page",
    file: "CVPhoneSurfaces",
    test: "presents settings as a page on desktop viewports and returns to the thread",
  },
  { cell: "settings desktop panels", file: "SP", test: "persists the diff behavior toggles" },
  {
    cell: "connection @320 + coarse landscape sheet",
    file: "AM",
    test: "contains the connection sheet at 320px and on a coarse landscape phone",
  },
  {
    cell: "connection @390 pill",
    file: "HC",
    test: "opens the phone connection sheet from the pill with the full bounded control set",
  },
  {
    cell: "connection desktop header",
    file: "HC",
    test: "renders inside the workspace header without a fixed overlay or control overlap",
  },
  {
    cell: "connection desktop all-nodes",
    file: "HC",
    test: "offers the All nodes return action from the desktop menu",
  },

  // ── Cross-cutting properties ───────────────────────────────────────────
  {
    cell: "tier classification",
    file: "PT",
    test: "classifies viewports and pointers into the phone/desktop matrix",
  },
  {
    cell: "tier diagnostics override",
    file: "PT",
    test: "forces the tier via the dev-only diagnostics override",
  },
  {
    cell: "coarse-pointer hidden shortcut hints",
    file: "CVPhoneSurfaces",
    test: "hides keyboard-shortcut hints in the command palette on coarse pointers",
  },
  {
    cell: "focus retention — settings",
    file: "PS",
    test: "moves focus to the section on push and back to the originating row on pop",
  },
  {
    cell: "focus retention — context sheet",
    file: "CS",
    test: "traps focus while open and resolves null on Escape",
  },
  {
    cell: "long-press parity — messages",
    file: "MT",
    test: "opens the message action sheet from a long-press and round-trips copy and revert",
  },
  {
    cell: "long-press parity — context menu",
    file: "CS",
    test: "presents every desktop context-menu descriptor set with touch-sized rows",
  },
  {
    cell: "reduced motion — banners",
    file: "CB",
    test: "dismisses immediately without exit-transition styles under reduced motion",
  },
  {
    cell: "200% text — app bar",
    file: "CVPhoneSurfaces",
    test: "keeps phone app-bar controls visible at 200% text scale at 320px and 390px",
  },
  {
    cell: "safe areas — surfaces",
    file: "CVPhoneSurfaces",
    test: "pads phone surfaces from the safe-area insets directly instead of the root inset",
  },
  {
    cell: "fail-closed node routes",
    file: "HN",
    test: "fails an unknown routed node closed to the directory with a bounded explanation",
  },
  {
    cell: "desktop regression — sidebar density",
    file: "CVPhoneComposer",
    test: "keeps tablet-width sidebar density unchanged on coarse pointers",
  },
  {
    cell: "desktop regression — connection header",
    file: "HC",
    test: "renders inside the workspace header without a fixed overlay or control overlap",
  },
  {
    cell: "PWA install guidance",
    file: "HP",
    test: "shows iOS installation steps and the relay trust boundary",
  },
  {
    cell: "icon-only accessible names",
    file: "CVPhoneSurfaces",
    test: "gives every visible phone control an accessible name across Home, thread, and sheets",
  },

  // ── Liquid Glass properties (delivery steps 2-8) ───────────────────────
  {
    cell: "step2 sheet — detents",
    file: "MSHEET",
    test: "opens at the requested detent and snaps between them",
  },
  {
    cell: "step2 sheet — swipe to dismiss",
    file: "MSHEET",
    test: "dismisses on a downward swipe and commits the dismissal on gesture resolution",
  },
  {
    cell: "step2 sheet — focus trap, scroll lock, restore",
    file: "MSHEET",
    test: "traps focus, locks page scroll, and restores focus to the trigger",
  },
  {
    cell: "step2 sheet — safe area + keyboard inset",
    file: "MSHEET",
    test: "applies the safe-area padding and the keyboard inset itself",
  },
  {
    cell: "step2 sheet — reduced motion",
    file: "MSHEET",
    test: "collapses its transitions under prefers-reduced-motion",
  },
  {
    cell: "step3 material — AA on every tier/step/scheme",
    file: "GS",
    test: "clears WCAG AA on every tier, every Material step and both colour schemes",
  },
  {
    cell: "step3 material — guaranteed base",
    file: "GS",
    test: "guarantees the same base regardless of what scrolls beneath",
  },
  {
    cell: "step3 material — per-tier floor pinned",
    file: "GS",
    test: "derives each tier's floor from its own roles, and pins it as the minimum",
  },
  {
    cell: "step4 composer — one-tap focus in activation task",
    file: "CVPhoneComposer",
    test: "focuses the phone composer editor in the activating task on the first tap",
  },
  {
    cell: "step4 composer — 16px type across tier",
    file: "CVPhoneComposer",
    test: "keeps a 16px composer type size across the whole phone tier",
  },
  {
    cell: "step4 composer — collapse across 640-767",
    file: "CVPhoneComposer",
    test: "collapses the composer across the whole phone tier, including 640-767px viewports",
  },
  {
    cell: "step5 reachability — bottom third Home+Thread",
    file: "PRC",
    test: "puts every primary and frequent action's centre in the bottom third on Home and Thread",
  },
  {
    cell: "step5 reachability — coarse landscape exemption",
    file: "PRC",
    test: "asserts the coarse-landscape exemption rather than skipping it",
  },
  {
    cell: "step5 reachability — last row clears dock",
    file: "PRC",
    test: "lets the last list row clear the dock instead of resting permanently behind it",
  },
  {
    cell: "step5 reachability — no dock on desktop",
    file: "PRC",
    test: "mounts no dock on the desktop tier",
  },
  {
    cell: "step6 select sheet — browse-first partial detent",
    file: "MSEL",
    test: "opens browse-first at the partial detent with search unfocused, and expands on focus",
  },
  {
    cell: "step6 select sheet — 44px rows + selected state",
    file: "MSEL",
    test: "renders every row as a 44px target with its selected state exposed to assistive tech",
  },
  {
    cell: "step6 model gating — bounded reason when disabled",
    file: "MSEL",
    test: "renders a bounded reason and commits nothing when it is disabled",
  },
  {
    cell: "step6 session gating — bounded reason when disabled",
    file: "MSEG",
    test: "renders a bounded reason and commits nothing when it is disabled",
  },
  {
    cell: "step6 session — consequential option is deliberate",
    file: "MSEG",
    test: "keeps the consequential option a deliberate activation, not something a swipe reaches",
  },
  {
    cell: "step7 indicator — text and icon at 320",
    file: "HC",
    test: "renders every bounded status as its own short label and an agreeing icon at 320px",
  },
  {
    cell: "step7 indicator — both live regions collapsed",
    file: "HC",
    test: "keeps both live regions mounted while the indicator is collapsed",
  },
  {
    cell: "step7 indicator — assertive delivery-unknown",
    file: "HC",
    test: "announces delivery-unknown assertively while the connection sheet is closed",
  },
  {
    cell: "step7 indicator — polite status changes",
    file: "HC",
    test: "announces every bounded status change politely from the pill while the sheet is closed",
  },
  {
    cell: "step7 indicator — 44px collapsed by hit test",
    file: "HC",
    test: "measures at least 44px by hit test at collapsed size on a coarse phone",
  },
  {
    cell: "step7 chip — word and icon, no colour-only",
    file: "MSTAT",
    test: "renders the status word and an icon, so no state is carried by colour alone",
  },
  {
    cell: "step7 chip — 44px inside clipping ancestors",
    file: "MSTAT",
    test: "reaches 44px on both axes by hit test even inside clipping ancestors",
  },
  {
    cell: "step8 diff — 44px by hit test",
    file: "DP",
    test: "gives every phone diff control a 44px effective touch target, measured by hit test",
  },
  {
    cell: "step8 diff — scroll containment",
    file: "DP",
    test: "contains unwrapped diff overflow inside the phone surface instead of the page",
  },
  {
    cell: "step8 diff — 200% turn chips",
    file: "DP",
    test: "keeps every turn chip reachable at 200% text scaling on the phone surface",
  },
  {
    cell: "step8 diff — desktop unchanged",
    file: "DP",
    test: "keeps the desktop diff toolbar, turn-strip arrows, and two-axis scrolling unchanged",
  },
  {
    cell: "step8 entry — primary action within fold",
    file: "HES",
    test: "keeps every entry surface's primary action within the fold at rest on a phone",
  },
  {
    cell: "step8 entry — sign-out out of top-right",
    file: "HES",
    test: "moves sign-out out of the node directory's top-right corner on the phone tier",
  },
  {
    cell: "step8 entry — 44px by hit test",
    file: "HES",
    test: "meets the 44px touch floor on every operable entry control, measured by hit test",
  },
  {
    cell: "step8 entry — bottom-anchored registration",
    file: "HES",
    test: "bottom-anchors the registration form's action group on a phone",
  },
  {
    cell: "step8 entry — live region in registration mode",
    file: "HES",
    test: "keeps the polite ceremony announcement and Hub recovery mounted in registration mode",
  },
  {
    cell: "step8 entry — desktop tier keeps flow layout and compact density",
    file: "HES",
    test: "puts the desktop directory in the Hub shell with its account controls in the Hub bar",
  },
  {
    cell: "step8 pairing — reachable + 44px",
    file: "PRP",
    test: "keeps the pairing action reachable and 44px on a phone at 320x568",
  },
  {
    cell: "step8 pairing — bottom-anchored",
    file: "PRP",
    test: "bottom-anchors the pairing action row when the surface fits at 390x844",
  },
  {
    cell: "step8 pairing — desktop unchanged",
    file: "PRP",
    test: "keeps the desktop pairing card centred with its actions in flow",
  },
  {
    cell: "primitive — list row 44px",
    file: "MLROW",
    test: "measures at least 44px on its smaller axis under coarse-pointer emulation",
  },
  {
    cell: "primitive — list row bounded disabled reason",
    file: "MLROW",
    test: "renders a disabled presentation with a bounded reason that is a description, not the name",
  },
  {
    cell: "primitive — dock 44px every density",
    file: "MDOCK",
    test: "measures at least 44px on both axes at every density under coarse-pointer emulation",
  },
  {
    cell: "primitive — dock inset is max, never sum",
    file: "MDOCK",
    test: "takes the larger of the keyboard inset and the bottom safe area, never their sum",
  },
  {
    cell: "primitive — context strip scroll + 44px pills",
    file: "MCSTRIP",
    test: "scrolls the rail rather than the page at 320px, with every pill a 44px target",
  },
];

// Phone-tier primitive suites the Liquid Glass workstream introduced. Every one
// must be represented in the matrix, so a new phone primitive cannot ship
// acceptance coverage the matrix does not point at.
const PHONE_PRIMITIVE_SUITES: readonly SuiteAlias[] = [
  "MSHEET",
  "MSEL",
  "MSEG",
  "MSTAT",
  "GS",
  "MLROW",
  "MDOCK",
  "MCSTRIP",
];

// Supporting suites the matrix leans on at file granularity: they must stay
// present and green, but the mapping references them as whole suites rather
// than by an individual test name. The hosted reconnect-policy and lifecycle
// controller unit suites moved into @ryco/client-runtime with the hosted unit
// (packages/client-runtime/src/{relay/reconnectPolicy,authorization/state}.test.ts,
// run by the workspace test gate); the web-composed integration suites below
// remain the in-matrix gate for that behavior.
const SUPPORTING_SUITES: readonly string[] = [
  "../hostedHub/nodeRouteRestore.integration.test.ts",
  "../hostedHub/returnToDirectory.integration.test.ts",
  "../hostedHub/lifecycle.integration.test.ts",
  "../pwa/lifecycle.test.ts",
  "../pwa/serviceWorkerPolicy.test.ts",
  "../pwa/buildArtifacts.test.ts",
];

// What Chromium emulation cannot prove. Physical qualification owns these; they
// are listed so qualification has a checklist rather than an inference, and so
// no automated cell can quietly claim to cover them.
const PHYSICAL_QUALIFICATION_DEFERRED: readonly string[] = [
  "Real iOS software-keyboard raise on first tap and real VisualViewport keyboard geometry.",
  "True safe-area insets on hardware.",
  "WebKit backdrop-filter scroll performance with stacked material — the Glass Material step's specific risk.",
  "Real momentum, detent feel, and swipe physics on a touchscreen.",
  "Screen-reader announcement order and timing for the polite and assertive live regions.",
  "Real thumb reach against the asserted lower-third geometry.",
];

describe("acceptance matrix — executable cell → proving-test mapping", () => {
  it("references only suite files that exist in the build", () => {
    const missing = [
      ...(Object.keys(SUITE_FILES) as SuiteAlias[]).map((alias) => SUITE_FILES[alias]),
      ...SUPPORTING_SUITES,
    ].filter((path) => typeof SUITE_SOURCES[path] !== "string");
    expect(missing, `Referenced suite files absent from the build:\n${missing.join("\n")}`).toEqual(
      [],
    );
  });

  it("maps every cell to a proving test that still exists in its suite", () => {
    const stale = PROVING_TESTS.filter(
      ({ file, test }) => !testNamesIn(file).some((name) => name.includes(test)),
    ).map(({ cell, file, test }) => `${cell} → ${file}: no test name contains "${test}"`);
    expect(stale, `Stale mapping entries:\n${stale.join("\n")}`).toEqual([]);
  });

  it("represents every phone-primitive suite in the matrix", () => {
    const referenced = new Set(PROVING_TESTS.map((cell) => cell.file));
    const unreferenced = PHONE_PRIMITIVE_SUITES.filter((alias) => !referenced.has(alias));
    expect(
      unreferenced,
      `Phone-primitive suites with no mapped cell: ${unreferenced.join(", ")}`,
    ).toEqual([]);
  });

  it("maps every reachability acceptance test to a cell (scoped reverse)", () => {
    // Full test-level bidirectionality over every primitive's internal unit
    // tests is intentionally not enforced — that is noise, since a primitive's
    // unit tests are not spec cells. The reverse is asserted where it is a
    // genuine completeness claim: PhoneReachability, whose every test is a
    // lower-third, dock-clearance, or coarse-landscape acceptance property.
    const mapped = PROVING_TESTS.filter((cell) => cell.file === "PRC").map((cell) => cell.test);
    const unmapped = testNamesIn("PRC").filter(
      (name) => !mapped.some((substring) => name.includes(substring)),
    );
    expect(
      unmapped,
      `PhoneReachability tests not mapped to a cell: ${unmapped.join(", ")}`,
    ).toEqual([]);
  });

  it("records what physical qualification must still prove", () => {
    // A live artifact, not a comment: physical qualification reads this list.
    expect(PHYSICAL_QUALIFICATION_DEFERRED.length).toBeGreaterThanOrEqual(5);
    for (const item of PHYSICAL_QUALIFICATION_DEFERRED) {
      expect(item.length, item).toBeGreaterThan(20);
    }
  });
});
