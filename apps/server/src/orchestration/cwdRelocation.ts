/**
 * Whether a thread's native conversation would continue somewhere else than
 * where it last ran.
 *
 * A thread's working directory can move (a chat turned into a project, a new
 * workspace root, a relocated worktree) while its persisted provider binding
 * still records the old one. Every path that would resume the conversation (a
 * turn start, a session restart, a checkpoint revert) compares the binding to
 * the thread's current workspace cwd here, so they agree on whether the
 * conversation moved and whether the provider can follow it.
 *
 * @module cwdRelocation
 */
import { realpathSync } from "node:fs";
import nodePath from "node:path";

import type { ProviderInstanceId, ProviderSession, ThreadId } from "@ryco/contracts";
import { Effect, Option } from "effect";

import type { ProviderServiceShape } from "../provider/Services/ProviderService.ts";

// Git canonicalizes registered paths, while saved paths can contain symlinked parents.
export function worktreeIdentity(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return nodePath.resolve(path);
  }
}

/** Whether a native conversation that last ran in `previous` would now run elsewhere. */
export function isMovedWorkingDirectory(previous: string, next: string): boolean {
  return previous !== next && worktreeIdentity(previous) !== worktreeIdentity(next);
}

/** A moved native conversation; `resumeSurvives` when the provider resumes it in any directory. */
export interface CwdRelocation {
  readonly previousCwd: string;
  readonly cwd: string;
  readonly resumeSurvives: boolean;
}

/**
 * The native conversation a start would resume, when it last ran outside the
 * thread's effective cwd. A restart resumes the live session's cursor; a
 * start without one gets the persisted binding's cursor and cwd merged by
 * ProviderService.startSession, for the same instance only. Undefined when
 * nothing would be resumed or the directory did not move.
 */
export const resolveCwdRelocation = Effect.fnUntraced(function* (
  providerService: Pick<ProviderServiceShape, "readResumeTarget" | "getCapabilities">,
  input: {
    readonly threadId: ThreadId;
    readonly liveSession: ProviderSession | undefined;
    readonly instanceId: ProviderInstanceId;
    readonly cwd: string | undefined;
  },
) {
  if (input.cwd === undefined) return undefined;
  let previousCwd: string | undefined;
  if (input.liveSession !== undefined) {
    previousCwd = input.liveSession.resumeCursor != null ? input.liveSession.cwd : undefined;
  } else if (providerService.readResumeTarget !== undefined) {
    const target = Option.getOrUndefined(yield* providerService.readResumeTarget(input.threadId));
    previousCwd =
      target?.hasResumeCursor === true && target.providerInstanceId === input.instanceId
        ? target.cwd
        : undefined;
  }
  if (previousCwd === undefined || !isMovedWorkingDirectory(previousCwd, input.cwd)) {
    return undefined;
  }
  const capabilities = yield* providerService.getCapabilities(input.instanceId);
  return {
    previousCwd,
    cwd: input.cwd,
    resumeSurvives: capabilities.resumeSurvivesCwdChange === true,
  } satisfies CwdRelocation;
});
