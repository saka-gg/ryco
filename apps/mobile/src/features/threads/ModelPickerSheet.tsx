import { useState } from "react";
import { Pressable, ScrollView, TextInput, View } from "react-native";
import Animated, {
  FadeIn,
  FadeOut,
  ReduceMotion,
  SlideInDown,
  SlideOutDown,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { GlassSurface } from "../../components/GlassSurface";
import { OverlayPortal } from "../../components/OverlayPortal";
import { ProviderIcon } from "../../components/ProviderIcon";
import { cn } from "../../lib/cn";
import { useThemeColor } from "../../lib/useThemeColor";
import type {
  ModelOptionControl,
  ModelPickerEntry,
  ModelPickerGroup,
  ModelPickerModel,
} from "./modelPickerModel";

// Grouped model picker, one section per provider instance, with the provider's
// brand mark on the section header. Like the policy sheet it goes through
// OverlayPortal rather than a Modal so opening it does not dismiss the
// composer's keyboard.

/**
 * The model's own options, stacked vertically beside the list.
 *
 * Vertical rather than horizontal for two reasons: three reasoning levels fit in
 * 58pt where a horizontal control cannot, and stacking the strongest at the TOP
 * gives the scale a direction that needs no legend.
 *
 * Rendered only when the selected model declares options. A model with none —
 * Haiku, for one — gets no rail at all rather than an empty or disabled one.
 */
function OptionRail(props: {
  readonly options: ReadonlyArray<ModelOptionControl>;
  readonly onSelectOption: (optionId: string, value: string | boolean) => void;
}) {
  const iconColor = useThemeColor("--color-icon");
  const cautionColor = useThemeColor("--color-warning");
  const boolean = props.options.find((option) => option.kind === "boolean");
  const select = props.options.find((option) => option.kind === "select");

  return (
    <View className="w-[58px] shrink-0 gap-1.5">
      {boolean ? (
        <Pressable
          accessibilityRole="switch"
          accessibilityState={{ checked: boolean.enabled }}
          accessibilityLabel={`${boolean.label}, ${boolean.enabled ? "on" : "off"}`}
          onPress={() => props.onSelectOption(boolean.id, !boolean.enabled)}
          className={cn(
            // A circle: fast mode is one binary thing, and a round target
            // reads as a toggle rather than as another segment of the stack
            // below it.
            "h-10 w-10 self-center items-center justify-center rounded-full border active:opacity-70",
            boolean.enabled ? "border-warning/40 bg-warning-bg" : "border-border bg-subtle",
          )}
        >
          <SymbolView
            name="bolt.fill"
            size={15}
            tintColor={(boolean.enabled ? cautionColor : iconColor) as string}
            type="monochrome"
          />
        </Pressable>
      ) : null}
      {select ? (
        <View
          accessibilityRole="radiogroup"
          accessibilityLabel={select.label}
          // Softened rather than fully pill: a stadium track next to a circular
          // toggle made the two read as one control. Concentric radii — track
          // 16, minus the 4pt inset, gives 12 on each segment.
          className="flex-1 gap-1 rounded-2xl bg-subtle p-1"
        >
          {/* Reversed: the provider declares low -> high, and the strongest
              belongs at the top so the stack reads as a scale. */}
          {[...select.choices].reverse().map((choice) => (
            <Pressable
              key={choice.id}
              accessibilityRole="radio"
              accessibilityState={{ checked: choice.selected }}
              accessibilityLabel={`${select.label}: ${choice.label}`}
              onPress={() => props.onSelectOption(select.id, choice.id)}
              className={cn(
                "min-h-9 flex-1 items-center justify-center rounded-xl active:opacity-70",
                choice.selected ? "bg-card" : "bg-transparent",
              )}
            >
              <Text
                className={cn(
                  "text-2xs",
                  choice.selected ? "font-ryco-bold text-foreground" : "text-foreground-muted",
                )}
                numberOfLines={1}
              >
                {choice.shortLabel}
              </Text>
            </Pressable>
          ))}
        </View>
      ) : null}
    </View>
  );
}

function ModelPickerRow(props: {
  readonly entry: ModelPickerEntry;
  readonly divided: boolean;
  readonly checkColor: string;
  readonly onSelect: (key: string) => void;
}) {
  const { entry } = props;
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ checked: entry.selected, disabled: entry.disabled }}
      accessibilityLabel={
        entry.disabled && entry.disabledReason
          ? `${entry.label}. ${entry.disabledReason}`
          : entry.label
      }
      disabled={entry.disabled}
      onPress={() => props.onSelect(entry.key)}
      className={cn(
        "min-h-11 flex-row items-center justify-between gap-3 px-3.5 py-2.5 active:bg-card-alt",
        props.divided && "border-t border-border-subtle",
        entry.disabled && "opacity-40",
      )}
    >
      <Text
        className={cn(
          "shrink text-sm",
          entry.selected ? "font-ryco-bold text-foreground" : "font-ryco-medium text-foreground",
        )}
        numberOfLines={1}
      >
        {entry.label}
      </Text>
      {entry.selected ? (
        <SymbolView name="checkmark" size={14} tintColor={props.checkColor} type="monochrome" />
      ) : null}
    </Pressable>
  );
}

/**
 * One provider instance: its current models, its legacy ones folded under a
 * row that expands in place, and the notice naming the CLI update that unlocks
 * models it can't run yet. The fold state lives here, so every open of the
 * sheet starts collapsed.
 */
function ModelPickerGroupSection(props: {
  readonly group: ModelPickerGroup;
  readonly onSelect: (key: string) => void;
}) {
  const checkColor = useThemeColor("--color-icon") as string;
  const chevronColor = useThemeColor("--color-icon-muted") as string;
  const [legacyExpanded, setLegacyExpanded] = useState(false);
  const { group } = props;
  const legacyCount = group.legacyEntries.length;

  return (
    <View className="gap-1.5">
      <View className="flex-row items-center gap-2 px-1">
        <ProviderIcon provider={group.providerDriver} size={14} />
        <Text className="text-xs font-ryco-bold uppercase tracking-wide text-foreground-tertiary">
          {group.providerLabel}
        </Text>
      </View>
      {group.entries.length > 0 ? (
        <View className="overflow-hidden rounded-2xl bg-subtle">
          {group.entries.map((entry, index) => (
            <ModelPickerRow
              key={entry.key}
              entry={entry}
              divided={index > 0}
              checkColor={checkColor}
              onSelect={props.onSelect}
            />
          ))}
          {legacyCount > 0 ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Legacy models, ${legacyCount} ${
                legacyCount === 1 ? "model" : "models"
              }`}
              accessibilityState={{ expanded: legacyExpanded }}
              onPress={() => setLegacyExpanded((expanded) => !expanded)}
              className="min-h-11 flex-row items-center justify-between gap-3 border-t border-border-subtle px-3.5 py-2.5 active:bg-card-alt"
            >
              <Text className="shrink text-sm font-ryco-medium text-foreground-muted">
                Legacy models · {legacyCount}
              </Text>
              <SymbolView
                name={legacyExpanded ? "chevron.down" : "chevron.right"}
                size={13}
                tintColor={chevronColor}
                type="monochrome"
              />
            </Pressable>
          ) : null}
          {legacyExpanded
            ? group.legacyEntries.map((entry) => (
                <ModelPickerRow
                  key={entry.key}
                  entry={entry}
                  divided
                  checkColor={checkColor}
                  onSelect={props.onSelect}
                />
              ))
            : null}
        </View>
      ) : null}
      {group.updateRequiredNotice ? (
        <Text className="px-1 text-xs leading-snug text-foreground-muted">
          {group.updateRequiredNotice}
        </Text>
      ) : null}
    </View>
  );
}

export function ModelPickerSheet(props: {
  readonly visible: boolean;
  readonly model: ModelPickerModel;
  readonly query: string;
  readonly onChangeQuery: (query: string) => void;
  readonly onClose: () => void;
  readonly onSelect: (key: string) => void;
  readonly onSelectOption: (optionId: string, value: string | boolean) => void;
}) {
  const insets = useSafeAreaInsets();
  const iconColor = useThemeColor("--color-icon");
  const placeholderColor = useThemeColor("--color-placeholder");
  const textColor = useThemeColor("--color-foreground");

  if (!props.visible) return null;

  return (
    <OverlayPortal>
      <Animated.View
        entering={FadeIn.duration(160).reduceMotion(ReduceMotion.System)}
        exiting={FadeOut.duration(140).reduceMotion(ReduceMotion.System)}
        className="absolute inset-0"
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Close model picker"
          onPress={props.onClose}
          className="flex-1 bg-backdrop"
        />
      </Animated.View>
      <Animated.View
        // The panel rises; the scrim only fades. Moving both reads as the whole
        // screen lurching. ReduceMotion.System honours the OS setting, which
        // turns these into a plain cross-fade.
        entering={SlideInDown.duration(260).reduceMotion(ReduceMotion.System)}
        exiting={SlideOutDown.duration(200).reduceMotion(ReduceMotion.System)}
        pointerEvents="box-none"
        className="absolute inset-x-0 bottom-0 px-3"
        style={{ paddingBottom: Math.max(12, insets.bottom) }}
      >
        <GlassSurface radius={28} glassEffectStyle="regular" style={{ padding: 16 }}>
          <View className="mb-3 flex-row items-center justify-between">
            <Text className="text-base font-ryco-bold text-foreground">Model</Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Done"
              onPress={props.onClose}
              className="h-9 w-9 items-center justify-center rounded-full active:bg-subtle-strong"
            >
              <SymbolView
                name="xmark"
                size={15}
                tintColor={iconColor as string}
                type="monochrome"
              />
            </Pressable>
          </View>

          <View className="mb-3 flex-row items-center rounded-2xl bg-sidebar-search px-3">
            <SymbolView
              name="magnifyingglass"
              size={15}
              tintColor={placeholderColor as string}
              type="monochrome"
            />
            <TextInput
              accessibilityLabel="Search models"
              value={props.query}
              onChangeText={props.onChangeQuery}
              placeholder="Search models"
              placeholderTextColor={placeholderColor as string}
              autoCapitalize="none"
              autoCorrect={false}
              className="h-10 flex-1 px-2 font-sans text-sm"
              style={{ color: textColor as string }}
            />
          </View>

          {props.model.lockNotice ? (
            <Text className="mb-2 px-1 text-xs font-ryco-medium text-warning">
              {props.model.lockNotice}
            </Text>
          ) : null}

          <View className="flex-row gap-2">
            <ScrollView
              keyboardShouldPersistTaps="handled"
              showsVerticalScrollIndicator={false}
              contentContainerStyle={{ gap: 14, paddingBottom: 4 }}
              style={{ maxHeight: 380, flex: 1 }}
            >
              {props.model.loading ? (
                <Text className="px-1 py-6 text-center text-sm text-foreground-muted">
                  Loading models from the node…
                </Text>
              ) : (
                <>
                  {/* A search can match no model yet keep a group for its update notice. */}
                  {props.model.groups.length === 0 || props.model.emptyForQuery ? (
                    <Text className="px-1 py-6 text-center text-sm text-foreground-muted">
                      {props.model.emptyForQuery
                        ? "No models match that search."
                        : "This node has no available models."}
                    </Text>
                  ) : null}
                  {props.model.groups.map((group) => (
                    <ModelPickerGroupSection
                      key={group.providerKey}
                      group={group}
                      onSelect={props.onSelect}
                    />
                  ))}
                </>
              )}
            </ScrollView>
            {props.model.hasOptionRail ? (
              <OptionRail options={props.model.options} onSelectOption={props.onSelectOption} />
            ) : null}
          </View>
        </GlassSurface>
      </Animated.View>
    </OverlayPortal>
  );
}
