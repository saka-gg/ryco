import { ClaudeResumeReviewError } from "./claudeCacheReview.ts";
import type { EnvironmentId } from "@ryco/contracts";
import type { EnvironmentConnection } from "../../connection/connection.ts";
import { getWsConnectionStatusForEnvironment } from "../../rpc/wsConnectionState.ts";

/** Capture an existing owner's live shell generation; never establishes readiness. */
export function captureReviewedSendReadiness(
  environmentId: EnvironmentId,
  readConnection: () => EnvironmentConnection | null,
): () => void {
  const connection = readConnection();
  const generation = connection?.shellSnapshotReadiness.read();
  return () => {
    if (
      !connection ||
      !generation ||
      readConnection() !== connection ||
      connection.shellSnapshotReadiness.read() !== generation ||
      getWsConnectionStatusForEnvironment(environmentId).phase !== "connected"
    ) {
      throw new ClaudeResumeReviewError(
        "The connection changed during Claude resume review. Reconnect and review again; your draft is retained.",
      );
    }
  };
}
