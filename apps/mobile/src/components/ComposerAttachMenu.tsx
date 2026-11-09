import type { MenuAction } from "@react-native-menu/menu";
import type { ReactNode } from "react";

import { isCameraCaptureAvailable } from "../lib/cameraAvailability";
import type { ComposerAttachmentSource } from "../lib/composerFiles";
import { useThemeColor } from "../lib/useThemeColor";
import { AnchoredMenu } from "./AnchoredMenu";
import { type AppSymbolName, SymbolView } from "./AppSymbol";

const SOURCES: ReadonlyArray<{
  readonly source: ComposerAttachmentSource;
  readonly title: string;
}> = [
  { source: "library", title: "Photo Library" },
  { source: "camera", title: "Take Photo" },
  { source: "files", title: "Choose Files" },
];

const COMMANDS_ID = "#commands";
const MENTION_ID = "#mention";
const SIDE_CHAT_ID = "#side-chat";
const SIDE_CHAT_GROUP: ReadonlySet<string> = new Set([SIDE_CHAT_ID]);
// Icons lead the rows (the menu draws an action's `image` at the trailing edge instead).
const ICONS: Readonly<Record<string, AppSymbolName>> = {
  library: "photo.on.rectangle",
  camera: "camera",
  files: "folder",
  [COMMANDS_ID]: "slash.circle",
  [MENTION_ID]: "at",
  [SIDE_CHAT_ID]: "bubble.left.and.bubble.right",
};

/**
 * The composer's + menu: photos, the camera, or any file from the Files app. Both composers
 * use it, so they offer the same sources; the chat's composer adds `/` commands, an `@`
 * mention and the side chat.
 */
export function ComposerAttachMenu(props: {
  readonly disabled: boolean;
  readonly onPick: (source: ComposerAttachmentSource) => void;
  /** Starts a `/` command in the draft (the command popover takes it from there). */
  readonly onInsertCommand?: (() => void) | undefined;
  /** Starts an `@` file mention in the draft. */
  readonly onInsertMention?: (() => void) | undefined;
  readonly onOpenSideChat?: (() => void) | undefined;
  readonly onClose: () => void;
  readonly children: (open: () => void) => ReactNode;
}) {
  const iconColor = useThemeColor("--color-icon");
  const cameraAvailable = isCameraCaptureAvailable();
  const actions: MenuAction[] = SOURCES.filter(
    (entry) => entry.source !== "camera" || cameraAvailable,
  ).map((entry) => ({
    id: entry.source,
    title: entry.title,
    attributes: { disabled: props.disabled },
  }));
  if (props.onInsertCommand)
    actions.push({
      id: COMMANDS_ID,
      title: "Commands",
      attributes: { disabled: props.disabled },
    });
  if (props.onInsertMention)
    actions.push({
      id: MENTION_ID,
      title: "Mention a file",
      attributes: { disabled: props.disabled },
    });
  if (props.onOpenSideChat) actions.push({ id: SIDE_CHAT_ID, title: "Side chat" });
  return (
    <AnchoredMenu
      title="Attach"
      menuWidth={240}
      actions={actions}
      separatorBeforeIds={SIDE_CHAT_GROUP}
      onClose={props.onClose}
      renderIcon={(action) =>
        action.id !== undefined && ICONS[action.id] ? (
          <SymbolView name={ICONS[action.id]!} size={16} tintColor={iconColor} type="monochrome" />
        ) : null
      }
      onPressAction={({ nativeEvent }) => {
        if (nativeEvent.event === SIDE_CHAT_ID) {
          props.onOpenSideChat?.();
          return;
        }
        if (props.disabled) return;
        if (nativeEvent.event === COMMANDS_ID) {
          props.onInsertCommand?.();
          return;
        }
        if (nativeEvent.event === MENTION_ID) {
          props.onInsertMention?.();
          return;
        }
        const entry = SOURCES.find((candidate) => candidate.source === nativeEvent.event);
        if (entry) props.onPick(entry.source);
      }}
    >
      {props.children}
    </AnchoredMenu>
  );
}
