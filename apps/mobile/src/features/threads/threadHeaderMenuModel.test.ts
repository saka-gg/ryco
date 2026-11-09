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

/** Each group as [id, its rows, its More rows]. */
const ids = (sections: ReturnType<typeof menu>) =>
  sections.map((section) => [
    section.id,
    section.actions.map((action) => action.id),
    (section.more ?? []).map((action) => action.id),
  ]);

const all = (sections: ReturnType<typeof menu>) => flattenThreadHeaderMenu(sections);

const allTools = { findInFiles: true, scripts: true, servers: true, notes: true, devices: true };

describe("thread header menu", () => {
  it("keeps the top level short: tools behind Workspace, rare actions behind More", () => {
    const sections = menu({ findAvailable: true });
    expect(ids(sections)).toEqual([
      ["workspace", ["files", "terminal", "source-control", "review"], []],
      ["chat", ["find", "side-chat", "fork", "rename"], []],
      ["state", ["archive"], ["artifacts", "add-task", "copy-reference", "delete"]],
    ]);
    expect(sections[0]?.collapsed).toEqual({ title: "Workspace", icon: "folder" });
    expect(sections.slice(1).every((section) => section.collapsed === undefined)).toBe(true);
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
      [
        "workspace",
        ["files", "terminal", "device", "source-control", "review", "pull-request"],
        [],
      ],
      ["chat", ["side-chat", "fork", "rename"], []],
      ["state", ["stop", "archive"], ["add-task", "copy-reference", "copy-task-id", "delete"]],
    ]);
    expect(all(sections).find((action) => action.id === "pull-request")?.title).toBe(
      "Pull request #42",
    );
    expect(all(sections).find((action) => action.id === "copy-reference")?.title).toBe(
      "Copy pull request link",
    );
    // A running turn must stop before the chat can be archived.
    expect(all(sections).find((action) => action.id === "archive")).toMatchObject({
      disabled: true,
      subtitle: "Stop the current turn first.",
    });
  });

  it("puts every workspace tool in the one Workspace submenu, only the available ones", () => {
    const sections = menu({ tools: allTools, deviceAvailable: true });
    expect(ids(sections)[0]).toEqual([
      "workspace",
      [
        "files",
        "terminal",
        "device",
        "source-control",
        "review",
        "find-in-files",
        "scripts",
        "servers",
        "notes",
        "devices",
      ],
      [],
    ]);
    expect(
      ids(
        menu({
          tools: { ...allTools, servers: false, devices: false },
          model: model({ reviewVisible: false }),
        }),
      )[0],
    ).toEqual([
      "workspace",
      ["files", "terminal", "source-control", "find-in-files", "scripts", "notes"],
      [],
    ]);
    // One submenu for the tools: no "More tools" inside Workspace.
    expect(all(sections).some((action) => action.title === "More tools")).toBe(false);
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
      ["chat", ["rename"], []],
      ["state", ["archive"], ["copy-reference", "delete"]],
    ]);
    expect(all(sections).find((action) => action.id === "rename")?.disabled).toBe(true);
    expect(all(sections).find((action) => action.id === "delete")?.disabled).toBe(true);
    expect(
      all(sections).find((action) => action.id === "copy-reference")?.disabled,
    ).toBeUndefined();
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
    const state = sections.find((section) => section.id === "state");
    expect(state?.actions.map((action) => [action.id, action.title, action.subtitle])).toEqual([
      ["settlement", "Settle task", "Resolve the pending approval first."],
      ["archive", "Restore", undefined],
    ]);
    expect(state?.more?.find((action) => action.id === "compact")).toMatchObject({
      subtitle: "Wait for the agent to finish.",
      disabled: true,
    });
  });

  it("offers a chat without a project to become one, after Rename", () => {
    const sections = menu({ promoteChatAvailable: true });
    expect(sections.find((section) => section.id === "chat")?.actions.map((a) => a.id)).toEqual([
      "side-chat",
      "fork",
      "rename",
      "turn-into-project",
    ]);
    expect(
      all(menu({ promoteChatAvailable: true, busy: true })).find(
        (action) => action.id === "turn-into-project",
      )?.disabled,
    ).toBe(true);
  });

  it("offers Stop session only while no turn runs, behind More, and Delete last", () => {
    const more = (overrides: Partial<ThreadHeaderMenuInput>) =>
      menu(overrides)
        .find((section) => section.id === "state")
        ?.more?.map((action) => action.id);
    expect(more({ sessionStoppable: true })).toEqual([
      "add-task",
      "copy-reference",
      "stop-session",
      "delete",
    ]);
    expect(
      more({
        sessionStoppable: true,
        model: model({ moreActions: ["rename", "archive", "stop", "details"] }),
      }),
    ).toEqual(["add-task", "copy-reference", "delete"]);
    expect(all(menu({})).find((action) => action.id === "delete")).toMatchObject({
      destructive: true,
    });
  });

  it("notes a running command and extra sessions under Terminal", () => {
    const terminal = (terminalSubtitle: string | null) =>
      all(menu({ terminalSubtitle })).find((action) => action.id === "terminal");
    expect(terminal("Command running · 2 sessions")?.subtitle).toBe("Command running · 2 sessions");
    expect(terminal(null)).not.toHaveProperty("subtitle");
  });

  it("is one list of real items on Android, in the iOS order, More rows after their group", () => {
    const flat = all(menu({ tools: allTools, findAvailable: true, sessionStoppable: true }));
    expect(flat.map((action) => action.id)).toEqual([
      "files",
      "terminal",
      "source-control",
      "review",
      "find-in-files",
      "scripts",
      "servers",
      "notes",
      "devices",
      "find",
      "side-chat",
      "fork",
      "rename",
      "archive",
      "artifacts",
      "add-task",
      "copy-reference",
      "stop-session",
      "delete",
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
