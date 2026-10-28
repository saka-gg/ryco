import * as FS from "node:fs";
import * as Path from "node:path";

/**
 * Replace `filePath` with `contents` atomically (temp file + rename), owner-only by default.
 * A failed write leaves the previous file intact and no temp file behind.
 *
 * Synchronous on purpose: callers write small files from paths that cannot
 * await, such as a window's `close` handler.
 */
export function writeFileAtomicallySync(
  filePath: string,
  contents: string,
  options?: { readonly fileMode?: number; readonly directoryMode?: number },
): void {
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  FS.mkdirSync(Path.dirname(filePath), { recursive: true, mode: options?.directoryMode ?? 0o700 });
  try {
    FS.writeFileSync(temporary, contents, { encoding: "utf8", mode: options?.fileMode ?? 0o600 });
    FS.renameSync(temporary, filePath);
  } finally {
    FS.rmSync(temporary, { force: true });
  }
}
