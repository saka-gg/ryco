// The providers × devices table of Providers & models: each device's state of each provider,
// Add and Edit targeted at a device, one-device mode, and offline or read-only devices shown
// read only. The devices are simulated (`sharedSettingsTestSource`).
import "../../index.css";

import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerConfig,
  type ServerProvider,
} from "@ryco/contracts";
import { page } from "vite-plus/test/browser";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

import { ProviderDeviceTable } from "./ProviderDeviceTable";
import { useProviderEditorRequest } from "./providerEditorRequest";
import {
  SharedSettingsModeProvider,
  type SharedSettingsModeValue,
} from "./sharedSettings/sharedSettingsMode";
import { SharedSettingsSourceProvider } from "./sharedSettings/sharedSettingsSource";
import { createTestSharedSettings } from "./sharedSettings/sharedSettingsTestSource";
import type { SettingsDeviceChoice } from "./useSettingsDevices";

const codex = ProviderDriverKind.make("codex");
const claude = ProviderDriverKind.make("claudeAgent");

function live(
  instanceId: string,
  driver: ProviderDriverKind,
  overrides: Partial<ServerProvider> = {},
) {
  return {
    instanceId: ProviderInstanceId.make(instanceId),
    driver,
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-11-03T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    ...overrides,
  } as ServerProvider;
}

function choice(
  id: string,
  label: string,
  overrides: Partial<SettingsDeviceChoice> = {},
): SettingsDeviceChoice {
  return {
    environmentId: EnvironmentId.make(id),
    label,
    disabled: false,
    status: null,
    kind: "remote",
    lastSeenAt: null,
    ...overrides,
  };
}

const ALL: SharedSettingsModeValue = { mode: { kind: "all" }, showDevice: null, targetLabel: null };

let mounted: Awaited<ReturnType<typeof render>> | null = null;

async function show(input: {
  readonly choices: ReadonlyArray<SettingsDeviceChoice>;
  readonly mode?: SharedSettingsModeValue;
  readonly canWriteStudio?: boolean;
  readonly studioConnected?: boolean;
}) {
  const network = createTestSharedSettings([
    {
      id: "laptop",
      label: "Laptop",
      settings: {
        providerInstances: {
          [ProviderInstanceId.make("claudeAgent_work")]: {
            driver: claude,
            enabled: true,
            displayName: "Work",
          },
        },
      },
      extra: {
        providers: [
          live("codex", codex),
          live("claudeAgent", claude, { auth: { status: "unauthenticated" }, status: "error" }),
          live("claudeAgent_work", claude),
        ],
      } as Partial<ServerConfig>,
    },
    {
      id: "studio",
      label: "Studio",
      connected: input.studioConnected ?? true,
      canWrite: input.canWriteStudio ?? true,
      extra: { providers: [live("codex", codex)] } as Partial<ServerConfig>,
    },
  ]);
  const select = vi.fn();
  const laptop = network.source.readDevices()[0]!;
  mounted = await render(
    <SharedSettingsSourceProvider value={network.source}>
      <SharedSettingsModeProvider value={input.mode ?? ALL}>
        <ProviderDeviceTable
          choices={input.choices}
          target={{
            environmentId: laptop.environmentId,
            nodeLabel: "Laptop",
            serverConfig: laptop.config as ServerConfig,
            primary: false,
            connected: true,
          }}
          select={select}
        />
      </SharedSettingsModeProvider>
    </SharedSettingsSourceProvider>,
  );
  return { network, select };
}

const cell = (provider: string, device: string) =>
  document.querySelector<HTMLElement>(
    `[data-testid="provider-device-row"][data-provider="${provider}"] td[data-device="${device}"]`,
  );

afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
  useProviderEditorRequest.setState({ request: null });
  document.body.innerHTML = "";
});

describe("the providers × devices table", () => {
  it("shows each device's state of each provider, grouped by instance id", async () => {
    await show({ choices: [choice("laptop", "Laptop"), choice("studio", "Studio")] });

    await expect.element(page.getByTestId("provider-device-table")).toBeVisible();
    await expect.poll(() => cell("Codex", "Laptop")?.dataset.status).toBe("ready");
    expect(cell("Codex", "Studio")?.dataset.status).toBe("ready");
    expect(cell("Claude", "Laptop")?.dataset.status).toBe("sign-in");
    // Studio's config lists no Claude status yet.
    expect(cell("Claude", "Studio")?.dataset.status).toBe("checking");
    expect(cell("Work", "Laptop")?.dataset.status).toBe("ready");
    expect(cell("Work", "Studio")?.dataset.status).toBe("missing");
    await expect.element(page.getByText("Claude · claudeAgent_work")).toBeVisible();
    // Each row is named by its provider for assistive tech.
    const rowHeaders = [...document.querySelectorAll('tbody th[scope="row"]')].map(
      (header) => header.querySelector("span")?.textContent,
    );
    expect(rowHeaders).toHaveLength(document.querySelectorAll("tbody tr").length);
    expect(rowHeaders.slice(0, 3)).toEqual(["Codex", "Claude", "Work"]);
    await expect.element(page.getByRole("rowheader", { name: /^Work/ })).toBeVisible();
  });

  it("adds a provider to the device of its column, through that device's add dialog", async () => {
    const { select } = await show({
      choices: [choice("laptop", "Laptop"), choice("studio", "Studio")],
    });

    await page.getByRole("button", { name: "Add Work to Studio" }).click();
    expect(useProviderEditorRequest.getState().request).toEqual({
      kind: "add",
      environmentId: "studio",
      preset: { driver: claude, displayName: "Work", instanceId: "claudeAgent_work" },
    });
    expect(select).toHaveBeenCalledWith("studio");
  });

  it("edits on the shown device without switching, and on another device by showing it", async () => {
    const { select } = await show({
      choices: [choice("laptop", "Laptop"), choice("studio", "Studio")],
    });

    await page.getByRole("button", { name: "Edit Work on Laptop" }).click();
    expect(useProviderEditorRequest.getState().request).toEqual({
      kind: "edit",
      environmentId: "laptop",
      instanceId: "claudeAgent_work",
    });
    expect(select).not.toHaveBeenCalled();

    await page.getByRole("button", { name: "Edit Codex on Studio" }).click();
    expect(useProviderEditorRequest.getState().request).toMatchObject({
      kind: "edit",
      environmentId: "studio",
      instanceId: "codex",
    });
    expect(select).toHaveBeenCalledWith("studio");
  });

  it("shows one column in one-device mode", async () => {
    await show({
      choices: [choice("laptop", "Laptop"), choice("studio", "Studio")],
      mode: {
        mode: { kind: "device", environmentId: EnvironmentId.make("studio") },
        showDevice: null,
        targetLabel: null,
      },
    });

    await expect.poll(() => cell("Codex", "Studio")?.dataset.status).toBe("ready");
    expect(cell("Codex", "Laptop")).toBeNull();
    expect([...document.querySelectorAll("thead th")].map((header) => header.textContent)).toEqual([
      "Provider",
      "Studio",
    ]);
  });

  it("shows an offline device's last known state, read only", async () => {
    const lastSeenAt = Date.now() - 2 * 60 * 60 * 1000;
    await show({
      choices: [
        choice("laptop", "Laptop"),
        choice("studio", "Studio", { status: "offline", lastSeenAt }),
      ],
      studioConnected: false,
    });

    await expect.element(page.getByText(/^Offline · Last seen 2/)).toBeVisible();
    await expect.poll(() => cell("Codex", "Studio")?.dataset.status).toBe("ready");
    expect(cell("Codex", "Studio")?.textContent).toContain("Ready when last seen");
    await expect
      .element(page.getByRole("button", { name: "Edit Codex on Studio" }))
      .not.toBeInTheDocument();
    await expect
      .element(page.getByRole("button", { name: "Add Work to Studio" }))
      .not.toBeInTheDocument();
  });

  it("offers no Add or Edit on a device this client may not change", async () => {
    await show({
      choices: [choice("laptop", "Laptop"), choice("studio", "Studio")],
      canWriteStudio: false,
    });

    await expect.poll(() => cell("Codex", "Studio")?.dataset.status).toBe("ready");
    await expect
      .element(page.getByRole("button", { name: "Edit Codex on Studio" }))
      .not.toBeInTheDocument();
    await expect
      .element(page.getByRole("button", { name: "Add Work to Studio" }))
      .not.toBeInTheDocument();
    await expect.element(page.getByRole("button", { name: "Edit Codex on Laptop" })).toBeVisible();
  });
});
