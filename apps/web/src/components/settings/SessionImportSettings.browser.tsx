import "../../index.css";
import { page } from "vite-plus/test/browser";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";
const harness = vi.hoisted(() => ({ discover: vi.fn(), run: vi.fn(), allowed: true }));
import { SessionImportPanel } from "./SessionImportPanel";
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
      client={() => ({ discover: harness.discover, run: harness.run })}
    />
  );
}
beforeEach(() => {
  vi.clearAllMocks();
  harness.allowed = true;
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
    await page.getByLabelText("Import target project").selectOptions("target");
    await expect.element(page.getByLabelText("Continuation model")).toHaveValue("fixture-model");
    await page.getByRole("button", { name: "Import selected / retry failed" }).click();
    await expect.element(page.getByText("Fixture provider unavailable")).toBeVisible();
    await expect.element(page.getByLabelText("Select First fixture")).toBeDisabled();
    await page.getByRole("button", { name: "Import selected / retry failed" }).click();
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
    await expect.element(page.getByLabelText("Continuation model")).toHaveValue("fixture-model");
    await page.getByLabelText("Import provider instance").selectOptions("codex-other");
    await expect.element(page.getByLabelText("Continuation model")).toHaveValue("other-model");
    await page.getByLabelText("Import source").selectOptions("claudeAgent");
    await expect.element(page.getByLabelText("Import provider instance")).toHaveValue("claude");
    await expect.element(page.getByLabelText("Continuation model")).toHaveValue("claude-model");
    await page.getByLabelText("Import source").selectOptions("codex");
    await expect.element(page.getByLabelText("Continuation model")).toHaveValue("fixture-model");
  });
  it("keeps discovery disabled until hosted mutation readiness is current", async () => {
    harness.allowed = false;
    render(<FixturePanel />);
    await expect.element(page.getByRole("button", { name: "Find conversations" })).toBeDisabled();
    expect(harness.discover).not.toHaveBeenCalled();
  });
});
