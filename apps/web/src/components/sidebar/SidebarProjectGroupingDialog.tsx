import { type SidebarProjectGroupingMode } from "@ryco/contracts";
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
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import {
  PROJECT_GROUPING_MODE_LABELS,
  projectGroupingModeDescription,
} from "./sidebarProjectGroupingLabels";

export function SidebarProjectGroupingDialog(props: {
  target: SidebarProjectGroupMember | null;
  selection: SidebarProjectGroupingMode | "inherit";
  globalGroupingMode: SidebarProjectGroupingMode;
  onSelectionChange: (selection: SidebarProjectGroupingMode | "inherit") => void;
  onClose: () => void;
  onSave: () => void;
}) {
  const { target, selection, globalGroupingMode, onSelectionChange, onClose, onSave } = props;
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
          <DialogTitle>Project grouping</DialogTitle>
          <DialogDescription>
            {target
              ? `Choose how ${target.cwd} should be grouped in the sidebar.`
              : "Choose how this project should be grouped in the sidebar."}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-4">
          <div className="grid gap-1.5">
            <span className="text-xs font-medium text-foreground">Grouping rule</span>
            <Select
              value={selection}
              onValueChange={(value) => {
                if (
                  value === "inherit" ||
                  value === "repository" ||
                  value === "repository_path" ||
                  value === "separate"
                ) {
                  onSelectionChange(value);
                }
              }}
            >
              <SelectTrigger className="w-full" aria-label="Project grouping rule">
                <SelectValue>
                  {selection === "inherit"
                    ? `Use global default (${PROJECT_GROUPING_MODE_LABELS[globalGroupingMode]})`
                    : PROJECT_GROUPING_MODE_LABELS[selection]}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem hideIndicator value="inherit">
                  Use global default
                </SelectItem>
                <SelectItem hideIndicator value="repository">
                  {PROJECT_GROUPING_MODE_LABELS.repository}
                </SelectItem>
                <SelectItem hideIndicator value="repository_path">
                  {PROJECT_GROUPING_MODE_LABELS.repository_path}
                </SelectItem>
                <SelectItem hideIndicator value="separate">
                  {PROJECT_GROUPING_MODE_LABELS.separate}
                </SelectItem>
              </SelectPopup>
            </Select>
          </div>
          <p className="text-xs text-muted-foreground">
            {selection === "inherit"
              ? projectGroupingModeDescription(globalGroupingMode)
              : projectGroupingModeDescription(selection)}
          </p>
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={onSave}>Save</Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
