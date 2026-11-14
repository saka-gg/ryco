import type { ComputerGetAuditHistoryResult } from "@ryco/contracts";
import { useCallback, useEffect, useState } from "react";
import type {
  ComputerBetaPreferences,
  ComputerBetaState,
  DesktopAppSnapPermissionKind,
} from "@ryco/contracts";
import { useLocalComputerEnvironmentId } from "../../computerUse/localComputer";
import { readEnvironmentApi } from "../../environmentApi";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { ColorSwatchPicker } from "./ColorSwatchPicker";
import { PermissionStatusBadge } from "./PermissionStatusBadge";
import { SettingsBlock, SettingsNotice, SettingsRow, SettingsSection } from "./settingsLayout";
import { SettingsSelect } from "./SettingsSelect";
import { errorMessage } from "~/lib/errorMessage";

/** Distinct from the system cursor and from each other on light and dark windows. */
const CURSOR_SWATCHES = ["#e8794a", "#f43f5e", "#a855f7", "#3b82f6", "#14b8a6", "#22c55e"] as const;

const PERMISSIONS = [
  {
    kind: "accessibility",
    label: "Accessibility",
    detail: "Click, type and read apps.",
    optional: false,
  },
  {
    kind: "screenRecording",
    label: "Screen Recording",
    detail: "See app windows.",
    optional: false,
  },
  {
    kind: "inputMonitoring",
    label: "Input Monitoring",
    detail: "Optional. Lets the Escape key stop an agent and allows foreground takeover.",
    optional: true,
  },
] as const satisfies ReadonlyArray<{
  kind: DesktopAppSnapPermissionKind;
  label: string;
  detail: string;
  optional: boolean;
}>;

/** Agent Control on this Mac's own server; Computer Use's tools come through it. */
function useLocalAgentControl() {
  const environmentId = useLocalComputerEnvironmentId();
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const server = () => (environmentId ? readEnvironmentApi(environmentId)?.server : undefined);
  const refresh = useCallback(() => {
    const api = environmentId ? readEnvironmentApi(environmentId)?.server : undefined;
    if (!api) return;
    void api
      .getSettings()
      .then((settings) => setEnabled(settings.agentControl.enabled))
      .catch(() => undefined);
  }, [environmentId]);
  useEffect(() => {
    refresh();
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [refresh]);
  const enable = async () => {
    const api = server();
    if (!api)
      throw new Error("This Mac's Ryco server is not connected. Reconnect, then try again.");
    const settings = await api.updateSettings({ agentControl: { enabled: true } });
    setEnabled(settings.agentControl.enabled);
  };
  return { enabled, enable };
}

type ComputerBetaApi = NonNullable<NonNullable<typeof window.desktopBridge>["computerBeta"]>;

/** Only the desktop app on a Mac can drive this Mac; elsewhere the section is absent. */
export function ComputerBetaSettings() {
  const api = window.desktopBridge?.computerBeta;
  return api ? <ComputerBetaSettingsPanel api={api} /> : null;
}

function ComputerBetaSettingsPanel({ api }: { api: ComputerBetaApi }) {
  const [state, setState] = useState<ComputerBetaState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState<ComputerGetAuditHistoryResult | null>(null);
  const agentControl = useLocalAgentControl();
  useEffect(() => {
    let mounted = true;
    let checked = false;
    const refresh = () => {
      void api
        .checkPermissions()
        .then((value) => {
          checked = true;
          if (mounted) setState(value);
        })
        .catch(() => undefined);
    };
    void api
      .getState()
      .then((value) => {
        if (mounted && !checked) setState(value);
      })
      .catch(() => undefined);
    const unsubscribe = api.onUpdate((event) => {
      if (event.type === "state") setState(event.state);
    });
    // The cached state may predate any check (after an update, nothing read the grants yet):
    // opening the panel reads them, so it never shows a stale-grant hint from unknown grants.
    refresh();
    window.addEventListener("focus", refresh);
    return () => {
      mounted = false;
      unsubscribe();
      window.removeEventListener("focus", refresh);
    };
  }, [api]);
  if (state?.supported === false) return null;
  const run = async (operation: () => Promise<ComputerBetaState>) => {
    setBusy(true);
    setError(null);
    try {
      setState(await operation());
    } catch (cause) {
      setError(errorMessage(cause, "Computer setup failed."));
    } finally {
      setBusy(false);
    }
  };
  const change = (patch: Partial<ComputerBetaPreferences>) => {
    if (state) void run(() => api.setPreferences({ ...state.preferences, ...patch }));
  };
  const turnOn = () =>
    void run(async () => {
      if (agentControl.enabled !== true) await agentControl.enable();
      return api.turnOn();
    });
  const setup = state?.setup;
  const granted = setup !== undefined && setup.missing.length === 0;
  const on = granted && state?.preferences.defaultEnabled === true;
  const restartApp = window.desktopBridge?.restartApp;
  return (
    <SettingsSection
      title="Computer Use"
      description="Let agents use your Mac's apps and a browser from any chat."
      headerAction={
        <Badge size="sm" variant="outline">
          Beta
        </Badge>
      }
    >
      {granted ? (
        <SettingsRow
          title="Use in every chat"
          description={
            on ? (
              <>Agents can use the computer in any chat. Apps ask once before an agent uses them.</>
            ) : (
              <>
                Off. Start a single task with{" "}
                <code className="font-mono text-foreground">/computer-use</code>.
                {agentControl.enabled === false
                  ? " Turning it on also turns on Agent Control."
                  : null}
              </>
            )
          }
          control={
            <Switch
              aria-label="Use Computer Use in every chat"
              disabled={busy || !state}
              checked={on}
              onCheckedChange={(value) => (value ? turnOn() : change({ defaultEnabled: false }))}
            />
          }
        />
      ) : (
        <SettingsRow
          title={state?.preferences.defaultEnabled ? "Setup isn't finished" : "Computer Use is off"}
          description={
            agentControl.enabled === false
              ? "Asks macOS for two permissions and turns on Agent Control, which gives agents Ryco's private tools."
              : "Asks macOS for two permissions. Ryco checks each one when you come back."
          }
          control={
            <Button size="sm" disabled={busy || !state} onClick={turnOn}>
              {state?.preferences.defaultEnabled ? "Continue setup" : "Turn on Computer Use"}
            </Button>
          }
        />
      )}
      {setup?.movedToHelper ? (
        <SettingsBlock>
          <SettingsNotice
            tone="warning"
            title={`Computer Use now runs as ${state?.permissions.appDisplayName || "Ryco Computer Use"}`}
            action={
              <Button
                size="xs"
                variant="outline"
                disabled={busy || !state}
                onClick={() => void run(() => api.setup())}
              >
                Set up
              </Button>
            }
          >
            It is its own app in System Settings. Allow it once; you can remove Ryco from those
            lists.
          </SettingsNotice>
        </SettingsBlock>
      ) : null}
      {(on || state?.preferences.defaultEnabled) && agentControl.enabled === false ? (
        <SettingsBlock>
          <SettingsNotice
            tone="warning"
            action={
              <Button
                size="xs"
                variant="outline"
                disabled={busy}
                onClick={() =>
                  void agentControl.enable().catch((cause: unknown) => {
                    setError(errorMessage(cause, "Could not turn it on."));
                  })
                }
              >
                Turn on Agent Control
              </Button>
            }
          >
            Agent Control is off, so agents can't use the computer.
          </SettingsNotice>
        </SettingsBlock>
      ) : null}
      <SettingsRow
        title="Mac permissions"
        description={`Granted to ${state?.permissions.appDisplayName || "Ryco"} in System Settings → Privacy & Security.`}
      >
        <ul className="grid gap-2">
          {PERMISSIONS.map((permission) => {
            const status = state?.permissions[`${permission.kind}Permission`];
            return (
              <li
                key={permission.kind}
                className="flex items-center justify-between gap-3 rounded-[min(var(--radius-md),0.5rem)] bg-muted/50 px-2.5 py-2 text-xs"
              >
                <span className="min-w-0">
                  <span className="block truncate text-foreground">{permission.label}</span>
                  <span className="block truncate text-muted-foreground">{permission.detail}</span>
                </span>
                <span className="flex shrink-0 items-center gap-2">
                  <PermissionStatusBadge status={status} checked={status !== undefined} />
                  {state && status !== "granted" ? (
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={busy}
                      aria-label={`${permission.optional ? "Turn on" : "Fix"} ${permission.label}`}
                      onClick={() => void run(() => api.setupPermission(permission.kind))}
                    >
                      {permission.optional ? "Turn on" : "Fix"}
                    </Button>
                  ) : null}
                </span>
              </li>
            );
          })}
        </ul>
        {setup && !setup.escapeStop ? (
          <p className="mt-2 text-xs text-muted-foreground">
            Without Input Monitoring, agents stay in the background. Stop them with Stop in chat or
            in the menu bar.
          </p>
        ) : null}
      </SettingsRow>
      {setup?.staleGrant ? (
        <SettingsBlock>
          <SettingsNotice
            tone="warning"
            title={`macOS may still list an older ${state?.permissions.appDisplayName || "Ryco"}`}
            action={
              restartApp ? (
                <Button size="xs" variant="outline" onClick={() => void restartApp()}>
                  Quit & Reopen
                </Button>
              ) : undefined
            }
          >
            In System Settings, select {state?.permissions.appDisplayName || "Ryco"} under each
            missing permission, remove it with −, add it again, then quit and reopen Ryco.
          </SettingsNotice>
        </SettingsBlock>
      ) : null}
      <SettingsRow
        title="Always allowed apps"
        description="Agents use these apps without asking. Other apps ask the first time."
      >
        {state?.approvedApps.length ? (
          <ul className="divide-y divide-border/60 rounded-[min(var(--radius-md),0.5rem)] bg-muted/40 text-xs">
            {state.approvedApps.map((app) => (
              <li key={app.key} className="flex items-center justify-between gap-3 px-3 py-1.5">
                <span className="truncate text-foreground first-letter:uppercase">{app.name}</span>
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={busy}
                  aria-label={`Remove ${app.name}`}
                  onClick={() => void run(() => api.revokeApp(app.key))}
                >
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-muted-foreground">None yet.</p>
        )}
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
        {setup?.escapeStop
          ? "Escape interrupts the current action. Stop in chat or the menu bar ends the task. Your own input pauses foreground work."
          : "Stop in chat or the menu bar ends the task."}
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
