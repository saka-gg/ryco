import type {
  EnvironmentId,
  SourceControlAssigneeCandidate,
  SourceControlChangeRequestDetail,
  SourceControlLabel,
} from "@ryco/contracts";
import { useState } from "react";
import { Modal, Pressable, ScrollView, TextInput, View } from "react-native";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { ErrorBanner } from "../../components/ErrorBanner";
import { cn } from "../../lib/cn";
import { useThemeColor } from "../../lib/useThemeColor";
import { PullRequestCompletingInput } from "./PullRequestCompletingInput";
import { pullRequestLabelColor } from "./pullRequestGlyphModel";
import {
  pullRequestDetailsEdit,
  pullRequestListEdit,
  requestedReviewerLogins,
} from "./pullRequestPeopleModel";
import type { PullRequestActionsControl } from "./usePullRequestActions";
import { useRepositoryLabels, useRepositoryPeople } from "./usePullRequestCompletions";

export type PullRequestEditSheet = "edit" | "reviewers" | "labels" | "comment";

interface SheetProps {
  readonly control: PullRequestActionsControl;
  readonly detail: SourceControlChangeRequestDetail;
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly onClose: () => void;
}

function SheetHeader(props: {
  readonly title: string;
  readonly action: string;
  readonly busy: boolean;
  readonly disabled: boolean;
  readonly onCancel: () => void;
  readonly onAction: () => void;
}) {
  return (
    <View className="flex-row items-center gap-3 px-4 pb-2 pt-6">
      <Pressable
        accessibilityRole="button"
        onPress={props.onCancel}
        className="h-11 min-w-16 justify-center active:opacity-60"
      >
        <Text className="text-base text-foreground">Cancel</Text>
      </Pressable>
      <Text className="flex-1 text-center text-lg font-ryco-bold text-foreground">
        {props.title}
      </Text>
      <Pressable
        accessibilityRole="button"
        disabled={props.disabled || props.busy}
        onPress={props.onAction}
        className="h-11 min-w-16 items-end justify-center active:opacity-60 disabled:opacity-30"
      >
        <Text className="text-base font-ryco-bold text-primary">
          {props.busy ? "Saving…" : props.action}
        </Text>
      </Pressable>
    </View>
  );
}

// Each sheet edits from the values it opened with, not the latest read: the
// pull request is read again while a sheet is open (live checks), and diffing
// against a fresh read would send back someone else's change undone.

function EditDetailsSheet(props: SheetProps) {
  const [start] = useState(() => ({ title: props.detail.title, body: props.detail.body }));
  const [title, setTitle] = useState(start.title);
  const [body, setBody] = useState(start.body);
  const placeholder = useThemeColor("--color-placeholder") as string;
  const text = useThemeColor("--color-foreground") as string;
  const edit = pullRequestDetailsEdit(start, { title, body });
  const busy = props.control.pending === "update";
  const save = () => {
    if (edit !== null) props.control.runUpdate(edit, "Saved.", props.onClose);
  };
  return (
    <View className="flex-1 bg-screen">
      <SheetHeader
        title="Edit"
        action="Save"
        busy={busy}
        disabled={edit === null || title.trim().length === 0}
        onCancel={props.onClose}
        onAction={save}
      />
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ padding: 16, gap: 14, paddingBottom: 48 }}
      >
        {props.control.error ? <ErrorBanner message={props.control.error} /> : null}
        <Text className="px-1 text-xs font-ryco-bold uppercase text-foreground-muted">Title</Text>
        <TextInput
          value={title}
          onChangeText={setTitle}
          placeholder="Title"
          placeholderTextColor={placeholder}
          className="rounded-2xl bg-card px-4 py-3 font-sans text-base"
          style={{ color: text }}
        />
        <Text className="px-1 text-xs font-ryco-bold uppercase text-foreground-muted">
          Description
        </Text>
        <PullRequestCompletingInput
          value={body}
          onChangeText={setBody}
          environmentId={props.environmentId}
          cwd={props.cwd}
          placeholder="Describe the change. Type @ or # to mention."
          minHeight={260}
        />
      </ScrollView>
    </View>
  );
}

interface PickerItem {
  readonly key: string;
  readonly title: string;
  readonly detail: string | null;
  readonly color: string | null;
}

function PickerSheet(props: {
  readonly title: string;
  readonly items: ReadonlyArray<PickerItem> | null;
  readonly loadError: string | null;
  readonly initial: ReadonlyArray<string>;
  readonly searchPlaceholder: string;
  /** What an empty list means here. */
  readonly emptyText: string;
  readonly control: PullRequestActionsControl;
  readonly onSave: (chosen: ReadonlyArray<string>) => void;
  readonly onClose: () => void;
}) {
  const [chosen, setChosen] = useState<ReadonlyArray<string>>(props.initial);
  const [query, setQuery] = useState("");
  const primary = useThemeColor("--color-primary") as string;
  const icon = useThemeColor("--color-icon-muted") as string;
  const placeholder = useThemeColor("--color-placeholder") as string;
  const text = useThemeColor("--color-foreground") as string;
  const needle = query.trim().toLowerCase();
  // Chosen entries stay listed even when the host's list leaves them out.
  const known = new Set((props.items ?? []).map((item) => item.key));
  const items: ReadonlyArray<PickerItem> = [
    ...props.initial
      .filter((key) => !known.has(key))
      .map((key) => ({ key, title: key, detail: null, color: null })),
    ...(props.items ?? []),
  ].filter(
    (item) =>
      needle.length === 0 ||
      item.title.toLowerCase().includes(needle) ||
      (item.detail?.toLowerCase().includes(needle) ?? false),
  );
  const changed = pullRequestListEdit(props.initial, chosen) !== null;
  const toggle = (key: string) =>
    setChosen((current) =>
      current.includes(key) ? current.filter((entry) => entry !== key) : [...current, key],
    );
  return (
    <View className="flex-1 bg-screen">
      <SheetHeader
        title={props.title}
        action="Save"
        busy={props.control.pending === "update"}
        disabled={!changed}
        onCancel={props.onClose}
        onAction={() => props.onSave(chosen)}
      />
      <View className="px-4 pb-2">
        <View className="h-10 flex-row items-center gap-2 rounded-xl bg-subtle px-3">
          <SymbolView name="magnifyingglass" size={14} tintColor={icon} />
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder={props.searchPlaceholder}
            placeholderTextColor={placeholder}
            autoCapitalize="none"
            autoCorrect={false}
            className="h-10 flex-1 font-sans text-base"
            style={{ color: text }}
          />
        </View>
      </View>
      {props.control.error ? (
        <View className="px-4 pb-2">
          <ErrorBanner message={props.control.error} />
        </View>
      ) : null}
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingBottom: 48 }}>
        {props.items === null && props.loadError === null ? (
          <Text className="px-5 py-6 text-sm text-foreground-muted">Loading…</Text>
        ) : null}
        {props.loadError ? (
          <Text className="px-5 py-6 text-sm text-foreground-muted">{props.loadError}</Text>
        ) : null}
        {props.items !== null && items.length === 0 ? (
          <Text className="px-5 py-6 text-sm text-foreground-muted">
            {needle.length > 0 ? "Nothing matches the search." : props.emptyText}
          </Text>
        ) : null}
        <View className="mx-4 overflow-hidden rounded-2xl bg-card">
          {items.map((item, index) => {
            const selected = chosen.includes(item.key);
            return (
              <Pressable
                key={item.key}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: selected }}
                onPress={() => toggle(item.key)}
                className={cn(
                  "min-h-12 flex-row items-center gap-3 px-4 py-2 active:bg-subtle",
                  index > 0 && "border-t border-border-subtle",
                )}
              >
                {item.color ? (
                  <View
                    style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: item.color }}
                  />
                ) : null}
                <View className="min-w-0 flex-1">
                  <Text className="text-base text-foreground" numberOfLines={1}>
                    {item.title}
                  </Text>
                  {item.detail ? (
                    <Text className="text-xs text-foreground-muted" numberOfLines={1}>
                      {item.detail}
                    </Text>
                  ) : null}
                </View>
                {selected ? <SymbolView name="checkmark" size={15} tintColor={primary} /> : null}
              </Pressable>
            );
          })}
        </View>
      </ScrollView>
    </View>
  );
}

function personItem(person: SourceControlAssigneeCandidate): PickerItem {
  return {
    key: person.login,
    title: person.login,
    detail: person.displayName ?? null,
    color: null,
  };
}

function labelItem(label: SourceControlLabel): PickerItem {
  return {
    key: label.name,
    title: label.name,
    detail: label.description ?? null,
    color: pullRequestLabelColor(label.color),
  };
}

function ReviewersSheet(props: SheetProps) {
  const people = useRepositoryPeople(props.environmentId, props.cwd, true);
  const [initial] = useState(() => requestedReviewerLogins(props.detail));
  const author = props.detail.author;
  return (
    <PickerSheet
      title="Reviewers"
      items={
        people.data === null
          ? null
          : people.data.filter((person) => person.login !== author).map(personItem)
      }
      loadError={people.error}
      initial={initial}
      searchPlaceholder="Search people"
      emptyText="Nobody else can review pull requests in this repository."
      control={props.control}
      onSave={(chosen) => {
        const edit = pullRequestListEdit(initial, chosen);
        if (edit)
          props.control.runUpdate(
            { kind: "reviewers", ...edit },
            "Reviewers updated.",
            props.onClose,
          );
      }}
      onClose={props.onClose}
    />
  );
}

function LabelsSheet(props: SheetProps) {
  const labels = useRepositoryLabels(props.environmentId, props.cwd, true);
  const [initial] = useState(() => (props.detail.labels ?? []).map((label) => label.name));
  return (
    <PickerSheet
      title="Labels"
      items={labels.data === null ? null : labels.data.map(labelItem)}
      loadError={labels.error}
      initial={initial}
      searchPlaceholder="Search labels"
      emptyText="This repository has no labels yet."
      control={props.control}
      onSave={(chosen) => {
        const edit = pullRequestListEdit(initial, chosen);
        if (edit)
          props.control.runUpdate({ kind: "labels", ...edit }, "Labels updated.", props.onClose);
      }}
      onClose={props.onClose}
    />
  );
}

function CommentSheet(props: SheetProps) {
  const [body, setBody] = useState("");
  const busy = props.control.pending === "comment";
  return (
    <View className="flex-1 bg-screen">
      <SheetHeader
        title="Comment"
        action="Post"
        busy={busy}
        disabled={body.trim().length === 0}
        onCancel={props.onClose}
        onAction={() => props.control.addComment(body.trim(), props.onClose)}
      />
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ padding: 16, gap: 12, paddingBottom: 48 }}
      >
        {props.control.error ? <ErrorBanner message={props.control.error} /> : null}
        <PullRequestCompletingInput
          value={body}
          onChangeText={setBody}
          environmentId={props.environmentId}
          cwd={props.cwd}
          placeholder="Write a comment. Type @ or # to mention."
          autoFocus
          editable={!busy}
          minHeight={180}
        />
      </ScrollView>
    </View>
  );
}

/** The pull request's edit sheets; one shows at a time. */
export function PullRequestEditSheets(props: {
  readonly sheet: PullRequestEditSheet | null;
  readonly control: PullRequestActionsControl;
  readonly detail: SourceControlChangeRequestDetail | null;
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly onClose: () => void;
}) {
  const { detail } = props;
  const shared =
    detail === null
      ? null
      : {
          control: props.control,
          detail,
          environmentId: props.environmentId,
          cwd: props.cwd,
          onClose: props.onClose,
        };
  return (
    <Modal
      visible={props.sheet !== null && shared !== null}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={props.onClose}
    >
      {shared === null ? null : props.sheet === "edit" ? (
        <EditDetailsSheet {...shared} />
      ) : props.sheet === "reviewers" ? (
        <ReviewersSheet {...shared} />
      ) : props.sheet === "labels" ? (
        <LabelsSheet {...shared} />
      ) : props.sheet === "comment" ? (
        <CommentSheet {...shared} />
      ) : null}
    </Modal>
  );
}
