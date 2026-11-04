import "../../index.css";

import type { ServerChatsCapability } from "@ryco/contracts";
import { page, userEvent } from "vite-plus/test/browser";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

import { AppAtomRegistryProvider } from "../../rpc/atomRegistry";
import { ChatsFolderSettings } from "./ChatsFolderSettings";
import { SharedSettingsSourceProvider } from "./sharedSettings/sharedSettingsSource";
import {
  createTestSharedSettings,
  TestDeviceTarget,
} from "./sharedSettings/sharedSettingsTestSource";

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
  useSavedEnvironmentRegistryStore: Object.assign(
    (selector: (state: { byId: Record<string, never> }) => unknown) => selector({ byId: {} }),
    { getState: () => ({ byId: {} }), subscribe: () => () => undefined },
  ),
  useSavedEnvironmentRuntimeStore: Object.assign(
    (selector: (state: { byId: Record<string, never> }) => unknown) => selector({ byId: {} }),
    { getState: () => ({ byId: {} }), subscribe: () => () => undefined },
  ),
}));

const NODE = "environment-remote";

function renderChats(chats: ServerChatsCapability | undefined) {
  const network = createTestSharedSettings([
    { id: NODE, label: "Remote test node", ...(chats ? { extra: { chats } } : {}) },
  ]);
  network.device(NODE).reject = (patch) =>
    patch.chatsRoot === "relative/chats"
      ? "Chats folder must be an absolute directory on this node or start with ~/."
      : null;
  const ui = (
    <AppAtomRegistryProvider>
      <SharedSettingsSourceProvider value={network.source}>
        <TestDeviceTarget network={network} id={NODE}>
          <ChatsFolderSettings />
        </TestDeviceTarget>
      </SharedSettingsSourceProvider>
    </AppAtomRegistryProvider>
  );
  return { network, ui };
}

describe("ChatsFolderSettings", () => {
  let mounted: Awaited<ReturnType<typeof render>> | null = null;

  afterEach(async () => {
    await mounted?.unmount();
    mounted = null;

    document.body.innerHTML = "";
  });

  it("saves the chats folder to the selected node and explains what moves", async () => {
    const { network, ui } = renderChats({ available: true, root: "/home/me/.ryco/chats" });
    mounted = await render(ui);
    await expect.element(page.getByText("Effective: /home/me/.ryco/chats")).toBeVisible();
    await expect
      .element(page.getByText("existing chats stay where they are", { exact: false }))
      .toBeVisible();
    const directory = page.getByRole("textbox", { name: "Chats folder directory" });
    await directory.fill("~/Chats");
    await userEvent.keyboard("{Enter}");
    // The only device: a shared write, so it keeps following the shared value.
    await expect
      .poll(() => network.device(NODE).writes.at(-1))
      .toEqual(
        expect.objectContaining({
          chatsRoot: "~/Chats",
          settingsSharing: {
            chatsRoot: expect.objectContaining({ mode: "shared", onlyIfOlderShared: true }),
          },
        }),
      );
    await page.getByRole("button", { name: "Reset chats folder to default" }).click();
    await expect
      .poll(() => network.device(NODE).writes.at(-1))
      .toEqual(expect.objectContaining({ chatsRoot: "" }));
  });

  it("shows validation errors from the node", async () => {
    mounted = await render(renderChats({ available: true }).ui);
    await page.getByRole("textbox", { name: "Chats folder directory" }).fill("relative/chats");
    await userEvent.keyboard("{Enter}");
    await expect.element(page.getByRole("status")).toMatchTextContent("absolute directory");
  });

  it("explains why chats are unavailable but still lets the user fix the folder", async () => {
    mounted = await render(
      renderChats({ available: false, unavailableReason: "inside-git-repository" }).ui,
    );
    await expect
      .element(page.getByTestId("chats-folder-unavailable"))
      .toMatchTextContent("inside a Git repository");
    await expect
      .element(page.getByRole("textbox", { name: "Chats folder directory" }))
      .toBeEnabled();
  });

  it("disables the folder on a node without chat support", async () => {
    mounted = await render(renderChats(undefined).ui);
    await expect
      .element(page.getByTestId("chats-folder-unavailable"))
      .toMatchTextContent("does not support chats");
    await expect
      .element(page.getByRole("textbox", { name: "Chats folder directory" }))
      .toBeDisabled();
  });

  it("removes empty chat folders after 3 idle days by default and saves another choice", async () => {
    const { network, ui } = renderChats({ available: true });
    mounted = await render(ui);
    const select = page.getByRole("combobox", { name: "Remove empty chat folders" });
    await expect.element(select).toMatchTextContent("After 3 idle days");
    await expect
      .element(page.getByText("comes back as soon as it is needed again", { exact: false }))
      .toBeVisible();
    await select.click();
    await page.getByRole("option", { name: "Never" }).click();
    await expect
      .poll(() => network.device(NODE).writes.at(-1))
      .toEqual(expect.objectContaining({ chatFolderCleanupAfterDays: null }));
    await expect.element(select).toMatchTextContent("Never");
    await page.getByRole("button", { name: "Reset empty chat folder cleanup to default" }).click();
    await expect
      .poll(() => network.device(NODE).writes.at(-1))
      .toEqual(expect.objectContaining({ chatFolderCleanupAfterDays: 3 }));
  });

  it("disables empty chat folder cleanup on a node without chat support", async () => {
    mounted = await render(renderChats(undefined).ui);
    await expect
      .element(page.getByRole("combobox", { name: "Remove empty chat folders" }))
      .toBeDisabled();
  });
});
