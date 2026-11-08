import { wantedThreadAlertKinds } from "@ryco/client-runtime/state/settings";
import type { PushAlertKind } from "@ryco/contracts/push";

import { updatePreferences, usePreferences } from "../../state/preferencesStore";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";

/** The kinds in the order they ask for attention, with what each one means. */
export const ALERT_KIND_ROWS: ReadonlyArray<{
  readonly kind: PushAlertKind;
  readonly label: string;
  readonly detail: string;
}> = [
  { kind: "approval", label: "Approvals", detail: "A command or file change waits for you." },
  { kind: "input", label: "Questions", detail: "The agent asks you something." },
  { kind: "plan-ready", label: "Plans", detail: "A plan is ready to review." },
  { kind: "completed", label: "Finished", detail: "A turn finished." },
  { kind: "failed", label: "Failed", detail: "A turn failed." },
  { kind: "stopped", label: "Stopped", detail: "A turn stopped while Ryco was in the background." },
];

/**
 * Which kinds alert, here and while Ryco is closed: the node sends only the kinds this device
 * registered (`effectivePushKinds`), and the app's own alerts leave out the same ones.
 */
export function AlertKindSettings() {
  const preferences = usePreferences();
  const wanted = new Set(wantedThreadAlertKinds(preferences.mutedAlertKinds));
  const setKind = (kind: PushAlertKind, on: boolean) => {
    const muted = new Set(preferences.mutedAlertKinds ?? []);
    if (on) muted.delete(kind);
    else muted.add(kind);
    updatePreferences({ mutedAlertKinds: [...muted] });
  };
  return (
    <SettingsSection title="Alert me about">
      {ALERT_KIND_ROWS.map((row, index) => (
        <SettingsSwitchRow
          key={row.kind}
          first={index === 0}
          label={row.label}
          detail={row.detail}
          value={wanted.has(row.kind)}
          onValueChange={(on) => setKind(row.kind, on)}
        />
      ))}
    </SettingsSection>
  );
}
