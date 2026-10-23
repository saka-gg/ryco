import { afterEach, describe, expect, it } from "vite-plus/test";

import { useCommandPaletteStore } from "./commandPaletteStore";

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
