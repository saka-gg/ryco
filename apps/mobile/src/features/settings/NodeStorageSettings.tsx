import { useLayoutEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Alert, Pressable, ScrollView, View } from "react-native";
import type { EnvironmentId, StorageRetentionPolicy } from "@ryco/contracts";
import { createStorageManagementController } from "@ryco/client-runtime/state/storage";
import { formatStorageSize, resolveStorageRetentionPolicy } from "@ryco/shared/storageRetention";
import { AppText as Text } from "../../components/AppText";
import { useHomeEnvironments } from "../home/useHomeEnvironments";
import { readRpcClient, updateEnvironmentServerSettings } from "../../connection/environmentApi";
import { useEnvironmentServerConfigs } from "../../state/environmentServerConfigs";
import { SettingsRow } from "./components/SettingsRow";
import { SettingsSection } from "./components/SettingsSection";

export function NodeStorageSettings() {
  const nodes = useHomeEnvironments();
  return (
    <>
      {nodes.map((node) => (
        <NodeStoragePanel
          key={node.environmentId}
          environmentId={node.environmentId}
          label={node.label}
          ready={
            node.mutationReady === true &&
            node.role === "owner" &&
            node.connectionState === "connected"
          }
        />
      ))}
    </>
  );
}

function NodeStoragePanel({
  environmentId,
  label,
  ready,
}: {
  environmentId: EnvironmentId;
  label: string;
  ready: boolean;
}) {
  const configs = useEnvironmentServerConfigs();
  const settings = configs.get(environmentId)?.settings;
  const enabled =
    ready && configs.get(environmentId)?.environment.capabilities.storageManagement === true;
  const controller = useMemo(
    () =>
      createStorageManagementController({
        readClient: () => readRpcClient(environmentId),
      }),
    [environmentId],
  );
  useLayoutEffect(() => {
    controller.setReady(enabled);
  }, [controller, enabled]);
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const policy = settings
    ? resolveStorageRetentionPolicy(settings, projectId)
    : { automatic: false, completedWorktreeDays: null, temporaryDataDays: null };
  const busy = !enabled || saving || state.busy;
  async function save(next: StorageRetentionPolicy | null) {
    if (busy || (!projectId && !next)) return;
    setSaving(true);
    setError(null);
    controller.invalidatePreview();
    setSelected([]);
    try {
      await updateEnvironmentServerSettings(
        environmentId,
        projectId
          ? { projectStorageRetention: { [projectId]: next } }
          : { storageRetention: next! },
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save retention policy.");
    } finally {
      setSaving(false);
    }
  }
  function changeAutomatic() {
    if (policy.automatic) {
      void save({ ...policy, automatic: false });
      return;
    }
    Alert.alert(
      "Enable automatic cleanup?",
      "This node will remove qualifying archived, stopped, clean, unshared Ryco-owned checkouts after the retention period. Messages, branches and usage history remain. Dirty/untracked/ignored work, submodules, archives and credentials stay protected.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Enable cleanup",
          style: "destructive",
          onPress: () => {
            void save({
              ...policy,
              automatic: true,
              completedWorktreeDays: policy.completedWorktreeDays ?? 30,
            });
          },
        },
      ],
    );
  }
  const choices = [null, 7, 30, 90, 365];
  return (
    <SettingsSection title={`Node storage · ${label}`}>
      <SettingsRow
        first
        label={state.busy ? "Working…" : "Scan storage"}
        disabled={busy}
        detail={
          ready
            ? "Bounded on-demand scan of this node. No startup scan."
            : "Connect as the node owner and wait for synchronization."
        }
        onPress={() => {
          setSelected([]);
          void controller.scan();
        }}
      />
      {state.snapshot && (
        <>
          <View className="gap-2 px-5 py-3">
            <Text className="text-xs text-foreground-muted">
              {state.snapshot.truncated
                ? "Scan budget reached. Lower bounds and unavailable sizes are labelled."
                : "Sizes are apparent bytes."}
            </Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false}>
              <View className="flex-row gap-2">
                {[
                  { id: "node", label: "Node default", projectId: null },
                  ...state.snapshot.entries.filter((entry) => entry.category === "repository"),
                ].map((entry) => (
                  <Pressable
                    key={entry.id}
                    accessibilityRole="button"
                    disabled={busy}
                    onPress={() => {
                      setProjectId(entry.projectId);
                      setSelected([]);
                      controller.invalidatePreview();
                    }}
                    className="rounded-full border border-border px-3 py-2"
                  >
                    <Text className="text-sm text-foreground">
                      {entry.projectId === projectId ? "✓ " : ""}
                      {entry.label}
                    </Text>
                  </Pressable>
                ))}
              </View>
            </ScrollView>
            <Text className="text-xs text-foreground-muted">
              {projectId && !settings?.projectStorageRetention[projectId]
                ? "Inherited node policy"
                : projectId
                  ? "Project policy"
                  : "Node default policy"}
            </Text>
          </View>
          <SettingsRow
            label="Automatic cleanup"
            value={policy.automatic ? "On" : "Off"}
            disabled={busy}
            onPress={changeAutomatic}
          />
          {(["completedWorktreeDays", "temporaryDataDays"] as const).map((field) => (
            <SettingsRow
              key={field}
              label={
                field === "completedWorktreeDays" ? "Completed checkouts" : "Completed staging data"
              }
              value={policy[field] === null ? "Keep forever" : `${policy[field]} days`}
              disabled={busy}
              detail="Tap to cycle: forever, 7, 30, 90, 365 days."
              onPress={() => {
                void save({
                  ...policy,
                  [field]: choices[(choices.indexOf(policy[field]) + 1) % choices.length]!,
                });
              }}
            />
          ))}
          {projectId && settings?.projectStorageRetention[projectId] && (
            <SettingsRow
              label="Use node retention policy"
              disabled={busy}
              onPress={() => {
                void save(null);
              }}
            />
          )}
          {state.snapshot.entries
            .filter((entry) => !projectId || entry.projectId === projectId)
            .map((entry) => (
              <SettingsRow
                key={entry.id}
                label={`${selected.includes(entry.id) ? "✓ " : ""}${entry.label}`}
                value={formatStorageSize(entry.bytes, entry.sizeStatus)}
                detail={`${entry.category} · ${entry.reason}${entry.path ? `\n${entry.path}` : ""}`}
                disabled={busy || !entry.eligible}
                onPress={() =>
                  setSelected((current) =>
                    current.includes(entry.id)
                      ? current.filter((id) => id !== entry.id)
                      : [...current, entry.id].slice(0, 20),
                  )
                }
              />
            ))}
          {state.snapshot.nextCursor && (
            <SettingsRow
              label="Next inventory page"
              disabled={busy}
              onPress={() => {
                setSelected([]);
                void controller.scan(undefined, state.snapshot!.nextCursor!);
              }}
            />
          )}
          <SettingsRow
            label={`Preview cleanup (${selected.length})`}
            disabled={busy || !selected.length}
            onPress={() => {
              void controller.preview(selected);
            }}
          />
          <View className="px-5 py-3">
            <Text className="text-xs text-foreground-muted">
              Hourly retention preserves branches and history. Abandoned worktrees have a 24-hour
              grace period. Temporary cleanup covers only completed Ryco staging allocations.
            </Text>
            {state.snapshot.history.slice(0, 6).map((sample) => (
              <Text
                key={`${sample.projectId ?? "node"}:${sample.sampledAt}`}
                className="mt-1 text-xs text-foreground-muted"
              >
                {new Date(sample.sampledAt).toLocaleString()} ·{" "}
                {formatStorageSize(
                  sample.measuredBytes,
                  sample.incompleteEntries ? "bounded" : "complete",
                )}{" "}
                · {sample.incompleteEntries} incomplete entries
              </Text>
            ))}
          </View>
        </>
      )}
      {state.preview && (
        <>
          <View className="gap-2 px-5 py-3">
            <Text className="font-ryco-medium text-base text-foreground">Review cleanup</Text>
            {state.preview.entries.map((entry) => (
              <Text key={entry.id} className="text-sm text-foreground">
                {entry.path} · {formatStorageSize(entry.bytes, entry.sizeStatus)}
              </Text>
            ))}
            <Text className="text-xs text-foreground-muted">
              Expires {new Date(state.preview.expiresAt).toLocaleTimeString()}. The server rechecks
              every path before removal.
            </Text>
          </View>
          <SettingsRow
            destructive
            label="Delete reviewed data"
            disabled={busy}
            onPress={() =>
              Alert.alert(
                "Delete reviewed data?",
                "This removes the listed checkouts/data and cannot be undone. Branches, messages and usage history remain.",
                [
                  { text: "Cancel", style: "cancel" },
                  {
                    text: "Delete",
                    style: "destructive",
                    onPress: () => {
                      void controller.execute(true);
                    },
                  },
                ],
              )
            }
          />
          <SettingsRow
            label="Cancel cleanup"
            disabled={busy}
            onPress={() => {
              controller.invalidatePreview();
              setSelected([]);
            }}
          />
        </>
      )}
      {(state.error || error) && (
        <View className="px-5 py-3">
          <Text accessibilityRole="alert" className="text-sm text-danger-foreground">
            {state.error ?? error}
          </Text>
        </View>
      )}
      {state.result?.results.map((result) => (
        <View key={result.id} className="px-5 py-3">
          <Text className="text-sm text-foreground">
            {result.status}: {result.detail}
          </Text>
        </View>
      ))}
    </SettingsSection>
  );
}
