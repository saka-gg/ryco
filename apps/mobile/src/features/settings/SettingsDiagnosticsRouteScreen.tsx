import Constants from "expo-constants";
import * as Updates from "expo-updates";
import { useCallback, useEffect, useState } from "react";
import { ScrollView } from "react-native";

import { AppText as Text } from "../../components/AppText";
import {
  appCrashRecords,
  type CrashRecord,
  formatCrashReport,
  mergeCrashRecords,
  parseStartupCrashRecords,
} from "../../diagnostics/crashLogModel";
import { parseFatalErrorRecords } from "../../diagnostics/fatalErrorRecorder";
import { fatalErrorFileStore } from "../../diagnostics/fatalErrorStore";
import { copyTextWithHaptic } from "../../lib/copyTextWithHaptic";
import { SettingsRow } from "./components/SettingsRow";
import { SettingsSection } from "./components/SettingsSection";

/** expo-updates keeps its log about a day; asking for a week costs nothing. */
const UPDATES_LOG_MAX_AGE_MS = 7 * 24 * 60 * 60_000;

async function readCrashes(): Promise<ReadonlyArray<CrashRecord>> {
  // Rejects while over-the-air updates are off; the app's own records still count.
  const startup = await Updates.readLogEntriesAsync(UPDATES_LOG_MAX_AGE_MS).then(
    parseStartupCrashRecords,
    () => [],
  );
  let app: ReadonlyArray<CrashRecord> = [];
  try {
    app = appCrashRecords(parseFatalErrorRecords(fatalErrorFileStore().read(), Date.now()));
  } catch {
    app = [];
  }
  return mergeCrashRecords(app, startup);
}

function crashLabel(record: CrashRecord): string {
  const when = new Date(record.timestamp).toLocaleString();
  return `${when} · ${record.source === "startup" ? "at startup" : "while running"}`;
}

/** Settings > About > Diagnostics: recent crashes, kept on this device, copied only on request. */
export function SettingsDiagnosticsRouteScreen() {
  const [records, setRecords] = useState<ReadonlyArray<CrashRecord> | null>(null);
  const reload = useCallback(() => {
    void readCrashes().then(setRecords);
  }, []);
  useEffect(reload, [reload]);

  const report = () =>
    formatCrashReport(records ?? [], {
      version: Constants.expoConfig?.version ?? "unknown",
      build: Constants.expoConfig?.extra?.appVariant ?? "production",
      updateId: Updates.updateId ?? null,
      channel: Updates.channel ?? null,
      runtimeVersion: Updates.runtimeVersion ?? null,
      emergencyLaunchReason: Updates.isEmergencyLaunch ? Updates.emergencyLaunchReason : null,
    });

  const clear = () => {
    try {
      fatalErrorFileStore().clear();
    } catch {
      // Nothing to clear.
    }
    void Updates.clearLogEntriesAsync()
      .catch(() => undefined)
      .then(reload);
  };

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      className="flex-1 bg-screen"
      contentContainerStyle={{ paddingTop: 4, paddingBottom: 40 }}
    >
      {Updates.isEmergencyLaunch ? (
        <SettingsSection title="This launch">
          <SettingsRow
            first
            label="Fell back to the bundled version"
            detail={Updates.emergencyLaunchReason ?? "The downloaded update did not start."}
          />
        </SettingsSection>
      ) : null}

      <SettingsSection title="Recent crashes">
        {records === null ? (
          <SettingsRow first label="Reading…" />
        ) : records.length === 0 ? (
          <SettingsRow first label="No crashes recorded" />
        ) : (
          records.map((record, index) => (
            <SettingsRow
              key={`${record.timestamp}-${index}`}
              first={index === 0}
              label={record.description}
              detail={crashLabel(record)}
            />
          ))
        )}
      </SettingsSection>

      <SettingsSection title="Report">
        <SettingsRow
          first
          label="Copy crash report"
          detail="Version, update and the crashes above, with file paths reduced to names."
          onPress={() => copyTextWithHaptic(report(), { target: "crash report" })}
        />
        <SettingsRow
          label="Clear"
          destructive
          disabled={records === null || records.length === 0}
          onPress={clear}
        />
      </SettingsSection>

      <Text className="mx-5 mt-2 font-sans text-xs leading-4 text-foreground-muted">
        Crashes stay on this device until you copy them. The app keeps its own for seven days;
        startup crashes caught by the update system are kept about a day.
      </Text>
    </ScrollView>
  );
}
