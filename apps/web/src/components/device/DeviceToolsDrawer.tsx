// The control set follows t3code's Tools drawer (MIT); see THIRD_PARTY_NOTICES.md.
import {
  DeviceColorFilter,
  DeviceTestingTextSize,
  type DeviceDetail,
  type DeviceDetailInput,
  type DeviceDescribeUiResult,
  type DeviceLaunchAppInput,
  type DeviceOpenUrlInput,
  type DeviceOrientation,
  type DevicePlatform,
  type DeviceSetOrientationInput,
  type DeviceTestingAction,
  type DeviceTestingInput,
  type DeviceTestingPermission,
  type DeviceUiFrame,
} from "@ryco/contracts";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import { cn } from "~/lib/utils";
import { createVisibilityAwarePoller } from "~/lib/visibilityPolling";
import { webAppLifecycle } from "~/platform/appLifecycle";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { errorMessage } from "./deviceControls";
import {
  ACCESSIBILITY_TOGGLES,
  ANDROID_PERMISSIONS,
  COLOR_FILTER_LABELS,
  IOS_PERMISSIONS,
  LOCATION_PRESETS,
  PERMISSION_LABELS,
  TEXT_SIZE_LABELS,
  alertPushPayload,
  flattenUiFrames,
  formatCoordinate,
  hasControl,
  isBundleId,
  parseCoordinates,
} from "./deviceTools.logic";

/** The device calls the drawer makes; the panel passes the environment's. */
export interface DeviceToolsApi {
  readonly detail: (input: DeviceDetailInput) => Promise<DeviceDetail>;
  readonly testing: (input: DeviceTestingInput) => Promise<void>;
  readonly launchApp: (input: DeviceLaunchAppInput) => Promise<unknown>;
  readonly openUrl: (input: DeviceOpenUrlInput) => Promise<void>;
  readonly describeUi: (input: { readonly udid: string }) => Promise<DeviceDescribeUiResult>;
  readonly setOrientation?: (input: DeviceSetOrientationInput) => Promise<void>;
}

const fieldClass =
  "h-7 min-w-0 rounded-md border border-border bg-background px-2 text-xs disabled:opacity-60";
/** How long an app takes to come to the front or leave it, before the read-back. */
const APP_SETTLE_MS = 1_000;
/** The overlay re-reads the tree this often while it is on. */
const OVERLAY_REFRESH_MS = 2_000;

const ORIENTATION_LABELS: Record<DeviceOrientation, string> = {
  portrait: "Portrait",
  "landscape-left": "Landscape left",
  "portrait-upside-down": "Upside down",
  "landscape-right": "Landscape right",
};

/**
 * The device's Tools drawer: app, device, accessibility, location, permission
 * and push controls. Every value shown is the one the device reported on the
 * last read, which runs on open and after each change; a control the device
 * does not support is not shown.
 */
export function DeviceToolsDrawer(props: {
  readonly udid: string;
  readonly platform: DevicePlatform;
  /** Changes are owner-only and need a booted, attached device. */
  readonly canChange: boolean;
  readonly api: DeviceToolsApi;
  /** The overlay's frames, or null when it is off. */
  readonly onFramesChange: (frames: readonly DeviceUiFrame[] | null) => void;
}) {
  const { api, udid, onFramesChange } = props;
  const [detail, setDetail] = useState<DeviceDetail | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [status, setStatus] = useState<{ readonly error: boolean; readonly text: string } | null>(
    null,
  );
  const [overlay, setOverlay] = useState(false);
  const [url, setUrl] = useState("");
  const [launchId, setLaunchId] = useState("");
  const [latitude, setLatitude] = useState("");
  const [longitude, setLongitude] = useState("");
  const [permissionApp, setPermissionApp] = useState("");
  const [service, setService] = useState<DeviceTestingPermission>("photos");
  const [pushMode, setPushMode] = useState<"alert" | "json">("alert");
  const [alertText, setAlertText] = useState("Hello from Ryco");
  const [payload, setPayload] = useState('{"aps":{"alert":"Hello from Ryco","sound":"default"}}');
  const inFlight = useRef(false);
  const reads = useRef(0);

  const foreground = detail?.foregroundApp?.bundleId ?? null;
  const permissionTarget = permissionApp.trim() || foreground || "";

  const refresh = useCallback(
    async (bundleId?: string) => {
      const read = ++reads.current;
      try {
        const next = await api.detail({
          udid,
          ...(bundleId && isBundleId(bundleId) ? { bundleId } : {}),
        });
        if (read !== reads.current) return;
        setDetail(next);
        setReadError(null);
      } catch (error) {
        if (read !== reads.current) return;
        setReadError(errorMessage(error, "The device did not report its settings."));
      }
    },
    [api, udid],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Element frames follow the screen while the overlay is on.
  useEffect(() => {
    if (!overlay) {
      onFramesChange(null);
      return;
    }
    let cancelled = false;
    const read = () =>
      api.describeUi({ udid }).then(
        (result) => {
          if (!cancelled) onFramesChange(flattenUiFrames(result.root));
        },
        (error: unknown) => {
          if (cancelled) return;
          setStatus({ error: true, text: errorMessage(error, "Could not read the elements.") });
          setOverlay(false);
        },
      );
    // Paused while the window is hidden; reads at once when it shows again.
    const poller = createVisibilityAwarePoller({
      lifecycle: webAppLifecycle,
      run: read,
      resolveDelayMs: () => OVERLAY_REFRESH_MS,
    });
    return () => {
      cancelled = true;
      poller.stop();
    };
  }, [api, onFramesChange, overlay, udid]);
  useEffect(() => () => onFramesChange(null), [onFramesChange]);

  /** Run one change, then read the device back so every control shows its real value. */
  const change = (
    key: string,
    action: () => Promise<unknown>,
    done: string,
    // An app takes a moment to come to the front (or leave it) after the call returns.
    settleMs = 0,
  ): Promise<void> => {
    if (!props.canChange || inFlight.current) return Promise.resolve();
    inFlight.current = true;
    setPending(key);
    setStatus(null);
    return action()
      .then(
        () => setStatus({ error: false, text: done }),
        (error: unknown) =>
          setStatus({ error: true, text: errorMessage(error, "The device did not apply that.") }),
      )
      .then(() =>
        settleMs > 0 ? new Promise<void>((resolve) => setTimeout(resolve, settleMs)) : undefined,
      )
      .then(() => refresh(permissionApp.trim() || undefined))
      .then(() => {
        inFlight.current = false;
        setPending(null);
      });
  };
  const testing = (key: string, action: DeviceTestingAction, done: string) =>
    void change(key, () => api.testing({ udid, action }), done);

  const settings = detail?.settings;
  const disabled = !props.canChange || pending !== null;
  const ios = props.platform === "ios-simulator";
  const coordinates = parseCoordinates(latitude, longitude);
  const permissions = ios ? IOS_PERMISSIONS : ANDROID_PERMISSIONS;
  const has = (control: Parameters<typeof hasControl>[1]) => hasControl(detail, control);

  return (
    <div
      data-device-tools
      className="max-h-[45%] shrink-0 overflow-y-auto border-t border-border/60 bg-card/40 px-3 py-2 text-xs"
    >
      <div className="flex items-center justify-between gap-2">
        <p className="font-medium">Tools</p>
        <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
          {detail ? <span>Read {new Date(detail.capturedAt).toLocaleTimeString()}</span> : null}
          <Button size="xs" variant="ghost" onClick={() => void refresh(permissionApp.trim())}>
            Refresh
          </Button>
        </div>
      </div>
      {readError ? (
        <p role="alert" className="mt-1 text-destructive">
          {readError}
        </p>
      ) : null}
      {!detail && !readError ? (
        <p role="status" className="mt-1 text-muted-foreground">
          Reading the device's settings…
        </p>
      ) : null}
      {!props.canChange ? (
        <p className="mt-1 text-muted-foreground">
          Values are read from the device. Changing them needs owner access and an attached device.
        </p>
      ) : null}

      {detail ? (
        <div className="mt-2 space-y-3">
          {has("foreground-app") ? (
            <Group title="App">
              <Row label="In front">
                <span className="min-w-0 truncate font-mono" data-testid="device-foreground-app">
                  {detail.foregroundApp
                    ? `${detail.foregroundApp.bundleId}${detail.foregroundApp.name ? ` (${detail.foregroundApp.name})` : ""}`
                    : detail.foregroundApp === null
                      ? "Home screen"
                      : "Not reported"}
                </span>
              </Row>
              {foreground ? (
                <div className="flex gap-1.5">
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={disabled}
                    onClick={() =>
                      void change(
                        "terminate",
                        () =>
                          api.testing({
                            udid,
                            action: { type: "terminate-app", bundleId: foreground },
                          }),
                        `Stopped ${foreground}.`,
                        APP_SETTLE_MS,
                      )
                    }
                  >
                    Terminate
                  </Button>
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={disabled}
                    onClick={() =>
                      void change(
                        "relaunch",
                        async () => {
                          await api
                            .testing({
                              udid,
                              action: { type: "terminate-app", bundleId: foreground },
                            })
                            .catch(() => undefined);
                          await api.launchApp({ udid, bundleId: foreground });
                        },
                        `Relaunched ${foreground}.`,
                        // A cold launch takes longer to reach the front.
                        APP_SETTLE_MS * 2.5,
                      )
                    }
                  >
                    Relaunch
                  </Button>
                </div>
              ) : null}
              <InlineForm
                placeholder="https://example.com or myapp://path"
                value={url}
                onChange={setUrl}
                disabled={disabled}
                action="Open URL"
                ready={url.trim().length > 0}
                onSubmit={() =>
                  void change(
                    "open-url",
                    () => api.openUrl({ udid, url: url.trim() }),
                    "URL opened.",
                    APP_SETTLE_MS,
                  )
                }
              />
              <InlineForm
                placeholder={ios ? "com.apple.Preferences" : "com.android.settings"}
                value={launchId}
                onChange={setLaunchId}
                disabled={disabled}
                action="Launch"
                ready={isBundleId(launchId.trim())}
                onSubmit={() =>
                  void change(
                    "launch",
                    () => api.launchApp({ udid, bundleId: launchId.trim() }),
                    `Launched ${launchId.trim()}.`,
                    APP_SETTLE_MS,
                  )
                }
              />
            </Group>
          ) : null}

          <Group title="Device">
            {has("appearance") ? (
              <Row label="Appearance">
                <Segmented
                  label="Appearance"
                  value={settings?.appearance ?? null}
                  options={[
                    ["light", "Light"],
                    ["dark", "Dark"],
                  ]}
                  disabled={disabled}
                  onChange={(value) =>
                    testing("appearance", { type: "appearance", value }, "Appearance changed.")
                  }
                />
              </Row>
            ) : null}
            {has("text-size") ? (
              <Row label="Text size">
                <select
                  aria-label="Text size"
                  className={fieldClass}
                  disabled={disabled}
                  value={settings?.textSize ?? ""}
                  onChange={(event) =>
                    testing(
                      "text-size",
                      { type: "text-size", value: event.target.value as DeviceTestingTextSize },
                      "Text size changed.",
                    )
                  }
                >
                  {settings?.textSize ? null : <option value="">Unknown</option>}
                  {DeviceTestingTextSize.literals.map((value) => (
                    <option key={value} value={value}>
                      {TEXT_SIZE_LABELS[value]}
                    </option>
                  ))}
                </select>
                {settings?.fontScale !== undefined ? (
                  <span className="text-[10px] text-muted-foreground">×{settings.fontScale}</span>
                ) : null}
              </Row>
            ) : null}
            {has("orientation") ? (
              <Row label="Orientation">
                <select
                  aria-label="Orientation"
                  className={fieldClass}
                  disabled={disabled || (ios && !api.setOrientation)}
                  value={settings?.orientation ?? ""}
                  onChange={(event) => {
                    const orientation = event.target.value as DeviceOrientation;
                    const setOrientation = api.setOrientation;
                    void change(
                      "orientation",
                      () =>
                        ios && setOrientation
                          ? setOrientation({ udid, orientation })
                          : api.testing({
                              udid,
                              action: { type: "orientation", value: orientation },
                            }),
                      "Orientation changed.",
                    );
                  }}
                >
                  {settings?.orientation ? null : <option value="">Unknown</option>}
                  {(Object.keys(ORIENTATION_LABELS) as DeviceOrientation[]).map((value) => (
                    <option key={value} value={value}>
                      {ORIENTATION_LABELS[value]}
                    </option>
                  ))}
                </select>
              </Row>
            ) : null}
            {has("liquid-glass") ? (
              <Row label="Liquid Glass">
                <Segmented
                  label="Liquid Glass"
                  value={settings?.liquidGlass ?? null}
                  options={[
                    ["clear", "Clear"],
                    ["tinted", "Tinted"],
                  ]}
                  disabled={disabled}
                  onChange={(value) =>
                    testing(
                      "liquid-glass",
                      { type: "liquid-glass", value },
                      "Liquid Glass changed.",
                    )
                  }
                />
              </Row>
            ) : null}
            {has("color-filter") ? (
              <Row label="Color filter">
                <select
                  aria-label="Color filter"
                  className={fieldClass}
                  disabled={disabled}
                  value={settings?.colorFilter ?? ""}
                  onChange={(event) =>
                    testing(
                      "color-filter",
                      { type: "color-filter", value: event.target.value as DeviceColorFilter },
                      "Color filter changed.",
                    )
                  }
                >
                  {settings?.colorFilter ? null : <option value="">Unknown</option>}
                  {DeviceColorFilter.literals.map((value) => (
                    <option key={value} value={value}>
                      {COLOR_FILTER_LABELS[value]}
                    </option>
                  ))}
                </select>
              </Row>
            ) : null}
            {has("network") ? (
              <Row label="Network">
                <ToggleValue
                  label="Network"
                  checked={settings?.network === undefined ? null : settings.network === "on"}
                  disabled={disabled}
                  onChange={(on) =>
                    testing(
                      "network",
                      { type: "network", value: on ? "on" : "off" },
                      on ? "Network on." : "Network off.",
                    )
                  }
                />
              </Row>
            ) : null}
          </Group>

          {ACCESSIBILITY_TOGGLES.some((toggle) => has(toggle.setting)) ? (
            <Group title="Accessibility">
              {ACCESSIBILITY_TOGGLES.filter((toggle) => has(toggle.setting)).map((toggle) => (
                <Row key={toggle.setting} label={toggle.label}>
                  <ToggleValue
                    label={toggle.label}
                    checked={settings?.[toggle.field] ?? null}
                    disabled={disabled}
                    onChange={(value) =>
                      testing(
                        toggle.setting,
                        { type: "accessibility", setting: toggle.setting, value },
                        `${toggle.label} ${value ? "on" : "off"}.`,
                      )
                    }
                  />
                </Row>
              ))}
              <Row label="Element frames">
                <Switch
                  aria-label="Show element frames"
                  checked={overlay}
                  onCheckedChange={(checked) => setOverlay(Boolean(checked))}
                />
              </Row>
            </Group>
          ) : null}

          {has("location") ? (
            <Group title="Location">
              <Row label="Simulated">
                <span data-testid="device-location">
                  {settings?.location
                    ? `${formatCoordinate(settings.location.latitude)}, ${formatCoordinate(settings.location.longitude)}${settings.location.source === "applied" ? " (last set by Ryco)" : ""}`
                    : settings?.location === null
                      ? "None"
                      : "Not reported"}
                </span>
              </Row>
              <div className="flex flex-wrap gap-1">
                {LOCATION_PRESETS.map((preset) => (
                  <Button
                    key={preset.label}
                    size="xs"
                    variant="outline"
                    disabled={disabled}
                    onClick={() =>
                      testing(
                        "location",
                        {
                          type: "location",
                          latitude: preset.latitude,
                          longitude: preset.longitude,
                        },
                        `Location set to ${preset.label}.`,
                      )
                    }
                  >
                    {preset.label}
                  </Button>
                ))}
              </div>
              <div className="flex gap-1.5">
                <input
                  aria-label="Latitude"
                  className={cn(fieldClass, "w-24")}
                  inputMode="decimal"
                  placeholder="Latitude"
                  value={latitude}
                  disabled={disabled}
                  onChange={(event) => setLatitude(event.target.value)}
                />
                <input
                  aria-label="Longitude"
                  className={cn(fieldClass, "w-24")}
                  inputMode="decimal"
                  placeholder="Longitude"
                  value={longitude}
                  disabled={disabled}
                  onChange={(event) => setLongitude(event.target.value)}
                />
                <Button
                  size="xs"
                  variant="outline"
                  disabled={disabled || !coordinates}
                  onClick={() =>
                    coordinates &&
                    testing("location", { type: "location", ...coordinates }, "Location set.")
                  }
                >
                  Set
                </Button>
                {has("clear-location") ? (
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={disabled}
                    onClick={() =>
                      testing("clear-location", { type: "clear-location" }, "Location cleared.")
                    }
                  >
                    Clear
                  </Button>
                ) : null}
              </div>
            </Group>
          ) : null}

          {has("permission") ? (
            <Group title="Permissions">
              <div className="flex gap-1.5">
                <input
                  aria-label="App for permissions"
                  className={cn(fieldClass, "flex-1 font-mono")}
                  placeholder={foreground ?? "com.example.app"}
                  value={permissionApp}
                  autoCapitalize="none"
                  spellCheck={false}
                  onChange={(event) => setPermissionApp(event.target.value)}
                  onBlur={() => void refresh(permissionApp.trim() || undefined)}
                />
                <select
                  aria-label="Permission"
                  className={fieldClass}
                  value={service}
                  onChange={(event) => setService(event.target.value as DeviceTestingPermission)}
                >
                  {permissions.map((value) => (
                    <option key={value} value={value}>
                      {PERMISSION_LABELS[value]}
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex gap-1.5">
                {(["grant", "revoke", "reset"] as const).map((decision) => (
                  <Button
                    key={decision}
                    size="xs"
                    variant="outline"
                    disabled={disabled || !isBundleId(permissionTarget)}
                    onClick={() =>
                      testing(
                        `permission-${decision}`,
                        { type: "permission", bundleId: permissionTarget, service, decision },
                        `${PERMISSION_LABELS[service]}: ${decision === "grant" ? "granted" : decision === "revoke" ? "revoked" : "reset"}.`,
                      )
                    }
                  >
                    {decision === "grant" ? "Grant" : decision === "revoke" ? "Revoke" : "Reset"}
                  </Button>
                ))}
              </div>
              {detail.permissions && detail.permissions.bundleId === permissionTarget ? (
                <ul className="flex flex-wrap gap-1" aria-label="Permission states">
                  {detail.permissions.states.map((entry) => (
                    <li
                      key={entry.service}
                      className={cn(
                        "rounded border px-1.5 py-0.5 text-[10px]",
                        entry.state === "granted" || entry.state === "limited"
                          ? "border-emerald-500/40 text-emerald-700 dark:text-emerald-300"
                          : entry.state === "denied"
                            ? "border-red-500/40 text-red-700 dark:text-red-300"
                            : "border-border text-muted-foreground",
                      )}
                    >
                      {PERMISSION_LABELS[entry.service]}: {entry.state.replace("-", " ")}
                    </li>
                  ))}
                </ul>
              ) : null}
              <p className="text-[10px] text-muted-foreground">
                {ios
                  ? "Changing a permission may stop the app. Location states are not readable here."
                  : "The app must declare a permission in its manifest to change it."}
              </p>
            </Group>
          ) : null}

          {has("push") ? (
            <Group title="Push">
              <Segmented
                label="Push payload"
                value={pushMode}
                options={[
                  ["alert", "Alert text"],
                  ["json", "JSON"],
                ]}
                disabled={false}
                onChange={setPushMode}
              />
              {pushMode === "alert" ? (
                <input
                  aria-label="Alert text"
                  className={cn(fieldClass, "w-full")}
                  maxLength={1_000}
                  value={alertText}
                  onChange={(event) => setAlertText(event.target.value)}
                />
              ) : (
                <textarea
                  aria-label="Push payload (JSON)"
                  className={cn(fieldClass, "h-20 w-full py-1 font-mono")}
                  maxLength={4096}
                  value={payload}
                  spellCheck={false}
                  onChange={(event) => setPayload(event.target.value)}
                />
              )}
              <div className="flex items-center gap-2">
                <Button
                  size="xs"
                  variant="outline"
                  disabled={
                    disabled ||
                    !isBundleId(permissionTarget) ||
                    (pushMode === "alert" ? !alertText.trim() : !payload.trim())
                  }
                  onClick={() =>
                    testing(
                      "push",
                      {
                        type: "push",
                        bundleId: permissionTarget,
                        payload:
                          pushMode === "alert" ? alertPushPayload(alertText.trim()) : payload,
                      },
                      `Push sent to ${permissionTarget}.`,
                    )
                  }
                >
                  Send push
                </Button>
                <span className="min-w-0 truncate text-[10px] text-muted-foreground">
                  To {permissionTarget || "the app in front"}. Local only; not APNs.
                </span>
              </div>
            </Group>
          ) : null}

          {has("presets") ? (
            <Group title="Presets">
              <div className="flex flex-wrap gap-1">
                {(
                  [
                    ["dark", "Dark"],
                    ["large-text", "Large text"],
                    ["dark-large-text", "Dark + large"],
                    ["standard", "Standard"],
                  ] as const
                ).map(([value, label]) => (
                  <Button
                    key={value}
                    size="xs"
                    variant="outline"
                    disabled={disabled}
                    onClick={() =>
                      testing(`preset-${value}`, { type: "preset", value }, `${label} applied.`)
                    }
                  >
                    {label}
                  </Button>
                ))}
              </div>
            </Group>
          ) : null}
        </div>
      ) : null}

      {pending ? (
        <p role="status" className="mt-2 text-muted-foreground">
          Applying…
        </p>
      ) : status ? (
        <p
          role={status.error ? "alert" : "status"}
          className={cn("mt-2", status.error ? "text-destructive" : "text-muted-foreground")}
        >
          {status.text}
        </p>
      ) : null}
    </div>
  );
}

function Group(props: { readonly title: string; readonly children: ReactNode }) {
  return (
    <section aria-label={props.title} className="space-y-1.5">
      <p className="text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
        {props.title}
      </p>
      {props.children}
    </section>
  );
}

function Row(props: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="flex min-h-7 items-center justify-between gap-2">
      <span className="shrink-0 text-muted-foreground">{props.label}</span>
      <div className="flex min-w-0 items-center justify-end gap-1.5">{props.children}</div>
    </div>
  );
}

/** A switch showing the device's value; unknown reads as a dash, not as off. */
function ToggleValue(props: {
  readonly label: string;
  readonly checked: boolean | null;
  readonly disabled: boolean;
  readonly onChange: (value: boolean) => void;
}) {
  if (props.checked === null) {
    return <span className="text-muted-foreground">Not reported</span>;
  }
  return (
    <Switch
      aria-label={props.label}
      checked={props.checked}
      disabled={props.disabled}
      onCheckedChange={(checked) => props.onChange(Boolean(checked))}
    />
  );
}

function Segmented<T extends string>(props: {
  readonly label: string;
  readonly value: T | null;
  readonly options: readonly (readonly [T, string])[];
  readonly disabled: boolean;
  readonly onChange: (value: T) => void;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={props.label}
      className="flex rounded-md border border-border p-0.5"
    >
      {props.options.map(([value, label]) => (
        <button
          key={value}
          type="button"
          role="radio"
          aria-checked={props.value === value}
          disabled={props.disabled}
          className={cn(
            "rounded px-2 py-0.5 text-[11px] disabled:opacity-60",
            props.value === value ? "bg-primary text-primary-foreground" : "hover:bg-muted",
          )}
          onClick={() => {
            if (props.value !== value) props.onChange(value);
          }}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

function InlineForm(props: {
  readonly placeholder: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly disabled: boolean;
  readonly action: string;
  readonly ready: boolean;
  readonly onSubmit: () => void;
}) {
  return (
    <div className="flex gap-1.5">
      <input
        aria-label={props.action}
        className={cn(fieldClass, "flex-1 font-mono")}
        placeholder={props.placeholder}
        value={props.value}
        disabled={props.disabled}
        autoCapitalize="none"
        spellCheck={false}
        onChange={(event) => props.onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && props.ready && !props.disabled) props.onSubmit();
        }}
      />
      <Button
        size="xs"
        variant="outline"
        disabled={props.disabled || !props.ready}
        onClick={props.onSubmit}
      >
        {props.action}
      </Button>
    </div>
  );
}
