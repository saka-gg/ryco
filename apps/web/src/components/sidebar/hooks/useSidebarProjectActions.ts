import { useCallback } from "react";
import { scopedProjectKey, scopeProjectRef } from "@ryco/client-runtime/scoped";
import { readLocalApi } from "../../../localApi";
import {
  describeProjectRemoval,
  openProjectRemote,
  removeProjectCheckout,
} from "../../../projectMutations";
import { selectSidebarThreadsForProjectRefs, useStore } from "../../../store";
import type { SidebarProjectGroupMember } from "../../../sidebarProjectGrouping";
import { stackedThreadToast, toastManager } from "../../ui/toast";

export function useSidebarProjectActions(params: {
  memberThreadCountByPhysicalKey: ReadonlyMap<string, number>;
  jiraProjectOpenUrlByProjectKey: ReadonlyMap<string, string>;
}) {
  const { memberThreadCountByPhysicalKey, jiraProjectOpenUrlByProjectKey } = params;

  const openProjectRemoteLink = useCallback(
    (member: SidebarProjectGroupMember) => openProjectRemote(member),
    [],
  );

  const openProjectJiraLink = useCallback(
    (member: SidebarProjectGroupMember) => {
      const url =
        jiraProjectOpenUrlByProjectKey.get(
          scopedProjectKey(scopeProjectRef(member.environmentId, member.id)),
        ) ?? null;
      if (!url) {
        toastManager.add({
          type: "warning",
          title: "No Jira project link available",
        });
        return;
      }

      const api = readLocalApi();
      if (!api) {
        toastManager.add({
          type: "error",
          title: "Link opening is unavailable.",
        });
        return;
      }

      void api.shell.openExternal(url).catch((error) => {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Unable to open Jira project",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      });
    },
    [jiraProjectOpenUrlByProjectKey],
  );

  const removeProject = useCallback(
    (member: SidebarProjectGroupMember, options: { force?: boolean } = {}): Promise<void> =>
      removeProjectCheckout(member, options),
    [],
  );

  const handleRemoveProject = useCallback(
    async (member: SidebarProjectGroupMember) => {
      const api = readLocalApi();
      if (!api) {
        return;
      }

      const memberProjectRef = scopeProjectRef(member.environmentId, member.id);
      const memberThreadCount = memberThreadCountByPhysicalKey.get(member.physicalProjectKey) ?? 0;
      if (memberThreadCount > 0) {
        const warningToastId = toastManager.add(
          stackedThreadToast({
            type: "warning",
            title: "Project is not empty",
            description: "Delete all threads in this project before removing it.",
            actionVariant: "destructive",
            actionProps: {
              children: "Delete anyway",
              onClick: () => {
                void (async () => {
                  toastManager.close(warningToastId);
                  await new Promise<void>((resolve) => {
                    window.setTimeout(resolve, 180);
                  });

                  const latestProjectThreads = selectSidebarThreadsForProjectRefs(
                    useStore.getState(),
                    [memberProjectRef],
                  );
                  const removal = describeProjectRemoval({
                    ...member,
                    threadCount: latestProjectThreads.length,
                  });
                  const confirmed = await api.dialogs.confirm(
                    [removal.title, ...removal.lines].join("\n"),
                  );
                  if (!confirmed) {
                    return;
                  }

                  await removeProject(member, { force: true });
                })().catch((error) => {
                  const message =
                    error instanceof Error ? error.message : "Unknown error removing project.";
                  console.error("Failed to remove project", {
                    projectId: member.id,
                    environmentId: member.environmentId,
                    error,
                  });
                  toastManager.add(
                    stackedThreadToast({
                      type: "error",
                      title: `Failed to remove "${member.name}"`,
                      description: message,
                    }),
                  );
                });
              },
            },
          }),
        );
        return;
      }

      const removal = describeProjectRemoval({ ...member, threadCount: 0 });
      const confirmed = await api.dialogs.confirm([removal.title, ...removal.lines].join("\n"));
      if (!confirmed) {
        return;
      }

      try {
        await removeProject(member);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error removing project.";
        console.error("Failed to remove project", {
          projectId: member.id,
          environmentId: member.environmentId,
          error,
        });
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: `Failed to remove "${member.name}"`,
            description: message,
          }),
        );
      }
    },
    [memberThreadCountByPhysicalKey, removeProject],
  );

  return {
    openProjectRemoteLink,
    openProjectJiraLink,
    removeProject,
    handleRemoveProject,
  };
}
