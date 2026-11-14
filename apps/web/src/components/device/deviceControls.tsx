import type { ComponentType } from "react";

import { cn } from "~/lib/utils";
import { Button } from "../ui/button";

/*
 * The device rail's button and error wording, shared by the viewer and the
 * panel around it without either loading the other.
 */

export function Control(props: {
  /** A lucide icon, or one of the inline glyphs drawn to keep icons out of shared chunks. */
  readonly icon: ComponentType<{ className?: string }>;
  readonly label: string;
  /** The tooltip, when it should say more than the label (why a control is off). */
  readonly title?: string;
  /** Highlights a running action (recording). */
  readonly active?: boolean;
  /** A toggle's state, shown as a pressed button. */
  readonly pressed?: boolean;
  readonly disabled?: boolean;
  readonly compact?: boolean;
  readonly onClick: () => void;
}) {
  const Icon = props.icon;
  const button = (
    <Button
      size={props.compact ? "icon-xs" : "icon-sm"}
      variant="ghost"
      title={props.title ?? props.label}
      aria-label={props.label}
      aria-pressed={props.pressed ?? props.active}
      disabled={props.disabled}
      className={cn(props.active && "text-red-500", props.pressed && "bg-accent text-foreground")}
      onClick={props.onClick}
    >
      <Icon className={props.compact ? "size-3.5" : "size-4"} />
    </Button>
  );
  // A disabled button shows no tooltip of its own; the wrapper carries the reason.
  return props.disabled && props.title ? (
    <span title={props.title} className="inline-flex">
      {button}
    </span>
  ) : (
    button
  );
}
