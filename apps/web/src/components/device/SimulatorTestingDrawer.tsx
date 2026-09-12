import {
  DeviceTestingPermission,
  DeviceTestingTextSize,
  type DeviceTestingAction,
  type DeviceTestingInput,
} from "@ryco/contracts";
import { useRef, useState } from "react";
import { Button } from "../ui/button";

const fieldClass = "w-full rounded-md border border-border bg-background px-2 py-1.5 text-xs";

export function SimulatorTestingDrawer(props: {
  readonly udid: string;
  readonly disabled: boolean;
  readonly testing: (input: DeviceTestingInput) => Promise<void>;
}) {
  const [pending, setPending] = useState(false);
  const inFlight = useRef(false);
  const [status, setStatus] = useState<{ error: boolean; text: string } | null>(null);
  const [appearance, setAppearance] = useState<"light" | "dark">("dark");
  const [textSize, setTextSize] =
    useState<typeof DeviceTestingTextSize.Type>("accessibility-large");
  const [latitude, setLatitude] = useState("");
  const [longitude, setLongitude] = useState("");
  const [bundleId, setBundleId] = useState("");
  const [service, setService] = useState<typeof DeviceTestingPermission.Type>("location");
  const [payload, setPayload] = useState('{"aps":{"alert":"Hello from Ryco","sound":"default"}}');
  const disabled = props.disabled || pending;
  const appReady = /^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(bundleId) && bundleId.length <= 256;
  const lat = Number(latitude);
  const lon = Number(longitude);
  const locationReady =
    latitude.trim() !== "" &&
    longitude.trim() !== "" &&
    Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    Math.abs(lat) <= 90 &&
    Math.abs(lon) <= 180;

  async function apply(action: DeviceTestingAction, label: string) {
    if (props.disabled || inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    setStatus(null);
    try {
      await props.testing({ udid: props.udid, action });
      setStatus({ error: false, text: label });
    } catch (error) {
      setStatus({
        error: true,
        text: error instanceof Error ? error.message : "The simulator testing action failed.",
      });
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }

  return (
    <details className="max-h-[55%] shrink-0 overflow-y-auto border-b border-border/60 bg-card/40">
      <summary className="cursor-pointer px-3 py-2 text-xs font-medium">Simulator testing</summary>
      <div className="space-y-4 px-3 pb-3 text-xs">
        <p className="text-muted-foreground">
          Apply test settings to this simulator. Values below are choices to apply, not a reading of
          its current settings.
        </p>
        {props.disabled ? (
          <p className="text-muted-foreground">Connect a booted simulator to enable testing.</p>
        ) : null}
        <fieldset disabled={disabled} className="space-y-2">
          <legend className="mb-2 font-medium">Reusable presets</legend>
          <div className="flex flex-wrap gap-1.5">
            {(
              [
                ["dark", "Dark mode"],
                ["large-text", "Large text"],
                ["dark-large-text", "Dark + large text"],
                ["standard", "Light + default text"],
              ] as const
            ).map(([value, label]) => (
              <Button
                key={value}
                size="xs"
                variant="outline"
                onClick={() => void apply({ type: "preset", value }, `${label} applied.`)}
              >
                {label}
              </Button>
            ))}
          </div>
          <p className="text-muted-foreground">
            Large text uses Accessibility Large. Presets change only appearance and/or text size.
          </p>
        </fieldset>
        <fieldset disabled={disabled} className="space-y-2">
          <legend className="mb-2 font-medium">Appearance and text size</legend>
          <div className="flex items-end gap-2">
            <label className="min-w-0 flex-1 space-y-1">
              <span>Appearance</span>
              <select
                className={fieldClass}
                value={appearance}
                onChange={(event) => setAppearance(event.target.value as typeof appearance)}
              >
                <option value="light">Light</option>
                <option value="dark">Dark</option>
              </select>
            </label>
            <Button
              size="xs"
              variant="outline"
              onClick={() =>
                void apply({ type: "appearance", value: appearance }, "Appearance applied.")
              }
            >
              Apply appearance
            </Button>
          </div>
          <div className="flex items-end gap-2">
            <label className="min-w-0 flex-1 space-y-1">
              <span>Text size</span>
              <select
                className={fieldClass}
                value={textSize}
                onChange={(event) => setTextSize(event.target.value as typeof textSize)}
              >
                {DeviceTestingTextSize.literals.map((value) => (
                  <option key={value} value={value}>
                    {value === "large" ? "large (default)" : value}
                  </option>
                ))}
              </select>
            </label>
            <Button
              size="xs"
              variant="outline"
              onClick={() =>
                void apply({ type: "text-size", value: textSize }, "Text size applied.")
              }
            >
              Apply text size
            </Button>
          </div>
        </fieldset>
        <fieldset disabled={disabled} className="space-y-2">
          <legend className="mb-2 font-medium">Location</legend>
          <div className="grid grid-cols-2 gap-2">
            <label className="space-y-1">
              <span>Latitude</span>
              <input
                className={fieldClass}
                type="number"
                min={-90}
                max={90}
                step="any"
                placeholder="37.3349"
                value={latitude}
                onChange={(event) => setLatitude(event.target.value)}
              />
            </label>
            <label className="space-y-1">
              <span>Longitude</span>
              <input
                className={fieldClass}
                type="number"
                min={-180}
                max={180}
                step="any"
                placeholder="-122.0090"
                value={longitude}
                onChange={(event) => setLongitude(event.target.value)}
              />
            </label>
          </div>
          <div className="flex gap-2">
            <Button
              size="xs"
              variant="outline"
              disabled={!locationReady}
              onClick={() =>
                void apply(
                  { type: "location", latitude: lat, longitude: lon },
                  "Simulated location applied.",
                )
              }
            >
              Set location
            </Button>
            <Button
              size="xs"
              variant="outline"
              onClick={() => void apply({ type: "clear-location" }, "Simulated location cleared.")}
            >
              Clear location
            </Button>
          </div>
        </fieldset>
        <fieldset disabled={disabled} className="space-y-2">
          <legend className="mb-2 font-medium">App permissions and push</legend>
          <label className="block space-y-1">
            <span>App bundle ID</span>
            <input
              className={fieldClass}
              maxLength={256}
              placeholder="com.example.app"
              value={bundleId}
              onChange={(event) => setBundleId(event.target.value)}
              autoCapitalize="none"
              spellCheck={false}
            />
          </label>
          <label className="block space-y-1">
            <span>Permission</span>
            <select
              className={fieldClass}
              value={service}
              onChange={(event) => setService(event.target.value as typeof service)}
            >
              {DeviceTestingPermission.literals.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </label>
          <div className="flex flex-wrap gap-2">
            {(["grant", "revoke", "reset"] as const).map((decision) => (
              <Button
                key={decision}
                size="xs"
                variant="outline"
                disabled={!appReady}
                onClick={() =>
                  void apply(
                    { type: "permission", bundleId, service, decision },
                    `Permission ${decision} completed.`,
                  )
                }
              >
                {decision === "grant"
                  ? "Grant"
                  : decision === "revoke"
                    ? "Revoke"
                    : "Reset to prompt"}
              </Button>
            ))}
          </div>
          <p className="text-muted-foreground">
            Permission changes may stop the app. Camera and notification permission changes are not
            supported here; allow notifications in the app before testing an alert.
          </p>
          <label className="block space-y-1">
            <span>Push payload (JSON)</span>
            <textarea
              className={`${fieldClass} min-h-24 font-mono`}
              maxLength={4096}
              value={payload}
              onChange={(event) => setPayload(event.target.value)}
              spellCheck={false}
            />
          </label>
          <p className="text-muted-foreground">
            Maximum 4,096 UTF-8 bytes, including an aps object. Simulates an app notification
            locally; it does not test APNs delivery.
          </p>
          <Button
            size="xs"
            variant="outline"
            disabled={!appReady || !payload.trim()}
            onClick={() =>
              void apply({ type: "push", bundleId, payload }, "Push delivered to the simulator.")
            }
          >
            Send push
          </Button>
        </fieldset>
        {pending ? <p role="status">Applying simulator test…</p> : null}
        {status ? (
          <p
            role={status.error ? "alert" : "status"}
            className={status.error ? "text-destructive" : "text-muted-foreground"}
          >
            {status.text}
          </p>
        ) : null}
      </div>
    </details>
  );
}
