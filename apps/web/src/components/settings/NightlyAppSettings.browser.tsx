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
  const getState = vi.fn(async () => state);
  const confirm = vi.fn<(message: string) => Promise<boolean>>();
  window.desktopBridge = {
    nightly: { getState, open, switchBack },
    openExternal,
    confirm,
    // Read by the local API that `confirmAction` asks through.
    getLocalEnvironmentBootstrap: () => null,
  } as unknown as DesktopBridge;
  return { open, switchBack, openExternal, getState, confirm };
}

it("opens Ryco Nightly as it is, or with a copy of Ryco's data once confirmed", async () => {
  // The desktop app asks through its native dialog, not the renderer's window.confirm.
  const { open, confirm } = install(stable);
  confirm.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
  const view = await render(<NightlyAppSettings scope="This device" />);

  await view.getByRole("button", { name: "Open Ryco Nightly" }).click();
  expect(open).toHaveBeenLastCalledWith({ copyData: false });

  await view.getByRole("button", { name: "Copy my data and open" }).click();
  await vi.waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
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

it("looks again when the window comes back, so quitting Ryco Nightly frees the copy", async () => {
  const { getState, confirm } = install({ ...stable, nightlyRunning: true });
  const view = await render(<NightlyAppSettings scope="This device" />);
  const copy = view.getByRole("button", { name: "Copy my data and open" });
  await expect.element(copy).toBeDisabled();
  getState.mockResolvedValue(stable);
  window.dispatchEvent(new Event("focus"));
  await expect.element(copy).toBeEnabled();
  // The confirmation says what really comes over.
  confirm.mockResolvedValue(false);
  await copy.click();
  await vi.waitFor(() => expect(confirm).toHaveBeenCalled());
  expect(confirm).toHaveBeenCalledWith(
    expect.stringContaining("schedules and chat goals come over paused"),
  );
});

it("says so when it cannot check for Ryco Nightly, and when Ryco is missing on the way back", async () => {
  const { getState } = install(stable);
  getState.mockRejectedValue(new Error("no handler"));
  const failed = await render(<NightlyAppSettings scope="This device" />);
  await expect
    .element(failed.getByRole("alert"))
    .toHaveTextContent("Could not check for Ryco Nightly.");
  await failed.unmount();

  install({ ...stable, flavor: "nightly", otherAppInstalled: false });
  const nightly = await render(<NightlyAppSettings scope="This device" />);
  await expect.element(nightly.getByText("Ryco is not in Applications.")).toBeVisible();
});

it("treats a desktop dialog that fails as not confirmed", async () => {
  const { open, confirm } = install(stable);
  confirm.mockRejectedValueOnce(new Error("The dialog could not open."));
  const view = await render(<NightlyAppSettings scope="This device" />);

  await view.getByRole("button", { name: "Copy my data and open" }).click();
  await vi.waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
  expect(open).not.toHaveBeenCalled();
});
