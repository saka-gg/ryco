import type { RefObject } from "react";
import { useRouter } from "@tanstack/react-router";
import { type ThreadEnvMode } from "@ryco/contracts";

import { useSettings } from "~/hooks/useSettings";
import { useNewThreadHandler } from "../../../hooks/useHandleNewThread";
import { useThreadActions } from "../../../hooks/useThreadActions";
import type { SidebarProjectGroupMember } from "../../../sidebarProjectGrouping";
import { useThreadSelectionStore } from "../../../threadSelectionStore";
import { useUiStateStore } from "../../../uiStateStore";
import type { SidebarThreadSummary } from "../../../types";
import { useSidebar } from "../../ui/sidebar";
import { useSidebarThreadActions } from "../../sidebar/hooks/useSidebarThreadActions";
import { useThreadClipboardActions } from "../../sidebar/hooks/useThreadClipboardActions";

/**
 * Phone wiring for the shared sidebar thread actions. The handlers themselves
 * live in `useSidebarThreadActions` (identical to the desktop sidebar rows);
 * this hook only gathers the standard store and settings dependencies so
 * phone surfaces (Home rows, the thread kebab sheet) can present the same
 * action inventory through the bottom-sheet presenter.
 */
export function usePhoneThreadActions(params: {
  readonly sidebarThreadByKeyRef: RefObject<ReadonlyMap<string, SidebarThreadSummary>>;
  readonly memberProjectByScopedKey: ReadonlyMap<string, SidebarProjectGroupMember>;
  readonly projectCwd: string | null;
}) {
  const router = useRouter();
  const { isMobile, setOpenMobile } = useSidebar();
  const appSettingsConfirmThreadDelete = useSettings<boolean>(
    (settings) => settings.confirmThreadDelete,
  );
  const appSettingsConfirmThreadArchive = useSettings<boolean>(
    (settings) => settings.confirmThreadArchive,
  );
  const appSettingsConfirmThreadUnpin = useSettings<boolean>(
    (settings) => settings.confirmThreadUnpin,
  );
  const defaultThreadEnvMode = useSettings<ThreadEnvMode>(
    (settings) => settings.defaultThreadEnvMode,
  );
  const { archiveThread, trashThread, stopThreadSession, interruptThreadTurn } = useThreadActions();
  const { handleNewThread } = useNewThreadHandler();
  const markThreadUnread = useUiStateStore((state) => state.markThreadUnread);
  const toggleThreadSelection = useThreadSelectionStore((state) => state.toggleThread);
  const rangeSelectTo = useThreadSelectionStore((state) => state.rangeSelectTo);
  const clearSelection = useThreadSelectionStore((state) => state.clearSelection);
  const removeFromSelection = useThreadSelectionStore((state) => state.removeFromSelection);
  const setSelectionAnchor = useThreadSelectionStore((state) => state.setAnchor);
  const selectedThreadCount = useThreadSelectionStore((state) => state.selectedThreadKeys.size);
  const { copyThreadIdToClipboard, copyPathToClipboard } = useThreadClipboardActions();

  return useSidebarThreadActions({
    router,
    isMobile,
    setOpenMobile,
    clearSelection,
    setSelectionAnchor,
    toggleThreadSelection,
    rangeSelectTo,
    removeFromSelection,
    selectedThreadCount,
    appSettingsConfirmThreadDelete,
    appSettingsConfirmThreadArchive,
    appSettingsConfirmThreadUnpin,
    defaultThreadEnvMode,
    trashThread,
    archiveThread,
    stopThreadSession,
    interruptThreadTurn,
    handleNewThread,
    markThreadUnread,
    copyPathToClipboard,
    copyThreadIdToClipboard,
    sidebarThreadByKeyRef: params.sidebarThreadByKeyRef,
    memberProjectByScopedKey: params.memberProjectByScopedKey,
    projectCwd: params.projectCwd,
  });
}
