import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, View } from "react-native";
import { AppText as Text } from "../../components/AppText";
import { showConfirmDialog } from "../../components/ConfirmDialogHost";
import {
  clearDeviceCache,
  readDeviceCacheUsage,
  type DeviceCacheUsage,
} from "../../persistence/deviceCache";
import { formatCacheBytes } from "../../persistence/cacheSize";
import { useHomeEnvironments } from "../home/useHomeEnvironments";
import { SettingsRow } from "./components/SettingsRow";
import { SettingsSection } from "./components/SettingsSection";

export function DeviceCacheStorage() {
  const environments = useHomeEnvironments();
  const deviceKey = JSON.stringify(
    environments.map(({ environmentId, label }) => ({ environmentId, label })),
  );
  const [rows, setRows] = useState<readonly DeviceCacheUsage[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [cleared, setCleared] = useState<{ environmentId: string; label: string } | null>(null);
  const generation = useRef(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const refresh = useCallback(async () => {
    const request = ++generation.current;
    try {
      const next = await readDeviceCacheUsage(JSON.parse(deviceKey));
      if (mounted.current && request === generation.current) {
        setRows(next);
        setError(null);
      }
    } catch (cause) {
      if (mounted.current && request === generation.current)
        setError(cause instanceof Error ? cause.message : "Could not read cache storage.");
    }
  }, [deviceKey]);
  useEffect(() => {
    const request = ++generation.current;
    let cancelled = false;
    void readDeviceCacheUsage(JSON.parse(deviceKey)).then(
      (next) => {
        if (!cancelled && request === generation.current) {
          setRows(next);
          setError(null);
        }
      },
      (cause) => {
        if (!cancelled && request === generation.current)
          setError(cause instanceof Error ? cause.message : "Could not read cache storage.");
      },
    );
    return () => {
      cancelled = true;
    };
  }, [deviceKey]);
  const clear = (row: DeviceCacheUsage) =>
    showConfirmDialog({
      title: `Clear cache for ${row.label}?`,
      message:
        "Removes this device’s downloaded task summaries, project images, file previews, and diffs from this phone. Originals, drafts, and queued messages stay intact. Connected devices can download fresh data as you use the app.",
      confirmText: "Clear cache",
      destructive: true,
      onConfirm: () => {
        if (busy !== null) return;
        setBusy(row.environmentId);
        setCleared(null);
        void clearDeviceCache(row.environmentId)
          .then(async () => {
            if (!mounted.current) return;
            setCleared({ environmentId: row.environmentId, label: row.label });
            await refresh();
          })
          .catch((cause) => {
            if (mounted.current)
              setError(
                cause instanceof Error
                  ? cause.message
                  : "Could not clear this cache. Please try again.",
              );
          })
          .finally(() => {
            if (mounted.current) setBusy(null);
          });
      },
    });
  return (
    <View>
      <SettingsSection title="Cache storage">
        <SettingsRow
          first
          label="Cached on this phone"
          value={
            rows ? formatCacheBytes(rows.reduce((sum, row) => sum + row.totalBytes, 0)) : "Loading…"
          }
          detail="Stored task metadata plus estimated memory used by image and file previews. Active views and SQLite overhead are not included."
        />
        <SettingsRow
          label="Refresh storage usage"
          onPress={() => {
            void refresh();
          }}
          disabled={busy !== null}
        />
      </SettingsSection>
      {error ? (
        <Text accessibilityRole="alert" className="mx-5 mt-3 text-sm text-danger-foreground">
          {error}
        </Text>
      ) : null}
      {cleared ? (
        <Text accessibilityLiveRegion="polite" className="mx-5 mt-3 text-sm text-foreground-muted">
          Cache cleared for {cleared.label}.
        </Text>
      ) : null}
      {!rows && !error ? <ActivityIndicator className="mt-4" /> : null}
      {rows
        ?.filter((row) => row.totalBytes > 0 || row.environmentId === cleared?.environmentId)
        .map((row) => (
          <SettingsSection key={row.environmentId} title={row.label}>
            <SettingsRow
              first
              label="Tasks & projects"
              value={formatCacheBytes(row.snapshotBytes)}
              detail={`${row.threads} task summaries · ${row.projects} projects · on disk`}
            />
            <SettingsRow
              label="Images"
              value={formatCacheBytes(row.imageBytes)}
              detail="Project artwork and image previews · memory"
            />
            <SettingsRow
              label="Files & diffs"
              value={formatCacheBytes(row.fileBytes)}
              detail="File contents, directory listings, and code diffs · memory"
            />
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Clear cache for ${row.label}`}
              disabled={busy !== null || row.totalBytes === 0}
              onPress={() => clear(row)}
              className="flex-row items-center justify-between border-t border-border-subtle px-5 py-3.5 active:bg-subtle"
            >
              <Text
                className={`text-base text-danger-foreground ${busy !== null || !row.totalBytes ? "opacity-40" : ""}`}
              >
                {busy === row.environmentId ? "Clearing…" : "Clear cache"}
              </Text>
              <Text className="text-sm text-foreground-muted">
                {formatCacheBytes(row.totalBytes)}
              </Text>
            </Pressable>
          </SettingsSection>
        ))}
      {rows?.every((row) => row.totalBytes === 0) ? (
        <Text className="mx-5 mt-5 text-sm text-foreground-muted">No cached device data.</Text>
      ) : null}
      <Text className="mx-5 mb-8 mt-5 text-xs leading-5 text-foreground-muted">
        Image and file previews are kept in memory only. Live tasks remain available while
        connected. Cache data may build up again when a device sends updates or you reopen content.
      </Text>
    </View>
  );
}
