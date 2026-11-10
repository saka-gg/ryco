import { toggleModelFavorite } from "@ryco/client-runtime/state/composer";
import type { ModelSelection } from "@ryco/contracts";
import type { ReactNode, Ref } from "react";
import { useImperativeHandle, useRef, useState } from "react";
import { Pressable, ScrollView, TextInput, View } from "react-native";

import { AnchoredPopover, type AnchoredPopoverHandle } from "../../components/AnchoredPopover";
import type { AnchoredMenuHandle } from "../../components/AnchoredMenu";
import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { ProviderIcon } from "../../components/ProviderIcon";
import { cn } from "../../lib/cn";
import { useThemeColor } from "../../lib/useThemeColor";
import { updatePreferences, usePreferences } from "../../state/preferencesStore";
import { ComposerModelTuningDial } from "./ComposerModelTuningDial";
import { applyComposerTuningChange, resolveComposerTuning } from "./composerFooterModel";
import { listModelPickerEntries, type ModelPickerModel } from "./modelPickerModel";
import {
  buildModelPickerList,
  buildModelPickerTabs,
  initialModelPickerTab,
  resolveModelPickerRowSelection,
  searchModelPickerGroups,
  type ModelPickerModelRow,
  type ModelPickerTabId,
} from "./modelPickerTabsModel";

// The composer's model picker, ported from the desktop one (apps/web ModelPickerContent,
// ModelPickerTabs, ModelListRow, ModelTuningDial): source tabs on top — favorites, one per
// provider instance, "Add providers" — a search across every instance, the open tab's models
// with a star each and a folded "Legacy models" row, and the tuning dial for the active model.
// The phone adds Claude's prompt-cache row above the dial.

/** The desktop popup's width. */
const PICKER_WIDTH = 320;

function TabButton(props: {
  readonly label: string;
  readonly selected: boolean;
  readonly onPress: () => void;
  readonly children: ReactNode;
}) {
  const accent = useThemeColor("--color-primary");
  return (
    <Pressable
      accessibilityRole="tab"
      accessibilityLabel={props.label}
      accessibilityState={{ selected: props.selected }}
      hitSlop={{ top: 6, bottom: 6 }}
      onPress={props.onPress}
      className="h-7 min-w-7 items-center justify-center rounded-lg px-1.5 active:bg-subtle-strong"
    >
      <View style={{ opacity: props.selected ? 1 : 0.7 }}>{props.children}</View>
      {props.selected ? (
        // The open tab's marker hangs below the button.
        <View
          pointerEvents="none"
          className="absolute rounded-full"
          style={{ left: 6, right: 6, bottom: -4, height: 2, backgroundColor: accent }}
        />
      ) : null}
    </Pressable>
  );
}

function ModelRow(props: {
  readonly row: ModelPickerModelRow;
  readonly disabled: boolean;
  readonly onSelect: () => void;
  readonly onToggleFavorite: () => void;
}) {
  const { row } = props;
  const subtle = useThemeColor("--color-icon-subtle");
  const star = useThemeColor("--color-warning");
  const disabled = props.disabled || row.entry.disabled;
  const favoriteLabel = row.isFavorite ? "Remove from favorites" : "Add to favorites";
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityLabel={[row.entry.label, row.detail, row.entry.disabledReason]
        .filter(Boolean)
        .join(", ")}
      accessibilityState={{ checked: row.active, disabled }}
      // The star is a button inside the row; VoiceOver reaches it as the row's action.
      accessibilityActions={[{ name: "favorite", label: favoriteLabel }]}
      onAccessibilityAction={(event) => {
        if (event.nativeEvent.actionName === "favorite" && !props.disabled)
          props.onToggleFavorite();
      }}
      disabled={disabled}
      onPress={props.onSelect}
      className={cn(
        "min-h-10 flex-row items-center gap-2 rounded-md py-1 pe-1 ps-2",
        row.active ? "bg-subtle-strong" : "active:bg-subtle",
        disabled && "opacity-45",
      )}
    >
      {row.showProvider ? <ProviderIcon provider={row.entry.providerDriver} size={14} /> : null}
      <View className="min-w-0 flex-1">
        <View className="flex-row items-center gap-2">
          <Text numberOfLines={1} className="shrink text-[13px] text-foreground">
            {row.entry.label}
          </Text>
          {row.detail ? (
            <Text numberOfLines={1} className="min-w-0 flex-1 text-xs text-foreground-tertiary">
              {row.detail}
            </Text>
          ) : null}
        </View>
        {row.entry.disabledReason ? (
          <Text numberOfLines={2} className="text-[11px] text-foreground-muted">
            {row.entry.disabledReason}
          </Text>
        ) : null}
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={favoriteLabel}
        hitSlop={8}
        disabled={props.disabled}
        onPress={props.onToggleFavorite}
        className="size-7 items-center justify-center rounded-md active:bg-subtle-strong"
      >
        <SymbolView
          name={row.isFavorite ? "star.fill" : "star"}
          size={13}
          tintColor={row.isFavorite ? star : subtle}
          type="monochrome"
        />
      </Pressable>
    </Pressable>
  );
}

export function ComposerModelMenu({
  ref,
  ...props
}: {
  readonly ref?: Ref<AnchoredMenuHandle>;
  readonly model: ModelPickerModel;
  readonly selection: ModelSelection;
  readonly disabled: boolean;
  readonly onSelect: (selection: ModelSelection) => void;
  readonly onClose: () => void;
  /** Claude's observed prompt cache, as a row above the dial. */
  readonly onOpenCacheInfo?: (() => void) | undefined;
  /** The "+" tab: where the machine's providers are set up. */
  readonly onAddProviders?: (() => void) | undefined;
  /** The draft, so a prompt-controlled "ultrathink" locks the effort dial as on desktop. */
  readonly prompt?: string;
  /** The anchor wrapper's layout; it fills a toolbar by default. */
  readonly anchorClassName?: string;
  readonly children: (
    open: () => void,
    settings: {
      readonly reasoningLabel: string | null;
      readonly fastEnabled: boolean;
      readonly accessibilitySuffix: string;
    },
  ) => ReactNode;
}) {
  const favorites = usePreferences().favorites ?? [];
  const popoverRef = useRef<AnchoredPopoverHandle>(null);
  const listRef = useRef<ScrollView>(null);
  useImperativeHandle(ref, () => ({ open: () => popoverRef.current?.open() }));
  const [tab, setTab] = useState<ModelPickerTabId | null>(null);
  const [query, setQuery] = useState("");
  const [expandedLegacy, setExpandedLegacy] = useState<ReadonlySet<string>>(() => new Set());
  const iconColor = useThemeColor("--color-icon");
  const iconSubtle = useThemeColor("--color-icon-subtle");
  const textColor = useThemeColor("--color-foreground");

  const { model, selection } = props;
  const tabs = buildModelPickerTabs(model);
  const allEntries = listModelPickerEntries(model);
  const selectedKey = `${selection.instanceId}:${selection.model}`;
  const selectedEntry = allEntries.find((entry) => entry.key === selectedKey);
  const list = buildModelPickerList({
    groups: query.trim()
      ? searchModelPickerGroups(model.groups, query, model.lockedProviderKey)
      : model.groups,
    allEntries,
    tab,
    query,
    favorites,
    selection,
    expandedLegacy,
  });
  const tuning = resolveComposerTuning({ model, selection, prompt: props.prompt ?? "" });

  const controls = model.options;
  const reasoning = controls.find((option) => option.kind === "select");
  const selectedReasoning = reasoning?.choices.find((choice) => choice.selected);
  const fast = controls.find((option) => option.kind === "boolean");
  const settings = {
    reasoningLabel: selectedReasoning?.shortLabel ?? null,
    fastEnabled: fast?.enabled === true,
    accessibilitySuffix: [
      selectedReasoning ? `${reasoning?.label}: ${selectedReasoning.label}` : null,
      fast?.enabled ? `${fast.label} on` : null,
    ]
      .filter(Boolean)
      .join(", "),
  };

  const selectRow = (row: ModelPickerModelRow) => {
    const next = resolveModelPickerRowSelection({ row, selection, disabled: props.disabled });
    if (next) props.onSelect(next);
  };

  return (
    <AnchoredPopover
      ref={popoverRef}
      width={PICKER_WIDTH}
      onOpen={() => {
        setTab(initialModelPickerTab({ tabs, favoritesCount: favorites.length, selection }));
        setQuery("");
        setExpandedLegacy(new Set());
      }}
      onClose={props.onClose}
      className={props.anchorClassName ?? "min-w-0 flex-1"}
      renderContent={({ maxHeight }) => (
        <View style={{ maxHeight }}>
          {tabs.length > 1 || props.onAddProviders ? (
            <View
              accessibilityRole="tablist"
              className="flex-row items-center gap-0.5 border-b border-border p-1.5"
            >
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                keyboardShouldPersistTaps="always"
                contentContainerStyle={{ alignItems: "center", gap: 2, paddingVertical: 4 }}
                className="-my-1 min-w-0 flex-1"
              >
                {tabs.map((candidate) => (
                  <TabButton
                    key={candidate.id}
                    label={candidate.label}
                    selected={list.openTab === candidate.id}
                    onPress={() => {
                      setQuery("");
                      setTab(candidate.id);
                    }}
                  >
                    {candidate.providerDriver === null ? (
                      <SymbolView
                        name="star.fill"
                        size={13}
                        tintColor={iconColor}
                        type="monochrome"
                      />
                    ) : (
                      <ProviderIcon provider={candidate.providerDriver} size={16} />
                    )}
                  </TabButton>
                ))}
              </ScrollView>
              {props.onAddProviders ? (
                <TabButton
                  label="Add providers"
                  selected={false}
                  onPress={() => {
                    popoverRef.current?.close();
                    props.onAddProviders?.();
                  }}
                >
                  <SymbolView name="plus" size={13} tintColor={iconColor} type="monochrome" />
                </TabButton>
              ) : null}
            </View>
          ) : null}
          <View className="flex-row items-center gap-2 border-b border-border px-3">
            <SymbolView name="magnifyingglass" size={14} tintColor={iconSubtle} type="monochrome" />
            <TextInput
              accessibilityLabel="Search models"
              placeholder="Search models..."
              placeholderTextColor={iconSubtle as string}
              value={query}
              onChangeText={setQuery}
              autoCapitalize="none"
              autoCorrect={false}
              className="h-10 flex-1 text-sm"
              style={{ color: textColor as string }}
            />
          </View>
          {model.lockNotice ? (
            <Text className="px-3 pt-2 text-xs leading-snug text-foreground-muted">
              {model.lockNotice}
            </Text>
          ) : null}
          <ScrollView
            ref={listRef}
            bounces={false}
            keyboardShouldPersistTaps="always"
            showsVerticalScrollIndicator={false}
            className="shrink"
            contentContainerStyle={{ gap: 1, padding: 4 }}
          >
            {list.rows.map((row) =>
              row.kind === "legacy" ? (
                <Pressable
                  key={row.key}
                  accessibilityRole="button"
                  accessibilityLabel={`Legacy models, ${row.countLabel}`}
                  accessibilityState={{ expanded: row.expanded }}
                  onPress={() => {
                    const providerKey = row.key.slice("#legacy:".length);
                    setExpandedLegacy((current) => {
                      const next = new Set(current);
                      if (next.has(providerKey)) next.delete(providerKey);
                      else next.add(providerKey);
                      return next;
                    });
                  }}
                  className="min-h-10 flex-row items-center gap-2 rounded-md py-1 pe-1 ps-2 active:bg-subtle"
                >
                  <Text className="min-w-0 flex-1 text-[13px] text-foreground-muted">
                    Legacy models
                  </Text>
                  <Text className="text-xs text-foreground-tertiary">{row.countLabel}</Text>
                  <View className="size-7 items-center justify-center">
                    <SymbolView
                      name={row.expanded ? "chevron.down" : "chevron.right"}
                      size={11}
                      tintColor={iconSubtle}
                      type="monochrome"
                    />
                  </View>
                </Pressable>
              ) : (
                <ModelRow
                  key={row.key}
                  row={row}
                  disabled={props.disabled}
                  onSelect={() => selectRow(row)}
                  onToggleFavorite={() =>
                    updatePreferences({ favorites: toggleModelFavorite(favorites, row.favorite) })
                  }
                />
              ),
            )}
            {list.emptyMessage ? (
              <Text className="py-6 text-center text-xs text-foreground-muted">
                {list.emptyMessage}
              </Text>
            ) : null}
          </ScrollView>
          {list.notices.map((notice) => (
            <Text
              key={notice}
              className="border-t border-border px-3 py-2 text-xs leading-snug text-foreground-muted"
            >
              {notice}
            </Text>
          ))}
          {props.onOpenCacheInfo ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Prompt cache. What Claude reused"
              onPress={() => {
                popoverRef.current?.close();
                props.onOpenCacheInfo?.();
              }}
              className="min-h-10 flex-row items-center gap-2 border-t border-border px-3 active:bg-subtle"
            >
              <SymbolView name="info.circle" size={14} tintColor={iconSubtle} type="monochrome" />
              <Text className="text-[13px] text-foreground">Prompt cache</Text>
              <Text className="min-w-0 flex-1 text-xs text-foreground-tertiary">
                What Claude reused
              </Text>
            </Pressable>
          ) : null}
          {tuning ? (
            <View className="border-t border-border">
              <ComposerModelTuningDial
                tuning={tuning}
                modelLabel={selectedEntry?.label ?? selection.model}
                disabled={props.disabled}
                onChange={(change) => {
                  if (props.disabled) return;
                  const next = applyComposerTuningChange({ model, selection, tuning, change });
                  if (next !== selection) props.onSelect(next);
                }}
                onRevealModel={() => {
                  setQuery("");
                  setTab(
                    tabs.some((candidate) => candidate.id === selection.instanceId)
                      ? selection.instanceId
                      : tab,
                  );
                  listRef.current?.scrollTo({ y: 0, animated: true });
                }}
              />
            </View>
          ) : null}
        </View>
      )}
    >
      {(open) => props.children(open, settings)}
    </AnchoredPopover>
  );
}
