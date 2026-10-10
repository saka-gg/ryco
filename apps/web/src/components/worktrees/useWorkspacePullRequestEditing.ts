import { WS_METHODS, type EnvironmentId, type WorktreePullRequestLink } from "@ryco/contracts";

import { useHostedRpcCapability } from "~/hostedHub/capabilities";
import { usePresentationTier } from "~/hooks/usePresentationTier";
import { useWsConnectionStatusForEnvironment } from "~/rpc/wsConnectionState";
import { isSyntheticWorktreeId } from "../sidebar/hooks/useSidebarTree";

export interface WorkspacePullRequestEditing {
  /** "Link pull request…" and "Unlink" exist for this workspace at all. */
  readonly supported: boolean;
  /** …and work right now (the environment accepts mutations). */
  readonly ready: boolean;
}

/**
 * Whether a workspace's pull request links can be changed from here. Not for
 * the project root, an archived or synthetic workspace, a server that predates
 * links (it sends no `pullRequests` and has no link RPC), or the frozen phone
 * tier; and only while the environment's connection accepts mutations.
 */
export function useWorkspacePullRequestEditing(input: {
  readonly environmentId: EnvironmentId | null;
  readonly worktree: {
    readonly worktreeId: string;
    readonly origin: string;
    readonly archivedAt?: string | null | undefined;
    readonly pullRequests?: ReadonlyArray<WorktreePullRequestLink> | undefined;
  } | null;
}): WorkspacePullRequestEditing {
  const presentationTier = usePresentationTier();
  const connection = useWsConnectionStatusForEnvironment(input.environmentId);
  const capability = useHostedRpcCapability(WS_METHODS.sourceControlLinkWorktreePullRequest);
  const worktree = input.worktree;
  const supported =
    input.environmentId !== null &&
    worktree !== null &&
    presentationTier !== "phone" &&
    worktree.origin !== "main" &&
    !worktree.archivedAt &&
    worktree.pullRequests !== undefined &&
    !isSyntheticWorktreeId(worktree.worktreeId);
  return {
    supported,
    ready: supported && connection.phase === "connected" && capability.allowed,
  };
}
