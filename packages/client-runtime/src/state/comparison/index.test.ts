import { describe, expect, it, vi } from "vite-plus/test";
import type { GitReadComparisonResult } from "@ryco/contracts";
import { comparisonFileKey, comparisonStorageKey, createComparisonController } from "./index.ts";

const result = (ref: string, oid = ref): GitReadComparisonResult => ({
  selection: { ref, mode: "direct" },
  source: {
    repositoryPath: "/repo/.git",
    worktreePath: "/repo",
    refOid: oid,
    baseOid: oid,
    headOid: "head",
    revision: oid,
  },
  patch: ref,
});
function setup(read = vi.fn(async (selection: { ref: string }) => result(selection.ref))) {
  const values = new Map<string, string>();
  const storage = {
    getItem: async (key: string) => values.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: async (key: string) => {
      values.delete(key);
    },
  };
  const controller = createComparisonController({ storage, storageKey: "repo", read });
  return { controller, read, values, storage };
}
describe("comparison state", () => {
  it("persists scope and isolates environments/repositories", async () => {
    const f = setup();
    f.controller.setSelection({ ref: "main", mode: "direct" });
    await f.controller.refresh();
    const next = createComparisonController({
      storage: f.storage,
      storageKey: "repo",
      read: f.read,
    });
    await next.hydrate();
    await next.refresh();
    expect(next.getSnapshot().selection?.ref).toBe("main");
    expect(comparisonStorageKey("a", "/repo")).not.toBe(comparisonStorageKey("b", "/repo"));
    expect(comparisonStorageKey("a", "/repo")).not.toBe(comparisonStorageKey("a", "/other"));
    f.controller.setSelection(null);
    await Promise.resolve();
    await Promise.resolve();
    expect(f.values.get("repo")).toBe("null");
  });
  it("deduplicates overlapping refreshes and discards old selections and transport generations", async () => {
    const pending: ((value: GitReadComparisonResult) => void)[] = [];
    const f = setup(
      vi.fn(() => new Promise<GitReadComparisonResult>((resolve) => pending.push(resolve))),
    );
    f.controller.setSelection({ ref: "old", mode: "direct" });
    const old = f.controller.refresh();
    expect(f.controller.refresh()).toBe(old);
    await Promise.resolve();
    f.controller.setSelection({ ref: "new", mode: "direct" });
    const fresh = f.controller.refresh();
    await Promise.resolve();
    pending[1]!(result("new"));
    await fresh;
    pending[0]!(result("old"));
    await old;
    expect(f.controller.getSnapshot().data?.patch).toBe("new");
    const obsolete = f.controller.refresh();
    await Promise.resolve();
    f.controller.invalidate();
    pending[2]!(result("new", "old-generation"));
    await obsolete;
    expect(f.controller.getSnapshot().data).toBeNull();
  });
  it("shows moved refs, clears unavailable data, and never falls back to another ref", async () => {
    const f = setup();
    f.controller.setSelection({ ref: "main", mode: "direct" });
    await f.controller.refresh();
    f.read.mockResolvedValueOnce(result("main", "moved"));
    await f.controller.refresh();
    expect(f.controller.getSnapshot().refMoved).toBe(true);
    f.read.mockRejectedValueOnce(new Error("Reference unavailable"));
    await f.controller.refresh();
    expect(f.controller.getSnapshot()).toMatchObject({
      data: null,
      error: "Reference unavailable",
      selection: { ref: "main" },
    });
  });
  it("ignores malformed saved state and isolates revision/file cache keys", async () => {
    const f = setup();
    f.values.set("repo", '{"ref":"--x","mode":"direct"}');
    await f.controller.hydrate();
    expect(f.read).not.toHaveBeenCalled();
    const source = result("main").source;
    const key = comparisonFileKey("a", source, "base", "file.ts");
    expect(key).not.toBe(comparisonFileKey("b", source, "base", "file.ts"));
    expect(key).not.toBe(comparisonFileKey("a", source, "head", "file.ts"));
    expect(key).not.toBe(
      comparisonFileKey("a", { ...source, revision: "changed" }, "base", "file.ts"),
    );
  });
});
