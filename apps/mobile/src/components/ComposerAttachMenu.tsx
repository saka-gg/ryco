import type { MenuAction } from "@react-native-menu/menu";
import type { ReactNode } from "react";

import { isCameraCaptureAvailable } from "../lib/cameraAvailability";
import type { ComposerAttachmentSource } from "../lib/composerFiles";
import { AnchoredMenu } from "./AnchoredMenu";

const SOURCES: ReadonlyArray<{
  readonly source: ComposerAttachmentSource;
  readonly title: string;
  readonly image: string;
}> = [
  { source: "library", title: "Photo Library", image: "photo.on.rectangle" },
  { source: "camera", title: "Take Photo", image: "camera" },
  { source: "files", title: "Choose Files", image: "folder" },
];

/**
 * The composer's attach button menu: photos, the camera, or any file from the
 * Files app. Both composers use it, so they offer the same sources.
 */
export function ComposerAttachMenu(props: {
  readonly disabled: boolean;
  readonly onPick: (source: ComposerAttachmentSource) => void;
  readonly onClose: () => void;
  readonly children: (open: () => void) => ReactNode;
}) {
  const cameraAvailable = isCameraCaptureAvailable();
  const actions: MenuAction[] = SOURCES.filter(
    (entry) => entry.source !== "camera" || cameraAvailable,
  ).map((entry) => ({
    id: entry.source,
    title: entry.title,
    image: entry.image,
    attributes: { disabled: props.disabled },
  }));
  return (
    <AnchoredMenu
      title="Attach"
      menuWidth={240}
      actions={actions}
      onClose={props.onClose}
      onPressAction={({ nativeEvent }) => {
        const entry = SOURCES.find((candidate) => candidate.source === nativeEvent.event);
        if (entry && !props.disabled) props.onPick(entry.source);
      }}
    >
      {props.children}
    </AnchoredMenu>
  );
}
