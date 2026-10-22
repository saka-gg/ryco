// FILE: CopyProjectDialog.tsx
// Purpose: "Copy <project> to another node": destination node and folder, what
//          to bring (unpushed commits, uncommitted changes, settings), setup,
//          then the copy's progress. Placeholder until the copy dialog work
//          replaces it.
// Layer: Web UI. Mounted once by `ProjectNodesDialogs` (lazy); opened through
//        `projectNodesDialogStore.openCopyProject`. Copies run through
//        `copyRuntime/copyManager`.

import { closeCopyProject, useProjectNodesDialogStore } from "./projectNodesDialogStore";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";

/** The app's one copy-to-another-node dialog. */
export function CopyProjectDialog() {
  const open = useProjectNodesDialogStore((state) => state.copyProject.open);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) closeCopyProject();
      }}
    >
      <DialogPopup className="max-w-lg" data-testid="copy-project-dialog">
        <DialogHeader>
          <DialogTitle>Copy to another node</DialogTitle>
          <DialogDescription>Pick where the copy goes and what it brings.</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <p className="text-muted-foreground text-sm">Coming in this change.</p>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
