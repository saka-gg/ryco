import type { ComponentProps, ReactElement } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { ProviderInstanceId, type ModelSelection } from "@ryco/contracts";
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
function menu(disabled = false, locked = false) {
  state.favorites = [low, high];
  state.update.mockClear();
  const onSelect = vi.fn();
  const model = buildModelPickerModelFromOptions({
    currentSelection: selection,
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
        capabilities: caps,
        selection,
      },
    ],
  });
  const tree = ComposerModelMenu({
    model,
    selection,
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
