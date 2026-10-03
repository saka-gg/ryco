import type { ComputerGetAuditHistoryResult } from "@ryco/contracts";
import { useEffect, useState } from "react";
import type { ComputerBetaPreferences, ComputerBetaState } from "@ryco/contracts";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { ColorSwatchPicker } from "./ColorSwatchPicker";
import { PermissionStatusBadge } from "./PermissionStatusBadge";
import { SettingsBlock, SettingsNotice, SettingsRow, SettingsSection } from "./settingsLayout";
import { SettingsSelect } from "./SettingsSelect";

/** Distinct from the system cursor and from each other on light and dark windows. */
const CURSOR_SWATCHES = ["#e8794a", "#f43f5e", "#a855f7", "#3b82f6", "#14b8a6", "#22c55e"] as const;

export function ComputerBetaSettings() {
  const api = window.desktopBridge?.computerBeta;
  const [state, setState] = useState<ComputerBetaState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState<ComputerGetAuditHistoryResult | null>(null);
  useEffect(() => {
    if (!api) return;
    let mounted = true;
    const refresh = () => {
      void api
        .checkPermissions()
        .then((value) => {
          if (mounted) setState(value);
        })
        .catch(() => undefined);
    };
    void api
      .getState()
      .then((value) => {
        if (mounted) setState(value);
      })
      .catch(() => undefined);
    const unsubscribe = api.onUpdate((event) => {
      if (event.type === "state") setState(event.state);
    });
    window.addEventListener("focus", refresh);
    return () => {
      mounted = false;
      unsubscribe();
      window.removeEventListener("focus", refresh);
    };
  }, [api]);
  if (!api || state?.supported === false) return null;
  const run = async (operation: () => Promise<ComputerBetaState>) => {
    setBusy(true);
    setError(null);
    try {
      setState(await operation());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Computer setup failed.");
    } finally {
      setBusy(false);
    }
  };
  const change = (patch: Partial<ComputerBetaPreferences>) => {
    if (state) void run(() => api.setPreferences({ ...state.preferences, ...patch }));
  };
  const permissions = [
    ["Accessibility", "accessibilityPermission"],
    ["Input Monitoring", "inputMonitoringPermission"],
    ["Screen Recording", "screenRecordingPermission"],
  ] as const;
  return (
    <SettingsSection
      title="Computer Use"
      description={
        <>
          Use Mac apps and an isolated browser from chat. Start one task with{" "}
          <code className="font-mono text-foreground">/computer-use</code>, or turn it on by
          default. Requires Agent Control and a supported provider.
        </>
      }
      headerAction={
        <Badge size="sm" variant="outline">
          Beta
        </Badge>
      }
    >
      <SettingsRow
        title="Use by default"
        description="Start every new task with Computer Use available."
        control={
          <Switch
            aria-label="Enable Computer by default"
            disabled={busy || !state}
            checked={state?.preferences.defaultEnabled ?? false}
            onCheckedChange={(value) => change({ defaultEnabled: !!value })}
          />
        }
      />
      <SettingsRow
        title="Mac permissions"
        description="Grant access to this Ryco app in System Settings. Setup checks each grant again when you return, and never sends your prompt."
        control={
          <>
            <Button
              size="xs"
              variant="outline"
              disabled={busy}
              onClick={() => void run(() => api.checkPermissions())}
            >
              Check permissions
            </Button>
            <Button size="xs" disabled={busy} onClick={() => void run(() => api.setup())}>
              Set up Computer
            </Button>
          </>
        }
      >
        <ul className="grid gap-2 sm:grid-cols-3">
          {permissions.map(([label, key]) => (
            <li
              key={key}
              className="flex items-center justify-between gap-2 rounded-[min(var(--radius-md),0.5rem)] bg-muted/50 px-2.5 py-2 text-xs"
            >
              <span className="truncate text-foreground">{label}</span>
              <PermissionStatusBadge
                status={state?.permissions[key]}
                checked={state?.permissions[key] !== undefined}
              />
            </li>
          ))}
        </ul>
      </SettingsRow>
      <SettingsRow
        title="Show preview automatically"
        description="Open a view-only preview while an agent works. It is never added to model context."
        control={
          <Switch
            aria-label="Show preview automatically"
            disabled={!state || busy}
            checked={state?.preferences.autoPreview ?? true}
            onCheckedChange={(value) => change({ autoPreview: !!value })}
          />
        }
      />
      <SettingsRow
        title="Preview size"
        description="How much room the live preview takes beside the conversation."
        control={
          <SettingsSelect<"compact" | "large">
            ariaLabel="Preview size"
            width="sm"
            value={state?.preferences.previewSize ?? "compact"}
            disabled={!state || busy}
            onValueChange={(value) => change({ previewSize: value })}
            options={[
              { value: "compact", label: "Compact" },
              { value: "large", label: "Large" },
            ]}
          />
        }
      />
      <SettingsRow
        title="Agent cursor color"
        description="The color of the agent's own cursor, so you can tell its actions from yours."
      >
        <ColorSwatchPicker
          ariaLabel="Agent cursor color"
          value={state?.preferences.cursorColor ?? null}
          disabled={!state}
          swatches={CURSOR_SWATCHES}
          defaultOption={{ label: "Default cursor" }}
          onChange={(cursorColor) => change({ cursorColor })}
        />
      </SettingsRow>
      <SettingsRow
        title="Recent actions"
        description="Bounded local activity history. Typed values and clipboard contents are omitted."
        status={history?.truncated ? "Some older activity is no longer retained." : undefined}
        control={
          <>
            {history?.nextCursor ? (
              <Button
                size="xs"
                variant="ghost"
                onClick={() =>
                  void api
                    .getHistory({ before: history.nextCursor! })
                    .then(setHistory)
                    .catch(() => setError("Could not load older actions."))
                }
              >
                Older actions
              </Button>
            ) : null}
            <Button
              size="xs"
              variant="outline"
              onClick={() =>
                void api
                  .getHistory()
                  .then(setHistory)
                  .catch(() => setError("Could not load recent actions."))
              }
            >
              {history ? "Refresh" : "Load recent actions"}
            </Button>
          </>
        }
      >
        {history ? (
          history.entries.length ? (
            <ul className="max-h-64 divide-y divide-border/60 overflow-y-auto rounded-[min(var(--radius-md),0.5rem)] bg-muted/40 text-xs">
              {history.entries.map((entry) => (
                <li key={entry.id} className="flex justify-between gap-4 px-3 py-2">
                  <span className="truncate capitalize text-foreground">
                    {entry.tool.replaceAll("_", " ")}
                  </span>
                  <span className="shrink-0 text-muted-foreground tabular-nums">
                    {entry.effect.replaceAll("-", " ")} · {new Date(entry.ts).toLocaleTimeString()}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-muted-foreground">No actions recorded.</p>
          )
        ) : null}
      </SettingsRow>
      <SettingsBlock className="text-xs leading-relaxed text-muted-foreground">
        Escape interrupts the current action and requires a fresh observation. Stop in chat ends the
        task. Your own input pauses foreground work.
      </SettingsBlock>
      {error || state?.error ? (
        <SettingsBlock>
          <SettingsNotice tone="error" role="alert">
            {error ?? state?.error}
          </SettingsNotice>
        </SettingsBlock>
      ) : null}
    </SettingsSection>
  );
}
