import { afterEach, describe, expect, it } from "vite-plus/test";

import { EnvironmentId } from "@ryco/contracts";

import { useCommandPaletteStore } from "./commandPaletteStore";
import {
  resetProjectNodesDialogStoreForTests,
  useProjectNodesDialogStore,
} from "./components/projectNodes/projectNodesDialogStore";

const initialState = useCommandPaletteStore.getState();
const state = () => useCommandPaletteStore.getState();

afterEach(() => {
  useCommandPaletteStore.setState(initialState, true);
});

describe("workspace search mode", () => {
  it("opens quick open and closes it on the same key", () => {
    state().openWorkspaceSearch("files");
    expect(state()).toMatchObject({ open: true, workspaceSearchMode: "files" });

    state().openWorkspaceSearch("files");
    expect(state()).toMatchObject({ open: false, workspaceSearchMode: null });
  });

  it("switches from the command list to quick open", () => {
    state().setOpen(true);
    state().openWorkspaceSearch("files");
    expect(state()).toMatchObject({ open: true, workspaceSearchMode: "files" });
  });

  it("switches between quick open and find in files", () => {
    state().openWorkspaceSearch("files");
    state().openWorkspaceSearch("content");
    expect(state()).toMatchObject({ open: true, workspaceSearchMode: "content" });

    state().openWorkspaceSearch("files");
    expect(state()).toMatchObject({ open: true, workspaceSearchMode: "files" });
  });

  it("goes back to the command list on the palette key", () => {
    state().openWorkspaceSearch("files");
    state().toggleOpen();
    expect(state()).toMatchObject({ open: true, workspaceSearchMode: null });

    state().toggleOpen();
    expect(state().open).toBe(false);
  });

  it("forgets the mode when the palette closes", () => {
    state().openWorkspaceSearch("files");
    state().setOpen(false);
    expect(state().workspaceSearchMode).toBeNull();

    state().toggleOpen();
    expect(state()).toMatchObject({ open: true, workspaceSearchMode: null });
  });

  it("shows the command list for palette intents", () => {
    state().openWorkspaceSearch("files");
    state().openSearch("deploy");
    expect(state()).toMatchObject({
      open: true,
      workspaceSearchMode: null,
      openIntent: { kind: "search", query: "deploy" },
    });
  });
});

describe("add-project intent", () => {
  afterEach(() => {
    resetProjectNodesDialogStoreForTests();
  });

  it("carries a dropped folder's path and environment", () => {
    const environmentId = EnvironmentId.make("environment-local");
    state().openAddProject({ path: "/repo/dropped", environmentId });
    state().openAddProject({ path: "/repo/dropped", environmentId });
    expect(state()).toMatchObject({
      open: true,
      openIntent: { kind: "add-project", requestId: 2, path: "/repo/dropped", environmentId },
    });
    expect(useProjectNodesDialogStore.getState().addProject.open).toBe(false);
  });

  it("opens the add-project dialog without a folder", () => {
    // Unit tests run on the desktop tier, where the dialog is available.
    state().openAddProject();
    expect(state()).toMatchObject({ open: false, openIntent: null });
    expect(useProjectNodesDialogStore.getState().addProject).toMatchObject({
      open: true,
      request: { environmentId: null, mode: null, projectRef: null },
    });
  });

  it("ignores a click event passed as the request", () => {
    // Sidebar buttons hand the action to `onClick` as it is.
    const onClick = state().openAddProject as (event: unknown) => void;
    onClick({ type: "click", target: null, nativeEvent: {} });
    expect(state().openIntent).toBeNull();
    expect(useProjectNodesDialogStore.getState().addProject).toMatchObject({
      open: true,
      request: { environmentId: null, mode: null, projectRef: null },
    });
  });
});
