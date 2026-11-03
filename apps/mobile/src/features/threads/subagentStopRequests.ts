import {
  createStopRequestRegistry,
  describeSubagentStopFailure,
  STOP_UNCONFIRMED_MS,
  type StopRequestRegistry,
} from "@ryco/client-runtime/state/session/subagentStop";

/**
 * The phone's one registry of agent stops (web keeps its own): every agents
 * sheet agrees on which stop is on its way, and each is reported once.
 */
export const subagentStopRequests = createStopRequestRegistry(STOP_UNCONFIRMED_MS);

export interface SubagentStopAlert {
  readonly title: string;
  readonly message: string;
}

/**
 * Sends a stop for one agent unless one is on its way. The node accepting it
 * is not the agent stopping: it stays pending until the agent settles (its row
 * loses Stop) or the shared timeout passes. A stop still unconfirmed then,
 * while its row shows, and a failed one are reported, in web's words.
 */
export function startSubagentStop(input: {
  readonly registry: StopRequestRegistry;
  readonly key: string;
  readonly send: () => Promise<void>;
  readonly alert: (alert: SubagentStopAlert) => void;
}): boolean {
  return input.registry.start(input.key, input.send, {
    onUnconfirmed: () =>
      input.alert({
        title: "Stop not confirmed",
        message: "The agent may still be running. You can try again.",
      }),
    onFailed: (cause) =>
      input.alert({ title: "Could not stop agent", message: describeSubagentStopFailure(cause) }),
  });
}
