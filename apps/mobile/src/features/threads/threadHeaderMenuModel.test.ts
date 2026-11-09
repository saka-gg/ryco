import { describe, expect, it } from "vite-plus/test";

import {
  buildThreadHeaderMenu,
  flattenThreadHeaderMenu,
  resolveThreadRename,
  type ThreadHeaderMenuInput,
} from "./threadHeaderMenuModel";
import type { ThreadHeaderModel } from "./threadHeaderModel";

function model(overrides: Partial<ThreadHeaderModel> = {}): ThreadHeaderModel {
  return {
    title: "Fix CI",
    nodeLabel: "Studio",
    projectLabel: "Ryco",
    worktreeLabel: "feat/ci",
    contextHeading: "Project · Worktree",
    statusLabel: "Ready",
    contextAccessibilityLabel: "",
    reviewVisible: true,
    filesVisible: true,
    terminalVisible: true,
    moreActions: ["rename", "archive", "details"],
    changeRequest: null,
    pullRequestNumber: null,
    settlementAction: null,
    compactAction: null,
    pullRequestWatch: null,
    copyReference: { kind: "thread", value: "thread-ci" },
    taskId: "thread-ci",
    ...overrides,
  };
}

function menu(overrides: Partial<ThreadHeaderMenuInput> = {}) {
  return buildThreadHeaderMenu({
    model: model(),
    sourceControlAvailable: true,
    deviceAvailable: false,
    sideChatAvailable: true,
    forkAvailable: true,
    addTaskAvailable: true,
    busy: false,
    ...overrides,
  });
}

const ids = (sections: ReturnType<typeof menu>) =>
  sections.map((section) => [section.id, section.actions.map((action) => action.id)]);

const allTools = { findInFiles: true, scripts: true, servers: true, notes: true, devices: true };

describe("thread header menu", () => {
  it("gathers the old header buttons and the task sheet's actions in three groups", () => {
    expect(ids(menu())).toEqual([
      ["workspace", ["files", "terminal", "source-control", "review"]],
      ["chat", ["side-chat", "fork", "rename", "add-task", "copy-reference"]],
      ["state", ["archive"]],
    ]);
  });

  it("adds the device, the pull request and its link, and the running turn's Stop", () => {
    const sections = menu({
      deviceAvailable: true,
      model: model({
        pullRequestNumber: 42,
        copyReference: { kind: "pull-request", value: "https://github.com/o/r/pull/42" },
        moreActions: ["rename", "archive", "stop", "details"],
      }),
    });
    expect(ids(sections)).toEqual([
      ["workspace", ["files", "terminal", "device", "source-control", "review", "pull-request"]],
      ["chat", ["side-chat", "fork", "rename", "add-task", "copy-reference", "copy-task-id"]],
      ["state", ["stop", "archive"]],
    ]);
    const all = sections.flatMap((section) => section.actions);
    expect(all.find((action) => action.id === "pull-request")?.title).toBe("Pull request #42");
    expect(all.find((action) => action.id === "copy-reference")?.title).toBe(
      "Copy pull request link",
    );
    // A running turn must stop before the chat can be archived.
    expect(all.find((action) => action.id === "archive")).toMatchObject({
      disabled: true,
      subtitle: "Stop the current turn first.",
    });
  });

  it("puts the workspace tools behind one More tools submenu when the group would run long", () => {
    const sections = menu({ tools: allTools });
    expect(ids(sections)[0]).toEqual([
      "workspace",
      ["files", "terminal", "source-control", "review", "more-tools"],
    ]);
    const more = sections[0]?.actions.at(-1);
    expect(more?.title).toBe("More tools");
    expect(more?.children?.map((action) => action.id)).toEqual([
      "find-in-files",
      "scripts",
      "servers",
      "notes",
      "devices",
    ]);
  });

  it("keeps the tools inline while the group stays short, and only the available ones", () => {
    const sections = menu({
      tools: { ...allTools, servers: false, devices: false },
      model: model({ reviewVisible: false }),
    });
    expect(ids(sections)[0]).toEqual([
      "workspace",
      ["files", "terminal", "source-control", "find-in-files", "scripts", "notes"],
    ]);
    expect(sections[0]?.actions.every((action) => action.children === undefined)).toBe(true);
  });

  it("drops the workspace group without a checkout and gates changes while busy", () => {
    const sections = menu({
      sourceControlAvailable: false,
      sideChatAvailable: false,
      forkAvailable: false,
      addTaskAvailable: false,
      busy: true,
      model: model({ reviewVisible: false, filesVisible: false, terminalVisible: false }),
    });
    expect(ids(sections)).toEqual([
      ["chat", ["rename", "copy-reference"]],
      ["state", ["archive"]],
    ]);
    const all = sections.flatMap((section) => section.actions);
    expect(all.find((action) => action.id === "rename")?.disabled).toBe(true);
    expect(all.find((action) => action.id === "copy-reference")?.disabled).toBeUndefined();
  });

  it("says why compacting or settling cannot run, and restores an archived chat", () => {
    const sections = menu({
      model: model({
        moreActions: ["rename", "unarchive", "details"],
        compactAction: {
          label: "Compact conversation",
          detail: "Wait for the agent to finish.",
          disabled: true,
        },
        settlementAction: {
          kind: "settle",
          label: "Settle task",
          detail: "Resolve the pending approval first.",
          disabled: true,
        },
      }),
    });
    const state = sections.find((section) => section.id === "state")?.actions ?? [];
    expect(state.map((action) => [action.id, action.title, action.subtitle])).toEqual([
      ["compact", "Compact conversation", "Wait for the agent to finish."],
      ["settlement", "Settle task", "Resolve the pending approval first."],
      ["archive", "Restore", undefined],
    ]);
  });

  it("offers a chat without a project to become one, after Rename", () => {
    const sections = menu({
      promoteChatAvailable: true,
      sourceControlAvailable: false,
      model: model({ reviewVisible: false, filesVisible: true, terminalVisible: true }),
    });
    expect(ids(sections)).toEqual([
      ["workspace", ["files", "terminal"]],
      ["chat", ["side-chat", "fork", "rename", "turn-into-project", "add-task", "copy-reference"]],
      ["state", ["archive"]],
    ]);
    expect(
      menu({ promoteChatAvailable: true, busy: true })
        .flatMap((section) => section.actions)
        .find((action) => action.id === "turn-into-project")?.disabled,
    ).toBe(true);
  });

  it("notes a running command and extra sessions under Terminal", () => {
    const terminal = (terminalSubtitle: string | null) =>
      menu({ terminalSubtitle })
        .flatMap((section) => section.actions)
        .find((action) => action.id === "terminal");
    expect(terminal("Command running · 2 sessions")?.subtitle).toBe("Command running · 2 sessions");
    expect(terminal(null)).not.toHaveProperty("subtitle");
  });

  it("is one list of real items on Android, in the iOS order, with no group rows", () => {
    const sections = menu({ tools: allTools });
    const flat = flattenThreadHeaderMenu(sections);
    expect(flat.map((action) => action.id)).toEqual([
      "files",
      "terminal",
      "source-control",
      "review",
      "more-tools",
      "side-chat",
      "fork",
      "rename",
      "add-task",
      "copy-reference",
      "archive",
    ]);
    // Every row is an action with a title: none is an untitled group (a blank submenu). The one
    // submenu Android draws is "More tools", titled, holding the tools.
    expect(flat.every((action) => action.title.length > 0)).toBe(true);
    expect(flat.filter((action) => action.children).map((action) => action.title)).toEqual([
      "More tools",
    ]);
  });
});

describe("thread rename", () => {
  it("saves a trimmed new title and nothing for an empty or unchanged one", () => {
    expect(resolveThreadRename("Fix CI", "  Fix the CI  ")).toBe("Fix the CI");
    expect(resolveThreadRename("Fix CI", " Fix CI ")).toBeNull();
    expect(resolveThreadRename("Fix CI", "   ")).toBeNull();
    expect(resolveThreadRename("Fix CI", undefined)).toBeNull();
  });
});
