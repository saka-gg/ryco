// Adapted from Synara v1.0.4 (d36a31a29); see docs/licenses/synara-computer-use.txt.
/**
 * The workspace boundary for Computer tools that hand the caller's files to
 * the driver: browser upload/download and native image/file paste. Both take
 * model-supplied absolute paths, so both canonicalize them and prove they stay
 * inside the caller thread's workspace before anything dispatches.
 */
import { realpath } from "node:fs/promises";
import { isAbsolute, sep } from "node:path";
import { Effect } from "effect";

import { ToolInputError } from "./toolInput.ts";
import type { ToolContext } from "./toolRuntime.ts";

/** The caller thread's workspace root (its worktree when it has one), or null when it has none. */
export type ComputerWorkspaceRootResolver = (context: ToolContext) => Effect.Effect<string | null>;

/**
 * The caller thread's canonical workspace root. A missing resolver, a
 * projectless thread and a root that no longer exists all refuse with the
 * route's own message, before any file is touched.
 */
export async function canonicalComputerWorkspaceRoot(
  resolve: ComputerWorkspaceRootResolver | undefined,
  context: ToolContext,
  signal: AbortSignal | undefined,
  refusal: string,
): Promise<string> {
  const root = resolve
    ? await Effect.runPromise(resolve(context), signal ? { signal } : undefined)
    : null;
  if (!root?.trim()) throw new ToolInputError(refusal);
  return realpath(root).catch(() => {
    throw new ToolInputError(refusal);
  });
}

/**
 * Canonicalize one model-supplied filesystem path and prove it resolves inside
 * the already-canonical workspace. The canonical path is what gets dispatched:
 * a symlink cannot widen the approved set, and the driver's own canonicality
 * check then passes by construction.
 */
export async function boundedWorkspacePath(
  raw: unknown,
  workspaceRoot: string,
  field: string,
): Promise<string> {
  if (typeof raw !== "string" || raw.length === 0 || !isAbsolute(raw))
    throw new ToolInputError(`"${field}" must be an absolute path.`);
  const canonical = await realpath(raw).catch(() => {
    throw new ToolInputError(`"${field}" does not resolve to an existing path.`);
  });
  if (canonical !== workspaceRoot && !canonical.startsWith(workspaceRoot + sep))
    throw new ToolInputError(`"${field}" resolves outside the active workspace.`);
  return canonical;
}
