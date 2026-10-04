import "../../index.css";

import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationShellSnapshot,
  type OrchestrationThreadShell,
  type ThreadLineage,
} from "@ryco/contracts";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";

import { syncServerShellSnapshot, useStore } from "../../store";
import { DelegatedThreadsSection } from "./DelegatedThreadsSection";

const ENVIRONMENT_ID = EnvironmentId.make("delegated-section-env");
const PROJECT_ID = ProjectId.make("delegated-section-project");
const PARENT = ThreadId.make("coordinator");

const delegatedFrom = (parent: ThreadId, root: ThreadId = parent): ThreadLineage => ({
  parentThreadId: parent,
  rootThreadId: root,
  relationship: "delegated",
});

function shell(
  id: string,
  title: string,
  overrides: Partial<OrchestrationThreadShell> = {},
): OrchestrationThreadShell {
  return {
    id: ThreadId.make(id),
    projectId: PROJECT_ID,
    title,
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    goal: null,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...overrides,
  };
}

function seed(threads: ReadonlyArray<OrchestrationThreadShell>) {
  const snapshot: OrchestrationShellSnapshot = {
    snapshotSequence: 1,
    projects: [
      {
        id: PROJECT_ID,
        title: "Project",
        workspaceRoot: "/repo",
        projectMetadataDir: ".ryco",
        defaultModelSelection: null,
        customAvatarContentHash: null,
        preferredRemoteName: null,
        scripts: [],
        createdAt: "2026-10-01T00:00:00.000Z",
        updatedAt: "2026-10-01T00:00:00.000Z",
      },
    ],
    threads,
    updatedAt: "2026-10-01T00:00:00.000Z",
  };
  useStore.setState(
    syncServerShellSnapshot(
      { activeEnvironmentId: ENVIRONMENT_ID, environmentStateById: {} },
      snapshot,
      ENVIRONMENT_ID,
    ),
  );
}

describe("DelegatedThreadsSection", () => {
  afterEach(() => {
    useStore.setState({ activeEnvironmentId: null, environmentStateById: {} });
    document.body.innerHTML = "";
  });

  it("renders nothing for a thread without delegated children", async () => {
    seed([shell("coordinator", "Coordinator"), shell("other", "Unrelated")]);
    const mounted = await render(
      <DelegatedThreadsSection environmentId={ENVIRONMENT_ID} parentThreadId={PARENT} />,
    );
    try {
      expect(document.querySelector('[data-testid="delegated-threads"]')).toBeNull();
    } finally {
      await mounted.unmount();
    }
  });

  it("lists direct children in creation order behind a collapsed count", async () => {
    seed([
      shell("coordinator", "Coordinator"),
      shell("later-worker", "Later worker", {
        createdAt: "2026-10-01T00:00:05.000Z",
        lineage: delegatedFrom(PARENT),
      }),
      shell("first-worker", "First worker", {
        createdAt: "2026-10-01T00:00:01.000Z",
        lineage: delegatedFrom(PARENT),
      }),
      shell("grandchild", "Grandchild worker", {
        lineage: delegatedFrom(ThreadId.make("first-worker"), PARENT),
      }),
    ]);
    const mounted = await render(
      <DelegatedThreadsSection environmentId={ENVIRONMENT_ID} parentThreadId={PARENT} />,
    );
    try {
      const toggle = page.getByRole("button", { name: "Delegated threads · 2" });
      await expect.element(toggle).toHaveAttribute("aria-expanded", "false");
      expect(document.querySelector('[data-testid="delegated-threads-list"]')).toBeNull();

      await toggle.click();
      await expect.element(toggle).toHaveAttribute("aria-expanded", "true");
      const titles = [
        ...document.querySelectorAll('[data-testid="delegated-threads-list"] button'),
      ].map((row) => row.querySelector(".truncate")?.textContent);
      // Direct children only (spec D8): the grandchild belongs to its own parent's view.
      expect(titles).toEqual(["First worker", "Later worker"]);
    } finally {
      await mounted.unmount();
    }
  });
});
