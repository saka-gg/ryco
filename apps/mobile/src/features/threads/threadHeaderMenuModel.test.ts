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

  it("notes a running command and extra sessions under Terminal", () => {
    const terminal = (terminalSubtitle: string | null) =>
      menu({ terminalSubtitle })
        .flatMap((section) => section.actions)
        .find((action) => action.id === "terminal");
    expect(terminal("Command running · 2 sessions")?.subtitle).toBe("Command running · 2 sessions");
    expect(terminal(null)).not.toHaveProperty("subtitle");
  });

  it("is one list of real items on Android, in the iOS order, with no group rows", () => {
    const sections = menu();
    const flat = flattenThreadHeaderMenu(sections);
    expect(flat.map((action) => action.id)).toEqual([
      "files",
      "terminal",
      "source-control",
      "review",
      "side-chat",
      "fork",
      "rename",
      "copy-reference",
      "archive",
    ]);
    // Every row is an action with a title: none is an untitled group (a blank submenu).
    expect(flat.every((action) => action.title.length > 0)).toBe(true);
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
