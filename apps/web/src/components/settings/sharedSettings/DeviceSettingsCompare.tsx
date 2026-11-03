import {
  readSharedSettingViews,
  type SharedSettingDeviceState,
} from "@ryco/client-runtime/state/settings/sharedDeviceSettings";
import {
  shareableSettingValuesEqual,
  type ShareableServerSettingKey,
} from "@ryco/shared/settingsSharing";
import { useMemo, useState } from "react";

import { cn } from "../../../lib/utils";
import { Badge } from "../../ui/badge";
import { Switch } from "../../ui/switch";
import { settingsSection, type SettingsPageSectionId } from "../settingsRegistry";
import { SettingsCard, SettingsSection } from "../settingsLayout";
import { openSharedSetting } from "./openSharedSetting";
import { readSharedRowModel } from "./sharedSettingRow.logic";
import { formatSharedSettingValue, SHARED_SETTING_DISPLAY } from "./sharedSettingsCatalog";
import { useSharedSettingsSnapshot } from "./sharedSettingsSource";

function CellMark({ state }: { readonly state: SharedSettingDeviceState }) {
  switch (state.kind) {
    case "override":
      return (
        <Badge variant="secondary" size="sm">
          own
        </Badge>
      );
    case "queued":
      return (
        <Badge variant="secondary" size="sm">
          queued
        </Badge>
      );
    case "syncing":
      return (
        <Badge variant="info" size="sm">
          syncing
        </Badge>
      );
    case "unsupported":
      return <span className="text-muted-foreground">needs update</span>;
    case "couldNotApply":
      return (
        <Badge variant="error" size="sm" title={state.reason}>
          couldn't apply
        </Badge>
      );
    case "differs":
      return (
        <Badge variant="warning" size="sm" title="Kept from before sharing">
          not shared yet
        </Badge>
      );
    case "unknown":
    case "shared":
      return null;
  }
}

/**
 * Every shared device setting next to each device's value (All devices → Compare settings).
 * "Only differences" leaves out the settings every device agrees on; a row opens its setting
 * where it lives, with its device list open. Self-contained: it reads every device itself.
 */
export function DeviceSettingsCompare({
  canOpen = () => true,
}: {
  /** Whether this reader can open a section; a row of one they can't reads only. */
  readonly canOpen?: (section: SettingsPageSectionId) => boolean;
} = {}) {
  const snapshot = useSharedSettingsSnapshot();
  const [onlyDifferences, setOnlyDifferences] = useState(true);
  const views = useMemo(
    () =>
      readSharedSettingViews({
        devices: snapshot.devices,
        cache: snapshot.cache,
        attempts: snapshot.attempts,
      }),
    [snapshot],
  );
  const rows = useMemo(
    () =>
      views.map((view) => {
        const model = readSharedRowModel({
          view,
          devices: snapshot.devices,
          mode: { kind: "all" },
          open: false,
        });
        const differs = model.kind === "list" && model.differs > 0;
        // A cell differs from the value "Use … everywhere" would write.
        const reference = model.kind === "list" ? model.everywhere : null;
        return { view, differs, reference };
      }),
    [snapshot.devices, views],
  );
  if (snapshot.devices.length < 2) return null;
  const shown = onlyDifferences ? rows.filter((row) => row.differs) : rows;
  const toggleId = "settings-compare-only-differences";
  return (
    <SettingsSection
      title="Compare settings"
      description={
        shown.some((row) => canOpen(SHARED_SETTING_DISPLAY[row.view.key].section))
          ? "Settings every device shares, side by side. Open one to change it."
          : "Settings every device shares, side by side."
      }
      headerAction={
        <label htmlFor={toggleId} className="flex items-center gap-2 text-xs text-muted-foreground">
          <Switch
            id={toggleId}
            checked={onlyDifferences}
            onCheckedChange={(checked) => setOnlyDifferences(Boolean(checked))}
          />
          Only differences
        </label>
      }
      bare
    >
      <SettingsCard className="overflow-x-auto">
        <table className="w-full border-collapse text-xs" data-testid="settings-compare-table">
          <thead>
            <tr>
              <th
                scope="col"
                className="px-4 py-2 text-left font-medium whitespace-nowrap text-muted-foreground"
              >
                Setting
              </th>
              {snapshot.devices.map((device) => (
                <th
                  key={device.environmentId}
                  scope="col"
                  className="px-3 py-2 text-left font-medium whitespace-nowrap text-muted-foreground"
                >
                  <span className="inline-flex items-center gap-1.5">
                    <span
                      aria-hidden
                      className={cn(
                        "size-1.5 rounded-full",
                        device.connected ? "bg-success" : "bg-muted-foreground/50",
                      )}
                    />
                    {device.label}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.length === 0 ? (
              <tr>
                <td
                  colSpan={snapshot.devices.length + 1}
                  className="border-t border-border/60 px-4 py-3 text-muted-foreground"
                >
                  Every shared setting matches on all devices.
                </td>
              </tr>
            ) : (
              shown.map(({ view, differs, reference }) => (
                <CompareRow
                  key={view.key}
                  settingKey={view.key}
                  openable={canOpen(SHARED_SETTING_DISPLAY[view.key].section)}
                  devices={view.devices}
                  differs={differs}
                  reference={reference}
                />
              ))
            )}
          </tbody>
        </table>
      </SettingsCard>
    </SettingsSection>
  );
}

function CompareRow(props: {
  readonly settingKey: ShareableServerSettingKey;
  /** The reader can open the setting's section; otherwise the row only reads. */
  readonly openable: boolean;
  readonly devices: ReturnType<typeof readSharedSettingViews>[number]["devices"];
  readonly differs: boolean;
  readonly reference: unknown;
}) {
  const { settingKey: key } = props;
  const display = SHARED_SETTING_DISPLAY[key];
  return (
    <tr
      className={cn(
        "group border-t border-border/60",
        props.openable && "cursor-pointer hover:bg-accent/40",
      )}
      data-testid="settings-compare-row"
      data-setting={key}
      onClick={props.openable ? () => openSharedSetting(key) : undefined}
    >
      <th scope="row" className="px-4 py-2 text-left align-middle font-normal">
        {props.openable ? (
          <button
            type="button"
            className="rounded-sm text-left text-[13px] font-medium text-foreground outline-hidden group-hover:underline focus-visible:ring-2 focus-visible:ring-ring"
            onClick={(event) => {
              event.stopPropagation();
              openSharedSetting(key);
            }}
          >
            {display.title}
          </button>
        ) : (
          <span className="text-[13px] font-medium text-foreground">{display.title}</span>
        )}
        <span className="block text-muted-foreground">
          {settingsSection(display.section).title}
        </span>
      </th>
      {props.devices.map((device) => {
        const cellDiffers =
          props.differs &&
          device.written !== undefined &&
          props.reference !== null &&
          !shareableSettingValuesEqual(device.written, props.reference) &&
          device.state.kind !== "queued" &&
          device.state.kind !== "syncing";
        return (
          <td
            key={device.environmentId}
            data-differs={cellDiffers || undefined}
            className={cn(
              "max-w-56 px-3 py-2 align-middle",
              cellDiffers && "bg-warning/8 dark:bg-warning/16",
            )}
          >
            <span className="flex flex-wrap items-center gap-1.5">
              <span className="truncate">
                {device.written === undefined ? "—" : formatSharedSettingValue(key, device.written)}
              </span>
              {cellDiffers ? (
                // Not by colour alone.
                <span className="text-warning-foreground" title="Differs">
                  <span aria-hidden>≠</span>
                  <span className="sr-only">differs</span>
                </span>
              ) : null}
              <CellMark state={device.state} />
            </span>
          </td>
        );
      })}
    </tr>
  );
}
