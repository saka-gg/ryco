import type { ChangeRequest, EnvironmentId, SourceControlIssueSummary } from "@ryco/contracts";
import { useState } from "react";
import { PaperclipIcon } from "lucide-react";
import {
  hasUsableSourceControlRemote,
  useSourceControlDiscovery,
} from "~/lib/sourceControlDiscoveryState";
import { Button } from "../ui/button";
import { Popover, PopoverTrigger, PopoverPopup } from "../ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ContextPickerPopup } from "./ContextPickerPopup";

export function ContextPickerButton(props: {
  environmentId: EnvironmentId | null;
  cwd: string;
  onSelectIssue: (issue: SourceControlIssueSummary) => void;
  onSelectChangeRequest: (cr: ChangeRequest) => void;
  onAttachFile: (file: File) => void;
  onCaptureWindow?: (windowId: number) => void;
}) {
  const [open, setOpen] = useState(false);
  // Auth state only matters once the picker is wanted: discovery probes several
  // CLIs (networked auth checks included), so the composer mounting must not
  // start it. Pointing at or focusing the button gives it a head start.
  const [wanted, setWanted] = useState(false);
  const sourceControlDiscovery = useSourceControlDiscovery(undefined, {
    enabled: open || wanted,
  });
  const markWanted = () => setWanted(true);
  // Until the first discovery answers, the picker shows its (loading) lists
  // instead of claiming that there is no remote.
  const hasSourceControlRemote =
    sourceControlDiscovery.data === null && sourceControlDiscovery.isPending
      ? true
      : hasUsableSourceControlRemote(sourceControlDiscovery.data);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger
          render={
            <PopoverTrigger
              render={
                <Button
                  type="button"
                  size="icon-xs"
                  variant="ghost"
                  aria-label="Add context"
                  className="text-muted-foreground/70 hover:text-foreground/80"
                  onPointerEnter={markWanted}
                  onFocus={markWanted}
                />
              }
            />
          }
        >
          <PaperclipIcon className="size-4" />
        </TooltipTrigger>
        <TooltipPopup side="top">Add context</TooltipPopup>
      </Tooltip>
      <PopoverPopup align="start" side="top" className="p-0">
        <ContextPickerPopup
          environmentId={props.environmentId}
          cwd={props.cwd}
          hasSourceControlRemote={hasSourceControlRemote}
          onSelectIssue={(issue) => {
            props.onSelectIssue(issue);
            setOpen(false);
          }}
          onSelectChangeRequest={(cr) => {
            props.onSelectChangeRequest(cr);
            setOpen(false);
          }}
          onAttachFile={(file) => {
            props.onAttachFile(file);
            setOpen(false);
          }}
          {...(props.onCaptureWindow
            ? {
                onCaptureWindow: (windowId: number) => {
                  props.onCaptureWindow?.(windowId);
                  setOpen(false);
                },
              }
            : {})}
        />
      </PopoverPopup>
    </Popover>
  );
}
