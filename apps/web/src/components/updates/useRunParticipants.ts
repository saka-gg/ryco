import type { UpdateEverythingRunState } from "@ryco/client-runtime/updates";
import { useState } from "react";

import {
  nextRunParticipants,
  type UpdateEverythingRunParticipants,
} from "./updateEverything.logic";

/**
 * The devices the current run set out to update, folded over every state this
 * component has seen, so one that drops out mid-run still counts toward done/total.
 */
export function useRunParticipants(
  run: UpdateEverythingRunState | null,
): UpdateEverythingRunParticipants | null {
  const [participants, setParticipants] = useState<UpdateEverythingRunParticipants | null>(null);
  const next = nextRunParticipants(participants, run);
  if (next !== participants) setParticipants(next);
  return next;
}
