import "../../index.css";

import { DEFAULT_SERVER_SETTINGS, EnvironmentId, type ServerConfig } from "@ryco/contracts";
import { applyServerSettingsPatch } from "@ryco/shared/serverSettings";
import { page } from "vite-plus/test/browser";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { useState } from "react";
import { render } from "vitest-browser-react";

import { AppAtomRegistryProvider } from "../../rpc/atomRegistry";
import { SettingsTargetProvider } from "../../settingsTarget";
import { GitWritingStyleEditor } from "./GitWritingStyleSettings";

const mockUpdateEnvironmentServerSettings = vi.hoisted(() => vi.fn());

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
  updateEnvironmentServerSettings: mockUpdateEnvironmentServerSettings,
  useSavedEnvironmentRegistryStore: (
    selector: (state: { byId: Record<string, never> }) => unknown,
  ) => selector({ byId: {} }),
  useSavedEnvironmentRuntimeStore: (
    selector: (state: { byId: Record<string, never> }) => unknown,
  ) => selector({ byId: {} }),
}));

const PROJECTS = [{ id: "p1", title: "Project One" }];

function baseConfig(supported: boolean): ServerConfig {
  return {
    environment: {
      environmentId: EnvironmentId.make("environment-remote"),
      label: "Remote test node",
      platform: { os: "darwin" as const, arch: "arm64" as const },
      serverVersion: "0.0.0-test",
      capabilities: {
        repositoryIdentity: true,
        threadSettlement: false,
        ...(supported ? { gitWritingStyle: true } : {}),
      },
    },
    auth: {
      policy: "loopback-browser",
      bootstrapMethods: ["one-time-token"],
      sessionMethods: ["browser-session-cookie", "bearer-session-token"],
      sessionCookieName: "ryco_session",
    },
    cwd: "/repo/project",
    keybindingsConfigPath: "/repo/project/.ryco-keybindings.json",
    keybindings: [],
    issues: [],
    providers: [],
    availableEditors: [],
    observability: {
      logsDirectoryPath: "/repo/project/.ryco/logs",
      localTracingEnabled: true,
      otlpTracesEnabled: false,
      otlpMetricsEnabled: false,
    },
    settings: DEFAULT_SERVER_SETTINGS,
  };
}

function Harness(props: {
  readonly projectId: string;
  readonly supported?: boolean;
  readonly projects?: ReadonlyArray<{ readonly id: string; readonly title: string }>;
}) {
  const [config, setConfig] = useState(() => baseConfig(props.supported ?? true));
  mockUpdateEnvironmentServerSettings.mockImplementation(async (_environmentId, patch) => {
    setConfig((current) => ({
      ...current,
      settings: applyServerSettingsPatch(current.settings, patch),
    }));
  });
  return (
    <AppAtomRegistryProvider>
      <SettingsTargetProvider
        value={{
          environmentId: config.environment.environmentId,
          nodeLabel: "Remote test node",
          serverConfig: config,
          primary: false,
          connected: true,
          canManage: true,
        }}
      >
        <GitWritingStyleEditor
          projectId={props.projectId}
          projects={props.projects ?? PROJECTS}
          disabled={false}
        />
      </SettingsTargetProvider>
    </AppAtomRegistryProvider>
  );
}

describe("GitWritingStyleSettings", () => {
  let mounted: Awaited<ReturnType<typeof render>> | null = null;

  afterEach(async () => {
    await mounted?.unmount();
    mounted = null;
    mockUpdateEnvironmentServerSettings.mockReset();
    document.body.innerHTML = "";
  });

  it("saves the node's style and describes it", async () => {
    mounted = await render(<Harness projectId="" />);
    const style = page.getByRole("combobox", { name: "Writing style" });
    await expect.element(style).toHaveTextContent("Repository style");
    await expect
      .element(page.getByText("Follow the style of recent commits and merged pull requests."))
      .toBeVisible();
    await style.click();
    await page.getByRole("option", { name: "Conventional Commits", exact: true }).click();
    await expect
      .poll(() => mockUpdateEnvironmentServerSettings.mock.calls.at(-1))
      .toEqual(["environment-remote", { gitWritingStyle: "conventional" }]);
    await expect.element(style).toHaveTextContent("Conventional Commits");
  });

  it("overrides one project and inherits again", async () => {
    mounted = await render(<Harness projectId="p1" />);
    const style = page.getByRole("combobox", { name: "Writing style" });
    await expect.element(style).toHaveTextContent("Inherit");
    await expect
      .element(page.getByText("Uses the device default (Repository style)."))
      .toBeVisible();
    await style.click();
    await page.getByRole("option", { name: "Conventional Commits", exact: true }).click();
    await expect
      .poll(() => mockUpdateEnvironmentServerSettings.mock.calls.at(-1))
      .toEqual(["environment-remote", { projectGitWritingStyle: { p1: "conventional" } }]);
    await style.click();
    await page.getByRole("option", { name: "Inherit", exact: true }).click();
    await expect
      .poll(() => mockUpdateEnvironmentServerSettings.mock.calls.at(-1))
      .toEqual(["environment-remote", { projectGitWritingStyle: { p1: null } }]);
    await expect.element(style).toHaveTextContent("Inherit");
  });

  it("asks to update a node that does not know the setting", async () => {
    mounted = await render(<Harness projectId="" supported={false} />);
    await expect.element(page.getByRole("combobox", { name: "Writing style" })).toBeDisabled();
    await expect
      .element(page.getByText("Update this node to choose a writing style."))
      .toBeVisible();
    expect(mockUpdateEnvironmentServerSettings).not.toHaveBeenCalled();
  });

  it("does not edit a removed project", async () => {
    mounted = await render(<Harness projectId="gone" />);
    await expect.element(page.getByRole("combobox", { name: "Writing style" })).toBeDisabled();
    expect(mockUpdateEnvironmentServerSettings).not.toHaveBeenCalled();
  });
});
