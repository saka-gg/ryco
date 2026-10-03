import { MessageSquarePlusIcon, SparklesIcon } from "lucide-react";
import type { CSSProperties } from "react";

import { cn } from "../../../lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../ui/tooltip";
import { KeyHint } from "../primitives";

const CHIP_ACTION_CLASS =
  "inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground outline-hidden transition-colors duration-(--app-motion-duration-chip) hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50";

/**
 * Floats under a line selection (line numbers clicked or dragged) without
 * pushing the diff down: comment on the selected lines, or hand them to an
 * agent. Esc clears the selection.
 */
export function SelectionChip(props: {
  readonly label: string;
  readonly style: CSSProperties;
  readonly canComment: boolean;
  readonly commentUnavailableReason?: string | undefined;
  readonly canAsk: boolean;
  readonly askUnavailableReason?: string | undefined;
  readonly onComment: () => void;
  readonly onAsk: () => void;
}) {
  return (
    <div
      role="toolbar"
      aria-label={`Selected ${props.label}`}
      data-selection-chip
      style={props.style}
      className="pr-chip-in absolute z-30 flex items-center gap-0.5 rounded-lg border border-border/70 bg-popover p-0.5 shadow-lg/5"
    >
      <ChipAction
        enabled={props.canComment}
        reason={props.commentUnavailableReason}
        onClick={props.onComment}
        label="Comment"
        icon={<MessageSquarePlusIcon className="size-3.5" />}
      />
      <ChipAction
        enabled={props.canAsk}
        reason={props.askUnavailableReason}
        onClick={props.onAsk}
        label="Ask agent"
        icon={<SparklesIcon className="size-3.5" />}
        hint="A"
      />
    </div>
  );
}

function ChipAction(props: {
  readonly enabled: boolean;
  readonly reason: string | undefined;
  readonly onClick: () => void;
  readonly label: string;
  readonly icon: React.ReactNode;
  readonly hint?: string;
}) {
  const button = (
    <button
      type="button"
      className={cn(CHIP_ACTION_CLASS)}
      disabled={!props.enabled}
      onClick={props.onClick}
    >
      {props.icon}
      {props.label}
      {props.hint && props.enabled ? <KeyHint>{props.hint}</KeyHint> : null}
    </button>
  );
  if (props.enabled || !props.reason) return button;
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="inline-flex">{button}</span>} />
      <TooltipPopup side="bottom" sideOffset={4}>
        {props.reason}
      </TooltipPopup>
    </Tooltip>
  );
}
