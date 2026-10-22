// FILE: ProjectCopyViewBridge.tsx
// Purpose: Lets a finished copy's toast ("X is ready on Y · View") open a
//          new-thread draft in the new project: registers the app's new-thread
//          handler with `copyManager`, which runs outside React.
// Layer: Web copy runtime, mounted by `ProjectNodesDialogs` (lazy) while it is.

import { useEffect } from "react";

import { useNewThreadHandler } from "../../../hooks/useHandleNewThread";
import { registerProjectCopyViewer } from "./copyManager";

export function ProjectCopyViewBridge() {
  // The new-thread handler resolves the project's draft (reusing one the
  // logical project already has) and, through the Hub, waits for the
  // destination's mutation lease before the draft route adopts that node.
  const { handleNewThread } = useNewThreadHandler();
  useEffect(
    () => registerProjectCopyViewer((projectRef) => handleNewThread(projectRef)),
    [handleNewThread],
  );
  return null;
}
