import type {
  DesktopAppSnapKeyChord,
  DesktopAppSnapShortcut,
  DesktopWindowCaptureState,
  ResolvedKeybindingsConfig,
} from "@ryco/contracts";
import {
  appSnapKeyChordFromKeyEvent,
  appSnapKeyChordText,
  appSnapShortcutAppConflict,
  appSnapShortcutLabels,
} from "@ryco/shared/appSnapShortcut";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@ryco/shared/keybindings";
import { useEffect, useState } from "react";

import { useAppKeybindingsState } from "~/appKeybindings";
import { getCommandMeta } from "~/lib/keybindingCategories";
import { windowCaptureErrorMessage } from "~/windowCapture";
import { Button } from "../ui/button";
import { PermissionStatusBadge } from "./PermissionStatusBadge";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { SettingsSelect } from "./SettingsSelect";

type ShortcutMode = "off" | "both-option-keys" | "custom";

function shortcutMode(shortcut: DesktopAppSnapShortcut | null | undefined): ShortcutMode {
  if (!shortcut) return "off";
  return shortcut.kind === "both-option-keys" ? "both-option-keys" : "custom";
}

function ShortcutKeys({ shortcut }: { shortcut: DesktopAppSnapShortcut }) {
  return (
    <span className="inline-flex items-center gap-1">
      {appSnapShortcutLabels(shortcut).map((label) => (
        <kbd
          key={label}
          className="rounded-[min(var(--radius-md),0.4rem)] border border-border bg-muted/60 px-1.5 font-mono text-[11px] text-foreground"
        >
          {label}
        </kbd>
      ))}
    </span>
  );
}

/**
 * The Ryco command a chord would take from, e.g. “Open command palette” for
 * ⌘ K: the global reservation also swallows the chord inside Ryco.
 */
function appBindingConflict(
  chord: DesktopAppSnapKeyChord,
  bindings: ResolvedKeybindingsConfig,
): string | null {
  const command = appSnapShortcutAppConflict(chord, bindings);
  if (!command) return null;
  return command.startsWith("projectScript.")
    ? "a project script"
    : `“${getCommandMeta(command).title}”`;
}

/** Records the next modifier + key chord; Escape or Tab cancels. */
function ShortcutRecorder(props: {
  onRecord: (chord: DesktopAppSnapKeyChord) => void;
  onCancel: () => void;
}) {
  const { onRecord, onCancel } = props;
  const [hint, setHint] = useState<string | null>(null);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      const bare = !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey;
      if (bare && (event.key === "Escape" || event.key === "Tab")) {
        onCancel();
        return;
      }
      const result = appSnapKeyChordFromKeyEvent(event);
      if (!result) return;
      if ("error" in result) setHint(result.error);
      else onRecord(result.chord);
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [onCancel, onRecord]);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span
        role="status"
        className="inline-flex h-6 items-center rounded-[min(var(--radius-md),0.4rem)] border border-primary/60 bg-primary/10 px-2 font-mono text-[11px] text-foreground"
      >
        Press shortcut…
      </span>
      <Button type="button" size="xs" variant="ghost" onClick={onCancel}>
        Cancel
      </Button>
      {hint ? <span className="text-xs text-muted-foreground">{hint}</span> : null}
    </div>
  );
}

/**
 * Window capture into the composer (macOS desktop): the optional global
 * shortcut and the grants it needs. The composer's attachment menu works
 * without the shortcut and asks for Screen Recording on first use.
 */
export function WindowCaptureSettings({ scope }: { scope?: string }) {
  const api = window.desktopBridge?.windowCapture;
  const [state, setState] = useState<DesktopWindowCaptureState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  // Before hydration the defaults stand in, so a chord never skips the check.
  const keybindings = useAppKeybindingsState();
  const appBindings = keybindings.hydrated ? keybindings.bindings : DEFAULT_RESOLVED_KEYBINDINGS;

  useEffect(() => {
    if (!api) return;
    let live = true;
    const refresh = () => {
      void api
        .getState()
        .then((next) => {
          if (live) setState(next);
        })
        .catch(() => {
          if (live) setError("Could not check window capture.");
        });
    };
    refresh();
    const unsubscribe = api.onState((next) => {
      if (live) setState(next);
    });
    // Grants change in System Settings; check again when the user comes back.
    window.addEventListener("focus", refresh);
    return () => {
      live = false;
      unsubscribe();
      window.removeEventListener("focus", refresh);
    };
  }, [api]);

  if (!api || state?.supported === false) return null;

  const run = async (operation: () => Promise<DesktopWindowCaptureState>) => {
    setBusy(true);
    setError(null);
    try {
      setState(await operation());
    } catch (cause) {
      setError(windowCaptureErrorMessage(cause));
    } finally {
      setBusy(false);
    }
  };
  const saveShortcut = (shortcut: DesktopAppSnapShortcut | null) =>
    run(async () => {
      const result = await api.setShortcut(shortcut);
      if (!result.availability.available) {
        throw new Error(result.availability.reason ?? "This shortcut is not available.");
      }
      return result.state;
    });

  const mode = recording ? "custom" : shortcutMode(state?.shortcut);
  const appName = state?.appDisplayName || "Ryco";
  const permissions = [
    ["Screen Recording", state?.screenRecordingPermission] as const,
    ...(state?.shortcut?.kind === "both-option-keys"
      ? [["Input Monitoring", state.inputMonitoringPermission] as const]
      : []),
  ];
  // The desktop app arms the shortcut only once its grants are held; its
  // message says what else keeps it off (another app holds the chord, a
  // listener failure).
  const waitingForGrants = Boolean(state?.shortcut && state.missingPermissions.length > 0);
  const message = error ?? state?.message ?? null;
  const shortcutArmed = Boolean(state?.shortcut) && !waitingForGrants && !state?.message;
  // Keybindings can change after the shortcut was saved; a chord Ryco now
  // binds itself stays saved, so say what it takes over, or would once armed.
  // Shown below the message above, never in its place.
  const savedChord = state?.shortcut?.kind === "key-chord" ? state.shortcut : null;
  const savedConflict =
    savedChord && keybindings.hydrated
      ? appBindingConflict(savedChord, keybindings.bindings)
      : null;
  const conflictWarning =
    savedChord && savedConflict
      ? `${appSnapKeyChordText(savedChord)} also runs ${savedConflict} in Ryco, ${
          shortcutArmed
            ? "and the capture shortcut takes it over"
            : "which the capture shortcut would take over once it works"
        }. Choose another shortcut.`
      : null;
  const alerts = [message, conflictWarning].filter((line): line is string => line !== null);
  const grantsHint =
    waitingForGrants && !message
      ? "The shortcut starts working once the permissions below are allowed."
      : null;

  return (
    <SettingsSection title="Window capture" owner="client">
      <SettingsRow
        title="Capture shortcut"
        owner="client"
        {...(scope ? { scope } : {})}
        description="Press it in any app to attach the frontmost window to the chat you have open. The attachment menu can capture any window without it."
        status={
          alerts.length > 0 || grantsHint ? (
            <>
              {alerts.length > 0 ? (
                <span role="alert" className="flex flex-col gap-1">
                  {alerts.map((line) => (
                    <span key={line}>{line}</span>
                  ))}
                </span>
              ) : null}
              {grantsHint ? <span className="mt-1 block first:mt-0">{grantsHint}</span> : null}
            </>
          ) : undefined
        }
        control={
          <SettingsSelect<ShortcutMode>
            ariaLabel="Capture shortcut"
            width="md"
            value={state ? mode : null}
            disabled={!state || busy}
            onValueChange={(next) => {
              if (next === "custom") {
                setError(null);
                setRecording(true);
                return;
              }
              setRecording(false);
              void saveShortcut(next === "off" ? null : { kind: "both-option-keys" });
            }}
            options={[
              { value: "off", label: "Off" },
              { value: "both-option-keys", label: "Both ⌥ Option keys" },
              { value: "custom", label: "Custom shortcut" },
            ]}
          />
        }
      >
        {recording ? (
          <ShortcutRecorder
            onCancel={() => setRecording(false)}
            onRecord={(chord) => {
              setRecording(false);
              const conflict = appBindingConflict(chord, appBindings);
              if (conflict) {
                setError(
                  `${appSnapKeyChordText(chord)} already runs ${conflict} in Ryco. Choose another shortcut.`,
                );
                return;
              }
              void saveShortcut(chord);
            }}
          />
        ) : state?.shortcut ? (
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <ShortcutKeys shortcut={state.shortcut} />
            {state.shortcut.kind === "key-chord" ? (
              <Button
                type="button"
                size="xs"
                variant="ghost"
                disabled={busy}
                onClick={() => {
                  setError(null);
                  setRecording(true);
                }}
              >
                Change
              </Button>
            ) : null}
          </div>
        ) : null}
      </SettingsRow>
      <SettingsRow
        title="Mac permissions"
        owner="client"
        description={`Screen Recording lets ${appName} capture windows. The Option-key shortcut also needs Input Monitoring. Nothing is asked until you set it up.`}
        control={
          <Button
            type="button"
            size="xs"
            variant="outline"
            disabled={busy || !state || state.missingPermissions.length === 0}
            onClick={() => void run(() => api.setup())}
          >
            Set up
          </Button>
        }
      >
        <ul className="grid gap-2 sm:grid-cols-2">
          {permissions.map(([label, status]) => (
            <li
              key={label}
              className="flex items-center justify-between gap-2 rounded-[min(var(--radius-md),0.5rem)] bg-muted/50 px-2.5 py-2 text-xs"
            >
              <span className="truncate text-foreground">{label}</span>
              <PermissionStatusBadge status={status} checked={status !== undefined} />
            </li>
          ))}
        </ul>
      </SettingsRow>
    </SettingsSection>
  );
}
