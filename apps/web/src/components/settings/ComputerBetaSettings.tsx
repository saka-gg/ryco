import type { ComputerGetAuditHistoryResult } from "@ryco/contracts";
import { useEffect, useState } from "react";
import type { ComputerBetaPreferences, ComputerBetaState } from "@ryco/contracts";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";

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
  return (
    <section data-settings-section="Computer Use beta" className="border-b p-6 sm:p-8">
      <div className="mx-auto max-w-4xl space-y-5">
        <div>
          <h2 className="text-lg font-semibold">
            Computer Use{" "}
            <span className="ml-1 rounded border px-1.5 py-0.5 text-xs font-normal text-muted-foreground">
              Beta
            </span>
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Use Mac apps and an isolated browser from chat. Start one task with{" "}
            <code>/computer-use</code>, or enable it by default. Requires Agent Control and a
            supported provider.
          </p>
        </div>
        <label className="flex items-center justify-between gap-4 text-sm">
          Enable Computer by default
          <Switch
            aria-label="Enable Computer by default"
            disabled={busy || !state}
            checked={state?.preferences.defaultEnabled ?? false}
            onCheckedChange={(value) => change({ defaultEnabled: !!value })}
          />
        </label>
        <div className="space-y-2 rounded-lg border p-4">
          <h3 className="text-sm font-medium">Mac permissions</h3>
          <ol className="space-y-1 text-sm text-muted-foreground">
            {(
              [
                ["Accessibility", "accessibilityPermission"],
                ["Input Monitoring", "inputMonitoringPermission"],
                ["Screen Recording", "screenRecordingPermission"],
              ] as const
            ).map(([label, key], index) => (
              <li key={key}>
                {index + 1}. {label}
                <span className="float-right">{state?.permissions[key] ?? "Not checked"}</span>
              </li>
            ))}
          </ol>
          <p className="text-xs text-muted-foreground">
            Grant access to this Ryco app in System Settings. Setup checks each grant again when you
            return. It never sends your prompt.
          </p>
          <div className="flex gap-2">
            <Button size="sm" disabled={busy} onClick={() => void run(() => api.setup())}>
              Set up Computer
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => void run(() => api.checkPermissions())}
            >
              Check permissions
            </Button>
          </div>
        </div>
        <label className="flex items-center justify-between text-sm">
          Show preview automatically
          <Switch
            aria-label="Show preview automatically"
            disabled={!state || busy}
            checked={state?.preferences.autoPreview ?? true}
            onCheckedChange={(value) => change({ autoPreview: !!value })}
          />
        </label>
        <label className="flex items-center justify-between text-sm">
          Preview size
          <select
            aria-label="Preview size"
            className="rounded border bg-background px-2 py-1"
            value={state?.preferences.previewSize ?? "compact"}
            disabled={!state || busy}
            onChange={(event) =>
              change({ previewSize: event.target.value === "large" ? "large" : "compact" })
            }
          >
            <option value="compact">Compact</option>
            <option value="large">Large</option>
          </select>
        </label>
        <label className="flex items-center justify-between text-sm">
          Agent cursor color
          <input
            aria-label="Agent cursor color"
            type="color"
            value={state?.preferences.cursorColor ?? "#e8794a"}
            disabled={!state || busy}
            onChange={(event) => change({ cursorColor: event.target.value })}
          />
        </label>
        <p className="text-xs text-muted-foreground">
          Escape interrupts the current action and requires a fresh observation. Stop in chat ends
          the task. Your own input pauses foreground work. The preview is view-only and is never
          added to model context.
        </p>
        <div>
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              void api
                .getHistory()
                .then(setHistory)
                .catch(() => setError("Could not load recent actions."))
            }
          >
            Load recent actions
          </Button>
          {history?.nextCursor ? (
            <Button
              size="sm"
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
          {history?.truncated ? (
            <p className="text-xs text-muted-foreground">
              Some older activity is no longer retained.
            </p>
          ) : null}
          {history ? (
            <div className="mt-2 max-h-64 overflow-auto text-xs">
              <p className="mb-2 text-muted-foreground">
                Bounded local activity history. Typed values and clipboard contents are omitted.
              </p>
              {history.entries.length ? (
                history.entries.map((entry) => (
                  <p key={entry.id} className="flex justify-between gap-4 border-b py-2">
                    <span>{entry.tool.replaceAll("_", " ")}</span>
                    <span>
                      {entry.effect.replaceAll("-", " ")} ·{" "}
                      {new Date(entry.ts).toLocaleTimeString()}
                    </span>
                  </p>
                ))
              ) : (
                <p>No actions recorded.</p>
              )}
            </div>
          ) : null}
        </div>
        {error || state?.error ? (
          <p role="alert" className="text-sm text-destructive">
            {error ?? state?.error}
          </p>
        ) : null}
      </div>
    </section>
  );
}
