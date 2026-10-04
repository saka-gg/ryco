import { useCallback, useEffect, useRef, useState } from "react";
import type { DesktopBridge, DesktopKeepAwakeState } from "@ryco/contracts";

import { createVisibilityAwarePoller } from "../../lib/visibilityPolling";
import { webAppLifecycle } from "../../platform/appLifecycle";
import { Switch } from "../ui/switch";
import { describeDesktopKeepAwake, desktopDeviceNoun } from "./desktopKeepAwake.logic";
import { SettingsRow } from "./settingsLayout";

/** Power source and reachability change underneath the row; re-read this often. */
const KEEP_AWAKE_POLL_MS = 15_000;

/** The single desktop toggle for holding a reachable node awake on AC power. */
export function DesktopKeepAwakeRow({
  desktopBridge,
}: {
  readonly desktopBridge: Pick<DesktopBridge, "getKeepAwakeState" | "setKeepAwakeEnabled">;
}) {
  const [state, setState] = useState<DesktopKeepAwakeState | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);
  const device = desktopDeviceNoun(typeof navigator === "undefined" ? "" : navigator.platform);

  useEffect(() => {
    mountedRef.current = true;
    const read = desktopBridge.getKeepAwakeState;
    if (!read) return;
    const poller = createVisibilityAwarePoller({
      lifecycle: webAppLifecycle,
      run: async () => {
        const next = await read();
        if (mountedRef.current) setState(next);
      },
      resolveDelayMs: () => KEEP_AWAKE_POLL_MS,
    });
    return () => {
      mountedRef.current = false;
      poller.stop();
    };
  }, [desktopBridge]);

  const setEnabled = useCallback(
    async (enabled: boolean) => {
      const write = desktopBridge.setKeepAwakeEnabled;
      if (!write) return;
      setSaving(true);
      setError(null);
      try {
        const next = await write(enabled);
        if (mountedRef.current) setState(next);
      } catch {
        if (mountedRef.current) setError("Unable to change this setting.");
      } finally {
        if (mountedRef.current) setSaving(false);
      }
    },
    [desktopBridge],
  );

  if (!desktopBridge.getKeepAwakeState || !desktopBridge.setKeepAwakeEnabled) return null;

  return (
    <SettingsRow
      title={`Keep ${device} awake while plugged in`}
      description={describeDesktopKeepAwake(state, device)}
      status={error ? <span className="block text-destructive">{error}</span> : null}
      control={
        <Switch
          checked={state?.enabled ?? true}
          disabled={state === null || saving}
          onCheckedChange={(checked) => void setEnabled(Boolean(checked))}
          aria-label={`Keep ${device} awake while plugged in`}
        />
      }
    />
  );
}
