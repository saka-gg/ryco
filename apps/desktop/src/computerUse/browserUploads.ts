// Staging rules adapted from Synara (MIT) commit 8f6521a67 workspaceUpload.ts; see docs/licenses/synara-computer-use.txt.
import type { Stats } from "node:fs";
import { chmod, lstat, mkdir, readdir, realpath, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { ComputerUseRequest } from "@ryco/contracts";
import {
  BROWSER_UPLOAD_MAX_FILES,
  BROWSER_UPLOAD_MAX_PATH_LENGTH,
  isBrowserUploadId,
} from "@ryco/shared/browserUpload";
import type { BrowserUploads, ResolvedBrowserUpload } from "./browser.ts";

export const BROWSER_UPLOAD_DIR_NAME = "computer-use-browser-uploads";
/** Synara workspaceUpload.ts DEFAULT_MAX_STAGED_UPLOAD_BYTES_PER_WEB_CONTENTS. */
export const MAX_RETAINED_UPLOAD_BYTES_PER_TAB = 512 * 1024 * 1024;
/** Synara DEFAULT_MAX_STAGED_UPLOAD_DIRECTORIES_PER_WEB_CONTENTS. */
export const MAX_RETAINED_UPLOADS_PER_TAB = 64;
/** Synara DEFAULT_MAX_STAGED_UPLOAD_FILES_PER_WEB_CONTENTS. */
export const MAX_RETAINED_UPLOAD_FILES_PER_TAB = 512;
/** Ryco's own bound: 24 tabs at the per-tab limit would hold 12 GiB. */
export const MAX_RETAINED_UPLOAD_BYTES_TOTAL = 2 * 1024 * 1024 * 1024;
/** Longer than the desktop's 60 s request limit plus time in its queue. */
export const ORPHAN_UPLOAD_AGE_MS = 5 * 60_000;
export const ORPHAN_SWEEP_INTERVAL_MS = 5 * 60_000;
/** Staging is the server's: the agent's way to stage the files again is another upload call. */
export const BROWSER_UPLOAD_REFUSED = "Upload refused. Call upload again.";
export const BROWSER_UPLOAD_QUOTA =
  "Too many uploaded files are held by open pages. Close or navigate a tab first.";
const SWEEP_BATCH = 256;
const STALE_MARKER = ".stale-";

class QuotaExceeded extends Error {}

const ownedByUser = (info: Stats): boolean =>
  process.getuid === undefined || info.uid === process.getuid();

async function verifyPrivateDirectory(directory: string): Promise<void> {
  const info = await lstat(directory);
  if (
    info.isSymbolicLink() ||
    !info.isDirectory() ||
    !ownedByUser(info) ||
    (process.platform !== "win32" && (info.mode & 0o077) !== 0)
  )
    throw new Error("The browser upload directory is not private.");
}

const removeTreeDefault = (path: string): Promise<void> =>
  rm(path, { recursive: true, force: true });

export interface BrowserUploadStoreOptions {
  /** Removes a directory tree (tests replace it). */
  readonly removeTree?: (path: string) => Promise<void>;
  /** Wall clock for the orphan age, in ms (compared with directory mtimes). */
  readonly now?: () => number;
}

/**
 * The desktop's private directory for browser uploads. The backend stages copies of workspace files
 * into `<root>/<uploadId>/<index>/<name>`; once a request carrying them reaches the desktop, the
 * desktop owns them: a page keeps them until its main frame navigates or the tab goes away,
 * `settle` removes the ones nothing kept when the request ends, and `sweep` removes orphans whose
 * request never arrived.
 */
export class BrowserUploadStore implements BrowserUploads {
  readonly root: string;
  private readonly removeTree: (path: string) => Promise<void>;
  private readonly now: () => number;
  /** Uploads pages hold, by directory. */
  private readonly retained = new Map<string, { tab: string; bytes: number; count: number }>();
  /** Uploads a request is using right now; `released` when their tab's page went away meanwhile. */
  private readonly inflight = new Map<string, { tab: string; released: boolean }>();
  private sweeping: Promise<void> | null = null;
  private timer: ReturnType<typeof setInterval> | undefined;

  private constructor(
    root: string,
    removeTree: (path: string) => Promise<void>,
    now: () => number,
  ) {
    this.root = root;
    this.removeTree = removeTree;
    this.now = now;
  }

  /**
   * Fast whatever an earlier run left: an existing directory is renamed aside (O(1)) and removed in
   * the background with every older `.stale-*` sibling, so leftover gigabytes never delay the
   * backend's start. The new directory is private (0700, owned by this user, not a link).
   */
  static async create(
    stateDir: string,
    options: BrowserUploadStoreOptions = {},
  ): Promise<BrowserUploadStore> {
    const removeTree = options.removeTree ?? removeTreeDefault;
    const base = join(stateDir, BROWSER_UPLOAD_DIR_NAME);
    await mkdir(stateDir, { recursive: true });
    try {
      await rename(base, `${base}${STALE_MARKER}${process.pid}-${Date.now()}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await mkdir(base, { mode: 0o700 });
    await chmod(base, 0o700);
    await verifyPrivateDirectory(base);
    const store = new BrowserUploadStore(await realpath(base), removeTree, options.now ?? Date.now);
    void removeStale(stateDir, removeTree);
    store.timer = setInterval(() => void store.sweep(), ORPHAN_SWEEP_INTERVAL_MS);
    store.timer.unref?.();
    return store;
  }

  /**
   * Validates a server-staged upload for `tab` before Chromium sees any path: every file must be a
   * regular, unlinked file of this user directly in `<root>/<uploadId>/<index>/`, and the pages'
   * quotas must hold. A refusal removes the upload's directory.
   */
  async resolve(tab: string, uploadId: unknown, files: unknown): Promise<ResolvedBrowserUpload> {
    if (!isBrowserUploadId(uploadId)) throw new Error(BROWSER_UPLOAD_REFUSED);
    const dir = join(this.root, uploadId);
    // A repeated id: the copies belong to the request or page that has them.
    if (this.retained.has(dir) || this.inflight.has(dir)) throw new Error(BROWSER_UPLOAD_REFUSED);
    this.inflight.set(dir, { tab, released: false });
    try {
      await this.sweep();
      if ((await realpath(dir)) !== dir) throw new Error(BROWSER_UPLOAD_REFUSED);
      const directory = await lstat(dir);
      if (!directory.isDirectory() || !ownedByUser(directory))
        throw new Error(BROWSER_UPLOAD_REFUSED);
      if (!Array.isArray(files) || files.length < 1 || files.length > BROWSER_UPLOAD_MAX_FILES)
        throw new Error(BROWSER_UPLOAD_REFUSED);
      const paths: string[] = [];
      const names: string[] = [];
      let bytes = 0;
      for (const [index, file] of files.entries()) {
        if (
          typeof file !== "string" ||
          file.length > BROWSER_UPLOAD_MAX_PATH_LENGTH ||
          dirname(file) !== join(dir, String(index)) ||
          (await realpath(file)) !== file
        )
          throw new Error(BROWSER_UPLOAD_REFUSED);
        const info = await lstat(file);
        if (!info.isFile() || info.nlink !== 1 || !ownedByUser(info))
          throw new Error(BROWSER_UPLOAD_REFUSED);
        bytes += info.size;
        paths.push(file);
        names.push(basename(file));
      }
      let tabBytes = 0;
      let tabUploads = 0;
      let tabFiles = 0;
      let totalBytes = 0;
      for (const entry of this.retained.values()) {
        totalBytes += entry.bytes;
        if (entry.tab !== tab) continue;
        tabBytes += entry.bytes;
        tabUploads += 1;
        tabFiles += entry.count;
      }
      if (
        tabBytes + bytes > MAX_RETAINED_UPLOAD_BYTES_PER_TAB ||
        tabUploads + 1 > MAX_RETAINED_UPLOADS_PER_TAB ||
        tabFiles + paths.length > MAX_RETAINED_UPLOAD_FILES_PER_TAB ||
        totalBytes + bytes > MAX_RETAINED_UPLOAD_BYTES_TOTAL
      )
        throw new QuotaExceeded();
      return { tab, dir, files: paths, names, bytes };
    } catch (error) {
      await this.discard(dir);
      // Only the fixed message reaches the agent; the cause (paths, errno) stays on the desktop.
      throw new Error(
        error instanceof QuotaExceeded ? BROWSER_UPLOAD_QUOTA : BROWSER_UPLOAD_REFUSED,
        { cause: error },
      );
    }
  }

  /**
   * The page has the files (or may have them: a CDP call that failed can still have run). Kept until
   * the tab's main frame navigates or the tab goes away; removed at once when that already happened
   * while the upload ran.
   */
  retain(upload: ResolvedBrowserUpload): void {
    if (this.retained.has(upload.dir)) return;
    const flight = this.inflight.get(upload.dir);
    this.inflight.delete(upload.dir);
    if (!flight || flight.released || flight.tab !== upload.tab) {
      void this.remove(upload.dir);
      return;
    }
    this.retained.set(upload.dir, {
      tab: upload.tab,
      bytes: upload.bytes,
      count: upload.files.length,
    });
  }

  /** Removes an upload no page kept. Never touches a retained one or anything outside the root. */
  async discard(dir: string): Promise<void> {
    this.inflight.delete(dir);
    if (this.retained.has(dir) || dirname(dir) !== this.root || !isBrowserUploadId(basename(dir)))
      return;
    await this.remove(dir);
  }

  /** After every browser request that carried an uploadId: its copies go unless a page kept them. */
  async settle(uploadId: unknown): Promise<void> {
    if (!isBrowserUploadId(uploadId)) return;
    await this.discard(join(this.root, uploadId)).catch(() => undefined);
  }

  /** The tab's page navigated or went away: the files it held are gone for it. */
  async releaseTab(tab: string): Promise<void> {
    for (const flight of this.inflight.values()) if (flight.tab === tab) flight.released = true;
    const dirs = [...this.retained].flatMap(([dir, entry]) => (entry.tab === tab ? [dir] : []));
    for (const dir of dirs) this.retained.delete(dir);
    await Promise.all(dirs.map((dir) => this.remove(dir)));
  }

  /** Removes what no page or request holds and is older than 5 min; at most 256 entries per pass. */
  sweep(now = this.now()): Promise<void> {
    this.sweeping ??= this.sweepOnce(now).finally(() => {
      this.sweeping = null;
    });
    return this.sweeping;
  }

  /** Stops the periodic sweep (runtime dispose). */
  dispose(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }

  private held(dir: string): boolean {
    return this.retained.has(dir) || this.inflight.has(dir);
  }

  private async sweepOnce(now: number): Promise<void> {
    let entries: string[];
    try {
      entries = await readdir(this.root);
    } catch {
      return;
    }
    let checked = 0;
    for (const entry of entries) {
      if (checked >= SWEEP_BATCH) break;
      const dir = join(this.root, entry);
      if (this.held(dir)) continue;
      checked += 1;
      try {
        if (now - (await lstat(dir)).mtimeMs < ORPHAN_UPLOAD_AGE_MS) continue;
      } catch {
        continue;
      }
      if (!this.held(dir)) await this.remove(dir);
    }
  }

  private async remove(dir: string): Promise<void> {
    await this.removeTree(dir).catch(() => undefined);
  }
}

/** Leftovers of earlier runs (renamed aside at start, or a run that crashed before removing them). */
async function removeStale(
  stateDir: string,
  removeTree: (path: string) => Promise<void>,
): Promise<void> {
  try {
    const prefix = `${BROWSER_UPLOAD_DIR_NAME}${STALE_MARKER}`;
    const stale = (await readdir(stateDir)).filter((entry) => entry.startsWith(prefix));
    await Promise.allSettled(stale.map((entry) => removeTree(join(stateDir, entry))));
  } catch {
    // The next start tries again.
  }
}

/**
 * After a desktop request ends (answered, refused or failed): a browser upload's copies go unless a
 * page kept them. The driver's work on them has settled by then.
 */
export function settleBrowserUpload(
  request: Pick<ComputerUseRequest, "tool" | "args">,
  uploads: Pick<BrowserUploadStore, "settle"> | null,
): void {
  if (request.tool !== "browser" || request.args.uploadId === undefined) return;
  void uploads?.settle(request.args.uploadId);
}
