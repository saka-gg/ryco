import type { EnvironmentId } from "@ryco/contracts";

import { cn } from "~/lib/utils";
import { DeviceIcon } from "../DeviceIcon";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import type { ComposerExecutionTarget } from "./ExecutionTarget.logic";
import { RollingText, useTravelDirection } from "./RollingText";

export interface ExecutionTargetSelectProps {
  readonly targets: ReadonlyArray<ComposerExecutionTarget>;
  readonly selectedEnvironmentId: EnvironmentId;
  readonly locked: boolean;
  readonly onChange: ((environmentId: EnvironmentId) => void) | undefined;
  /**
   * `ghost` is the compact control in the composer footer; `pill` is the
   * bordered device pill above the new-thread composer, with an availability
   * dot and a rolling label.
   */
  readonly appearance?: "ghost" | "pill";
}

/** The device ("execution machine") a thread runs on. */
export function ExecutionTargetSelect({
  targets,
  selectedEnvironmentId,
  locked,
  onChange,
  appearance = "ghost",
}: ExecutionTargetSelectProps) {
  const selectedIndex = targets.findIndex(
    (target) => target.environmentId === selectedEnvironmentId,
  );
  const selected = selectedIndex === -1 ? null : targets[selectedIndex]!;
  const direction = useTravelDirection(selectedIndex);
  const label = selected?.label ?? "No verified machine";
  const pill = appearance === "pill";

  return (
    <>
      <Select
        value={selectedEnvironmentId}
        disabled={locked}
        onValueChange={(value) => {
          if (value) onChange?.(value as EnvironmentId);
        }}
      >
        <SelectTrigger
          variant="ghost"
          size="xs"
          className={
            pill
              ? // `new-thread-pill` (index.css) owns the pill's border, fill and hover.
                "new-thread-pill sm:h-7 sm:text-xs data-disabled:opacity-100"
              : "max-w-40 gap-1 px-1.5 text-muted-foreground/80"
          }
          aria-label="Execution machine"
          title={
            locked
              ? "Existing threads stay on their owning machine"
              : "Choose a device to run this thread"
          }
        >
          {pill ? (
            <>
              {/* Keyed so a switch replays the icon's entrance and the dot's ping. */}
              <span
                key={`icon:${selectedEnvironmentId}`}
                className="new-thread-pill-icon inline-flex"
              >
                <DeviceIcon environmentId={selectedEnvironmentId} className="size-3.5 shrink-0" />
              </span>
              <RollingText className="max-w-40" text={label} direction={direction} />
              <span
                key={`dot:${selectedEnvironmentId}`}
                aria-hidden
                className="new-thread-connection-dot"
                data-connected={selected !== null && selected.disabled !== true}
              />
            </>
          ) : (
            <>
              <DeviceIcon environmentId={selectedEnvironmentId} className="size-3.5 shrink-0" />
              <SelectValue>{label}</SelectValue>
            </>
          )}
        </SelectTrigger>
        <SelectPopup
          alignItemWithTrigger={false}
          {...(pill ? { align: "end" as const } : {})}
          className="w-56 p-0.5"
        >
          {targets.map((target) => (
            <SelectItem
              key={target.environmentId}
              value={target.environmentId}
              disabled={target.disabled}
            >
              <span className="inline-flex min-w-0 items-center gap-2">
                <DeviceIcon
                  environmentId={target.environmentId}
                  label={target.label}
                  className="size-3.5 shrink-0 text-muted-foreground"
                />
                <span className="flex min-w-0 flex-col">
                  <span className="truncate">{target.label}</span>
                  {target.status ? (
                    <span className="text-xs text-muted-foreground">{target.status}</span>
                  ) : null}
                </span>
              </span>
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
      {!locked && selected?.disabled ? (
        <span className={cn("shrink-0 text-destructive text-xs", pill && "ml-1.5")}>
          Device unavailable
        </span>
      ) : null}
    </>
  );
}
