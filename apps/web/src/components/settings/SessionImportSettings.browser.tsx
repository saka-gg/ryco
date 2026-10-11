import "../../index.css";
import { page } from "vite-plus/test/browser";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";
const harness = vi.hoisted(() => ({
  discover: vi.fn(),
  run: vi.fn(),
  sources: vi.fn(),
  reconcile: vi.fn(),
  adopt: vi.fn(),
  allowed: true,
}));
import { SessionImportPanel } from "./SessionImportPanel";

async function chooseOption(label: string, option: string) {
  await page.getByLabelText(label, { exact: true }).click();
  await page.getByRole("option", { name: option, exact: true }).click();
}
import { ProviderInstanceId, ProviderDriverKind } from "@ryco/contracts";
function FixturePanel() {
  return (
    <SessionImportPanel
      nodeLabel="Fixture node"
      allowed={harness.allowed}
      projects={[{ id: "target", name: "Replacement project" }]}
      providerOptions={[
        {
          instanceId: ProviderInstanceId.make("codex"),
          driver: ProviderDriverKind.make("codex"),
          enabled: true,
          installed: true,
          displayName: "Fixture Codex",
          models: [
            {
              slug: "fixture-model",
              name: "Fixture model",
              isDefault: true,
              isCustom: false,
              capabilities: null,
            },
          ],
        },
        {
          instanceId: ProviderInstanceId.make("codex-other"),
          driver: ProviderDriverKind.make("codex"),
          enabled: true,
          installed: true,
          displayName: "Other Codex",
          models: [
            { slug: "other-model", name: "Other model", isCustom: false, capabilities: null },
          ],
        },
        {
          instanceId: ProviderInstanceId.make("claude"),
          driver: ProviderDriverKind.make("claudeAgent"),
          enabled: true,
          installed: true,
          displayName: "Claude fixture",
          models: [
            {
              slug: "claude-model",
              name: "Claude fixture model",
              isCustom: false,
              capabilities: null,
            },
          ],
        },
      ]}
      client={() => ({
        discover: harness.discover,
        run: harness.run,
        sources: harness.sources,
        reconcile: harness.reconcile,
        adopt: harness.adopt,
      })}
    />
  );
}
beforeEach(() => {
  vi.clearAllMocks();
  harness.allowed = true;
  harness.sources.mockImplementation(async ({ source }) => [
    {
      key: "c".repeat(64),
      label: "Default store",
      isDefault: true,
      instanceIds: source === "codex" ? ["codex", "codex-other"] : ["claude"],
    },
  ]);
});
describe("local history import", () => {
  it("selects history, maps a moved folder, reports failure and retries without repeating completed items", async () => {
    harness.discover.mockResolvedValue({
      items: [
        {
          key: "a".repeat(64),
          source: "codex",
          title: "First fixture",
          cwd: "C:\\missing\\project",
          archived: true,
          messageCount: 2,
          importedThreadId: null,
          quarantined: false,
        },
        {
          key: "b".repeat(64),
          source: "codex",
          title: "Second fixture",
          cwd: "/missing/project",
          archived: false,
          messageCount: 2,
          importedThreadId: null,
          quarantined: false,
        },
      ],
      notices: [],
      nextOffset: null,
    });
    harness.run
      .mockResolvedValueOnce({ threadId: "one", alreadyImported: false })
      .mockRejectedValueOnce(new Error("Fixture provider unavailable"))
      .mockResolvedValueOnce({ threadId: "two", alreadyImported: false });
    render(<FixturePanel />);
    await page.getByRole("button", { name: "Find conversations" }).click();
    await page.getByLabelText("Select First fixture").click();
    await page.getByLabelText("Select Second fixture").click();
    await chooseOption("Import target project", "Replacement project");
    await expect
      .element(page.getByLabelText("Continuation model"))
      .toMatchTextContent("Fixture model");
    await page.getByRole("button", { name: "Import selected" }).click();
    await expect.element(page.getByText("Fixture provider unavailable")).toBeVisible();
    await expect.element(page.getByLabelText("Select First fixture")).toBeDisabled();
    await page.getByRole("button", { name: "Import selected" }).click();
    await expect.poll(() => harness.run.mock.calls.length).toBe(3);
    expect(harness.run.mock.calls[2]![0]).toMatchObject({
      key: "b".repeat(64),
      projectId: "target",
      modelSelection: { instanceId: "codex", model: "fixture-model" },
    });
  });
  it("quarantines only uncertain items while keeping other histories selectable", async () => {
    harness.discover.mockResolvedValue({
      items: [
        {
          key: "a".repeat(64),
          source: "codex",
          title: "Uncertain fixture",
          cwd: "/old",
          archived: false,
          messageCount: 2,
          importedThreadId: null,
          quarantined: true,
        },
        {
          key: "b".repeat(64),
          source: "codex",
          title: "Available fixture",
          cwd: "/old",
          archived: false,
          messageCount: 2,
          importedThreadId: null,
          quarantined: false,
        },
      ],
      notices: ["An uncertain native fork is quarantined."],
      nextOffset: null,
    });
    render(<FixturePanel />);
    await page.getByRole("button", { name: "Find conversations" }).click();
    await expect.element(page.getByLabelText("Select Uncertain fixture")).toBeDisabled();
    await expect.element(page.getByLabelText("Select Available fixture")).toBeEnabled();
    await expect.element(page.getByText("An uncertain native fork is quarantined.")).toBeVisible();
  });
  it("normalizes models when source or provider changes", async () => {
    render(<FixturePanel />);
    await expect
      .element(page.getByLabelText("Continuation model"))
      .toMatchTextContent("Fixture model");
    await chooseOption("Import provider instance", "Other Codex");
    await expect
      .element(page.getByLabelText("Continuation model"))
      .toMatchTextContent("Other model");
    await chooseOption("Import source", "Claude Code");
    await expect
      .element(page.getByLabelText("Import provider instance"))
      .toMatchTextContent("Claude fixture");
    await expect
      .element(page.getByLabelText("Continuation model"))
      .toMatchTextContent("Claude fixture model");
    await chooseOption("Import source", "Codex");
    await expect
      .element(page.getByLabelText("Continuation model"))
      .toMatchTextContent("Fixture model");
  });
  it("keeps discovery disabled until hosted mutation readiness is current", async () => {
    harness.allowed = false;
    render(<FixturePanel />);
    await expect.element(page.getByRole("button", { name: "Find conversations" })).toBeDisabled();
    expect(harness.discover).not.toHaveBeenCalled();
  });
});

const uncertain = {
  key: "a".repeat(64),
  source: "codex",
  title: "Recovery fixture",
  cwd: "/old",
  archived: false,
  messageCount: 2,
  importedThreadId: null,
  quarantined: true,
};
const unique = {
  state: "unique",
  candidates: [{ id: "synthetic-copy", messageCount: 2 }],
  nextCursor: null,
  adoptionToken: "server-proof",
  notice: "One compatible copy is proven.",
};
it("inspects bounded pages and explicitly adopts only the server-proven copy", async () => {
  harness.discover.mockResolvedValue({ items: [uncertain], notices: [], nextOffset: null });
  harness.reconcile
    .mockResolvedValueOnce({
      state: "scanning",
      candidates: [],
      nextCursor: "scan-page",
      adoptionToken: null,
      notice: "Continue inspection.",
    })
    .mockResolvedValueOnce(unique);
  harness.adopt.mockResolvedValue({ threadId: "saved-copy", alreadyImported: false });
  render(<FixturePanel />);
  await page.getByRole("button", { name: "Find conversations" }).click();
  await page.getByRole("button", { name: "Inspect existing copies" }).click();
  await expect
    .element(page.getByRole("button", { name: "Adopt proven copy" }))
    .not.toBeInTheDocument();
  await page.getByRole("button", { name: "Inspect next page" }).click();
  expect(harness.reconcile.mock.calls[1]![0]).toMatchObject({
    cursor: "scan-page",
    key: uncertain.key,
  });
  await expect.element(page.getByText("Copy synthetic-copy · 2 messages")).toBeVisible();
  expect(harness.adopt).not.toHaveBeenCalled();
  await page.getByRole("button", { name: "Adopt proven copy" }).click();
  await expect.element(page.getByText("Already imported")).toBeVisible();
  expect(harness.adopt.mock.calls[0]![0]).toEqual({
    source: "codex",
    key: uncertain.key,
    adoptionToken: "server-proof",
  });
  expect(harness.run).not.toHaveBeenCalled();
});
it.each(["missing", "multiple", "mismatched", "unknown"])(
  "keeps %s evidence paused without an adopt or refork action",
  async (state) => {
    harness.discover.mockResolvedValue({ items: [uncertain], notices: [], nextOffset: null });
    harness.reconcile.mockResolvedValue({
      ...unique,
      state,
      adoptionToken: null,
      notice: "Import remains paused.",
    });
    render(<FixturePanel />);
    await page.getByRole("button", { name: "Find conversations" }).click();
    await page.getByRole("button", { name: "Inspect existing copies" }).click();
    await expect.element(page.getByText("Import remains paused.")).toBeVisible();
    await expect
      .element(page.getByRole("button", { name: "Adopt proven copy" }))
      .not.toBeInTheDocument();
    expect(harness.adopt).not.toHaveBeenCalled();
    expect(harness.run).not.toHaveBeenCalled();
  },
);
it("filters continuation instances by the explicitly chosen store and clears old discovery", async () => {
  harness.sources.mockResolvedValue([
    { key: "c".repeat(64), label: "Default store", isDefault: true, instanceIds: ["codex"] },
    { key: "d".repeat(64), label: "Custom store", isDefault: false, instanceIds: ["codex-other"] },
    { key: "e".repeat(64), label: "Disabled store", isDefault: false, instanceIds: [] },
  ]);
  harness.discover.mockResolvedValue({ items: [uncertain], notices: [], nextOffset: null });
  render(<FixturePanel />);
  await page.getByRole("button", { name: "Find conversations" }).click();
  await expect
    .element(page.getByLabelText("Import provider instance"))
    .toMatchTextContent("Fixture Codex");
  await chooseOption("Import source store", "Custom store");
  await expect.element(page.getByText("Recovery fixture")).not.toBeInTheDocument();
  await expect
    .element(page.getByLabelText("Import provider instance"))
    .toMatchTextContent("Other Codex");
  await page.getByRole("button", { name: "Find conversations" }).click();
  expect(harness.discover.mock.calls[1]![0].storeKey).toBe("d".repeat(64));
  await chooseOption("Import source store", "Disabled store (no enabled continuation instance)");
  await expect.element(page.getByRole("button", { name: "Import selected" })).toBeDisabled();
});

it("invalidates a late inspection when owner readiness is lost", async () => {
  harness.discover.mockResolvedValue({ items: [uncertain], notices: [], nextOffset: null });
  let resolve!: (value: typeof unique) => void;
  harness.reconcile.mockReturnValue(
    new Promise((done) => {
      resolve = done;
    }),
  );
  const view = await render(<FixturePanel />);
  await page.getByRole("button", { name: "Find conversations" }).click();
  await page.getByRole("button", { name: "Inspect existing copies" }).click();
  harness.allowed = false;
  await view.rerender(<FixturePanel />);
  resolve(unique);
  await expect.element(page.getByRole("button", { name: "Find conversations" })).toBeDisabled();
  await expect
    .element(page.getByRole("button", { name: "Adopt proven copy" }))
    .not.toBeInTheDocument();
  expect(harness.adopt).not.toHaveBeenCalled();
  harness.allowed = true;
  await view.rerender(<FixturePanel />);
  await expect.element(page.getByRole("button", { name: "Find conversations" })).toBeEnabled();
  await expect
    .element(page.getByRole("button", { name: "Adopt proven copy" }))
    .not.toBeInTheDocument();
});
