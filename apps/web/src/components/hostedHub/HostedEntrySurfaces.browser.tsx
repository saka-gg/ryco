// The hosted entry surfaces on the phone tier: reachability of the primary
// action, the touch floor, and the desktop regression that pins all of it as
// phone-only.
//
// Measured baseline this family replaces, taken on this fixture set with true
// coarse-pointer emulation and the tier attribute asserted live:
//
//   320x568  "Sign in with passkey"   y 491.8-535.8 (last on-screen row, with
//                                     the invitation and first-owner actions
//                                     already past the fold)
//   320x568  "I saved the codes"      y 587.0-631.0 against a 568px viewport —
//                                     entirely below the fold
//   390x844  "Sign out"               36x36, x 317-353, y 241.3-277.3 — inside
//                                     the top third and the right half, i.e.
//                                     the top-right corner
//   390x844  "Refresh nodes"          153.5x36
//   390x844  "Enroll node"            130.1x36
//
// Production CSS is part of the behaviour under test — the anchoring is a
// `phone:sticky` rule and the touch floor is real box sizing — so the real
// stylesheet is imported rather than approximated.
import "../../index.css";

import { EnvironmentId } from "@ryco/contracts";
import { page } from "vite-plus/test/browser";
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

// Hosted mode, which no browser test gets by default: there is no `.env` in
// this harness, so `isHostedHubMode()` answers false and every hosted gate runs
// as the standard client. See `HostedNodeDirectory.browser.tsx` for the full
// note.
vi.mock("../../env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../env")>()),
  readRycoClientMode: () => "hosted-hub" as const,
  isHostedHubMode: () => true,
}));

import { resetPointerEmulation, setCoarsePointerEmulation } from "../../../test/browserPointer";
import { measureEffectiveHitTarget } from "../../../test/touchTargets";
import { syncDocumentPresentationTier } from "../../lib/presentationTier";
import { hostedHubController, useHostedHubStore } from "../../hostedHub/state";
import { navigateHub, resetHubRoutesForTests } from "../../hostedHub/hubRoutes";
import type { HostedHubNode } from "../../hostedHub/types";
import { HostedHubRoot } from "./HostedHubRoot";

const TOUCH_FLOOR_PX = 44;

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

function node(index: number): HostedHubNode {
  const id = `node_${String(index).padStart(22, "a")}`;
  return {
    id,
    environmentId: EnvironmentId.make(`env_${String(index).padStart(22, "a")}`),
    label: `Studio node ${index}`,
    platformOs: "linux",
    platformArch: "x64",
    clientVersion: "0.9.0",
    createdAt: 1,
    updatedAt: 1,
    lastAuthenticatedAt: 1,
    revokedAt: null,
    revocationReasonCode: null,
    grant: { id: `grant_${index}`, role: "operator" },
    effectiveRole: "operator",
    presence: { online: true, lastHeartbeatAt: 1 },
  };
}

/**
 * Twenty nodes and ten recovery codes, not one of each. Every bound below is a
 * bound on the tall state: with a single node the directory never overflows the
 * viewport, and an assertion that the action group is on screen would then hold
 * for any layout at all.
 */
const NODES: ReadonlyArray<HostedHubNode> = Array.from({ length: 20 }, (_unused, index) =>
  node(index + 1),
);
const RECOVERY_CODES: ReadonlyArray<string> = Array.from(
  { length: 10 },
  (_unused, index) => `code-${index}-abcd-efgh-ijkl`,
);

type EntrySurface = "sign-in" | "recovery-codes" | "node-directory";

/**
 * The primary action of each entry surface, by accessible name, so the
 * inventory reads the way a screen-reader user hears it and cannot be narrowed
 * without editing this list.
 */
const PRIMARY_ACTION: Record<EntrySurface, string> = {
  "sign-in": "Sign in with passkey",
  "recovery-codes": "I saved the codes",
  "node-directory": "Refresh nodes",
};

/**
 * Each surface in its **tallest reachable state**, which is where the fold
 * defect lived: sign-in with an error rendered and first-owner bootstrap
 * offered, recovery codes with a full code set, and the directory with a node
 * list that overflows every phone viewport.
 */
function seedSurface(surface: EntrySurface): void {
  if (surface === "sign-in") {
    useHostedHubStore.setState({
      bootstrapAvailable: true,
      errorMessage:
        "The passkey ceremony was cancelled before it completed. Try again, or redeem an invitation.",
    });
    return;
  }
  if (surface === "recovery-codes") {
    useHostedHubStore.setState({
      accountStatus: "authenticated",
      account,
      session,
      recoveryCodes: [...RECOVERY_CODES],
    });
    return;
  }
  navigateHub({ kind: "nodes" }, { replace: true });
  useHostedHubStore.setState({
    accountStatus: "authenticated",
    account,
    session,
    directoryStatus: "ready",
    browserStatus: "current",
    nodes: [...NODES],
  });
}

async function usePhoneViewport(width: number, height: number): Promise<void> {
  await page.viewport(width, height);
  await setCoarsePointerEmulation(true);
  await vi.waitFor(() => {
    expect(document.documentElement.getAttribute("data-tier")).toBe("phone");
  });
  // Coarse gating asserted live, not assumed: width-only emulation reports
  // `pointer: fine`, under which every coarse rule is inert.
  expect(window.matchMedia("(pointer: coarse)").matches).toBe(true);
  expect(window.innerWidth).toBe(width);
  expect(window.innerHeight).toBe(height);
}

function control(name: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(`[aria-label="${name}"]`);
  if (element) return element;
  const byText = [...document.querySelectorAll<HTMLElement>("button")].find(
    (candidate) => candidate.textContent?.trim() === name,
  );
  if (!byText) throw new Error(`No control named "${name}" is rendered.`);
  return byText;
}

/**
 * Every control a person can actually operate on the current surface, so the
 * touch-floor sweep cannot be narrowed by forgetting to list one.
 */
function operableControls(): ReadonlyArray<HTMLElement> {
  return [...document.querySelectorAll<HTMLElement>("button, input")].filter(
    (element) => (element.checkVisibility?.() ?? true) && !(element as HTMLButtonElement).disabled,
  );
}

function describeControl(element: HTMLElement): string {
  return element.getAttribute("aria-label") ?? element.textContent?.trim().slice(0, 40) ?? "?";
}

/**
 * The element that clips the surface horizontally. Containment must be
 * asserted here rather than on each control's rectangle: `overflow-x: hidden`
 * still answers programmatic scrolling (only `clip` blocks both), so any
 * assertion taken after `scrollIntoView` measures a panned viewport.
 */
function surfaceScroller(): HTMLElement {
  const element = document.querySelector<HTMLElement>("main");
  if (!element) throw new Error("Expected the hosted entry surface to be rendered.");
  return element;
}

let mounted: Awaited<ReturnType<typeof render>> | null = null;

async function renderSurface(surface: EntrySurface): Promise<void> {
  seedSurface(surface);
  mounted = await render(<HostedHubRoot />);
  await expect.element(page.getByRole("button", { name: PRIMARY_ACTION[surface] })).toBeVisible();
}

describe("hosted entry surfaces", () => {
  beforeAll(() => {
    syncDocumentPresentationTier();
  });

  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    hostedHubController.resetForTests();
    resetHubRoutesForTests();
    navigate.mockClear();
  });

  afterEach(async () => {
    await mounted?.unmount();
    mounted = null;
    hostedHubController.resetForTests();
    resetHubRoutesForTests();
    vi.restoreAllMocks();
    document.body.innerHTML = "";
    document.documentElement.style.fontSize = "";
    await resetPointerEmulation();
    await page.viewport(1_280, 720);
  });

  it("keeps every entry surface's primary action within the fold at rest on a phone", async () => {
    for (const viewport of [
      { width: 320, height: 568 },
      { width: 390, height: 844 },
    ]) {
      for (const surface of ["sign-in", "recovery-codes", "node-directory"] as const) {
        await usePhoneViewport(viewport.width, viewport.height);
        await renderSurface(surface);

        const scroller = document.querySelector<HTMLElement>("main");
        expect(scroller, "the entry surface owns a scroll container").not.toBeNull();
        expect(
          scroller!.scrollTop,
          "the action must be reachable at rest, before any scrolling",
        ).toBe(0);
        if (viewport.width === 320) {
          // The narrowest supported phone is where every one of these surfaces
          // genuinely overflows, so the anchoring is exercised against content
          // taller than the viewport rather than against a short state that
          // would fit under any layout.
          expect(
            scroller!.scrollHeight,
            `${surface} at ${viewport.width}x${viewport.height} must actually overflow, or the anchoring is untested`,
          ).toBeGreaterThan(scroller!.clientHeight);
        }

        // The surface fills the viewport instead of floating a centred desktop
        // card, and its content column is the growing flex column the action
        // group's `mt-auto` resolves against. The desktop regression below
        // asserts the exact opposite of all three on the desktop baseline.
        const card = document.querySelector<HTMLElement>("main section")!;
        const cardStyle = getComputedStyle(card);
        expect(cardStyle.borderTopWidth, `${surface}: phone card border`).toBe("0px");
        expect(cardStyle.borderTopLeftRadius, `${surface}: phone card radius`).toBe("0px");
        expect(cardStyle.display, `${surface}: phone content column`).toBe("flex");

        const action = control(PRIMARY_ACTION[surface]);
        const rect = action.getBoundingClientRect();
        const where = `${surface} "${PRIMARY_ACTION[surface]}" at ${viewport.width}x${viewport.height}`;
        expect(rect.top, `${where}: above the viewport`).toBeGreaterThanOrEqual(0);
        expect(rect.bottom, `${where}: below the fold`).toBeLessThanOrEqual(window.innerHeight);
        expect(rect.left, `${where}: off-screen left`).toBeGreaterThanOrEqual(0);
        expect(rect.right, `${where}: off-screen right`).toBeLessThanOrEqual(window.innerWidth);
        // Bottom-anchored, not merely on screen: the centre sits in the lower
        // third the design reserves for thumb reach.
        expect(
          rect.top + rect.height / 2,
          `${where}: centre above the bottom third`,
        ).toBeGreaterThan((window.innerHeight * 2) / 3);

        // And it stays anchored while the content above it scrolls.
        scroller!.scrollTop = scroller!.scrollHeight;
        await vi.waitFor(() => {
          const scrolled = control(PRIMARY_ACTION[surface]).getBoundingClientRect();
          expect(scrolled.top).toBeGreaterThanOrEqual(0);
          expect(scrolled.bottom).toBeLessThanOrEqual(window.innerHeight);
        });

        expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
        await mounted?.unmount();
        mounted = null;
        hostedHubController.resetForTests();
        resetHubRoutesForTests();
      }
    }
  });

  it("moves sign-out out of the node directory's top-right corner on the phone tier", async () => {
    await usePhoneViewport(390, 844);
    await renderSurface("node-directory");

    // Exactly one sign-out control exists, and it is a labelled action rather
    // than a bare icon: its visible text carries the name.
    const signOutControls = [...document.querySelectorAll<HTMLElement>("button")].filter(
      (button) =>
        button.getAttribute("aria-label") === "Sign out" ||
        button.textContent?.trim() === "Sign out",
    );
    expect(signOutControls).toHaveLength(1);
    const signOut = signOutControls[0]!;
    expect(signOut.textContent?.trim()).toBe("Sign out");

    // Hit-test the whole top-right region rather than deriving the claim from
    // the control's own rectangle: sampling fails if it is put back anywhere
    // in that corner, and does not depend on any other assertion holding.
    const samples = 12;
    for (let column = 0; column <= samples; column += 1) {
      for (let row = 0; row <= samples; row += 1) {
        const x = window.innerWidth / 2 + ((window.innerWidth / 2 - 1) * column) / samples;
        const y = ((window.innerHeight / 3) * row) / samples;
        const hit = document.elementFromPoint(x, y);
        expect(
          hit !== null && signOut.contains(hit),
          `sign-out answers the top-right corner at (${Math.round(x)}, ${Math.round(y)})`,
        ).toBe(false);
      }
    }

    const rect = signOut.getBoundingClientRect();
    expect(rect.top + rect.height / 2).toBeGreaterThan((window.innerHeight * 2) / 3);
    const hit = measureEffectiveHitTarget(signOut);
    expect(hit.width).toBeGreaterThanOrEqual(TOUCH_FLOOR_PX);
    expect(hit.height).toBeGreaterThanOrEqual(TOUCH_FLOOR_PX);

    const signOutSpy = vi.spyOn(hostedHubController, "signOut").mockResolvedValue();
    signOut.click();
    expect(signOutSpy).toHaveBeenCalledOnce();
  });

  it("meets the 44px touch floor on every operable entry control, measured by hit test", async () => {
    for (const surface of ["sign-in", "recovery-codes", "node-directory"] as const) {
      await usePhoneViewport(320, 568);
      await renderSurface(surface);

      const controls = operableControls();
      expect(controls.length, `${surface} renders no operable control`).toBeGreaterThan(0);
      for (const element of controls) {
        // Centred, not `nearest`: the anchored action group is pinned over the
        // bottom of the scrollport, so a control aligned to the nearest edge
        // can land underneath it and measure as occluded.
        element.scrollIntoView({ block: "center", inline: "nearest" });
        const hit = measureEffectiveHitTarget(element);
        const where = `${surface} "${describeControl(element)}"`;
        expect(hit.width, `${where}: effective width`).toBeGreaterThanOrEqual(TOUCH_FLOOR_PX);
        expect(hit.height, `${where}: effective height`).toBeGreaterThanOrEqual(TOUCH_FLOOR_PX);
        // The floor comes from the real box, not from hit slop. Slop reaches
        // the floor here — nothing clips it on these surfaces — but it is
        // clipped elsewhere in the app by an `overflow` ancestor, so the entry
        // controls are sized rather than left depending on it.
        expect(
          element.getBoundingClientRect().height,
          `${where}: border-box height`,
        ).toBeGreaterThanOrEqual(TOUCH_FLOOR_PX);
      }

      await mounted?.unmount();
      mounted = null;
      hostedHubController.resetForTests();
      resetHubRoutesForTests();
    }
  });

  it("survives 200% text scaling at 320px without hiding a control or overflowing the page", async () => {
    // The layout is rem-based, so doubling the root font emulates 200% browser
    // text scaling.
    for (const surface of ["sign-in", "recovery-codes", "node-directory"] as const) {
      await usePhoneViewport(320, 568);
      document.documentElement.style.fontSize = "32px";
      await renderSurface(surface);

      // No control collapses away. Deliberately NOT a check on each control's
      // right edge after `scrollIntoView`: `main` is `overflow-x: hidden`,
      // which a script can still pan even though a user cannot, so scrolling a
      // control into view before measuring its right edge reports an over-wide
      // control as compliant. Measured on this fixture: "Refresh nodes" reads
      // right=339.0 at scrollLeft=0 and right=320.0 after `scrollIntoView`
      // panned `main` to scrollLeft=19. Horizontal containment is asserted on
      // the clipping element instead, below and in the two tests after this
      // one.
      for (const element of operableControls()) {
        const rect = element.getBoundingClientRect();
        const where = `${surface} "${describeControl(element)}" at 200% text`;
        expect(rect.width, `${where}: collapsed`).toBeGreaterThan(0);
        expect(rect.height, `${where}: collapsed`).toBeGreaterThan(0);
      }

      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
      expect(document.body.scrollWidth).toBeLessThanOrEqual(window.innerWidth);

      const action = control(PRIMARY_ACTION[surface]).getBoundingClientRect();
      expect(
        action.bottom,
        `${surface} primary action below the fold at 200% text`,
      ).toBeLessThanOrEqual(window.innerHeight);

      await mounted?.unmount();
      mounted = null;
      document.documentElement.style.fontSize = "";
      hostedHubController.resetForTests();
      resetHubRoutesForTests();
    }
  });

  it("keeps the polite ceremony announcement and Hub recovery mounted in registration mode", async () => {
    // Redeeming an invitation and bootstrapping the first owner both drive
    // `accountStatus` to `authenticating` through the same path sign-in uses
    // (`hostedHub/state.ts` `#registerAccount`), and the WebAuthn ceremony then
    // runs for seconds. The registration form itself carries only a
    // `role="alert"` for failures, which never fires on success, so a polite
    // region that unmounts while the form is open leaves a screen-reader user
    // with nothing at all. `Retry Hub` is the recovery path out of an
    // unavailable Hub and must survive the same state.
    await usePhoneViewport(320, 568);
    useHostedHubStore.setState({ bootstrapAvailable: true });
    mounted = await render(<HostedHubRoot />);
    await page.getByRole("button", { name: "Redeem invitation" }).click();
    await expect.element(page.getByLabelText("Invitation code")).toBeVisible();

    const politeRegion = () =>
      [...document.querySelectorAll<HTMLElement>('[aria-live="polite"]')].find((region) =>
        region.classList.contains("sr-only"),
      ) ?? null;
    expect(politeRegion(), "polite region unmounted by registration mode").not.toBeNull();

    useHostedHubStore.setState({ accountStatus: "authenticating" });
    await vi.waitFor(() => {
      expect(politeRegion()?.textContent).toContain("Passkey authentication is in progress");
    });

    useHostedHubStore.setState({ accountStatus: "unavailable" });
    await vi.waitFor(() => {
      const retry = [...document.querySelectorAll<HTMLElement>("button")].find(
        (button) => button.textContent?.trim() === "Retry Hub",
      );
      expect(retry, "Retry Hub unmounted by registration mode").not.toBeUndefined();
    });
    // The form is still the surface being shown, so this is genuinely the
    // registration state rather than a silent fall-back to sign-in.
    expect(document.querySelector("#hub-registration-credential")).not.toBeNull();
  });

  it("bottom-anchors the registration form's action group on a phone", async () => {
    // The registration branch renders its own `phone:flex phone:flex-1` form
    // and its own anchored action row, neither of which the sign-in fixture
    // exercises. All three portrait viewports are measured because they
    // exercise different halves of the anchoring: at 320x568 the form
    // overflows and `sticky` carries it; at 390x844 and 430x932 it fits, and
    // the growing flex column plus `mt-auto` is what puts the row in the thumb
    // zone.
    for (const viewport of [
      { width: 320, height: 568 },
      { width: 390, height: 844 },
      { width: 430, height: 932 },
    ]) {
      await usePhoneViewport(viewport.width, viewport.height);
      useHostedHubStore.setState({ bootstrapAvailable: true });
      mounted = await render(<HostedHubRoot />);
      await page.getByRole("button", { name: "Redeem invitation" }).click();
      await expect.element(page.getByLabelText("Invitation code")).toBeVisible();

      const submit = [...document.querySelectorAll<HTMLElement>("button")].find(
        (button) => button.textContent?.trim() === "Create account and passkey",
      );
      expect(submit).not.toBeUndefined();

      const scroller = surfaceScroller();
      expect(scroller.scrollTop, "measured at rest, before any scrolling").toBe(0);
      if (viewport.width === 320) {
        expect(
          scroller.scrollHeight,
          "the registration form must actually overflow at 320x568, or `sticky` is untested",
        ).toBeGreaterThan(scroller.clientHeight);
      } else {
        expect(
          scroller.scrollHeight,
          `the registration form must fit at ${viewport.width}x${viewport.height}, or \`mt-auto\` is untested`,
        ).toBe(scroller.clientHeight);
      }

      const rect = submit!.getBoundingClientRect();
      const where = `registration action at ${viewport.width}x${viewport.height}`;
      expect(rect.top, `${where}: above the viewport`).toBeGreaterThanOrEqual(0);
      expect(rect.bottom, `${where}: below the fold`).toBeLessThanOrEqual(window.innerHeight);
      expect(rect.height, `${where}: border-box height`).toBeGreaterThanOrEqual(TOUCH_FLOOR_PX);

      // Anchored, measured against what each rule actually guarantees rather
      // than against a bottom-third band. The band is too loose here: with the
      // anchoring removed the row still lands at y=633.5, which is inside the
      // bottom third at all three of these viewports, so a band assertion
      // could not fail.
      const group = submit!.parentElement!.getBoundingClientRect();
      const sectionBottom = document.querySelector("main section")!.getBoundingClientRect().bottom;
      if (viewport.width === 320) {
        // Overflowing: `sticky bottom-0` pins the group to the bottom of the
        // scrollport while the form scrolls beneath it.
        expect(
          Math.abs(window.innerHeight - group.bottom),
          `${where}: group not pinned to the scrollport bottom`,
        ).toBeLessThanOrEqual(1);
      } else {
        // Fitting: `mt-auto` inside the growing flex column puts the group
        // flush with the bottom of the content column. Measured without it,
        // the group's bottom sits at 681.5 against a column bottom of 804.0
        // (390x844) and 892.0 (430x932).
        expect(
          Math.abs(sectionBottom - group.bottom),
          `${where}: group not flush with the content column's bottom`,
        ).toBeLessThanOrEqual(1);
      }

      // And it stays anchored while the form scrolls.
      scroller.scrollTop = scroller.scrollHeight;
      await vi.waitFor(() => {
        const scrolled = submit!.getBoundingClientRect();
        expect(scrolled.top).toBeGreaterThanOrEqual(0);
        expect(scrolled.bottom).toBeLessThanOrEqual(window.innerHeight);
      });

      await mounted?.unmount();
      mounted = null;
      hostedHubController.resetForTests();
      resetHubRoutesForTests();
    }
  });

  it("contains every entry surface horizontally inside its own clipping box at 320px", async () => {
    // Horizontal containment measured where it is actually decided. A
    // per-control `rect.right <= innerWidth` check taken after
    // `scrollIntoView` cannot fail: `main` is `overflow-x: hidden`, which a
    // script may still pan even though a user cannot, so the check pans the
    // control into view and then reports it compliant. Measured on this
    // fixture: "Refresh nodes" reads right=339.0 at scrollLeft=0 and
    // right=320.0 after `scrollIntoView` moved `main` to scrollLeft=19.
    //
    // Falsifiability: this exact assertion, on this exact fixture, fails at
    // 200% text — see the pinned pre-existing residual in the test below.
    for (const surface of ["sign-in", "recovery-codes", "node-directory"] as const) {
      await usePhoneViewport(320, 568);
      await renderSurface(surface);

      const scroller = surfaceScroller();
      expect(scroller.scrollLeft, "measured unpanned").toBe(0);
      expect(
        scroller.scrollWidth,
        `${surface}: content wider than the surface's clipping box`,
      ).toBeLessThanOrEqual(scroller.clientWidth);

      await mounted?.unmount();
      mounted = null;
      hostedHubController.resetForTests();
      resetHubRoutesForTests();
    }
  });

  it("contains the surfaces this branch reshaped at 200% text scaling at 320px", async () => {
    // At 320px with a 32px root every `rem`-derived length doubles, so the
    // track's `px-4` resolves to 32px per side and the content box is 256px.
    // Measured on this fixture, at a 32px root, before and after this fix:
    //
    //   node-directory  483 -> 320   (contained)
    //   recovery-codes  320 -> 320   (contained throughout)
    //   sign-in         351 -> 333   (residual pinned below)
    //
    // The 483 was ONE box, and it was not the node rows: reverting the row
    // changes alone still measures 320 here, because each row is
    // `overflow-hidden` and clips its own contents instead of widening the
    // page (that failure is asserted separately below, since this measurement
    // cannot see it). It was the two-up Account | Sign out row — `flex gap-2`
    // with two `flex-1` children and no wrap — whose min-content is both
    // labels side by side and which therefore could not fit a 320px phone at
    // any font scale above ~150%. It wraps now.
    await usePhoneViewport(320, 568);
    document.documentElement.style.fontSize = "32px";
    for (const surface of ["recovery-codes", "node-directory"] as const) {
      await renderSurface(surface);

      const scroller = surfaceScroller();
      // `overflow-x: hidden` still answers programmatic scrolling, so this must
      // be measured unpanned or it reports a clipped surface as compliant.
      expect(scroller.scrollLeft, "measured unpanned").toBe(0);
      expect(
        scroller.scrollWidth,
        `${surface}: content wider than the surface's clipping box, and clipped rather than reachable`,
      ).toBeLessThanOrEqual(scroller.clientWidth);

      await mounted?.unmount();
      mounted = null;
      hostedHubController.resetForTests();
      resetHubRoutesForTests();
    }
  });

  it("keeps the directory's phone account row whole at 200% text scaling", async () => {
    // The two-up `flex gap-2` / `flex-1` row this surface introduced put
    // Account and Sign out on one line with no way to wrap. At a 32px root the
    // line cannot hold both, and `main` is `overflow-x: hidden`, so Sign out
    // was cut off with half its icon missing. Before it was paired it was
    // full-width and fit.
    await usePhoneViewport(320, 568);
    document.documentElement.style.fontSize = "32px";
    await renderSurface("node-directory");

    const account = control("Account");
    const signOut = control("Sign out");
    const rect = signOut.getBoundingClientRect();
    expect(rect.left, "Sign out starts off-screen left").toBeGreaterThanOrEqual(0);
    expect(rect.right, "Sign out is cut off on the right").toBeLessThanOrEqual(window.innerWidth);
    // Its own label is not clipped inside its own box either.
    expect(signOut.scrollWidth, "the Sign out label overflows its button").toBeLessThanOrEqual(
      signOut.clientWidth,
    );
    // The row wrapped rather than squeezing both onto one line.
    expect(
      rect.top,
      "the row refused to wrap and squeezed both controls onto one line",
    ).toBeGreaterThanOrEqual(account.getBoundingClientRect().bottom - 0.5);
  });

  it("keeps a node row's own contents inside the row at 200% text scaling", async () => {
    // The row is `overflow-hidden`, so what it cannot fit it destroys silently
    // — the page-level containment assertion above is blind to it. Everything
    // on the row that could not shrink scaled with the root font: the leading
    // tile (72px at a 32px root), the details column (88px), the two `gap-3`
    // gutters (48px) and the row's `px-4` (64px). The label was the only column
    // with `min-w-0`, so it was the only one that yielded — and at 320px it had
    // yielded all of it: measured labelW=0 and 5px of the presence indicator
    // clipped away, i.e. a list of machines with no names on it.
    //
    // The tile and the details column are pixel boxes now — a touch target and
    // an icon frame, neither of which is text — and the row's contents wrap, so
    // the presence indicator drops to a second line instead of squeezing the
    // name out. `NodePresence` itself is untouched: its tested contract that
    // online and offline stay visually distinguished does not have to bend.
    await usePhoneViewport(320, 568);
    document.documentElement.style.fontSize = "32px";
    await renderSurface("node-directory");

    const row = document.querySelector<HTMLElement>('ul[role="list"] > li');
    expect(row, "no node row rendered").not.toBeNull();
    expect(
      row!.scrollWidth,
      "the row clips content it cannot fit, and nothing can scroll to it",
    ).toBeLessThanOrEqual(row!.clientWidth);

    // The one thing a directory of machines cannot afford to lose.
    const label = [...row!.querySelectorAll<HTMLElement>("span")].find(
      (span) => span.textContent === "Studio node 1",
    );
    expect(label, "the node's own name is not rendered at all").not.toBeUndefined();
    expect(
      label!.getBoundingClientRect().width,
      "the node's own name was squeezed to nothing",
    ).toBeGreaterThan(0);

    // …and the presence indicator is inside the row rather than past its edge.
    const presence = [...row!.querySelectorAll<HTMLElement>("span")].find(
      (span) => span.textContent?.trim() === "Online",
    );
    expect(presence, "no presence indicator on the row").not.toBeUndefined();
    expect(
      presence!.getBoundingClientRect().right,
      "the presence indicator is clipped by the row",
    ).toBeLessThanOrEqual(row!.getBoundingClientRect().right + 0.5);
  });

  it.fails("PRE-EXISTING: sign-in's button labels outgrow their boxes at 200% text scaling", async () => {
    // Pinned, not fixed, and narrower than what it replaces: the two surfaces
    // this branch reshaped are contained now (asserted above), and sign-in is
    // back to the 333 it measured before this branch — the "New to this Hub?"
    // disclosure label that had pushed it to 351 wraps now.
    //
    // What is left is not this surface's to fix. `buttonVariants` bakes
    // `whitespace-nowrap` and a fixed `h-*` into every button in the design
    // system, so at a 32px root "Sign in with passkey" needs a 300px inline
    // run inside a 254px box and paints past it. Letting button labels wrap
    // is a design-system change with its own review and its own regression
    // surface on every screen; making it from here would be editing a shared
    // primitive under cover of an entry-surface fix.
    //
    // Exactly one assertion lives in this test so `it.fails` cannot pass for
    // some unrelated reason; fixing the primitive makes this test fail until
    // the annotation is removed.
    await usePhoneViewport(320, 568);
    document.documentElement.style.fontSize = "32px";
    await renderSurface("sign-in");

    const scroller = surfaceScroller();
    expect(scroller.scrollWidth).toBeLessThanOrEqual(scroller.clientWidth);
  });

  it("puts the desktop directory in the Hub shell with its account controls in the Hub bar", async () => {
    // Desktop regression for every phone-gated change: the anchoring and the
    // receding chrome are still phone-only, and the desktop tier now renders
    // the standalone Hub shell — a bar above a page — rather than the floating
    // settings-style card the directory used to share with the node app.
    await page.viewport(1_280, 720);
    await vi.waitFor(() => {
      expect(document.documentElement.getAttribute("data-tier")).toBe("desktop");
    });
    await renderSurface("node-directory");

    // The account and signing out live in one account menu, named for the
    // account, rather than in two icon buttons.
    const accountMenu = document.querySelector<HTMLElement>(
      'button[aria-label^="Account menu for "]',
    );
    expect(accountMenu, "desktop has an account menu in the Hub bar").not.toBeNull();
    expect(document.querySelector('button[aria-label="Sign out"]')).toBeNull();

    // The account controls belong to the Hub, not to the node list, so they
    // live in the Hub bar. The bar is a sibling of the scroll container rather
    // than a `sticky` child of it, which is what keeps the page's own
    // `overscroll-contain` scroller clean.
    const bar = document.querySelector<HTMLElement>("header");
    expect(bar, "the desktop Hub renders its own top bar").not.toBeNull();
    expect(bar!.contains(accountMenu!), "the account menu sits in the Hub bar").toBe(true);
    const scroller = surfaceScroller();
    expect(bar!.contains(scroller), "the bar is not an ancestor of the scroller").toBe(false);
    expect(scroller.contains(bar!), "the bar does not scroll with the page").toBe(false);
    // Still top-right of the chrome, and above the page it labels.
    expect(accountMenu!.getBoundingClientRect().right).toBeGreaterThan(window.innerWidth / 2);
    expect(accountMenu!.getBoundingClientRect().bottom).toBeLessThanOrEqual(
      scroller.getBoundingClientRect().top + 1,
    );

    // The page column is a page, not a floating card: no border, no radius.
    // The phone assertion above requires the same three values, which is what
    // makes the two tiers differ in chrome and layout rather than in geometry.
    const column = document.querySelector<HTMLElement>("main section")!;
    const columnStyle = getComputedStyle(column);
    expect(Number.parseFloat(columnStyle.borderTopLeftRadius)).toBe(0);
    expect(Number.parseFloat(columnStyle.borderTopWidth)).toBe(0);

    // The action group is still in flow: the bottom anchoring is phone-only.
    const refresh = control("Refresh nodes");
    const actionGroup = refresh.parentElement!;
    expect(getComputedStyle(actionGroup).position).toBe("static");

    // Desktop density is untouched: the entry buttons keep their compact size.
    expect(refresh.getBoundingClientRect().height).toBeLessThan(TOUCH_FLOOR_PX);
  });
});
