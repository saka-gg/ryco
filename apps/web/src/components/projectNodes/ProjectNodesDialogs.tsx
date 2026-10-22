// FILE: ProjectNodesDialogs.tsx
// Purpose: The lazily loaded surface of the project-nodes feature: the
//          add-project and copy-to-another-node dialogs, and what running copies
//          need from React (opening the copied project from a toast).
// Layer: Web UI. `RootAppShell` mounts it the first time a dialog opens or a
//        copy starts, then keeps it mounted. Each dialog lives in its own file.

import { AddProjectDialog } from "./AddProjectDialog";
import { CopyProjectDialog } from "./CopyProjectDialog";
import { ProjectCopyViewBridge } from "./copyRuntime/ProjectCopyViewBridge";

export function ProjectNodesDialogs() {
  return (
    <>
      <AddProjectDialog />
      <CopyProjectDialog />
      <ProjectCopyViewBridge />
    </>
  );
}
