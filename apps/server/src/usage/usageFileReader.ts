// @effect-diagnostics nodeBuiltinImport:off
import { constants } from "node:fs";
import * as FS from "node:fs/promises";

export class UsageFileReadError extends Error {
  readonly code: "usage-path-rejected" | "usage-file-oversized" | "usage-file-changed";
  constructor(code: UsageFileReadError["code"]) {
    super(code);
    this.code = code;
  }
}

/** Regular files only, bounded allocation/read work, no following final links.
 * A changed file is not a trustworthy snapshot and contributes no new records. */
export async function readBoundedUsageFile(
  path: string,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();
  const before = await FS.lstat(path);
  if (!before.isFile() || before.isSymbolicLink())
    throw new UsageFileReadError("usage-path-rejected");
  if (before.size > maxBytes) throw new UsageFileReadError("usage-file-oversized");
  const file = await FS.open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const opened = await file.stat();
    if (
      !opened.isFile() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.size !== before.size ||
      opened.ctimeMs !== before.ctimeMs
    )
      throw new UsageFileReadError("usage-file-changed");
    const buffer = Buffer.alloc(before.size + 1);
    let offset = 0;
    while (offset < buffer.length) {
      signal?.throwIfAborted();
      const { bytesRead } = await file.read(
        buffer,
        offset,
        Math.min(64 * 1024, buffer.length - offset),
        offset,
      );
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const after = await file.stat(),
      current = await FS.lstat(path);
    if (
      offset !== before.size ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs ||
      current.dev !== before.dev ||
      current.ino !== before.ino ||
      current.isSymbolicLink()
    )
      throw new UsageFileReadError("usage-file-changed");
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, offset));
  } finally {
    await file.close();
  }
}
