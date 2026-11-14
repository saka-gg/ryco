import type { EnvironmentId } from "@ryco/contracts";
import type {
  NodeSettingsApplyResult,
  NodeSettingsConfig,
} from "@ryco/client-runtime/state/settings/nodeSettingsTargets";
import {
  readSharedSettingView,
  type SharedSettingDeviceState,
} from "@ryco/client-runtime/state/settings/sharedDeviceSettings";
import {
  shareableSettingValuesEqual,
  type ShareableServerSettingKey,
  type ShareableSettingValue,
} from "@ryco/shared/settingsSharing";
import { LayersIcon } from "lucide-react";
import { useEffect, useMemo, useState, type ComponentProps, type ReactNode } from "react";

import { usePrimaryEnvironmentId } from "../../../environments/primary/context";
import { usePresentationTier } from "../../../hooks/usePresentationTier";
import { cn } from "../../../lib/utils";
import { relativeTime } from "../../hostedHub/HostedNodeDisplay.logic";
import { useSettingsTarget } from "../../../settingsTarget";
import { DeviceIcon } from "../../DeviceIcon";
import { Badge } from "../../ui/badge";
import { Button } from "../../ui/button";
import {
  SettingResetButton,
  SettingsChip,
  SettingsSection,
  SettingsRow as LayoutSettingsRow,
  SettingsRowChipProvider,
  SharedRowScope,
  useSettingsRowChip,
} from "../settingsLayout";
import {
  buildSharedRowCommand,
  describeSharedRowOutcome,
  readSharedRowModel,
  type SharedRowAction,
  type SharedRowDevice,
  type SharedSettingsMode,
} from "./sharedSettingRow.logic";
import {
  formatSharedSettingValue,
  SHARED_SETTING_DISPLAY,
  sharedSettingRowId,
} from "./sharedSettingsCatalog";
import {
  takeSharedRowOpen,
  useSharedRowOpenRequest,
  useSharedSettingsMode,
} from "./sharedSettingsMode";
import { useSharedSettingsSnapshot, useSharedSettingsSource } from "./sharedSettingsSource";
import { errorMessage } from "~/lib/errorMessage";

/** What a shared row's `render` draws one control with. */
export interface SharedSettingControl<K extends ShareableServerSettingKey> {
  readonly value: ShareableSettingValue<K>;
  readonly onChange: (next: ShareableSettingValue<K>) => void;
  /** As `onChange`, for an editor that waits: what was written, or null when nothing was. */
  readonly save: (next: ShareableSettingValue<K>) => Promise<NodeSettingsApplyResult | null>;
  readonly disabled: boolean;
  /** The device this control edits, for its accessible name; null when it edits every device. */
  readonly deviceLabel: string | null;
  /** `editor` layout: the row's sharing status, for the editor to show. */
  readonly sharing: ReactNode;
  /** The device knows the setting; false on a node too old for it (its value means nothing). */
  readonly known: boolean;
}

export interface SharedSettingRowProps<K extends ShareableServerSettingKey> {
  readonly settingKey: K;
  /** Defaults to the catalog's title. */
  readonly title?: ReactNode;
  readonly description?: ReactNode;
  /** Shown before the row's sharing status. */
  readonly status?: ReactNode;
  /** The row's existing control, for one value. */
  readonly render: (control: SharedSettingControl<K>) => ReactNode;
  /**
   * `block`: the control is a full-width field (a text area), drawn under the title, and the
   * device list shows each device's value with an Edit that switches to that device.
   * `editor`: the control is a whole section (a form with its own Save) drawn once, for every
   * device while they agree or for the device shown; it places `sharing` itself. While devices
   * differ the row shows them, each with its value and an Edit.
   */
  readonly layout?: "inline" | "block" | "editor";
  /** With `resetLabel`, a reset to this value beside the title. */
  readonly defaultValue?: ShareableSettingValue<K>;
  readonly resetLabel?: string;
  /** Whether a device knows the setting; older nodes drop unknown keys. */
  readonly knowsSetting?: (config: NodeSettingsConfig) => boolean;
  /** Said for a device that does not know the setting. */
  readonly unknownSettingStatus?: string;
  /**
   * For a row that edits one field of a larger setting: the field it compares, and how a value
   * reads in its hints and "Use … everywhere" (the catalog's format otherwise).
   */
  readonly compareBy?: (value: ShareableSettingValue<K>) => unknown;
  /**
   * With `compareBy`: puts the edited field into a device's own value, so the one control and
   * "Use … everywhere" change that field on each device and keep the rest of each device's own
   * value (`buildSharedRowCommand`).
   */
  readonly applyField?: (
    current: ShareableSettingValue<K>,
    edited: ShareableSettingValue<K>,
  ) => ShareableSettingValue<K>;
  /**
   * Names this row among other rows of the same setting (one per field), for its element id.
   * The key's first row leaves it out: "Open" from the compare table reveals that one.
   */
  readonly field?: string;
  readonly formatValue?: (value: ShareableSettingValue<K>) => string;
  readonly className?: string | undefined;
}

/** A control's accessible name, naming the device it edits in a device list. */
export function sharedControlLabel(
  name: string,
  control: { readonly deviceLabel: string | null },
): string {
  return control.deviceLabel === null ? name : `${name} on ${control.deviceLabel}`;
}

/** The mark of a row stored on each device. */
export const PER_DEVICE_CHIP = (
  <SettingsChip icon={<LayersIcon aria-hidden />}>Per device</SettingsChip>
);

/** A shared row marks itself "Per device" wherever device rows carry a mark. */
function SettingsRow(props: ComponentProps<typeof LayoutSettingsRow>) {
  const chip = useSettingsRowChip();
  return (
    <SettingsRowChipProvider value={chip === null ? null : PER_DEVICE_CHIP}>
      <LayoutSettingsRow {...props} />
    </SettingsRowChipProvider>
  );
}

function StatusDot({ connected }: { readonly connected: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        "size-1.5 shrink-0 rounded-full",
        connected ? "bg-success" : "bg-muted-foreground/50",
      )}
    />
  );
}

function LinkButton(props: {
  readonly children: ReactNode;
  readonly onClick: () => void;
  readonly disabled?: boolean;
  readonly label?: string;
}) {
  return (
    <button
      type="button"
      disabled={props.disabled}
      aria-label={props.label}
      onClick={props.onClick}
      className="rounded-sm text-xs font-medium text-link underline-offset-2 outline-hidden hover:underline focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
    >
      {props.children}
    </button>
  );
}

/** The marks beside one device: its own value, waiting, catching up, too old, refused. */
function DeviceStateMark(props: {
  readonly label: string;
  readonly state: SharedSettingDeviceState;
  readonly onReset: (() => void) | null;
}) {
  const { state } = props;
  switch (state.kind) {
    case "override":
      return (
        <span className="inline-flex flex-wrap items-center gap-1.5">
          <Badge variant="secondary" size="sm">
            Own value
          </Badge>
          {props.onReset ? (
            <LinkButton onClick={props.onReset} label={`Reset ${props.label} to shared`}>
              Reset to shared
            </LinkButton>
          ) : null}
        </span>
      );
    case "queued":
      return (
        <Badge
          variant="secondary"
          size="sm"
          title={
            state.reason === "offline"
              ? `Applies when ${props.label} reconnects`
              : `Applies when an owner of ${props.label} opens it`
          }
        >
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
      return (
        <span className="text-xs text-muted-foreground">
          Update {props.label} to share settings
        </span>
      );
    case "couldNotApply":
      return (
        <span role="alert" className="text-xs text-destructive-foreground">
          Couldn't apply: {state.reason}
        </span>
      );
    case "unknown":
      return <span className="text-xs text-muted-foreground">Not connected yet</span>;
    case "differs":
      return (
        <Badge
          variant="warning"
          size="sm"
          title={`${props.label} keeps the value it had before sharing until you choose one`}
        >
          Not shared yet
        </Badge>
      );
    case "shared":
      return null;
  }
}

/**
 * A setting stored on every device and shared between them (docs/shared-device-settings.md).
 * With every device on one value it is one control, "Same on all N devices", that changes
 * every device; with values that differ, or opened with "Set per device", it lists each device
 * with its own control, its marks and "Use … everywhere". A device bar showing one device
 * edits that device's own value. Every write goes through the sharing commands, so a shared
 * key never turns into an override by accident.
 */
/** One shared setting across every device: its view, row model and the edits it sends. */
function useSharedSettingState<K extends ShareableServerSettingKey>(props: {
  readonly settingKey: K;
  readonly knowsSetting?: ((config: NodeSettingsConfig) => boolean) | undefined;
  readonly compareBy?: ((value: ShareableSettingValue<K>) => unknown) | undefined;
  readonly applyField?:
    | ((
        current: ShareableSettingValue<K>,
        edited: ShareableSettingValue<K>,
      ) => ShareableSettingValue<K>)
    | undefined;
  readonly formatValue?: ((value: ShareableSettingValue<K>) => string) | undefined;
}) {
  const { settingKey: key } = props;
  const source = useSharedSettingsSource();
  const snapshot = useSharedSettingsSnapshot();
  const shared = useSharedSettingsMode();
  // The frozen web phone tier keeps editing one device: the one its settings show.
  const phone = usePresentationTier() === "phone";
  const settingsTarget = useSettingsTarget();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const phoneDevice = settingsTarget?.environmentId ?? primaryEnvironmentId;
  const mode: SharedSettingsMode =
    phone && phoneDevice !== null ? { kind: "device", environmentId: phoneDevice } : shared.mode;
  const showDevice = phone ? null : shared.showDevice;
  const [open, setOpen] = useState(() => takeSharedRowOpen(key));
  const [busy, setBusy] = useState(false);
  const [notes, setNotes] = useState<ReadonlyArray<string>>([]);
  // A later request (the compare table, "Where this device differs") opens it again.
  useEffect(
    () =>
      useSharedRowOpenRequest.subscribe((state) => {
        if (state.key === key && takeSharedRowOpen(key)) setOpen(true);
      }),
    [key],
  );

  const view = useMemo(
    () =>
      readSharedSettingView({
        key,
        devices: snapshot.devices,
        cache: snapshot.cache,
        attempts: snapshot.attempts,
      }),
    [key, snapshot],
  );
  const model = readSharedRowModel({
    view,
    devices: snapshot.devices,
    mode,
    open,
    ...(props.knowsSetting === undefined ? {} : { knowsSetting: props.knowsSetting }),
    ...(props.compareBy === undefined ? {} : { compareBy: props.compareBy }),
  });
  const display = SHARED_SETTING_DISPLAY[key];
  const formatValue = props.formatValue;
  const format = (value: ShareableSettingValue<K> | undefined) =>
    value !== undefined && formatValue !== undefined
      ? formatValue(value)
      : formatSharedSettingValue(key, value);

  const send = async (action: SharedRowAction<K>): Promise<NodeSettingsApplyResult | null> => {
    const command = buildSharedRowCommand({
      key,
      action,
      view,
      devices: snapshot.devices,
      cache: snapshot.cache,
      nextStamp: () => source.nextStamp(snapshot.devices),
      ...(props.applyField === undefined ? {} : { applyField: props.applyField }),
    });
    if (command === null) return null;
    setBusy(true);
    setNotes([]);
    // No `finally`: the React Compiler cannot lower it. The catch takes every failure.
    let result: NodeSettingsApplyResult | null = null;
    try {
      // The settings target joins the source's devices when the source does not list it.
      const extra = snapshot.devices.filter(
        (device) =>
          !source.readDevices().some((known) => known.environmentId === device.environmentId),
      );
      result = await source.run(command, extra);
      setNotes(describeSharedRowOutcome({ action, command, result, view }));
    } catch (error) {
      setNotes([errorMessage(error, "The change was not saved.")]);
    }
    setBusy(false);
    return result;
  };

  return { key, model, view, setOpen, busy, notes, send, format, display, showDevice, mode };
}

/**
 * Runs a writer's save and throws the device's own message when it did not apply: refused, or
 * not written anywhere (offline, read-only, too old).
 */
export async function saveSharedSetting<V>(
  save: (next: V) => Promise<NodeSettingsApplyResult | null>,
  next: V,
): Promise<NodeSettingsApplyResult> {
  const result = await save(next);
  if (result === null) throw new Error("This device cannot be changed now.");
  const failed = result.notApplied.find((entry) => entry.reason === "failed");
  if (failed !== undefined) throw new Error(failed.detail ?? `${failed.label} refused the value.`);
  if (result.applied.length === 0) {
    const missed = result.notApplied[0];
    throw new Error(
      missed === undefined
        ? "No device could be changed now."
        : missed.reason === "read-only"
          ? `Only the owner of ${missed.label} can change it.`
          : missed.reason === "unsupported"
            ? `Update ${missed.label} to change this setting.`
            : `${missed.label} is not connected.`,
    );
  }
  return result;
}

/**
 * For a policy editor inside a larger section (retention, cleanup suggestions): saves the
 * device-level value through the sharing commands, to every device while they agree, else to
 * the device the page shows (its own value), and says how the devices stand in one line.
 */
export function useSharedSettingWriter<K extends ShareableServerSettingKey>(
  settingKey: K,
  options: { readonly knowsSetting?: (config: NodeSettingsConfig) => boolean } = {},
): {
  readonly save: (next: ShareableSettingValue<K>) => Promise<NodeSettingsApplyResult | null>;
  readonly status: ReactNode;
} {
  const state = useSharedSettingState({ settingKey, knowsSetting: options.knowsSetting });
  const settingsTarget = useSettingsTarget();
  const { model, format, notes } = state;
  const shownId =
    state.mode.kind === "device"
      ? state.mode.environmentId
      : (settingsTarget?.environmentId ?? null);
  const shown =
    model.kind === "single"
      ? model.device
      : model.kind === "list"
        ? (model.devices.find((device) => device.environmentId === shownId) ?? null)
        : null;
  const save = (next: ShareableSettingValue<K>) =>
    model.kind === "same"
      ? state.send({ kind: "all", value: next })
      : shown === null
        ? Promise.resolve(null)
        : state.send({ kind: "device", environmentId: shown.environmentId, value: next });
  const others =
    model.kind === "single"
      ? model.others
      : model.kind === "list"
        ? model.devices.flatMap((device) =>
            device.environmentId === shown?.environmentId || device.value === undefined
              ? []
              : [{ label: device.label, value: device.value }],
          )
        : [];
  const line =
    model.kind === "same" ? (
      model.deviceCount > 1 ? (
        <span>
          Same on all {model.deviceCount} devices
          {sameModelNotes(model)
            .map((part) => ` · ${part}`)
            .join("")}
        </span>
      ) : null
    ) : others.length > 0 ? (
      <span className="flex flex-wrap items-center gap-1.5">
        <Badge variant="warning" size="sm">
          Differs
        </Badge>
        {others.map((other) => `${other.label}: ${format(other.value)}`).join(" · ")}
        {shown !== null ? <span>· Saving changes {shown.label} only.</span> : null}
      </span>
    ) : null;
  const mark =
    shown !== null && model.deviceCount > 1 && shown.state.kind !== "shared" ? (
      <DeviceStateMark
        label={shown.label}
        state={shown.state}
        onReset={
          shown.editable
            ? () => void state.send({ kind: "reset", environmentId: shown.environmentId })
            : null
        }
      />
    ) : null;
  const status =
    line || mark || notes.length > 0 ? (
      <span className="flex flex-col gap-1">
        {line}
        {mark}
        {notes.length > 0 ? <span role="status">{notes.join(" ")}</span> : null}
      </span>
    ) : null;
  return { save, status };
}

/** What the one control of a "same" row does not reach, in short parts. */
function sameModelNotes(model: {
  readonly queued: number;
  readonly waitingForOwner: number;
  readonly syncing: number;
  readonly needUpdate: ReadonlyArray<string>;
  readonly notLoaded: number;
}): ReadonlyArray<string> {
  return [
    model.queued > 0 ? `${model.queued} queued until online` : null,
    model.waitingForOwner > 0 ? `${model.waitingForOwner} waiting for an owner` : null,
    model.syncing > 0 ? `${model.syncing} syncing` : null,
    model.needUpdate.length > 0
      ? `${model.needUpdate.join(", ")} need${model.needUpdate.length === 1 ? "s" : ""} an update to share settings`
      : null,
    model.notLoaded > 0 ? `${model.notLoaded} not loaded yet` : null,
  ].filter((part) => part !== null);
}

export function SharedSettingRow<K extends ShareableServerSettingKey>(
  props: SharedSettingRowProps<K>,
) {
  // Shown while only shared rows may (All devices, the device shown unusable).
  return (
    <SharedRowScope>
      <SharedSettingRowBody {...props} />
    </SharedRowScope>
  );
}

function SharedSettingRowBody<K extends ShareableServerSettingKey>(
  props: SharedSettingRowProps<K>,
) {
  const { render } = props;
  const { key, model, setOpen, busy, notes, send, format, display, showDevice } =
    useSharedSettingState(props);
  const rowId =
    props.field === undefined
      ? sharedSettingRowId(key)
      : `${sharedSettingRowId(key)}-${props.field}`;
  const { lastSeenAt } = useSharedSettingsMode();
  const lastSeenLabel = (environmentId: EnvironmentId): string | null => {
    const at = lastSeenAt?.(environmentId) ?? null;
    return at === null ? null : relativeTime(at, Date.now());
  };
  const act = (action: SharedRowAction<K>) => void send(action);

  const block = props.layout === "block";
  const editor = props.layout === "editor";
  const title = props.title ?? display.title;
  const reset = (value: ShareableSettingValue<K>, editable: boolean, onReset: () => void) =>
    props.defaultValue !== undefined &&
    props.resetLabel !== undefined &&
    editable &&
    !shareableSettingValuesEqual(value, props.defaultValue) ? (
      <SettingResetButton label={props.resetLabel} onClick={onReset} disabled={busy} />
    ) : null;
  const noteLines =
    notes.length === 0 ? null : (
      <span role="status" className="block">
        {notes.join(" ")}
      </span>
    );
  const withStatus = (sharing: ReactNode) =>
    props.status || sharing || noteLines ? (
      <>
        {props.status ? <span className="block">{props.status}</span> : null}
        {sharing}
        {noteLines}
      </>
    ) : undefined;

  if (model.kind === "single") {
    const device = model.device;
    const value = device?.value;
    if (device === null || value === undefined) {
      // No config yet: the control waits, disabled, on the default.
      const waiting =
        props.defaultValue === undefined || editor
          ? null
          : render({
              value: props.defaultValue,
              onChange: () => undefined,
              save: async () => null,
              disabled: true,
              deviceLabel: null,
              sharing: null,
              known: true,
            });
      return (
        <SettingsRow
          id={rowId}
          title={title}
          description={props.description}
          owner="node"
          scope={device?.label ?? "Device connecting…"}
          status={withStatus(device === null ? null : <span>Waiting for {device.label}…</span>)}
          control={block ? undefined : waiting}
          {...(props.className === undefined ? {} : { className: props.className })}
        >
          {block ? waiting : undefined}
        </SettingsRow>
      );
    }
    const deviceAction = (next: ShareableSettingValue<K>): SharedRowAction<K> => ({
      kind: "device",
      environmentId: device.environmentId,
      value: next,
    });
    const others =
      model.others.length === 0 ? null : (
        <span className="flex flex-wrap items-center gap-1.5">
          <Badge variant="warning" size="sm">
            Differs
          </Badge>
          {model.others.map((other) => `${other.label}: ${format(other.value)}`).join(" · ")}
        </span>
      );
    const mark =
      model.deviceCount > 1 && device.state.kind !== "shared" ? (
        <DeviceStateMark
          label={device.label}
          state={device.state}
          onReset={
            device.editable
              ? () => act({ kind: "reset", environmentId: device.environmentId })
              : null
          }
        />
      ) : null;
    const singleStatus = !device.knowsSetting ? (
      (props.unknownSettingStatus ?? `Update ${device.label} to change this setting.`)
    ) : others || mark ? (
      <span className="flex flex-col gap-1">
        {others}
        {mark}
      </span>
    ) : null;
    const control = render({
      value,
      onChange: (next) => act(deviceAction(next)),
      save: (next) => send(deviceAction(next)),
      disabled: !device.editable || busy,
      deviceLabel: model.deviceCount > 1 ? device.label : null,
      sharing: editor ? withStatus(singleStatus) : null,
      known: device.knowsSetting,
    });
    if (editor)
      return (
        <div id={rowId} data-shared-setting>
          {control}
        </div>
      );
    return (
      <SettingsRow
        id={rowId}
        scope={device.label}
        title={title}
        description={props.description}
        owner="node"
        status={withStatus(singleStatus)}
        resetAction={reset(value, device.editable, () => {
          if (props.defaultValue !== undefined)
            act({
              kind: "device",
              environmentId: device.environmentId,
              value: props.defaultValue,
            });
        })}
        control={block ? undefined : control}
        {...(props.className === undefined ? {} : { className: props.className })}
      >
        {block ? control : undefined}
      </SettingsRow>
    );
  }

  if (model.kind === "same") {
    const waiting = sameModelNotes(model);
    const sameStatus = withStatus(
      <span className="flex flex-wrap items-center gap-x-1.5" data-testid="shared-setting-same">
        <span>Same on all {model.deviceCount} devices</span>
        {waiting.map((part) => (
          <span key={part}>
            ·{" "}
            <Badge variant="secondary" size="sm">
              {part}
            </Badge>
          </span>
        ))}
        <span aria-hidden>·</span>
        <LinkButton
          onClick={() => setOpen(true)}
          label={`Set ${typeof title === "string" ? title : display.title} per device`}
        >
          Set per device
        </LinkButton>
      </span>,
    );
    const control = render({
      value: model.value,
      onChange: (next) => act({ kind: "all", value: next }),
      save: (next) => send({ kind: "all", value: next }),
      disabled: !model.editable || busy,
      deviceLabel: null,
      sharing: editor ? sameStatus : null,
      known: true,
    });
    if (editor)
      return (
        <div id={rowId} data-shared-setting>
          {control}
        </div>
      );
    return (
      <SettingsRow
        id={rowId}
        scope="All devices"
        title={title}
        description={props.description}
        owner="node"
        status={sameStatus}
        resetAction={reset(model.value, model.editable, () => {
          if (props.defaultValue !== undefined) act({ kind: "all", value: props.defaultValue });
        })}
        control={block ? undefined : control}
        {...(props.className === undefined ? {} : { className: props.className })}
      >
        {block ? control : undefined}
      </SettingsRow>
    );
  }

  const everywhere = model.everywhere;
  const list = (
    <SettingsRow
      id={rowId}
      scope="All devices"
      title={title}
      description={props.description}
      owner="node"
      status={withStatus(
        model.differs > 0 ? (
          <Badge variant="warning" size="sm" data-testid="shared-setting-differs">
            Differs on {model.differs} of {model.deviceCount}
          </Badge>
        ) : null,
      )}
      {...(props.className === undefined ? {} : { className: props.className })}
    >
      <div
        className="min-w-0 rounded-lg border border-border/70"
        data-testid="shared-setting-devices"
        role="group"
        aria-label={`${typeof title === "string" ? title : display.title} on each device`}
      >
        {model.devices.map((device) => (
          <SharedDeviceRow
            key={device.environmentId}
            device={device}
            busy={busy}
            block={block || editor}
            format={format}
            render={render}
            title={typeof title === "string" ? title : display.title}
            onChange={(next) =>
              act({ kind: "device", environmentId: device.environmentId, value: next })
            }
            onReset={() => act({ kind: "reset", environmentId: device.environmentId })}
            onEdit={showDevice === null ? null : () => showDevice(device.environmentId)}
            lastSeen={lastSeenLabel(device.environmentId)}
          />
        ))}
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/60 px-3 py-2">
          <span className="text-xs text-muted-foreground">
            {everywhere === null ? "All devices match." : "Values differ across devices."}
          </span>
          {everywhere === null ? (
            <Button size="xs" variant="outline" onClick={() => setOpen(false)}>
              Done
            </Button>
          ) : (
            <Button
              size="xs"
              variant="outline"
              disabled={busy || !model.everywhereEditable}
              onClick={() => act({ kind: "everywhere", value: everywhere })}
            >
              Use “{format(everywhere)}” everywhere
            </Button>
          )}
        </div>
      </div>
    </SettingsRow>
  );
  return editor ? (
    <SettingsSection title={typeof title === "string" ? title : display.title}>
      {list}
    </SettingsSection>
  ) : (
    list
  );
}

function SharedDeviceRow<K extends ShareableServerSettingKey>(props: {
  readonly device: SharedRowDevice<K>;
  readonly busy: boolean;
  readonly block: boolean;
  readonly format: (value: ShareableSettingValue<K> | undefined) => string;
  readonly render: (control: SharedSettingControl<K>) => ReactNode;
  /** The row's title, for the accessible names of its per-device buttons. */
  readonly title: string;
  readonly onChange: (next: ShareableSettingValue<K>) => void;
  readonly onReset: () => void;
  readonly onEdit: (() => void) | null;
  /** When it was last seen, for an offline device. */
  readonly lastSeen: string | null;
}) {
  const { device } = props;
  const value = device.value;
  return (
    <div
      className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1.5 border-t border-border/60 px-3 py-2 first:border-t-0"
      data-testid="shared-setting-device"
      data-device={device.environmentId}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <DeviceIcon
          environmentId={device.environmentId as EnvironmentId}
          label={device.label}
          className="size-3.5 shrink-0 text-muted-foreground"
        />
        <span className="truncate text-[13px] text-foreground">{device.label}</span>
        <StatusDot connected={device.connected} />
        {device.connected ? null : <span className="text-xs text-muted-foreground">offline</span>}
        <DeviceStateMark
          label={device.label}
          state={device.state}
          onReset={device.editable && !props.busy ? props.onReset : null}
        />
      </div>
      <div className="flex min-w-0 items-center gap-2">
        {value === undefined ? (
          <span className="text-xs text-muted-foreground">Unknown</span>
        ) : !device.connected ? (
          // Its last known value, read only: shared writes reach it through the queue.
          <span className="max-w-64 truncate text-xs text-muted-foreground">
            {props.format(value)}
            {props.lastSeen ? ` · last seen ${props.lastSeen}` : ""}
          </span>
        ) : props.block ? (
          <>
            <span className="max-w-64 truncate text-xs text-muted-foreground">
              {props.format(value)}
            </span>
            {props.onEdit && device.editable ? (
              <Button
                size="xs"
                variant="outline"
                onClick={props.onEdit}
                aria-label={`Edit ${props.title} on ${device.label}`}
              >
                Edit
              </Button>
            ) : null}
          </>
        ) : (
          props.render({
            value,
            onChange: props.onChange,
            save: async (next) => {
              props.onChange(next);
              return null;
            },
            disabled: !device.editable || props.busy,
            deviceLabel: device.label,
            sharing: null,
            known: device.knowsSetting,
          })
        )}
      </div>
    </div>
  );
}
