import { useEffect, useState } from "react";
import { useDesktopWorkspaceState } from "../platform/desktopWorkspace";
import { useSettingsDialogStore } from "../settingsDialogStore";
import { Button } from "./ui/button";

/** Native main owns sign-in, protected storage, and automatic node setup. */
export function DesktopAccountConnect() {
  const workspace = useDesktopWorkspaceState();
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  // Native account setup only exists where main can run it. Elsewhere the node
  // enrols from Connection settings, and this prompt would fail on every click.
  const [supported, setSupported] = useState<boolean | null>(null);
  const bridge = window.desktopBridge;
  const connect = bridge?.connectHostedIdentity;
  useEffect(() => {
    if (!bridge?.getHubLaunchConfig) return;
    let active = true;
    void bridge
      .getHubLaunchConfig()
      .then((config) => {
        if (active) setSupported(config.origin !== null && config.hostedIdentitySupported === true);
      })
      .catch(() => {
        if (active) setSupported(false);
      });
    return () => {
      active = false;
    };
  }, [bridge]);
  if (!connect || supported !== true || workspace.status === "ready") return null;

  return (
    <div className="mt-6 space-y-3">
      <p className="text-sm text-muted-foreground">
        Sign in to bring your machines together. Ryco adds this Mac automatically.
      </p>
      <div className="flex flex-wrap justify-center gap-2">
        <Button
          disabled={pending}
          onClick={async () => {
            setPending(true);
            setFailed(false);
            try {
              const state = await connect();
              setFailed(state.status === "unavailable");
            } catch {
              setFailed(true);
            } finally {
              setPending(false);
            }
          }}
        >
          {pending ? "Opening sign-in…" : "Connect Ryco account"}
        </Button>
        <Button
          variant="ghost"
          onClick={() => useSettingsDialogStore.getState().openSettings("connections")}
        >
          Connection settings
        </Button>
      </div>
      {failed ? (
        <p role="status" className="text-sm text-destructive">
          Account setup is temporarily unavailable. Retry or open Connection settings for details.
        </p>
      ) : null}
    </div>
  );
}
