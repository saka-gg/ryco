import { MenuView, type MenuAction, type NativeActionEvent } from "@react-native-menu/menu";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import {
  dueLabel,
  hasTaskLink,
  parseTaskLinkPaste,
  selectTaskView,
  taskProjectLocked,
  useLocalTasksStore,
} from "@ryco/client-runtime/state/tasks";
import type { LocalTaskLink, ProjectId, ThreadId } from "@ryco/contracts";
import { EnvironmentId } from "@ryco/contracts/base-schemas";
import { LOCAL_TASK_MAX_LINKS, LOCAL_TASK_NOTES_MAX_LENGTH } from "@ryco/contracts/local-tasks";
import * as Haptics from "expo-haptics";
import type { SFSymbol } from "expo-symbols";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Alert, LayoutAnimation, Pressable, ScrollView, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useShallow } from "zustand/react/shallow";

import { ComposerAttachMenu } from "../../components/ComposerAttachMenu";
import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { EmptyState } from "../../components/EmptyState";
import { cn } from "../../lib/cn";
import {
  pickComposerAttachmentsFrom,
  type ComposerAttachmentSource,
} from "../../lib/composerFiles";
import { openWebLink } from "../../lib/openWebLink";
import { useThemeColor } from "../../lib/useThemeColor";
import { useComposerFileUploadMaxBytes } from "../../state/composerFileUpload";
import {
  addPickedTaskFiles,
  dismissPendingTaskFile,
  useTaskFileUploadsStore,
} from "./taskFileUploads";
import {
  confirmDeleteTask,
  openTaskChat,
  setTaskDone,
  startTaskChat,
  updateTask,
} from "./taskActions";
import {
  linkableTaskChats,
  taskChatRows,
  taskLinkRows,
  titleToSave,
  type TaskThreadInfo,
} from "./taskDetailModel";
import { TaskDuePicker } from "./TaskDuePicker";
import { TaskCheckbox } from "./TaskRow";
import { TASK_PRIORITY_LABELS, type TaskPriority } from "./tasksListModel";
import { mobileLocalTaskWriter } from "./tasksRuntime";
import { useMachineTasks, useTaskMachines } from "./useMachineTasks";

type TaskDetailRouteScreenProps = StaticScreenProps<{
  readonly environmentId: string;
  readonly taskId: string;
}>;

const PRIORITIES: ReadonlyArray<TaskPriority> = ["low", "normal", "high", "urgent"];
/** Notes save this long after the last keystroke (and on leaving the field). */
const NOTES_SAVE_DELAY_MS = 700;

const LINK_SYMBOLS: Readonly<Record<string, SFSymbol>> = {
  pr: "arrow.triangle.pull",
  issue: "smallcircle.filled.circle",
  workItem: "ticket",
  branch: "arrow.triangle.branch",
  url: "link",
  thread: "bubble.left",
};

const CHAT_TONE_CLASS: Readonly<Record<string, string>> = {
  "needs-you": "text-warning",
  starting: "text-accent",
  running: "text-accent",
  failed: "text-danger-foreground",
  review: "text-success",
  gone: "text-foreground-tertiary",
};

function Group(props: {
  readonly title: string;
  readonly trailing?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <View className="gap-1.5">
      <View className="flex-row items-center justify-between px-1">
        <Text className="text-[13px] font-ryco-bold uppercase tracking-wide text-foreground-muted">
          {props.title}
        </Text>
        {props.trailing}
      </View>
      <View className="overflow-hidden rounded-2xl bg-card">{props.children}</View>
    </View>
  );
}

function Row(props: {
  readonly first?: boolean;
  readonly symbol?: SFSymbol;
  readonly label: string;
  readonly value?: string | null;
  readonly valueClassName?: string;
  readonly detail?: string | null;
  readonly onPress?: () => void;
  readonly accessory?: ReactNode;
  readonly disabled?: boolean;
}) {
  const icon = useThemeColor("--color-icon-muted") as string;
  const body = (
    <View
      className={cn(
        "min-h-12 flex-row items-center gap-3 px-4 py-2.5",
        !props.first && "border-t border-border-subtle",
        props.disabled && "opacity-50",
      )}
    >
      {props.symbol ? <SymbolView name={props.symbol} size={15} tintColor={icon} /> : null}
      <View className="min-w-0 flex-1">
        <Text className="text-[15px] text-foreground" numberOfLines={1}>
          {props.label}
        </Text>
        {props.detail ? (
          <Text className="text-xs text-foreground-muted" numberOfLines={2}>
            {props.detail}
          </Text>
        ) : null}
      </View>
      {props.value ? (
        <Text
          className={cn("max-w-[55%] text-[15px] text-foreground-muted", props.valueClassName)}
          numberOfLines={1}
        >
          {props.value}
        </Text>
      ) : null}
      {props.accessory}
    </View>
  );
  if (!props.onPress) return body;
  return (
    <Pressable
      accessibilityRole="button"
      disabled={props.disabled}
      onPress={props.onPress}
      className="active:bg-subtle"
    >
      {body}
    </Pressable>
  );
}

function RemoveButton(props: { readonly label: string; readonly onPress: () => void }) {
  const icon = useThemeColor("--color-icon-subtle") as string;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.label}
      hitSlop={10}
      onPress={props.onPress}
      className="h-7 w-7 items-center justify-center rounded-full active:bg-subtle"
    >
      <SymbolView name="xmark" size={11} weight="semibold" tintColor={icon} />
    </Pressable>
  );
}

function AddButton(props: { readonly label: string; readonly onPress?: () => void }) {
  const primary = useThemeColor("--color-accent") as string;
  const content = (
    <View className="min-h-12 flex-row items-center gap-3 border-t border-border-subtle px-4">
      <SymbolView name="plus.circle.fill" size={17} tintColor={primary} />
      <Text className="text-[15px] text-accent">{props.label}</Text>
    </View>
  );
  if (!props.onPress) return content;
  return (
    <Pressable accessibilityRole="button" onPress={props.onPress} className="active:bg-subtle">
      {content}
    </Pressable>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * One task, editable: title, notes, priority, due day, project, links, files
 * and its chats, with Start chat (or Open chat) and Delete. Every change saves
 * at once through the machine's task writer.
 */
export function TaskDetailRouteScreen(props: TaskDetailRouteScreenProps) {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const environmentId = EnvironmentId.make(props.route.params.environmentId);
  const taskId = props.route.params.taskId;
  const { environment, projects, getSummary, summaries } = useMachineTasks(environmentId);
  // A machine that is offline (or no longer listed) shows its task as last read, unchangeable.
  const machine = useTaskMachines().find((candidate) => candidate.environmentId === environmentId);
  const readOnly = !(machine?.connected ?? false);
  const task = useLocalTasksStore((state) => selectTaskView(state, environmentId, taskId));
  const pendingFiles = useTaskFileUploadsStore(useShallow((state) => state.byTask[taskId] ?? []));
  const fileUploadMaxBytes = useComposerFileUploadMaxBytes(environmentId);
  const [title, setTitle] = useState(task?.title ?? "");
  const [notes, setNotes] = useState(task?.notes ?? "");
  const [dueOpen, setDueOpen] = useState(false);
  const notesTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const editingTitle = useRef(false);
  const editingNotes = useRef(false);
  const placeholder = useThemeColor("--color-placeholder") as string;
  const foreground = useThemeColor("--color-foreground") as string;
  const primaryForeground = useThemeColor("--color-primary-foreground") as string;
  const icon = useThemeColor("--color-icon-muted") as string;
  const nowMs = Date.now();

  // Someone else's edit shows unless the field is being typed in.
  const nodeTitle = task?.title;
  const nodeNotes = task?.notes;
  useEffect(() => {
    if (nodeTitle !== undefined && !editingTitle.current) setTitle(nodeTitle);
  }, [nodeTitle]);
  useEffect(() => {
    if (nodeNotes !== undefined && !editingNotes.current) setNotes(nodeNotes);
  }, [nodeNotes]);
  // Notes still waiting for their save go out when the sheet closes.
  const pendingNotes = useRef<(() => void) | null>(null);
  const pendingTitle = useRef<(() => void) | null>(null);
  useEffect(
    () => () => {
      if (notesTimer.current) clearTimeout(notesTimer.current);
      pendingNotes.current?.();
      pendingTitle.current?.();
    },
    [],
  );

  if (!task) {
    return (
      <View className="flex-1 bg-screen px-6 pt-16">
        <EmptyState
          variant="plain"
          title={environment.readAt === null ? "Loading…" : "Task not found"}
          detail={
            environment.readAt === null
              ? ""
              : "It may have been deleted on another device. Close this sheet to go back."
          }
        />
      </View>
    );
  }

  const done = task.state === "done";
  const readThread = (threadId: ThreadId): TaskThreadInfo | undefined => {
    const summary = summaries[threadId];
    return summary ? (summary as TaskThreadInfo) : undefined;
  };
  const chats = taskChatRows(task, getSummary, readThread);
  const links = taskLinkRows(task.links, readThread);
  const projectLocked = taskProjectLocked(task, (threadId) => summaries[threadId] !== undefined);
  const project = projects.find((candidate) => candidate.id === task.projectId) ?? null;
  const linkable = linkableTaskChats(task, Object.values(summaries) as TaskThreadInfo[]);

  const saveTitle = () => {
    editingTitle.current = false;
    pendingTitle.current = null;
    const next = titleToSave(title, task.title);
    if (next === null) setTitle(task.title);
    else updateTask(environmentId, taskId, { title: next });
  };
  const flushNotes = (value: string) => {
    if (notesTimer.current) clearTimeout(notesTimer.current);
    notesTimer.current = null;
    pendingNotes.current = null;
    if (value !== task.notes) updateTask(environmentId, taskId, { notes: value });
  };
  const changeNotes = (value: string) => {
    editingNotes.current = true;
    setNotes(value);
    if (notesTimer.current) clearTimeout(notesTimer.current);
    pendingNotes.current = () => flushNotes(value);
    notesTimer.current = setTimeout(() => flushNotes(value), NOTES_SAVE_DELAY_MS);
  };
  const setLinks = (next: ReadonlyArray<LocalTaskLink>) => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    updateTask(environmentId, taskId, { links: [...next] });
  };
  const addLink = (link: LocalTaskLink) => {
    if (hasTaskLink(task.links, link)) return;
    if (task.links.length >= LOCAL_TASK_MAX_LINKS) {
      Alert.alert("Too many links", `A task holds up to ${LOCAL_TASK_MAX_LINKS} links.`);
      return;
    }
    void Haptics.selectionAsync();
    setLinks([...task.links, link]);
  };
  const promptLink = () =>
    Alert.prompt(
      "Add a link",
      "Paste a pull request, issue or Jira URL, a Jira key, or any web address.",
      (text) => {
        const link = parseTaskLinkPaste(text);
        if (link) addLink(link);
        else Alert.alert("Not a link", "That isn’t a URL or a Jira key.");
      },
      "plain-text",
    );
  const promptBranch = () =>
    Alert.prompt("Link a branch", "Its name, as git knows it.", (text) => {
      const name = text.trim();
      if (name.length > 0 && name.length <= 255 && !/\s/.test(name))
        addLink({ kind: "branch", name });
    });
  const pickFiles = (source: ComposerAttachmentSource) => {
    void pickComposerAttachmentsFrom(source, {
      existingCount: task.files.length + pendingFiles.length,
      existingTotalBytes:
        task.files.reduce((total, file) => total + file.sizeBytes, 0) +
        pendingFiles.reduce((total, file) => total + file.sizeBytes, 0),
      fileUploadMaxBytes,
    }).then((picked) => {
      if (picked.error) Alert.alert("Some files were not added", picked.error);
      addPickedTaskFiles({
        environmentId,
        taskId,
        picked,
        stored: task.files,
        streamingMaxBytes: fileUploadMaxBytes,
      });
    });
  };
  const removeFile = (fileId: string, name: string) =>
    Alert.alert("Remove this file?", `“${name}” is taken off the task.`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Remove",
        style: "destructive",
        onPress: () =>
          void mobileLocalTaskWriter(environmentId).removeFile(taskId, fileId as never),
      },
    ]);
  const start = () => {
    // A tap on Start doesn't blur the fields: what was typed saves before the chat is seeded.
    if (editingTitle.current) saveTitle();
    flushNotes(notes);
    startTaskChat(navigation, environmentId, task, { replace: true });
  };
  const latestChat = chats.find((chat) => chat.openable && chat.tone !== "gone");

  const projectActions: MenuAction[] = [
    { id: "", title: "No project", state: task.projectId === null ? "on" : "off" },
    ...projects.map((candidate) => ({
      id: candidate.id,
      title: candidate.name,
      state: candidate.id === task.projectId ? ("on" as const) : ("off" as const),
    })),
  ];
  const linkActions: MenuAction[] = [
    { id: "paste", title: "Paste a URL or key", image: "link" },
    { id: "branch", title: "A branch", image: "arrow.triangle.branch" },
    ...(linkable.length > 0
      ? [
          {
            id: "chats",
            title: "A chat",
            image: "bubble.left",
            subactions: linkable.map((thread) => ({
              id: `chat:${thread.id}`,
              title: thread.title,
            })),
          },
        ]
      : []),
  ];
  const onLinkAction = (event: NativeActionEvent) => {
    const id = event.nativeEvent.event;
    if (id === "paste") promptLink();
    else if (id === "branch") promptBranch();
    else if (id.startsWith("chat:")) addLink({ kind: "thread", threadId: id.slice(5) as ThreadId });
  };

  return (
    <ScrollView
      className="flex-1 bg-screen"
      keyboardDismissMode="interactive"
      keyboardShouldPersistTaps="handled"
      automaticallyAdjustKeyboardInsets
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 40, gap: 20 }}
    >
      <View className="gap-2">
        <View className="flex-row items-start gap-3">
          <View className="pt-1.5">
            <TaskCheckbox
              checked={done}
              title={task.title}
              size={26}
              disabled={readOnly}
              onToggle={() => setTaskDone(environmentId, task, !done)}
            />
          </View>
          <TextInput
            editable={!readOnly}
            value={title}
            onChangeText={(value) => {
              editingTitle.current = true;
              const typed = value.replace(/\n/g, " ");
              setTitle(typed);
              pendingTitle.current = () => {
                const next = titleToSave(typed, task.title);
                if (next !== null) updateTask(environmentId, taskId, { title: next });
              };
            }}
            onBlur={saveTitle}
            onSubmitEditing={saveTitle}
            submitBehavior="blurAndSubmit"
            multiline
            scrollEnabled={false}
            returnKeyType="done"
            accessibilityLabel="Title"
            placeholder="Title"
            placeholderTextColor={placeholder}
            className={cn(
              "min-w-0 flex-1 font-ryco-bold text-[22px] leading-[28px]",
              done && "line-through",
            )}
            style={{ color: foreground, paddingTop: 0, paddingBottom: 0 }}
          />
        </View>
        {task.creating || task.saving ? (
          <Text className="pl-[38px] text-xs text-foreground-tertiary">Saving…</Text>
        ) : null}
      </View>

      <View className="min-h-24 rounded-2xl bg-card px-4 py-3">
        <TextInput
          editable={!readOnly}
          value={notes}
          onChangeText={changeNotes}
          onBlur={() => {
            editingNotes.current = false;
            flushNotes(notes);
          }}
          multiline
          scrollEnabled={false}
          maxLength={LOCAL_TASK_NOTES_MAX_LENGTH}
          accessibilityLabel="Notes"
          placeholder="Notes: what to do, what done looks like"
          placeholderTextColor={placeholder}
          className="min-h-20 font-sans text-[15px] leading-[21px]"
          style={{ color: foreground, textAlignVertical: "top" }}
        />
      </View>

      <View className="gap-2">
        {latestChat ? (
          <View className="flex-row gap-2">
            <Pressable
              accessibilityRole="button"
              onPress={() => openTaskChat(navigation, environmentId, latestChat.threadId)}
              className="h-12 flex-1 flex-row items-center justify-center gap-2 rounded-2xl bg-primary active:opacity-80"
            >
              <SymbolView name="bubble.left.fill" size={15} tintColor={primaryForeground} />
              <Text className="text-[15px] font-ryco-bold text-primary-foreground">Open chat</Text>
            </Pressable>
            {done || readOnly ? null : (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Start another chat"
                onPress={start}
                className="h-12 flex-row items-center justify-center gap-2 rounded-2xl bg-card px-4 active:bg-subtle"
              >
                <SymbolView name="plus" size={14} tintColor={icon} />
                <Text className="text-[15px] font-ryco-medium text-foreground">Another</Text>
              </Pressable>
            )}
          </View>
        ) : done || readOnly ? null : (
          <Pressable
            accessibilityRole="button"
            accessibilityHint="Opens a new chat with this task as its message"
            onPress={start}
            className="h-12 flex-row items-center justify-center gap-2 rounded-2xl bg-primary active:opacity-80"
          >
            <SymbolView name="sparkles" size={15} tintColor={primaryForeground} />
            <Text className="text-[15px] font-ryco-bold text-primary-foreground">Start chat</Text>
          </Pressable>
        )}
        {readOnly ? (
          <View className="flex-row items-center gap-2 rounded-xl bg-subtle px-3 py-2.5">
            <SymbolView name="wifi.slash" size={14} tintColor={icon} />
            <Text className="min-w-0 flex-1 text-xs text-foreground-muted">
              {machine?.label ?? "Its machine"} is offline. This is the task as last read; it can
              change once the machine is back.
            </Text>
          </View>
        ) : done ? (
          <Text className="px-1 text-xs text-foreground-muted">
            Reopen the task to start a chat for it.
          </Text>
        ) : task.files.length > 0 || task.links.length > 0 ? (
          <Text className="px-1 text-xs text-foreground-muted">
            The chat starts with the task’s notes and links
            {task.files.length > 0 ? " and gets its files" : ""}.
          </Text>
        ) : null}
      </View>

      <View pointerEvents={readOnly ? "none" : "auto"} className={cn(readOnly && "opacity-50")}>
        <Group title="Details">
          <View className="gap-2 px-4 py-3">
            <Text className="text-[15px] text-foreground">Priority</Text>
            <View accessibilityRole="radiogroup" className="flex-row rounded-xl bg-subtle p-0.5">
              {PRIORITIES.map((value) => {
                const selected = task.priority === value;
                return (
                  <Pressable
                    key={value}
                    accessibilityRole="radio"
                    accessibilityState={{ selected }}
                    onPress={() => {
                      if (selected) return;
                      void Haptics.selectionAsync();
                      updateTask(environmentId, taskId, { priority: value });
                    }}
                    className={cn(
                      "h-8 flex-1 items-center justify-center rounded-[10px]",
                      selected && "bg-card",
                    )}
                  >
                    <Text
                      className={cn(
                        "text-[13px]",
                        selected ? "font-ryco-bold" : "text-foreground-muted",
                        selected && value === "urgent" && "text-danger-foreground",
                        selected && value === "high" && "text-warning",
                        selected && (value === "normal" || value === "low") && "text-foreground",
                      )}
                    >
                      {TASK_PRIORITY_LABELS[value]}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          </View>
          <Row
            symbol="calendar"
            label="Due"
            value={task.dueAt === null ? "None" : (dueLabel(task.dueAt, nowMs) ?? "None")}
            onPress={() => {
              LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
              setDueOpen((open) => !open);
            }}
            accessory={
              <SymbolView
                name={dueOpen ? "chevron.up" : "chevron.down"}
                size={11}
                tintColor={icon}
              />
            }
          />
          {dueOpen ? (
            <TaskDuePicker
              dueAt={task.dueAt}
              nowMs={nowMs}
              onChange={(dueAt) => updateTask(environmentId, taskId, { dueAt })}
            />
          ) : null}
          <MenuView
            title="Project"
            actions={projectActions}
            onPressAction={(event: NativeActionEvent) => {
              const id = event.nativeEvent.event;
              if (projectLocked) return;
              updateTask(environmentId, taskId, {
                projectId: id.length > 0 ? (id as ProjectId) : null,
              });
            }}
          >
            <Row
              symbol="folder"
              label="Project"
              value={project?.name ?? "None"}
              disabled={projectLocked}
              detail={projectLocked ? "Fixed: the task’s chats run in it." : null}
            />
          </MenuView>
        </Group>
      </View>

      {chats.length > 0 ? (
        <Group title={chats.length === 1 ? "Chat" : `Chats · ${chats.length}`}>
          {chats.map((chat, index) => (
            <Row
              key={chat.key}
              first={index === 0}
              symbol={chat.linked ? "link" : "bubble.left"}
              label={chat.title}
              detail={chat.error ?? chat.branch}
              value={chat.word}
              valueClassName={cn("font-ryco-medium", CHAT_TONE_CLASS[chat.tone])}
              disabled={!chat.openable}
              {...(chat.openable
                ? { onPress: () => openTaskChat(navigation, environmentId, chat.threadId) }
                : {})}
            />
          ))}
        </Group>
      ) : null}

      <View
        pointerEvents={readOnly ? "none" : "auto"}
        className={cn("gap-5", readOnly && "opacity-50")}
      >
        <Group title="Links">
          {links.length === 0 ? (
            <Text className="px-4 py-3 text-[15px] text-foreground-tertiary">
              Pull requests, issues, branches, chats and pages this task is about.
            </Text>
          ) : (
            links.map((link, index) => (
              <Row
                key={link.key}
                first={index === 0}
                symbol={LINK_SYMBOLS[link.kind] ?? "link"}
                label={link.label}
                detail={link.detail === link.label ? null : link.detail}
                {...(link.target === null
                  ? {}
                  : {
                      onPress: () => {
                        const target = link.target;
                        if (target?.kind === "url") openWebLink(target.url);
                        else if (target?.kind === "thread")
                          openTaskChat(navigation, environmentId, target.threadId);
                      },
                    })}
                accessory={
                  <RemoveButton
                    label={`Remove ${link.label}`}
                    onPress={() => setLinks(task.links.filter((_, at) => at !== link.index))}
                  />
                }
              />
            ))
          )}
          <MenuView title="Link" actions={linkActions} onPressAction={onLinkAction}>
            <AddButton label="Add link" />
          </MenuView>
        </Group>

        <Group title="Files">
          {task.files.length === 0 && pendingFiles.length === 0 ? (
            <Text className="px-4 py-3 text-[15px] text-foreground-tertiary">
              Every chat started from the task gets these files.
            </Text>
          ) : null}
          {task.files.map((file, index) => (
            <Row
              key={file.fileId}
              first={index === 0}
              symbol={file.type === "image" ? "photo" : "doc"}
              label={file.name}
              detail={formatBytes(file.sizeBytes)}
              accessory={
                <RemoveButton
                  label={`Remove ${file.name}`}
                  onPress={() => removeFile(file.fileId, file.name)}
                />
              }
            />
          ))}
          {pendingFiles.map((file, index) => (
            <Row
              key={file.key}
              first={task.files.length === 0 && index === 0}
              symbol={file.error ? "exclamationmark.triangle" : "arrow.up.circle"}
              label={file.name}
              detail={file.error ?? `Uploading… ${Math.round(file.progress * 100)}%`}
              {...(file.error
                ? {
                    accessory: (
                      <RemoveButton
                        label={`Dismiss ${file.name}`}
                        onPress={() => dismissPendingTaskFile(taskId, file.key)}
                      />
                    ),
                  }
                : {})}
            />
          ))}
          <ComposerAttachMenu disabled={false} onPick={pickFiles} onClose={() => undefined}>
            {(open) => <AddButton label="Add photos or files" onPress={open} />}
          </ComposerAttachMenu>
        </Group>

        <Pressable
          accessibilityRole="button"
          onPress={() => {
            void confirmDeleteTask(environmentId, task).then((deleted) => {
              if (deleted) navigation.goBack();
            });
          }}
          className="h-12 items-center justify-center rounded-2xl bg-card active:bg-subtle"
        >
          <Text className="text-[15px] font-ryco-medium text-danger-foreground">Delete task</Text>
        </Pressable>
      </View>
    </ScrollView>
  );
}
