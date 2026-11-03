import "../../index.css";
import { EnvironmentId } from "@ryco/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";

import { getClientSettingsSnapshot } from "../../hooks/clientSettingsStore";
import { getCustomThemes } from "../../themes/registry";
import { SettingsFileRows } from "./SettingsFileRows";
import {
  SharedSettingsSourceProvider,
  type SharedSettingsSource,
} from "./sharedSettings/sharedSettingsSource";
import {
  createTestSharedSettings,
  type TestSharedSettings,
} from "./sharedSettings/sharedSettingsTestSource";

afterEach(() => {
  localStorage.clear();
  document.body.innerHTML = "";
});

it("shows what a preferences file would change, then applies it", async () => {
  const view = await render(<SettingsFileRows />);
  const file = new File(
    [
      JSON.stringify({
        format: "ryco-client-settings",
        version: 1,
        client: { chatWidth: "wide", favorites: [] },
      }),
    ],
    "ryco-client-settings.json",
    { type: "application/json" },
  );
  await userEvent.upload(view.getByLabelText("Settings file to restore"), file);

  await expect.element(page.getByText('chatWidth: "comfortable" -> "wide"')).toBeVisible();
  await expect
    .element(page.getByText("favorites: not a setting this file carries, left as it is"))
    .toBeVisible();
  expect(getClientSettingsSnapshot().chatWidth).toBe("comfortable");

  await page.getByRole("button", { name: "Apply" }).click();
  await expect.poll(() => getClientSettingsSnapshot().chatWidth).toBe("wide");
  await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
});

it("refuses a file that is not a preferences file before anything changes", async () => {
  const view = await render(<SettingsFileRows />);
  await userEvent.upload(
    view.getByLabelText("Settings file to restore"),
    new File(["{}"], "other.json", { type: "application/json" }),
  );
  await expect
    .element(page.getByRole("alert"))
    .toHaveTextContent("This is not a Ryco settings file.");
});

describe("backing up and restoring device settings", () => {
  let network: TestSharedSettings | null = null;
  let mounted: Awaited<ReturnType<typeof render>> | null = null;

  afterEach(async () => {
    network?.runner.stop();
    network = null;
    await mounted?.unmount();
    mounted = null;
    vi.restoreAllMocks();
  });

  async function showRows(
    next: TestSharedSettings,
    options: {
      readonly source?: SharedSettingsSource;
      readonly shownEnvironmentId?: EnvironmentId;
    } = {},
  ) {
    network = next;
    next.runner.start();
    mounted = await render(
      <SharedSettingsSourceProvider value={options.source ?? next.source}>
        <SettingsFileRows
          {...(options.shownEnvironmentId === undefined
            ? {}
            : { shownEnvironmentId: options.shownEnvironmentId })}
        />
      </SharedSettingsSourceProvider>,
    );
    return mounted;
  }

  /** Clicks Export in the backup dialog and returns the downloaded file. */
  async function exportFile(): Promise<{
    readonly name: string;
    readonly value: Record<string, unknown>;
  }> {
    let blob: Blob | null = null;
    let name = "";
    vi.spyOn(URL, "createObjectURL").mockImplementation((value) => {
      blob = value as Blob;
      return "blob:settings";
    });
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      name = this.download;
    });
    await page.getByRole("button", { name: "Export" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Export" }).click();
    await expect.poll(() => blob).not.toBeNull();
    return { name, value: JSON.parse(await blob!.text()) as Record<string, unknown> };
  }

  async function importFile(view: Awaited<ReturnType<typeof render>>, value: unknown) {
    await userEvent.upload(
      view.getByLabelText("Settings file to restore"),
      new File([JSON.stringify(value)], "ryco-settings.json", { type: "application/json" }),
    );
  }

  it("backs up the shared device settings and restores them to picked devices only", async () => {
    const devices = createTestSharedSettings([
      { id: "laptop", label: "Laptop", settings: { worktreeBranchPrefix: "team" } },
      { id: "studio", label: "Studio", settings: { worktreeBranchPrefix: "team" } },
    ]);
    const view = await showRows(devices);

    const backup = await exportFile();
    expect(backup.name).toBe("ryco-settings.json");
    const deviceSettings = backup.value.deviceSettings as Record<string, unknown>;
    expect(deviceSettings.worktreeBranchPrefix).toBe("team");
    expect(Object.keys(deviceSettings)).not.toContain("worktreeRoot");
    expect(Object.keys(deviceSettings)).not.toContain("providerInstances");
    expect(backup.value.client).toBeDefined();

    for (const id of ["laptop", "studio"])
      devices.update(id, (device) => {
        device.config = {
          ...device.config,
          settings: { ...device.config.settings, worktreeBranchPrefix: "other" },
        };
      });
    await importFile(view, { ...backup.value, client: undefined, appearance: undefined });

    await expect
      .element(page.getByRole("list", { name: "Changes on Studio" }))
      .toHaveTextContent("Worktree branch prefix: other -> team");
    await expect.element(page.getByRole("list", { name: "Changes on Laptop" })).toBeVisible();
    await page.getByRole("radio", { name: /Only these devices/ }).click();
    await page
      .getByRole("group", { name: "Devices" })
      .getByRole("checkbox", { name: "Laptop" })
      .click();
    await expect
      .element(page.getByRole("list", { name: "Changes on Laptop" }))
      .not.toBeInTheDocument();
    await expect
      .element(page.getByText("Becomes its own value here: Worktree branch prefix"))
      .toBeVisible();

    await page.getByRole("button", { name: "Apply" }).click();
    await expect
      .element(page.getByRole("list", { name: "Device results" }))
      .toHaveTextContent("Studio: 1 setting applied");
    expect(devices.settings("studio").worktreeBranchPrefix).toBe("team");
    expect(devices.settings("studio").settingsSharing.worktreeBranchPrefix?.mode).toBe("override");
    expect(devices.settings("laptop").worktreeBranchPrefix).toBe("other");
    await page.getByRole("button", { name: "Done" }).click();
    await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
  });

  it("restores to every device as one shared value; an offline device takes it when it is back", async () => {
    const devices = createTestSharedSettings([
      { id: "laptop", label: "Laptop" },
      { id: "studio", label: "Studio", connected: false },
    ]);
    const view = await showRows(devices);
    await importFile(view, {
      format: "ryco-client-settings",
      version: 1,
      deviceSettings: { worktreeBranchPrefix: "team", worktreeRoot: "/Users/me/w" },
    });

    await expect
      .element(page.getByRole("checkbox", { name: /This app's settings/ }))
      .not.toBeInTheDocument();
    await expect
      .element(page.getByText(/Studio · 1 change · takes it when it is back online/))
      .toBeVisible();
    await expect
      .element(
        page.getByText("worktreeRoot: not a device setting this file carries, left as it is"),
      )
      .toBeVisible();
    await page.getByRole("button", { name: "Apply" }).click();

    const results = page.getByRole("list", { name: "Device results" });
    await expect.element(results.getByText("Laptop: 1 setting applied")).toBeVisible();
    await expect.element(results.getByText("Studio: 1 queued until online")).toBeVisible();
    expect(devices.settings("laptop").worktreeBranchPrefix).toBe("team");
    expect(devices.settings("laptop").settingsSharing.worktreeBranchPrefix?.mode).toBe("shared");
    expect(devices.settings("studio").worktreeBranchPrefix).toBe("ryco");

    devices.update("studio", (device) => {
      device.connected = true;
    });
    await expect.poll(() => devices.settings("studio").worktreeBranchPrefix).toBe("team");
    expect(devices.settings("studio").settingsSharing.worktreeBranchPrefix).toEqual(
      devices.settings("laptop").settingsSharing.worktreeBranchPrefix,
    );
  });
  it("backs up the shown device's value where the devices disagree", async () => {
    const devices = createTestSharedSettings([
      { id: "laptop", label: "Laptop", settings: { gitWritingStyle: "conventional" } },
      { id: "studio", label: "Studio", settings: { gitWritingStyle: "repository" } },
    ]);
    await showRows(devices, { shownEnvironmentId: EnvironmentId.make("studio") });
    const backup = await exportFile();
    expect((backup.value.deviceSettings as Record<string, unknown>).gitWritingStyle).toBe(
      "repository",
    );
    // A file with device settings is version 2: an older Ryco asks for an update.
    expect(backup.value.version).toBe(2);
  });

  it("offers no Apply when no device can be written, and says nothing is queued", async () => {
    const devices = createTestSharedSettings([
      { id: "laptop", label: "Laptop", canWrite: false },
      { id: "studio", label: "Studio", connected: false, sharingVersion: null },
    ]);
    const view = await showRows(devices);
    await importFile(view, {
      format: "ryco-client-settings",
      version: 2,
      deviceSettings: { worktreeBranchPrefix: "team" },
    });

    await expect
      .element(page.getByText(/Laptop · 1 change · not changed: only an owner can change it/))
      .toBeVisible();
    await expect.element(page.getByText(/Studio · 1 change · not changed: offline/)).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Apply" })).toBeDisabled();
  });

  it("drops a picked device from the plan once it goes offline", async () => {
    const devices = createTestSharedSettings([
      { id: "laptop", label: "Laptop" },
      { id: "studio", label: "Studio" },
    ]);
    const view = await showRows(devices);
    await importFile(view, {
      format: "ryco-client-settings",
      version: 2,
      deviceSettings: { worktreeBranchPrefix: "team" },
    });
    await page.getByRole("radio", { name: /Only these devices/ }).click();
    await expect
      .element(
        page.getByRole("group", { name: "Devices" }).getByRole("checkbox", { name: "Studio" }),
      )
      .toBeChecked();

    devices.update("studio", (device) => {
      device.connected = false;
    });
    await expect
      .element(
        page.getByRole("group", { name: "Devices" }).getByRole("checkbox", { name: "Studio" }),
      )
      .not.toBeInTheDocument();
    await expect
      .element(page.getByRole("list", { name: "Changes on Studio" }))
      .not.toBeInTheDocument();

    await page.getByRole("button", { name: "Apply" }).click();
    const results = page.getByRole("list", { name: "Device results" });
    await expect.element(results).toHaveTextContent("Laptop: 1 setting applied");
    expect(results.element().textContent).not.toContain("Studio");
    expect(devices.settings("studio").worktreeBranchPrefix).toBe("ryco");
  });

  it("restores this app's part once: Apply again after a failed device part retries only that", async () => {
    const devices = createTestSharedSettings([{ id: "laptop", label: "Laptop" }]);
    // Sharing is not ready (no signed-in account): no stamp for device writes.
    const view = await showRows(devices, { source: { ...devices.source, nextStamp: () => null } });
    await importFile(view, {
      format: "ryco-client-settings",
      version: 2,
      customThemes: [{ id: "custom-sunset", name: "Sunset", builtIn: false }],
      deviceSettings: { worktreeBranchPrefix: "team" },
    });
    await expect.element(page.getByText("custom theme: Sunset")).toBeVisible();

    const customThemes = () => getCustomThemes().length;
    await page.getByRole("button", { name: "Apply" }).click();
    await expect
      .element(page.getByRole("alert"))
      .toHaveTextContent(
        "This app's settings were restored. Device settings can't be written yet: sign in first.",
      );
    await expect.element(page.getByText("This app's settings are restored.")).toBeVisible();

    await page.getByRole("button", { name: "Apply" }).click();
    await expect
      .element(page.getByRole("alert"))
      .toHaveTextContent("Device settings can't be written yet: sign in first.");
    expect(customThemes()).toBe(1);
  });
});
