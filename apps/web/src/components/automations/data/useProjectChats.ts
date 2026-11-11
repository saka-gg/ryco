import { scopeProjectRef } from "@ryco/client-runtime/scoped";
import type { SidebarThreadOrStub } from "@ryco/client-runtime/state/threads";
import type { EnvironmentId, ProjectId } from "@ryco/contracts";
import { isChatProject, isChatsAutomationScope } from "@ryco/shared/projectKind";
import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";

import {
  selectProjectsForEnvironment,
  selectSidebarThreadsForProjectRef,
  selectSidebarThreadsForProjectRefs,
  useStore,
} from "../../../store";

const NO_PROJECT_IDS: readonly ProjectId[] = [];

/** A project's chats on one device, as the sidebar has them (archived ones included). */
export function useProjectChats(
  environmentId: EnvironmentId | null | undefined,
  projectId: ProjectId | null | undefined,
): readonly SidebarThreadOrStub[] {
  return useStore((state) =>
    selectSidebarThreadsForProjectRef(
      state,
      environmentId && projectId ? scopeProjectRef(environmentId, projectId) : null,
    ),
  );
}

/** The chats without a project on one device (each its own `chat` project), archived included. */
function useChatsWithoutProject(
  environmentId: EnvironmentId | null | undefined,
): readonly SidebarThreadOrStub[] {
  const chatProjectIds = useStore(
    useShallow((state) =>
      environmentId
        ? selectProjectsForEnvironment(state, environmentId)
            .filter(isChatProject)
            .map((project) => project.id)
        : NO_PROJECT_IDS,
    ),
  );
  // Stable while the chats are: the selector caches its rows by this array.
  const refs = useMemo(
    () =>
      environmentId
        ? chatProjectIds.map((projectId) => scopeProjectRef(environmentId, projectId))
        : [],
    [chatProjectIds, environmentId],
  );
  return useStore((state) => selectSidebarThreadsForProjectRefs(state, refs));
}

/**
 * The chats a schedule's runs can go into on one device: its project's, or in the "No
 * project" scope every chat without a project.
 */
export function useScheduleChats(
  environmentId: EnvironmentId | null | undefined,
  projectId: ProjectId | null | undefined,
): readonly SidebarThreadOrStub[] {
  const chats = isChatsAutomationScope(projectId);
  const projectChats = useProjectChats(environmentId, chats ? null : projectId);
  const chatsWithoutProject = useChatsWithoutProject(chats ? environmentId : null);
  return chats ? chatsWithoutProject : projectChats;
}
