import {
  PULL_REQUEST_SORT_OPTIONS,
  PULL_REQUEST_STATE_OPTIONS,
  togglePullRequestLabelFilter,
} from "@ryco/client-runtime/state/pull-request-review";
import type { SourceControlLabel } from "@ryco/contracts";
import { Modal, Pressable, ScrollView, Switch, View } from "react-native";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { cn } from "../../lib/cn";
import { useThemeColor } from "../../lib/useThemeColor";
import { pullRequestLabelColor } from "./pullRequestGlyphModel";
import { countPullRequestTabFilters, type PullRequestTabFilters } from "./pullRequestListModel";

type SheetFilters = Omit<PullRequestTabFilters, "q" | "segment">;

function Group(props: { readonly title: string; readonly children: React.ReactNode }) {
  return (
    <View className="gap-2">
      <Text className="px-1 text-xs font-ryco-bold uppercase tracking-wide text-foreground-muted">
        {props.title}
      </Text>
      <View className="overflow-hidden rounded-2xl bg-card">{props.children}</View>
    </View>
  );
}

function CheckRow(props: {
  readonly label: string;
  readonly selected: boolean;
  readonly first: boolean;
  readonly onPress: () => void;
  readonly dotColor?: string | null;
}) {
  const primary = useThemeColor("--color-primary") as string;
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ selected: props.selected }}
      onPress={props.onPress}
      className={cn(
        "min-h-12 flex-row items-center gap-3 px-4 active:bg-subtle",
        !props.first && "border-t border-border-subtle",
      )}
    >
      {props.dotColor ? (
        <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: props.dotColor }} />
      ) : null}
      <Text className="min-w-0 flex-1 text-base text-foreground" numberOfLines={1}>
        {props.label}
      </Text>
      {props.selected ? <SymbolView name="checkmark" size={15} tintColor={primary} /> : null}
    </Pressable>
  );
}

function ToggleRow(props: {
  readonly label: string;
  readonly detail?: string;
  readonly value: boolean;
  readonly disabled?: boolean;
  readonly first: boolean;
  readonly onChange: (value: boolean) => void;
}) {
  return (
    <View
      className={cn(
        "min-h-12 flex-row items-center gap-3 px-4 py-2",
        !props.first && "border-t border-border-subtle",
        props.disabled && "opacity-40",
      )}
    >
      <View className="min-w-0 flex-1">
        <Text className="text-base text-foreground">{props.label}</Text>
        {props.detail ? (
          <Text className="text-xs text-foreground-muted">{props.detail}</Text>
        ) : null}
      </View>
      <Switch value={props.value} disabled={props.disabled} onValueChange={props.onChange} />
    </View>
  );
}

/**
 * The PRs tab's filters as a sheet: state, sort, two narrowings and the
 * repository's labels. Changes apply as they are made; Reset puts every one
 * back to its default.
 */
export function PullRequestFilterSheet(props: {
  readonly visible: boolean;
  readonly filters: PullRequestTabFilters;
  readonly labels: ReadonlyArray<SourceControlLabel>;
  readonly checkRollup: boolean;
  readonly onChange: (patch: Partial<SheetFilters>) => void;
  readonly onReset: () => void;
  readonly onClose: () => void;
}) {
  const { filters } = props;
  const state = filters.state ?? "open";
  const sort = filters.sort ?? "readiness";
  const selectedLabels = new Set(filters.label ?? []);
  const active = countPullRequestTabFilters(filters);
  return (
    <Modal
      visible={props.visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={props.onClose}
    >
      <View className="flex-1 bg-screen">
        <View className="flex-row items-center gap-3 px-4 pb-2 pt-4">
          <Pressable
            accessibilityRole="button"
            disabled={active === 0}
            onPress={props.onReset}
            className="h-11 min-w-16 justify-center px-1 active:opacity-60 disabled:opacity-30"
          >
            <Text className="text-base text-foreground">Reset</Text>
          </Pressable>
          <Text className="flex-1 text-center text-lg font-ryco-bold text-foreground">Filters</Text>
          <Pressable
            accessibilityRole="button"
            onPress={props.onClose}
            className="h-11 min-w-16 items-end justify-center px-1 active:opacity-60"
          >
            <Text className="text-base font-ryco-bold text-primary">Done</Text>
          </Pressable>
        </View>
        <ScrollView contentContainerStyle={{ padding: 16, gap: 22, paddingBottom: 48 }}>
          <Group title="State">
            {PULL_REQUEST_STATE_OPTIONS.map((option, index) => (
              <CheckRow
                key={option.value}
                label={option.label}
                first={index === 0}
                selected={state === option.value}
                onPress={() =>
                  props.onChange({ state: option.value === "open" ? undefined : option.value })
                }
              />
            ))}
          </Group>
          <Group title="Sort by">
            {PULL_REQUEST_SORT_OPTIONS.map((option, index) => (
              <CheckRow
                key={option.value}
                label={option.label}
                first={index === 0}
                selected={sort === option.value}
                onPress={() =>
                  props.onChange({ sort: option.value === "readiness" ? undefined : option.value })
                }
              />
            ))}
          </Group>
          <Group title="Show">
            <ToggleRow
              first
              label="Failing checks only"
              detail={props.checkRollup ? undefined : "This host does not report checks on lists."}
              disabled={!props.checkRollup}
              value={filters.failingOnly === true}
              onChange={(value) => props.onChange({ failingOnly: value ? true : undefined })}
            />
            <ToggleRow
              first={false}
              label="Hide drafts"
              value={filters.hideDrafts === true}
              onChange={(value) => props.onChange({ hideDrafts: value ? true : undefined })}
            />
          </Group>
          {props.labels.length > 0 ? (
            <Group title="Labels">
              {props.labels.map((label, index) => (
                <CheckRow
                  key={label.name}
                  label={label.name}
                  first={index === 0}
                  dotColor={pullRequestLabelColor(label.color)}
                  selected={selectedLabels.has(label.name)}
                  onPress={() =>
                    props.onChange({
                      label: togglePullRequestLabelFilter(filters.label, label.name),
                    })
                  }
                />
              ))}
            </Group>
          ) : null}
        </ScrollView>
      </View>
    </Modal>
  );
}
