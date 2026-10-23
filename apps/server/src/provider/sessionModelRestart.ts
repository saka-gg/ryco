import type { ModelSelection } from "@ryco/contracts";
import { Equal } from "effect";

/**
 * Whether a turn's model selection restarts the thread's live session on its provider
 * instance. A Claude session restarts (resuming its conversation) for any change of model or
 * options; every other driver applies the selection inside the running session. The restart
 * replaces the provider runtime, which ends the native background work it still runs, so the
 * engine guards such a turn start like a context handoff
 * (`requireNoBackgroundWorkForModelSwitch`).
 */
export function modelSelectionChangeRestartsSession(input: {
  readonly driver: string | null | undefined;
  readonly previous: ModelSelection | undefined;
  readonly requested: ModelSelection | undefined;
}): boolean {
  return (
    input.driver === "claudeAgent" &&
    input.requested !== undefined &&
    !Equal.equals(input.previous, input.requested)
  );
}
