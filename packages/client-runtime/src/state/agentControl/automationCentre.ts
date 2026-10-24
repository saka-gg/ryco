import type {
  AgentControlAutomationRunStatus,
  AutomationCentreApi,
  AutomationCentreSnapshot,
  ProjectId,
} from "@ryco/contracts";
import * as Records from "effect/Record";

import { createSingleFlightReader, type SingleFlightReader } from "../singleFlightReader.ts";
import { AUTOMATION_RUN_STATUS } from "./automationSchedules.ts";

/** One run vocabulary app-wide: the labels of `AUTOMATION_RUN_STATUS`. */
export const automationRunStatusLabel: Readonly<Record<AgentControlAutomationRunStatus, string>> =
  Records.map(AUTOMATION_RUN_STATUS, (status) => status.label);

/** The checkout's automation snapshot through the shared single-flight reader. */
export function createAutomationCentreReader(input: {
  api: AutomationCentreApi;
  projectId: ProjectId;
  onSnapshot: (snapshot: AutomationCentreSnapshot) => void;
  onError: () => void;
}): SingleFlightReader {
  return createSingleFlightReader({
    read: () => input.api.snapshot({ projectId: input.projectId }),
    onValue: input.onSnapshot,
    onError: () => input.onError(),
  });
}
