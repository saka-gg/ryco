// Staging rules adapted from Synara (MIT) commit 8f6521a67 workspaceUpload.ts; see docs/licenses/synara-computer-use.txt.
import * as fs from "node:fs/promises";
import path from "node:path";

import {
  BROWSER_UPLOAD_MAX_FILES,
  BROWSER_UPLOAD_MAX_PATH_LENGTH,
  newBrowserUploadId,
} from "@ryco/shared/browserUpload";
import { Data } from "effect";

import {
  isInside,
  stageWorkspaceFile,
  WorkspaceFileSizeError,
} from "../../assistantAttachments.ts";

/** Bytes per upload (Synara `workspaceUpload.ts` DEFAULT_MAX_UPLOAD_INVOCATION_BYTES). */
export const BROWSER_UPLOAD_MAX_BYTES = 256 * 1024 * 1024;
/**
 * Bytes staged by one backend whose desktop request has not returned yet. The server copies files
 * before the desktop's consent, hold and queue checks, so without this bound 64 queued requests
 * could hold 16 GiB of copies.
 */
export const BROWSER_UPLOAD_MAX_OUTSTANDING_BYTES = 512 * 1024 * 1024;

/** The one refusal the model sees for its files: never filesystem errors or absolute paths. */
export const BROWSER_UPLOAD_REFUSED = `Upload refused: use 1-32 existing, non-empty regular files inside this thread's workspace (relative paths, no links or "..", at most 256 MiB in total).`;
/** The files are fine, but other uploads hold the bytes they need. */
export const BROWSER_UPLOAD_BUSY = "Another upload is still in progress. Try again shortly.";

export class BrowserUploadRefused extends Data.TaggedError("BrowserUploadRefused")<{
  readonly reason: string;
}> {}

export interface StagedBrowserUpload {
  /** The staging directory's name under the desktop's upload directory (`isBrowserUploadId`). */
  readonly uploadId: string;
  /** In request order; each `path` is `<uploadDir>/<uploadId>/<index>/<the workspace file's name>`. */
  readonly files: ReadonlyArray<{
    readonly path: string;
    readonly name: string;
    readonly sizeBytes: number;
  }>;
  readonly bytes: number;
}

const refused = () => new BrowserUploadRefused({ reason: BROWSER_UPLOAD_REFUSED });
const busy = () => new BrowserUploadRefused({ reason: BROWSER_UPLOAD_BUSY });

function uploadPaths(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > BROWSER_UPLOAD_MAX_FILES ||
    value.some(
      (entry) =>
        typeof entry !== "string" ||
        entry.length < 1 ||
        entry.length > BROWSER_UPLOAD_MAX_PATH_LENGTH,
    ) ||
    new Set(value).size !== value.length
  )
    throw refused();
  return value as string[];
}

/**
 * The desktop's upload directory: canonical, a real directory owned by this user and closed to
 * everyone else (the desktop sets its mode; this only checks it).
 */
async function privateUploadRoot(uploadDir: string): Promise<string> {
  const root = await fs.realpath(uploadDir);
  if (root !== path.resolve(uploadDir)) throw refused();
  const info = await fs.lstat(root);
  if (
    info.isSymbolicLink() ||
    !info.isDirectory() ||
    (process.getuid !== undefined && info.uid !== process.getuid()) ||
    (process.platform !== "win32" && (info.mode & 0o077) !== 0)
  )
    throw refused();
  return root;
}

/**
 * Copies workspace files of `cwd` for one `ryco_browser` upload into a fresh private directory of
 * the desktop's `uploadDir`, with `stageWorkspaceFile`'s rules (relative paths without links,
 * parent traversal or hard links; regular, non-empty files that do not change while read). Chromium
 * only ever reads these copies, so a workspace file swapped for a link after the check cannot
 * redirect it. On any refusal nothing stays on disk.
 */
export async function stageBrowserUpload(input: {
  readonly uploadDir: string;
  readonly cwd: string;
  readonly paths: unknown;
  readonly signal?: AbortSignal;
  /** What this upload may stage now (the budget's grant); defaults to `limitBytes`. */
  readonly maxBytes?: number;
  /**
   * The most any upload may stage (the budget's ceiling, at most BROWSER_UPLOAD_MAX_BYTES). Files
   * over `maxBytes` but within it are refused as busy: they fit once other uploads finish.
   */
  readonly limitBytes?: number;
}): Promise<StagedBrowserUpload> {
  const paths = uploadPaths(input.paths);
  const limitBytes = Math.min(
    input.limitBytes ?? BROWSER_UPLOAD_MAX_BYTES,
    BROWSER_UPLOAD_MAX_BYTES,
  );
  const maxBytes = Math.max(0, Math.min(input.maxBytes ?? limitBytes, limitBytes));
  let directory: string | undefined;
  try {
    const uploadRoot = await privateUploadRoot(input.uploadDir);
    const root = await fs.realpath(input.cwd);
    // A workspace that contains the staging area (or lies in it) would let the agent write there.
    if (root === uploadRoot || isInside(root, uploadRoot) || isInside(uploadRoot, root))
      throw refused();
    // Fails rather than reuses a directory that exists; mkdir's mode is narrowed by the umask only.
    const created = path.join(uploadRoot, newBrowserUploadId());
    await fs.mkdir(created, { mode: 0o700 });
    directory = created;
    await fs.chmod(directory, 0o700);
    const files: Array<StagedBrowserUpload["files"][number]> = [];
    let used = 0;
    for (const [index, relativePath] of paths.entries()) {
      input.signal?.throwIfAborted();
      const staged = await stageWorkspaceFile({
        cwd: root,
        relativePath,
        stagingDir: directory,
        maxBytes: maxBytes - used,
        signal: input.signal,
      }).catch((error: unknown) => {
        // Within one upload's limit, only other uploads' reservations are in the way.
        if (
          error instanceof WorkspaceFileSizeError &&
          error.sizeBytes > 0 &&
          used + error.sizeBytes <= limitBytes
        )
          throw busy();
        throw error;
      });
      // One directory per file, so the page sees each workspace file's own name.
      const slot = path.join(directory, String(index));
      await fs.mkdir(slot, { mode: 0o700 });
      const destination = path.join(slot, staged.sourceBaseName);
      await fs.rename(staged.temporary, destination);
      used += staged.sizeBytes;
      files.push({ path: destination, name: staged.sourceBaseName, sizeBytes: staged.sizeBytes });
    }
    input.signal?.throwIfAborted();
    return { uploadId: path.basename(directory), files, bytes: used };
  } catch (error) {
    if (directory) await fs.rm(directory, { recursive: true, force: true }).catch(() => undefined);
    throw error instanceof BrowserUploadRefused ? error : refused();
  }
}

export interface BrowserUploadReservation {
  /** The most this upload may stage. */
  readonly maxBytes: number;
  /** The most any upload may stage while no other holds part of the budget. */
  readonly limitBytes: number;
  /** Keeps only what was actually staged reserved. */
  shrink(bytes: number): void;
  /** Ends the reservation (idempotent): the desktop owns the copies now, or the request failed. */
  release(): void;
}

/**
 * The backend's budget for staged-but-undelivered upload bytes. A reservation takes up to one
 * upload's maximum before staging starts, so concurrent uploads can never exceed the limit
 * together, and shrinks to the staged size once the copies exist.
 */
export function makeUploadBudget(limit = BROWSER_UPLOAD_MAX_OUTSTANDING_BYTES) {
  const limitBytes = Math.min(BROWSER_UPLOAD_MAX_BYTES, limit);
  let outstanding = 0;
  return {
    outstanding: (): number => outstanding,
    /** Undefined when nothing is left: refuse without touching the disk. */
    reserve(): BrowserUploadReservation | undefined {
      const maxBytes = Math.min(limitBytes, limit - outstanding);
      if (maxBytes <= 0) return undefined;
      outstanding += maxBytes;
      let held = maxBytes;
      return {
        maxBytes,
        limitBytes,
        shrink(bytes) {
          const next = Math.max(0, Math.min(held, bytes));
          outstanding -= held - next;
          held = next;
        },
        release() {
          outstanding -= held;
          held = 0;
        },
      };
    },
  };
}
export type BrowserUploadBudget = ReturnType<typeof makeUploadBudget>;
