import { describe, expect, it } from "vite-plus/test";
import { createEmptyReadModel } from "./projector.ts";
import { createWorkspaceCommitFence } from "./workspaceCommitFence.ts";

const identity = { threadId: "synthetic-thread", cwd: "/synthetic/a", worktreePath: null };
const fixture = () => {
  let model = {
    ...createEmptyReadModel("2026-09-01T00:00:00.000Z"),
    threads: [
      {
        id: identity.threadId,
        projectId: "synthetic-project",
        worktreePath: null,
        deletedAt: null,
      },
    ],
    projects: [{ id: "synthetic-project", workspaceRoot: identity.cwd, deletedAt: null }],
  } as unknown as ReturnType<typeof createEmptyReadModel>;
  return {
    fence: createWorkspaceCommitFence(() => model),
    change: (cwd: string) => {
      model = { ...model, projects: [{ ...model.projects[0]!, workspaceRoot: cwd }] };
    },
  };
};

describe("workspace input commit fence", () => {
  it("invalidates queued input before asynchronous workspace persistence and across an A-B-A transition", () => {
    const { fence, change } = fixture();
    const captured = fence.capture(identity)!;
    expect(captured()).toBe(true);
    fence.begin([{ type: "project.meta-updated" }]);
    expect(captured()).toBe(false);
    expect(fence.capture(identity)).toBeUndefined();
    change("/synthetic/b");
    fence.publish();
    expect(fence.capture(identity)).toBeUndefined();
    fence.begin([{ type: "project.meta-updated" }]);
    change(identity.cwd);
    fence.publish();
    expect(captured()).toBe(false);
    expect(fence.capture(identity)!()).toBe(true);
  });
  it("keeps unrelated message events available and rejects absent threads and mismatched worktrees", () => {
    const { fence } = fixture();
    const captured = fence.capture(identity)!;
    fence.begin([{ type: "thread.message-sent" }]);
    expect(captured()).toBe(true);
    expect(fence.capture({ ...identity, threadId: "other-thread" })).toBeUndefined();
    expect(fence.capture({ ...identity, worktreePath: identity.cwd })).toBeUndefined();
  });
});
