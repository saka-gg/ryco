import type { StaticScreenProps } from "@react-navigation/native";
import {
  applyUsagePricePatch,
  resolveUsagePriceDrafts,
  savedRowId,
  USAGE_PRICE_FIELDS,
  type UsagePriceDraft,
  type UsagePriceMode,
  type UsagePriceRow,
} from "@ryco/client-runtime/state/settings/usagePrices";
import { EnvironmentId } from "@ryco/contracts/base-schemas";
import type { UsagePriceOverrides } from "@ryco/contracts/settings";
import { useState } from "react";
import { Alert, Pressable, ScrollView, TextInput, View } from "react-native";

import { AppText as Text } from "../../../components/AppText";
import { cn } from "../../../lib/cn";
import { useThemeColor } from "../../../lib/useThemeColor";
import { SettingsRow } from "../components/SettingsRow";
import { SettingsSection } from "../components/SettingsSection";
import { useMachineSettings } from "./useMachineSettings";

type SettingsMachineUsagePricesRouteScreenProps = StaticScreenProps<{
  readonly environmentId: string;
}>;

const NO_OVERRIDES: UsagePriceOverrides = {};

function rowSummary(row: UsagePriceRow): string {
  if (row.form.mode === "map") return `Uses ${row.form.mapTo}`;
  const { inputUsdPerMillion, outputUsdPerMillion } = row.form.prices;
  return `$${inputUsdPerMillion} in · $${outputUsdPerMillion} out`;
}

function RowEditor(props: {
  readonly row: UsagePriceRow;
  readonly draft: UsagePriceDraft;
  readonly error: string | null;
  readonly saving: boolean;
  readonly onChange: (draft: UsagePriceDraft) => void;
  readonly onCancel: () => void;
  readonly onSave: () => void;
}) {
  const { row, draft } = props;
  const placeholder = useThemeColor("--color-placeholder") as string;
  const foreground = useThemeColor("--color-foreground") as string;
  const mode = row.form.mode;
  const input = (
    value: string,
    onChangeText: (value: string) => void,
    hint: string,
    numeric = false,
  ) => (
    <TextInput
      value={value}
      onChangeText={onChangeText}
      placeholder={hint}
      placeholderTextColor={placeholder}
      autoCapitalize="none"
      autoCorrect={false}
      keyboardType={numeric ? "decimal-pad" : "default"}
      className="h-10 rounded-xl bg-subtle px-3 font-sans text-[15px]"
      style={{ color: foreground }}
    />
  );
  return (
    <View className="gap-2.5 border-t border-border-subtle px-4 py-3">
      {row.isNew ? (
        <View className="gap-1">
          <Text className="text-xs text-foreground-muted">Model ID</Text>
          {input(row.model, (model) => props.onChange({ ...draft, model }), "claude-sonnet-5-5")}
        </View>
      ) : (
        <Text className="text-[15px] font-ryco-medium text-foreground">{row.model}</Text>
      )}
      <View className="flex-row rounded-[10px] bg-subtle p-0.5">
        {(["price", "map"] as const satisfies ReadonlyArray<UsagePriceMode>).map((value) => (
          <Pressable
            key={value}
            accessibilityRole="button"
            accessibilityState={{ selected: mode === value }}
            onPress={() => props.onChange({ ...draft, mode: value })}
            className={cn(
              "h-8 flex-1 items-center justify-center rounded-[8px]",
              mode === value && "bg-card",
            )}
          >
            <Text
              className={cn(
                "text-[13px]",
                mode === value ? "font-ryco-bold text-foreground" : "text-foreground-muted",
              )}
            >
              {value === "price" ? "Custom price" : "Use another model's"}
            </Text>
          </Pressable>
        ))}
      </View>
      {mode === "price" ? (
        <View className="flex-row flex-wrap gap-2">
          {USAGE_PRICE_FIELDS.map((field) => (
            <View key={field.key} className="min-w-[45%] flex-1 gap-1">
              <Text className="text-xs text-foreground-muted">
                {`${field.label}${field.optional ? " (optional)" : ""}`}
              </Text>
              {input(
                row.form.prices[field.key],
                (value) =>
                  props.onChange({ ...draft, prices: { ...draft.prices, [field.key]: value } }),
                field.optional ? "= input" : "0.00",
                true,
              )}
            </View>
          ))}
          <Text className="w-full text-[11px] text-foreground-tertiary">
            USD per million tokens. Blank cache prices charge the input price; 0 is free.
          </Text>
        </View>
      ) : (
        <View className="gap-1">
          <Text className="text-xs text-foreground-muted">Priced like</Text>
          {input(
            row.form.mapTo,
            (mapTo) => props.onChange({ ...draft, mapTo }),
            "claude-sonnet-5-5",
          )}
        </View>
      )}
      {props.error ? <Text className="text-xs text-danger-foreground">{props.error}</Text> : null}
      <View className="flex-row justify-end gap-2">
        <Pressable
          accessibilityRole="button"
          onPress={props.onCancel}
          className="h-9 justify-center rounded-full bg-card-alt px-4 active:opacity-70"
        >
          <Text className="text-[14px] font-ryco-bold text-foreground">Cancel</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          disabled={props.error !== null || props.saving}
          onPress={props.onSave}
          className={cn(
            "h-9 justify-center rounded-full bg-primary px-4 active:opacity-70",
            (props.error !== null || props.saving) && "opacity-50",
          )}
        >
          <Text className="text-[14px] font-ryco-bold text-primary-foreground">
            {props.saving ? "Saving…" : "Save"}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

/**
 * The machine's custom usage prices: a price per million tokens for a model the provider does
 * not price, or a model whose price another model ID uses (a preview ID). A shared setting:
 * an edit here is this machine's value. One row is edited at a time and saved on its own.
 */
export function SettingsMachineUsagePricesRouteScreen(
  props: SettingsMachineUsagePricesRouteScreenProps,
) {
  const environmentId = EnvironmentId.make(props.route.params.environmentId);
  const machine = useMachineSettings(environmentId);
  const saved = machine.config?.settings.usagePriceOverrides ?? NO_OVERRIDES;
  const supported = machine.config?.environment.capabilities.usagePriceOverrides === true;
  const [draft, setDraft] = useState<UsagePriceDraft | null>(null);
  const resolved = resolveUsagePriceDrafts(saved, draft ? [draft] : []);
  const off = !machine.editable || !supported;
  const commit = async (patch: Readonly<Record<string, UsagePriceOverrides[string] | null>>) => {
    const ok = await machine.writeShared("usagePriceOverrides", applyUsagePricePatch(saved, patch));
    if (ok) setDraft(null);
  };
  const remove = (model: string) =>
    Alert.alert(`Remove ${model}?`, "Its usage is priced by the provider again.", [
      { text: "Cancel", style: "cancel" },
      { text: "Remove", style: "destructive", onPress: () => void commit({ [model]: null }) },
    ]);
  const editorFor = (row: UsagePriceRow) =>
    draft && draft.id === row.id ? (
      <RowEditor
        key={row.id}
        row={row}
        draft={draft}
        error={resolved.errors.get(row.id) ?? resolved.limitError}
        saving={machine.saving}
        onChange={setDraft}
        onCancel={() => setDraft(null)}
        onSave={() => {
          if (!resolved.blocked) void commit(resolved.patch);
        }}
      />
    ) : null;
  const savedRows = resolved.rows.filter((row) => !row.isNew);
  const newRow = resolved.rows.find((row) => row.isNew);
  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      className="flex-1 bg-screen"
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="on-drag"
      contentContainerStyle={{ paddingTop: 4, paddingBottom: 48 }}
    >
      {!supported && machine.config ? (
        <Text className="px-6 pt-3 text-xs text-foreground-muted">
          Update this machine to set usage prices from here.
        </Text>
      ) : machine.readOnlyReason ? (
        <Text className="px-6 pt-3 text-xs text-foreground-muted">{machine.readOnlyReason}</Text>
      ) : null}
      {machine.error ? (
        <Text className="px-6 pt-3 text-xs text-danger-foreground">{machine.error}</Text>
      ) : null}
      <SettingsSection footer="Used for the cost in Usage. A custom price replaces what the provider reports, at every speed.">
        {savedRows.length === 0 && !newRow ? <SettingsRow first label="No custom prices" /> : null}
        {savedRows.map(
          (row, index) =>
            editorFor(row) ?? (
              <SettingsRow
                key={row.id}
                first={index === 0}
                label={row.model}
                value={rowSummary(row)}
                disabled={off || draft !== null}
                onPress={() =>
                  Alert.alert(row.model, rowSummary(row), [
                    {
                      text: "Edit",
                      onPress: () =>
                        setDraft({ id: savedRowId(row.model), model: row.model, isNew: false }),
                    },
                    { text: "Remove", style: "destructive", onPress: () => remove(row.model) },
                    { text: "Cancel", style: "cancel" },
                  ])
                }
              />
            ),
        )}
        {newRow ? (
          editorFor(newRow)
        ) : (
          <SettingsRow
            icon="plus"
            label="Add a model"
            disabled={off || draft !== null}
            onPress={() => setDraft({ id: "new", model: "", isNew: true, mode: "price" })}
          />
        )}
      </SettingsSection>
    </ScrollView>
  );
}
