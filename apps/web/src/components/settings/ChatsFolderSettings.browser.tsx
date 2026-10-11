import "../../index.css";

import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  type ServerChatsCapability,
  type ServerConfig,
} from "@ryco/contracts";
import { applyServerSettingsPatch } from "@ryco/shared/serverSettings";
import { page, userEvent } from "vite-plus/test/browser";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { useState } from "react";
import { render } from "vitest-browser-react";

import { AppAtomRegistryProvider } from "../../rpc/atomRegistry";
import { SettingsTargetProvider } from "../../settingsTarget";
import { ChatsFolderEditor } from "./ChatsFolderSettings";

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

function baseConfig(chats: ServerChatsCapability | undefined): ServerConfig {
  return {
    environment: {
      environmentId: EnvironmentId.make("environment-remote"),
      label: "Remote test node",
      platform: { os: "darwin" as const, arch: "arm64" as const },
      serverVersion: "0.0.0-test",
      capabilities: {
        repositoryIdentity: true,
        threadSettlement: false,
        threadPriorityRanking: false,
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
    ...(chats ? { chats } : {}),
  };
}

function ChatsFolderHarness(props: { readonly chats: ServerChatsCapability | undefined }) {
  const [config, setConfig] = useState(() => baseConfig(props.chats));
  mockUpdateEnvironmentServerSettings.mockImplementation(async (_environmentId, patch) => {
    if (patch.chatsRoot === "relative/chats")
      throw new Error("Chats folder must be an absolute directory on this node or start with ~/.");
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
        <ChatsFolderEditor disabled={false} />
      </SettingsTargetProvider>
    </AppAtomRegistryProvider>
  );
}

describe("ChatsFolderSettings", () => {
  let mounted: Awaited<ReturnType<typeof render>> | null = null;

  afterEach(async () => {
    await mounted?.unmount();
    mounted = null;
    mockUpdateEnvironmentServerSettings.mockReset();
    document.body.innerHTML = "";
  });

  it("saves the chats folder to the selected node and explains what moves", async () => {
    mounted = await render(
      <ChatsFolderHarness chats={{ available: true, root: "/home/me/.ryco/chats" }} />,
    );
    await expect.element(page.getByText("Effective: /home/me/.ryco/chats")).toBeVisible();
    await expect
      .element(page.getByText("existing chats stay where they are", { exact: false }))
      .toBeVisible();
    const directory = page.getByRole("textbox", { name: "Chats folder directory" });
    await directory.fill("~/Chats");
    await userEvent.keyboard("{Enter}");
    await expect
      .poll(() => mockUpdateEnvironmentServerSettings.mock.calls.at(-1))
      .toEqual(["environment-remote", { chatsRoot: "~/Chats" }]);
    await page.getByRole("button", { name: "Reset chats folder to default" }).click();
    await expect
      .poll(() => mockUpdateEnvironmentServerSettings.mock.calls.at(-1))
      .toEqual(["environment-remote", { chatsRoot: "" }]);
  });

  it("shows validation errors from the node", async () => {
    mounted = await render(<ChatsFolderHarness chats={{ available: true }} />);
    await page.getByRole("textbox", { name: "Chats folder directory" }).fill("relative/chats");
    await userEvent.keyboard("{Enter}");
    await expect.element(page.getByRole("alert")).toMatchTextContent("absolute directory");
  });

  it("explains why chats are unavailable but still lets the user fix the folder", async () => {
    mounted = await render(
      <ChatsFolderHarness
        chats={{ available: false, unavailableReason: "inside-git-repository" }}
      />,
    );
    await expect
      .element(page.getByTestId("chats-folder-unavailable"))
      .toMatchTextContent("inside a Git repository");
    await expect
      .element(page.getByRole("textbox", { name: "Chats folder directory" }))
      .toBeEnabled();
  });

  it("disables the folder on a node without chat support", async () => {
    mounted = await render(<ChatsFolderHarness chats={undefined} />);
    await expect
      .element(page.getByTestId("chats-folder-unavailable"))
      .toMatchTextContent("does not support chats");
    await expect
      .element(page.getByRole("textbox", { name: "Chats folder directory" }))
      .toBeDisabled();
  });
});
