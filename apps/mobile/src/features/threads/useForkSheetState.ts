import type { EnvironmentId, ThreadId } from "@ryco/contracts";
import { useState, type Dispatch, type SetStateAction } from "react";

import { forkSheetOnTarget, type ForkSheetHandle } from "./forkDestinationModel";

/**
 * The thread screen's fork sheet. The screen instance is reused when `navigate` retargets it to
 * another thread; a sheet opened on the previous thread is then dropped for good (during render,
 * so it is never shown on the new thread for even one frame) rather than hidden, so it can never
 * pop up again on its own when the screen comes back. Its attempt stays in the shared registry,
 * so "Fork from here" on that reply continues it.
 */
export function useForkSheetState(target: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}): readonly [ForkSheetHandle | null, Dispatch<SetStateAction<ForkSheetHandle | null>>] {
  const [state, setState] = useState<ForkSheetHandle | null>(null);
  const sheet = forkSheetOnTarget(state, target);
  if (sheet !== state) setState(sheet);
  return [sheet, setState];
}
