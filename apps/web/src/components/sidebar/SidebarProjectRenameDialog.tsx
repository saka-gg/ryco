import { hasNoShortcutModifiers } from "../../keybindings";
import type { SidebarProjectGroupMember } from "../../sidebarProjectGrouping";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";

export function SidebarProjectRenameDialog(props: {
  target: SidebarProjectGroupMember | null;
  title: string;
  onTitleChange: (title: string) => void;
  onClose: () => void;
  onSubmit: () => void;
}) {
  const { target, title, onTitleChange, onClose, onSubmit } = props;
  return (
    <Dialog
      open={target !== null}
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
    >
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Rename project</DialogTitle>
          <DialogDescription>
            {target ? `Update the title for ${target.cwd}.` : "Update the project title."}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-4">
          <div className="grid gap-1.5">
            <span className="text-xs font-medium text-foreground">Project title</span>
            <Input
              aria-label="Project title"
              value={title}
              onChange={(event) => onTitleChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && hasNoShortcutModifiers(event)) {
                  event.preventDefault();
                  onSubmit();
                }
              }}
            />
          </div>
          {target?.environmentLabel ? (
            <p className="text-xs text-muted-foreground">Environment: {target.environmentLabel}</p>
          ) : null}
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={onSubmit}>Save</Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
