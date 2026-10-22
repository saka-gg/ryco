// FILE: AddProjectDialog.tsx
// Purpose: "Add project": node first, then the source (open a folder, clone a
//          repository, copy from another node, link a checkout), then the
//          folder. Placeholder until the add-project dialog work replaces it.
// Layer: Web UI. Mounted once by `ProjectNodesDialogs` (lazy); opened through
//        `projectNodesDialogStore.openAddProject`.

import { closeAddProject, useProjectNodesDialogStore } from "./projectNodesDialogStore";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";

/** The app's one add-project dialog. */
export function AddProjectDialog() {
  const open = useProjectNodesDialogStore((state) => state.addProject.open);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) closeAddProject();
      }}
    >
      <DialogPopup className="max-w-lg" data-testid="add-project-dialog">
        <DialogHeader>
          <DialogTitle>Add project</DialogTitle>
          <DialogDescription>Pick a node, then a folder or a repository.</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <p className="text-muted-foreground text-sm">Coming in this change.</p>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
