import { useCallback, useEffect, useRef, useState } from "react";
import type { DesktopBridge } from "@ryco/contracts";

import {
  setDesktopThreadContentCacheEnabled,
  useDesktopThreadContentCacheEnabled,
} from "../../platform/desktopWorkspace";
import { Switch } from "../ui/switch";
import { SettingsRow } from "./settingsLayout";

const TITLE = "Keep recent conversations on this device";

/**
 * The desktop toggle for keeping recent conversation text on this device, so
 * they open at once after a restart. The cache itself lives in the Desktop main
 * process, encrypted; turning the row off deletes it.
 */
export function DesktopConversationCacheRow({
  desktopBridge,
}: {
  readonly desktopBridge: Pick<
    DesktopBridge,
    "getDesktopThreadContentCacheEnabled" | "setDesktopThreadContentCacheEnabled"
  >;
}) {
  const enabled = useDesktopThreadContentCacheEnabled();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const change = useCallback(async (next: boolean) => {
    setSaving(true);
    setError(null);
    try {
      await setDesktopThreadContentCacheEnabled(next);
    } catch {
      if (mountedRef.current) setError("Unable to change this setting.");
    } finally {
      if (mountedRef.current) setSaving(false);
    }
  }, []);

  // Unknown until the Desktop app answers, and for good when it has no Hub to cache for.
  if (
    !desktopBridge.getDesktopThreadContentCacheEnabled ||
    !desktopBridge.setDesktopThreadContentCacheEnabled ||
    enabled === null
  ) {
    return null;
  }

  return (
    <SettingsRow
      title={TITLE}
      description="Recent conversations open at once after a restart. They are encrypted on this device and deleted when you sign out or turn this off."
      status={error ? <span className="block text-destructive">{error}</span> : null}
      control={
        <Switch
          checked={enabled}
          disabled={saving}
          onCheckedChange={(checked) => void change(Boolean(checked))}
          aria-label={TITLE}
        />
      }
    />
  );
}
