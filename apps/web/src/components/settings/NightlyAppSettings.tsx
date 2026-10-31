import type { DesktopNightlyState } from "@ryco/contracts";
import { useCallback, useEffect, useState } from "react";

import { desktopInvokeErrorMessage } from "~/lib/desktopInvokeError";
import { Button } from "../ui/button";
import { SettingsRow } from "./settingsLayout";

const COPY_CONFIRMATION =
  "Ryco Nightly's chats and settings are replaced by a copy of Ryco's when it starts. Ryco stays as it is. Ryco's node identity, sessions and schedules are not copied.";

function describe(state: DesktopNightlyState): string {
  if (state.flavor === "nightly") {
    const imported = state.lastImport;
    if (imported === null) return "This is Ryco Nightly, with its own data next to Ryco's.";
    const when = new Date(imported.completedAt).toLocaleString();
    return imported.ok
      ? `Ryco's data was copied in on ${when}. Ryco itself was not changed.`
      : `The last copy of Ryco's data did not happen: ${imported.error ?? "it failed."}`;
  }
  if (!state.otherAppInstalled) {
    return "Try nightly builds as a separate app, Ryco Nightly, with its own data. Ryco stays as it is.";
  }
  return state.nightlyRunning
    ? "Ryco Nightly is open. Quit it to start it with a copy of Ryco's data."
    : "Open Ryco Nightly as it is, or start it with a copy of Ryco's chats and settings.";
}

/** Ryco Nightly from Ryco (install, open, copy), and the way back from Ryco Nightly. */
export function NightlyAppSettings({ scope }: { readonly scope: string }) {
  const api = window.desktopBridge?.nightly;
  const [state, setState] = useState<DesktopNightlyState | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(() => {
    if (!api) return;
    void api
      .getState()
      .then(setState)
      .catch(() => setError("Could not check for Ryco Nightly."));
  }, [api]);
  useEffect(refresh, [refresh]);
  if (!api || state === null) return null;

  const run = (action: () => Promise<void>) => {
    setPending(true);
    setError(null);
    void action()
      .catch((cause: unknown) => setError(desktopInvokeErrorMessage(cause, "It did not work.")))
      .finally(() => {
        setPending(false);
        refresh();
      });
  };
  const openExternal = () => void window.desktopBridge?.openExternal(state.releasesUrl);

  const control =
    state.flavor === "nightly" ? (
      state.otherAppInstalled ? (
        <Button size="sm" variant="outline" disabled={pending} onClick={() => run(api.switchBack)}>
          Switch back to Ryco
        </Button>
      ) : null
    ) : !state.otherAppInstalled ? (
      <Button size="sm" variant="outline" onClick={openExternal}>
        Get Ryco Nightly
      </Button>
    ) : (
      <div className="flex flex-wrap justify-end gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={pending}
          onClick={() => run(() => api.open({ copyData: false }))}
        >
          Open Ryco Nightly
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={pending || state.nightlyRunning}
          onClick={() => {
            if (!window.confirm(COPY_CONFIRMATION)) return;
            run(() => api.open({ copyData: true }));
          }}
        >
          Copy my data and open
        </Button>
      </div>
    );

  return (
    <SettingsRow
      title="Ryco Nightly"
      scope={scope}
      description={describe(state)}
      status={error ? <span role="alert">{error}</span> : undefined}
      control={control}
    />
  );
}
