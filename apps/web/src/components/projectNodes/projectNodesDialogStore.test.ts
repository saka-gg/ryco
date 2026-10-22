import { EnvironmentId, ProjectId } from "@ryco/contracts";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { openAddProjectWith, useCommandPaletteStore } from "../../commandPaletteStore";
import {
  ADD_PROJECT_DIALOG_ENABLED,
  addProjectDialogAvailable,
  closeAddProject,
  closeCopyProject,
  markProjectCopiesActive,
  openAddProject,
  openCopyProject,
  resetProjectNodesDialogStoreForTests,
  useProjectNodesDialogStore,
} from "./projectNodesDialogStore";

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

    openAddProjectWith({ environmentId: MINI });
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
});
