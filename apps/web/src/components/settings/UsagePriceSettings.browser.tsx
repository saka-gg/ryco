import "../../index.css";

import { usageSummaryCache } from "@ryco/client-runtime/usage";
import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  type ServerConfig,
  type UsagePriceOverrides,
} from "@ryco/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";

import { AppAtomRegistryProvider } from "../../rpc/atomRegistry";
import { SettingsEditingScopeProvider, SettingsTargetProvider } from "../../settingsTarget";
import { UsagePriceSettings } from "./UsagePriceSettings";
import { requestUsagePriceRow, useUsagePriceRowRequestStore } from "./usagePriceSettingsRequest";

const harness = vi.hoisted(() => ({ updateSettings: vi.fn() }));

// Only the settings write is observed; nothing here connects to an environment.
vi.mock("../../environments/runtime", () => ({
  getEnvironmentHttpBaseUrl: () => "http://localhost:3000",
  getSavedEnvironmentRecord: () => null,
  getSavedEnvironmentRuntimeState: () => null,
  hasSavedEnvironmentRegistryHydrated: () => true,
  listSavedEnvironmentRecords: () => [],
  resetSavedEnvironmentRegistryStoreForTests: () => undefined,
  resetSavedEnvironmentRuntimeStoreForTests: () => undefined,
  resolveEnvironmentHttpUrl: (_environmentId: unknown, path: string) =>
    new URL(path, "http://localhost:3000").toString(),
  waitForSavedEnvironmentRegistryHydration: async () => undefined,
  addSavedEnvironment: vi.fn(),
  connectPrimaryEnvironment: vi.fn(),
  connectDesktopWorkspaceEnvironment: vi.fn(),
  connectDesktopSshEnvironment: vi.fn(),
  disconnectPrimaryEnvironment: vi.fn(),
  disconnectSavedEnvironment: vi.fn(),
  ensureEnvironmentConnectionBootstrapped: async () => undefined,
  getPrimaryEnvironmentConnection: () => null,
  readEnvironmentConnection: () => null,
  reconnectSavedEnvironment: vi.fn(),
  removeSavedEnvironment: vi.fn(),
  requireEnvironmentConnection: vi.fn(),
  resetEnvironmentServiceForTests: () => undefined,
  startEnvironmentConnectionService: () => undefined,
  subscribeEnvironmentConnections: () => () => {},
  updateEnvironmentServerSettings: harness.updateSettings,
  useSavedEnvironmentRegistryStore: (
    selector: (state: { byId: Record<string, never> }) => unknown,
  ) => selector({ byId: {} }),
  useSavedEnvironmentRuntimeStore: (
    selector: (state: { byId: Record<string, never> }) => unknown,
  ) => selector({ byId: {} }),
}));

const environmentId = EnvironmentId.make("env-prices");

const SAVED: UsagePriceOverrides = {
  "claude-preview-x": { price: { inputUsdPerMillion: 3, outputUsdPerMillion: 15 } },
  "gateway/sonnet": { mapTo: "claude-sonnet-4-5" },
};

function Fixture(props: {
  readonly supported?: boolean;
  readonly overrides?: UsagePriceOverrides;
  readonly canManage?: boolean;
}) {
  const serverConfig = {
    settings: { ...DEFAULT_SERVER_SETTINGS, usagePriceOverrides: props.overrides ?? SAVED },
    environment: {
      capabilities: props.supported === false ? {} : { usagePriceOverrides: true },
    },
  } as unknown as ServerConfig;
  return (
    <AppAtomRegistryProvider>
      <SettingsEditingScopeProvider value="node">
        <SettingsTargetProvider
          value={{
            environmentId,
            nodeLabel: "Studio Mac",
            serverConfig,
            primary: false,
            connected: true,
            canManage: props.canManage ?? true,
          }}
        >
          <UsagePriceSettings />
        </SettingsTargetProvider>
      </SettingsEditingScopeProvider>
    </AppAtomRegistryProvider>
  );
}

describe("UsagePriceSettings", () => {
  let mounted: Awaited<ReturnType<typeof render>> | null = null;

  beforeEach(async () => {
    await page.viewport(1_280, 800);
    harness.updateSettings.mockReset();
    harness.updateSettings.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    await mounted?.unmount();
    mounted = null;
    useUsagePriceRowRequestStore.setState({ request: null });
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  it("shows saved prices and mappings, and saves a new price with only that entry", async () => {
    const forget = vi.spyOn(usageSummaryCache, "forget");
    mounted = await render(<Fixture />);
    await expect.element(page.getByText("claude-preview-x", { exact: true })).toBeVisible();
    await expect.element(page.getByLabelText("Input price of claude-preview-x")).toHaveValue("3");
    await expect
      .element(page.getByLabelText("Count gateway/sonnet as"))
      .toHaveValue("claude-sonnet-4-5");

    await page.getByRole("button", { name: "Add model price" }).click();
    await expect.element(page.getByLabelText("New model ID")).toHaveFocus();
    await page.getByLabelText("New model ID").fill("claude-opus-5-preview");
    await page.getByLabelText("Input price of claude-opus-5-preview").fill("5");
    await expect
      .element(page.getByText("Enter input and output prices.", { exact: true }))
      .toBeVisible();
    await expect.element(page.getByRole("button", { name: "Save prices" })).toBeDisabled();
    await page.getByLabelText("Output price of claude-opus-5-preview").fill("25");
    await page.getByLabelText("Cache read price of claude-opus-5-preview").fill("0.5");
    await page.getByRole("button", { name: "Save prices" }).click();

    expect(harness.updateSettings).toHaveBeenCalledWith(environmentId, {
      usagePriceOverrides: {
        "claude-opus-5-preview": {
          price: { inputUsdPerMillion: 5, outputUsdPerMillion: 25, cacheReadUsdPerMillion: 0.5 },
        },
      },
    });
    await expect.element(page.getByRole("status")).toMatchTextContent(/Saved/u);
    expect(forget).toHaveBeenCalledWith(environmentId);
    await expect.element(page.getByLabelText("New model ID")).not.toBeInTheDocument();
  });

  it("switches a price to a mapping and removes an entry with null", async () => {
    mounted = await render(<Fixture />);
    await page.getByRole("combobox", { name: "How to price claude-preview-x" }).click();
    await page.getByRole("option", { name: "Map to" }).click();
    await page.getByLabelText("Count claude-preview-x as").fill("claude-opus-4-1");
    await page.getByRole("button", { name: "Remove gateway/sonnet" }).click();
    await expect.element(page.getByText("Removed when saved")).toBeVisible();
    await page.getByRole("button", { name: "Save prices" }).click();

    expect(harness.updateSettings).toHaveBeenCalledWith(environmentId, {
      usagePriceOverrides: {
        "claude-preview-x": { mapTo: "claude-opus-4-1" },
        "gateway/sonnet": null,
      },
    });
  });

  it("explains a model listed twice and does not save it", async () => {
    mounted = await render(<Fixture />);
    await page.getByRole("button", { name: "Add model price" }).click();
    await page.getByLabelText("New model ID").fill("Claude-Preview-X");
    await page.getByLabelText("Input price of Claude-Preview-X").fill("1");
    await page.getByLabelText("Output price of Claude-Preview-X").fill("2");
    await expect
      .element(page.getByRole("alert"))
      .toHaveTextContent("This model is already listed.");
    await expect.element(page.getByRole("button", { name: "Save prices" })).toBeDisabled();

    await page.getByRole("button", { name: "Discard" }).click();
    await expect.element(page.getByLabelText("New model ID")).not.toBeInTheDocument();
    expect(harness.updateSettings).not.toHaveBeenCalled();
  });

  it("reports a failed save and keeps the edits", async () => {
    harness.updateSettings.mockRejectedValue(new Error("The node is not reachable."));
    mounted = await render(<Fixture />);
    await page.getByLabelText("Input price of claude-preview-x").fill("4");
    await page.getByRole("button", { name: "Save prices" }).click();
    await expect.element(page.getByText("The node is not reachable.")).toBeVisible();
    await expect.element(page.getByLabelText("Input price of claude-preview-x")).toHaveValue("4");
  });

  it("asks to update a node that predates custom prices instead of saving into it", async () => {
    mounted = await render(<Fixture supported={false} overrides={{}} />);
    await expect
      .element(page.getByText("Update Ryco on this node to set custom model prices."))
      .toBeVisible();
    await expect.element(page.getByRole("button", { name: "Add model price" })).toBeDisabled();
  });

  it("is read-only for a node this client cannot manage", async () => {
    mounted = await render(<Fixture canManage={false} />);
    await expect.element(page.getByRole("button", { name: "Add model price" })).toBeDisabled();
    await expect.element(page.getByLabelText("Input price of claude-preview-x")).toBeDisabled();
    await expect
      .element(page.getByRole("button", { name: "Remove gateway/sonnet" }))
      .toBeDisabled();
  });

  it("adds a row for a model the Usage page asked to price on this node", async () => {
    requestUsagePriceRow(EnvironmentId.make("another-node"), "ignored-model");
    requestUsagePriceRow(environmentId, "claude-preview-y");
    mounted = await render(<Fixture />);
    await expect.element(page.getByLabelText("New model ID")).toHaveValue("claude-preview-y");
    await expect.poll(() => useUsagePriceRowRequestStore.getState().request).toBeNull();
  });
});
