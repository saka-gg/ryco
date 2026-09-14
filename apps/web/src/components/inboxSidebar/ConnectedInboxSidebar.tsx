import { useCallback, useMemo, useRef } from "react";
import { useRouter } from "@tanstack/react-router";
import { scopedProjectKey, scopedThreadKey, scopeThreadRef } from "@ryco/client-runtime/scoped";
import type { ScopedProjectRef } from "@ryco/contracts";
import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import { useSidebarProjectDialogs } from "../sidebar/SidebarProjectDialogOwner";
import type { useThreadActions } from "../../hooks/useThreadActions";
import { useSettings } from "../../hooks/useSettings";
import { useUiStateStore } from "../../uiStateStore";
import { useThreadMenuActions } from "../sidebar/hooks/useThreadMenuActions";
import { useThreadClipboardActions } from "../sidebar/hooks/useThreadClipboardActions";
import { Dialog, DialogPopup, DialogTitle } from "../ui/dialog";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { InboxSidebar, type InboxSidebarProps } from "./InboxSidebar";

export function ConnectedInboxSidebar(
  props: InboxSidebarProps & { projectGroups: readonly SidebarProjectSnapshot[] } & Pick<
      ReturnType<typeof useThreadActions>,
      "archiveThread" | "deleteThread"
    >,
) {
  const router = useRouter();
  const projectDialogs = useSidebarProjectDialogs();
  const openProjectSettings = useCallback(
    (projectRef: ScopedProjectRef) => {
      const member = props.projectGroups
        .flatMap((group) => group.memberProjects)
        .find(
          (project) =>
            project.environmentId === projectRef.environmentId &&
            project.id === projectRef.projectId,
        );
      if (member) projectDialogs.openSettings(member);
    },
    [props.projectGroups, projectDialogs],
  );
  const { deleteThread, archiveThread } = props;
  const clipboard = useThreadClipboardActions();
  const appSettingsConfirmThreadDelete = useSettings((s) => s.confirmThreadDelete);
  const appSettingsConfirmThreadArchive = useSettings((s) => s.confirmThreadArchive);
  const appSettingsConfirmThreadUnpin = useSettings((s) => s.confirmThreadUnpin);
  const markThreadUnread = useUiStateStore((s) => s.markThreadUnread);
  const threadByKey = useMemo(
    () =>
      new Map(
        props.threads.map((thread) => [
          scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
          thread,
        ]),
      ),
    [props.threads],
  );
  const sidebarThreadByKeyRef = useRef(threadByKey);
  sidebarThreadByKeyRef.current = threadByKey;
  const memberProjectByScopedKey = useMemo(
    () =>
      new Map(
        props.projects.map((project) => [
          scopedProjectKey({ environmentId: project.environmentId, projectId: project.id }),
          project,
        ]),
      ),
    [props.projects],
  );
  const actions = useThreadMenuActions({
    router,
    deleteThread,
    archiveThread,
    ...clipboard,
    appSettingsConfirmThreadDelete,
    appSettingsConfirmThreadArchive,
    appSettingsConfirmThreadUnpin,
    markThreadUnread,
    sidebarThreadByKeyRef,
    memberProjectByScopedKey,
    projectCwd: null,
    openProjectSettings,
  });
  const renaming = actions.renamingThreadKey
    ? sidebarThreadByKeyRef.current.get(actions.renamingThreadKey)
    : undefined;
  return (
    <>
      <InboxSidebar {...props} threadActions={actions} />
      <Dialog
        open={Boolean(renaming)}
        onOpenChange={(open) => {
          if (!open) actions.cancelRename();
        }}
      >
        <DialogPopup className="max-w-sm p-5">
          <DialogTitle>Rename thread</DialogTitle>
          <form
            className="mt-4 space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (renaming)
                void actions.commitRename(
                  scopeThreadRef(renaming.environmentId, renaming.id),
                  actions.renamingTitle,
                  renaming.title,
                );
            }}
          >
            <Input
              aria-label="Thread title"
              autoFocus
              value={actions.renamingTitle}
              onChange={(event) => actions.setRenamingTitle(event.target.value)}
            />
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" onClick={actions.cancelRename}>
                Cancel
              </Button>
              <Button type="submit" disabled={!actions.renamingTitle.trim()}>
                Save
              </Button>
            </div>
          </form>
        </DialogPopup>
      </Dialog>
    </>
  );
}
