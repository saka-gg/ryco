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
 * before the server graph loads. It also holds the boot guard's rollback bounds and the readiness
 * watchdog the guard arms for the server to disarm (one module instance serves both).
 *
 * @module nodeUpdate/updateProtocol
 */
import { writeSync } from "node:fs";

/** In the state directory. */
export const NODE_UPDATE_MARKER_FILE_NAME = "node-update.json";
/** In the state directory: the snapshot before a restart, the preflight copy, a failed database. */
export const NODE_UPDATE_DIRECTORY_NAME = "node-update";
/**
 * In the update directory: the releases the node's own unattended updates no longer try
 * (`nodeAutoSkip.ts`). The only file there an update keeps.
 */
export const NODE_UPDATE_AUTO_SKIP_FILE_NAME = "auto-skip.json";
/** Nobody waits for the answer to an older update, and nothing rolls it back. */
export const NODE_UPDATE_MARKER_MAX_AGE_MS = 24 * 60 * 60 * 1_000;
/** Starts of the target release that may end before it is ready; the next one rolls back. */
export const NODE_UPDATE_MAX_BOOT_ATTEMPTS = 2;
/** Further starts that retry a rollback whose reinstall failed, before the guard gives up. */
export const NODE_UPDATE_ROLLBACK_TRIES = 3;

/**
 * Whether the start after start number `bootAttempts` of an update's target still rolls back
 * (bootGuard.ts): only then may a start that is not getting ready end itself to get there.
 */
export const nodeUpdateNextStartRollsBack = (bootAttempts: number) =>
  bootAttempts + 1 <= NODE_UPDATE_MAX_BOOT_ATTEMPTS + NODE_UPDATE_ROLLBACK_TRIES;

/** How long a release an unattended update restarted into may take to get ready. */
export const UNATTENDED_BOOT_READY_TIMEOUT_MS = 10 * 60 * 1_000;
/** The exit code of a release that did not get ready in time after an unattended update. */
export const NODE_NOT_READY_EXIT_CODE = 1;

let bootWatchdog: ReturnType<typeof setTimeout> | undefined;

/**
 * Runs `onTimeout` {@link UNATTENDED_BOOT_READY_TIMEOUT_MS} from now unless
 * {@link disarmNodeBootWatchdog} comes first. The boot guard arms it when a start of a release an
 * unattended update restarted into begins, before migrations or a wait for the database, so a
 * start that hangs anywhere is ended too; the server disarms it once it is ready, or once it
 * finds this start is nothing to watch.
 */
export function armNodeBootWatchdog(onTimeout: () => void): void {
  disarmNodeBootWatchdog();
  bootWatchdog = setTimeout(onTimeout, UNATTENDED_BOOT_READY_TIMEOUT_MS);
  // Never what keeps a process alive that is ending anyway.
  bootWatchdog.unref?.();
}

export function disarmNodeBootWatchdog(): void {
  if (bootWatchdog !== undefined) clearTimeout(bootWatchdog);
  bootWatchdog = undefined;
}

export const isNodeBootWatchdogArmed = () => bootWatchdog !== undefined;
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
