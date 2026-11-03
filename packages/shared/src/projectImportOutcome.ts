import type { AgentControlProjectSetupOutcome } from "@ryco/contracts";
import type { ProjectImportSnapshot } from "@ryco/contracts/project-copy";

/** A result message's bound (`AGENT_CONTROL_ERROR_MESSAGE_MAX_CHARS`). */
const DETAIL_MAX_CHARS = 2_000;

/**
 * How an import's setup command ended, read from its `setup` step: what an
 * Agent Control result reports for an `importProject` (this node's import) and
 * a `copyProjectToNode` (the target's import, reported by the approving app).
 * Null when no setup command ran (none was given, or the import ended first).
 *
 * Pure: shared by the server and the web client.
 */
export function projectImportSetupOutcome(
  snapshot: Pick<ProjectImportSnapshot, "steps">,
): AgentControlProjectSetupOutcome | null {
  const step = snapshot.steps.find((candidate) => candidate.id === "setup");
  if (step === undefined || (step.status !== "done" && step.status !== "failed")) return null;
  const detail = step.detail?.trim().slice(0, DETAIL_MAX_CHARS).trim() ?? "";
  return {
    status: step.status === "done" ? "succeeded" : "failed",
    detail: detail.length === 0 ? null : detail,
  };
}
