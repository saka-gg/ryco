import "../index.css";
import { useSyncExternalStore } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";
import { createComparisonController } from "@ryco/client-runtime/state/comparison";
import type { GitReadComparisonResult } from "@ryco/contracts";
import { DiffComparisonControls } from "./DiffComparisonControls";

const result = (
  ref: string,
  mode: "mergeBase" | "direct",
  oid: string,
): GitReadComparisonResult => ({
  selection: { ref, mode },
  source: {
    repositoryPath: "/repo/.git",
    worktreePath: "/repo",
    baseOid: oid,
    refOid: oid,
    headOid: "1234567890",
    revision: oid,
  },
  patch: "",
});

function harness() {
  const values = new Map<string, string>();
  const read = vi.fn(async (selection: { ref: string; mode: "mergeBase" | "direct" }) =>
    result(selection.ref, selection.mode, "abcdefghij"),
  );
  const controller = createComparisonController({
    storage: {
      getItem: async (key) => values.get(key) ?? null,
      setItem: async (key, value) => {
        values.set(key, value);
      },
      removeItem: async (key) => {
        values.delete(key);
      },
    },
    storageKey: "comparison",
    read,
  });
  function View() {
    const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
    return (
      <div style={{ width: 650, maxWidth: "100%" }}>
        <DiffComparisonControls
          {...state}
          onSelect={controller.setSelection}
          onRefresh={() => {
            void controller.refresh();
          }}
        />
      </div>
    );
  }
  return { controller, read, View };
}
describe("comparison controls", () => {
  it("selects branch/commit semantics, reports moved/deleted refs and returns to turn review", async () => {
    await page.viewport(900, 500);
    const f = harness();
    const screen = await render(<f.View />);
    await screen.getByRole("textbox", { name: "Branch, tag, or commit" }).fill("main");
    await screen.getByRole("button", { name: "Compare", exact: true }).click();
    await expect.element(screen.getByText(/Merge-base of/)).toBeVisible();
    await expect
      .element(screen.getByText(/Staged, unstaged, and untracked changes are excluded/))
      .toBeVisible();
    await expect.poll(() => f.read.mock.calls[0]?.[0]).toEqual({ ref: "main", mode: "mergeBase" });
    await page.screenshot({ path: "../../output/task05-comparison.png" });
    f.read.mockResolvedValueOnce(result("main", "mergeBase", "moved12345"));
    await screen.getByRole("button", { name: "Refresh comparison" }).click();
    await expect.element(screen.getByText(/selected reference moved/)).toBeVisible();
    f.read.mockRejectedValueOnce(new Error("Reference main is unavailable"));
    await screen.getByRole("button", { name: "Refresh comparison" }).click();
    await expect
      .element(screen.getByRole("alert"))
      .toHaveTextContent("Reference main is unavailable");
    expect(f.controller.getSnapshot().data).toBeNull();
    await screen.getByRole("combobox", { name: "Comparison mode" }).selectOptions("direct");
    await screen.getByRole("textbox", { name: "Branch, tag, or commit" }).fill("abc1234");
    await screen.getByRole("button", { name: "Compare", exact: true }).click();
    await expect.poll(() => f.controller.getSnapshot().data?.selection.mode).toBe("direct");
    await screen.getByRole("button", { name: "Turn review" }).click();
    await expect
      .element(screen.getByRole("button", { name: "Turn review" }))
      .toHaveAttribute("aria-pressed", "true");
    f.controller.dispose();
    await screen.unmount();
  });
  it("keeps invalid input actionable without running Git", async () => {
    await page.viewport(900, 500);
    const f = harness();
    const screen = await render(<f.View />);
    await screen.getByRole("textbox", { name: "Branch, tag, or commit" }).fill("--output=bad");
    await screen.getByRole("button", { name: "Compare", exact: true }).click();
    await expect.element(screen.getByRole("alert")).toBeVisible();
    expect(f.read).not.toHaveBeenCalled();
    f.controller.dispose();
    await screen.unmount();
  });
});
