import { memo, type KeyboardEvent } from "react";

import { cn } from "../../../lib/utils";
import { DeviceIcon } from "../../DeviceIcon";
import { INBOX_ROW_KEY_ATTRIBUTE } from "../../inboxSidebar/useInboxListMotion";
import { ProjectFavicon } from "../../ProjectFavicon";
import { RelativeTime } from "../../pullRequests/primitives";
import type { ProjectListRow as ProjectListRowModel } from "../projectsModel.logic";

/** Up to this many device glyphs; a project on more devices shows "+n". */
const MAX_DEVICE_GLYPHS = 3;

export const PROJECT_ROW_BUTTON_SELECTOR = "[data-project-row]";

/**
 * One logical project: favicon and name, then the repository (or path) with
 * the devices it lives on. The trailing slot is live: a running dot while a
 * thread works, else the last activity.
 */
export const ProjectListRow = memo(function ProjectListRow(props: {
  readonly row: ProjectListRowModel;
  readonly selected: boolean;
  readonly tabStop: boolean;
  readonly onSelect: (row: ProjectListRowModel) => void;
  readonly onKeyDown: (event: KeyboardEvent<HTMLButtonElement>, row: ProjectListRowModel) => void;
}) {
  const { row } = props;
  const extraDevices = row.devices.length - MAX_DEVICE_GLYPHS;
  return (
    <div {...{ [INBOX_ROW_KEY_ATTRIBUTE]: row.key }} className="relative z-[1]">
      <button
        type="button"
        data-project-row={row.key}
        aria-current={props.selected ? "true" : undefined}
        tabIndex={props.tabStop ? 0 : -1}
        onClick={() => props.onSelect(row)}
        onKeyDown={(event) => props.onKeyDown(event, row)}
        className={cn(
          "grid w-full grid-cols-[1.25rem_minmax(0,1fr)_auto] items-center gap-x-2.5 gap-y-0.5 rounded-[min(var(--radius-lg),0.625rem)] px-2.5 py-2 text-left outline-hidden",
          "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
        )}
      >
        <span className="row-span-2 grid size-5 place-items-center self-start overflow-hidden rounded-[min(var(--radius-md),0.375rem)] text-muted-foreground">
          <ProjectFavicon
            environmentId={row.snapshot.environmentId}
            cwd={row.snapshot.cwd}
            projectId={row.snapshot.id}
            customAvatarContentHash={row.snapshot.customAvatarContentHash ?? null}
            className="size-5"
          />
        </span>
        <span
          className={cn(
            "min-w-0 truncate text-[13px] leading-5",
            props.selected ? "font-medium text-foreground" : "text-foreground/90",
          )}
        >
          {row.name}
        </span>
        <span className="flex h-5 items-center justify-end text-[11px] text-muted-foreground">
          {row.running ? (
            <span
              className="status-activity-signal size-1.5 text-sky-500 dark:text-sky-300/80"
              title="A thread is working"
            >
              <span className="size-full rounded-full bg-current" />
              <span className="sr-only">A thread is working</span>
            </span>
          ) : row.lastActivityAt !== null ? (
            <RelativeTime value={new Date(row.lastActivityAt).toISOString()} />
          ) : (
            <span aria-label="No threads yet">—</span>
          )}
        </span>
        <span className="col-start-2 min-w-0 truncate text-[11px] leading-4 text-muted-foreground">
          {row.subtitle}
        </span>
        <span className="col-start-3 flex h-4 items-center justify-end gap-0.5 text-muted-foreground/70">
          {row.devices.length > 1 ? (
            <>
              {row.devices.slice(0, MAX_DEVICE_GLYPHS).map((device) => (
                <DeviceIcon
                  key={device.environmentId}
                  environmentId={device.environmentId}
                  {...(device.label ? { label: device.label } : {})}
                  className="size-3"
                />
              ))}
              {extraDevices > 0 ? (
                <span className="text-[10px] tabular-nums">+{extraDevices}</span>
              ) : null}
              <span className="sr-only">
                On {row.devices.length} devices:{" "}
                {row.devices.map((device) => device.label ?? "This device").join(", ")}
              </span>
            </>
          ) : null}
        </span>
      </button>
    </div>
  );
});
