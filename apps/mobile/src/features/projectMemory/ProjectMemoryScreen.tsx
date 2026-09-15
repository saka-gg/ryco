import { useEffect, useState, useSyncExternalStore } from "react";
import { Alert, Pressable, ScrollView, Share, Text, TextInput, View } from "react-native";
import { randomUUID } from "expo-crypto";
import type { ProjectMemoryEntry } from "@ryco/contracts";
import type { ProjectMemoryController } from "@ryco/client-runtime/state/project-memory";
import {
  PROJECT_MEMORY_DELETION_NOTICE,
  projectMemoryNeedsReview,
  projectMemoryTextProblem,
} from "@ryco/shared/projectMemory";

function Action({
  label,
  disabled = false,
  onPress,
}: {
  label: string;
  disabled?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      className="min-h-11 justify-center rounded-lg border border-separator px-3 py-2"
      style={{ opacity: disabled ? 0.45 : 1 }}
    >
      <Text className="text-foreground">{label}</Text>
    </Pressable>
  );
}
function Provenance({ entry }: { entry: ProjectMemoryEntry }) {
  return (
    <Text className="text-xs text-foreground-secondary">
      {entry.kind} · User {entry.provenance.actorId.slice(0, 8)} · Revision {entry.revision} ·{" "}
      {new Date(entry.createdAt).toLocaleDateString()}
      {entry.provenance.source
        ? ` · Thread ${entry.provenance.source.threadId} · Message ${entry.provenance.source.messageId}`
        : " · Written by a user"}
    </Text>
  );
}
export function ProjectMemoryNativeRecallPreview({
  controller,
}: {
  controller: ProjectMemoryController;
}) {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  if (!state.references.length) return null;
  return (
    <View
      accessibilityLabel="Selected project memory"
      className="gap-2 rounded-xl border border-separator p-3"
    >
      <Text className="font-semibold text-foreground">
        {state.references.length} {state.references.length === 1 ? "memory" : "memories"} selected
      </Text>
      {state.preview ? (
        <>
          {state.preview.entries.map((entry) => (
            <View key={entry.id} className="gap-1">
              <Text selectable className="text-foreground">
                {entry.text}
              </Text>
              <Provenance entry={entry} />
            </View>
          ))}
          <Text className="text-xs text-foreground-secondary">
            References are checked again at delivery. {state.preview.envelopeBytes} / 16,384 bytes.
          </Text>
        </>
      ) : (
        <Action
          label="Review selected memories"
          disabled={state.busy}
          onPress={() => void controller.previewRecall()}
        />
      )}
    </View>
  );
}
/** Presentation only. The existing native connection owner supplies the shared controller. */
export function ProjectMemoryScreen({ controller }: { controller: ProjectMemoryController }) {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const [text, setText] = useState("");
  const [kind, setKind] = useState<ProjectMemoryEntry["kind"]>("fact");
  const [editing, setEditing] = useState<ProjectMemoryEntry | null>(null);
  const [query, setQuery] = useState("");
  useEffect(() => {
    void controller.refresh();
  }, [controller]);
  const save = async () => {
    if (
      await controller.mutate(
        editing
          ? { operation: "edit", id: editing.id, revision: editing.revision, kind, text }
          : { operation: "create", id: randomUUID(), kind, text },
      )
    ) {
      setEditing(null);
      setText("");
    }
  };
  const forget = (entry?: ProjectMemoryEntry) =>
    Alert.alert(
      entry ? "Forget this memory?" : "Delete all and disable?",
      PROJECT_MEMORY_DELETION_NOTICE,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: () => {
            void controller
              .mutate(
                entry
                  ? { operation: "forget", id: entry.id, revision: entry.revision }
                  : { operation: "deleteAll" },
              )
              .then((ok) => {
                if (ok) {
                  setEditing(null);
                  setText("");
                }
              });
          },
        },
      ],
    );
  const exportMemory = async () => {
    const result = await controller.export();
    if (!result) return;
    try {
      await Share.share({ title: "Project memory JSON", message: JSON.stringify(result, null, 2) });
    } catch {
      Alert.alert("Export failed", "Project memory could not be shared. Try again.");
    }
  };
  return (
    <ScrollView
      className="flex-1 bg-screen"
      contentContainerStyle={{ padding: 16, gap: 16 }}
      keyboardShouldPersistTaps="handled"
    >
      <Text accessibilityRole="header" className="text-xl font-semibold text-foreground">
        Project memory
      </Text>
      <Text className="text-foreground-secondary">
        Curated facts for this project on this node. Nothing is collected or recalled automatically.
      </Text>
      <Text className="text-xs text-foreground-secondary">
        Do not save credentials or private information. Only recognized sensitive patterns can be
        rejected.
      </Text>
      {state.error && (
        <Text accessibilityRole="alert" className="text-foreground">
          {state.error}
        </Text>
      )}
      <Action
        label={state.page?.enabled ? "Disable memory" : "Enable memory"}
        disabled={state.busy || !state.page}
        onPress={() =>
          void controller.mutate({ operation: "enable", enabled: !state.page?.enabled })
        }
      />
      <View className="flex-row flex-wrap gap-2">
        <Action label="Refresh" disabled={state.busy} onPress={() => void controller.refresh()} />
        <Action
          label="Export JSON"
          disabled={state.busy || !state.page}
          onPress={() => void exportMemory()}
        />
        <Action
          label="Delete all and disable"
          disabled={state.busy || !state.page}
          onPress={() => forget()}
        />
      </View>
      <Text className="text-xs text-foreground-secondary">
        {state.page?.total ?? 0} / 200 entries
      </Text>
      {state.page?.enabled && (
        <View className="gap-2">
          <Text className="font-semibold text-foreground">
            {editing ? "Edit memory" : "New memory"}
          </Text>
          <View className="flex-row flex-wrap gap-2">
            {(["fact", "convention", "decision", "preference"] as const).map((value) => (
              <Action
                key={value}
                label={kind === value ? `${value} (selected)` : value}
                onPress={() => setKind(value)}
              />
            ))}
          </View>
          <TextInput
            accessibilityLabel="Memory text"
            multiline
            value={text}
            onChangeText={setText}
            className="min-h-24 rounded-lg border border-separator p-3 text-foreground"
          />
          <Text className="text-xs text-foreground-secondary">
            {Array.from(text).length} / 500 characters. Unpinned entries need review after 90 days.
          </Text>
          <Action
            label={editing ? "Save changes" : "Save memory"}
            disabled={state.busy || projectMemoryTextProblem(text) !== null}
            onPress={() => void save()}
          />
          {editing && (
            <Action
              label="Cancel edit"
              onPress={() => {
                setEditing(null);
                setText("");
              }}
            />
          )}
        </View>
      )}
      <TextInput
        accessibilityLabel="Search memories"
        placeholder="Search memories"
        value={query}
        onChangeText={setQuery}
        maxLength={200}
        onSubmitEditing={() => void controller.refresh(query, 0)}
        className="min-h-11 rounded-lg border border-separator p-3 text-foreground"
      />
      <Action
        label="Search"
        disabled={state.busy}
        onPress={() => void controller.refresh(query, 0)}
      />
      {state.busy && (
        <Text accessibilityLiveRegion="polite" className="text-foreground">
          Loading project memory…
        </Text>
      )}
      {state.page && !state.page.entries.length && (
        <Text className="text-foreground-secondary">No memories found.</Text>
      )}
      {state.page?.entries.map((entry) => (
        <View key={entry.id} className="gap-2 border-b border-separator pb-4">
          <Text selectable className="text-foreground">
            {entry.text}
          </Text>
          <Provenance entry={entry} />
          <Text className="text-xs text-foreground-secondary">
            {entry.pinned
              ? "Pinned"
              : projectMemoryNeedsReview(entry, Date.parse(state.page!.asOf))
                ? "Needs review"
                : "Current"}
          </Text>
          <View className="flex-row flex-wrap gap-2">
            <Action
              label={
                state.references.some((ref) => ref.id === entry.id)
                  ? "Deselect recall"
                  : "Select for recall"
              }
              disabled={
                state.busy ||
                !state.page?.enabled ||
                projectMemoryNeedsReview(entry, Date.parse(state.page!.asOf))
              }
              onPress={() => controller.toggleRecall(entry)}
            />
            <Action
              label="Edit"
              disabled={state.busy || !state.page?.enabled}
              onPress={() => {
                setEditing(entry);
                setText(entry.text);
                setKind(entry.kind);
              }}
            />
            <Action
              label={entry.pinned ? "Unpin" : "Pin"}
              disabled={state.busy || !state.page?.enabled}
              onPress={() =>
                void controller.mutate({
                  operation: "pin",
                  id: entry.id,
                  revision: entry.revision,
                  pinned: !entry.pinned,
                })
              }
            />
            <Action
              label="Still true"
              disabled={state.busy || !state.page?.enabled}
              onPress={() =>
                void controller.mutate({
                  operation: "affirm",
                  id: entry.id,
                  revision: entry.revision,
                })
              }
            />
            <Action label="Forget" disabled={state.busy} onPress={() => forget(entry)} />
          </View>
        </View>
      ))}
      <View className="flex-row gap-2">
        <Action
          label="Previous"
          disabled={state.busy || state.offset === 0}
          onPress={() => void controller.refresh(state.query, Math.max(0, state.offset - 50))}
        />
        <Action
          label="Next"
          disabled={state.busy || state.page?.nextOffset == null}
          onPress={() => void controller.refresh(state.query, state.page?.nextOffset ?? 0)}
        />
      </View>
      <ProjectMemoryNativeRecallPreview controller={controller} />
      <Text className="text-xs text-foreground-secondary">{PROJECT_MEMORY_DELETION_NOTICE}</Text>
    </ScrollView>
  );
}
