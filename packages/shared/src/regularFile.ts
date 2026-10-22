import { constants, type BigIntStats, type Stats } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";

// Windows defines neither constant and has no FIFOs at file paths, so both
// collapse to 0 there.
const O_NONBLOCK = constants.O_NONBLOCK ?? 0;
const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0;

/**
 * Read flags for a file that must be a regular file at a link-free path.
 * O_NONBLOCK makes opening a FIFO return at once instead of waiting for a
 * writer: that wait cannot be cancelled and pins a libuv worker (or, through
 * openSync, the event loop) until something opens the other end. O_NOFOLLOW
 * refuses a final symbolic link. The descriptor must still be fstat-ed and
 * refused unless it is a regular file before anything reads from it.
 */
export const REGULAR_FILE_READ_FLAGS = constants.O_RDONLY | O_NOFOLLOW | O_NONBLOCK;

/** The path names a FIFO, socket, device, directory or refused link, not a regular file. */
export class NotRegularFileError extends Error {
  override readonly name = "NotRegularFileError";

  constructor(options?: ErrorOptions) {
    super("Only regular files can be opened.", options);
  }
}

export interface OpenedRegularFile<S extends Stats | BigIntStats> {
  readonly handle: FileHandle;
  /** The opened descriptor's fstat, taken before anything was read or written. */
  readonly stat: S;
}

export interface OpenRegularFileOptions {
  /**
   * Open for writing, creating the file when it is absent. An existing file is
   * not truncated: the caller does that once it holds a verified regular file.
   */
  readonly write?: boolean;
  /**
   * Follow a final symbolic link. Only for a path the caller has already
   * resolved and contained, whose existing link handling it keeps.
   */
  readonly followSymlinks?: boolean;
  readonly bigint?: boolean;
}

/**
 * Opens `path` without ever waiting on a special file and returns the
 * descriptor only when it is a regular file. A FIFO opened for reading returns
 * at once and fails the fstat check; opened for writing without a reader it
 * fails with ENXIO. Both, a refused final symbolic link and every other
 * non-regular file reject with NotRegularFileError. The caller closes the
 * returned handle.
 */
export function openRegularFile(
  path: string,
  options: OpenRegularFileOptions & { readonly bigint: true },
): Promise<OpenedRegularFile<BigIntStats>>;
export function openRegularFile(
  path: string,
  options?: OpenRegularFileOptions & { readonly bigint?: false },
): Promise<OpenedRegularFile<Stats>>;
export async function openRegularFile(
  path: string,
  options: OpenRegularFileOptions = {},
): Promise<OpenedRegularFile<Stats | BigIntStats>> {
  const noFollow = options.followSymlinks === true ? 0 : O_NOFOLLOW;
  const flags =
    (options.write === true ? constants.O_WRONLY | constants.O_CREAT : constants.O_RDONLY) |
    noFollow |
    O_NONBLOCK;
  let handle: FileHandle;
  try {
    handle = await open(path, flags);
  } catch (cause) {
    // open(2) reports ENXIO only for special files, such as a FIFO opened for
    // writing without a reader or a socket. Under O_NOFOLLOW, ELOOP means the
    // path ends in a symbolic link.
    const code = (cause as NodeJS.ErrnoException).code;
    if (code === "ENXIO" || (code === "ELOOP" && noFollow !== 0)) {
      throw new NotRegularFileError({ cause });
    }
    throw cause;
  }
  try {
    const stat =
      options.bigint === true ? await handle.stat({ bigint: true }) : await handle.stat();
    if (!stat.isFile()) throw new NotRegularFileError();
    return { handle, stat };
  } catch (cause) {
    await handle.close().catch(() => undefined);
    throw cause;
  }
}
