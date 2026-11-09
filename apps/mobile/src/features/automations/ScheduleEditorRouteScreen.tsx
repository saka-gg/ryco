import { MenuView, type MenuAction } from "@react-native-menu/menu";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import {
  definitionFromDraft,
  scheduleDraftKey,
  scheduleDraftMessages,
  scheduleModelLabel,
  validateScheduleDraft,
  type ScheduleDraft,
} from "@ryco/client-runtime/state/agentControl";
import {
  applyDraftFix,
  calendarChoiceOf,
  modelMissing,
  promptCount,
  SAVE_REFUSED,
  sentenceWords,
  withStart,
} from "@ryco/client-runtime/state/automations/editor";
import { AgentControlAutomationId } from "@ryco/contracts/agent-control";
import { EnvironmentId } from "@ryco/contracts/base-schemas";
import type { ProjectId, RuntimeMode } from "@ryco/contracts";
import {
  AUTOMATION_LIMITS,
  endFor,
  INTERVAL_PRESETS,
  UNTIL_PRESETS,
  untilLimit,
  when,
} from "@ryco/shared/automationSchedule";
import { parseWhen, whenQuickPicks } from "@ryco/shared/automationWhenParser";
import * as Haptics from "expo-haptics";
import { useLayoutEffect, useState, type ReactNode } from "react";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  Switch,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { EmptyState } from "../../components/EmptyState";
import { cn } from "../../lib/cn";
import { uuidv4 } from "../../lib/uuid";
import { useThemeColor } from "../../lib/useThemeColor";
import { runtimeModeConfig } from "../threads/sessionPolicyPresentation";
import {
  scheduleEditorOpening,
  scheduleEffortChoices,
  scheduleModelChoices,
  scheduleRepeatOf,
  withCalendarChoice,
  withEffort,
  withModelChoice,
  withRepeat,
  type ScheduleEditorMode,
  type ScheduleEditorOpening,
  type ScheduleRepeat,
} from "./scheduleEditorModel";
import { sendScheduleCommand } from "./scheduledRuntime";
import { useScheduleCheckout, type ScheduleCheckout } from "./useScheduleCheckout";

type ScheduleEditorRouteScreenProps = StaticScreenProps<{
  readonly environmentId: string;
  readonly projectId: string;
  readonly mode: string;
  readonly automationId?: string;
}>;

const RUNTIME_MODES: ReadonlyArray<RuntimeMode> = [
  "approval-required",
  "auto-accept-edits",
  "auto",
  "full-access",
];

function Chip(props: {
  readonly label: string;
  readonly selected: boolean;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: props.selected }}
      onPress={() => {
        void Haptics.selectionAsync();
        props.onPress();
      }}
      className={cn(
        "h-8 justify-center rounded-full px-3",
        props.selected ? "bg-primary" : "bg-subtle active:bg-subtle-strong",
      )}
    >
      <Text
        className={cn(
          "text-[13px] font-ryco-medium",
          props.selected ? "text-primary-foreground" : "text-foreground",
        )}
      >
        {props.label}
      </Text>
    </Pressable>
  );
}

function Segmented<T extends string>(props: {
  readonly value: T;
  readonly options: ReadonlyArray<{ readonly value: T; readonly label: string }>;
  readonly onChange: (value: T) => void;
}) {
  return (
    <View className="flex-row rounded-[10px] bg-subtle p-0.5">
      {props.options.map((option) => {
        const selected = option.value === props.value;
        return (
          <Pressable
            key={option.value}
            accessibilityRole="button"
            accessibilityState={{ selected }}
            onPress={() => {
              void Haptics.selectionAsync();
              props.onChange(option.value);
            }}
            className={cn(
              "h-8 flex-1 items-center justify-center rounded-[8px]",
              selected && "bg-card",
            )}
          >
            <Text
              className={cn(
                "text-[13px]",
                selected
                  ? "font-ryco-bold text-foreground"
                  : "font-ryco-medium text-foreground-muted",
              )}
            >
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function Card(props: { readonly title?: string; readonly children: ReactNode }) {
  return (
    <View className="mt-5 gap-2 px-4">
      {props.title ? (
        <Text className="px-2 text-[13px] font-ryco-medium text-foreground-muted">
          {props.title}
        </Text>
      ) : null}
      <View className="overflow-hidden rounded-[22px] bg-card">{props.children}</View>
    </View>
  );
}

/** A row that opens a native menu of choices. */
function MenuRow(props: {
  readonly label: string;
  readonly value: string;
  readonly first?: boolean;
  readonly actions: MenuAction[];
  readonly onPick: (id: string) => void;
  readonly invalid?: boolean;
}) {
  const chevron = useThemeColor("--color-icon-subtle") as string;
  return (
    <MenuView
      actions={props.actions}
      shouldOpenOnLongPress={false}
      onPressAction={({ nativeEvent }) => {
        void Haptics.selectionAsync();
        props.onPick(nativeEvent.event);
      }}
    >
      <View
        accessible
        accessibilityRole="button"
        accessibilityLabel={`${props.label}: ${props.value}`}
        className={cn(
          "min-h-[50px] flex-row items-center gap-3 px-4 py-3",
          !props.first && "border-t border-border-subtle",
        )}
      >
        <Text className="text-[16px] text-foreground">{props.label}</Text>
        <Text
          className={cn(
            "flex-1 text-right text-[15px]",
            props.invalid ? "text-danger-foreground" : "text-foreground-muted",
          )}
          numberOfLines={1}
        >
          {props.value}
        </Text>
        <SymbolView name="chevron.up.chevron.down" size={12} tintColor={chevron} />
      </View>
    </MenuView>
  );
}

function StartPicker(props: {
  readonly draft: ScheduleDraft;
  readonly nowMs: number;
  readonly onChange: (startMs: number) => void;
}) {
  const [text, setText] = useState("");
  const placeholder = useThemeColor("--color-placeholder") as string;
  const foreground = useThemeColor("--color-foreground") as string;
  const parsed = text.trim() ? parseWhen(text, props.nowMs) : null;
  const apply = () => {
    if (parsed?.ok) {
      props.onChange(parsed.ms);
      setText("");
    }
  };
  return (
    <View className="gap-2.5 border-t border-border-subtle px-4 py-3">
      <View className="flex-row flex-wrap gap-2">
        {whenQuickPicks(props.nowMs).map((pick) => (
          <Chip
            key={pick.label}
            label={pick.label}
            selected={props.draft.start === pick.ms}
            onPress={() => props.onChange(pick.ms)}
          />
        ))}
      </View>
      <View className="h-10 flex-row items-center gap-2 rounded-xl bg-subtle px-3">
        <SymbolView name="text.cursor" size={13} tintColor={placeholder} />
        <TextInput
          value={text}
          onChangeText={setText}
          onSubmitEditing={apply}
          placeholder="Or type: fri 17:30, in 2h, oct 20 9am"
          placeholderTextColor={placeholder}
          returnKeyType="done"
          autoCorrect={false}
          autoCapitalize="none"
          className="h-10 flex-1 font-sans text-[15px]"
          style={{ color: foreground }}
        />
      </View>
      {parsed ? (
        <Pressable
          accessibilityRole="button"
          disabled={!parsed.ok}
          onPress={apply}
          className="active:opacity-60"
        >
          <Text className={cn("text-[13px]", parsed.ok ? "text-primary" : "text-foreground-muted")}>
            {parsed.ok ? `Use ${parsed.label} (${parsed.rel})` : parsed.error}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

function Editor(props: {
  readonly checkout: ScheduleCheckout;
  readonly opening: ScheduleEditorOpening;
}) {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const { checkout } = props;
  const [draft, setDraft] = useState(props.opening.draft);
  const [attempted, setAttempted] = useState(false);
  const [titleTouched, setTitleTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  const [editing, setEditing] = useState<"start" | null>(null);
  const placeholder = useThemeColor("--color-placeholder") as string;
  const foreground = useThemeColor("--color-foreground") as string;
  const primary = useThemeColor("--color-primary") as string;
  const nowMs = checkout.nowMs;
  const providers = checkout.providers;
  const change = (next: ScheduleDraft) => {
    setDraft(next);
    setRefused(null);
  };
  const validation = validateScheduleDraft(draft, {
    nowMs: Date.now(),
    snapshot: checkout.snapshot,
    ...(providers.length ? { providers } : {}),
    projectName: checkout.projectName,
  });
  const messages = scheduleDraftMessages(draft, validation.errors, {
    nowMs,
    attempted,
    titleTouched,
  });
  const words = sentenceWords(draft, nowMs);
  const repeat = scheduleRepeatOf(draft);
  const calendarChoice = calendarChoiceOf(draft);
  const modelChoices = scheduleModelChoices(providers, draft.modelSelection);
  const effort = scheduleEffortChoices(providers, draft.modelSelection);
  const dirty =
    props.opening.initialKey === "" || scheduleDraftKey(draft) !== props.opening.initialKey;
  const heartbeat = draft.target !== null;
  const otherErrors = [
    validation.errors.prompt,
    validation.errors.model,
    validation.errors.limit,
  ].filter((message): message is string => typeof message === "string" && message.length > 0);

  const save = async () => {
    if (saving || !checkout.editable) return;
    const current = validateScheduleDraft(draft, {
      nowMs: Date.now(),
      snapshot: checkout.snapshot,
      ...(providers.length ? { providers } : {}),
      projectName: checkout.projectName,
    });
    if (!current.ok) {
      setAttempted(true);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      return;
    }
    if (!dirty && !props.opening.isNew) {
      Alert.alert("Nothing changed", "Nothing was proposed.");
      return;
    }
    const automationId = draft.id ?? AgentControlAutomationId.make(uuidv4());
    const expectedRevision =
      (draft.id &&
        checkout.snapshot?.automations.find((automation) => automation.automationId === draft.id)
          ?.revision) ||
      null;
    setSaving(true);
    const result = await sendScheduleCommand(checkout.environmentId, {
      kind: "save",
      projectId: draft.projectId,
      automationId,
      expectedRevision,
      definition: definitionFromDraft(draft),
    });
    setSaving(false);
    if (!result.ok) {
      setRefused(result.error || SAVE_REFUSED);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      return;
    }
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    navigation.goBack();
  };

  useLayoutEffect(() => {
    navigation.setOptions({
      title: props.opening.isNew ? "New schedule" : "Edit schedule",
      headerRight: () =>
        saving ? (
          <ActivityIndicator color={primary} />
        ) : (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Save for approval"
            hitSlop={8}
            disabled={!checkout.editable}
            onPress={() => void save()}
            className="px-1 active:opacity-60"
          >
            <Text
              className={cn(
                "text-[16px] font-ryco-bold",
                checkout.editable ? "text-primary" : "text-foreground-muted",
              )}
            >
              Save
            </Text>
          </Pressable>
        ),
    });
  });

  const messageFor = (key: "start" | "interval" | "end" | "title") =>
    messages.find((message) => message.key === key) ?? null;
  const messageView = (key: "start" | "interval" | "end" | "title") => {
    const message = messageFor(key);
    if (!message) return null;
    return (
      <View className="flex-row flex-wrap items-center gap-x-2 gap-y-1 border-t border-border-subtle px-4 py-2.5">
        <Text className="text-[13px] text-danger-foreground">{message.text}</Text>
        {message.fix ? (
          <Pressable
            accessibilityRole="button"
            onPress={() => {
              const fix = message.fix;
              if (fix) change(applyDraftFix(draft, message.key, fix.value));
            }}
            className="active:opacity-60"
          >
            <Text className="text-[13px] font-ryco-medium text-primary">{message.fix.label}</Text>
          </Pressable>
        ) : null}
      </View>
    );
  };
  const modelActions: MenuAction[] = modelChoices.map((provider) => ({
    id: `p:${provider.instanceId}`,
    title: provider.title,
    subactions: provider.models.map((model) => ({
      id: model.id,
      title: model.title,
      state: model.selected ? ("on" as const) : ("off" as const),
    })),
  }));
  const endPresetSelected = (ms: number) =>
    Math.abs(draft.endsAt - endFor(draft.start, ms)) < 60_000;
  const maxEnd = untilLimit(nowMs);

  return (
    <ScrollView
      className="flex-1 bg-sheet"
      keyboardDismissMode="on-drag"
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={{ paddingBottom: insets.bottom + 32 }}
    >
      <Card>
        <TextInput
          value={draft.title}
          onChangeText={(title) => change({ ...draft, title })}
          onBlur={() => setTitleTouched(true)}
          placeholder="Name"
          placeholderTextColor={placeholder}
          maxLength={200}
          className="min-h-[50px] px-4 py-3 font-ryco-medium text-[17px]"
          style={{ color: foreground }}
        />
        {messageView("title")}
        <TextInput
          value={draft.prompt}
          onChangeText={(prompt) => change({ ...draft, prompt })}
          placeholder="What should the agent do on each run?"
          placeholderTextColor={placeholder}
          multiline
          textAlignVertical="top"
          className="min-h-[120px] border-t border-border-subtle px-4 py-3 font-sans text-[16px] leading-[22px]"
          style={{ color: foreground }}
        />
        {draft.prompt.length > 0 ? (
          <Text className="px-4 pb-2 text-right text-[11px] text-foreground-tertiary">
            {promptCount(draft.prompt.length, AUTOMATION_LIMITS.promptMax)}
          </Text>
        ) : null}
      </Card>

      <Card title="When">
        <View className="px-4 py-3">
          <Segmented<ScheduleRepeat>
            value={repeat}
            options={[
              { value: "interval", label: "Repeat" },
              { value: "days", label: "Days" },
              { value: "once", label: "Once" },
            ]}
            onChange={(next) => change(withRepeat(draft, next))}
          />
        </View>
        {repeat === "interval" ? (
          <View className="flex-row flex-wrap gap-2 px-4 pb-3">
            {INTERVAL_PRESETS.map((preset) => (
              <Chip
                key={preset.label}
                label={preset.label}
                selected={draft.intervalMs === preset.ms}
                onPress={() => change({ ...draft, intervalMs: preset.ms })}
              />
            ))}
          </View>
        ) : null}
        {repeat === "days" ? (
          <View className="flex-row flex-wrap gap-2 px-4 pb-3">
            {(["daily", "weekdays", "weekly"] as const).map((choice) => (
              <Chip
                key={choice}
                label={
                  choice === "daily"
                    ? "Every day"
                    : choice === "weekdays"
                      ? "Weekdays"
                      : "Once a week"
                }
                selected={calendarChoice === choice}
                onPress={() => change(withCalendarChoice(draft, choice))}
              />
            ))}
          </View>
        ) : null}
        {messageView("interval")}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={words.startLabel}
          onPress={() => setEditing(editing === "start" ? null : "start")}
          className="min-h-[50px] flex-row items-center gap-3 border-t border-border-subtle px-4 py-3 active:bg-subtle"
        >
          <Text className="text-[16px] text-foreground">
            {repeat === "once" ? "Runs at" : repeat === "days" ? "Time and first day" : "First run"}
          </Text>
          <Text className="flex-1 text-right text-[15px] text-foreground-muted" numberOfLines={1}>
            {words.start}
          </Text>
        </Pressable>
        {editing === "start" ? (
          <StartPicker
            draft={draft}
            nowMs={nowMs}
            onChange={(startMs) => change(withStart(draft, startMs))}
          />
        ) : null}
        {messageView("start")}
        {repeat !== "once" ? (
          <View className="gap-2 border-t border-border-subtle px-4 py-3">
            <Text className="text-[13px] text-foreground-muted">{`Ends · ${words.endWord} ${words.end}`}</Text>
            <View className="flex-row flex-wrap gap-2">
              {UNTIL_PRESETS.map((preset) => (
                <Chip
                  key={preset.label}
                  label={preset.label}
                  selected={endPresetSelected(preset.ms)}
                  onPress={() => change({ ...draft, endsAt: endFor(draft.start, preset.ms) })}
                />
              ))}
              <Chip
                label="90 days"
                selected={Math.abs(draft.endsAt - maxEnd) < 60_000}
                onPress={() => change({ ...draft, endsAt: maxEnd })}
              />
            </View>
          </View>
        ) : null}
        {messageView("end")}
      </Card>
      <Text className="px-6 pt-2 text-[13px] leading-[18px] text-foreground-muted">
        {repeat === "once"
          ? `Once, ${words.start}.`
          : `Every ${words.interval}, from ${words.start} ${words.endWord} ${words.end}.`}
      </Text>

      <Card title="Each run">
        <MenuRow
          first
          label="Model"
          value={
            modelMissing(draft.modelSelection)
              ? "Pick a model"
              : scheduleModelLabel(draft.modelSelection, providers)
          }
          invalid={attempted && !!validation.errors.model}
          actions={modelActions}
          onPick={(id) => change(withModelChoice(draft, providers, id))}
        />
        {effort ? (
          <MenuRow
            label={effort.label}
            value={effort.choices.find((choice) => choice.selected)?.title ?? "Default"}
            actions={effort.choices.map((choice) => ({
              id: choice.id,
              title: choice.title,
              state: choice.selected ? ("on" as const) : ("off" as const),
            }))}
            onPick={(id) => change(withEffort(draft, effort.descriptorId, id))}
          />
        ) : null}
        <MenuRow
          label="Permissions"
          value={runtimeModeConfig[draft.runtimeMode].label}
          actions={RUNTIME_MODES.map((mode) => ({
            id: mode,
            title: runtimeModeConfig[mode].label,
            subtitle: runtimeModeConfig[mode].description,
            state: draft.runtimeMode === mode ? ("on" as const) : ("off" as const),
          }))}
          onPick={(id) => change({ ...draft, runtimeMode: id as RuntimeMode })}
        />
        {heartbeat ? (
          <View className="min-h-[50px] flex-row items-center border-t border-border-subtle px-4 py-3">
            <Text className="flex-1 text-[16px] text-foreground">Runs in</Text>
            <Text className="text-[15px] text-foreground-muted">{words.env}</Text>
          </View>
        ) : (
          <MenuRow
            label="Runs in"
            value={words.env}
            actions={[
              {
                id: "worktree",
                title: "A new worktree",
                state: draft.envMode === "worktree" ? "on" : "off",
              },
              {
                id: "local",
                title: "The main checkout",
                state: draft.envMode === "local" ? "on" : "off",
              },
            ]}
            onPick={(id) => change({ ...draft, envMode: id === "local" ? "local" : "worktree" })}
          />
        )}
        {!heartbeat && draft.envMode === "worktree" ? (
          <Pressable
            accessibilityRole="button"
            onPress={() =>
              Alert.prompt(
                "Branch",
                "The branch each run's worktree starts from. Leave it empty for the project's default branch.",
                (text) => change({ ...draft, baseRef: text.trim() }),
                "plain-text",
                draft.baseRef,
              )
            }
            className="min-h-[50px] flex-row items-center gap-3 border-t border-border-subtle px-4 py-3 active:bg-subtle"
          >
            <Text className="text-[16px] text-foreground">Branch</Text>
            <Text className="flex-1 text-right text-[15px] text-foreground-muted" numberOfLines={1}>
              {draft.baseRef.trim() || "Default branch"}
            </Text>
          </Pressable>
        ) : null}
        {checkout.snapshot?.runWithoutAsking ? (
          <View className="min-h-[50px] flex-row items-center gap-3 border-t border-border-subtle px-4 py-2.5">
            <View className="flex-1 gap-0.5">
              <Text className="text-[16px] text-foreground">Run without asking</Text>
              <Text className="text-xs text-foreground-muted">
                Each run starts on its own instead of waiting for your approval.
              </Text>
            </View>
            <Switch
              value={draft.runWithoutAsking}
              onValueChange={(runWithoutAsking) => change({ ...draft, runWithoutAsking })}
            />
          </View>
        ) : null}
      </Card>

      {(attempted ? otherErrors : validation.errors.limit ? [validation.errors.limit] : []).map(
        (message) => (
          <Text key={message} className="px-6 pt-2 text-[13px] text-danger-foreground">
            {message}
          </Text>
        ),
      )}
      {refused ? (
        <Text className="px-6 pt-2 text-[13px] text-danger-foreground">{refused}</Text>
      ) : null}
      <Text className="px-6 pt-3 text-[13px] text-foreground-muted">
        {checkout.readOnlyReason !== null
          ? checkout.readOnlyReason
          : `${props.opening.isNew ? "Nothing runs" : "Nothing changes"} until you approve it. Saving proposes it to ${checkout.machineLabel}.`}
      </Text>
      <Text className="px-6 pt-1 text-[12px] text-foreground-tertiary">
        {`${checkout.projectName} · next run ${when(draft.start, nowMs)}`}
      </Text>
    </ScrollView>
  );
}

/**
 * The schedule editor, as a sheet: a new schedule, a change to one, or an expired proposal
 * proposed again. Saving proposes it to the machine, where it waits for approval like a
 * change made on the desktop.
 */
export function ScheduleEditorRouteScreen(props: ScheduleEditorRouteScreenProps) {
  const params = props.route.params;
  const environmentId = EnvironmentId.make(params.environmentId);
  const projectId = params.projectId as ProjectId;
  const mode: ScheduleEditorMode =
    params.mode === "edit" || params.mode === "repropose" ? params.mode : "new";
  const checkout = useScheduleCheckout(environmentId, projectId);
  const row = params.automationId
    ? (checkout.rows.find((item) => item.row.id === params.automationId)?.row ?? null)
    : null;
  // The draft starts once, from what is known when the schedule (and the models) arrive.
  const [opening, setOpening] = useState<ScheduleEditorOpening | null>(null);
  const ready =
    checkout.status !== "loading" &&
    (mode === "new" ? checkout.providers.length > 0 || checkout.snapshot !== null : row !== null);
  if (opening === null && ready) {
    const next = scheduleEditorOpening({
      mode,
      projectId,
      row,
      providers: checkout.providers,
      nowMs: Date.now(),
    });
    if (next) setOpening(next);
  }
  if (!opening) {
    return (
      <View className="flex-1 bg-sheet px-6 pt-16">
        <EmptyState
          variant="plain"
          title={checkout.status === "unavailable" ? "Schedules unavailable" : "Loading…"}
          detail={
            checkout.status === "unavailable"
              ? "This machine's schedules could not be read. Reconnect and try again."
              : ""
          }
        />
      </View>
    );
  }
  return <Editor checkout={checkout} opening={opening} />;
}
