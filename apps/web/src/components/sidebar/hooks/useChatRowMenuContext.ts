import { scopeProjectRef, scopeThreadRef } from "@ryco/client-runtime/scoped";
import { isChatProject } from "@ryco/shared/projectKind";
import { useMemo } from "react";

import { usePrimaryEnvironmentId } from "../../../environments/primary";
import { selectProjectByRef, useStore } from "../../../store";
import type { SidebarThreadSummary } from "../../../types";
import { type ChatRowMenuSubject, useChatRowMenuExtensions } from "../chatRowMenu";

/**
 * The `chat` parameter of `useThreadMenuActions`: resolves the chat behind a
 * thread row (reading the store when a menu opens) and carries the chat menu
 * extensions. Shared by every surface that lists chat threads.
 */
export function useChatRowMenuContext() {
  const extensions = useChatRowMenuExtensions();
  const localEnvironmentId = usePrimaryEnvironmentId();
  return useMemo(
    () => ({
      resolveSubject: (thread: SidebarThreadSummary): ChatRowMenuSubject | null => {
        const projectRef = scopeProjectRef(thread.environmentId, thread.projectId);
        const project = selectProjectByRef(useStore.getState(), projectRef);
        if (!isChatProject(project)) return null;
        return {
          threadRef: scopeThreadRef(thread.environmentId, thread.id),
          projectRef,
          title: thread.title,
          folderPath: project?.cwd ?? null,
        };
      },
      extensions,
      localEnvironmentId,
    }),
    [extensions, localEnvironmentId],
  );
}
