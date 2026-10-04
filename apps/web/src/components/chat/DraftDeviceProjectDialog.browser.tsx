import "../../index.css";

import { EnvironmentId, ProjectId } from "@ryco/contracts";
import { DraftId } from "@ryco/client-runtime/state/composer";
import type { NodeMutationLease } from "@ryco/client-runtime/authorization";
import { useSyncExternalStore } from "react";
import { page } from "vite-plus/test/browser";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

import { createHostedDraftTargetController } from "../../hostedHub/draftExecutionTarget";
import { selectProjectsForEnvironment, useStore } from "../../store";
import { workspaceMetadataToCachedShellSnapshot } from "../../workspaceMetadataProjection";
import { DraftDeviceProjectDialog } from "./DraftDeviceProjectDialog";

let mounted: Awaited<ReturnType<typeof render>> | null = null;
afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
  useStore.setState({ activeEnvironmentId: null, environmentStateById: {} });
});

it("lets a user choose a cached device project while the live connection is pending", async () => {
  const source = EnvironmentId.make("source");
  const target = EnvironmentId.make("target");
  const projectId = ProjectId.make("project-target");
  useStore.getState().hydrateEnvironmentStateFromCache(
    workspaceMetadataToCachedShellSnapshot({
      schemaVersion: 1,
      environmentId: target,
      capturedAt: 1,
      projects: [
        {
          environmentId: target,
          id: projectId,
          name: "Target repository",
          cwd: "/repo",
          repositoryIdentity: null,
          createdAt: null,
          updatedAt: null,
        },
      ],
      worktrees: [],
      threads: [],
    }),
    target,
  );
  let currentLease: NodeMutationLease | null = null;
  let resolveLease!: (lease: NodeMutationLease | null) => void;
  const move = vi.fn();
  const controller = createHostedDraftTargetController({
    sourceIsCurrent: () => true,
    targetIsEligible: () => true,
    routeMatches: () => true,
    subscribeRoute: () => () => undefined,
    retain: () => () => undefined,
    adopt: () => true,
    waitForLease: () =>
      new Promise((resolve) => {
        resolveLease = resolve;
      }),
    readLease: () => currentLease,
    readProjects: (environmentId) =>
      selectProjectsForEnvironment(useStore.getState(), environmentId),
    canPreviewProjects: () => true,
    move,
    retry: () => undefined,
  });
  controller.begin({
    draftId: DraftId.make("draft-a"),
    project: {
      environmentId: source,
      id: ProjectId.make("source-project"),
      name: "Source",
      cwd: "/source",
      defaultModelSelection: null,
      scripts: [],
    },
    environmentId: target,
    label: "Second Mac",
    logicalKey: (project) => project.name,
  });
  function PendingPicker() {
    const selection = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
    return selection ? (
      <DraftDeviceProjectDialog
        {...selection}
        onCancel={controller.cancel}
        onSelect={controller.selectProject}
        onRetry={controller.retry}
      />
    ) : null;
  }
  mounted = await render(<PendingPicker />);

  await expect.element(page.getByRole("dialog")).toBeVisible();
  await expect
    .element(page.getByRole("heading", { name: "Choose a project on Second Mac" }))
    .toBeVisible();
  await page.getByRole("button", { name: "Target repository /repo" }).click();
  expect(move).not.toHaveBeenCalled();
  await expect
    .element(page.getByRole("heading", { name: "Connecting to Second Mac…" }))
    .toBeVisible();

  currentLease = {
    environmentId: target,
    selectionGeneration: 1,
    snapshotGeneration: 1,
    effectiveRole: "owner",
    directoryReady: true,
    relayReady: true,
    shellReady: true,
  };
  resolveLease(currentLease);
  await expect.poll(() => move.mock.calls.length).toBe(1);
  await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
});
