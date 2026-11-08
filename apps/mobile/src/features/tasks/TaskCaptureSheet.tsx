import { MenuView, type NativeActionEvent } from "@react-native-menu/menu";
import {
  dueLabel,
  dueQuickPicks,
  dueAtForDay,
  parseTaskQuickAdd,
  splitPastedTaskLines,
} from "@ryco/client-runtime/state/tasks";
import type { ProjectId } from "@ryco/contracts";
import { LOCAL_TASK_TITLE_MAX_LENGTH } from "@ryco/contracts/local-tasks";
import * as Haptics from "expo-haptics";
import { useRef, useState } from "react";
import { KeyboardAvoidingView, Modal, Pressable, TextInput, View } from "react-native";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { cn } from "../../lib/cn";
import { useThemeColor } from "../../lib/useThemeColor";
import { TASK_PRIORITY_LABELS, type TaskPriority } from "./tasksListModel";

export interface TaskCaptureInput {
  readonly title: string;
  readonly projectId: ProjectId | null;
  readonly dueAt: string | null;
  readonly priority: TaskPriority;
}

export interface TaskCaptureProject {
  readonly projectId: ProjectId;
  readonly name: string;
}

const PRIORITIES: ReadonlyArray<TaskPriority> = ["urgent", "high", "normal", "low"];

function CaptureChip(props: {
  readonly symbol: string;
  readonly label: string;
  readonly active: boolean;
}) {
  const icon = useThemeColor(props.active ? "--color-foreground" : "--color-icon-muted") as string;
  return (
    <View
      className={cn(
        "h-8 flex-row items-center gap-1.5 rounded-full px-3",
        props.active ? "bg-subtle-strong" : "bg-subtle",
      )}
    >
      <SymbolView name={props.symbol as never} size={12} tintColor={icon} />
      <Text
        className={cn(
          "text-[13px]",
          props.active ? "font-ryco-bold text-foreground" : "text-foreground-muted",
        )}
        numberOfLines={1}
      >
        {props.label}
      </Text>
    </View>
  );
}

/**
 * Fast capture: the title first, with the keyboard up at once. `#project` and
 * `@fri` / `due:tomorrow` in the text file the task (the web add row's
 * shorthand), or the chips below set them. Return adds the task and keeps the
 * field open for the next one; a pasted list adds one task per line.
 */
export function TaskCaptureSheet(props: {
  readonly visible: boolean;
  readonly projects: ReadonlyArray<TaskCaptureProject>;
  /** The project the list is filtered to: new tasks go there unless told otherwise. */
  readonly defaultProjectId: ProjectId | null;
  readonly onAdd: (inputs: ReadonlyArray<TaskCaptureInput>) => void;
  readonly onClose: () => void;
}) {
  const inputRef = useRef<TextInput>(null);
  const [text, setText] = useState("");
  const [projectId, setProjectId] = useState<ProjectId | null>(props.defaultProjectId);
  const [dueAt, setDueAt] = useState<string | null>(null);
  const [priority, setPriority] = useState<TaskPriority>("normal");
  const [added, setAdded] = useState(0);
  const placeholder = useThemeColor("--color-placeholder") as string;
  const foreground = useThemeColor("--color-foreground") as string;
  const primary = useThemeColor("--color-primary") as string;
  const primaryForeground = useThemeColor("--color-primary-foreground") as string;
  const nowMs = Date.now();

  const parsed = parseTaskQuickAdd(text, props.projects, nowMs);
  const effectiveProjectId = parsed.projectId ?? projectId;
  const effectiveDueAt = parsed.dueAt ?? dueAt;
  const projectName =
    props.projects.find((project) => project.projectId === effectiveProjectId)?.name ?? null;
  const canAdd = parsed.title.length > 0;

  const reset = () => {
    setText("");
    setDueAt(null);
    setPriority("normal");
    setAdded(0);
    setProjectId(props.defaultProjectId);
  };
  const close = () => {
    reset();
    props.onClose();
  };
  const add = () => {
    const lines = splitPastedTaskLines(text);
    const inputs: TaskCaptureInput[] = (lines.length > 1 ? lines : [text]).flatMap((line) => {
      const item = parseTaskQuickAdd(line, props.projects, nowMs);
      const title = item.title.slice(0, LOCAL_TASK_TITLE_MAX_LENGTH).trim();
      return title.length === 0
        ? []
        : [
            {
              title,
              projectId: item.projectId ?? projectId,
              dueAt: item.dueAt ?? dueAt,
              priority,
            },
          ];
    });
    if (inputs.length === 0) return;
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    props.onAdd(inputs);
    setAdded((count) => count + inputs.length);
    setText("");
    inputRef.current?.clear();
    inputRef.current?.focus();
  };

  const dueActions = [
    // Keyed by label: on a Sunday, Tomorrow and Next week are the same day.
    ...dueQuickPicks(nowMs).map((pick) => ({
      id: pick.label,
      title: pick.label,
      state: effectiveDueAt === dueAtForDay(pick.dayMs) ? ("on" as const) : ("off" as const),
    })),
    { id: "none", title: "No date", attributes: { destructive: false } },
  ];
  const onDue = (event: NativeActionEvent) => {
    const id = event.nativeEvent.event;
    const pick = dueQuickPicks(Date.now()).find((quick) => quick.label === id);
    setDueAt(pick ? dueAtForDay(pick.dayMs) : null);
  };
  const projectActions = [
    { id: "none", title: "No project", state: effectiveProjectId === null ? "on" : "off" },
    ...props.projects.map((project) => ({
      id: project.projectId,
      title: project.name,
      state: project.projectId === effectiveProjectId ? "on" : "off",
    })),
  ] as const;
  const priorityActions = PRIORITIES.map((value) => ({
    id: value,
    title: TASK_PRIORITY_LABELS[value],
    state: value === priority ? ("on" as const) : ("off" as const),
  }));

  return (
    <Modal
      visible={props.visible}
      transparent
      animationType="fade"
      onShow={() => setProjectId(props.defaultProjectId)}
      onRequestClose={close}
    >
      <KeyboardAvoidingView behavior="padding" className="flex-1 justify-end">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Close"
          onPress={close}
          className="absolute inset-0 bg-backdrop"
        />
        <View
          className="mx-2 gap-3 rounded-[26px] border border-border bg-card px-4 pb-3 pt-4"
          style={{ marginBottom: 8 }}
        >
          <View className="flex-row items-center gap-3">
            <View className="h-[22px] w-[22px] rounded-full border-[1.75px] border-foreground-tertiary" />
            <TextInput
              ref={inputRef}
              autoFocus
              // Uncontrolled: fast typing never races a re-render; Add clears it through the ref.
              onChangeText={setText}
              placeholder={added > 0 ? "Another task" : "New task"}
              placeholderTextColor={placeholder}
              returnKeyType="done"
              submitBehavior="submit"
              onSubmitEditing={add}
              maxLength={LOCAL_TASK_TITLE_MAX_LENGTH * 4}
              accessibilityLabel="Task title"
              accessibilityHint="Type #project or @friday to file it"
              className="min-h-10 flex-1 font-sans text-[17px]"
              style={{ color: foreground }}
            />
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Add task"
              accessibilityState={{ disabled: !canAdd }}
              disabled={!canAdd}
              onPress={add}
              className={cn(
                "h-9 w-9 items-center justify-center rounded-full",
                !canAdd && "opacity-30",
              )}
              style={{ backgroundColor: primary }}
            >
              <SymbolView name="arrow.up" size={15} weight="bold" tintColor={primaryForeground} />
            </Pressable>
          </View>
          <View className="flex-row flex-wrap gap-2">
            <MenuView title="Due" actions={dueActions} onPressAction={onDue}>
              <CaptureChip
                symbol="calendar"
                label={effectiveDueAt === null ? "Due" : (dueLabel(effectiveDueAt, nowMs) ?? "Due")}
                active={effectiveDueAt !== null}
              />
            </MenuView>
            {props.projects.length > 0 ? (
              <MenuView
                title="Project"
                actions={projectActions as never}
                onPressAction={(event: NativeActionEvent) => {
                  const id = event.nativeEvent.event;
                  setProjectId(id === "none" ? null : (id as ProjectId));
                }}
              >
                <CaptureChip
                  symbol="folder"
                  label={projectName ?? "Project"}
                  active={projectName !== null}
                />
              </MenuView>
            ) : null}
            <MenuView
              title="Priority"
              actions={priorityActions}
              onPressAction={(event: NativeActionEvent) =>
                setPriority(event.nativeEvent.event as TaskPriority)
              }
            >
              <CaptureChip
                symbol="flag"
                label={priority === "normal" ? "Priority" : TASK_PRIORITY_LABELS[priority]}
                active={priority !== "normal"}
              />
            </MenuView>
          </View>
          {added > 0 ? (
            <Text className="text-xs text-foreground-tertiary">
              {added === 1 ? "1 task added" : `${added} tasks added`}
            </Text>
          ) : null}
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}
