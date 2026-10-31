import {
  applyNodeSettingsPatch,
  type NodeSettingsTarget,
} from "@ryco/client-runtime/state/settings/nodeSettingsFanOut";
import { projectPreferencesWritePatch } from "@ryco/client-runtime/state/settings/projectPreferenceEditing";
import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProjectId,
  type EffectiveProjectPreferences,
} from "@ryco/contracts";
import { applyServerSettingsPatch } from "@ryco/shared/serverSettings";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  settleNewTaskDefaults,
  testEffectivePreferences,
  testNode,
  testNodeConfig,
  TEST_PROVIDER,
  type TestNode,
} from "./newTaskDefaults.testSupport";

import {
  buildNewTaskDefaultRows,
  buildNewTaskDefaultsView,
  createNewTaskDefaultsController,
  initialModelOptionPatch,
  initialModelPicker,
  initialModelPickPatch,
  NEW_TASK_DEFAULTS_READ_ONLY,
  newTaskDefaultsApplyChoices,
  newTaskDefaultsScopes,
  resolveNewTaskDefaultsScope,
  worktreeSubmodulesRow,
  type NewTaskDefaultsController,
  type NewTaskDefaultsInput,
} from "./nodeNewTaskDefaultsModel";

const PROJECT = ProjectId.make("project-1");
const OTHER_PROJECT = ProjectId.make("project-2");
const CODEX = TEST_PROVIDER;
const config = testNodeConfig;
const effectiveFor = testEffectivePreferences;
const fakeNode = testNode;
const settle = settleNewTaskDefaults;

function input(node: TestNode, patch: Partial<NewTaskDefaultsInput> = {}): NewTaskDefaultsInput {
  return {
    label: "Studio",
    config: config(node.settings),
    api: node.api,
    editable: true,
    projectId: null,
    ...patch,
  };
}

async function opened(
  node: TestNode,
  patch: Partial<NewTaskDefaultsInput> = {},
): Promise<NewTaskDefaultsController> {
  const controller = createNewTaskDefaultsController({ write: node.write });
  controller.setInput(input(node, patch));
  await settle();
  return controller;
}

function rowsOf(controller: NewTaskDefaultsController, editable = true) {
  return buildNewTaskDefaultsView({
    state: controller.getSnapshot(),
    label: "Studio",
    config: config(),
    editable,
  });
}

describe("new-task default rows", () => {
  it("lists the model, then every registry setting the node reports, with its source", () => {
    const rows = buildNewTaskDefaultRows({
      effective: effectiveFor({ ...DEFAULT_SERVER_SETTINGS, worktreeBranchPrefix: "team" }),
      projectId: null,
      config: config(),
    });

    // The branch-name style and template use keep node rows of their own, as on the web.
    expect(rows.map((row) => [row.title, row.value, row.source])).toEqual([
      ["Provider and model", "GPT Builtin · High", "Ryco default"],
      ["New threads", "Local", "Node default"],
      ["Worktree branch prefix", "team", "Node default"],
      ["Worktree setup", "Run setup", "Node default"],
    ]);
    expect(rows.find((row) => row.key === "defaultThreadEnvMode")).toMatchObject({
      kind: "select",
      choices: [
        { label: "Local", selected: true, patch: { defaultThreadEnvMode: "local" } },
        { label: "New worktree", selected: false, patch: { defaultThreadEnvMode: "worktree" } },
      ],
    });
    expect(rows.find((row) => row.key === "worktreeBranchPrefix")).toMatchObject({
      kind: "text",
      text: "team",
      placeholder: "No prefix",
    });
    // The node's own default differs from Ryco's, so it can go back to it.
    expect(rows.find((row) => row.key === "worktreeBranchPrefix")?.reset).toEqual({
      label: "Use Ryco default for worktree branch prefix",
      patch: { worktreeBranchPrefix: DEFAULT_SERVER_SETTINGS.worktreeBranchPrefix },
    });
  });

  it("hides a setting an older node's reply leaves out instead of guessing it", () => {
    // A node from before the branch-name and template overrides omits both.
    const {
      worktreeBranchChangeTypes: _types,
      pullRequestTemplates: _templates,
      ...older
    } = effectiveFor(DEFAULT_SERVER_SETTINGS, PROJECT);
    const rows = buildNewTaskDefaultRows({
      effective: older as EffectiveProjectPreferences,
      projectId: PROJECT,
      config: config(),
    });
    expect(rows.map((row) => row.key)).toEqual([
      "initialModelSelection",
      "defaultThreadEnvMode",
      "worktreeBranchPrefix",
      "runSetupScript",
    ]);
    expect(buildNewTaskDefaultRows({ effective: null, projectId: null, config: config() })).toEqual(
      [],
    );
  });

  it("marks a project's own override and offers its way back to the node default", () => {
    const settings = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      projectPreferences: { [PROJECT]: { defaultThreadEnvMode: "worktree" } },
    });
    const rows = buildNewTaskDefaultRows({
      effective: effectiveFor(settings, PROJECT),
      projectId: PROJECT,
      config: config(settings),
    });
    const mode = rows.find((row) => row.key === "defaultThreadEnvMode");
    expect(mode).toMatchObject({
      value: "New worktree",
      source: "Overridden for this project",
      reset: {
        label: "Use node default for new threads",
        patch: { defaultThreadEnvMode: null },
      },
    });
    const setup = rows.find((row) => row.key === "runSetupScript");
    expect(setup).toMatchObject({ source: "Inherited from node defaults", reset: null });
    expect(rows[0]).toMatchObject({ source: "Inherited from Ryco defaults", reset: null });
    // A project overrides the branch-name style and template use too.
    expect(rows.slice(-2).map((row) => [row.title, row.value])).toEqual([
      ["Generated branch names", "By change type"],
      ["Pull request template", "Follow template"],
    ]);
  });

  it("reads submodules from the node's own config and says when the node is too old", () => {
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      worktreeSubmodules: "top-level" as const,
      projectWorktreeSubmodules: { [PROJECT]: "none" as const },
    };
    expect(worktreeSubmodulesRow(config(settings), null)).toEqual({
      value: "Top-level only",
      detail:
        "Node default. New worktrees also honor project overrides and repository configuration.",
    });
    expect(worktreeSubmodulesRow(config(settings), PROJECT)).toEqual({
      value: "None",
      detail: "Overridden for this project.",
    });
    expect(worktreeSubmodulesRow(config(settings), OTHER_PROJECT).value).toBe("Top-level only");
    expect(worktreeSubmodulesRow(config(settings, {}), null)).toEqual({
      value: "Update this machine",
      detail: "This node does not support configurable submodules.",
    });
    expect(worktreeSubmodulesRow(null, null).value).toBe("Connect a machine");
  });
});

describe("new-task default scopes", () => {
  it("offers the node's defaults and its projects, never a chat", () => {
    const scopes = newTaskDefaultsScopes([
      { id: PROJECT, name: "Ryco" },
      { id: ProjectId.make("chat-1"), name: "Chat folder", kind: "chat" },
      { id: OTHER_PROJECT, name: "Site", kind: "project" },
    ]);
    expect(scopes).toEqual([
      { projectId: null, label: "Node defaults" },
      { projectId: PROJECT, label: "Ryco" },
      { projectId: OTHER_PROJECT, label: "Site" },
    ]);
    expect(resolveNewTaskDefaultsScope(OTHER_PROJECT, scopes)).toBe(OTHER_PROJECT);
    // A removed project's edits never go anywhere else: the panel shows the node's defaults.
    expect(resolveNewTaskDefaultsScope(ProjectId.make("gone"), scopes)).toBeNull();
  });
});

describe("the initial model sheet", () => {
  it("offers only traits a creation preset may carry and saves only those", () => {
    const selection = { instanceId: CODEX, model: "gpt-builtin" };
    const picker = initialModelPicker({ config: config(), selection });
    expect(picker.options.map((option) => option.id)).toEqual(["reasoningEffort"]);
    expect(picker.hasOptionRail).toBe(true);

    expect(initialModelPickPatch(picker, `${CODEX}:gpt-fast`)).toEqual({
      initialModelSelection: {
        instanceId: CODEX,
        model: "gpt-fast",
        options: [{ id: "reasoningEffort", value: "high" }],
      },
    });
    expect(initialModelPickPatch(picker, `${CODEX}:gpt-builtin`)).toBeNull();
    expect(initialModelOptionPatch(picker, selection, "reasoningEffort", "low")).toEqual({
      initialModelSelection: {
        instanceId: CODEX,
        model: "gpt-builtin",
        options: [{ id: "reasoningEffort", value: "low" }],
      },
    });
    expect(initialModelOptionPatch(picker, selection, "agent", "build")).toBeNull();
  });
});

describe("the new-task defaults controller", () => {
  it("writes what the web writes: a project's never-set model compares as absent", async () => {
    const node = fakeNode();
    const controller = await opened(node, { projectId: PROJECT });
    const effective = controller.getSnapshot().effective!;
    const model = { instanceId: CODEX, model: "gpt-fast" };

    await controller.save({ initialModelSelection: model });

    expect(node.writes).toEqual([
      projectPreferencesWritePatch({
        effective,
        projectId: PROJECT,
        patch: { initialModelSelection: model },
      }),
    ]);
    expect(node.writes[0]).toEqual({
      projectPreferences: { [PROJECT]: { initialModelSelection: model } },
      expectedProjectPreferences: { [PROJECT]: { initialModelSelection: "absent" } },
    });
    // Read again after the write: the project now shows its own model.
    expect(rowsOf(controller).rows[0]).toMatchObject({
      value: "GPT Fast · High",
      source: "Overridden for this project",
    });
  });

  it("writes what the web writes: a node model only Ryco's default fills compares as unset", async () => {
    const node = fakeNode();
    const controller = await opened(node);
    const model = { instanceId: CODEX, model: "gpt-fast" };

    await controller.save({ initialModelSelection: model });

    expect(node.writes).toEqual([
      { initialModelSelection: model, expectedNodePreferences: { initialModelSelection: null } },
    ]);
    expect(node.settings.initialModelSelection).toEqual(model);
  });

  it("shows a refused write as '<node>: <message>' next to the node's current values", async () => {
    const node = fakeNode();
    const controller = await opened(node);
    // Another device switches the node to worktrees after this panel read it.
    node.changeElsewhere({ defaultThreadEnvMode: "worktree" });

    await controller.save({ defaultThreadEnvMode: "worktree" });

    const view = rowsOf(controller);
    expect(view.error).toBe("Studio: Node preferences changed elsewhere. Reload before saving.");
    expect(node.reads).toEqual([undefined, undefined]);
    expect(view.rows.find((row) => row.key === "defaultThreadEnvMode")?.value).toBe("New worktree");
    expect(view.canEdit).toBe(true);
  });

  it("holds a second edit until the first one's values are read back", async () => {
    const node = fakeNode();
    const controller = await opened(node);
    let answer: (() => void) | undefined;
    node.answerNextRead(
      (projectId) =>
        new Promise((resolve) => {
          answer = () => resolve(effectiveFor(node.settings, projectId));
        }),
    );

    const first = controller.save({ defaultThreadEnvMode: "worktree" });
    await settle();
    expect(rowsOf(controller).canEdit).toBe(false);
    await controller.save({ runSetupScript: false });
    expect(node.writes).toHaveLength(1);
    answer?.();
    await first;
    expect(rowsOf(controller).canEdit).toBe(true);

    // A settings push reads the node again; its values stay on screen and editable meanwhile.
    node.answerNextRead(() => new Promise(() => undefined));
    controller.setInput(input(node));
    expect(controller.getSnapshot().phase).toBe("loading");
    expect(rowsOf(controller)).toMatchObject({ canEdit: true, notice: null });
    expect(rowsOf(controller).rows.find((row) => row.key === "defaultThreadEnvMode")?.value).toBe(
      "New worktree",
    );
  });

  it("drops an answer for a scope the panel has left", async () => {
    const node = fakeNode(
      applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
        projectPreferences: { [PROJECT]: { worktreeBranchPrefix: "first" } },
      }),
    );
    let answerFirst: (() => void) | undefined;
    node.answerNextRead(
      (projectId) =>
        new Promise((resolve) => {
          answerFirst = () => resolve(effectiveFor(node.settings, projectId));
        }),
    );
    const controller = createNewTaskDefaultsController({ write: node.write });
    controller.setInput(input(node, { projectId: PROJECT }));
    controller.setInput(input(node, { projectId: OTHER_PROJECT }));
    await settle();
    answerFirst?.();
    await settle();

    const state = controller.getSnapshot();
    expect(state.projectId).toBe(OTHER_PROJECT);
    expect(state.effective?.worktreeBranchPrefix).toEqual({
      value: DEFAULT_SERVER_SETTINGS.worktreeBranchPrefix,
      source: "node",
    });
  });

  it("never stands in values when the node fails to answer", async () => {
    const node = fakeNode();
    const controller = await opened(node);
    node.answerNextRead(() => Promise.reject(new Error("socket")));

    await controller.reload();

    const view = rowsOf(controller);
    expect(view.rows).toEqual([]);
    expect(view.notice).toBe("Could not load Studio's defaults. Reconnect and try again.");
    await controller.save({ runSetupScript: false });
    expect(node.writes).toEqual([]);
  });

  it("asks an older node to update, without reading it", async () => {
    const node = fakeNode();
    const controller = await opened(node, { config: config(DEFAULT_SERVER_SETTINGS, {}) });
    expect(node.reads).toEqual([]);
    expect(rowsOf(controller).notice).toBe(
      "Update this node to change its new-task defaults here.",
    );
  });

  it("shows a viewer the node's values read-only and writes nothing for it", async () => {
    const node = fakeNode();
    const controller = await opened(node, { editable: false });

    const view = rowsOf(controller, false);
    expect(view.rows.map((row) => row.title)).toContain("New threads");
    expect(view.canEdit).toBe(false);
    expect(view.notice).toBe(NEW_TASK_DEFAULTS_READ_ONLY);
    await controller.save({ defaultThreadEnvMode: "worktree" });
    await controller.saveText("worktreeBranchPrefix", "team");
    expect(node.writes).toEqual([]);
  });

  it("checks a branch prefix with the node's own rule and the web's message before saving", async () => {
    const node = fakeNode();
    const controller = await opened(node);

    await controller.saveText("worktreeBranchPrefix", "team/");
    expect(node.writes).toEqual([]);
    expect(controller.getSnapshot().error).toBe(
      "Use a valid Git namespace of up to 128 characters without a trailing slash.",
    );

    await controller.saveText("worktreeBranchPrefix", "  team/tasks ");
    expect(node.writes).toEqual([
      {
        worktreeBranchPrefix: "team/tasks",
        expectedNodePreferences: {
          worktreeBranchPrefix: DEFAULT_SERVER_SETTINGS.worktreeBranchPrefix,
        },
      },
    ]);
    expect(controller.getSnapshot().error).toBeNull();
    // An unchanged value is no write.
    await controller.saveText("worktreeBranchPrefix", "team/tasks");
    expect(node.writes).toHaveLength(1);
  });

  it("applies one node default to every connected node, each compared with its own value", async () => {
    const studio = fakeNode(
      applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, { defaultThreadEnvMode: "worktree" }),
    );
    const laptop = fakeNode();
    const away = fakeNode();
    const target = (
      id: string,
      label: string,
      node: TestNode,
      connected = true,
    ): NodeSettingsTarget => ({
      environmentId: EnvironmentId.make(id),
      label,
      config: config(node.settings),
      connected,
      canWrite: true,
      write: node.write,
    });
    const targets = [
      target("studio", "Studio", studio),
      target("laptop", "Laptop", laptop),
      target("away", "Away", away, false),
    ];
    const controller = await opened(studio);

    expect(
      newTaskDefaultsApplyChoices(rowsOf(controller).rows, targets).find(
        (choice) => choice.key === "defaultThreadEnvMode",
      ),
    ).toEqual({
      key: "defaultThreadEnvMode",
      title: "New threads",
      value: "New worktree",
      detail: "Differs: Studio: New worktree, Laptop: Local.",
    });
    await controller.applyToAllNodes("defaultThreadEnvMode", targets);

    expect(studio.writes).toEqual([
      {
        defaultThreadEnvMode: "worktree",
        expectedNodePreferences: { defaultThreadEnvMode: "worktree" },
      },
    ]);
    expect(laptop.writes).toEqual([
      {
        defaultThreadEnvMode: "worktree",
        expectedNodePreferences: { defaultThreadEnvMode: "local" },
      },
    ]);
    expect(away.writes).toEqual([]);
    expect(controller.getSnapshot().applyStatus).toBe(
      "Applied to Studio, Laptop. Not changed: Away (not connected).",
    );
    // The model is never offered: provider instances differ per node.
    expect(
      newTaskDefaultsApplyChoices(rowsOf(controller).rows, targets).map((choice) => choice.key),
    ).not.toContain("initialModelSelection");
  });

  it("never sends a project override to other nodes", async () => {
    const node = fakeNode();
    const other = vi.fn(async () => undefined);
    const controller = await opened(node, { projectId: PROJECT });
    const targets: NodeSettingsTarget[] = [
      {
        environmentId: EnvironmentId.make("laptop"),
        label: "Laptop",
        config: config(),
        connected: true,
        canWrite: true,
        write: other,
      },
    ];

    await controller.applyToAllNodes("defaultThreadEnvMode", targets);
    expect(other).not.toHaveBeenCalled();
    expect(node.writes).toEqual([]);
    // Sanity: the same targets do take a node default written directly.
    await applyNodeSettingsPatch(targets, { defaultThreadEnvMode: "local" });
    expect(other).toHaveBeenCalledTimes(1);
  });
});
