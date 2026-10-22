import "../../index.css";

import type { DesktopUpdateState } from "@ryco/contracts";
import { page } from "vite-plus/test/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

import type { UpdateEverythingController } from "../../updates/useUpdateEverything";

const mock = vi.hoisted(() => ({ controller: null as UpdateEverythingController | null }));

// The desktop app, so this app's own updater (download progress, the Intel-build
// warning) reaches the pill.
vi.mock("../../env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../env")>()),
  isElectron: true,
}));

vi.mock("../../updates/useUpdateEverything", () => ({
  useUpdateEverything: () => mock.controller!,
  useNodeUpdateState: () => null,
}));

import { AppAtomRegistryProvider } from "../../rpc/atomRegistry";
import { setDesktopUpdateState } from "../../rpc/desktopUpdateAtoms";
import { SidebarProvider } from "../ui/sidebar";
import {
  EMPTY_PLAN,
  FULL_PLAN,
  LINUX_DEVICE,
  M4_DEVICE,
  runDevice,
  runState,
  THIS_MAC_DEVICE,
  updatePlan,
} from "../updates/updateEverythingTestFixtures";
import { SidebarUpdateEverythingPill } from "./SidebarUpdateEverythingPill";

const DESKTOP_STATE: DesktopUpdateState = {
  enabled: true,
  status: "idle",
  channel: "latest",
  currentVersion: "0.1.34",
  availableVersion: null,
  downloadedVersion: null,
  downloadPercent: null,
  checkedAt: null,
  message: null,
  errorContext: null,
  canRetry: false,
};

function setController(overrides: Partial<UpdateEverythingController> = {}) {
  mock.controller = {
    plan: FULL_PLAN,
    run: null,
    result: null,
    running: false,
    start: vi.fn(),
    checkAll: vi.fn(async () => undefined),
    checking: false,
    dismissRun: vi.fn(),
    ...overrides,
  };
  return mock.controller;
}

const pill = () => document.querySelector<HTMLElement>('[data-slot="update-everything-pill"]');
const pillButton = (name: RegExp) => page.getByRole("button", { name });

function Harness() {
  return (
    <AppAtomRegistryProvider>
      <SidebarProvider>
        <div style={{ width: 240 }}>
          <SidebarUpdateEverythingPill />
        </div>
      </SidebarProvider>
    </AppAtomRegistryProvider>
  );
}

describe("the sidebar Update everything pill", () => {
  let mounted: Awaited<ReturnType<typeof render>> | null = null;

  beforeEach(() => {
    setDesktopUpdateState(null);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await mounted?.unmount();
    mounted = null;
    setDesktopUpdateState(null);
    document.body.innerHTML = "";
  });

  it("offers everything one click updates and opens the plan", async () => {
    const controller = setController();
    mounted = await render(<Harness />);

    const button = pillButton(/^Update everything\. 5 updates\./);
    await expect.element(button).toBeVisible();
    await expect.element(button).toMatchTextContent("Update everything5");
    expect(pill()?.dataset.kind).toBe("available");

    await button.click();
    const dialog = page.getByRole("dialog", { name: "Update everything" });
    await expect.element(dialog).toBeVisible();
    await expect.element(dialog).toMatchTextContent("MacBook Pro M4");
    await page.getByRole("button", { name: "Update all" }).click();
    expect(controller.start).toHaveBeenCalledOnce();
  });

  it("stays away without one-click work", async () => {
    setController({ plan: updatePlan([LINUX_DEVICE]) });
    mounted = await render(<Harness />);
    await expect.poll(() => pill()).toBeNull();

    setController({ plan: EMPTY_PLAN });
    await mounted.rerender(<Harness />);
    await expect.poll(() => pill()).toBeNull();
  });

  it("dismisses until the plan changes", async () => {
    setController();
    mounted = await render(<Harness />);
    await page.getByRole("button", { name: "Dismiss update notice" }).click();
    await expect.poll(() => pill()).toBeNull();

    // A newer release is something new.
    setController({
      plan: updatePlan([
        M4_DEVICE,
        {
          ...THIS_MAC_DEVICE,
          node: { kind: "this-app", fromVersion: "0.1.34", toVersion: "0.1.36" },
        },
      ]),
    });
    await mounted.rerender(<Harness />);
    await expect.element(pillButton(/^Update everything/)).toBeVisible();
  });

  it("follows a run in the same space, with done/total and a bar", async () => {
    setController();
    mounted = await render(<Harness />);
    await expect.element(pillButton(/^Update everything/)).toBeVisible();
    await expect
      .poll(
        () =>
          pill()?.closest('[data-slot="update-everything-pill-area"]')?.getBoundingClientRect()
            .height,
      )
      .toBeGreaterThan(0);
    const idleHeight = pill()!.getBoundingClientRect().height;

    const devices = [
      runDevice(THIS_MAC_DEVICE, "queued"),
      runDevice(LINUX_DEVICE, "skipped", "Up to date."),
      runDevice(M4_DEVICE, "updating", "Installing Ryco 0.1.35…"),
    ];
    setController({ run: runState(devices), running: true });
    await mounted.rerender(<Harness />);

    const running = pillButton(/^Updating MacBook Pro M4\. 0 of 2 done\./);
    await expect.element(running).toBeVisible();
    await expect.element(running).toMatchTextContent("Updating MacBook Pro M40/2");
    await expect
      .element(page.getByRole("progressbar", { name: "Update progress" }))
      .toHaveAttribute("aria-valuenow", "25");
    expect(page.getByRole("button", { name: "Dismiss update notice" }).elements()).toHaveLength(0);
    // The bar's row was reserved all along: no layout shift.
    expect(pill()!.getBoundingClientRect().height).toBe(idleHeight);

    setController({
      run: runState(
        [
          runDevice(
            THIS_MAC_DEVICE,
            "updating",
            "Installing Ryco 0.1.35. This app restarts when it's done.",
          ),
          runDevice(LINUX_DEVICE, "skipped", "Up to date."),
          runDevice(M4_DEVICE, "done", "Updated Ryco to 0.1.35."),
        ],
        "this-app",
      ),
      running: true,
    });
    await mounted.rerender(<Harness />);
    await expect.element(pillButton(/^Updating This Mac\. 1 of 2 done\./)).toBeVisible();
    await expect
      .element(page.getByRole("progressbar", { name: "Update progress" }))
      .toHaveAttribute("aria-valuenow", "75");
  });

  it("keeps a failed run's outcome until it is dismissed", async () => {
    const controller = setController({
      run: runState([runDevice(M4_DEVICE, "failed", "The update failed.")], "finished"),
      result: {
        updatedNodes: 0,
        updatedProviders: 1,
        failures: ["MacBook Pro M4 · Ryco: The update failed."],
        postponed: [],
        unknown: [],
        skipped: [],
      },
    });
    mounted = await render(<Harness />);
    await expect.element(pillButton(/^An update failed\./)).toBeVisible();
    expect(pill()?.dataset.kind).toBe("finished");
    await page.getByRole("button", { name: "Dismiss update notice" }).click();
    expect(controller.dismissRun).toHaveBeenCalledOnce();
  });

  it("clears a successful run by itself", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const controller = setController({
        run: runState([runDevice(M4_DEVICE, "done", "Updated Ryco to 0.1.35.")], "finished"),
        result: {
          updatedNodes: 1,
          updatedProviders: 2,
          failures: [],
          postponed: [],
          unknown: [],
          skipped: [],
        },
      });
      mounted = await render(<Harness />);
      await expect.element(pillButton(/^Updated 1 node and 2 providers/)).toBeVisible();
      expect(controller.dismissRun).not.toHaveBeenCalled();
      vi.advanceTimersByTime(4_000);
      expect(controller.dismissRun).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows this app's own download with its progress", async () => {
    setController({ plan: EMPTY_PLAN });
    setDesktopUpdateState({
      ...DESKTOP_STATE,
      status: "downloading",
      availableVersion: "0.1.36",
      downloadPercent: 45.4,
    });
    mounted = await render(<Harness />);
    const button = pillButton(/^Downloading Ryco 0\.1\.36\./);
    await expect.element(button).toBeVisible();
    await expect.element(button).toMatchTextContent("Downloading Ryco 0.1.3645%");
    await expect
      .element(page.getByRole("progressbar", { name: "Update progress" }))
      .toHaveAttribute("aria-valuenow", "45");
  });
});
