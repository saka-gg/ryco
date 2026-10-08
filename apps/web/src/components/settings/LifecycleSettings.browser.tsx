import "../../index.css";

import {
  type EnvironmentApi,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationShellSnapshot,
  type TrashedThreadSummary,
} from "@ryco/contracts";
import { page } from "vite-plus/test/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

import {
  __resetEnvironmentApiOverridesForTests,
  __setEnvironmentApiOverrideForTests,
} from "../../environmentApi";
import { useStore } from "../../store";
import { TrashSection } from "./LifecycleSettings";

const ENVIRONMENT_ID = EnvironmentId.make("environment-local");
const CHAT_PROJECT_ID = ProjectId.make("chat-project");
const PROJECT_ID = ProjectId.make("project-1");
const CHAT_FOLDER = "/home/me/.ryco/chats/2026-10-08-plan-a-trip-1a2b3c4d";
const NOW = "2026-10-08T10:00:00.000Z";

const harness = vi.hoisted(() => ({
  trash: [] as TrashedThreadSummary[],
  deleteThreadPermanently: vi.fn(async () => undefined),
  deleteChatFolder: vi.fn(async () => ({ deleted: true })),
}));

vi.mock("../../hooks/useThreadActions", () => ({
  useThreadActions: () => ({
    untrashThread: vi.fn(async () => undefined),
    deleteThreadPermanently: harness.deleteThreadPermanently,
  }),
}));

function trashed(
  projectId: ProjectId,
  title: string,
  projectTitle: string = title,
): TrashedThreadSummary {
  return {
    threadId: ThreadId.make(`thread-${projectId}`),
    projectId,
    projectTitle,
    projectAvailable: true,
    title,
    branch: null,
    worktreePath: null,
    worktreeId: null,
    archivedAt: null,
    trashedAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function seedProjects(): void {
  const project = {
    defaultModelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
    scripts: [],
    createdAt: NOW,
    updatedAt: NOW,
  };
  const snapshot: OrchestrationShellSnapshot = {
    snapshotSequence: 1,
    projects: [
      { ...project, id: PROJECT_ID, title: "Project", workspaceRoot: "/repo/project" },
      {
        ...project,
        id: CHAT_PROJECT_ID,
        title: "Plan a trip",
        workspaceRoot: CHAT_FOLDER,
        kind: "chat",
      },
    ],
    threads: [],
    updatedAt: NOW,
  };
  useStore.getState().syncServerShellSnapshot(snapshot, ENVIRONMENT_ID);
}

describe("TrashSection permanent delete", () => {
  let mounted: Awaited<ReturnType<typeof render>> | null = null;

  beforeEach(() => {
    useStore.setState({ activeEnvironmentId: null, environmentStateById: {} });
    seedProjects();
    harness.deleteThreadPermanently.mockClear();
    harness.deleteChatFolder.mockClear();
    __setEnvironmentApiOverrideForTests(ENVIRONMENT_ID, {
      lifecycle: { listTrash: async () => ({ threads: harness.trash, truncated: false }) },
      projects: { deleteChatFolder: harness.deleteChatFolder },
    } as unknown as EnvironmentApi);
  });

  afterEach(async () => {
    await mounted?.unmount();
    mounted = null;
    __resetEnvironmentApiOverridesForTests();
    document.body.innerHTML = "";
  });

  async function openDeleteDialog(): Promise<void> {
    mounted = await render(
      <TrashSection environmentId={ENVIRONMENT_ID} mutationAllowed mutationReason={null} />,
    );
    await page.getByRole("button", { name: "Delete permanently" }).click();
  }

  it("keeps the chat folder unless the user opts in", async () => {
    harness.trash = [trashed(CHAT_PROJECT_ID, "Plan a trip")];
    await openDeleteDialog();
    const folderOption = page.getByTestId("trash-delete-chat-folder");
    await expect.element(folderOption).toHaveTextContent(CHAT_FOLDER);
    await expect.element(page.getByRole("checkbox")).not.toBeChecked();
    await page.getByTestId("trash-delete-permanently").click();
    await expect.poll(() => harness.deleteThreadPermanently.mock.calls.length).toBe(1);
    expect(harness.deleteChatFolder).not.toHaveBeenCalled();
  });

  it("deletes the chat folder after the conversation when asked", async () => {
    harness.trash = [trashed(CHAT_PROJECT_ID, "Plan a trip")];
    await openDeleteDialog();
    await page.getByRole("checkbox").click();
    await page.getByTestId("trash-delete-permanently").click();
    await expect
      .poll(() => harness.deleteChatFolder.mock.calls.at(-1))
      .toEqual([{ projectId: CHAT_PROJECT_ID }]);
    expect(harness.deleteThreadPermanently).toHaveBeenCalledTimes(1);
  });

  it("lists a trashed chat under No project, never under its folder's title", async () => {
    // The server names a chat's project after the chat itself.
    harness.trash = [
      trashed(CHAT_PROJECT_ID, "Plan a trip"),
      trashed(PROJECT_ID, "Fix the build", "Project"),
    ];
    mounted = await render(
      <TrashSection environmentId={ENVIRONMENT_ID} mutationAllowed mutationReason={null} />,
    );
    await expect
      .element(page.getByTestId(`trash-row-place-thread-${CHAT_PROJECT_ID}`))
      .toHaveTextContent(/^No project · Moved to Trash/);
    await expect
      .element(page.getByTestId(`trash-row-place-thread-${PROJECT_ID}`))
      .toHaveTextContent(/^Project · Moved to Trash/);
  });

  it("lists a chat as No project from the node's project kind alone", async () => {
    // The chat's project is no longer in this client's store; the node still says it was a chat.
    const goneChatId = ProjectId.make("gone-chat-project");
    harness.trash = [
      {
        ...trashed(goneChatId, "Old chat", "old-chat"),
        projectKind: "chat",
        projectAvailable: false,
      },
    ];
    mounted = await render(
      <TrashSection environmentId={ENVIRONMENT_ID} mutationAllowed mutationReason={null} />,
    );
    await expect
      .element(page.getByTestId(`trash-row-place-thread-${goneChatId}`))
      .toHaveTextContent(/^No project · Moved to Trash/);
  });

  it("offers no folder option for a chat whose folder this client does not know", async () => {
    harness.trash = [
      {
        ...trashed(ProjectId.make("gone-chat-project"), "Old chat", "old-chat"),
        projectKind: "chat",
        projectAvailable: false,
      },
    ];
    await openDeleteDialog();
    await expect.element(page.getByTestId("trash-delete-permanently")).toBeVisible();
    expect(document.querySelector('[data-testid="trash-delete-chat-folder"]')).toBeNull();
  });

  it("offers no folder option for a regular project's conversation", async () => {
    harness.trash = [trashed(PROJECT_ID, "Fix the build")];
    await openDeleteDialog();
    await expect.element(page.getByTestId("trash-delete-permanently")).toBeVisible();
    expect(document.querySelector('[data-testid="trash-delete-chat-folder"]')).toBeNull();
  });
});
