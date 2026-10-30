import { scopeProjectRef } from "@ryco/client-runtime/scoped";
import type { SidebarThreadOrStub } from "@ryco/client-runtime/state/threads";
import type { EnvironmentId, ProjectId } from "@ryco/contracts";

import { selectSidebarThreadsForProjectRef, useStore } from "../../../store";

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
