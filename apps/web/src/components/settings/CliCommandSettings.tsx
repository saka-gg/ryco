import type { DesktopCliCommandState } from "@ryco/contracts";
import { useEffect, useState } from "react";

import { desktopInvokeErrorMessage } from "~/lib/desktopInvokeError";
import { Button } from "../ui/button";
import { SettingsRow, SettingsSection } from "./settingsLayout";

function describe(state: DesktopCliCommandState): string {
  const name = state.commandName;
  if (state.shadowedBy) {
    return `Another ${name} at ${state.shadowedBy} runs first in a new terminal. Remove it to use this app's.`;
  }
  if (state.installedPath === null) {
    return `Run \`${name}\` in any terminal (pairing, Hub, threads and more) against this app's node.`;
  }
  return state.onPath
    ? `Installed at ${state.installedPath}. Open a new terminal to use it.`
    : `Installed at ${state.installedPath}, which is not on your PATH yet. Add its folder to your PATH to run \`${name}\`.`;
}

/** Installs the desktop app's `ryco` command (macOS and Linux, installed app only). */
export function CliCommandSettings({ scope }: { scope: string }) {
  const api = window.desktopBridge?.cliCommand;
  const [state, setState] = useState<DesktopCliCommandState | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void api
      ?.getState()
      .then((value) => {
        if (live) setState(value);
      })
      .catch(() => {
        if (live) setError("Could not read the terminal command's state.");
      });
    return () => {
      live = false;
    };
  }, [api]);
  if (!api || (state !== null && !state.supported)) return null;
  if (state === null && error === null) return null;
  const installed = state?.installedPath != null;
  const change = (action: "install" | "uninstall") => {
    setPending(true);
    setError(null);
    void api[action]()
      .then(setState)
      .catch((cause: unknown) => {
        setError(desktopInvokeErrorMessage(cause, "Something went wrong."));
      })
      .finally(() => setPending(false));
  };
  return (
    <SettingsSection title="Command line">
      <SettingsRow
        title="Terminal command"
        owner="client"
        scope={scope}
        description={state ? describe(state) : undefined}
        status={error ? <span role="alert">{error}</span> : undefined}
        control={
          state ? (
            <Button
              size="sm"
              variant="outline"
              disabled={pending}
              aria-label={`${installed ? "Remove" : "Install"} the ${state.commandName} command`}
              onClick={() => change(installed ? "uninstall" : "install")}
            >
              {installed ? "Remove" : "Install"}
            </Button>
          ) : undefined
        }
      />
    </SettingsSection>
  );
}
