import { usePaneEffect } from "./PaneFocus";
import { EditorId, type ResolvedKeybindingsConfig } from "@ryco/contracts";
import { memo, useCallback, useMemo } from "react";
import {
  isOpenFavoriteEditorShortcut,
  shouldIgnoreGlobalNavigationShortcut,
  shortcutLabelForCommand,
} from "../../keybindings";
import { isEditorPreferenceEligible, usePreferredEditor } from "../../editorPreferences";
import { ChevronDownIcon } from "lucide-react";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuShortcut, MenuTrigger } from "../ui/menu";
import {
  HEADER_CHROME_BUTTON_CLASS_NAME,
  HEADER_CHROME_GROUP_CLASS_NAME,
  HEADER_CHROME_ICON_BUTTON_CLASS_NAME,
} from "./headerChrome";
import { resolveEditorOptions } from "../settings/SettingsPanels.editor";
import { readLocalApi } from "~/localApi";

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

  return (
    <div aria-label="Subscription actions" className={HEADER_CHROME_GROUP_CLASS_NAME} role="group">
      <Button
        size="xs"
        variant="ghost"
        className={HEADER_CHROME_BUTTON_CLASS_NAME}
        disabled={!preferredEditor || !openInCwd}
        onClick={() => openInEditor(preferredEditor)}
      >
        {primaryOption?.Icon && <primaryOption.Icon aria-hidden="true" className="size-3.5" />}
        <span className="sr-only @3xl/header-actions:not-sr-only @3xl/header-actions:ml-0.5">
          Open
        </span>
      </Button>
      <Menu>
        <MenuTrigger
          render={
            <Button
              aria-label="Copy options"
              className={HEADER_CHROME_ICON_BUTTON_CLASS_NAME}
              size="icon-xs"
              variant="ghost"
            />
          }
        >
          <ChevronDownIcon aria-hidden="true" className="size-4" />
        </MenuTrigger>
        <MenuPopup align="end">
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
        </MenuPopup>
      </Menu>
    </div>
  );
});
