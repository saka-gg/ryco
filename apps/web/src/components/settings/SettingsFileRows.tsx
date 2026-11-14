import type { EnvironmentId } from "@ryco/contracts";
import { useLayoutEffect, useRef, useState } from "react";

import { useTheme } from "../../hooks/useTheme";
import { getClientSettingsSnapshot } from "../../hooks/clientSettingsStore";
import { persistClientSettingsUpdate } from "../../hooks/useSettings";
import {
  applyClientSettingsImport,
  buildClientSettingsFile,
  type ClientSettingsFileState,
  type ClientSettingsImportPlan,
  readClientSettingsImportFile,
} from "../../settingsFile/clientSettingsFile";
import {
  buildDeviceSettingsRestoreCommands,
  buildDeviceSettingsSection,
  deviceSettingsRestoreHasWork,
  deviceTakesOwnValueNow,
  pickableRestoreDevices,
  previewDeviceSettingsRestore,
  summarizeDeviceSettingsRestore,
  type DeviceRestoreChange,
  type DeviceRestoreOutcome,
  type DeviceRestorePreview,
  type DeviceRestoreTargets,
  type DeviceSettingsFileKey,
} from "../../settingsFile/deviceSettingsFile";
import {
  applyAppearancePreferencesToDocument,
  getAppearancePreferences,
  setAppearancePreference,
} from "../../themes/appearancePreferences";
import {
  addCustomTheme,
  deleteCustomTheme,
  generateCustomThemeId,
  getAllThemes,
  getCustomThemes,
} from "../../themes/registry";
import { downloadJsonFile } from "../../themes/transport";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Radio, RadioGroup } from "../ui/radio-group";
import { SettingsRow } from "./settingsLayout";
import {
  formatSharedSettingValue,
  SHARED_SETTING_DISPLAY,
} from "./sharedSettings/sharedSettingsCatalog";
import { useSharedSettingsMode } from "./sharedSettings/sharedSettingsMode";
import {
  useSharedSettingsSnapshot,
  useSharedSettingsSource,
  type SharedSettingsSnapshot,
} from "./sharedSettings/sharedSettingsSource";
import { errorMessage } from "~/lib/errorMessage";

function Choice(props: {
  readonly label: string;
  readonly description: string;
  readonly checked: boolean;
  readonly disabled?: boolean;
  readonly onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-2.5 text-[13px] text-foreground has-data-disabled:cursor-default has-data-disabled:opacity-64">
      <Checkbox
        className="mt-0.5"
        checked={props.checked}
        disabled={props.disabled === true}
        onCheckedChange={(checked) => props.onChange(checked === true)}
      />
      <span>
        {props.label}
        <span className="block text-xs text-muted-foreground">{props.description}</span>
      </span>
    </label>
  );
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** A shared setting's name, as its row shows it. */
function settingTitle(key: DeviceSettingsFileKey): string {
  return SHARED_SETTING_DISPLAY[key].title;
}

function titles(keys: ReadonlyArray<DeviceSettingsFileKey>): string {
  return keys.map(settingTitle).join(", ");
}

/** One change as its row reads values: "Writing style: Conventional -> Repository". */
function changeLine({ key, from, to }: DeviceRestoreChange): string {
  const before = formatSharedSettingValue(key, from);
  const after = formatSharedSettingValue(key, to);
  return before === after
    ? `${settingTitle(key)}: ${after} (edited)`
    : `${settingTitle(key)}: ${before} -> ${after}`;
}

function waitNote(preview: DeviceRestorePreview): string | null {
  if (preview.waits === null || preview.changes.length === 0) return null;
  if (preview.catchesUp) return "takes it when it is back online";
  return preview.waits === "offline"
    ? "not changed: offline"
    : "not changed: only an owner can change it";
}

function DevicePreview({ preview }: { readonly preview: DeviceRestorePreview }) {
  const notes = [
    preview.changes.length === 0
      ? "nothing changes"
      : plural(preview.changes.length, "change", "changes"),
    waitNote(preview),
  ].filter(Boolean);
  return (
    <li data-device-preview={preview.label} className="space-y-1">
      <p className="text-xs">
        <span className="font-medium text-foreground">{preview.label}</span>
        <span className="text-muted-foreground"> · {notes.join(" · ")}</span>
      </p>
      {preview.changes.length > 0 ? (
        <ul aria-label={`Changes on ${preview.label}`} className="space-y-0.5 text-xs">
          {preview.changes.map((change) => (
            <li key={change.key}>{changeLine(change)}</li>
          ))}
        </ul>
      ) : null}
      {preview.keepsOwn.length > 0 ? (
        <p className="text-xs text-muted-foreground">
          Keeps its own value: {titles(preview.keepsOwn)}
        </p>
      ) : null}
      {preview.becomesOwn.length > 0 ? (
        <p className="text-xs text-muted-foreground">
          Becomes its own value here: {titles(preview.becomesOwn)}
        </p>
      ) : null}
    </li>
  );
}

function outcomeLine(outcome: DeviceRestoreOutcome): string {
  const parts = [
    outcome.applied.length > 0
      ? `${plural(outcome.applied.length, "setting", "settings")} applied`
      : null,
    outcome.queued.length > 0 ? `${outcome.queued.length} queued until online` : null,
    ...(["offline", "read-only"] as const).map((reason) => {
      const count = outcome.notApplied.filter((entry) => entry.reason === reason).length;
      if (count === 0) return null;
      return `${count} not applied (${reason === "offline" ? "offline" : "only an owner can change it"})`;
    }),
    outcome.kept.some((entry) => entry.reason === "override")
      ? `${outcome.kept.filter((entry) => entry.reason === "override").length} kept its own value`
      : null,
    outcome.kept.some((entry) => entry.reason === "unsupported")
      ? "needs a Ryco update to share settings"
      : null,
    ...outcome.failed.map((entry) => `Couldn't apply ${settingTitle(entry.key)}: ${entry.detail}`),
  ].filter(Boolean);
  return `${outcome.label}: ${parts.length === 0 ? "nothing to change" : parts.join(" · ")}`;
}

/** Devices the snapshot knows that the source does not list (the settings target). */
function extraDevices(
  snapshot: SharedSettingsSnapshot,
  source: ReturnType<typeof useSharedSettingsSource>,
) {
  const listed = new Set(source.readDevices().map((device) => device.environmentId));
  return snapshot.devices.filter((device) => !listed.has(device.environmentId));
}

/**
 * Data & backup → Settings file: Back up (this app's settings and/or the shared device
 * settings, to one file) and Restore (checked first, every change listed, this app's part all
 * or nothing, the device part to every device or to the devices picked). Nothing changes until
 * Apply.
 */
export function SettingsFileRows({
  shownEnvironmentId,
}: {
  /** The device the settings show: a backup takes its value where the devices disagree. */
  readonly shownEnvironmentId?: EnvironmentId | null;
} = {}) {
  const { theme, setTheme, activeThemeId, setActiveTheme } = useTheme();
  const snapshot = useSharedSettingsSnapshot();
  // Apply reads the devices as they are once the app part is saved, not as they were rendered.
  const latestSnapshot = useRef(snapshot);
  useLayoutEffect(() => {
    latestSnapshot.current = snapshot;
  }, [snapshot]);
  const source = useSharedSettingsSource();
  const { mode } = useSharedSettingsMode();
  const preferred =
    shownEnvironmentId ?? (mode.kind === "device" ? mode.environmentId : null) ?? null;
  const inputRef = useRef<HTMLInputElement>(null);
  const knownDevices = snapshot.devices.filter((device) => device.config !== null);

  const [backupOpen, setBackupOpen] = useState(false);
  const [backupApp, setBackupApp] = useState(true);
  const [backupDevices, setBackupDevices] = useState(true);

  const [plan, setPlan] = useState<ClientSettingsImportPlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  // This app's part is restored (all or nothing) once; Apply again only retries the devices.
  const [appRestored, setAppRestored] = useState(false);
  const [restoreApp, setRestoreApp] = useState(true);
  const [restoreDevices, setRestoreDevices] = useState(true);
  const [targetsKind, setTargetsKind] = useState<"every" | "chosen">("every");
  const [chosen, setChosen] = useState<ReadonlySet<EnvironmentId>>(new Set());
  const [outcomes, setOutcomes] = useState<ReadonlyArray<DeviceRestoreOutcome> | null>(null);

  const currentState = (): ClientSettingsFileState => ({
    client: getClientSettingsSnapshot(),
    appearance: getAppearancePreferences(),
    colorMode: theme,
    activeThemeId,
    customThemes: getCustomThemes(),
  });

  const exportFile = () => {
    const deviceSettings =
      backupDevices && knownDevices.length > 0
        ? buildDeviceSettingsSection({
            devices: snapshot.devices,
            cache: snapshot.cache,
            preferred,
          })
        : undefined;
    const file = buildClientSettingsFile(
      backupApp ? currentState() : null,
      new Date(),
      deviceSettings,
    );
    downloadJsonFile(
      deviceSettings === undefined ? "ryco-client-settings.json" : "ryco-settings.json",
      `${JSON.stringify(file, null, 2)}\n`,
    );
    setBackupOpen(false);
  };

  const closeRestore = () => {
    setPlan(null);
    setOutcomes(null);
    setError(null);
    setAppRestored(false);
  };

  const readFile = (file: File) => {
    setError(null);
    setOutcomes(null);
    setAppRestored(false);
    void readClientSettingsImportFile(file, currentState(), {
      newThemeId: (imported) => generateCustomThemeId(imported.id),
      themeExists: (id) => getAllThemes().some((entry) => entry.id === id),
    })
      .then((next) => {
        setRestoreApp(next.hasAppSettings);
        setRestoreDevices(next.deviceSettings !== null);
        setTargetsKind("every");
        setChosen(
          new Set(
            snapshot.devices.filter(deviceTakesOwnValueNow).map((device) => device.environmentId),
          ),
        );
        setPlan(next);
      })
      .catch((cause: unknown) => setError(errorMessage(cause, "Could not read the file.")));
  };

  const deviceValues = plan?.deviceSettings?.values ?? null;
  // Picked devices count while they can be written: one that went offline or lost write access
  // since the file was read drops out of the plan (and comes back checked when it returns).
  const pickable = snapshot.devices.filter(deviceTakesOwnValueNow);
  const restoreTargets = (devices: SharedSettingsSnapshot["devices"]): DeviceRestoreTargets =>
    targetsKind === "every"
      ? { kind: "every" }
      : { kind: "chosen", environmentIds: pickableRestoreDevices(devices, chosen) };
  const targets = restoreTargets(snapshot.devices);
  const previews =
    deviceValues === null
      ? []
      : previewDeviceSettingsRestore({ values: deviceValues, devices: snapshot.devices, targets });
  const appWork = plan !== null && restoreApp && plan.changes.length > 0 && !appRestored;
  // Only targets that can be written now, or that take the shared values by themselves later.
  const deviceWork = restoreDevices && deviceSettingsRestoreHasWork(previews);

  const apply = async () => {
    if (!plan) return;
    setApplying(true);
    setError(null);
    if (appWork) {
      try {
        await applyClientSettingsImport(plan, currentState(), {
          addTheme: addCustomTheme,
          removeTheme: deleteCustomTheme,
          setAppearance: (key, value) => {
            setAppearancePreference(key, value);
            applyAppearancePreferencesToDocument();
          },
          setColorMode: setTheme,
          setActiveTheme,
          saveClientSettings: persistClientSettingsUpdate,
        });
        setAppRestored(true);
      } catch (cause) {
        setError(`Nothing was restored: ${errorMessage(cause, "saving failed.")}`);
        setApplying(false);
        return;
      }
    }
    if (!deviceWork || deviceValues === null) {
      setApplying(false);
      closeRestore();
      return;
    }
    const now = latestSnapshot.current;
    const commands = buildDeviceSettingsRestoreCommands({
      values: deviceValues,
      devices: now.devices,
      targets: restoreTargets(now.devices),
      nextStamp: () => source.nextStamp(now.devices),
    });
    if (commands === null) {
      setError(
        appWork
          ? "This app's settings were restored. Device settings can't be written yet: sign in first."
          : "Device settings can't be written yet: sign in first.",
      );
      setApplying(false);
      return;
    }
    const extra = extraDevices(now, source);
    const runs = [];
    for (const command of commands) {
      try {
        runs.push({ command, result: await source.run(command, extra) });
      } catch (cause) {
        const detail = errorMessage(cause, "The write failed.");
        runs.push({
          command,
          result: {
            applied: [],
            notApplied: command.writes.map((write) => ({
              environmentId: write.environmentId,
              label:
                now.devices.find((device) => device.environmentId === write.environmentId)?.label ??
                write.environmentId,
              reason: "failed" as const,
              detail,
            })),
          },
        });
      }
    }
    setOutcomes(summarizeDeviceSettingsRestore(now.devices, runs));
    setApplying(false);
  };

  return (
    <>
      <SettingsRow
        title="Back up settings"
        description="Save this app's settings and the settings your devices share to one file."
        control={
          <Button size="sm" variant="outline" onClick={() => setBackupOpen(true)}>
            Export
          </Button>
        }
      />
      <SettingsRow
        title="Restore settings"
        description="Pick what to restore, and to which devices."
        status={
          error && !plan ? (
            <span role="alert" className="text-destructive">
              {error}
            </span>
          ) : null
        }
        control={
          <>
            <Button size="sm" variant="outline" onClick={() => inputRef.current?.click()}>
              Import…
            </Button>
            <input
              ref={inputRef}
              type="file"
              accept=".json,application/json"
              className="hidden"
              aria-label="Settings file to restore"
              onChange={(event) => {
                const file = event.currentTarget.files?.[0];
                event.currentTarget.value = "";
                if (file) readFile(file);
              }}
            />
          </>
        }
      />

      <Dialog open={backupOpen} onOpenChange={setBackupOpen}>
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>Back up settings</DialogTitle>
            <DialogDescription>
              The file never holds a device, an account, a connection or a credential.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="grid gap-3">
            <Choice
              label="This app's settings"
              description="Appearance, themes, chat, shortcuts and other preferences of this app."
              checked={backupApp}
              onChange={setBackupApp}
            />
            <Choice
              label="Shared device settings"
              description="Worktree and Git defaults, retention, prices and the other settings devices share. Paths and providers stay out."
              checked={backupDevices && knownDevices.length > 0}
              disabled={knownDevices.length === 0}
              onChange={setBackupDevices}
            />
          </DialogPanel>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setBackupOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={!backupApp && !(backupDevices && knownDevices.length > 0)}
              onClick={exportFile}
            >
              Export
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>

      <Dialog open={plan !== null} onOpenChange={(open) => !open && closeRestore()}>
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>Restore settings</DialogTitle>
            <DialogDescription>
              {outcomes !== null
                ? "Restored. Here is how each device took it."
                : "Nothing changes until you apply. Nodes, accounts and connections stay as they are."}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="grid gap-5">
            {outcomes !== null ? (
              <ul aria-label="Device results" className="space-y-1 text-xs">
                {outcomes.length === 0 ? <li>No device was changed.</li> : null}
                {outcomes.map((outcome) => (
                  <li key={outcome.environmentId}>{outcomeLine(outcome)}</li>
                ))}
              </ul>
            ) : (
              <>
                {plan?.hasAppSettings && appRestored ? (
                  <p className="text-xs text-muted-foreground">This app's settings are restored.</p>
                ) : null}
                {plan?.hasAppSettings && !appRestored ? (
                  <section className="grid gap-2">
                    <Choice
                      label="This app's settings"
                      description="Restored all at once: if one can't be saved, none change."
                      checked={restoreApp}
                      onChange={setRestoreApp}
                    />
                    {restoreApp ? (
                      plan.changes.length === 0 ? (
                        <p className="text-xs text-muted-foreground">
                          They match yours; nothing would change.
                        </p>
                      ) : (
                        <ul aria-label="Changes" className="space-y-0.5 font-mono text-xs">
                          {plan.changes.map((change) => (
                            <li key={change}>{change}</li>
                          ))}
                        </ul>
                      )
                    ) : null}
                  </section>
                ) : null}
                {plan?.deviceSettings ? (
                  <section className="grid gap-3">
                    <Choice
                      label="Device settings"
                      description="The settings your devices share."
                      checked={restoreDevices}
                      onChange={setRestoreDevices}
                    />
                    {restoreDevices ? (
                      <>
                        <RadioGroup
                          aria-label="Restore to"
                          value={targetsKind}
                          onValueChange={(value) =>
                            setTargetsKind(value === "chosen" ? "chosen" : "every")
                          }
                          className="gap-2 ps-7"
                        >
                          <label className="flex cursor-pointer items-start gap-2.5 text-[13px] text-foreground">
                            <Radio value="every" className="mt-0.5" />
                            <span>
                              Every device
                              <span className="block text-xs text-muted-foreground">
                                Shared on all of them. Offline devices take it when they are back.
                              </span>
                            </span>
                          </label>
                          <label className="flex cursor-pointer items-start gap-2.5 text-[13px] text-foreground">
                            <Radio value="chosen" className="mt-0.5" />
                            <span>
                              Only these devices
                              <span className="block text-xs text-muted-foreground">
                                As if you changed each one on its own: it keeps the value as its
                                own. Only online devices you can change.
                              </span>
                            </span>
                          </label>
                        </RadioGroup>
                        {targetsKind === "chosen" ? (
                          <div className="grid gap-2 ps-14" role="group" aria-label="Devices">
                            {pickable.map((device) => (
                              <label
                                key={device.environmentId}
                                className="flex cursor-pointer items-center gap-2.5 text-[13px] text-foreground"
                              >
                                <Checkbox
                                  checked={
                                    targets.kind === "chosen" &&
                                    targets.environmentIds.has(device.environmentId)
                                  }
                                  onCheckedChange={(checked) =>
                                    setChosen((current) => {
                                      const next = new Set(current);
                                      if (checked === true) next.add(device.environmentId);
                                      else next.delete(device.environmentId);
                                      return next;
                                    })
                                  }
                                />
                                {device.label}
                              </label>
                            ))}
                          </div>
                        ) : null}
                        <ul aria-label="Device changes" className="grid gap-3 ps-7">
                          {previews.map((preview) => (
                            <DevicePreview key={preview.environmentId} preview={preview} />
                          ))}
                        </ul>
                      </>
                    ) : null}
                  </section>
                ) : null}
                {plan &&
                (plan.warnings.length > 0 || (plan.deviceSettings?.warnings.length ?? 0) > 0) ? (
                  <ul
                    aria-label="Left as they are"
                    className="space-y-1 text-xs text-muted-foreground"
                  >
                    {[...plan.warnings, ...(plan.deviceSettings?.warnings ?? [])].map((warning) => (
                      <li key={warning}>{warning}</li>
                    ))}
                  </ul>
                ) : null}
              </>
            )}
            {error ? (
              <p role="alert" className="text-xs text-destructive">
                {error}
              </p>
            ) : null}
          </DialogPanel>
          <DialogFooter>
            {outcomes !== null ? (
              <Button onClick={closeRestore}>Done</Button>
            ) : (
              <>
                <Button variant="ghost" onClick={closeRestore}>
                  Cancel
                </Button>
                <Button
                  disabled={applying || (!appWork && !deviceWork)}
                  onClick={() => void apply()}
                >
                  Apply
                </Button>
              </>
            )}
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </>
  );
}
