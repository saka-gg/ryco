import { usePaneEffect } from "./PaneFocus";
import type { EditorId, EnvironmentId, ResolvedKeybindingsConfig } from "@ryco/contracts";
import { memo, useCallback, useMemo } from "react";
import {
  isOpenFavoriteEditorShortcut,
  shouldIgnoreGlobalNavigationShortcut,
  shortcutLabelForCommand,
} from "../../keybindings";
import { isEditorPreferenceEligible, usePreferredEditor } from "../../editorPreferences";
import { CodeIcon } from "lucide-react";
import { Menu, MenuItem, MenuPopup, MenuShortcut, MenuTrigger } from "../ui/menu";
import { OverviewRailButton, OverviewRailMenuAction } from "../overview/OverviewRail";
import { resolveEditorOptions } from "../settings/SettingsPanels.editor";
import { readLocalApi } from "~/localApi";

/** Editors open local paths, so the picker only applies to this machine's threads. */
export function shouldShowOpenInPicker(input: {
  readonly activeProjectName: string | undefined;
  readonly activeThreadEnvironmentId: EnvironmentId;
  readonly primaryEnvironmentId: EnvironmentId | null;
}): boolean {
  return (
    Boolean(input.activeProjectName) &&
    input.primaryEnvironmentId !== null &&
    input.activeThreadEnvironmentId === input.primaryEnvironmentId
  );
}

/**
 * "Open in editor" as a desktop overview rail item. The row names the
 * preferred editor and opens it directly; its options menu opens the workspace
 * in any installed editor. The
 * favorite-editor shortcut stays live while the rail is mounted.
 */
export const OpenInPicker = memo(function OpenInPicker({
  keybindings,
  availableEditors,
  openInCwd,
}: {
  keybindings: ResolvedKeybindingsConfig;
  availableEditors: ReadonlyArray<EditorId>;
  openInCwd: string | null;
}) {
  const [preferredEditor, setPreferredEditor] = usePreferredEditor(availableEditors);
  const options = useMemo(
    () => resolveEditorOptions(navigator.platform, availableEditors),
    [availableEditors],
  );
  const primaryOption = options.find(({ value }) => value === preferredEditor) ?? null;

  const openInEditor = useCallback(
    (editorId: EditorId | null) => {
      const api = readLocalApi();
      if (!api || !openInCwd) return;
      const editor = editorId ?? preferredEditor;
      if (!editor) return;
      void api.shell
        .openInEditor(openInCwd, editor)
        .then(() => {
          if (isEditorPreferenceEligible(editor)) setPreferredEditor(editor);
        })
        .catch((error: unknown) => {
          console.error(`Failed to open ${editor}.`, error);
        });
    },
    [preferredEditor, openInCwd, setPreferredEditor],
  );

  const openFavoriteEditorShortcutLabel = useMemo(
    () => shortcutLabelForCommand(keybindings, "editor.openFavorite"),
    [keybindings],
  );

  usePaneEffect(() => {
    const handler = (e: globalThis.KeyboardEvent) => {
      const api = readLocalApi();
      if (shouldIgnoreGlobalNavigationShortcut(e)) return;
      if (!isOpenFavoriteEditorShortcut(e, keybindings)) return;
      if (!api || !openInCwd) return;
      if (!preferredEditor) return;

      e.preventDefault();
      void api.shell.openInEditor(openInCwd, preferredEditor);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [preferredEditor, keybindings, openInCwd]);

  const menuItems = (
    <>
      {options.length === 0 && <MenuItem disabled>No installed editors found</MenuItem>}
      {options.map(({ label, Icon, value }) => (
        <MenuItem key={value} onClick={() => openInEditor(value)}>
          <Icon aria-hidden="true" className="text-muted-foreground" />
          {label}
          {value === preferredEditor && openFavoriteEditorShortcutLabel && (
            <MenuShortcut>{openFavoriteEditorShortcutLabel}</MenuShortcut>
          )}
        </MenuItem>
      ))}
    </>
  );

  if (!primaryOption) {
    return (
      <Menu>
        <MenuTrigger
          render={
            <OverviewRailButton icon={<CodeIcon />} label="Open in editor" disabled={!openInCwd} />
          }
        />
        <MenuPopup side="left" align="start" sideOffset={10}>
          {menuItems}
        </MenuPopup>
      </Menu>
    );
  }

  const PrimaryIcon = primaryOption.Icon;
  return (
    <OverviewRailMenuAction
      icon={<PrimaryIcon aria-hidden="true" />}
      label={`Open in ${primaryOption.label}`}
      value={openFavoriteEditorShortcutLabel ?? undefined}
      disabled={!openInCwd}
      onClick={() => openInEditor(null)}
      optionsLabel="Choose editor"
      optionsDisabled={!openInCwd}
    >
      {menuItems}
    </OverviewRailMenuAction>
  );
});
