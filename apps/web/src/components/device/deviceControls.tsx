import type { LucideIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import { Button } from "../ui/button";

/*
 * The device rail's button and error wording, shared by the viewer and the
 * panel around it without either loading the other.
 */

export function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim() ? error.message : fallback;
}

export function Control(props: {
  readonly icon: LucideIcon;
  readonly label: string;
  readonly active?: boolean;
  readonly disabled?: boolean;
  readonly compact?: boolean;
  readonly onClick: () => void;
}) {
  const Icon = props.icon;
  return (
    <Button
      size={props.compact ? "icon-xs" : "icon-sm"}
      variant="ghost"
      title={props.label}
      aria-label={props.label}
      aria-pressed={props.active}
      disabled={props.disabled}
      className={cn(props.active && "text-red-500")}
      onClick={props.onClick}
    >
      <Icon className={props.compact ? "size-3.5" : "size-4"} />
    </Button>
  );
}
