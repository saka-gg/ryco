import "../../index.css";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";
import type { ComputerUsePolicy, ComputerUseState, DesktopBridge } from "@ryco/contracts";
import { ComputerUseSettings } from "./ComputerUseSettings";

const previous = window.desktopBridge;
afterEach(() => {
  if (previous) window.desktopBridge = previous;
  else delete window.desktopBridge;
});
it("keeps control opt-in, preserves remembered app denial and pairs only enabled browsers", async () => {
  let state: ComputerUseState = {
    policy: {
      enabled: false,
      foregroundEnabled: false,
      apps: { "/Applications/Private.app": "block" },
      browsers: [],
    },
    apps: [],
    connectedBrowsers: [],
    accessibility: "unknown",
    screenRecording: "unknown",
    helperAvailable: false,
    activity: null,
    error: null,
  };
  const setPolicy = vi.fn(async (policy: ComputerUsePolicy) => {
    state = { ...state, policy };
    return state;
  });
  const pairBrowser = vi.fn(async () => ({
    browser: "chrome" as const,
    url: "ws://127.0.0.1:1234/browser",
    token: "x".repeat(43),
  }));
  const stop = vi.fn(async () => {});
  const openBrowserSetup = vi.fn(async () => {});
  window.desktopBridge = {
    computerUse: {
      getState: async () => state,
      onState: () => () => {},
      setPolicy,
      pairBrowser,
      stop,
      refresh: async () => state,
      requestPermission: async () => {},
      showExtension: async () => "/tmp/ryco-extension",
      openBrowserSetup,
    },
  } as unknown as DesktopBridge;
  const view = await render(<ComputerUseSettings />);
  await expect
    .element(view.getByRole("switch", { name: "Enable computer use on this computer" }))
    .not.toBeDisabled();
  await expect
    .element(view.getByRole("switch", { name: "Enable computer use on this computer" }))
    .not.toBeChecked();
  await view.getByRole("switch", { name: "Enable computer use on this computer" }).click();
  await expect
    .element(view.getByRole("combobox", { name: "Access to Private.app" }))
    .toHaveValue("block");
  await expect
    .element(view.getByRole("switch", { name: "Allow foreground takeover requests" }))
    .not.toBeChecked();
  await view.getByRole("switch", { name: "Enable Google Chrome control" }).click();
  await view.getByRole("button", { name: "Pair", exact: true }).click();
  expect(pairBrowser).toHaveBeenCalledWith("chrome");
  await view.getByRole("button", { name: "Open browser Extensions" }).click();
  expect(openBrowserSetup).toHaveBeenCalledWith("chrome");
  await view.getByRole("button", { name: "Show extension folder", exact: true }).click();
  await expect
    .element(view.getByRole("textbox", { name: "Extension folder path" }))
    .toHaveValue("/tmp/ryco-extension");
  await expect
    .element(view.getByRole("textbox", { name: "Browser pairing configuration" }))
    .toHaveValue(JSON.stringify(await pairBrowser()));
  await view.getByRole("button", { name: "Stop all" }).click();
  expect(stop).toHaveBeenCalledOnce();
  await view.getByRole("switch", { name: "Enable computer use on this computer" }).click();
  expect(setPolicy).toHaveBeenLastCalledWith(
    expect.objectContaining({ enabled: false, apps: { "/Applications/Private.app": "block" } }),
  );
  await expect
    .element(view.getByRole("button", { name: "Pair", exact: true }))
    .not.toBeInTheDocument();
});

it("does not expose desktop controls in a normal web browser", async () => {
  delete window.desktopBridge;
  const view = await render(<ComputerUseSettings />);
  await expect.element(view.getByRole("switch")).not.toBeInTheDocument();
});

it("uses distinct permission badges and rechecks when returning from system settings", async () => {
  let state: ComputerUseState = {
    policy: { enabled: true, foregroundEnabled: false, apps: {}, browsers: [] },
    apps: [],
    connectedBrowsers: [],
    accessibility: "denied",
    screenRecording: "unknown",
    helperAvailable: true,
    activity: null,
    error: null,
  };
  const getState = vi.fn(async () => state);
  const requestPermission = vi.fn(async () => {});
  window.desktopBridge = {
    computerUse: { getState, onState: () => () => {}, requestPermission },
  } as unknown as DesktopBridge;
  const view = await render(<ComputerUseSettings />);
  await expect
    .element(view.getByRole("button", { name: "Accessibility Not granted" }))
    .toBeVisible();
  await expect.element(view.getByText("Not granted", { exact: true })).toHaveClass("text-red-700");
  await expect
    .element(view.getByRole("button", { name: "Screen recording Not checked" }))
    .toBeVisible();
  await view.getByRole("button", { name: "Accessibility Not granted" }).click();
  expect(requestPermission).toHaveBeenCalledWith("accessibility");
  state = { ...state, accessibility: "granted", screenRecording: "granted" };
  window.dispatchEvent(new Event("focus"));
  await expect.element(view.getByRole("button", { name: "Accessibility Granted" })).toBeVisible();
  await expect
    .element(view.getByRole("button", { name: "Screen recording Granted" }))
    .toBeVisible();
  const badges = document.querySelectorAll('[data-permission-status="granted"]');
  expect(badges).toHaveLength(2);
  expect(badges[0]?.classList.contains("text-emerald-700")).toBe(true);
});
