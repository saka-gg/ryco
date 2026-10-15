import fs from "node:fs";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import zlib from "node:zlib";

/**
 * File the packaged desktop shell captures the backend's stdout/stderr into,
 * inside the backend's own `logs` directory.
 */
export const DESKTOP_BACKEND_LOG_FILE_NAME = "server-child.log";

/**
 * The desktop backend's own rotating log (logfmt), beside the shell's
 * stdout capture. Diagnostics tails this one.
 */
export const SERVER_LOG_FILE_NAME = "server.log";

export interface RotatingFileSinkOptions {
  readonly filePath: string;
  readonly maxBytes: number;
  readonly maxFiles: number;
  readonly throwOnError?: boolean;
}

export interface AsyncRotatingFileSinkOptions extends RotatingFileSinkOptions {
  /**
   * Gzip each rotated backup (`<file>.1` becomes `<file>.1.gz`) off the write
   * path. Leave off for files whose backups are read back as text.
   */
  readonly compressRotatedFiles?: boolean;
  /**
   * The deepest backup index an earlier configuration of this file may have
   * left behind (its old `maxFiles`). Backups up to here are removed when the
   * sink starts; the default probes only a few indices past `maxFiles`.
   */
  readonly pruneBackupsUpTo?: number;
}

export class RotatingFileSink {
  private readonly filePath: string;
  private readonly maxBytes: number;
  private readonly maxFiles: number;
  private readonly throwOnError: boolean;
  private currentSize = 0;

  constructor(options: RotatingFileSinkOptions) {
    if (options.maxBytes < 1) {
      throw new Error(`maxBytes must be >= 1 (received ${options.maxBytes})`);
    }
    if (options.maxFiles < 1) {
      throw new Error(`maxFiles must be >= 1 (received ${options.maxFiles})`);
    }

    this.filePath = options.filePath;
    this.maxBytes = options.maxBytes;
    this.maxFiles = options.maxFiles;
    this.throwOnError = options.throwOnError ?? false;

    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    this.pruneOverflowBackups();
    this.currentSize = this.readCurrentSize();
  }

  write(chunk: string | Buffer): void {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    if (buffer.length === 0) return;

    try {
      if (this.currentSize > 0 && this.currentSize + buffer.length > this.maxBytes) {
        this.rotate();
      }

      fs.appendFileSync(this.filePath, buffer);
      this.currentSize += buffer.length;

      if (this.currentSize > this.maxBytes) {
        this.rotate();
      }
    } catch {
      this.currentSize = this.readCurrentSize();
      if (this.throwOnError) {
        throw new Error(`Failed to write log chunk to ${this.filePath}`);
      }
    }
  }

  private rotate(): void {
    try {
      const oldest = this.withSuffix(this.maxFiles);
      if (fs.existsSync(oldest)) {
        fs.rmSync(oldest, { force: true });
      }

      for (let index = this.maxFiles - 1; index >= 1; index -= 1) {
        const source = this.withSuffix(index);
        const target = this.withSuffix(index + 1);
        if (fs.existsSync(source)) {
          fs.renameSync(source, target);
        }
      }

      if (fs.existsSync(this.filePath)) {
        fs.renameSync(this.filePath, this.withSuffix(1));
      }

      this.currentSize = 0;
    } catch {
      this.currentSize = this.readCurrentSize();
      if (this.throwOnError) {
        throw new Error(`Failed to rotate log file ${this.filePath}`);
      }
    }
  }

  private pruneOverflowBackups(): void {
    try {
      const dir = path.dirname(this.filePath);
      const baseName = path.basename(this.filePath);
      for (const entry of fs.readdirSync(dir)) {
        if (!entry.startsWith(`${baseName}.`)) continue;
        const suffix = Number(entry.slice(baseName.length + 1));
        if (!Number.isInteger(suffix) || suffix <= this.maxFiles) continue;
        fs.rmSync(path.join(dir, entry), { force: true });
      }
    } catch {
      if (this.throwOnError) {
        throw new Error(`Failed to prune log backups for ${this.filePath}`);
      }
    }
  }

  private readCurrentSize(): number {
    try {
      return fs.statSync(this.filePath).size;
    } catch {
      return 0;
    }
  }

  private withSuffix(index: number): string {
    return `${this.filePath}.${index}`;
  }
}

/**
 * Serialized, non-blocking counterpart used by runtime observability paths.
 *
 * Holds one append-mode file handle between writes (opened lazily, released on
 * rotation and by `close()`), writes each batch with a single `writev`, and
 * keeps initialization and rotation on the promise-based filesystem API so a
 * busy trace or provider stream cannot stall the server event loop. Owners
 * must call `close()` when they drop a sink so the handle is not left for the
 * garbage collector.
 */
export class AsyncRotatingFileSink {
  private readonly filePath: string;
  private readonly maxBytes: number;
  private readonly maxFiles: number;
  private readonly throwOnError: boolean;
  private readonly compressRotatedFiles: boolean;
  private readonly pruneBackupsUpTo: number;
  private currentSize = 0;
  private handle: FileHandle | undefined;
  private compression: Promise<void> | undefined;
  private writeTail: Promise<void>;

  constructor(options: AsyncRotatingFileSinkOptions) {
    if (options.maxBytes < 1) {
      throw new Error(`maxBytes must be >= 1 (received ${options.maxBytes})`);
    }
    if (options.maxFiles < 1) {
      throw new Error(`maxFiles must be >= 1 (received ${options.maxFiles})`);
    }

    this.filePath = options.filePath;
    this.maxBytes = options.maxBytes;
    this.maxFiles = options.maxFiles;
    this.throwOnError = options.throwOnError ?? false;
    this.compressRotatedFiles = options.compressRotatedFiles ?? false;
    this.pruneBackupsUpTo = Math.max(
      this.maxFiles + OVERFLOW_BACKUP_PROBE_COUNT,
      options.pruneBackupsUpTo ?? 0,
    );
    this.writeTail = this.initialize();
  }

  write(chunk: string | Buffer): Promise<void> {
    return this.writeBatch([chunk]).then(() => undefined);
  }

  /**
   * Appends `chunks` in order, one `writev` per file touched (a batch that
   * crosses `maxBytes` rotates between chunks). Resolves to the bytes written.
   */
  writeBatch(chunks: ReadonlyArray<string | Buffer>): Promise<number> {
    const buffers: Array<Buffer> = [];
    for (const chunk of chunks) {
      const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      if (buffer.length > 0) buffers.push(buffer);
    }
    if (buffers.length === 0) return this.writeTail.then(() => 0);

    const operation = this.writeTail.then(() => this.writeNow(buffers));
    // Keep later writes usable after an individual operation fails while still
    // returning that failure to the caller that owns retry policy.
    this.writeTail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  flush(): Promise<void> {
    return this.writeTail;
  }

  /**
   * Drains queued writes and any backup compression, then releases the file
   * handle. Never rejects; a later write simply reopens the file.
   */
  close(): Promise<void> {
    this.writeTail = this.writeTail
      .then(async () => {
        await this.compression;
        await this.closeHandle();
      })
      .catch(() => undefined);
    return this.writeTail;
  }

  private async initialize(): Promise<void> {
    try {
      await fs.promises.mkdir(path.dirname(this.filePath), { recursive: true });
      await this.pruneOverflowBackups();
      this.currentSize = await this.readCurrentSize();
    } catch {
      this.currentSize = 0;
      if (this.throwOnError) {
        throw new Error(`Failed to initialize log file ${this.filePath}`);
      }
    }
  }

  private async writeNow(buffers: ReadonlyArray<Buffer>): Promise<number> {
    let written = 0;
    try {
      let segment: Array<Buffer> = [];
      let segmentBytes = 0;
      for (const buffer of buffers) {
        const pending = this.currentSize + segmentBytes;
        if (pending > 0 && pending + buffer.length > this.maxBytes) {
          if (segment.length > 0) {
            await this.append(segment, segmentBytes);
            written += segmentBytes;
            segment = [];
            segmentBytes = 0;
          }
          await this.rotate();
        }
        segment.push(buffer);
        segmentBytes += buffer.length;
      }
      if (segment.length > 0) {
        await this.append(segment, segmentBytes);
        written += segmentBytes;
      }

      if (this.currentSize > this.maxBytes) {
        await this.rotate();
      }
      return written;
    } catch {
      await this.closeHandle();
      this.currentSize = await this.readCurrentSize();
      if (this.throwOnError) {
        throw new Error(`Failed to write log chunk to ${this.filePath}`);
      }
      return written;
    }
  }

  private async append(buffers: ReadonlyArray<Buffer>, bytes: number): Promise<void> {
    this.handle ??= await fs.promises.open(this.filePath, "a");
    const { bytesWritten } = await this.handle.writev(buffers);
    if (bytesWritten < bytes) {
      // libuv already retries short writes; this only guards exotic file systems.
      const rest = Buffer.concat(buffers).subarray(bytesWritten);
      let offset = 0;
      while (offset < rest.length) {
        const result = await this.handle.write(rest, offset);
        if (result.bytesWritten <= 0) {
          throw new Error(`Short write to ${this.filePath}`);
        }
        offset += result.bytesWritten;
      }
    }
    this.currentSize += bytes;
  }

  private async rotate(): Promise<void> {
    try {
      await this.closeHandle();
      // The previous backup may still be compressing; let it land before shifting.
      await this.compression;
      await this.removeBackup(this.maxFiles);

      for (let index = this.maxFiles - 1; index >= 1; index -= 1) {
        await renameIfPresent(this.withSuffix(index), this.withSuffix(index + 1));
        if (this.compressRotatedFiles) {
          await renameIfPresent(
            compressedPath(this.withSuffix(index)),
            compressedPath(this.withSuffix(index + 1)),
          );
        }
      }

      await renameIfPresent(this.filePath, this.withSuffix(1));
      this.currentSize = 0;
      if (this.compressRotatedFiles) {
        this.compression = compressBackup(this.withSuffix(1)).finally(() => {
          this.compression = undefined;
        });
      }
    } catch {
      this.currentSize = await this.readCurrentSize();
      if (this.throwOnError) {
        throw new Error(`Failed to rotate log file ${this.filePath}`);
      }
    }
  }

  /**
   * Removes backups a deeper rotation (an earlier, larger `maxFiles`) left
   * behind, up to `pruneBackupsUpTo`. Probing a bounded range of exact paths
   * keeps sink creation independent of how many files share the directory.
   */
  private async pruneOverflowBackups(): Promise<void> {
    try {
      for (let index = this.maxFiles + 1; index <= this.pruneBackupsUpTo; index += 1) {
        await this.removeBackup(index);
      }
    } catch {
      if (this.throwOnError) {
        throw new Error(`Failed to prune log backups for ${this.filePath}`);
      }
    }
  }

  private async removeBackup(index: number): Promise<void> {
    const backup = this.withSuffix(index);
    await fs.promises.rm(backup, { force: true });
    await fs.promises.rm(compressedPath(backup), { force: true });
  }

  private async closeHandle(): Promise<void> {
    const handle = this.handle;
    this.handle = undefined;
    if (handle) {
      await handle.close().catch(() => undefined);
    }
  }

  private async readCurrentSize(): Promise<number> {
    try {
      return (await fs.promises.stat(this.filePath)).size;
    } catch {
      return 0;
    }
  }

  private withSuffix(index: number): string {
    return `${this.filePath}.${index}`;
  }
}

/** Backups past `maxFiles` probed (and removed) when a sink starts. */
const OVERFLOW_BACKUP_PROBE_COUNT = 3;

function compressedPath(filePath: string): string {
  return `${filePath}.gz`;
}

/**
 * Gzips `source` to `source.gz` through zlib's threadpool and removes the
 * original. Never rejects: on failure the uncompressed backup stays and keeps
 * rotating and ageing out like any other.
 */
async function compressBackup(source: string): Promise<void> {
  const target = compressedPath(source);
  const temporary = `${target}.tmp`;
  try {
    await pipeline(fs.createReadStream(source), zlib.createGzip(), fs.createWriteStream(temporary));
    await fs.promises.rename(temporary, target);
    await fs.promises.rm(source, { force: true });
  } catch {
    await fs.promises.rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function renameIfPresent(source: string, target: string): Promise<void> {
  try {
    await fs.promises.rename(source, target);
  } catch (error) {
    if (!isMissingFileError(error)) throw error;
  }
}

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === "ENOENT"
  );
}
