import "../../index.css";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";
import type { DesktopBridge, DesktopNightlyState } from "@ryco/contracts";
import { NightlyAppSettings } from "./NightlyAppSettings";

const previous = window.desktopBridge;
afterEach(() => {
  vi.restoreAllMocks();
  if (previous) window.desktopBridge = previous;
  else delete window.desktopBridge;
});

const stable: DesktopNightlyState = {
  flavor: "stable",
  otherAppInstalled: true,
  nightlyRunning: false,
  lastImport: null,
  releasesUrl: "https://github.com/saka-gg/ryco/releases",
};

function install(state: DesktopNightlyState) {
  const open = vi.fn(async () => {});
  const switchBack = vi.fn(async () => {});
  const openExternal = vi.fn(async () => true);
  window.desktopBridge = {
    nightly: { getState: async () => state, open, switchBack },
    openExternal,
  } as unknown as DesktopBridge;
  return { open, switchBack, openExternal };
}

it("opens Ryco Nightly as it is, or with a copy of Ryco's data once confirmed", async () => {
  const { open } = install(stable);
  const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
  const view = await render(<NightlyAppSettings scope="This device" />);

  await view.getByRole("button", { name: "Open Ryco Nightly" }).click();
  expect(open).toHaveBeenLastCalledWith({ copyData: false });

  await view.getByRole("button", { name: "Copy my data and open" }).click();
  expect(open).toHaveBeenCalledTimes(1);
  await view.getByRole("button", { name: "Copy my data and open" }).click();
  expect(confirm).toHaveBeenCalledTimes(2);
  await vi.waitFor(() => expect(open).toHaveBeenLastCalledWith({ copyData: true }));
});

it("holds the copy while Ryco Nightly is open, and offers the download when it is missing", async () => {
  install({ ...stable, nightlyRunning: true });
  const running = await render(<NightlyAppSettings scope="This device" />);
  await expect
    .element(running.getByRole("button", { name: "Copy my data and open" }))
    .toBeDisabled();
  await expect.element(running.getByText(/Quit it to start it with a copy/u)).toBeVisible();
  await running.unmount();

  const { openExternal } = install({ ...stable, otherAppInstalled: false });
  const missing = await render(<NightlyAppSettings scope="This device" />);
  await missing.getByRole("button", { name: "Get Ryco Nightly" }).click();
  expect(openExternal).toHaveBeenCalledWith("https://github.com/saka-gg/ryco/releases");
});

it("switches back from Ryco Nightly and says how the last copy went", async () => {
  const { switchBack } = install({
    ...stable,
    flavor: "nightly",
    nightlyRunning: true,
    lastImport: { completedAt: "2026-10-31T08:01:00.000Z", ok: false, error: "Ryco is newer." },
  });
  const view = await render(<NightlyAppSettings scope="This device" />);
  await expect
    .element(view.getByText("The last copy of Ryco's data did not happen: Ryco is newer."))
    .toBeVisible();
  await view.getByRole("button", { name: "Switch back to Ryco" }).click();
  expect(switchBack).toHaveBeenCalledOnce();
});
