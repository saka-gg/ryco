import {
  readWorkspaceFileBytesFromTransport,
  type WorkspaceFileBytes,
  type WorkspaceFileReadProgress,
} from "@ryco/client-runtime/rpc/workspaceFileRead";
import type { EnvironmentId } from "@ryco/contracts";

import { readEnvironmentApi } from "../environmentApi";

/**
 * Reads a workspace file in bounded chunks over its environment's authorized
 * connection, as it stands when the read starts (a replacement connection
 * fails the read instead of contributing chunks to it).
 */
export function readEnvironmentWorkspaceFileBytes(input: {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly relativePath: string;
  readonly signal?: AbortSignal | undefined;
  readonly onProgress?: ((progress: WorkspaceFileReadProgress) => void) | undefined;
}): Promise<WorkspaceFileBytes> {
  const { environmentId, cwd, relativePath } = input;
  return readWorkspaceFileBytesFromTransport({
    reference: { cwd, relativePath },
    currentTransport: () => {
      const readFileChunk = readEnvironmentApi(environmentId)?.projects.readFileChunk;
      return readFileChunk ? { readFileChunk } : undefined;
    },
    signal: input.signal,
    onProgress: input.onProgress,
  });
}
