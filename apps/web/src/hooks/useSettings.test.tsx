import { DEFAULT_SERVER_SETTINGS, type ServerConfig } from "@ryco/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { localApi, addToast } = vi.hoisted(() => ({
  localApi: { server: { updateSettings: vi.fn(), getSettings: vi.fn() } },
  addToast: vi.fn(),
}));
vi.mock("~/localApi", () => ({ ensureLocalApi: () => localApi }));
vi.mock("~/components/ui/toast", () => ({ toastManager: { add: addToast } }));
vi.mock("~/environments/runtime", () => ({ updateEnvironmentServerSettings: vi.fn() }));

import {
  getServerConfig,
  resetServerStateForTests,
  setServerConfigSnapshot,
} from "~/rpc/serverState";
import { useUpdateSettings } from "./useSettings";

const RELOAD_FAILURE = "[SETTINGS] could not reload settings after a failed update";

type UpdateSettings = ReturnType<typeof useUpdateSettings>["updateSettings"];

function Probe(props: { readonly capture: (updateSettings: UpdateSettings) => void }) {
  props.capture(useUpdateSettings().updateSettings);
  return null;
}

function renderUpdateSettings(): UpdateSettings {
  let updateSettings: UpdateSettings | undefined;
  renderToStaticMarkup(
    <Probe
      capture={(next) => {
        updateSettings = next;
      }}
    />,
  );
  return updateSettings!;
}

describe("useUpdateSettings on the primary node", () => {
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

  beforeEach(() => {
    resetServerStateForTests();
    setServerConfigSnapshot({
      settings: DEFAULT_SERVER_SETTINGS,
      providers: [],
      issues: [],
    } as unknown as ServerConfig);
    localApi.server.updateSettings.mockReset();
    localApi.server.getSettings.mockReset();
    addToast.mockReset();
    consoleError.mockClear();
  });

  it("reports a rejected write and applies the server's current settings", async () => {
    const serverSettings = { ...DEFAULT_SERVER_SETTINGS, worktreeBranchPrefix: "server" };
    localApi.server.updateSettings.mockRejectedValue(new Error("disk full"));
    localApi.server.getSettings.mockResolvedValue(serverSettings);

    renderUpdateSettings()({ worktreeBranchPrefix: "optimistic" });

    expect(getServerConfig()?.settings.worktreeBranchPrefix).toBe("optimistic");
    await vi.waitFor(() => expect(getServerConfig()?.settings).toBe(serverSettings));
    expect(addToast).toHaveBeenCalledWith({
      type: "error",
      title: "Could not save settings",
      description: "disk full",
    });
  });

  it("restores the previous settings when they cannot be reloaded", async () => {
    localApi.server.updateSettings.mockRejectedValue(new Error("disconnected"));
    localApi.server.getSettings.mockRejectedValue(new Error("disconnected"));

    renderUpdateSettings()({ worktreeBranchPrefix: "optimistic" });

    await vi.waitFor(() => expect(getServerConfig()?.settings).toBe(DEFAULT_SERVER_SETTINGS));
    expect(addToast).toHaveBeenCalledOnce();
  });

  it("keeps a newer optimistic write when the failed one cannot be reloaded", async () => {
    localApi.server.updateSettings
      .mockRejectedValueOnce(new Error("disconnected"))
      .mockReturnValueOnce(new Promise(() => {}));
    localApi.server.getSettings.mockRejectedValue(new Error("disconnected"));

    const updateSettings = renderUpdateSettings();
    updateSettings({ worktreeBranchPrefix: "first" });
    updateSettings({ worktreeBranchPrefix: "second" });

    await vi.waitFor(() =>
      expect(consoleError).toHaveBeenCalledWith(RELOAD_FAILURE, expect.anything()),
    );
    expect(getServerConfig()?.settings.worktreeBranchPrefix).toBe("second");
  });
});
