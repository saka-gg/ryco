import { EDITORS, EditorId, type EnvironmentId, LocalApi } from "@ryco/contracts";
import { REMOTE_CAPABLE_EDITOR_IDS, buildRemoteEditorLink } from "@ryco/shared/remoteEditorLink";
import { getLocalStorageItem, setLocalStorageItem, useLocalStorage } from "./hooks/useLocalStorage";
import { useMemo } from "react";
import { getClientSettings } from "./hooks/useSettings";
import { toastManager } from "./components/ui/toast";
import { resolveEditorOpenRoute, type EditorOpenRoute } from "./editorOpenRoute";
import { getPrimaryKnownEnvironment } from "./environments/primary";
import { getSavedEnvironmentRecord } from "./environments/runtime/catalog";
import { readLocalApi } from "./localApi";
import { useSettings } from "./hooks/useSettings";

const LAST_EDITOR_KEY = "ryco:last-editor";

export function isEditorPreferenceEligible(editorId: EditorId): boolean {
  const editor = EDITORS.find((candidate) => candidate.id === editorId);
  return Boolean(editor && (!("workspaceOnly" in editor) || !editor.workspaceOnly));
}

export function usePreferredEditor(availableEditors: ReadonlyArray<EditorId>) {
  const [lastEditor, setLastEditor] = useLocalStorage(LAST_EDITOR_KEY, null, EditorId);
  const pinnedEditor = useSettings((s) => s.preferredEditor);

  const effectiveEditor = useMemo(() => {
    if (
      pinnedEditor &&
      availableEditors.includes(pinnedEditor) &&
      isEditorPreferenceEligible(pinnedEditor)
    ) {
      return pinnedEditor;
    }
    if (
      lastEditor &&
      availableEditors.includes(lastEditor) &&
      isEditorPreferenceEligible(lastEditor)
    ) {
      return lastEditor;
    }
    return (
      EDITORS.find(
        (editor) => availableEditors.includes(editor.id) && isEditorPreferenceEligible(editor.id),
      )?.id ?? null
    );
  }, [pinnedEditor, lastEditor, availableEditors]);

  return [effectiveEditor, setLastEditor] as const;
}

export function resolveAndPersistPreferredEditor(
  availableEditors: readonly EditorId[],
): EditorId | null {
  const availableEditorIds = new Set(availableEditors);
  const pinned = getClientSettings().preferredEditor;
  if (pinned && availableEditorIds.has(pinned) && isEditorPreferenceEligible(pinned)) return pinned;
  const stored = getLocalStorageItem(LAST_EDITOR_KEY, EditorId);
  if (stored && availableEditorIds.has(stored) && isEditorPreferenceEligible(stored)) return stored;
  const editor =
    EDITORS.find(
      (candidate) =>
        availableEditorIds.has(candidate.id) && isEditorPreferenceEligible(candidate.id),
    )?.id ?? null;
  if (editor) setLocalStorageItem(LAST_EDITOR_KEY, editor, EditorId);
  return editor ?? null;
}

export async function openInPreferredEditor(api: LocalApi, targetPath: string): Promise<EditorId> {
  const { availableEditors } = await api.server.getConfig();
  const editor = resolveAndPersistPreferredEditor(availableEditors);
  if (!editor) throw new Error("No available editors found.");
  await api.shell.openInEditor(targetPath, editor);
  return editor;
}

/** The route for `environmentId` as this app knows it now. */
export function readEditorOpenRoute(
  environmentId: EnvironmentId | null | undefined,
): EditorOpenRoute {
  return resolveEditorOpenRoute({
    environmentId,
    primaryEnvironmentId: getPrimaryKnownEnvironment()?.environmentId ?? null,
    sshTarget:
      environmentId === null || environmentId === undefined
        ? null
        : getSavedEnvironmentRecord(environmentId)?.desktopSsh,
  });
}

/**
 * Whether Open in editor can do anything for a path on `environmentId`. The
 * primary environment is passed in, so a component that reads it from its
 * hook re-renders when it changes.
 */
export function canOpenInEditor(
  environmentId: EnvironmentId | null | undefined,
  primaryEnvironmentId: EnvironmentId | null,
): boolean {
  if (readLocalApi() === undefined) return false;
  return (
    resolveEditorOpenRoute({
      environmentId,
      primaryEnvironmentId,
      sshTarget:
        environmentId === null || environmentId === undefined
          ? null
          : getSavedEnvironmentRecord(environmentId)?.desktopSsh,
    }).kind !== "unavailable"
  );
}

async function openRemoteInEditor(
  api: LocalApi,
  route: Extract<EditorOpenRoute, { kind: "remote-ssh" }>,
  target: string,
): Promise<EditorId> {
  // This computer's editors: the primary environment is this computer.
  const { availableEditors } = await api.server.getConfig();
  const editor = resolveAndPersistPreferredEditor(
    availableEditors.filter((candidate) => REMOTE_CAPABLE_EDITOR_IDS.includes(candidate)),
  );
  if (!editor) {
    throw new Error("No editor here can open files over SSH. Install VS Code, Cursor or Zed.");
  }
  const link = buildRemoteEditorLink({
    editor,
    host: route.host,
    username: route.username,
    target,
  });
  if (link === undefined) throw new Error("This editor can't open files over SSH.");
  await api.shell.openExternal(link);
  return editor;
}

/**
 * Opens `target` (a path on `environmentId`, optionally ending in `:line` or
 * `:line:column`) in the preferred editor, or rejects with a message for the
 * user.
 */
export async function openPathInEditor(
  environmentId: EnvironmentId | null | undefined,
  target: string,
): Promise<EditorId> {
  const api = readLocalApi();
  if (!api) throw new Error("No local editor bridge is available.");
  const route = readEditorOpenRoute(environmentId);
  switch (route.kind) {
    case "local":
      return openInPreferredEditor(api, target);
    case "remote-ssh":
      return openRemoteInEditor(api, route, target);
    case "unavailable":
      throw new Error(route.reason);
  }
}

/** {@link openPathInEditor} for surfaces without their own failure notice. */
export function openPathInEditorWithToast(
  environmentId: EnvironmentId | null | undefined,
  target: string,
): void {
  void openPathInEditor(environmentId, target).catch((error: unknown) => {
    toastManager.add({
      type: "error",
      title: "Unable to open file",
      description: error instanceof Error ? error.message : "An error occurred.",
    });
  });
}
