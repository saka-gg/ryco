import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "@tanstack/react-router";
import { scopedProjectKey, scopedThreadKey, scopeThreadRef } from "@ryco/client-runtime/scoped";
import { WS_METHODS, type ScopedProjectRef } from "@ryco/contracts";
import { inboxDraftThreadSummary } from "@ryco/client-runtime/state/threads";
import { useComposerDraftStore } from "../../composerDraftStore";
import { buildProjectsPageLocation } from "../../projectsRoute";
import { useCommandPaletteStore } from "../../commandPaletteStore";
import { useHostedRpcCapability } from "../../hostedHub/capabilities";
import type { useThreadActions } from "../../hooks/useThreadActions";
import { useSettings } from "../../hooks/useSettings";
import { isUnarchivedThreadEntry } from "../../types";
import { useUiStateStore } from "../../uiStateStore";
import { useChatRowMenuContext } from "../sidebar/hooks/useChatRowMenuContext";
import { useThreadMenuActions } from "../sidebar/hooks/useThreadMenuActions";
import { useThreadClipboardActions } from "../sidebar/hooks/useThreadClipboardActions";
import { Dialog, DialogPopup, DialogTitle } from "../ui/dialog";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { createInboxDraftsSelector } from "./inboxDrafts";
import { InboxSidebar, type InboxSidebarProps } from "./InboxSidebar";

export function ConnectedInboxSidebar(
  props: InboxSidebarProps &
    Pick<
      ReturnType<typeof useThreadActions>,
      "archiveThread" | "deleteThread" | "stopThreadSession" | "interruptThreadTurn"
    >,
) {
  const router = useRouter();
  const openAddProject = useCommandPaletteStore((store) => store.openAddProject);
  // Adding opens the command palette, which gates the same action on the routed node.
  // hosted-capability: routed node
  const addProjectCapability = useHostedRpcCapability(WS_METHODS.projectsAdd, null);
  const openProjectSettings = useCallback(
    (projectRef: ScopedProjectRef) => {
      void router.navigate(
        buildProjectsPageLocation({
          environmentId: projectRef.environmentId,
          projectId: projectRef.projectId,
          view: "settings",
        }),
      );
    },
    [router],
  );
  const { deleteThread, archiveThread, stopThreadSession, interruptThreadTurn } = props;
  const clipboard = useThreadClipboardActions();
  const appSettingsConfirmThreadDelete = useSettings((s) => s.confirmThreadDelete);
  const appSettingsConfirmThreadArchive = useSettings((s) => s.confirmThreadArchive);
  const appSettingsConfirmThreadUnpin = useSettings((s) => s.confirmThreadUnpin);
  const markThreadUnread = useUiStateStore((s) => s.markThreadUnread);
  // Drafts the composer holds content for; the selector keeps its result while
  // typing only changes a prompt past its title.
  const [selectDrafts] = useState(createInboxDraftsSelector);
  const drafts = useComposerDraftStore(selectDrafts);
  // Menus act on inbox rows, which are all unarchived (never stubs). A draft row
  // carries its draft id, so its menu offers only discarding it.
  const threadByKey = useMemo(
    () =>
      // Server threads come last: one the draft already became wins over it.
      new Map([
        ...drafts.map(
          (draft) =>
            [
              scopedThreadKey(scopeThreadRef(draft.environmentId, draft.threadId)),
              { ...inboxDraftThreadSummary(draft), draftId: draft.draftId },
            ] as const,
        ),
        ...props.threads
          .filter(isUnarchivedThreadEntry)
          .map(
            (thread) =>
              [scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)), thread] as const,
          ),
      ]),
    [drafts, props.threads],
  );
  // Read by menu callbacks; synced after render so the React Compiler can
  // optimize this component (render-time ref writes make it bail out).
  const sidebarThreadByKeyRef = useRef(threadByKey);
  useLayoutEffect(() => {
    sidebarThreadByKeyRef.current = threadByKey;
  }, [threadByKey]);
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
  const chat = useChatRowMenuContext();
  const actions = useThreadMenuActions({
    router,
    deleteThread,
    archiveThread,
    stopThreadSession,
    interruptThreadTurn,
    includeWorkspaceSubmenu: true,
    chat,
    includeMoveToProject: true,
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
    ? threadByKey.get(actions.renamingThreadKey)
    : undefined;
  return (
    <>
      <InboxSidebar
        {...props}
        drafts={drafts}
        threadActions={actions}
        onAddProject={addProjectCapability.allowed ? openAddProject : undefined}
      />
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
