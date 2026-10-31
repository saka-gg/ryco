/**
 * The model selection of a turn that names none (a goal continuation), loaded by the provider
 * command reactor only when a client stored a pick on the thread since its session applied one.
 *
 * @module implicitTurnModelSelection
 */
import type { ModelSelection, OrchestrationThreadShell } from "@ryco/contracts";
import { sameModelSelection } from "@ryco/shared/model";
import { Effect } from "effect";

import type { ProviderServiceShape } from "../provider/Services/ProviderService.ts";
import type { modelSelectionChangeRestartsSession } from "../provider/sessionModelRestart.ts";
import type { ThreadBackgroundLivenessService } from "./ThreadBackgroundLiveness.ts";

/** `modelSelectionChangeRestartsSession`, passed in: this module imports no boot values. */
type ChangeRestartsSession = typeof modelSelectionChangeRestartsSession;

/**
 * The selection a turn that names none runs with, or undefined to keep what the session runs.
 * Clients store a pick on the thread when it is made and the session takes it at its next turn,
 * so such a turn runs on the thread's stored selection when it differs from the one the session
 * applied last on the same provider instance. It keeps the session's own: before any applied
 * selection is known (a start uses the stored one anyway), for a pick of another instance (only
 * a send hands off), for another model on a session that cannot switch models, and for a change
 * that would restart a session still running background work, since no one is asked before
 * those tasks end (the next send asks).
 */
export function implicitTurnModelSelection(input: {
  readonly driver: string | null | undefined;
  readonly sessionModelSwitch: "in-session" | "unsupported";
  readonly applied: ModelSelection | undefined;
  readonly stored: ModelSelection;
  readonly hasLiveBackgroundWork: boolean;
  readonly changeRestartsSession: ChangeRestartsSession;
}): ModelSelection | undefined {
  const { applied, stored } = input;
  if (
    applied === undefined ||
    applied.instanceId !== stored.instanceId ||
    sameModelSelection(applied, stored) ||
    (input.sessionModelSwitch === "unsupported" && applied.model !== stored.model)
  ) {
    return undefined;
  }
  if (
    input.hasLiveBackgroundWork &&
    input.changeRestartsSession({
      driver: input.driver,
      previous: applied,
      requested: stored,
    })
  ) {
    return undefined;
  }
  return stored;
}

/** `implicitTurnModelSelection` for the thread as the reactor reads it at its turn start. */
export const resolveImplicitTurnModelSelection = Effect.fnUntraced(function* (input: {
  readonly thread: OrchestrationThreadShell;
  readonly applied: ModelSelection;
  readonly providerService: Pick<ProviderServiceShape, "getCapabilities">;
  readonly backgroundLiveness: ThreadBackgroundLivenessService["Service"] | undefined;
  readonly changeRestartsSession: ChangeRestartsSession;
}) {
  const { thread } = input;
  const stored = thread.modelSelection;
  const sessionModelSwitch = yield* input.providerService.getCapabilities(stored.instanceId).pipe(
    Effect.map((capabilities) => capabilities.sessionModelSwitch),
    // An instance the node cannot describe keeps what its session runs.
    Effect.orElseSucceed(() => "unsupported" as const),
  );
  const session = thread.session;
  const hasLiveBackgroundWork =
    session !== null &&
    session.status !== "stopped" &&
    input.backgroundLiveness !== undefined &&
    input.backgroundLiveness.listLiveTaskIds(thread.id, session.runtimeSessionId ?? null).length >
      0;
  return implicitTurnModelSelection({
    driver: session?.providerName,
    sessionModelSwitch,
    applied: input.applied,
    stored,
    hasLiveBackgroundWork,
    changeRestartsSession: input.changeRestartsSession,
  });
});
