/**
 * nodeUpdate/updateProtocol - What the two releases of a CLI node update rely on in each other:
 * where the marker lives, and the preflight handshake.
 *
 * The updating (old) process runs the candidate as `ryco node-update-preflight --database
 * <copy>` and reads the verdict from its stdout. The candidate announces itself before it loads
 * anything, so a crash while loading its graph still reads as a failed preflight. Output without
 * the announcement comes from a release that does not know the subcommand (one that predates
 * it, such as a downgrade target), and only then does the update fall back to `ryco --version`.
 * The handshake decides rather than the version number, so nightlies, local builds and release
 * numbers this build cannot order need no special case.
 *
 * Dependency-free apart from `node:fs`: the process entry (bin.ts) and the boot guard use it
 * before the server graph loads.
 *
 * @module nodeUpdate/updateProtocol
 */
import { writeSync } from "node:fs";

/** In the state directory. */
export const NODE_UPDATE_MARKER_FILE_NAME = "node-update.json";
/** In the state directory: the snapshot before a restart, the preflight copy, a failed database. */
export const NODE_UPDATE_DIRECTORY_NAME = "node-update";
/** Nobody waits for the answer to an older update, and nothing rolls it back. */
export const NODE_UPDATE_MARKER_MAX_AGE_MS = 24 * 60 * 60 * 1_000;
/** The contract's bound on `run.output`. */
export const NODE_UPDATE_OUTPUT_MAX_CHARS = 10_000;

export const NODE_UPDATE_PREFLIGHT_ARG = "node-update-preflight";
export const NODE_UPDATE_PREFLIGHT_DATABASE_FLAG = "--database";
/** The first stdout line of a release that knows the preflight. */
export const NODE_UPDATE_PREFLIGHT_STARTED = "ryco-node-update-preflight: started";
/** The last stdout line of a preflight that passed, followed by a space and the release. */
export const NODE_UPDATE_PREFLIGHT_PASSED = "ryco-node-update-preflight: passed";

/**
 * Written synchronously: a write to a pipe is asynchronous on macOS, and a native module that
 * crashes the process right after would lose it.
 */
export function announceNodeUpdatePreflight(): void {
  writeSync(1, `${NODE_UPDATE_PREFLIGHT_STARTED}\n`);
}
