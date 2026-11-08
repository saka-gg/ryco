import { WorktreeId, type WorkspaceLifecyclePreview } from "@ryco/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { runDirectWorkspaceAction } from "./workspaceActions.ts";

const worktreeId = WorktreeId.make("wt-1");
const preview = (blockers: string[]) =>
  ({
    request: { worktreeId, action: "archive", discard: false },
    blockers,
    fingerprint: "fp-1",
  }) as unknown as WorkspaceLifecyclePreview;

describe("runDirectWorkspaceAction", () => {
  it("applies exactly the preview the node made", async () => {
    const result = { outcome: "completed" as const, message: "Archived.", steps: [] };
    const lifecycle = {
      previewWorkspace: vi.fn(async () => preview([])),
      applyWorkspace: vi.fn(async () => result),
    };
    await expect(
      runDirectWorkspaceAction(lifecycle, { worktreeId, action: "archive" }),
    ).resolves.toEqual({ kind: "applied", result });
    expect(lifecycle.previewWorkspace).toHaveBeenCalledWith({ worktreeId, action: "archive" });
    expect(lifecycle.applyWorkspace).toHaveBeenCalledWith({
      worktreeId,
      action: "archive",
      discard: false,
      expectedFingerprint: "fp-1",
    });
  });

  it("changes nothing when the node names a blocker", async () => {
    const lifecycle = {
      previewWorkspace: vi.fn(async () => preview(["A turn is running."])),
      applyWorkspace: vi.fn(),
    };
    await expect(
      runDirectWorkspaceAction(lifecycle, { worktreeId, action: "restore" }),
    ).resolves.toEqual({ kind: "blocked", blockers: ["A turn is running."] });
    expect(lifecycle.applyWorkspace).not.toHaveBeenCalled();
  });
});
