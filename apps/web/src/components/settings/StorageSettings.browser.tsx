import "../../index.css";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";
import { DEFAULT_SERVER_SETTINGS } from "@ryco/contracts";
import { StorageSettings } from "./StorageSettings";

const fixtures = vi.hoisted(() => ({
  ready: true,
  settings: {} as typeof DEFAULT_SERVER_SETTINGS,
  scan: vi.fn(),
  preview: vi.fn(),
  execute: vi.fn(),
  save: vi.fn(),
}));
vi.mock("../../lib/utils", () => ({
  cn: (...values: unknown[]) => values.filter(Boolean).join(" "),
}));
vi.mock("../../rpc/serverState", () => ({
  useServerConfig: () => ({
    settings: fixtures.settings,
    environment: { environmentId: "fixture-node", capabilities: { storageManagement: true } },
  }),
}));
vi.mock("../../settingsTarget", () => ({
  useSettingsEditingScope: () => "node",
  useSettingsTarget: () => ({
    environmentId: "fixture-node",
    nodeLabel: "Fixture node",
    connected: true,
    canManage: true,
    canMutate: fixtures.ready,
  }),
}));
vi.mock("../../environments/runtime", () => {
  const client = {
    storage: { scan: fixtures.scan, preview: fixtures.preview, execute: fixtures.execute },
  };
  return {
    readEnvironmentConnection: () => ({ client }),
    updateEnvironmentServerSettings: fixtures.save,
  };
});
let mounted: Awaited<ReturnType<typeof render>> | null = null;
beforeEach(() => {
  fixtures.ready = true;
  fixtures.settings = DEFAULT_SERVER_SETTINGS;
  vi.clearAllMocks();
  const entries = [
    {
      id: "repo",
      projectId: "project",
      category: "repository",
      label: "Fixture repository",
      path: "/fixture/repository",
      bytes: 2048,
      sizeStatus: "complete",
      eligible: false,
      reason: "Repositories are protected.",
    },
    {
      id: "checkout",
      projectId: "project",
      category: "worktree",
      label: "Completed checkout",
      path: "/fixture/checkout",
      bytes: 1024,
      sizeStatus: "complete",
      eligible: true,
      reason: "Archived, stopped and clean.",
    },
    {
      id: "unknown",
      projectId: null,
      category: "protected",
      label: "Provider archives",
      path: "",
      bytes: null,
      sizeStatus: "unknown",
      eligible: false,
      reason: "Never scanned or removed.",
    },
  ];
  fixtures.scan.mockResolvedValue({
    entries,
    history: [],
    truncated: false,
    nextCursor: null,
    scannedAt: new Date().toISOString(),
  });
  fixtures.preview.mockResolvedValue({
    entries: [entries[1]],
    token: "fixture-preview",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  fixtures.execute.mockResolvedValue({
    results: [{ id: "checkout", status: "removed", detail: "Branches and history retained." }],
  });
  fixtures.save.mockImplementation(async (_id, patch) => {
    fixtures.settings = { ...fixtures.settings, ...patch };
  });
});
afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
});

it("reviews exact paths and requires typed confirmation before deleting", async () => {
  mounted = await render(<StorageSettings />);
  expect(fixtures.scan).not.toHaveBeenCalled();
  await mounted.getByRole("button", { name: "Scan storage" }).click();
  await expect
    .element(
      mounted.getByRole("checkbox", { name: "Provider archives · protected · Size unavailable" }),
    )
    .toBeDisabled();
  await expect
    .element(mounted.getByRole("checkbox", { name: /Fixture repository/ }))
    .toBeDisabled();
  await mounted.getByRole("checkbox", { name: /Completed checkout/ }).click();
  await mounted.getByRole("button", { name: "Preview cleanup (1)" }).click();
  await expect
    .element(mounted.getByRole("alertdialog", { name: "Confirm storage cleanup" }))
    .toBeVisible();
  await expect
    .element(mounted.getByRole("button", { name: "Delete reviewed data" }))
    .toBeDisabled();
  expect(fixtures.execute).not.toHaveBeenCalled();
  await mounted.getByRole("textbox", { name: "Type DELETE to confirm cleanup" }).fill("DELETE");
  await mounted.getByRole("button", { name: "Delete reviewed data" }).click();
  expect(fixtures.execute).toHaveBeenCalledWith({
    token: "fixture-preview",
    confirmation: "delete reviewed data",
  });
});

it("makes automatic cleanup an explicit opt-in and keeps synchronized ownership gating", async () => {
  mounted = await render(<StorageSettings />);
  await mounted.getByRole("button", { name: "Scan storage" }).click();
  await expect
    .element(mounted.getByRole("switch", { name: "Automatic retention cleanup" }))
    .not.toBeChecked();
  await mounted.getByRole("switch", { name: "Automatic retention cleanup" }).click();
  expect(fixtures.save).not.toHaveBeenCalled();
  await mounted.getByRole("button", { name: "Enable automatic cleanup", exact: true }).click();
  expect(fixtures.save).toHaveBeenCalledWith("fixture-node", {
    storageRetention: { automatic: true, completedWorktreeDays: 30, temporaryDataDays: null },
  });
  fixtures.ready = false;
  await mounted.rerender(<StorageSettings />);
  await expect.element(mounted.getByRole("button", { name: "Rescan" })).toBeDisabled();
});
