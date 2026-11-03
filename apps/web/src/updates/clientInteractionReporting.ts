/**
 * Tells connected nodes that update themselves unattended (`automaticUpdates`) when someone uses
 * this app, so their updates wait until nobody has for a while. Loaded off the shell's critical
 * path; the input listeners exist only while a connected node wants reports. Which nodes hear
 * about input, and how often, is `@ryco/client-runtime/updates/clientInteraction`'s, shared with
 * the phone app.
 */
import { subscribeEnvironmentServerConfigs } from "@ryco/client-runtime/rpc";
import { createClientInteractionReporter } from "@ryco/client-runtime/updates/clientInteraction";

import { readNodeServerConfig } from "../environments/nodeServerConfig";
import {
  listEnvironmentConnections,
  subscribeEnvironmentConnections,
} from "../environments/runtime";

const INPUT_EVENTS = ["pointerdown", "keydown", "wheel", "touchstart"] as const;
// Captured, so input a control stops from propagating (an editor's keydown) still counts.
const LISTENER_OPTIONS = { capture: true, passive: true } as const;

/** Reports input while any connected node wants it, until the returned stop runs. */
export function startClientInteractionReporting(): () => void {
  const reporter = createClientInteractionReporter({
    listConnections: listEnvironmentConnections,
    readServerConfig: readNodeServerConfig,
    now: () => performance.now(),
  });
  const onInput = () => reporter.noteInteraction();
  let listening = false;
  const listen = (on: boolean) => {
    if (on === listening) return;
    listening = on;
    for (const type of INPUT_EVENTS) {
      if (on) window.addEventListener(type, onInput, LISTENER_OPTIONS);
      else window.removeEventListener(type, onInput, LISTENER_OPTIONS);
    }
  };
  const reconcile = () => listen(reporter.wanted());
  const unsubscribes = [
    subscribeEnvironmentConnections(reconcile),
    subscribeEnvironmentServerConfigs(reconcile),
  ];
  reconcile();
  return () => {
    for (const unsubscribe of unsubscribes) unsubscribe();
    listen(false);
  };
}
