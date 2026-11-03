import { useEffect } from "react";

import { useDesktopUpdateState } from "../rpc/desktopUpdateAtoms";
import { toastManager } from "../components/ui/toast";
import { selectUpdatedNotice, UPDATED_NOTICE_SHOWN_KEY } from "./updatedNotice.logic";

function readShownVersion(): string | null {
  try {
    return window.localStorage.getItem(UPDATED_NOTICE_SHOWN_KEY);
  } catch {
    return null;
  }
}

function writeShownVersion(version: string): void {
  try {
    window.localStorage.setItem(UPDATED_NOTICE_SHOWN_KEY, version);
  } catch {
    // Without storage the notice can show again in another window; nothing worse.
  }
}

/**
 * "Updated to X" once, on the first launch after an update this desktop app installed (at
 * Restart or when it quit). Mount once, in the desktop app only.
 */
export function DesktopUpdatedNotice() {
  const notice = selectUpdatedNotice(useDesktopUpdateState(), readShownVersion());
  const version = notice?.version ?? null;
  const title = notice?.title ?? null;
  const description = notice?.description ?? null;

  useEffect(() => {
    if (version === null || title === null || description === null) return;
    writeShownVersion(version);
    toastManager.add({ type: "success", title, description });
  }, [description, title, version]);

  return null;
}
