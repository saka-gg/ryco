import "../../index.css";

import {
  resetEnvironmentServerConfigsForTests,
  writeEnvironmentServerConfig,
} from "@ryco/client-runtime/rpc";
import {
  DEFAULT_SERVER_SETTINGS,
  type EnvironmentId,
  type NodeUpdateState,
  type ServerConfig,
} from "@ryco/contracts";
import { page } from "vite-plus/test/browser";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

import type { UpdateEverythingController } from "../../updates/useUpdateEverything";

const mock = vi.hoisted(() => ({
  controller: null as UpdateEverythingController | null,
  nodeUpdates: new Map<string, Pick<NodeUpdateState, "channel" | "checkedAt">>(),
}));

vi.mock("../../updates/useUpdateEverything", () => ({
  useUpdateEverything: () => mock.controller!,
  useNodeUpdateState: (environmentId: EnvironmentId) =>
    (mock.nodeUpdates.get(environmentId) as NodeUpdateState | undefined) ?? null,
}));

import {
  EMPTY_PLAN,
  FULL_PLAN,
  LINUX_DEVICE,
  LINUX_ID,
  OFFLINE_ID,
  THIS_MAC_ID,
  M4_DEVICE,
  M4_ID,
  runDevice,
  runState,
  THIS_MAC_DEVICE,
} from "../updates/updateEverythingTestFixtures";
import { UpdatesSettings } from "./UpdatesSettings";

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

const card = (name: string) => page.getByRole("group", { name, exact: true });

describe("Settings → Updates", () => {
  let mounted: Awaited<ReturnType<typeof render>> | null = null;

  afterEach(async () => {
    await mounted?.unmount();
    mounted = null;
    mock.nodeUpdates.clear();
    resetEnvironmentServerConfigsForTests();
    document.body.innerHTML = "";
  });

  it("lets each node's owner turn on automatic provider updates", async () => {
    const nodeConfig = (settings: Partial<ServerConfig["settings"]>, supported = true) =>
      ({
        environment: { capabilities: supported ? { automaticUpdates: true } : {} },
        settings: { ...DEFAULT_SERVER_SETTINGS, ...settings },
      }) as unknown as ServerConfig;
    writeEnvironmentServerConfig(M4_ID, nodeConfig({ automaticUpdates: true }));
    writeEnvironmentServerConfig(THIS_MAC_ID, nodeConfig({}));
    writeEnvironmentServerConfig(LINUX_ID, nodeConfig({ enableProviderUpdateChecks: false }));
    // Too old to update unattended: no switch at all.
    writeEnvironmentServerConfig(OFFLINE_ID, nodeConfig({}, false));
    setController();
    mounted = await render(<UpdatesSettings />);

    const toggle = (name: string) =>
      page.getByRole("switch", { name: `Update ${name} automatically`, exact: true });
    await expect.element(toggle("MacBook Pro M4")).toBeChecked();
    await expect.element(toggle("This Mac")).not.toBeChecked();
    await expect.element(toggle("This Mac")).toBeEnabled();
    // Unattended updates need provider update checks.
    await expect.element(toggle("Linux box")).toBeDisabled();
    await expect
      .element(
        page.getByText("Turn on provider update checks for this node first (General settings)."),
      )
      .toBeVisible();
    expect(toggle("Studio PC").elements()).toHaveLength(0);
  });

  it("lists every device and updates one, all, or checks again", async () => {
    mock.nodeUpdates.set(M4_ID, { channel: "nightly", checkedAt: new Date().toISOString() });
    const controller = setController();
    mounted = await render(<UpdatesSettings />);

    await expect
      .element(
        page.getByText(
          "2 Ryco updates and 3 provider updates ready. 1 update needs a manual step.",
        ),
      )
      .toBeVisible();
    await expect
      .element(card("MacBook Pro M4"))
      .toMatchTextContent("Nightly channel · checked just now");
    await expect.element(card("Linux box")).toMatchTextContent("Up to date.");
    // Only devices one click can update offer their own button.
    expect(page.getByRole("button", { name: "Update Linux box" }).elements()).toHaveLength(0);
    expect(page.getByRole("button", { name: "Update Studio PC" }).elements()).toHaveLength(0);

    await page.getByRole("button", { name: "Update MacBook Pro M4" }).click();
    expect(controller.start).toHaveBeenLastCalledWith({ environmentIds: [M4_ID] });

    await page.getByRole("button", { name: "Update all" }).click();
    expect(controller.start).toHaveBeenLastCalledWith();

    await page.getByRole("button", { name: "Check for updates" }).click();
    expect(controller.checkAll).toHaveBeenCalledOnce();
  });

  it("follows a run and hides the per-device buttons meanwhile", async () => {
    setController({
      run: runState([
        runDevice(THIS_MAC_DEVICE, "queued"),
        runDevice(LINUX_DEVICE, "skipped", "Up to date."),
        runDevice(M4_DEVICE, "providers", "Updating Codex…"),
      ]),
      running: true,
      checking: true,
    });
    mounted = await render(<UpdatesSettings />);
    await expect.element(page.getByText("Updating · 0 of 2 done")).toBeVisible();
    await expect.element(card("MacBook Pro M4")).toMatchTextContent("Updating Codex…");
    await expect.element(page.getByRole("button", { name: "Updating…" })).toBeDisabled();
    await expect.element(page.getByRole("button", { name: "Checking…" })).toBeDisabled();
    expect(page.getByRole("button", { name: "Update MacBook Pro M4" }).elements()).toHaveLength(0);
  });

  it("reports a finished run until it is dismissed", async () => {
    const controller = setController({
      run: runState([runDevice(M4_DEVICE, "postponed", "Someone there postponed it.")], "finished"),
      result: {
        updatedNodes: 0,
        updatedProviders: 2,
        failures: [],
        postponed: ["MacBook Pro M4"],
        unknown: [],
        skipped: [],
      },
    });
    mounted = await render(<UpdatesSettings />);
    await expect.element(page.getByText("Update postponed on MacBook Pro M4")).toBeVisible();
    await page.getByRole("button", { name: "Dismiss" }).click();
    expect(controller.dismissRun).toHaveBeenCalledOnce();
  });

  it("says when no device is connected", async () => {
    setController({ plan: EMPTY_PLAN });
    mounted = await render(<UpdatesSettings />);
    await expect.element(page.getByText("No devices connected", { exact: true })).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Update all" })).toBeDisabled();
  });
});
