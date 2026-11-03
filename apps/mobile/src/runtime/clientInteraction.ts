/**
 * Touches while the app is in front tell the connected machines that update themselves unattended
 * (`automaticUpdates`) that someone is using Ryco, so their updates wait. Which machines hear about
 * it, and how often, is `@ryco/client-runtime/updates/clientInteraction`'s, shared with web.
 */
import { readEnvironmentServerConfig } from "@ryco/client-runtime/rpc";
import {
  createClientInteractionReporter,
  type ClientInteractionReporter,
} from "@ryco/client-runtime/updates/clientInteraction";

import { createMobileConnectionRegistry } from "./bootstrap";

let reporter: ClientInteractionReporter | null = null;

/** A touch landed in the app; cheap enough for every touch. */
export function noteMobileClientInteraction(): void {
  reporter ??= createClientInteractionReporter({
    listConnections: () => createMobileConnectionRegistry().driver.supervisor.list(),
    readServerConfig: readEnvironmentServerConfig,
    now: () => performance.now(),
  });
  reporter.noteInteraction();
}
