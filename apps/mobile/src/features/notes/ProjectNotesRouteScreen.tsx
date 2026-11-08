import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import {
  noteWorktreeKey,
  notesDocumentKey,
  projectNotesKey,
  retainProjectNotes,
  selectNotesDocument,
  selectProjectNotesState,
  useNotesStore,
  type ProjectNotesSync,
} from "@ryco/client-runtime/state/notes";
import type { NoteScope, NotesApi, NotesCommand, NotesSnapshot } from "@ryco/contracts";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Alert, Pressable, TextInput, View } from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";

import { AppText as Text } from "../../components/AppText";
import { EmptyState } from "../../components/EmptyState";
import { ErrorBanner } from "../../components/ErrorBanner";
import { SegmentedControl } from "../../components/SegmentedControl";
import { useEnvironmentApi } from "../../connection/useEnvironmentApi";
import { errorMessageOr } from "../../lib/errorMessage";
import { useThemeColor } from "../../lib/useThemeColor";
import {
  useSourceControlTarget,
  type SourceControlRouteParams,
} from "../sourceControl/useSourceControlTarget";
import { useEnvironmentMutationReady } from "../home/useEnvironmentMutationReady";
import {
  notesEditorState,
  notesScopeOptions,
  notesStatusLabel,
  unsavedNoteScopes,
} from "./notesModel";

type ProjectNotesRouteProps = StaticScreenProps<SourceControlRouteParams>;

type Draft = { readonly body: string; readonly baseRevision: number };

/** Sends one save; null (with the error shown) when the node did not confirm it. */
async function sendNotesCommand(
  api: NotesApi,
  command: NotesCommand,
  setError: (error: string) => void,
): Promise<NotesSnapshot | null> {
  try {
    return await api.command(command);
  } catch (cause) {
    setError(errorMessageOr(cause, "Couldn't confirm your notes were saved. Try again."));
    return null;
  }
}

/**
 * The checkout's and the project's notes — the same documents the desktop's
 * Notes pane edits. Typing stays on this device until Save (or leaving the
 * screen); a save made elsewhere meanwhile is shown, and saving keeps the
 * text typed here, as on the desktop.
 */
export function ProjectNotesRouteScreen(props: ProjectNotesRouteProps) {
  const navigation = useNavigation();
  const target = useSourceControlTarget(props.route.params);
  const { environmentId, projectId, worktree } = target;
  const api = useEnvironmentApi(environmentId)?.notes;
  const available = target.capabilities?.worktreeNotes === true && api !== undefined;
  const syncRef = useRef<ProjectNotesSync | null>(null);
  const [scope, setScope] = useState<NoteScope>("worktree");
  const [drafts, setDrafts] = useState<Partial<Record<NoteScope, Draft>>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textColor = useThemeColor("--color-foreground");
  const placeholderColor = useThemeColor("--color-placeholder");

  useEffect(() => {
    if (!api || !environmentId || !projectId || !available) return;
    const sync = retainProjectNotes(api, environmentId, projectId);
    syncRef.current = sync;
    return () => {
      syncRef.current = null;
      sync.release();
    };
  }, [api, available, environmentId, projectId]);

  const key = environmentId && projectId ? projectNotesKey(environmentId, projectId) : "";
  const notes = useNotesStore((state) => selectProjectNotesState(state, key));
  const worktreeKey = worktree
    ? noteWorktreeKey({ worktreeId: worktree.id, origin: worktree.origin })
    : null;
  const worktreeOf = (which: NoteScope) => (which === "project" ? null : worktreeKey);
  const documentOf = (which: NoteScope) =>
    selectNotesDocument(notes.snapshot, which, worktreeOf(which));
  const document = documentOf(scope);
  const draft = drafts[scope] ?? null;
  const editor = notesEditorState(document, draft, saving);
  const mutable = useEnvironmentMutationReady(environmentId);

  /** Saves one scope's typed text; true once the node confirmed it (or nothing was typed). */
  const saveScope = async (which: NoteScope): Promise<boolean> => {
    const typed = drafts[which];
    if (!typed) return true;
    const current = documentOf(which);
    if (notesEditorState(current, typed, false).status === "tooLong") return false;
    if (!api || !projectId || !mutable || target.worktreeMissing) return false;
    const command: NotesCommand = {
      kind: "save",
      projectId,
      scope: which,
      worktreeId: worktreeOf(which),
      body: typed.body,
      // The person typing wins: save over whatever the node holds now.
      expectedRevision: current ? current.revision : 0,
    };
    setSaving(true);
    setError(null);
    const snapshot = await sendNotesCommand(api, command, setError);
    setSaving(false);
    if (!snapshot) return false;
    syncRef.current?.applySnapshot(snapshot);
    const saved = selectNotesDocument(snapshot, which, worktreeOf(which));
    if (saved)
      useNotesStore
        .getState()
        .markOwn(key, notesDocumentKey(which, worktreeOf(which)), saved.revision);
    setDrafts((latest) => ({ ...latest, [which]: undefined }));
    return true;
  };
  const save = () => void saveScope(scope);

  // Leaving with typed text asks: save it (both scopes), discard it, or stay.
  const unsaved = unsavedNoteScopes(drafts, documentOf);
  useEffect(() =>
    navigation.addListener("beforeRemove", (event) => {
      if (unsaved.length === 0 || saving) return;
      event.preventDefault();
      Alert.alert("Save your notes?", "Some notes are not saved to the machine yet.", [
        { text: "Keep editing", style: "cancel" },
        {
          text: "Discard",
          style: "destructive",
          onPress: () => navigation.dispatch(event.data.action),
        },
        {
          text: "Save",
          onPress: () => {
            void (async () => {
              for (const which of unsaved) if (!(await saveScope(which))) return;
              navigation.dispatch(event.data.action);
            })();
          },
        },
      ]);
    }),
  );

  const canSave =
    mutable && draft !== null && (editor.status === "unsaved" || editor.status === "conflict");
  useLayoutEffect(() => {
    navigation.setOptions({
      headerRight: () => (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Save notes"
          accessibilityState={{ disabled: !canSave }}
          disabled={!canSave}
          onPress={save}
          hitSlop={8}
          className="h-9 justify-center rounded-full bg-primary px-4 active:opacity-75 disabled:opacity-35"
        >
          <Text className="text-[14px] font-ryco-bold text-primary-foreground">Save</Text>
        </Pressable>
      ),
    });
  });

  if (target.worktreeMissing) {
    // Never fall back to the main checkout's notes for a worktree this device does not know yet.
    return (
      <View className="flex-1 bg-screen px-5 py-16">
        <EmptyState
          variant="plain"
          title="Worktree unavailable"
          detail="This worktree has not loaded on this device yet. Reconnect and try again."
        />
      </View>
    );
  }

  if (!available) {
    return (
      <View className="flex-1 bg-screen px-5 py-16">
        <EmptyState
          variant="plain"
          title="Notes unavailable"
          detail={
            api === undefined
              ? `${target.environmentLabel} is not connected.`
              : "Update Ryco on this machine to use notes from the phone."
          }
        />
      </View>
    );
  }

  return (
    <KeyboardAvoidingView behavior="padding" className="flex-1 bg-screen">
      <View className="gap-2 px-4 pb-2 pt-3">
        <SegmentedControl
          value={scope}
          onChange={setScope}
          options={notesScopeOptions(worktree ? worktree.title?.trim() || worktree.branch : null)}
        />
        <Text className="px-1 text-[12px] text-foreground-muted">
          {notes.status === "loading" && !notes.snapshot
            ? "Reading notes…"
            : `${target.project?.name ?? "Project"} · ${notesStatusLabel(editor.status)}`}
        </Text>
        {(error ?? notes.error) ? <ErrorBanner message={(error ?? notes.error) as string} /> : null}
      </View>
      <TextInput
        accessibilityLabel={scope === "project" ? "Project notes" : "Checkout notes"}
        multiline
        textAlignVertical="top"
        value={editor.body}
        editable={!saving && notes.snapshot !== null}
        onChangeText={(body) =>
          setDrafts((current) => ({
            ...current,
            [scope]: { body, baseRevision: current[scope]?.baseRevision ?? editor.baseRevision },
          }))
        }
        placeholder={
          scope === "project"
            ? "Notes for everyone working on this project…"
            : "Notes for this checkout: what's done, what's next…"
        }
        placeholderTextColor={placeholderColor as string}
        className="flex-1 px-5 py-2 font-sans text-[16px] leading-6"
        style={{ color: textColor as string }}
      />
    </KeyboardAvoidingView>
  );
}
