import type {
  NodeSettingsConfig,
  NodeSettingsTarget,
} from "@ryco/client-runtime/state/settings/nodeSettingsTargets";
import type { EnvironmentId, ServerProvider } from "@ryco/contracts";
import { useMemo, useRef, useSyncExternalStore } from "react";

import { cn } from "../../lib/utils";
import type { SettingsTarget } from "../../settingsTarget";
import { Button } from "../ui/button";
import { DeviceStatusDot, settingsDeviceStatusText } from "./SettingsDeviceCards";
import { getDriverOption } from "./providerDriverMeta";
import {
  groupProviderInstancesAcrossDevices,
  PROVIDER_CELL_LABELS,
  type ProviderCellStatus,
  type ProviderTableCell,
  type ProviderTableDevice,
  type ProviderTableRow,
} from "./providerDeviceTable.logic";
import { requestProviderEditor } from "./providerEditorRequest";
import { SettingsCard, SettingsSection, useRelativeLabelTick } from "./settingsLayout";
import { useSharedSettingsMode } from "./sharedSettings/sharedSettingsMode";
import {
  settingsTargetDevice,
  useSharedSettingsSource,
  type SharedSettingsSource,
} from "./sharedSettings/sharedSettingsSource";
import type { SettingsDeviceChoice } from "./useSettingsDevices";

/** The node's provider status: this app's device targets carry each node's whole config. */
function readConfigProviders(config: NodeSettingsConfig): ReadonlyArray<ServerProvider> {
  const providers = (config as { readonly providers?: unknown }).providers;
  return Array.isArray(providers) ? (providers as ReadonlyArray<ServerProvider>) : [];
}

/** Every known device as the source reads it, kept equal while no config, connection or grant moved. */
function useSourceDevices(source: SharedSettingsSource): ReadonlyArray<NodeSettingsTarget> {
  const cache = useRef<ReadonlyArray<NodeSettingsTarget>>([]);
  const read = () => {
    const next = source.readDevices();
    const previous = cache.current;
    const same =
      previous.length === next.length &&
      previous.every((device, index) => {
        const other = next[index]!;
        return (
          device.environmentId === other.environmentId &&
          device.config === other.config &&
          device.connected === other.connected &&
          device.canWrite === other.canWrite
        );
      });
    if (!same) cache.current = next;
    return cache.current;
  };
  return useSyncExternalStore(source.subscribeDevices, read, read);
}

const STATUS_DOT: Record<ProviderCellStatus, string> = {
  ready: "bg-success",
  "sign-in": "bg-warning",
  attention: "bg-warning",
  "not-installed": "bg-muted-foreground/50",
  off: "bg-muted-foreground/50",
  checking: "bg-muted-foreground/50",
  missing: "",
  unknown: "",
};

function Cell({
  row,
  cell,
  device,
  onEdit,
  onAdd,
}: {
  readonly row: ProviderTableRow;
  readonly cell: ProviderTableCell;
  readonly device: SettingsDeviceChoice;
  readonly onEdit: () => void;
  readonly onAdd: () => void;
}) {
  const label = PROVIDER_CELL_LABELS[cell.status];
  if (cell.status === "missing" || cell.status === "unknown") {
    return cell.actionable ? (
      <Button
        size="xs"
        variant="link"
        className="h-auto px-0 text-info"
        aria-label={`Add ${row.displayName} to ${device.label}`}
        onClick={onAdd}
      >
        Add
      </Button>
    ) : (
      <span className="text-muted-foreground" title={label}>
        —<span className="sr-only">{label}</span>
      </span>
    );
  }
  return (
    <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
      <span
        className={cn(
          "inline-flex items-center gap-1.5 whitespace-nowrap",
          cell.status === "ready" && !cell.stale ? "text-success" : "text-muted-foreground",
        )}
        title={cell.stale ? `${label} when last seen` : undefined}
      >
        <span aria-hidden className={cn("size-1.5 rounded-full", STATUS_DOT[cell.status])} />
        {label}
        {cell.stale ? <span className="sr-only"> when last seen</span> : null}
      </span>
      {cell.actionable ? (
        <Button
          size="xs"
          variant="link"
          className="h-auto px-0 text-muted-foreground hover:text-foreground"
          aria-label={`Edit ${row.displayName} on ${device.label}`}
          onClick={onEdit}
        >
          Edit
        </Button>
      ) : null}
    </span>
  );
}

function rowDetail(row: ProviderTableRow): string {
  const driver = getDriverOption(row.driver)?.label ?? String(row.driver);
  if (row.isDefault) return "Built in";
  if (row.match === "name") return `${driver} · matched by name`;
  return row.displayName === driver ? row.instanceId : `${driver} · ${row.instanceId}`;
}

/**
 * Providers & models: where each provider runs. One row per provider (instances grouped across
 * devices by id, else by driver and name), one column per device the bar shows: All devices,
 * or the one chosen. A cell is that device's state from its last known config; an offline
 * device's is its last known one, read only. Edit opens the device's instance editor below, Add
 * its add-provider dialog, both for that device; no request of its own.
 */
export function ProviderDeviceTable({
  choices,
  target,
  select,
}: {
  readonly choices: ReadonlyArray<SettingsDeviceChoice>;
  /** The device the bar shows, whose provider settings show below. */
  readonly target: SettingsTarget | null;
  /** Shows a device's values below (the bar's target), keeping the bar's view. */
  readonly select: (environmentId: EnvironmentId) => void;
}) {
  const source = useSharedSettingsSource();
  const sourceDevices = useSourceDevices(source);
  const { mode } = useSharedSettingsMode();
  const nowMs = useRelativeLabelTick(choices.map((choice) => choice.lastSeenAt ?? undefined));

  const columns = useMemo(
    () =>
      mode.kind === "device"
        ? choices.filter((choice) => choice.environmentId === mode.environmentId)
        : choices,
    [choices, mode],
  );
  const devices = useMemo(
    () =>
      columns.map((choice): ProviderTableDevice => {
        const known =
          sourceDevices.find((device) => device.environmentId === choice.environmentId) ??
          (target?.environmentId === choice.environmentId ? settingsTargetDevice(target) : null);
        const config = known?.config ?? null;
        return {
          environmentId: choice.environmentId,
          label: choice.label,
          config:
            config === null
              ? null
              : { settings: config.settings, providers: readConfigProviders(config) },
          online: choice.status === null,
          canEdit: known !== null && known.connected && known.canWrite && !choice.disabled,
        };
      }),
    [columns, sourceDevices, target],
  );
  const rows = useMemo(() => groupProviderInstancesAcrossDevices(devices), [devices]);
  if (columns.length === 0) return null;

  const open = (environmentId: EnvironmentId) => {
    if (environmentId !== target?.environmentId) select(environmentId);
  };
  return (
    <SettingsSection
      title="Where each provider runs"
      description="Add a provider to a device from its column. Edit opens it below for that device."
      bare
    >
      <SettingsCard className="overflow-x-auto">
        <table className="w-full border-collapse text-xs" data-testid="provider-device-table">
          <thead>
            <tr>
              <th
                scope="col"
                className="px-4 py-2 text-left font-medium whitespace-nowrap text-muted-foreground"
              >
                Provider
              </th>
              {columns.map((choice) => (
                <th
                  key={choice.environmentId}
                  scope="col"
                  className="px-3 py-2 text-left align-bottom font-medium whitespace-nowrap text-muted-foreground"
                >
                  <span className="inline-flex items-center gap-1.5">
                    <DeviceStatusDot status={choice.status} />
                    {choice.label}
                  </span>
                  {choice.status !== null ? (
                    <span className="block font-normal text-muted-foreground/80">
                      {settingsDeviceStatusText(choice, nowMs)}
                    </span>
                  ) : null}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr
                key={row.key}
                className="border-t border-border/60"
                data-testid="provider-device-row"
                data-provider={row.displayName}
              >
                <th scope="row" className="px-4 py-2 text-left align-middle font-normal">
                  <span className="block text-[13px] font-medium text-foreground">
                    {row.displayName}
                  </span>
                  <span className="block text-muted-foreground">{rowDetail(row)}</span>
                </th>
                {row.cells.map((cell, index) => {
                  const choice = columns[index]!;
                  return (
                    <td
                      key={cell.environmentId}
                      className="px-3 py-2 align-middle"
                      data-device={choice.label}
                      data-status={cell.status}
                    >
                      <Cell
                        row={row}
                        cell={cell}
                        device={choice}
                        onEdit={() => {
                          if (cell.instanceId === null) return;
                          requestProviderEditor({
                            kind: "edit",
                            environmentId: cell.environmentId,
                            instanceId: cell.instanceId,
                          });
                          open(cell.environmentId);
                        }}
                        onAdd={() => {
                          requestProviderEditor({
                            kind: "add",
                            environmentId: cell.environmentId,
                            preset: {
                              driver: row.driver,
                              displayName: row.customName,
                              instanceId: row.instanceId,
                            },
                          });
                          open(cell.environmentId);
                        }}
                      />
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </SettingsCard>
    </SettingsSection>
  );
}
