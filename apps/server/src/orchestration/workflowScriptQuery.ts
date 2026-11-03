/**
 * Read-only access to persisted workflow scripts for the Agents surface's
 * "{} script" affordance.
 *
 * Containment rules:
 * - the resolved realpath must live under a `.claude/projects` root (where
 *   the Claude harness persists workflow scripts) — realpath re-containment
 *   defeats symlink escapes, including a symlinked leaf file. Roots cover
 *   the default OS home plus any configured Claude provider home overrides;
 * - only .js leaf files are served;
 * - reads are size-capped rather than failed, with a truncation marker.
 *
 * The client-supplied path is a hint from the workflow's runHandles; it is
 * never trusted beyond these checks.
 */
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { OrchestrationGetWorkflowScriptError, type ServerSettings } from "@ryco/contracts";
import { NotRegularFileError, openRegularFile } from "@ryco/shared/regularFile";
import { Effect } from "effect";

import { expandHomePath } from "../pathExpansion.ts";

const SCRIPT_BYTE_CAP = 256 * 1024;

export function defaultWorkflowScriptRoots(): ReadonlyArray<string> {
  return [NodePath.join(NodeOS.homedir(), ".claude", "projects")];
}

/**
 * Containment roots: the default OS home plus every configured Claude
 * provider home override (Ryco supports per-instance homePath, which is
 * where the harness persists workflow scripts when HOME is redirected).
 */
export function workflowScriptRootsFromSettings(
  settings: Pick<ServerSettings, "providerInstances" | "providers"> | undefined,
): ReadonlyArray<string> {
  const roots = [...defaultWorkflowScriptRoots()];
  const pushHome = (homePath: unknown) => {
    const trimmed = typeof homePath === "string" ? homePath.trim() : "";
    if (trimmed.length === 0) {
      return;
    }
    roots.push(NodePath.join(NodePath.resolve(expandHomePath(trimmed)), ".claude", "projects"));
  };
  // Legacy single-instance config — still the source of truth for
  // unmigrated deployments (see ProviderInstanceRegistryHydration). Roots
  // are a read-only containment allowlist, so including the legacy home
  // unconditionally also keeps pre-migration scripts readable.
  pushHome(settings?.providers?.claudeAgent?.homePath);
  for (const instance of Object.values(settings?.providerInstances ?? {})) {
    if (instance.driver !== "claudeAgent") {
      continue;
    }
    pushHome((instance.config as { homePath?: unknown } | undefined)?.homePath);
  }
  return [...new Set(roots)];
}

export const readWorkflowScript = Effect.fn("orchestration.readWorkflowScript")(function* (input: {
  readonly scriptPath: string;
  /** Candidate containment roots; defaults to the OS home's .claude/projects. */
  readonly roots?: ReadonlyArray<string>;
}) {
  const requested = input.scriptPath;

  if (!NodePath.isAbsolute(requested) || NodePath.extname(requested) !== ".js") {
    return yield* Effect.fail(
      new OrchestrationGetWorkflowScriptError({ reason: "invalid-path", scriptPath: requested }),
    );
  }

  // Realpath every candidate root; roots that don't exist are skipped, but
  // if none resolve the read fails closed.
  const candidateRoots = input.roots ?? defaultWorkflowScriptRoots();
  const resolvedRoots: string[] = [];
  for (const root of candidateRoots) {
    const resolved = yield* Effect.tryPromise({
      try: () => NodeFSP.realpath(root),
      catch: () => undefined,
    }).pipe(Effect.catch(() => Effect.succeed(undefined)));
    if (typeof resolved === "string") {
      resolvedRoots.push(resolved);
    }
  }
  if (resolvedRoots.length === 0) {
    return yield* Effect.fail(
      new OrchestrationGetWorkflowScriptError({
        reason: "root-unavailable",
        scriptPath: requested,
      }),
    );
  }

  // Realpath the FILE itself (not just its directory): a symlink named
  // like a script inside a contained directory must not escape.
  // Failures echo only the client-supplied path — the resolved path and the
  // raw fs cause stay in server logs (clients could otherwise probe the
  // filesystem layout through error payloads).
  const resolved = yield* Effect.tryPromise(() => NodeFSP.realpath(requested)).pipe(
    Effect.catch((error) =>
      Effect.logInfo("workflow script realpath failed", { requested, cause: error.cause }).pipe(
        Effect.andThen(
          Effect.fail(
            new OrchestrationGetWorkflowScriptError({ reason: "not-found", scriptPath: requested }),
          ),
        ),
      ),
    ),
  );

  const contained = resolvedRoots.some(
    (root) => resolved === root || resolved.startsWith(`${root}${NodePath.sep}`),
  );
  if (!contained) {
    yield* Effect.logWarning("workflow script escaped containment", { requested, resolved });
    return yield* Effect.fail(
      new OrchestrationGetWorkflowScriptError({ reason: "outside-root", scriptPath: requested }),
    );
  }
  if (NodePath.extname(resolved) !== ".js") {
    return yield* Effect.fail(
      new OrchestrationGetWorkflowScriptError({ reason: "not-js", scriptPath: requested }),
    );
  }

  // TOCTOU-safe read: open FIRST, then verify what was actually opened via
  // the file descriptor. Re-checking the path after open would race against
  // a swap; fstat on the handle cannot. The two containment checks fail with
  // their own tagged reasons (not manufactured Errors folded into
  // read-failed); "read-failed" is reserved for genuine platform failures
  // with the real cause attached.
  const read = yield* Effect.tryPromise(async () => {
    // Non-blocking, so a FIFO here fails the regular-file check instead of
    // waiting for a writer.
    const opened = await openRegularFile(resolved, { followSymlinks: true }).catch(
      (cause: unknown) => {
        if (cause instanceof NotRegularFileError) return null;
        throw cause;
      },
    );
    if (opened === null) {
      return { failure: "not-regular-file" as const };
    }
    const { handle, stat } = opened;
    try {
      // The opened inode must be the same one realpath resolved to: a
      // process swapping the path between realpath and open changes the
      // inode, which this comparison catches.
      const pathStat = await NodeFSP.lstat(resolved);
      if (stat.ino !== pathStat.ino || stat.dev !== pathStat.dev) {
        return { failure: "changed-during-read" as const };
      }
      const truncated = stat.size > SCRIPT_BYTE_CAP;
      const buffer = Buffer.alloc(Math.min(stat.size, SCRIPT_BYTE_CAP));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      return {
        contents: buffer.subarray(0, bytesRead).toString("utf8"),
        truncated,
      };
    } finally {
      await handle.close();
    }
  }).pipe(
    Effect.catch((error) =>
      Effect.logWarning("workflow script read failed", {
        requested,
        resolved,
        cause: error.cause,
      }).pipe(
        Effect.andThen(
          Effect.fail(
            new OrchestrationGetWorkflowScriptError({
              reason: "read-failed",
              scriptPath: requested,
            }),
          ),
        ),
      ),
    ),
  );
  if ("failure" in read) {
    return yield* new OrchestrationGetWorkflowScriptError({
      reason: read.failure,
      scriptPath: requested,
    });
  }

  return {
    // Echo the client's path, not the realpath: symlinked homes would
    // otherwise reveal the server's actual filesystem layout.
    scriptPath: requested,
    contents: read.contents,
    truncated: read.truncated,
  };
});
