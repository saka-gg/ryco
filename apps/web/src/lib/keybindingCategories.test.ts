import { describe, expect, it } from "vite-plus/test";
import { KEYBINDING_CATEGORIES, getCommandMeta } from "./keybindingCategories";

describe("keybindingCategories", () => {
  it("maps terminal commands to the Terminal category", () => {
    expect(getCommandMeta("terminal.toggle").category).toBe(KEYBINDING_CATEGORIES.terminal);
    expect(getCommandMeta("terminal.split").category).toBe(KEYBINDING_CATEGORIES.terminal);
    expect(getCommandMeta("terminal.new").category).toBe(KEYBINDING_CATEGORIES.terminal);
    expect(getCommandMeta("terminal.close").category).toBe(KEYBINDING_CATEGORIES.terminal);
  });

  it("maps workspace commands to the Workspace category", () => {
    expect(getCommandMeta("workspace.files").category).toBe(KEYBINDING_CATEGORIES.workspace);
    expect(getCommandMeta("workspace.review").category).toBe(KEYBINDING_CATEGORIES.workspace);
    expect(getCommandMeta("workspace.terminal").category).toBe(KEYBINDING_CATEGORIES.workspace);
  });

  it("maps chat commands to the Chat category", () => {
    expect(getCommandMeta("chat.new").category).toBe(KEYBINDING_CATEGORIES.chat);
    expect(getCommandMeta("chat.newLocal").category).toBe(KEYBINDING_CATEGORIES.chat);
  });

  it("maps sidebar mode commands to the Sidebar category", () => {
    expect(getCommandMeta("sidebar.showInbox")).toMatchObject({
      category: KEYBINDING_CATEGORIES.sidebar,
      title: "Show Inbox sidebar",
    });
    expect(getCommandMeta("sidebar.showProjects")).toMatchObject({
      category: KEYBINDING_CATEGORIES.sidebar,
      title: "Show Projects sidebar",
    });
  });

  it("maps the pull requests page command to its own category", () => {
    expect(getCommandMeta("pullRequests.open")).toMatchObject({
      category: KEYBINDING_CATEGORIES.pullRequests,
      title: "Open pull requests",
    });
  });

  it("maps the projects page command to its own category, apart from the sidebar mode", () => {
    expect(getCommandMeta("projects.open")).toMatchObject({
      category: KEYBINDING_CATEGORIES.projects,
      title: "Open projects page",
    });
  });

  it("maps stash to the Composer category with a friendly title", () => {
    expect(getCommandMeta("composer.stash").category).toBe(KEYBINDING_CATEGORIES.composer);
    expect(getCommandMeta("composer.stash").title).toBe("Stash prompt or open stash");
  });

  it("maps thread navigation to the Threads category", () => {
    expect(getCommandMeta("thread.find").category).toBe(KEYBINDING_CATEGORIES.thread);
    expect(getCommandMeta("thread.pinToggle")).toMatchObject({
      category: KEYBINDING_CATEGORIES.thread,
      title: "Pin or unpin current thread",
    });
    expect(getCommandMeta("thread.previous").category).toBe(KEYBINDING_CATEGORIES.thread);
    expect(getCommandMeta("thread.jump.1").category).toBe(KEYBINDING_CATEGORIES.thread);
    expect(getCommandMeta("thread.jump.9").category).toBe(KEYBINDING_CATEGORIES.thread);
  });

  it("maps split-view commands to the Split view category", () => {
    expect(getCommandMeta("pane.split")).toMatchObject({
      category: KEYBINDING_CATEGORIES.pane,
      title: "Open a thread in split view",
    });
    expect(getCommandMeta("pane.close").category).toBe(KEYBINDING_CATEGORIES.pane);
    expect(getCommandMeta("pane.focusNext").category).toBe(KEYBINDING_CATEGORIES.pane);
    expect(getCommandMeta("pane.focusPrevious").category).toBe(KEYBINDING_CATEGORIES.pane);
  });

  it("maps model-picker commands to the Model picker category", () => {
    expect(getCommandMeta("modelPicker.toggle").category).toBe(KEYBINDING_CATEGORIES.modelPicker);
    expect(getCommandMeta("modelPicker.jump.5").category).toBe(KEYBINDING_CATEGORIES.modelPicker);
  });

  it("maps script.<id>.run commands to the Project scripts category", () => {
    expect(getCommandMeta("script.test.run").category).toBe(KEYBINDING_CATEGORIES.script);
    expect(getCommandMeta("script.build.run").category).toBe(KEYBINDING_CATEGORIES.script);
  });

  it("returns a friendly title for static commands", () => {
    expect(getCommandMeta("terminal.toggle").title).toBe("Toggle terminal drawer");
    expect(getCommandMeta("workspace.files").title).toBe("Open workspace files");
    expect(getCommandMeta("commandPalette.toggle").title).toBe("Open command palette");
    expect(getCommandMeta("editor.openFavorite").title).toBe("Open in preferred editor");
    expect(getCommandMeta("thread.find").title).toBe("Find in current thread");
  });

  it("derives a title from the script id when no override is given", () => {
    expect(getCommandMeta("script.test.run").title).toBe("Run: test");
    expect(getCommandMeta("script.build-dev.run").title).toBe("Run: build-dev");
  });

  it("prefers the provided script title over the derived one", () => {
    expect(getCommandMeta("script.test.run", "Run tests").title).toBe("Run tests");
  });

  it("assigns increasing sort weights within a category", () => {
    expect(getCommandMeta("terminal.toggle").sortWeight).toBeLessThan(
      getCommandMeta("terminal.close").sortWeight,
    );
    expect(getCommandMeta("thread.find").sortWeight).toBeLessThan(
      getCommandMeta("thread.previous").sortWeight,
    );
    expect(getCommandMeta("thread.previous").sortWeight).toBeLessThan(
      getCommandMeta("thread.jump.1").sortWeight,
    );
  });
});
