/**
 * What `ryco remote threads` does with a connected remote: list its threads from
 * one shell snapshot. `ryco remote send` is `ryco thread send --remote`
 * (`cliThread/threadCommands.ts`).
 */
import {
  ORCHESTRATION_WS_METHODS,
  type OrchestrationShellSnapshot,
  type OrchestrationThreadShell,
} from "@ryco/contracts";
import { isUnknownUnionMember } from "@ryco/contracts/base-schemas";
import { isRestartReleasedSession } from "@ryco/shared/restartContinuation";
import { Effect, Option, Stream } from "effect";

import { CliRemoteError, type CliRemoteRpcClient as RemoteRpcClient } from "./remotes.ts";

export const loadRemoteShell = (client: RemoteRpcClient) =>
  client[ORCHESTRATION_WS_METHODS.subscribeShell]({}).pipe(
    // A kind a remote newer than this CLI added is skipped.
    Stream.filter((item) => !isUnknownUnionMember(item) && item.kind === "snapshot"),
    Stream.take(1),
    Stream.runHead,
    Effect.flatMap((item) =>
      Option.isSome(item) && !isUnknownUnionMember(item.value) && item.value.kind === "snapshot"
        ? Effect.succeed(item.value.snapshot)
        : Effect.fail(
            new CliRemoteError({
              message: "The remote closed the connection before sending its threads.",
            }),
          ),
    ),
  );

const threadState = (thread: OrchestrationThreadShell): string => {
  if (thread.hasPendingApprovals) return "needs approval";
  if (thread.hasPendingUserInput) return "needs input";
  const status = thread.session?.status;
  if (status === "running" || status === "starting") return "running";
  // A node restart cut the turn off; nothing failed.
  if (isRestartReleasedSession(thread.session)) return "interrupted";
  if (status === "error") return "error";
  return "idle";
};

/** One line per open thread, most recently updated first. */
export function formatRemoteThreads(
  snapshot: OrchestrationShellSnapshot,
  options: { readonly includeArchived?: boolean; readonly limit?: number } = {},
): string {
  const projects = new Map(snapshot.projects.map((project) => [project.id, project.title]));
  const threads = snapshot.threads
    .filter((thread) => options.includeArchived || thread.archivedAt === null)
    .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, options.limit ?? 50);
  if (threads.length === 0) return "No threads.";
  const stateWidth = Math.max(...threads.map((thread) => threadState(thread).length));
  return threads
    .map(
      (thread) =>
        `${thread.id}  ${threadState(thread).padEnd(stateWidth)}  ${projects.get(thread.projectId) ?? "?"} / ${thread.title}`,
    )
    .join("\n");
}
