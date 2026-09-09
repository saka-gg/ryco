// Production CSS is part of the behavior under test: the `phone` / `not-phone`
// custom variants key off the `data-tier` attribute stamped on the root
// element by lib/presentationTier.ts.
import "../index.css";

import { page } from "vite-plus/test/browser";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

const navigate = vi.fn(async () => undefined);
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => navigate,
}));

import { hostedHubController, useHostedHubStore } from "../hostedHub/state";
import { resetHubRoutesForTests } from "../hostedHub/hubRoutes";
import { getPresentationTier, syncDocumentPresentationTier } from "../lib/presentationTier";
import { RIGHT_PANEL_SHEET_CLASS_NAME } from "../rightPanelLayout";
import { useTierOverrideStore } from "../tierOverrideStore";
import { resetPointerEmulation, setCoarsePointerEmulation } from "../../test/browserPointer";
import { PairingPendingSurface } from "./auth/PairingRouteSurface";
import { HostedHubRoot } from "./hostedHub/HostedHubRoot";
import { DiagnosticsSettings } from "./settings/DiagnosticsSettings";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { Sheet, SheetDescription, SheetHeader, SheetPopup, SheetTitle } from "./ui/sheet";

const DESKTOP_VIEWPORT = { width: 1_280, height: 720 };

async function waitForTier(tier: "phone" | "desktop"): Promise<void> {
  await vi.waitFor(() => {
    expect(document.documentElement.getAttribute("data-tier")).toBe(tier);
    expect(getPresentationTier()).toBe(tier);
  });
}

function appendVariantProbes(): { phoneHidden: HTMLElement; desktopHidden: HTMLElement } {
  const phoneHidden = document.createElement("div");
  phoneHidden.className = "phone:hidden";
  phoneHidden.textContent = "phone-hidden probe";
  const desktopHidden = document.createElement("div");
  desktopHidden.className = "not-phone:hidden";
  desktopHidden.textContent = "desktop-hidden probe";
  document.body.append(phoneHidden, desktopHidden);
  return { phoneHidden, desktopHidden };
}

describe("presentation tier", () => {
  beforeAll(() => {
    // Mirrors main.tsx: the single document-level tier sync.
    syncDocumentPresentationTier();
  });

  beforeEach(async () => {
    // Defensive: no earlier test or file may leak touch emulation or an
    // active preview override into the classification assertions.
    await resetPointerEmulation();
    useTierOverrideStore.setState({ override: null });
    localStorage.clear();
    hostedHubController.resetForTests();
    resetHubRoutesForTests();
    await page.viewport(DESKTOP_VIEWPORT.width, DESKTOP_VIEWPORT.height);
  });

  afterEach(async () => {
    useTierOverrideStore.setState({ override: null });
    hostedHubController.resetForTests();
    resetHubRoutesForTests();
    document.body.innerHTML = "";
    await page.viewport(DESKTOP_VIEWPORT.width, DESKTOP_VIEWPORT.height);
  });

  it("classifies viewports and pointers into the phone/desktop matrix", async () => {
    // 767px is the last phone-tier width; 768px is desktop.
    await page.viewport(767, 900);
    await waitForTier("phone");

    await page.viewport(768, 900);
    await waitForTier("desktop");

    // Wide landscape with a fine pointer stays desktop (width clause does not
    // match; the pointer clause requires coarse).
    await page.viewport(844, 390);
    await waitForTier("desktop");

    // The same viewport with a coarse pointer is a landscape phone.
    await setCoarsePointerEmulation(true);
    try {
      await waitForTier("phone");

      // Coarse-pointer tablets at or above 768px width keep the desktop tier.
      await page.viewport(768, 1_024);
      await waitForTier("desktop");
    } finally {
      await setCoarsePointerEmulation(false);
    }
    await waitForTier("desktop");
  });

  it("stamps data-tier on the document element, covering pair and hosted subtrees", async () => {
    await waitForTier("desktop");

    // Probes outside any React root: documentElement stamping covers every
    // subtree, including portals.
    const { phoneHidden, desktopHidden } = appendVariantProbes();
    expect(getComputedStyle(phoneHidden).display).not.toBe("none");
    expect(getComputedStyle(desktopHidden).display).toBe("none");

    await page.viewport(700, 900);
    await waitForTier("phone");
    await vi.waitFor(() => {
      expect(getComputedStyle(phoneHidden).display).toBe("none");
      expect(getComputedStyle(desktopHidden).display).not.toBe("none");
    });

    // The /pair surface falls inside the phone-variant selector scope.
    const pairScreen = await render(<PairingPendingSurface />);
    const pairSection = document.querySelector("section");
    expect(pairSection).not.toBeNull();
    expect(pairSection!.matches('[data-tier="phone"] *')).toBe(true);
    await pairScreen.unmount();

    // So does the hosted root subtree.
    useHostedHubStore.setState({ bootstrapAvailable: true });
    const hostedScreen = await render(<HostedHubRoot />);
    const hostedHeading = page.getByRole("heading", { name: "Connect to your Ryco nodes" });
    await expect.element(hostedHeading).toBeVisible();
    expect(hostedHeading.element().matches('[data-tier="phone"] *')).toBe(true);
    await hostedScreen.unmount();

    phoneHidden.remove();
    desktopHidden.remove();
  });

  it("bottom-sticks dialogs on a wide coarse-pointer landscape viewport", async () => {
    // The key capability width-only styling cannot express: an 844px-wide
    // coarse landscape phone gets the bottom-stuck full-bleed dialog.
    await page.viewport(844, 390);
    await setCoarsePointerEmulation(true);
    try {
      await waitForTier("phone");

      const screen = await render(
        <Dialog open onOpenChange={() => undefined}>
          <DialogPopup>
            <DialogHeader>
              <DialogTitle>Confirm change</DialogTitle>
            </DialogHeader>
            <DialogPanel>
              <p>Dialog body</p>
            </DialogPanel>
            <DialogFooter>
              <button type="button">Confirm</button>
            </DialogFooter>
          </DialogPopup>
        </Dialog>,
      );

      const popup = document.querySelector<HTMLElement>('[data-slot="dialog-popup"]');
      expect(popup).not.toBeNull();
      await vi.waitFor(() => {
        const rect = popup!.getBoundingClientRect();
        expect(rect.bottom).toBeGreaterThan(389);
        expect(rect.width).toBeGreaterThanOrEqual(843);
      });
      expect(getComputedStyle(popup!).borderRadius).toBe("0px");
      await screen.unmount();
    } finally {
      await setCoarsePointerEmulation(false);
    }
  });

  it("narrows the right-panel sheet on the phone tier without the removed 760px breakpoint", async () => {
    const screen = await render(
      <Sheet open onOpenChange={() => undefined}>
        <SheetPopup side="right" showCloseButton={false} className={RIGHT_PANEL_SHEET_CLASS_NAME}>
          <SheetHeader className="sr-only">
            <SheetTitle>Right panel</SheetTitle>
            <SheetDescription>Right panel body.</SheetDescription>
          </SheetHeader>
          <div>panel body</div>
        </SheetPopup>
      </Sheet>,
    );
    const popup = document.querySelector<HTMLElement>('[data-slot="sheet-popup"]');
    expect(popup).not.toBeNull();

    // Desktop baseline: min(42vw, 28rem) resolves to 448px at 1280px.
    await vi.waitFor(() => {
      const width = popup!.getBoundingClientRect().width;
      expect(width).toBeGreaterThanOrEqual(447);
      expect(width).toBeLessThanOrEqual(449);
    });

    // A wide coarse landscape phone gets min(88vw, 24rem) = 384px.
    await page.viewport(844, 390);
    await setCoarsePointerEmulation(true);
    try {
      await waitForTier("phone");
      await vi.waitFor(() => {
        const width = popup!.getBoundingClientRect().width;
        expect(width).toBeGreaterThanOrEqual(383);
        expect(width).toBeLessThanOrEqual(385);
      });
    } finally {
      await setCoarsePointerEmulation(false);
    }
    await screen.unmount();
  });

  it("forces the tier via the dev-only diagnostics override without touching theme or display-mode", async () => {
    await waitForTier("desktop");

    const darkClassBaseline = document.documentElement.classList.contains("dark");
    const prefersDarkBaseline = window.matchMedia("(prefers-color-scheme: dark)").matches;
    const standaloneBaseline = window.matchMedia("(display-mode: standalone)").matches;

    const screen = await render(<DiagnosticsSettings />);
    await expect.element(page.getByText("Performance now", { exact: true })).toBeInTheDocument();
    await expect.element(page.getByText("Why was this slow?", { exact: true })).toBeInTheDocument();
    // The preview override renders only in development builds; production
    // builds tree-shake this section (verified against the build output).
    await expect
      .element(page.getByRole("group", { name: "Presentation tier preview" }))
      .toBeInTheDocument();

    const { phoneHidden, desktopHidden } = appendVariantProbes();

    await page.getByRole("button", { name: "Phone preview" }).click();
    await waitForTier("phone");
    // Faithful preview: tier-critical CSS follows the forced tier at a
    // desktop viewport.
    await vi.waitFor(() => {
      expect(getComputedStyle(phoneHidden).display).toBe("none");
      expect(getComputedStyle(desktopHidden).display).not.toBe("none");
    });

    // The override never touches theme or display-mode signals.
    expect(document.documentElement.classList.contains("dark")).toBe(darkClassBaseline);
    expect(window.matchMedia("(prefers-color-scheme: dark)").matches).toBe(prefersDarkBaseline);
    expect(window.matchMedia("(display-mode: standalone)").matches).toBe(standaloneBaseline);

    await page.getByRole("button", { name: "Desktop preview" }).click();
    await waitForTier("desktop");
    expect(useTierOverrideStore.getState().override).toBe("desktop");

    // Auto restores the media classification.
    await page.getByRole("button", { name: "Auto" }).click();
    await waitForTier("desktop");
    expect(useTierOverrideStore.getState().override).toBeNull();

    phoneHidden.remove();
    desktopHidden.remove();
    await screen.unmount();
  });
});
