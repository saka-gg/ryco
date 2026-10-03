import type { EnvironmentId } from "@ryco/contracts";
import { createContext, useContext } from "react";

import type { PullRequestAgentHandoff } from "../agentHandoff";
import type { LandingFlash } from "./checksUi";
import type { ChecksJobEntry, ChecksWorkflowEntry } from "./checksModel";

/** "Re-run failed jobs" for one run, registered by the run's section. */
export type ChecksRunRerun = () => Promise<unknown>;

/**
 * What every row of the Checks tab needs from the tab: where to read logs,
 * whether actions apply, expansion memory, the landing flash, and the
 * per-run re-run registry the summary's "Re-run failed" drives.
 */
export interface ChecksTabContextValue {
  readonly environmentId: EnvironmentId | null;
  readonly cwd: string | null;
  readonly pullRequestNumber: number;
  /** The host's name, for "Open on GitHub". */
  readonly providerName: string;
  /** Agent fixes only make sense on an open change request. */
  readonly actionable: boolean;
  /** Open, and the host re-runs workflows (`capabilities.rerunWorkflows`). */
  readonly canRerun: boolean;
  /** The host serves job logs (`capabilities.workflowJobLogs`). */
  readonly logsAvailable: boolean;
  /** The run list is still loading its jobs (rows show step skeletons). */
  readonly jobsLoading: boolean;
  readonly handoff: PullRequestAgentHandoff;
  readonly resolvePath: (raw: string) => string | null;
  readonly revealFile: (path: string, line: number) => void;
  isExpanded(workflow: ChecksWorkflowEntry, job: ChecksJobEntry): boolean;
  setExpanded(workflow: ChecksWorkflowEntry, job: ChecksJobEntry, expanded: boolean): void;
  readonly flash: LandingFlash | null;
  registerRunRerun(runId: string, rerun: ChecksRunRerun): () => void;
}

export const ChecksTabContext = createContext<ChecksTabContextValue | null>(null);

export function useChecksTab(): ChecksTabContextValue {
  const value = useContext(ChecksTabContext);
  if (value === null) throw new Error("useChecksTab must be used inside the Checks tab.");
  return value;
}
