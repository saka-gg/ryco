import "../index.css";
import type { NodeMutationLease } from "@ryco/client-runtime/authorization";
import { scopeProjectRef } from "@ryco/client-runtime/scoped";
import type { Project } from "@ryco/client-runtime/state/threads";
import { EnvironmentId, ProjectId, ProviderInstanceId } from "@ryco/contracts";
import { useSyncExternalStore } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";
import { DraftDeviceProjectDialog } from "../components/chat/DraftDeviceProjectDialog";
import { DraftId, useComposerDraftStore } from "../composerDraftStore";
import { createHostedDraftTargetController } from "../hostedHub/draftExecutionTarget";
import { useStore } from "../store";

vi.mock("../components/ProjectFavicon", () => ({ ProjectFavicon: () => null }));

const source = EnvironmentId.make("source");
const target = EnvironmentId.make("target");
const draftId = DraftId.make("draft-switch");
const sourceProject: Project = {
  id: ProjectId.make("source-project"),
  environmentId: source,
  name: "Source repository",
  cwd: "/source/repo",
  defaultModelSelection: null,
  scripts: [],
};
const targetProject: Project = {
  ...sourceProject,
  id: ProjectId.make("target-project"),
  environmentId: target,
  name: "Target repository",
  cwd: "/target/repo",
};
const ready: NodeMutationLease = {
  environmentId: target,
  selectionGeneration: 1,
  snapshotGeneration: 1,
  effectiveRole: "owner",
  directoryReady: true,
  relayReady: true,
  shellReady: true,
};
let mounted: Awaited<ReturnType<typeof render>> | null = null;

beforeEach(() => {
  localStorage.clear();
  useStore.setState({ activeEnvironmentId: null, environmentStateById: {} });
  useComposerDraftStore.setState({
    draftsByThreadKey: {},
    draftThreadsByThreadKey: {},
    logicalProjectDraftThreadKeyByLogicalProjectKey: {},
    stickyModelSelectionByProvider: {},
    stickyActiveProvider: null,
  });
  for (const project of [sourceProject, targetProject])
    useStore
      .getState()
      .hydrateEnvironmentStateFromCache(
        { capturedAt: 1, projects: [project], worktrees: [], threads: [] },
        project.environmentId,
      );
  const drafts = useComposerDraftStore.getState();
  drafts.setLogicalProjectDraftThreadId(
    sourceProject.name,
    scopeProjectRef(source, sourceProject.id),
    draftId,
    {
      branch: "source-branch",
      worktreePath: "/source/worktree",
      envMode: "worktree",
      runtimeMode: "full-access",
      tokenMode: "balanced",
    },
  );
  drafts.setPrompt(draftId, "Keep this unsent prompt while switching devices.");
  drafts.setModelSelection(draftId, {
    instanceId: ProviderInstanceId.make("codex"),
    model: "chosen-model",
  });
  drafts.addImage(draftId, {
    type: "image",
    id: "attachment",
    name: "image.png",
    mimeType: "image/png",
    sizeBytes: 1,
    previewUrl: "data:image/png;base64,AA==",
    file: null,
  });
});
afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
});

function harness() {
  let resolveLease!: (value: NodeMutationLease | null) => void;
  let routed = source;
  const release = vi.fn();
  const controller = createHostedDraftTargetController({
    sourceIsCurrent: (request) => {
      const draft = useComposerDraftStore.getState().getDraftSession(request.draftId);
      return (
        draft?.promotedTo == null &&
        draft?.environmentId === source &&
        draft?.projectId === sourceProject.id
      );
    },
    targetIsEligible: () => true,
    routeMatches: (request) => request.environmentId === routed,
    subscribeRoute: () => () => {},
    retain: () => release,
    adopt: (environmentId) => {
      routed = environmentId;
      return true;
    },
    waitForLease: () =>
      new Promise((resolve) => {
        resolveLease = resolve;
      }),
    readLease: () => ready,
    readProjects: () => [targetProject],
    move: (id, project, logicalProjectKey) =>
      useComposerDraftStore.getState().moveDraftThreadToProject(id, {
        projectRef: scopeProjectRef(project.environmentId, project.id),
        logicalProjectKey,
      }),
    retry: () => {},
  });
  function Shell() {
    const selection = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
    return selection ? (
      <DraftDeviceProjectDialog
        {...selection}
        onCancel={() => controller.cancel()}
        onRetry={controller.retry}
        onSelect={controller.selectProject}
      />
    ) : (
      <p>Draft ready</p>
    );
  }
  return {
    Shell,
    controller,
    release,
    ready: () => resolveLease(ready),
    begin: () =>
      controller.begin({
        draftId,
        project: sourceProject,
        environmentId: target,
        label: "Second Mac",
        logicalKey: (project) => project.name,
      }),
  };
}

describe("draft device project selection", () => {
  it("survives a shell remount and preserves composer content when choosing a target project", async () => {
    const test = harness();
    const before = useComposerDraftStore.getState().getComposerDraft(draftId);
    mounted = await render(<test.Shell />);
    test.begin();
    await expect.element(page.getByText("Loading device projects…")).toBeVisible();
    await mounted.unmount();
    mounted = null;
    test.ready();
    mounted = await render(<test.Shell />);
    await expect
      .element(page.getByRole("heading", { name: "Choose a project on Second Mac" }))
      .toBeVisible();
    await expect
      .element(page.getByRole("button", { name: "Source repository", exact: false }))
      .not.toBeInTheDocument();
    await page.getByRole("button", { name: "Target repository", exact: false }).click();
    await expect.element(page.getByText("Draft ready")).toBeVisible();
    expect(useComposerDraftStore.getState().getComposerDraft(draftId)).toEqual(before);
    expect(useComposerDraftStore.getState().getDraftSession(draftId)).toMatchObject({
      threadId: draftId,
      environmentId: target,
      projectId: targetProject.id,
      branch: null,
      worktreePath: null,
      runtimeMode: "full-access",
      tokenMode: "balanced",
      envMode: "local",
    });
    expect(test.release).toHaveBeenCalledOnce();
  });

  it("filters target projects and cancels without moving or clearing the draft", async () => {
    const test = harness();
    test.begin();
    test.ready();
    const before = useComposerDraftStore.getState().getComposerDraft(draftId);
    mounted = await render(<test.Shell />);
    const search = page.getByPlaceholder("Search projects…");
    await search.fill("missing");
    await expect.element(page.getByText("No matching projects.")).toBeVisible();
    await search.fill("/target");
    await expect
      .element(page.getByRole("button", { name: "Target repository", exact: false }))
      .toBeVisible();
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    expect(useComposerDraftStore.getState().getDraftSession(draftId)?.environmentId).toBe(source);
    expect(useComposerDraftStore.getState().getComposerDraft(draftId)).toEqual(before);
    expect(test.controller.getSnapshot()).toBeNull();
  });
});
