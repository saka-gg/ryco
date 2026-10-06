/**
 * The schedule list: device headings over two-line rows (title + tag,
 * cadence + state or the relative next run). Rows are keyed, so a tick or a
 * snapshot only changes their text — focus and selection survive. On a
 * project with several devices each device's rows are a group named for the
 * device (listbox > group > option), so every option says where it runs.
 * The dialog owns the keys (↑ ↓ Home End, ↵), across groups.
 */
import { scheduleRowPresentation } from "@ryco/client-runtime/state/agentControl";
import type { EnvironmentId } from "@ryco/contracts";
import { Fragment, memo, useLayoutEffect, useRef } from "react";

import { DeviceIcon } from "../../DeviceIcon";
import { RelativeTime } from "./Ticking";
import type { DialogListSection, DialogRow } from "./dialogModel.logic";
import { settle } from "./paneMotion";

/** Marks a row element; its value is the row's key. */
export const DIALOG_ROW_ATTRIBUTE = "data-ad-row";

export function ScheduleList(props: {
  readonly projectName: string;
  readonly sections: readonly DialogListSection[];
  /** By checkout key: the device's name and environment, for its heading. */
  readonly devices: ReadonlyMap<
    string,
    { readonly label: string; readonly environmentId: EnvironmentId }
  >;
  readonly selectedKey: string | null;
  /** The row being edited; the rest dim while the list is inert. */
  readonly editingKey: string | null;
  readonly nowMs: number;
  /** Asked once rows are there: true right after a project switch, so they settle in. */
  readonly takeSettle: () => boolean;
  readonly onSelect: (key: string) => void;
}) {
  const { takeSettle } = props;
  const listRef = useRef<HTMLDivElement | null>(null);
  const hasRows = props.sections.length > 0;
  // After a project switch the rows settle in as soon as they arrive.
  useLayoutEffect(() => {
    const node = listRef.current;
    if (!node || !hasRows || !takeSettle()) return;
    settle(Array.from(node.querySelectorAll(`[${DIALOG_ROW_ATTRIBUTE}]`)).slice(0, 8), {
      y: 5,
      duration: 300,
      stagger: 18,
    });
  }, [hasRows, takeSettle]);
  return (
    <div
      ref={listRef}
      className="ad-rows"
      role="listbox"
      aria-label={`Schedules in ${props.projectName}`}
    >
      {props.sections.map((section) => {
        const rows = section.rows.map((item) => (
          <ScheduleListRow
            key={item.key}
            item={item}
            selected={item.key === props.selectedKey}
            editing={item.key === props.editingKey}
            nowMs={props.nowMs}
            onSelect={props.onSelect}
          />
        ));
        if (section.checkoutKey === null) return <Fragment key={section.key}>{rows}</Fragment>;
        const device = props.devices.get(section.checkoutKey);
        return (
          <div key={section.key} className="ad-dev" role="group" aria-label={device?.label}>
            <div className="ad-group" aria-hidden="true">
              {device ? (
                <DeviceIcon
                  environmentId={device.environmentId}
                  label={device.label}
                  className="ad-group-ic"
                />
              ) : null}
              <span>{device?.label ?? ""}</span>
            </div>
            {rows}
          </div>
        );
      })}
    </div>
  );
}

/**
 * One row. Memoised so a selection change re-renders only the two rows it
 * touches; the minute tick still re-renders every row (its words depend on
 * the time), which keeps its element, so focus stays.
 */
const ScheduleListRow = memo(function ScheduleListRow(props: {
  readonly item: DialogRow;
  readonly selected: boolean;
  readonly editing: boolean;
  readonly nowMs: number;
  readonly onSelect: (key: string) => void;
}) {
  const { item } = props;
  const view = scheduleRowPresentation(item.row, props.nowMs);
  return (
    <div
      role="option"
      className="ad-row"
      {...{ [DIALOG_ROW_ATTRIBUTE]: item.key }}
      data-state={item.row.state}
      data-editing={props.editing ? "" : undefined}
      aria-selected={props.selected}
      tabIndex={props.selected ? 0 : -1}
      onClick={() => props.onSelect(item.key)}
    >
      <span className="ad-glyph" data-g={item.row.state} aria-hidden="true" />
      <span className="ad-row-title ad-trunc">{view.title}</span>
      <span className="ad-row-tag" data-tone={view.tagTone || undefined}>
        {view.tag}
      </span>
      <span className="ad-row-sum ad-trunc">{view.summary}</span>
      <span className="ad-row-meta tnum" data-tone={view.metaTone || undefined}>
        {view.soonAt !== null ? <RelativeTime atMs={view.soonAt} /> : view.meta}
      </span>
    </div>
  );
});
