// Shared device settings on the settings page: one control while every device agrees, each
// device's own control while they differ, overrides and their reset, queued writes for an
// offline device that apply when it reconnects, older nodes, refused values, read-only
// devices, and the compare table and device page jumping to a row. The devices are simulated
// (`sharedSettingsTestSource`): each applies a write with the node's own sharing rules, and a
// real runner catches devices up, as this app's runtime does.
import "../../../index.css";

import { EnvironmentId } from "@ryco/contracts";
import { page } from "vite-plus/test/browser";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { render } from "vitest-browser-react";

import { useSettingsDialogStore } from "../../../settingsDialogStore";
import { Switch } from "../../ui/switch";
import { SettingsCard } from "../settingsLayout";
import { useSettingsSearchRevealStore } from "../settingsSearchReveal";
import { DeviceSettingsCompare } from "./DeviceSettingsCompare";
import { DeviceSharingDifferences } from "./DeviceSharingDifferences";
import { SharedSettingRow, sharedControlLabel } from "./SharedSettingRow";
import { sharedSettingRowId } from "./sharedSettingsCatalog";
import {
  SharedSettingsModeProvider,
  useSharedRowOpenRequest,
  type SharedSettingsModeValue,
} from "./sharedSettingsMode";
import { SharedSettingsSourceProvider } from "./sharedSettingsSource";
import { createTestSharedSettings, type TestSharedSettings } from "./sharedSettingsTestSource";

const ALL: SharedSettingsModeValue = { mode: { kind: "all" }, showDevice: null, targetLabel: null };

function ChecksRow() {
  return (
    <SettingsCard>
      <SharedSettingRow
        settingKey="enableProviderUpdateChecks"
        description="Check installed provider CLIs for newer versions."
        render={(control) => (
          <Switch
            checked={control.value}
            disabled={control.disabled}
            onCheckedChange={(checked) => control.onChange(Boolean(checked))}
            aria-label={sharedControlLabel("Check providers for updates", control)}
          />
        )}
      />
    </SettingsCard>
  );
}

function PrefixRow() {
  return (
    <SettingsCard>
      <SharedSettingRow
        settingKey="worktreeBranchPrefix"
        render={(control) => (
          <button
            type="button"
            disabled={control.disabled}
            onClick={() => control.onChange("team")}
            aria-label={sharedControlLabel("Use team", control)}
          >
            {control.value}
          </button>
        )}
      />
    </SettingsCard>
  );
}

let mounted: Awaited<ReturnType<typeof render>> | null = null;
let network: TestSharedSettings | null = null;

async function show(
  next: TestSharedSettings,
  children: React.ReactNode,
  mode: SharedSettingsModeValue = ALL,
) {
  network = next;
  next.runner.start();
  mounted = await render(
    <SharedSettingsSourceProvider value={next.source}>
      <SharedSettingsModeProvider value={mode}>{children}</SharedSettingsModeProvider>
    </SharedSettingsSourceProvider>,
  );
}

const sharedEntry = (
  settings: { readonly settingsSharing: Record<string, unknown> },
  key: string,
) => settings.settingsSharing[key] as { readonly mode: string } | undefined;

beforeEach(async () => {
  await page.viewport(1_280, 900);
});

afterEach(async () => {
  network?.runner.stop();
  network = null;
  await mounted?.unmount();
  mounted = null;
  useSettingsSearchRevealStore.setState({ request: null });
  useSharedRowOpenRequest.setState({ key: null });
  document.body.innerHTML = "";
});

describe("a shared setting row", () => {
  it("is one control while every device agrees, and writes every device", async () => {
    const devices = createTestSharedSettings([
      { id: "laptop", label: "Laptop" },
      { id: "studio", label: "Studio" },
    ]);
    await show(devices, <ChecksRow />);

    await expect.element(page.getByText("Same on all 2 devices")).toBeVisible();
    await page.getByRole("switch", { name: "Check providers for updates" }).click();

    await expect.poll(() => devices.settings("laptop").enableProviderUpdateChecks).toBe(false);
    await expect.poll(() => devices.settings("studio").enableProviderUpdateChecks).toBe(false);
    // Both follow the shared value, with the same stamp.
    expect(sharedEntry(devices.settings("laptop"), "enableProviderUpdateChecks")?.mode).toBe(
      "shared",
    );
    expect(devices.settings("laptop").settingsSharing.enableProviderUpdateChecks).toEqual(
      devices.settings("studio").settingsSharing.enableProviderUpdateChecks,
    );
    await expect.element(page.getByText("Same on all 2 devices")).toBeVisible();
  });

  it("lists every device while they differ, and offers one value everywhere", async () => {
    const devices = createTestSharedSettings([
      { id: "laptop", label: "Laptop", settings: { enableProviderUpdateChecks: true } },
      { id: "studio", label: "Studio", settings: { enableProviderUpdateChecks: false } },
    ]);
    await show(devices, <ChecksRow />);

    await expect
      .element(page.getByTestId("shared-setting-differs"))
      .toHaveTextContent("Differs on 1 of 2");
    await expect
      .element(page.getByRole("switch", { name: "Check providers for updates on Laptop" }))
      .toBeChecked();
    await expect
      .element(page.getByRole("switch", { name: "Check providers for updates on Studio" }))
      .not.toBeChecked();

    await page.getByRole("button", { name: "Use “On” everywhere" }).click();
    await expect.poll(() => devices.settings("studio").enableProviderUpdateChecks).toBe(true);
    await expect.element(page.getByText("Same on all 2 devices")).toBeVisible();
  });

  it("gives one device its own value, and resets it to the shared one", async () => {
    const devices = createTestSharedSettings([
      { id: "laptop", label: "Laptop" },
      { id: "studio", label: "Studio" },
    ]);
    await show(devices, <ChecksRow />);

    await page.getByRole("button", { name: /per device/ }).click();
    await page.getByRole("switch", { name: "Check providers for updates on Studio" }).click();
    await expect.poll(() => devices.settings("studio").enableProviderUpdateChecks).toBe(false);
    expect(sharedEntry(devices.settings("studio"), "enableProviderUpdateChecks")?.mode).toBe(
      "override",
    );
    // Laptop kept its value.
    expect(devices.settings("laptop").enableProviderUpdateChecks).toBe(true);
    await expect.element(page.getByText("Own value")).toBeVisible();

    // Back on the shared value; no shared write happened yet, so it keeps its value until one does.
    await page.getByRole("button", { name: "Reset Studio to shared" }).click();
    await expect
      .poll(
        () =>
          sharedEntry(devices.settings("studio"), "enableProviderUpdateChecks")?.mode ?? "shared",
      )
      .toBe("shared");
    await expect.element(page.getByText("Own value")).not.toBeInTheDocument();
  });

  it("queues a change for an offline device and applies it when it reconnects", async () => {
    const devices = createTestSharedSettings([
      { id: "laptop", label: "Laptop" },
      { id: "box", label: "build", connected: false },
    ]);
    await show(devices, <ChecksRow />);

    await page.getByRole("switch", { name: "Check providers for updates" }).click();
    await expect.poll(() => devices.settings("laptop").enableProviderUpdateChecks).toBe(false);
    await expect.element(page.getByText("1 queued until online")).toBeVisible();
    expect(devices.device("box").writes).toEqual([]);

    // build comes back; its config push lets the runner catch it up.
    devices.update("box", (device) => {
      device.connected = true;
    });
    await expect.poll(() => devices.settings("box").enableProviderUpdateChecks).toBe(false);
    await expect.element(page.getByText("1 queued until online")).not.toBeInTheDocument();
    await expect.element(page.getByText("Same on all 2 devices")).toBeVisible();
  });

  it("leaves an offline device with its own value out of “Use … everywhere”, and says so", async () => {
    const devices = createTestSharedSettings([
      { id: "laptop", label: "Laptop", settings: { enableProviderUpdateChecks: true } },
      {
        id: "box",
        label: "build",
        connected: false,
        settings: {
          enableProviderUpdateChecks: false,
          settingsSharing: {
            enableProviderUpdateChecks: { mode: "override", stamp: { at: 1, by: "other" } },
          },
        },
      },
    ]);
    await show(devices, <ChecksRow />);

    // An offline device shows its last known value, read only.
    await expect
      .element(page.getByRole("switch", { name: "Check providers for updates on build" }))
      .not.toBeInTheDocument();
    await expect
      .element(page.getByTestId("shared-setting-device").nth(1))
      .toMatchTextContent(/offline.*Off/);
    await page.getByRole("button", { name: "Use “On” everywhere" }).click();
    await expect
      .element(page.getByText("build keeps its own value until it is online."))
      .toBeVisible();
    await expect.element(page.getByTestId("shared-setting-differs")).toBeVisible();
  });

  it("shows an older node as needing an update, and leaves it out of shared writes", async () => {
    const devices = createTestSharedSettings([
      { id: "laptop", label: "Laptop", settings: { worktreeBranchPrefix: "ryco" } },
      {
        id: "old",
        label: "Old box",
        sharingVersion: null,
        settings: { worktreeBranchPrefix: "x" },
      },
    ]);
    await show(devices, <PrefixRow />);

    await expect.element(page.getByText("Update Old box to share settings")).toBeVisible();
    await page.getByRole("button", { name: "Use “ryco” everywhere" }).click();
    await expect.poll(() => devices.device("laptop").writes.length).toBe(1);
    expect(devices.device("old").writes).toEqual([]);
    // Its own control is a plain edit of that device, without sharing state.
    await page.getByRole("button", { name: "Use team on Old box" }).click();
    await expect
      .poll(() => devices.device("old").writes.at(-1))
      .toEqual({
        worktreeBranchPrefix: "team",
      });
  });

  it("says when a device refused the shared value", async () => {
    const devices = createTestSharedSettings([
      { id: "laptop", label: "Laptop" },
      { id: "box", label: "build", connected: false },
    ]);
    devices.device("box").reject = (patch) =>
      patch.worktreeBranchPrefix === "team" ? "Branch prefix is reserved here." : null;
    await show(devices, <PrefixRow />);

    await page.getByRole("button", { name: "Use team" }).click();
    await expect.poll(() => devices.settings("laptop").worktreeBranchPrefix).toBe("team");
    devices.update("box", (device) => {
      device.connected = true;
    });
    await expect
      .element(page.getByText("Couldn't apply: Branch prefix is reserved here."))
      .toBeVisible();
  });

  it("keeps a device this client may only read read-only", async () => {
    const devices = createTestSharedSettings([
      { id: "laptop", label: "Laptop", settings: { enableProviderUpdateChecks: true } },
      {
        id: "shared-node",
        label: "Team node",
        canWrite: false,
        settings: { enableProviderUpdateChecks: false },
      },
    ]);
    await show(devices, <ChecksRow />);

    await expect
      .element(page.getByRole("switch", { name: "Check providers for updates on Team node" }))
      .toBeDisabled();
    await page.getByRole("button", { name: "Use “On” everywhere" }).click();
    await expect.poll(() => devices.device("laptop").writes.length).toBe(1);
    expect(devices.device("shared-node").writes).toEqual([]);
  });

  it("shows one device's own value with what the others hold", async () => {
    const devices = createTestSharedSettings([
      { id: "laptop", label: "Laptop", settings: { enableProviderUpdateChecks: true } },
      { id: "studio", label: "Studio", settings: { enableProviderUpdateChecks: false } },
    ]);
    await show(devices, <ChecksRow />, {
      mode: { kind: "device", environmentId: EnvironmentId.make("laptop") },
      showDevice: null,
      targetLabel: null,
    });

    await expect.element(page.getByText(/Studio: Off/)).toBeVisible();
    await page.getByRole("switch", { name: "Check providers for updates on Laptop" }).click();
    await expect.poll(() => devices.settings("laptop").enableProviderUpdateChecks).toBe(false);
    // One device's own value.
    expect(sharedEntry(devices.settings("laptop"), "enableProviderUpdateChecks")?.mode).toBe(
      "override",
    );
    expect(devices.device("studio").writes).toEqual([]);
  });
});

describe("compare settings", () => {
  it("lists only the differences and jumps to a setting with its devices open", async () => {
    const devices = createTestSharedSettings([
      { id: "laptop", label: "Laptop", settings: { worktreeBranchPrefix: "ryco" } },
      { id: "studio", label: "Studio", settings: { worktreeBranchPrefix: "team" } },
    ]);
    await show(devices, <DeviceSettingsCompare />);

    const rows = page.getByTestId("settings-compare-row");
    await expect.element(rows.first()).toHaveAttribute("data-setting", "worktreeBranchPrefix");
    expect(rows.all()).toHaveLength(1);
    await page.getByRole("switch", { name: "Only differences" }).click();
    await expect.poll(() => rows.all().length).toBeGreaterThan(10);
    await page.getByRole("switch", { name: "Only differences" }).click();

    await page.getByRole("button", { name: "Worktree branch prefix" }).click();
    expect(useSettingsDialogStore.getState().section).toBe("projects");
    expect(useSettingsSearchRevealStore.getState().request?.targetId).toBe(
      sharedSettingRowId("worktreeBranchPrefix"),
    );
    expect(useSharedRowOpenRequest.getState().key).toBe("worktreeBranchPrefix");
  });
});

describe("where this device differs", () => {
  it("lists the device's own values and opens them", async () => {
    const devices = createTestSharedSettings([
      { id: "laptop", label: "Laptop" },
      {
        id: "studio",
        label: "Studio",
        settings: {
          worktreeBranchPrefix: "mine",
          settingsSharing: {
            worktreeBranchPrefix: { mode: "override", stamp: { at: 2, by: "other" } },
          },
        },
      },
    ]);
    await show(devices, <DeviceSharingDifferences environmentId={EnvironmentId.make("studio")} />);

    await expect.element(page.getByText("Where this device differs")).toBeVisible();
    await expect.element(page.getByText("Own value")).toBeVisible();
    await expect.element(page.getByText(/here: mine/)).toBeVisible();
    await page.getByRole("button", { name: "Open" }).click();
    expect(useSharedRowOpenRequest.getState().key).toBe("worktreeBranchPrefix");
  });
});
