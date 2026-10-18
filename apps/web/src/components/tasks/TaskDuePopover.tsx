import { CalendarIcon, CheckIcon } from "lucide-react";
import { useRef, useState } from "react";

import { CalendarGrid } from "../automations/pickers/CalendarGrid";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { dueAtDayStart, dueAtForDay, dueLabel, dueQuickPicks } from "./taskDue.logic";
import { TASK_CHIP_CLASS } from "./tasksUi";

/**
 * The due chip ("Fri", or a dashed "Due date") and its calendar: the
 * automations' compact month grid, then Today / Tomorrow / Next week and
 * Clear. Picking a day sets it and closes.
 */
export function TaskDuePopover(props: {
  readonly taskId: string;
  readonly dueAt: string | null;
  readonly now: number;
  readonly onDueChange: (taskId: string, dueAt: string | null) => void;
}) {
  const { taskId, dueAt, now, onDueChange } = props;
  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const day = dueAtDayStart(dueAt);
  const label = dueAt !== null ? dueLabel(dueAt, now) : null;
  const choose = (next: string | null) => {
    onDueChange(taskId, next);
    setOpen(false);
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger className={TASK_CHIP_CLASS} data-ghost={label === null ? "" : undefined}>
        <CalendarIcon className="size-3 shrink-0" aria-hidden />
        {label ?? "Due date"}
      </PopoverTrigger>
      <PopoverPopup
        side="bottom"
        align="start"
        sideOffset={6}
        className="tsk-pop rounded-[12px] before:rounded-[11px]"
        viewportClassName="p-0"
        aria-label="Due date"
        initialFocus={() =>
          panelRef.current?.querySelector<HTMLElement>('[role="gridcell"][tabindex="0"]') ?? true
        }
      >
        <div ref={panelRef} className="pk-panel" data-compact="">
          <CalendarGrid
            value={day}
            min={null}
            max={null}
            nowMs={now}
            compact
            autoFocus
            onPick={(picked) => choose(dueAtForDay(picked))}
          />
          <div
            role="group"
            aria-label="Quick picks"
            className="flex items-center gap-0.5 border-t border-(--pk-hair) px-2 py-1.5"
          >
            {dueQuickPicks(now).map((pick) => (
              <button
                key={pick.label}
                type="button"
                className="pk-qp"
                aria-pressed={day === pick.dayMs}
                onClick={() => choose(dueAtForDay(pick.dayMs))}
              >
                <CheckIcon className="pk-ic" aria-hidden />
                <span>{pick.label}</span>
              </button>
            ))}
            {dueAt !== null ? (
              <button type="button" className="pk-qp ml-auto" onClick={() => choose(null)}>
                Clear
              </button>
            ) : null}
          </div>
        </div>
      </PopoverPopup>
    </Popover>
  );
}
