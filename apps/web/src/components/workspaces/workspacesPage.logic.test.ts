import { ProjectId, ThreadId, WorktreeId } from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import { excludePinnedSuggestions } from "./workspacesPage.logic";

describe("workspace page suggestions", () => {
  it("never suggests pinned threads or checkouts that hold a pinned thread", () => {
    const suggestions = {
      generatedAt: "2026-10-01T00:00:00.000Z",
      threads: [
        {
          threadId: ThreadId.make("pinned"),
          projectId: ProjectId.make("p"),
          title: "Pinned",
          lastActivityAt: "2026-08-01T00:00:00.000Z",
        },
        {
          threadId: ThreadId.make("idle"),
          projectId: ProjectId.make("p"),
          title: "Idle",
          lastActivityAt: "2026-08-01T00:00:00.000Z",
        },
      ],
      checkouts: [
        {
          worktreeId: WorktreeId.make("holds-pinned"),
          projectId: ProjectId.make("p"),
          title: "Feature",
          branch: "feature",
          archivedSince: "2026-09-01T00:00:00.000Z",
          conversations: 1,
        },
      ],
    };
    const filtered = excludePinnedSuggestions(
      suggestions,
      (threadId) => threadId === "pinned",
      new Set(["holds-pinned"]),
    );
    expect(filtered.threads.map((thread) => thread.threadId)).toEqual(["idle"]);
    expect(filtered.checkouts).toEqual([]);
  });
});
