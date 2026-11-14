import type { DiagnosticsSnapshot, EnvironmentId } from "@ryco/contracts";
import { ClipboardCheckIcon, ClipboardCopyIcon } from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import { APP_STAGE_LABEL, APP_VERSION } from "../../branding";
import {
  buildDiagnosticsBundle,
  hasPushSequenceGap,
  serializeDiagnosticsBundle,
} from "./DiagnosticsPanel.logic";
import {
  usePushSequenceMonitor,
  type PushSequenceEnvironmentState,
} from "../../diagnostics/pushSequenceMonitor";
import { resolveAndPersistPreferredEditor } from "../../editorPreferences";
import { isElectron } from "../../env";
import {
  readEnvironmentConnection,
  useSavedEnvironmentRegistryStore,
  useSavedEnvironmentRuntimeStore,
  type SavedEnvironmentRecord,
  type SavedEnvironmentRuntimeState,
} from "../../environments/runtime";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { cn } from "../../lib/utils";
import { useSettingsTarget } from "../../settingsTarget";
import { ensureLocalApi } from "../../localApi";
import {
  useServerAvailableEditors,
  useServerObservability,
  useServerProviders,
} from "../../rpc/serverState";
import { Button } from "../ui/button";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { errorMessage } from "~/lib/errorMessage";

const CONNECTION_STATE_DOT: Record<string, string> = {
  connected: "bg-success",
  connecting: "bg-warning",
  error: "bg-destructive",
  disconnected: "bg-muted-foreground/40",
};

const PROVIDER_STATE_DOT: Record<string, string> = {
  ready: "bg-success",
  warning: "bg-warning",
  error: "bg-destructive",
  disabled: "bg-muted-foreground/40",
};

function StateDot({ className }: { className: string }) {
  return (
    <span className={cn("inline-block size-2 shrink-0 rounded-full", className)} aria-hidden />
  );
}

function pushSequenceSummary(state: PushSequenceEnvironmentState | null): string {
  if (!state) {
    return "No push events observed yet.";
  }
  const parts = [
    `last #${state.highestSequence ?? "—"}`,
    `${state.eventCount} events`,
    `${state.snapshotCount} snapshots`,
  ];
  if (state.gapCount > 0) {
    parts.push(`${state.gapCount} gap${state.gapCount === 1 ? "" : "s"}`);
  } else {
    parts.push("no gaps");
  }
  return parts.join(" · ");
}

interface EnvironmentRowProps {
  readonly environmentId: EnvironmentId;
  readonly record: SavedEnvironmentRecord | null;
  readonly runtime: SavedEnvironmentRuntimeState | null;
  readonly pushSequence: PushSequenceEnvironmentState | null;
}

function EnvironmentRow({ environmentId, record, runtime, pushSequence }: EnvironmentRowProps) {
  const connectionState = runtime?.connectionState ?? "disconnected";
  const label = record?.label ?? environmentId;
  const gap = hasPushSequenceGap(pushSequence);

  return (
    <SettingsRow
      title={
        <span className="inline-flex items-center gap-2">
          <StateDot className={CONNECTION_STATE_DOT[connectionState] ?? "bg-muted-foreground/40"} />
          {label}
        </span>
      }
      description={
        <span className="space-y-0.5">
          <span className="block">
            WS {connectionState}
            {runtime?.authState ? ` · auth ${runtime.authState}` : ""}
            {runtime?.role ? ` · ${runtime.role}` : ""}
          </span>
          <span className={cn("block", gap ? "text-warning" : "text-muted-foreground/70")}>
            {pushSequenceSummary(pushSequence)}
          </span>
          {runtime?.lastError ? (
            <span className="block break-all text-destructive">{runtime.lastError}</span>
          ) : null}
        </span>
      }
    />
  );
}

export function DiagnosticsSupportSections({
  snapshot,
}: {
  readonly snapshot: DiagnosticsSnapshot | null;
}) {
  const registryById = useSavedEnvironmentRegistryStore((state) => state.byId);
  const runtimeById = useSavedEnvironmentRuntimeStore((state) => state.byId);
  const pushById = usePushSequenceMonitor((state) => state.byEnvironment);
  const target = useSettingsTarget();
  const primaryProviders = useServerProviders();
  const primaryObservability = useServerObservability();
  const primaryAvailableEditors = useServerAvailableEditors();
  const providers = useMemo(
    () => (target ? (target.serverConfig?.providers ?? []) : primaryProviders),
    [target, primaryProviders],
  );
  const observability =
    snapshot?.observability ??
    (target ? (target.serverConfig?.observability ?? null) : primaryObservability);
  const availableEditors = useMemo(
    () => (target ? (target.serverConfig?.availableEditors ?? []) : primaryAvailableEditors),
    [target, primaryAvailableEditors],
  );
  const localMetrics = snapshot?.performance?.local ?? null;

  const [isOpeningLogs, setIsOpeningLogs] = useState(false);

  const observabilityForBundle = useMemo(
    () =>
      observability
        ? {
            ...observability,
            ...(localMetrics ? { localMetrics } : {}),
          }
        : null,
    [localMetrics, observability],
  );

  const environmentIds = useMemo(() => {
    const ids = new Set<string>([
      ...Object.keys(registryById),
      ...Object.keys(runtimeById),
      ...Object.keys(pushById),
    ]);
    return [...ids].toSorted() as EnvironmentId[];
  }, [registryById, runtimeById, pushById]);

  const { copyToClipboard, isCopied } = useCopyToClipboard({
    onCopy: () => {
      toastManager.add({
        type: "success",
        title: "Debug bundle copied",
        description: "Secrets are redacted before export.",
      });
    },
    onError: (error) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not copy debug bundle",
          description: error.message,
        }),
      );
    },
  });

  const handleCopyBundle = useCallback(() => {
    const bundle = buildDiagnosticsBundle({
      generatedAt: new Date().toISOString(),
      app: {
        version: APP_VERSION,
        stage: APP_STAGE_LABEL,
        isElectron,
        userAgent: typeof navigator === "undefined" ? null : navigator.userAgent,
      },
      environments: environmentIds.map((environmentId) => ({
        environmentId,
        record: registryById[environmentId] ?? null,
        runtime: runtimeById[environmentId] ?? null,
        pushSequence: pushById[environmentId] ?? null,
      })),
      providers,
      observability: observabilityForBundle,
      performance: snapshot?.performance ?? null,
    });
    copyToClipboard(serializeDiagnosticsBundle(bundle), undefined);
  }, [
    copyToClipboard,
    environmentIds,
    observabilityForBundle,
    providers,
    pushById,
    registryById,
    runtimeById,
    snapshot?.performance,
  ]);

  const logsDirectoryPath = observability?.logsDirectoryPath ?? null;

  const handleOpenLogs = useCallback(() => {
    if (!logsDirectoryPath) return;
    setIsOpeningLogs(true);
    const editor = resolveAndPersistPreferredEditor(availableEditors ?? []);
    if (!editor) {
      setIsOpeningLogs(false);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not open logs folder",
          description: "No available editors found.",
        }),
      );
      return;
    }
    const openLogs = target
      ? (readEnvironmentConnection(target.environmentId)?.client.shell.openInEditor({
          cwd: logsDirectoryPath,
          editor,
        }) ?? Promise.reject(new Error("Selected environment is disconnected.")))
      : ensureLocalApi().shell.openInEditor(logsDirectoryPath, editor);
    void openLogs
      .catch((error: unknown) => {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not open logs folder",
            description: errorMessage(error, "Failed to open logs folder."),
          }),
        );
      })
      .finally(() => {
        setIsOpeningLogs(false);
      });
  }, [availableEditors, logsDirectoryPath, target]);

  return (
    <>
      <SettingsSection
        title="Diagnostics"
        headerAction={
          <Button size="xs" variant="outline" onClick={handleCopyBundle}>
            {isCopied ? (
              <ClipboardCheckIcon className="size-3.5" />
            ) : (
              <ClipboardCopyIcon className="size-3.5" />
            )}
            {isCopied ? "Copied" : "Copy debug bundle"}
          </Button>
        }
      >
        <SettingsRow
          title="Application"
          description={`Version ${APP_VERSION} · ${APP_STAGE_LABEL}${isElectron ? " · Desktop" : " · Browser"}`}
        />
        <SettingsRow
          title="Logs"
          description={logsDirectoryPath ?? "Resolving logs directory…"}
          control={
            <Button
              size="xs"
              variant="outline"
              disabled={!logsDirectoryPath || isOpeningLogs}
              onClick={handleOpenLogs}
            >
              {isOpeningLogs ? "Opening…" : "Open logs folder"}
            </Button>
          }
        />
      </SettingsSection>

      <SettingsSection title="Environments">
        {environmentIds.length === 0 ? (
          <SettingsRow
            title="No environments"
            description="No environment connections are tracked yet."
          />
        ) : (
          environmentIds.map((environmentId) => (
            <EnvironmentRow
              key={environmentId}
              environmentId={environmentId}
              record={registryById[environmentId] ?? null}
              runtime={runtimeById[environmentId] ?? null}
              pushSequence={pushById[environmentId] ?? null}
            />
          ))
        )}
      </SettingsSection>

      <SettingsSection title="Providers">
        {providers.length === 0 ? (
          <SettingsRow title="No providers" description="No provider instances are configured." />
        ) : (
          providers.map((provider) => {
            const detail = provider.unavailableReason ?? provider.message ?? null;
            return (
              <SettingsRow
                key={provider.instanceId}
                title={
                  <span className="inline-flex items-center gap-2">
                    <StateDot
                      className={PROVIDER_STATE_DOT[provider.status] ?? "bg-muted-foreground/40"}
                    />
                    {provider.displayName ?? provider.instanceId}
                  </span>
                }
                description={
                  <span className="space-y-0.5">
                    <span className="block">
                      {provider.status} · auth {provider.auth.status}
                      {provider.version ? ` · v${provider.version}` : ""}
                    </span>
                    {detail ? (
                      <span className="block break-all text-muted-foreground/70">{detail}</span>
                    ) : null}
                  </span>
                }
              />
            );
          })
        )}
      </SettingsSection>
    </>
  );
}
