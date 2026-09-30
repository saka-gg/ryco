import { useEffect, useState } from "react";
import { Pressable, View } from "react-native";
import { AppText as Text } from "../../components/AppText";
import {
  deriveBatchResultEvidence,
  readBatchResultEvidence,
  captureBatchLaunchReadiness,
  type BatchLaunch,
} from "@ryco/client-runtime/state/composer";
import { readEnvironmentApi } from "../../connection/environmentApi";
import { createMobileConnectionRegistry } from "../../runtime/bootstrap";
import { batchLaunchStore } from "../../state/batchLaunchStore";
import type { ThreadId } from "@ryco/contracts";
import { useWsConnectionStatusForEnvironment } from "../../rpc/wsConnectionState";

type Evidence = NonNullable<ReturnType<typeof deriveBatchResultEvidence>>;
export function BatchResults(props: {
  batch: BatchLaunch;
  connected: boolean;
  onOpen: (threadId: ThreadId) => void;
  onRetry?: (() => void) | undefined;
  onNew?: (() => void) | undefined;
  error?: string | null | undefined;
}) {
  const [evidenceState, setEvidenceState] = useState<{
    stamp: string;
    items: Record<string, Evidence>;
  }>({ stamp: "", items: {} });
  const [refresh, setRefresh] = useState(0);
  const connection = useWsConnectionStatusForEnvironment(props.batch.environmentId);
  const stamp = `${props.batch.id}:${props.connected}:${connection.phase}:${connection.attemptCount}:${connection.connectedAt}:${refresh}`;
  const evidence = evidenceState.stamp === stamp ? evidenceState.items : {};
  useEffect(() => {
    if (!props.connected || connection.phase !== "connected") return;
    const api = readEnvironmentApi(props.batch.environmentId);
    if (!api?.orchestration.getThreadWindow) return;
    let current = true;
    const guard = captureBatchLaunchReadiness(props.batch.environmentId, () =>
      createMobileConnectionRegistry().driver.supervisor.read(props.batch.environmentId),
    );
    void Promise.all(
      props.batch.destinations
        .filter((target) => target.status === "launched" || target.status === "uncertain")
        .map(async (target) => {
          try {
            const item = await readBatchResultEvidence({
              api,
              batch: props.batch,
              destination: target,
              assertMutationReady: guard,
            });
            if (!current || !item) return;
            setEvidenceState((previous) => ({
              stamp,
              items: {
                ...(previous.stamp === stamp ? previous.items : {}),
                [target.threadId]: item,
              },
            }));
            if (target.status === "uncertain" && item.accepted && item.worktreePath)
              await batchLaunchStore.reconcile(props.batch.id, [item]);
          } catch {
            /* Unknown is not safe failure. */
          }
        }),
    );
    return () => {
      current = false;
    };
  }, [props.batch, props.connected, connection.phase, stamp]);
  return (
    <View accessibilityLabel="Batch results" className="gap-3 rounded-2xl border border-border p-3">
      {props.error && (
        <Text accessibilityRole="alert" className="text-warning">
          {props.error}
        </Text>
      )}
      <Text className="font-ryco-medium">
        Model comparison ·{" "}
        {props.batch.destinations.filter((target) => target.status === "launched").length}/
        {props.batch.destinations.length} launched
      </Text>
      {props.batch.destinations.map((target) => {
        const item = evidence[target.threadId];
        return (
          <View key={target.threadId} className="gap-1 border-t border-border pt-2">
            <Text>{target.label}</Text>
            <Text className="text-xs text-foreground-muted">
              {target.modelSelection.options
                ?.map((option) => `${option.id}: ${option.value}`)
                .join(" · ")}
            </Text>
            <Text>
              {target.status}
              {item ? ` / ${item.status}` : ""}
            </Text>
            {target.error && <Text className="text-xs text-warning">{target.error}</Text>}
            <Text className="text-xs text-foreground-muted">
              {item?.files == null
                ? "Diff unavailable"
                : `${item.files} files · +${item.additions} −${item.deletions}`}{" "}
              ·{" "}
              {item?.tokens == null
                ? "Usage unavailable"
                : `${item.tokens.toLocaleString()} reported tokens`}
            </Text>
            {["launched", "uncertain", "dispatching"].includes(target.status) && (
              <Pressable
                accessibilityRole="button"
                onPress={() => props.onOpen(target.threadId)}
                className="min-h-11 justify-center"
              >
                <Text className="text-accent">Open thread and review</Text>
              </Pressable>
            )}
          </View>
        );
      })}
      <Text className="text-xs text-foreground-muted">
        Uncertain launches are never resent. Your draft is retained. Inspect changes and candidate
        test evidence before choosing a result.
      </Text>
      {props.batch.destinations.some((target) =>
        ["queued", "preparing", "dispatching", "failed"].includes(target.status),
      ) && (
        <Pressable
          accessibilityRole="button"
          onPress={() => void batchLaunchStore.cancel(props.batch.id).catch(() => {})}
          className="min-h-11 justify-center"
        >
          <Text>Stop remaining launches</Text>
        </Pressable>
      )}
      {props.onRetry && props.batch.destinations.some((target) => target.status === "failed") && (
        <Pressable
          accessibilityRole="button"
          disabled={!props.connected}
          onPress={props.onRetry}
          className="min-h-11 justify-center"
        >
          <Text>Retry safe failures</Text>
        </Pressable>
      )}
      <Pressable
        accessibilityRole="button"
        disabled={!props.connected}
        onPress={() => setRefresh((value) => value + 1)}
        className="min-h-11 justify-center"
      >
        <Text>Refresh evidence</Text>
      </Pressable>
      {props.onNew &&
        props.batch.destinations.every(
          (target) => target.status === "launched" || target.status === "cancelled",
        ) && (
          <Pressable
            accessibilityRole="button"
            onPress={props.onNew}
            className="min-h-11 justify-center"
          >
            <Text>Start another comparison</Text>
          </Pressable>
        )}
    </View>
  );
}
