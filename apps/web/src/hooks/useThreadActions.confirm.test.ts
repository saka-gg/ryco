import { EnvironmentId, ProjectId, ThreadId } from "@ryco/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  confirmAction: vi.fn(),
  confirmChatDelete: vi.fn(),
  environment: {
    threadIds: [] as string[],
    threadShellById: {} as Record<string, { readonly projectId: string }>,
  },
  projects: {} as Record<string, { readonly kind?: "chat"; readonly cwd: string }>,
}));
vi.mock("../confirmAction", () => ({ confirmAction: mocks.confirmAction }));
vi.mock("../components/ChatDeleteDialog", () => ({ confirmChatDelete: mocks.confirmChatDelete }));
vi.mock("../store", () => ({
  useStore: { getState: () => ({}) },
  selectEnvironmentState: () => mocks.environment,
  selectProjectByRef: (_state: unknown, ref: { readonly projectId: string }) =>
    mocks.projects[ref.projectId],
  selectSidebarThreadSummaryByRef: () => undefined,
  selectThreadByRef: () => undefined,
  selectThreadExistsByRef: () => false,
  selectThreadsForEnvironment: () => [],
}));

import { confirmThreadDeletion } from "./useThreadActions";

const environmentId = EnvironmentId.make("env");
const ref = { environmentId, threadId: ThreadId.make("thread-1") };

function seed(input: {
  readonly kind: "chat" | "project";
  readonly threads: ReadonlyArray<readonly [string, string]>;
}) {
  mocks.environment.threadIds = input.threads.map(([threadId]) => threadId);
  mocks.environment.threadShellById = Object.fromEntries(
    input.threads.map(([threadId, projectId]) => [threadId, { projectId }]),
  );
  mocks.projects = {
    "project-1": input.kind === "chat" ? { kind: "chat", cwd: "/chats/c1" } : { cwd: "/code/p1" },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.confirmAction.mockResolvedValue(true);
});

describe("confirmThreadDeletion", () => {
  it("offers the chat folder when the chat's last conversation is deleted", async () => {
    seed({ kind: "chat", threads: [["thread-1", "project-1"]] });
    const onDeleted = () => undefined;
    mocks.confirmChatDelete.mockResolvedValue({ onDeleted });

    await expect(confirmThreadDeletion(ref, "Trip")).resolves.toEqual({ onDeleted });
    expect(mocks.confirmAction).not.toHaveBeenCalled();
    expect(mocks.confirmChatDelete).toHaveBeenCalledExactlyOnceWith({
      message: expect.stringContaining('"Trip"'),
      threadId: ref.threadId,
      folder: {
        environmentId,
        projectId: ProjectId.make("project-1"),
        folderPath: "/chats/c1",
      },
    });
  });

  it("passes a declined chat dialog on", async () => {
    seed({ kind: "chat", threads: [["thread-1", "project-1"]] });
    mocks.confirmChatDelete.mockResolvedValue(null);
    await expect(confirmThreadDeletion(ref, "Trip")).resolves.toBeNull();
  });

  it("keeps the plain confirmation while another conversation still uses the folder", async () => {
    seed({
      kind: "chat",
      threads: [
        ["thread-1", "project-1"],
        ["thread-2", "project-1"],
      ],
    });
    await expect(confirmThreadDeletion(ref, "Trip")).resolves.toEqual({});
    expect(mocks.confirmChatDelete).not.toHaveBeenCalled();
  });

  it("never offers a regular project's folder", async () => {
    seed({ kind: "project", threads: [["thread-1", "project-1"]] });
    mocks.confirmAction.mockResolvedValue(false);
    await expect(confirmThreadDeletion(ref, "Trip")).resolves.toBeNull();
    expect(mocks.confirmChatDelete).not.toHaveBeenCalled();
  });
});
