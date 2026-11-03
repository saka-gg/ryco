import { EnvironmentId, ProjectId } from "@ryco/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { useCommandPaletteStore } from "../../commandPaletteStore";
import {
  ADD_PROJECT_DIALOG_ENABLED,
  addProjectDialogAvailable,
  clearProjectSelectorOpenRequest,
  closeAddProject,
  closeCopyProject,
  isProjectSelectorOpenRequested,
  openAddProject,
  openCopyProject,
  requestProjectSelectorOpen,
  resetProjectNodesDialogStoreForTests,
  useProjectNodesDialogStore,
} from "./projectNodesDialogStore";
import {
  markProjectCopiesActive,
  projectCopyBadgeFor,
  publishProjectCopyBadges,
} from "./projectNodesShellActions";

const MINI = EnvironmentId.make("env-mini");
const source = { environmentId: EnvironmentId.make("env-laptop"), projectId: ProjectId.make("p") };

afterEach(() => {
  resetProjectNodesDialogStoreForTests();
  useCommandPaletteStore.setState({ open: false, openIntent: null });
});

describe("projectNodesDialogStore", () => {
  it("opens the add-project dialog with a fresh request each time and keeps it while it folds", () => {
    openAddProject({ environmentId: MINI, mode: "clone" });
    openAddProject();
    expect(useProjectNodesDialogStore.getState().addProject).toEqual({
      open: true,
      token: 2,
      request: { environmentId: null, mode: null, projectRef: null },
    });

    closeAddProject();
    expect(useProjectNodesDialogStore.getState().addProject).toMatchObject({
      open: false,
      token: 2,
      request: { environmentId: null },
    });
  });

  it("opens the copy dialog for one checkout, with or without a destination", () => {
    openCopyProject({ source, origin: "sidebar" });
    expect(useProjectNodesDialogStore.getState().copyProject).toEqual({
      open: true,
      token: 1,
      request: { source, targetEnvironmentId: null, origin: "sidebar" },
    });
    openCopyProject({ source, targetEnvironmentId: MINI, origin: "devices-section" });
    expect(useProjectNodesDialogStore.getState().copyProject.request?.targetEnvironmentId).toBe(
      MINI,
    );
    closeCopyProject();
    expect(useProjectNodesDialogStore.getState().copyProject.open).toBe(false);
  });

  it("opens the dialog from every Add project entry point off the phone tier", () => {
    expect(ADD_PROJECT_DIALOG_ENABLED).toBe(true);
    expect(addProjectDialogAvailable("phone")).toBe(false);
    expect(addProjectDialogAvailable("desktop")).toBe(true);

    // Unit tests run on the desktop tier.
    useCommandPaletteStore.getState().openAddProject();
    expect(useProjectNodesDialogStore.getState().addProject.open).toBe(true);
    expect(useCommandPaletteStore.getState()).toMatchObject({ open: false, openIntent: null });

    useCommandPaletteStore.getState().openAddProject({ environmentId: MINI });
    expect(useProjectNodesDialogStore.getState().addProject).toMatchObject({
      open: true,
      token: 2,
      request: { environmentId: MINI, mode: null, projectRef: null },
    });
  });

  it("records that copies run this session", () => {
    expect(useProjectNodesDialogStore.getState().copiesActive).toBe(false);
    markProjectCopiesActive();
    markProjectCopiesActive();
    expect(useProjectNodesDialogStore.getState().copiesActive).toBe(true);
  });

  it("asks one project's selector to open, and lets the request lapse or be cleared", () => {
    vi.useFakeTimers();
    try {
      const other = { ...source, projectId: ProjectId.make("other") };
      requestProjectSelectorOpen(source);
      const request = () => useProjectNodesDialogStore.getState().projectSelectorOpenRequest;
      expect(isProjectSelectorOpenRequested(request(), source)).toBe(true);
      expect(isProjectSelectorOpenRequested(request(), other)).toBe(false);
      clearProjectSelectorOpenRequest(other);
      expect(request()).not.toBeNull();
      clearProjectSelectorOpenRequest(source);
      expect(request()).toBeNull();

      requestProjectSelectorOpen(source);
      vi.advanceTimersByTime(15_001);
      expect(request()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("publishes copy badges only when they change and finds a row's badge by its members", () => {
    const badges = { "env-laptop:p": 40, "env-mini:q": null };
    publishProjectCopyBadges(badges);
    const published = useProjectNodesDialogStore.getState().copyBadges;
    expect(published).toBe(badges);
    publishProjectCopyBadges({ ...badges });
    expect(useProjectNodesDialogStore.getState().copyBadges).toBe(published);

    expect(projectCopyBadgeFor(published, ["env-x:y", "env-laptop:p"])).toBe(40);
    expect(projectCopyBadgeFor(published, ["env-mini:q"])).toBeNull();
    expect(projectCopyBadgeFor(published, ["env-x:y"])).toBeUndefined();
    publishProjectCopyBadges({});
    expect(
      projectCopyBadgeFor(useProjectNodesDialogStore.getState().copyBadges, ["env-laptop:p"]),
    ).toBeUndefined();
  });
});
