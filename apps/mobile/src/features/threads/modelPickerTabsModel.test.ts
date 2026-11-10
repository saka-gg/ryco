import { ProviderInstanceId, type ModelSelection, type ServerProvider } from "@ryco/contracts";
import type { ModelFavorite } from "@ryco/contracts/settings";
import { createModelCapabilities } from "@ryco/shared/model";
import { describe, expect, it } from "vite-plus/test";

import type { ModelOption } from "../../lib/modelOptions";
import { buildModelPickerModelFromOptions, listModelPickerEntries } from "./modelPickerModel";
import {
  buildModelPickerList,
  buildModelPickerTabs,
  initialModelPickerTab,
  legacyRowKey,
  resolveModelPickerRowSelection,
  searchModelPickerGroups,
  type ModelPickerModelRow,
} from "./modelPickerTabsModel";

const personal = ProviderInstanceId.make("codex_personal");
const claude = ProviderInstanceId.make("claude_hub");
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
  instanceId: personal,
  model: "test",
  options: [
    { id: "reasoningEffort", value: "high" },
    { id: "fastMode", value: true },
  ],
};
const low: ModelFavorite = { provider: personal, model: "test", reasoningEffort: "low" };
const high: ModelFavorite = { ...low, reasoningEffort: "high" };

const option = (
  provider: ProviderInstanceId,
  slug: string,
  label: string,
  extra: Partial<ModelOption> = {},
): ModelOption => ({
  key: `${provider}:${slug}`,
  label,
  subtitle: provider === claude ? "Hub" : "Personal",
  providerKey: provider,
  providerLabel: provider === claude ? "Hub" : "Personal",
  providerDriver: provider === claude ? "claudeAgent" : "codex",
  isDefault: false,
  isLegacy: false,
  isCustom: false,
  capabilities: null,
  selection: { instanceId: provider, model: slug },
  ...extra,
});

const options: ModelOption[] = [
  option(personal, "test", "Test", { capabilities: caps, selection }),
  option(claude, "claude-opus-5", "Opus 5"),
  option(claude, "claude-opus-4-6", "Opus 4.6", { isLegacy: true }),
  option(claude, "claude-haiku-4-5", "Haiku 4.5", { isLegacy: true }),
];

function picker(input: { current?: ModelSelection; locked?: string | null } = {}) {
  return buildModelPickerModelFromOptions({
    currentSelection: input.current ?? selection,
    ...(input.locked ? { lockedProviderKey: input.locked } : {}),
    modelOptions: options,
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
}

function list(input: {
  tab: string | null;
  query?: string;
  favorites?: ModelFavorite[];
  current?: ModelSelection;
  expanded?: ReadonlySet<string>;
  locked?: string | null;
}) {
  const model = picker({ current: input.current ?? selection, locked: input.locked ?? null });
  const query = input.query ?? "";
  return buildModelPickerList({
    groups: query
      ? searchModelPickerGroups(model.groups, query, model.lockedProviderKey)
      : model.groups,
    allEntries: listModelPickerEntries(model),
    tab: input.tab,
    query,
    favorites: input.favorites ?? [],
    selection: input.current ?? selection,
    expandedLegacy: input.expanded ?? new Set(),
  });
}

const modelRows = (rows: ReturnType<typeof list>["rows"]) =>
  rows.filter((row): row is ModelPickerModelRow => row.kind === "model");

describe("model picker tabs", () => {
  it("puts favorites first, then one tab per instance; a provider lock leaves its own tab", () => {
    expect(buildModelPickerTabs(picker()).map((tab) => tab.id)).toEqual([
      "favorites",
      personal,
      claude,
    ]);
    expect(buildModelPickerTabs(picker({ locked: claude })).map((tab) => tab.id)).toEqual([claude]);
  });

  it("opens on favorites when there are any, else on the selection's instance", () => {
    const tabs = buildModelPickerTabs(picker());
    expect(initialModelPickerTab({ tabs, favoritesCount: 1, selection })).toBe("favorites");
    expect(initialModelPickerTab({ tabs, favoritesCount: 0, selection })).toBe(personal);
    const locked = buildModelPickerTabs(picker({ locked: claude }));
    expect(initialModelPickerTab({ tabs: locked, favoritesCount: 3, selection })).toBe(claude);
  });
});

describe("model picker rows", () => {
  it("shows the active model's effort and its star on its instance tab", () => {
    const rows = modelRows(list({ tab: personal, favorites: [high] }).rows);
    expect(rows.map((row) => [row.entry.label, row.detail, row.isFavorite, row.active])).toEqual([
      ["Test", "High", true, true],
    ]);
    expect(rows[0]?.showProvider).toBe(false);
  });

  it("folds legacy models under one row that opens in place", () => {
    const closed = list({ tab: claude, current: { instanceId: claude, model: "claude-opus-5" } });
    expect(closed.rows.map((row) => row.key)).toEqual([
      `${claude}:claude-opus-5`,
      legacyRowKey(claude),
    ]);
    expect(closed.rows[1]).toMatchObject({
      kind: "legacy",
      countLabel: "2 models",
      expanded: false,
    });
    expect(closed.notices).toEqual([
      "Update Claude Code to v2.1.257 or newer to use Claude Fable 5.1.",
    ]);
    const open = list({
      tab: claude,
      current: { instanceId: claude, model: "claude-opus-5" },
      expanded: new Set([claude]),
    });
    expect(modelRows(open.rows).map((row) => row.entry.label)).toEqual([
      "Opus 5",
      "Opus 4.6",
      "Haiku 4.5",
    ]);
  });

  it("lists favorites as presets, each with its own effort and provider", () => {
    const favorites = list({ tab: "favorites", favorites: [low, high] });
    expect(
      modelRows(favorites.rows).map((row) => [
        row.entry.label,
        row.detail,
        row.showProvider,
        row.active,
      ]),
    ).toEqual([
      ["Test", "Low", true, false],
      ["Test", "High", true, true],
    ]);
    expect(list({ tab: "favorites" }).emptyMessage).toBe("Star a model to keep it here.");
  });

  it("searches every instance, legacy models inline, with no tab open", () => {
    const found = list({ tab: personal, query: "opus" });
    expect(found.openTab).toBeNull();
    expect(modelRows(found.rows).map((row) => [row.entry.label, row.showProvider])).toEqual([
      ["Opus 5", true],
      ["Opus 4.6", true],
    ]);
    expect(list({ tab: personal, query: "nothing like it" }).emptyMessage).toBe("No models found");
    expect(list({ tab: personal, query: "fable" }).notices).toHaveLength(1);
  });
});

describe("model picker row picks", () => {
  const favoriteRow = (favorites: ModelFavorite[], current: ModelSelection, key: string) =>
    modelRows(list({ tab: "favorites", favorites, current }).rows).find((row) =>
      row.key.endsWith(key),
    )!;

  it("restores another effort on the selected model while retaining fast mode", () => {
    const row = favoriteRow([low, high], selection, '"low"]');
    expect(resolveModelPickerRowSelection({ row, selection, disabled: false })).toEqual({
      ...selection,
      options: [
        { id: "reasoningEffort", value: "low" },
        { id: "fastMode", value: true },
      ],
    });
  });

  it("applies a favorite over the destination model when another instance is active", () => {
    const foreign: ModelSelection = {
      instanceId: claude,
      model: "claude-opus-5",
      options: [{ id: "effort", value: "max" }],
    };
    const row = modelRows(list({ tab: "favorites", favorites: [low], current: foreign }).rows)[0]!;
    expect(resolveModelPickerRowSelection({ row, selection: foreign, disabled: false })).toEqual({
      ...selection,
      options: [
        { id: "reasoningEffort", value: "low" },
        { id: "fastMode", value: true },
      ],
    });
  });

  it("ignores taps while disabled, on a locked instance, or on the active model", () => {
    const row = modelRows(list({ tab: "favorites", favorites: [low] }).rows)[0]!;
    expect(resolveModelPickerRowSelection({ row, selection, disabled: true })).toBeNull();
    const locked = modelRows(list({ tab: null, query: "opus", locked: personal }).rows);
    expect(locked).toEqual([]);
    const lockedRow = modelRows(list({ tab: claude, locked: personal }).rows)[0]!;
    expect(lockedRow.entry.disabled).toBe(true);
    expect(
      resolveModelPickerRowSelection({ row: lockedRow, selection, disabled: false }),
    ).toBeNull();
    const active = modelRows(list({ tab: personal }).rows)[0]!;
    expect(resolveModelPickerRowSelection({ row: active, selection, disabled: false })).toBeNull();
    const other = modelRows(
      list({ tab: claude, current: selection, expanded: new Set([claude]) }).rows,
    )[1]!;
    expect(resolveModelPickerRowSelection({ row: other, selection, disabled: false })).toEqual({
      instanceId: claude,
      model: "claude-opus-4-6",
    });
  });

  it("stars the legacy model-only favorite as the current row, so the star removes it", () => {
    const legacy: ModelFavorite = { provider: personal, model: "test" };
    const row = modelRows(list({ tab: personal, favorites: [legacy] }).rows)[0]!;
    expect(row.isFavorite).toBe(true);
    expect(row.favorite).toEqual(legacy);
  });
});
