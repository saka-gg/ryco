import { MenuView, type MenuAction, type NativeActionEvent } from "@react-native-menu/menu";
import {
  dueAtForDay,
  dueLabel,
  dueQuickPicks,
  parseTaskQuickAdd,
  splitPastedTaskLines,
} from "@ryco/client-runtime/state/tasks";
import type { EnvironmentId, LocalTaskLink, ProjectId } from "@ryco/contracts";
import { LOCAL_TASK_TITLE_MAX_LENGTH } from "@ryco/contracts/local-tasks";
import * as Haptics from "expo-haptics";
import { useRef, useState } from "react";
import { KeyboardAvoidingView, Modal, Pressable, TextInput, View } from "react-native";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { cn } from "../../lib/cn";
import { useThemeColor } from "../../lib/useThemeColor";
import { TASK_PRIORITY_LABELS, type TaskPriority } from "./tasksListModel";
import type { TaskMachine } from "./tasksMachinesModel";

export interface TaskCaptureInput {
  readonly title: string;
  readonly projectId: ProjectId | null;
  readonly dueAt: string | null;
  readonly priority: TaskPriority;
  /** Links the task starts with (the chat or pull request it was made from). */
  readonly links: ReadonlyArray<LocalTaskLink>;
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
        "h-8 max-w-56 flex-row items-center gap-1.5 rounded-full px-3",
        props.active ? "bg-subtle-strong" : "bg-subtle",
      )}
    >
      <SymbolView name={props.symbol as never} size={12} tintColor={icon} />
      <Text
        className={cn(
          "shrink text-[13px]",
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
 * shorthand), or the chips below set them, including which machine it goes
 * to. Return adds the task and keeps the field open for the next one; a pasted
 * list adds one task per line. Details adds it and opens its sheet for notes,
 * links and files.
 */
export function TaskCaptureSheet(props: {
  /** Machines that can take a new task (reachable ones). */
  readonly machines: ReadonlyArray<TaskMachine>;
  readonly environmentId: EnvironmentId;
  readonly onMachineChange: (environmentId: EnvironmentId) => void;
  /** The chosen machine's projects. */
  readonly projects: ReadonlyArray<TaskCaptureProject>;
  readonly projectId: ProjectId | null;
  readonly onProjectChange: (projectId: ProjectId | null) => void;
  /** A link every task added here starts with, and how it reads. */
  readonly link: { readonly link: LocalTaskLink; readonly label: string } | null;
  readonly onRemoveLink: () => void;
  readonly onAdd: (
    inputs: ReadonlyArray<TaskCaptureInput>,
    options: { readonly openDetails: boolean },
  ) => void;
  readonly onClose: () => void;
}) {
  const inputRef = useRef<TextInput>(null);
  const closingRef = useRef(false);
  const [text, setText] = useState("");
  const [dueAt, setDueAt] = useState<string | null>(null);
  const [priority, setPriority] = useState<TaskPriority>("normal");
  const [added, setAdded] = useState(0);
  const placeholder = useThemeColor("--color-placeholder") as string;
  const foreground = useThemeColor("--color-foreground") as string;
  const primary = useThemeColor("--color-primary") as string;
  const primaryForeground = useThemeColor("--color-primary-foreground") as string;
  const linkIcon = useThemeColor("--color-icon-muted") as string;
  const nowMs = Date.now();

  const parsed = parseTaskQuickAdd(text, props.projects, nowMs);
  const effectiveProjectId = parsed.projectId ?? props.projectId;
  const effectiveDueAt = parsed.dueAt ?? dueAt;
  const projectName =
    props.projects.find((project) => project.projectId === effectiveProjectId)?.name ?? null;
  const machine = props.machines.find(
    (candidate) => candidate.environmentId === props.environmentId,
  );
  const canAdd = parsed.title.length > 0;

  const add = (openDetails: boolean) => {
    // Details closes the sheet: a second tap (or Return) before it is gone adds nothing more.
    if (closingRef.current) return;
    const lines = openDetails ? [] : splitPastedTaskLines(text);
    const links = props.link ? [props.link.link] : [];
    const inputs: TaskCaptureInput[] = (lines.length > 1 ? lines : [text]).flatMap((line) => {
      const item = parseTaskQuickAdd(line, props.projects, nowMs);
      const title = item.title.slice(0, LOCAL_TASK_TITLE_MAX_LENGTH).trim();
      return title.length === 0
        ? []
        : [
            {
              title,
              projectId: item.projectId ?? props.projectId,
              dueAt: item.dueAt ?? dueAt,
              priority,
              links,
            },
          ];
    });
    if (inputs.length === 0) return;
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    if (openDetails) closingRef.current = true;
    props.onAdd(inputs, { openDetails });
    if (openDetails) return;
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
    { id: "none", title: "No date" },
  ];
  const onDue = (event: NativeActionEvent) => {
    const pick = dueQuickPicks(Date.now()).find((quick) => quick.label === event.nativeEvent.event);
    setDueAt(pick ? dueAtForDay(pick.dayMs) : null);
  };
  const projectActions: MenuAction[] = [
    { id: "", title: "No project", state: effectiveProjectId === null ? "on" : "off" },
    ...props.projects.map((project) => ({
      id: project.projectId,
      title: project.name,
      state: project.projectId === effectiveProjectId ? ("on" as const) : ("off" as const),
    })),
  ];
  const machineActions: MenuAction[] = props.machines.map((candidate) => ({
    id: candidate.environmentId,
    title: candidate.label,
    state: candidate.environmentId === props.environmentId ? "on" : "off",
  }));
  const priorityActions = PRIORITIES.map((value) => ({
    id: value,
    title: TASK_PRIORITY_LABELS[value],
    state: value === priority ? ("on" as const) : ("off" as const),
  }));

  return (
    <Modal visible transparent animationType="fade" onRequestClose={props.onClose}>
      <KeyboardAvoidingView behavior="padding" className="flex-1 justify-end">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Close"
          onPress={props.onClose}
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
              onSubmitEditing={() => add(false)}
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
              onPress={() => add(false)}
              className={cn(
                "h-9 w-9 items-center justify-center rounded-full",
                !canAdd && "opacity-30",
              )}
              style={{ backgroundColor: primary }}
            >
              <SymbolView name="arrow.up" size={15} weight="bold" tintColor={primaryForeground} />
            </Pressable>
          </View>
          {props.link ? (
            <View className="flex-row items-center gap-2 rounded-xl bg-subtle px-3 py-2">
              <SymbolView
                name={props.link.link.kind === "thread" ? "bubble.left" : "arrow.triangle.pull"}
                size={12}
                tintColor={linkIcon}
              />
              <Text className="min-w-0 flex-1 text-[13px] text-foreground-muted" numberOfLines={1}>
                {props.link.label}
              </Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Don't link it"
                hitSlop={10}
                onPress={props.onRemoveLink}
              >
                <SymbolView name="xmark" size={10} weight="semibold" tintColor={linkIcon} />
              </Pressable>
            </View>
          ) : null}
          <View className="flex-row flex-wrap items-center gap-2">
            {props.machines.length > 1 ? (
              <MenuView
                title="Machine"
                actions={machineActions}
                onPressAction={(event: NativeActionEvent) =>
                  props.onMachineChange(event.nativeEvent.event as EnvironmentId)
                }
              >
                <CaptureChip symbol="laptopcomputer" label={machine?.label ?? "Machine"} active />
              </MenuView>
            ) : null}
            {props.projects.length > 0 ? (
              <MenuView
                title="Project"
                actions={projectActions}
                onPressAction={(event: NativeActionEvent) => {
                  const id = event.nativeEvent.event;
                  props.onProjectChange(id.length > 0 ? (id as ProjectId) : null);
                }}
              >
                <CaptureChip
                  symbol="folder"
                  label={projectName ?? "Project"}
                  active={projectName !== null}
                />
              </MenuView>
            ) : null}
            <MenuView title="Due" actions={dueActions} onPressAction={onDue}>
              <CaptureChip
                symbol="calendar"
                label={effectiveDueAt === null ? "Due" : (dueLabel(effectiveDueAt, nowMs) ?? "Due")}
                active={effectiveDueAt !== null}
              />
            </MenuView>
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
            <View className="flex-1" />
            <Pressable
              accessibilityRole="button"
              accessibilityHint="Adds the task and opens it for notes, links and files"
              disabled={!canAdd}
              onPress={() => add(true)}
              className={cn("h-8 justify-center px-1", !canAdd && "opacity-30")}
            >
              <Text className="text-[13px] font-ryco-bold text-accent">Details</Text>
            </Pressable>
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
