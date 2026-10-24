import { useCallback, useEffect, useRef, useState } from "react";
import type { DesktopBridge, DesktopKeepAwakeMode, DesktopKeepAwakeState } from "@ryco/contracts";

import { createVisibilityAwarePoller } from "../../lib/visibilityPolling";
import { webAppLifecycle } from "../../platform/appLifecycle";
import {
  DESKTOP_KEEP_AWAKE_MODE_OPTIONS,
  DESKTOP_KEEP_AWAKE_ROW_ID,
  describeDesktopKeepAwake,
  desktopDeviceNoun,
} from "./desktopKeepAwake.logic";
import { SettingsSelect } from "./SettingsSelect";
import { SettingsRow } from "./settingsLayout";

/** Power source, reachability and agent work change underneath the row; re-read this often. */
const KEEP_AWAKE_POLL_MS = 15_000;

/** The desktop's choice of when to hold this machine awake on AC power. */
export function DesktopKeepAwakeRow({
  desktopBridge,
}: {
  readonly desktopBridge: Pick<DesktopBridge, "getKeepAwakeState" | "setKeepAwakeMode">;
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

  const setMode = useCallback(
    async (mode: DesktopKeepAwakeMode) => {
      const write = desktopBridge.setKeepAwakeMode;
      if (!write) return;
      setSaving(true);
      setError(null);
      try {
        const next = await write(mode);
        if (mountedRef.current) setState(next);
      } catch {
        if (mountedRef.current) setError("Unable to change this setting.");
      } finally {
        if (mountedRef.current) setSaving(false);
      }
    },
    [desktopBridge],
  );

  if (!desktopBridge.getKeepAwakeState || !desktopBridge.setKeepAwakeMode) return null;

  return (
    <SettingsRow
      id={DESKTOP_KEEP_AWAKE_ROW_ID}
      title={`Keep ${device} awake while plugged in`}
      description={describeDesktopKeepAwake(state, device)}
      status={error ? <span className="block text-destructive">{error}</span> : null}
      control={
        <SettingsSelect<DesktopKeepAwakeMode>
          value={state?.mode ?? null}
          options={DESKTOP_KEEP_AWAKE_MODE_OPTIONS}
          disabled={state === null || saving}
          onValueChange={(mode) => void setMode(mode)}
          ariaLabel={`Keep ${device} awake while plugged in`}
          width="lg"
        />
      }
    />
  );
}
