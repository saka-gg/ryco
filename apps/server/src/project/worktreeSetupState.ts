import { constants } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, unlink } from "node:fs/promises";
import path from "node:path";
import { Effect, Exit } from "effect";
import { GitCommandError } from "@ryco/contracts";
import { canonicalizeWorktreePath } from "./worktreeRoot.ts";

/** Node-owned creation journal, separate from repository files and project provenance.
 * Reserve before Git creates a checkout; successful setup, explicit removal or proven
 * absence from both disk and the bound repository clears it.
 * Absence preserves legacy/adopted checkouts. Never initialize an existing checkout here.
 */
const markerPath = (stateDir: string, checkoutPath: string) =>
  path.join(
    stateDir,
    "incomplete-worktree-setup",
    `${createHash("sha256").update(checkoutPath).digest("hex")}.json`,
  );

const setupEffect = <A>(checkoutPath: string, action: () => Promise<A>) =>
  Effect.tryPromise({
    try: action,
    catch: (cause) =>
      new GitCommandError({
        operation: "GitVcsDriver.worktreeSetup",
        cwd: checkoutPath,
        command: "worktree setup",
        detail: cause instanceof Error ? cause.message : "Cannot inspect worktree setup state.",
        cause,
      }),
  });

// Bounded descriptor reads for node-owned journal and ownership records. A replaced,
// non-regular or unreadable record is uncertainty, never evidence of a dead owner.
const readSetupFile = async (filePath: string) => {
  const entry = await lstat(filePath).catch((cause: NodeJS.ErrnoException) => {
    if (cause.code === "ENOENT") return null;
    throw cause;
  });
  if (!entry) return null;
  if (!entry.isFile() || entry.isSymbolicLink())
    throw new Error(
      "Cannot safely inspect the incomplete worktree setup journal: expected a regular file.",
    );
  const file = await open(
    filePath,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  ).catch((cause: NodeJS.ErrnoException) => {
    if (cause.code === "ENOENT") return null;
    throw cause;
  });
  if (!file) return null;
  try {
    const stat = await file.stat();
    if (stat.dev !== entry.dev || stat.ino !== entry.ino)
      throw new Error(
        "Incomplete worktree setup journal changed during inspection. Retry the operation.",
      );
    if (!stat.isFile() || stat.size > 16 * 1024)
      throw new Error("Cannot safely inspect the incomplete worktree setup journal.");
    const buffer = Buffer.alloc(16 * 1024 + 1);
    let size = 0;
    while (size < buffer.length) {
      const read = await file.read(buffer, size, buffer.length - size, null);
      if (read.bytesRead === 0) break;
      size += read.bytesRead;
    }
    if (size > 16 * 1024)
      throw new Error("Cannot safely inspect the incomplete worktree setup journal.");
    let value: unknown;
    try {
      value = JSON.parse(buffer.subarray(0, size).toString("utf8"));
    } catch {
      throw new Error("Cannot safely parse the incomplete worktree setup journal.");
    }
    return { value, stat };
  } finally {
    await file.close();
  }
};

const ownershipMessage =
  "Worktree setup is owned by another active or unverified creator. Retry after it completes. A crash during Git mutation or interrupted setup requires operator inspection of the creator and its children before clearing node-owned setup state.";

const ownershipError = (cause?: unknown) => new Error(ownershipMessage, { cause });

type SetupOwner = {
  readonly version: 1;
  readonly pid: number;
  readonly token: string;
  readonly phase: "reserved" | "mutating";
};

/** Exclusive admission across cores and processes sharing node state. No timeout is
 * proof of death. Reused PIDs and failed probes block recovery. Persist mutation
 * before any child can start: after a crash, a dead parent alone cannot prove that
 * an orphan Git child is gone. Such owners require operator inspection.
 */
export const withWorktreeSetupOwnership = <A, E, R>(
  stateDir: string,
  checkoutPath: string,
  use: (
    mutation: Effect.Effect<void, GitCommandError>,
    ownerToken: string,
  ) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E | GitCommandError, R> => {
  const ownerPath = `${markerPath(stateDir, checkoutPath)}.owner`;
  const acquire = setupEffect(checkoutPath, async () => {
    await mkdir(path.dirname(ownerPath), { recursive: true, mode: 0o700 });
    const claim = () => open(ownerPath, "wx", 0o600);
    let file: Awaited<ReturnType<typeof claim>> | undefined;
    try {
      file = await claim();
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
      // Elect one reclaimer. Never reclaim this short-lived election by timeout
      // or PID: a crashed reclaimer is uncertain and needs operator inspection.
      const electionPath = `${ownerPath}.reclaim`;
      const election = await open(electionPath, "wx", 0o600).catch((error) => {
        throw ownershipError(error);
      });
      const cleanupElection = async () => {
        try {
          await election.close();
          await unlink(electionPath);
        } catch (error) {
          await file?.close().catch(() => undefined);
          throw error;
        }
      };
      try {
        const record = await readSetupFile(ownerPath).catch((error) => {
          throw ownershipError(error);
        });
        if (record) {
          const value = record.value;
          if (
            !value ||
            typeof value !== "object" ||
            !("version" in value) ||
            value.version !== 1 ||
            !("pid" in value) ||
            typeof value.pid !== "number" ||
            !Number.isSafeInteger(value.pid) ||
            value.pid <= 0 ||
            !("token" in value) ||
            typeof value.token !== "string" ||
            value.token.length === 0 ||
            !("phase" in value) ||
            value.phase !== "reserved"
          )
            throw ownershipError(cause);
          let absent = false;
          try {
            process.kill(value.pid, 0);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw ownershipError(error);
            absent = true;
          }
          if (!absent) throw ownershipError(cause);
          const current = await lstat(ownerPath);
          if (current.dev !== record.stat.dev || current.ino !== record.stat.ino)
            throw ownershipError(cause);
          await unlink(ownerPath);
        }
        // Claim while still elected: concurrent claimers can win, but no second
        // reclaimer can inspect an obsolete owner and unlink a newly live guard.
        file = await claim().catch((error) => {
          throw ownershipError(error);
        });
      } finally {
        await cleanupElection();
      }
    }
    if (!file) throw ownershipError();
    const owner: SetupOwner = {
      version: 1,
      pid: process.pid,
      token: randomUUID(),
      phase: "reserved",
    };
    try {
      await file.writeFile(JSON.stringify(owner));
      await file.sync();
      const journal = await readSetupFile(markerPath(stateDir, checkoutPath));
      if (
        journal &&
        (!journal.value ||
          typeof journal.value !== "object" ||
          !("version" in journal.value) ||
          journal.value.version !== 2)
      )
        throw ownershipError();
      return { file, owner, mutating: false };
    } catch (error) {
      await file.close();
      await unlink(ownerPath);
      throw error;
    }
  });
  return Effect.acquireUseRelease(
    acquire,
    (claim) => {
      const mutation = setupEffect(checkoutPath, async () => {
        // Partial writes are fail-closed; mutation never starts before this sync.
        await claim.file.truncate(0);
        await claim.file.write(JSON.stringify({ ...claim.owner, phase: "mutating" }), 0, "utf8");
        await claim.file.sync();
        claim.mutating = true;
      }).pipe(Effect.uninterruptible);
      return use(mutation, claim.owner.token);
    },
    (claim, exit) =>
      setupEffect(checkoutPath, async () => {
        try {
          // Cancellation or defects can leave filesystem promises running. Preserve
          // uncertainty; normal typed failures have completed their scoped children.
          if (claim.mutating && (Exit.hasInterrupts(exit) || Exit.hasDies(exit))) return;
          const current = await lstat(ownerPath);
          const own = await claim.file.stat();
          if (current.dev !== own.dev || current.ino !== own.ino) throw ownershipError();
          await unlink(ownerPath);
        } finally {
          await claim.file.close();
        }
      }).pipe(Effect.orDie),
  );
};

export const incompleteWorktreeSetupMessage = (checkoutPath: string) =>
  `Worktree '${checkoutPath}' has incomplete setup from a previous creation attempt. Provider startup and reuse are refused. Fix ryco.json or submodule access, then explicitly remove this checkout through source control and recreate it using its existing branch. Removal must preserve any work you need.`;

export const assertWorktreeSetupComplete = (
  stateDir: string,
  checkoutPath: string,
  ownToken?: string,
) =>
  setupEffect(checkoutPath, async () => {
    const marker = markerPath(stateDir, await canonicalizeWorktreePath(checkoutPath));
    const entry = await lstat(marker).catch((cause: NodeJS.ErrnoException) => {
      if (cause.code === "ENOENT") return null;
      throw cause;
    });
    if (entry !== null) throw new Error(incompleteWorktreeSetupMessage(checkoutPath));
    const owner = await readSetupFile(`${marker}.owner`).catch((cause) => {
      throw ownershipError(cause);
    });
    const isOwnGuard =
      ownToken !== undefined &&
      owner?.value &&
      typeof owner.value === "object" &&
      "token" in owner.value &&
      owner.value.token === ownToken;
    if (owner !== null && !isOwnGuard)
      throw new Error(incompleteWorktreeSetupMessage(checkoutPath));
  });

/** Both paths must be canonical; legacy journals without a repository binding fail closed. */
export const beginWorktreeSetup = (
  stateDir: string,
  checkoutPath: string,
  repositoryPath: string,
) =>
  setupEffect(checkoutPath, async () => {
    const marker = markerPath(stateDir, checkoutPath);
    await mkdir(path.dirname(marker), { recursive: true, mode: 0o700 });
    const file = await open(marker, "wx", 0o600).catch((cause: NodeJS.ErrnoException) => {
      if (cause.code === "EEXIST") throw new Error(incompleteWorktreeSetupMessage(checkoutPath));
      throw cause;
    });
    try {
      await file.writeFile(JSON.stringify({ version: 2, checkoutPath, repositoryPath }));
      await file.sync();
    } catch (cause) {
      // No Git mutation has started, and this attempt exclusively created the file.
      await unlink(marker).catch(() => undefined);
      throw cause;
    } finally {
      await file.close();
    }
  }).pipe(Effect.uninterruptible);

/** Pass the canonical path captured before removal; do not resolve a removed alias again. */
export const finishWorktreeSetup = (stateDir: string, canonicalPath: string) =>
  setupEffect(canonicalPath, () =>
    unlink(markerPath(stateDir, canonicalPath)).catch((cause: NodeJS.ErrnoException) => {
      if (cause.code !== "ENOENT") throw cause;
    }),
  );

/** Call under both the canonical destination lock and durable setup ownership. Reclaim only a bound creation journal
 * with neither a filesystem entry (including dangling links) nor Git registration.
 * No checkout, branch, registration or project provenance is deleted here.
 */
export const recoverOrphanedWorktreeSetup = (input: {
  readonly stateDir: string;
  readonly checkoutPath: string;
  readonly repositoryPath: Effect.Effect<string, GitCommandError>;
  readonly registeredWorktreePaths: Effect.Effect<ReadonlyArray<string>, GitCommandError>;
}) =>
  Effect.gen(function* () {
    const exists = () =>
      setupEffect(input.checkoutPath, async () => {
        return lstat(input.checkoutPath)
          .then(() => true)
          .catch((cause: NodeJS.ErrnoException) => {
            if (cause.code === "ENOENT") return false;
            throw cause;
          });
      });
    if (yield* exists()) return false;
    const journal = yield* setupEffect(input.checkoutPath, async () => {
      const marker = markerPath(input.stateDir, input.checkoutPath);
      const record = await readSetupFile(marker);
      if (!record) return null;
      const value = record.value;
      if (
        !value ||
        typeof value !== "object" ||
        !("version" in value) ||
        value.version !== 2 ||
        !("checkoutPath" in value) ||
        value.checkoutPath !== input.checkoutPath ||
        !("repositoryPath" in value) ||
        typeof value.repositoryPath !== "string"
      )
        throw new Error(
          "Cannot reclaim incomplete worktree setup: its repository binding or creator protocol is missing. Retry from the repository that created it; unbound legacy journals require operator inspection.",
        );
      return value.repositoryPath;
    });
    if (journal === null) return false;
    const repositoryPath = yield* input.repositoryPath;
    if (journal !== repositoryPath)
      return yield* setupEffect(input.checkoutPath, async () => {
        throw new Error(
          "Cannot reclaim incomplete worktree setup: its repository binding does not match. Retry from a checkout of the repository that created it.",
        );
      });
    const registered = yield* input.registeredWorktreePaths;
    if (registered.includes(input.checkoutPath)) return false;
    // Recheck after Git inspection: an external filesystem change cannot become
    // evidence for deleting setup state belonging to an existing checkout.
    if (yield* exists()) return false;
    yield* finishWorktreeSetup(input.stateDir, input.checkoutPath);
    return true;
  });
