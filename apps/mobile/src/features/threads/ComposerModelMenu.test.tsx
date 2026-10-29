import type { ComponentProps, ReactElement } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { ProviderInstanceId, type ModelSelection, type ServerProvider } from "@ryco/contracts";
import type { ModelFavorite } from "@ryco/contracts/settings";
import { createModelCapabilities } from "@ryco/shared/model";
import { modelFavoriteKey } from "@ryco/client-runtime/state/composer";

const state = vi.hoisted(() => ({ favorites: [] as ModelFavorite[], update: vi.fn() }));
vi.mock("../../state/preferencesStore", () => ({
  usePreferences: () => ({ favorites: state.favorites }),
  updatePreferences: state.update,
}));
vi.mock("../../components/AnchoredMenu", () => ({ AnchoredMenu: "AnchoredMenu" }));
vi.mock("../../components/ProviderIcon", () => ({ ProviderIcon: "ProviderIcon" }));
vi.mock("./ComposerModelOptions", () => ({ ComposerModelOptions: "ComposerModelOptions" }));
import { ComposerModelMenu } from "./ComposerModelMenu";
import { buildModelPickerModelFromOptions } from "./modelPickerModel";
import type { AnchoredMenu } from "../../components/AnchoredMenu";
import type { ModelOption } from "../../lib/modelOptions";

const provider = ProviderInstanceId.make("codex_personal");
const low = { provider, model: "test", reasoningEffort: "low" };
const high = { ...low, reasoningEffort: "high" };
const caps = createModelCapabilities({
  optionDescriptors: [
    {
      id: "reasoningEffort",
      label: "Reasoning",
      type: "select",
      options: [
        { id: "low", label: "Low" },
        { id: "high", label: "High" },
      ],
    },
    { id: "fastMode", label: "Fast", type: "boolean" },
  ],
});
const selection: ModelSelection = {
  instanceId: provider,
  model: "test",
  options: [
    { id: "reasoningEffort", value: "high" },
    { id: "fastMode", value: true },
  ],
};
function menu(
  disabled = false,
  locked = false,
  activeSelection = selection,
  favorites: ModelFavorite[] = [low, high],
) {
  state.favorites = favorites;
  state.update.mockClear();
  const onSelect = vi.fn();
  const model = buildModelPickerModelFromOptions({
    currentSelection: activeSelection,
    ...(locked ? { lockedProviderKey: "other" } : {}),
    modelOptions: [
      {
        key: `${provider}:test`,
        label: "Test",
        subtitle: "Personal",
        providerKey: provider,
        providerLabel: "Personal",
        providerDriver: "codex",
        isDefault: false,
        isLegacy: false,
        isCustom: false,
        capabilities: caps,
        selection,
      },
    ],
  });
  const tree = ComposerModelMenu({
    model,
    selection: activeSelection,
    disabled,
    onSelect,
    onClose: vi.fn(),
    children: () => null,
  }) as ReactElement<ComponentProps<typeof AnchoredMenu>>;
  return {
    props: tree.props,
    onSelect,
    press: (event: string) => tree.props.onPressAction?.({ nativeEvent: { event } }),
  };
}
describe("native model effort presets", () => {
  it("restores another effort on the selected model while retaining fast mode", () => {
    const mounted = menu();
    mounted.press(`favorite:${modelFavoriteKey(low)}`);
    expect(mounted.onSelect).toHaveBeenCalledWith({
      ...selection,
      options: [
        { id: "reasoningEffort", value: "low" },
        { id: "fastMode", value: true },
      ],
    });
    mounted.press(`remove:${modelFavoriteKey(low)}`);
    expect(state.update).toHaveBeenCalledWith({ favorites: [high] });
  });
  it("honors the mutation and provider-lock gates", () => {
    for (const [disabled, locked] of [
      [true, false],
      [false, true],
    ]) {
      const mounted = menu(disabled, locked);
      mounted.press(`favorite:${modelFavoriteKey(low)}`);
      expect(mounted.onSelect).not.toHaveBeenCalled();
    }
    const disabled = menu(true);
    disabled.press(`remove:${modelFavoriteKey(low)}`);
    disabled.press("toggle-favorite");
    expect(state.update).not.toHaveBeenCalled();
  });
});

it("native favorites preserve the destination selection when the active instance is different", () => {
  const foreign = {
    instanceId: ProviderInstanceId.make("claudeAgent"),
    model: "opus",
    options: [
      { id: "effort", value: "max" },
      { id: "fastMode", value: false },
    ],
  };
  const mounted = menu(false, false, foreign);
  mounted.press(`favorite:${modelFavoriteKey(low)}`);
  expect(mounted.onSelect).toHaveBeenCalledWith({
    ...selection,
    options: [
      { id: "reasoningEffort", value: "low" },
      { id: "fastMode", value: true },
    ],
  });
  const legacy = { provider, model: "test" };
  const old = menu(false, false, foreign, [legacy]);
  old.press(`favorite:${modelFavoriteKey(legacy)}`);
  expect(old.onSelect).toHaveBeenCalledWith(selection);
});
it("native current-model action removes a legacy favorite rather than adding an effort duplicate", () => {
  const legacy = { provider, model: "test" };
  const mounted = menu(false, false, selection, [legacy]);
  mounted.press("toggle-favorite");
  expect(state.update).toHaveBeenCalledWith({ favorites: [] });
});

describe("native legacy models", () => {
  const claude = ProviderInstanceId.make("claude_hub");
  const option = (slug: string, label: string, isLegacy: boolean): ModelOption => ({
    key: `${claude}:${slug}`,
    label,
    subtitle: "Hub",
    providerKey: claude,
    providerLabel: "Hub",
    providerDriver: "claudeAgent",
    isDefault: false,
    isLegacy,
    isCustom: false,
    capabilities: null,
    selection: { instanceId: claude, model: slug },
  });
  const active: ModelSelection = { instanceId: claude, model: "claude-opus-5" };
  function legacyMenu() {
    state.favorites = [];
    const onSelect = vi.fn();
    const model = buildModelPickerModelFromOptions({
      currentSelection: active,
      modelOptions: [
        option("claude-opus-5", "Opus 5", false),
        option("claude-opus-4-6", "Opus 4.6", true),
        option("claude-haiku-4-5", "Haiku 4.5", true),
      ],
      providers: [
        {
          instanceId: claude,
          driver: "claudeAgent",
          updateRequiredModels: [
            { slug: "claude-fable-5-1", name: "Claude Fable 5.1", minVersion: "2.1.257" },
          ],
        } as unknown as ServerProvider,
      ],
    });
    const tree = ComposerModelMenu({
      model,
      selection: active,
      disabled: false,
      onSelect,
      onClose: vi.fn(),
      children: () => null,
    }) as ReactElement<ComponentProps<typeof AnchoredMenu>>;
    return { tree, onSelect };
  }

  it("folds legacy models into a submenu that still dispatches a pick", () => {
    const { tree, onSelect } = legacyMenu();
    const provider = tree.props.actions.find((action) => action.id === `provider:${claude}`);
    expect(provider?.subactions?.map((action) => action.id)).toEqual([
      `${claude}:claude-opus-5`,
      `#legacy:${claude}`,
      `#update:${claude}`,
    ]);
    const legacy = provider?.subactions?.[1];
    expect(legacy).toMatchObject({ title: "Legacy models", subtitle: "2 models" });
    expect(legacy?.subactions?.map((action) => [action.title, action.state])).toEqual([
      ["Opus 4.6", "off"],
      ["Haiku 4.5", "off"],
    ]);

    tree.props.onPressAction?.({ nativeEvent: { event: `${claude}:claude-haiku-4-5` } });
    expect(onSelect).toHaveBeenCalledWith({ instanceId: claude, model: "claude-haiku-4-5" });
  });

  it("lists the update notice as text that cannot be picked", () => {
    const { tree, onSelect } = legacyMenu();
    const notice = tree.props.actions
      .find((action) => action.id === `provider:${claude}`)
      ?.subactions?.find((action) => action.id === `#update:${claude}`);
    expect(notice).toMatchObject({
      title: "Update Claude Code to v2.1.257 or newer to use Claude Fable 5.1.",
      attributes: { disabled: true },
    });
    expect(tree.props.renderIcon?.(notice!)).toBeNull();

    tree.props.onPressAction?.({ nativeEvent: { event: `#update:${claude}` } });
    expect(onSelect).not.toHaveBeenCalled();
  });
});
