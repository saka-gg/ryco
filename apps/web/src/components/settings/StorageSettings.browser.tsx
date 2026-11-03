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
let scanned: Record<string, unknown> = {};
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
  scanned = {
    entries,
    history: [],
    truncated: false,
    nextCursor: null,
    scannedAt: new Date().toISOString(),
  };
  fixtures.scan.mockResolvedValue(scanned);
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

it("shows the node's database from the scan, and nothing from a node without the report", async () => {
  mounted = await render(<StorageSettings />);
  await mounted.getByRole("button", { name: "Scan storage" }).click();
  await expect.element(mounted.getByRole("checkbox", { name: /Completed checkout/ })).toBeVisible();
  expect(mounted.container.textContent).not.toContain("Automatic shrinking");

  fixtures.scan.mockResolvedValue({
    ...scanned,
    database: {
      fileBytes: 8 * 1024 * 1024,
      walBytes: 1024 * 1024,
      pageSize: 4096,
      pageCount: 2048,
      freePages: 512,
      autoVacuum: "incremental",
      compaction: {
        enabled: true,
        headSequence: 1000,
        compactedThroughSequence: 400,
        caughtUp: false,
        lastPassCompletedAt: "2026-10-23T12:00:00.000Z",
        removedEvents: 1200,
        removedBytes: 2 * 1024 * 1024,
        estimatedCompactableBytes: 3 * 1024 * 1024,
      },
      reclaimableBytes: 5 * 1024 * 1024,
    },
  });
  await mounted.getByRole("button", { name: "Rescan" }).click();
  await expect
    .element(mounted.getByRole("heading", { name: "Database", exact: true }))
    .toBeVisible();
  // File plus write-ahead log: what the database occupies on disk.
  await expect.element(mounted.getByText("9.0 MiB", { exact: true })).toBeVisible();
  await expect
    .element(mounted.getByText(/including the 1\.0 MiB write-ahead log\. SQLite keeps reusing/))
    .toBeVisible();
  // The log file stays its size after its writes are merged, so its size is not pending data.
  expect(mounted.container.textContent).not.toContain("not yet merged");
  await expect.element(mounted.getByText("2.0 MiB", { exact: true })).toBeVisible();
  await expect.element(mounted.getByText(/Free space beyond 1 MiB is returned/)).toBeVisible();
  await expect
    .element(
      mounted.getByText(
        /superseded progress updates \(2\.0 MiB\)\. Catching up: 40% of history examined/,
      ),
    )
    .toBeVisible();
  await expect.element(mounted.getByText("5.0 MiB", { exact: true })).toBeVisible();
  await expect.element(mounted.getByText(/about 3\.0 MiB of superseded history/)).toBeVisible();
});

it("says when a database cannot shrink and compaction is off", async () => {
  fixtures.scan.mockResolvedValue({
    ...scanned,
    database: {
      fileBytes: 1024,
      walBytes: 0,
      pageSize: 4096,
      pageCount: 1,
      freePages: 0,
      autoVacuum: "none",
      compaction: {
        enabled: false,
        headSequence: 0,
        compactedThroughSequence: 0,
        caughtUp: false,
        lastPassCompletedAt: null,
        removedEvents: 0,
        removedBytes: 0,
        estimatedCompactableBytes: null,
      },
      reclaimableBytes: 0,
    },
  });
  mounted = await render(<StorageSettings />);
  await mounted.getByRole("button", { name: "Scan storage" }).click();
  await expect.element(mounted.getByText(/created before automatic shrinking/)).toBeVisible();
  await expect.element(mounted.getByText("On disk; the write-ahead log is empty.")).toBeVisible();
  await expect.element(mounted.getByText("Off on this node. Nothing removed yet.")).toBeVisible();
  await expect
    .element(mounted.getByText(/An estimate of superseded history follows the first/))
    .toBeVisible();
});

it("suggests the offline doctor with its command only when the node recommends it", async () => {
  const database = {
    fileBytes: 6 * 1024 ** 3,
    walBytes: 0,
    pageSize: 4096,
    pageCount: (6 * 1024 ** 3) / 4096,
    freePages: (512 * 1024 ** 2) / 4096,
    autoVacuum: "none",
    compaction: {
      enabled: true,
      headSequence: 1000,
      compactedThroughSequence: 900,
      caughtUp: true,
      lastPassCompletedAt: "2026-10-23T12:00:00.000Z",
      removedEvents: 1200,
      removedBytes: 2 * 1024 ** 3,
      estimatedCompactableBytes: 0,
    },
    reclaimableBytes: 2.5 * 1024 ** 3,
  };
  fixtures.scan.mockResolvedValue({
    ...scanned,
    database: { ...database, doctor: { recommended: false, command: "ryco doctor --apply" } },
  });
  mounted = await render(<StorageSettings />);
  await mounted.getByRole("button", { name: "Scan storage" }).click();
  await expect.element(mounted.getByText(/created before automatic shrinking/)).toBeVisible();
  expect(mounted.container.textContent).not.toContain("Shrink the database file");

  fixtures.scan.mockResolvedValue({
    ...scanned,
    database: {
      ...database,
      doctor: { recommended: true, command: "npx ryco-cli@0.1.36 doctor --apply" },
    },
  });
  await mounted.getByRole("button", { name: "Rescan" }).click();
  await expect.element(mounted.getByText("Shrink the database file")).toBeVisible();
  await expect
    .element(mounted.getByTestId("database-doctor-command"))
    .toHaveTextContent("npx ryco-cli@0.1.36 doctor --apply");
  await expect.element(mounted.getByText(/About 2\.5 GiB could be returned/)).toBeVisible();
  await expect.element(mounted.getByText(/Quit the Ryco app first/)).toBeVisible();
  await expect.element(mounted.getByRole("button", { name: "Copy" })).toBeVisible();
});
