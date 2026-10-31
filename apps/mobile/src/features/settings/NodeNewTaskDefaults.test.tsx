import { Fragment, isValidElement, type ReactElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ProjectId, type ServerSettingsPatch } from "@ryco/contracts";

import {
  settleNewTaskDefaults,
  testNode,
  testNodeConfig,
  TEST_PROVIDER,
  type TestNode,
} from "./newTaskDefaults.testSupport";

// The panel, invoked as plain functions with react-native mocked (no React renderer exists in
// this suite). Hooks keep their state in call order between renders, as React does; the
// controller and the node behind it are real.

type Slot = { value: unknown; deps?: ReadonlyArray<unknown> };

const hoisted = vi.hoisted(() => ({
  slots: [] as Slot[],
  cursor: 0,
  effects: [] as (() => void)[],
  environments: [] as unknown[],
  configs: new Map<string, unknown>(),
  apis: new Map<string, unknown>(),
  projects: new Map<string, unknown[]>(),
  writes: new Map<string, (patch: ServerSettingsPatch) => Promise<void>>(),
  alert: vi.fn(),
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const slot = (init: () => unknown): Slot => {
    const index = hoisted.cursor++;
    hoisted.slots[index] ??= { value: init() };
    return hoisted.slots[index]!;
  };
  return {
    ...actual,
    useState: (initial: unknown) => {
      const state = slot(() => (typeof initial === "function" ? initial() : initial));
      return [
        state.value,
        (next: unknown) => {
          state.value = typeof next === "function" ? next(state.value) : next;
        },
      ] as const;
    },
    useMemo: (factory: () => unknown, deps: ReadonlyArray<unknown>) => {
      const memo = slot(factory);
      if (memo.deps && deps.some((dep, index) => !Object.is(dep, memo.deps![index])))
        memo.value = factory();
      memo.deps = deps;
      return memo.value;
    },
    useLayoutEffect: (effect: () => void) => {
      hoisted.effects.push(effect);
    },
    useSyncExternalStore: (_subscribe: unknown, read: () => unknown) => read(),
  };
});
vi.mock("react-native", () => ({
  Alert: { alert: hoisted.alert },
  Pressable: "Pressable",
  ScrollView: "ScrollView",
  View: "View",
}));
vi.mock("zustand/react/shallow", () => ({ useShallow: <T,>(selector: T) => selector }));
vi.mock("../../components/AppText", () => ({ AppText: "Text", AppTextInput: "TextInput" }));
vi.mock("./components/SettingsRow", () => ({ SettingsRow: "SettingsRow" }));
vi.mock("./components/SettingsSection", () => ({ SettingsSection: "SettingsSection" }));
vi.mock("../threads/ModelPickerSheet", () => ({ ModelPickerSheet: "ModelPickerSheet" }));
vi.mock("../home/useHomeEnvironments", () => ({
  useHomeEnvironments: () => hoisted.environments,
}));
vi.mock("../../state/environmentServerConfigs", () => ({
  useEnvironmentServerConfigs: () => hoisted.configs,
}));
vi.mock("../../state/threadsRuntime", () => ({
  useStore: (selector: (state: unknown) => unknown) => selector({}),
  selectProjectsForEnvironment: (_state: unknown, environmentId: string) =>
    hoisted.projects.get(environmentId) ?? [],
}));
vi.mock("../../connection/useEnvironmentApi", () => ({
  useEnvironmentApi: (environmentId: string) => hoisted.apis.get(environmentId),
}));
vi.mock("../../connection/environmentApi", () => ({
  updateEnvironmentServerSettings: (environmentId: string, patch: ServerSettingsPatch) =>
    hoisted.writes.get(environmentId)!(patch),
}));

import { NodeNewTaskDefaults } from "./NodeNewTaskDefaults";

type Props = Record<string, unknown> & { readonly children?: ReactNode };

/** Calls every function component down the tree, leaving the mocked primitives. */
function expand(node: ReactNode): ReactNode {
  if (Array.isArray(node)) return node.map(expand);
  if (!isValidElement(node)) return node;
  const element = node as ReactElement<Props>;
  if (typeof element.type === "function") {
    return expand((element.type as (props: Props) => ReactNode)(element.props));
  }
  if ((element.type as unknown) === Fragment) return expand(element.props.children);
  return { ...element, props: { ...element.props, children: expand(element.props.children) } };
}

function elements(node: ReactNode, type: string): ReactElement<Props>[] {
  if (Array.isArray(node)) return node.flatMap((child: ReactNode) => elements(child, type));
  if (!isValidElement(node)) return [];
  const element = node as ReactElement<Props>;
  const own = element.type === type ? [element] : [];
  return [...own, ...elements(element.props.children, type)];
}

function textOf(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (!isValidElement(node)) return "";
  return textOf((node as ReactElement<Props>).props.children);
}

function row(tree: ReactNode, label: string): Props | undefined {
  return elements(tree, "SettingsRow").find((element) => element.props.label === label)?.props;
}

/** One render, then its layout effects, as a commit runs them. */
function render(): ReactNode {
  hoisted.cursor = 0;
  const tree = expand(<NodeNewTaskDefaults />);
  for (const effect of hoisted.effects.splice(0)) effect();
  return tree;
}

/** Renders until reads and writes have settled, and returns the settled tree. */
async function settled(): Promise<ReactNode> {
  render();
  await settleNewTaskDefaults();
  return render();
}

const STUDIO = EnvironmentId.make("studio");

function addNode(input: {
  readonly node: TestNode;
  readonly role?: "owner" | "viewer";
  readonly connected?: boolean;
}) {
  const connected = input.connected ?? true;
  hoisted.environments.push({
    environmentId: STUDIO,
    label: "Studio",
    role: input.role ?? "owner",
    connectionState: connected ? "connected" : "offline",
    mutationReady: connected,
  });
  hoisted.configs.set(STUDIO, testNodeConfig(input.node.settings));
  if (connected) hoisted.apis.set(STUDIO, input.node.api);
  hoisted.writes.set(STUDIO, input.node.write);
}

afterEach(() => {
  hoisted.slots = [];
  hoisted.effects = [];
  hoisted.environments = [];
  hoisted.configs.clear();
  hoisted.apis.clear();
  hoisted.projects.clear();
  hoisted.writes.clear();
  vi.clearAllMocks();
});

describe("the New tasks panel", () => {
  it("lets a connected owner pick the node's model, and writes it to that node", async () => {
    const node = testNode();
    addNode({ node });
    let tree: ReactNode = await settled();

    const model = row(tree, "Provider and model");
    expect(model).toMatchObject({ value: "GPT Builtin · High", detail: "Ryco default" });
    expect(model?.disabled).toBe(false);
    expect(typeof model?.onPress).toBe("function");
    (model!.onPress as () => void)();
    tree = render();
    const sheet = elements(tree, "ModelPickerSheet")[0]!.props;
    expect(sheet.visible).toBe(true);
    (sheet.onSelect as (key: string) => void)(`${TEST_PROVIDER}:gpt-fast`);
    tree = await settled();

    expect(node.writes).toEqual([
      {
        initialModelSelection: {
          instanceId: TEST_PROVIDER,
          model: "gpt-fast",
          options: [{ id: "reasoningEffort", value: "high" }],
        },
        expectedNodePreferences: { initialModelSelection: null },
      },
    ]);
    expect(row(tree, "Provider and model")).toMatchObject({
      value: "GPT Fast · High",
      detail: "Node default",
    });
    expect(elements(tree, "ModelPickerSheet")[0]!.props.visible).toBe(false);
  });

  it("applies a trait from the sheet while a search hides the selected model", async () => {
    const node = testNode();
    addNode({ node });
    let tree: ReactNode = await settled();
    (row(tree, "Provider and model")!.onPress as () => void)();
    tree = render();
    (elements(tree, "ModelPickerSheet")[0]!.props.onChangeQuery as (query: string) => void)("fast");
    tree = render();
    const sheet = elements(tree, "ModelPickerSheet")[0]!.props;
    expect(sheet.query).toBe("fast");

    (sheet.onSelectOption as (id: string, value: string) => void)("reasoningEffort", "low");
    await settled();

    expect(node.writes).toEqual([
      {
        initialModelSelection: {
          instanceId: TEST_PROVIDER,
          model: "gpt-builtin",
          options: [{ id: "reasoningEffort", value: "low" }],
        },
        expectedNodePreferences: { initialModelSelection: null },
      },
    ]);
  });

  it("shows a refused write as '<node>: <message>' and the node's values read again", async () => {
    const node = testNode();
    addNode({ node });
    let tree: ReactNode = await settled();
    // Another device changes the node after this panel read it.
    node.changeElsewhere({ defaultThreadEnvMode: "worktree" });

    (row(tree, "New threads")!.onPress as () => void)();
    const [title, , buttons] = hoisted.alert.mock.calls[0] as [
      string,
      string,
      { text: string; onPress?: () => void }[],
    ];
    expect(title).toBe("New threads");
    expect(buttons.map((button) => button.text)).toEqual(["Local ✓", "New worktree", "Cancel"]);
    buttons[1]!.onPress!();
    tree = await settled();

    const alert = elements(tree, "Text").find((element) => element.props.accessibilityRole);
    expect(textOf(alert)).toBe("Studio: Node preferences changed elsewhere. Reload before saving.");
    expect(row(tree, "New threads")).toMatchObject({ value: "New worktree" });
  });

  it("offers a project's override its way back, and never offers to apply it elsewhere", async () => {
    const project = ProjectId.make("project-1");
    const node = testNode();
    node.changeElsewhere({ projectPreferences: { [project]: { runSetupScript: false } } });
    addNode({ node });
    hoisted.projects.set(STUDIO, [
      { id: project, name: "Ryco" },
      { id: ProjectId.make("chat"), name: "A chat", kind: "chat" },
    ]);
    let tree: ReactNode = await settled();
    const chips = elements(tree, "Pressable");
    expect(chips.map((chip) => textOf(chip))).toEqual(["✓ Node defaults", "Ryco"]);

    (chips[1]!.props.onPress as () => void)();
    tree = await settled();
    expect(node.reads.at(-1)).toBe(project);
    expect(row(tree, "Worktree setup")).toMatchObject({
      value: "Skip setup",
      detail: "Overridden for this project",
    });
    (row(tree, "Use node default for worktree setup")!.onPress as () => void)();
    tree = await settled();

    expect(node.writes.at(-1)).toEqual({
      projectPreferences: { [project]: { runSetupScript: null } },
      expectedProjectPreferences: { [project]: { runSetupScript: false } },
    });
    expect(row(tree, "Worktree setup")).toMatchObject({ detail: "Inherited from node defaults" });
    expect(row(tree, "Apply to all connected nodes")).toBeUndefined();
  });

  it("shows a viewer the values with no control and no runtime mode row", async () => {
    const node = testNode();
    addNode({ node, role: "viewer" });
    const tree = await settled();

    expect(textOf(tree)).toContain("Connect as the node owner to change this.");
    const model = row(tree, "Provider and model");
    expect(model).toMatchObject({ value: "GPT Builtin · High" });
    expect(model?.onPress).toBeUndefined();
    expect(row(tree, "New threads")?.onPress).toBeUndefined();
    expect(elements(tree, "TextInput")).toEqual([]);
    expect(row(tree, "Runtime mode")).toBeUndefined();
  });

  it("reads nothing from an offline node and invents no values for it", async () => {
    const node = testNode();
    addNode({ node, connected: false });
    const tree = await settled();

    expect(node.reads).toEqual([]);
    expect(row(tree, "Provider and model")).toBeUndefined();
    // Its owner is asked to reconnect, not to become the owner.
    expect(textOf(tree)).toContain("Reconnect to change this.");
    expect(textOf(tree)).not.toContain("Connect as the node owner");
    expect(row(tree, "Worktree submodules")).toMatchObject({ value: "Recursive" });
  });
});
