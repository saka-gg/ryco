// @effect-diagnostics nodeBuiltinImport:off - Effect has no ZIP reader, positional reads, or inflate stream.
/**
 * Safe, file-backed extraction of an already verified ZIP archive.
 *
 * The archive is read from disk entry by entry: the central directory is
 * parsed once, then each member streams through inflate into its own file,
 * so a ~100 MB archive never sits in memory. Every name, type, size, and
 * checksum is treated as untrusted even after the download was verified.
 *
 * @module zipArchive
 */
import { createReadStream, createWriteStream } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import * as NodeFs from "node:fs/promises";
import * as NodePath from "node:path";
import { Transform, type TransformCallback } from "node:stream";
import { pipeline } from "node:stream/promises";
import * as NodeZlib from "node:zlib";

import { Effect, Schema } from "effect";

export class ZipArchiveError extends Schema.TaggedError<ZipArchiveError>()("ZipArchiveError", {
  /** "invalid": the archive itself is malformed or unsafe; "io": reading or writing files failed. */
  kind: Schema.Literals(["invalid", "io"]),
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return this.detail;
  }
}
const isZipArchiveError = Schema.is(ZipArchiveError);

export interface ZipEntry {
  /** The member's name as stored, `/`-separated; directories end with `/`. */
  readonly name: string;
  readonly isDirectory: boolean;
  /** Unix mode bits (type and permissions) recorded by the archiver; 0 when absent. */
  readonly unixMode: number;
  readonly compressionMethod: number;
  readonly encrypted: boolean;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly crc32: number;
  readonly localHeaderOffset: number;
}

const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const CENTRAL_DIRECTORY_ENTRY = 0x02014b50;
const LOCAL_FILE_HEADER = 0x04034b50;
const END_OF_CENTRAL_DIRECTORY_SIZE = 22;
// The end record sits within its own size plus the longest comment of the file's end.
const MAX_END_SEARCH = END_OF_CENTRAL_DIRECTORY_SIZE + 0xffff;
const MAX_CENTRAL_DIRECTORY_BYTES = 16 * 1024 * 1024;
const STORED = 0;
const DEFLATED = 8;
const UNIX_TYPE_MASK = 0o170000;
const UNIX_DIRECTORY = 0o040000;
const UNIX_REGULAR_FILE = 0o100000;
// Extracted files never keep group/other write, setuid, setgid, or sticky bits.
const EXTRACTED_MODE_MASK = 0o755;

const zipError = (detail: string, cause?: unknown, kind: "invalid" | "io" = "invalid") =>
  new ZipArchiveError({ kind, detail, ...(cause === undefined ? {} : { cause }) });

// zlib reports corrupt data with `Z_*` codes; everything else is the file system.
const isInflateError = (cause: unknown) =>
  typeof cause === "object" &&
  cause !== null &&
  typeof (cause as { code?: unknown }).code === "string" &&
  (cause as { code: string }).code.startsWith("Z_");

const readExactly = async (handle: FileHandle, position: number, length: number) => {
  const buffer = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const { bytesRead } = await handle.read(buffer, offset, length - offset, position + offset);
    if (bytesRead === 0) throw zipError("The archive ended unexpectedly.");
    offset += bytesRead;
  }
  return buffer;
};

const utf8 = new TextDecoder("utf-8", { fatal: true });

/** Every entry the central directory lists, and where member data must end. */
const readCentralDirectory = async (handle: FileHandle, maxEntries: number) => {
  const { size } = await handle.stat();
  const tailLength = Math.min(size, MAX_END_SEARCH);
  const tail = await readExactly(handle, size - tailLength, tailLength);
  // The last end record whose comment runs exactly to the end of the file.
  let end = -1;
  for (let at = tail.length - END_OF_CENTRAL_DIRECTORY_SIZE; at >= 0; at -= 1) {
    if (
      tail.readUInt32LE(at) === END_OF_CENTRAL_DIRECTORY &&
      at + END_OF_CENTRAL_DIRECTORY_SIZE + tail.readUInt16LE(at + 20) === tail.length
    ) {
      end = at;
      break;
    }
  }
  if (end === -1) throw zipError("The archive has no ZIP directory.");
  const diskNumber = tail.readUInt16LE(end + 4);
  const directoryDisk = tail.readUInt16LE(end + 6);
  const diskEntries = tail.readUInt16LE(end + 8);
  const count = tail.readUInt16LE(end + 10);
  const directorySize = tail.readUInt32LE(end + 12);
  const directoryOffset = tail.readUInt32LE(end + 16);
  if (diskNumber !== 0 || directoryDisk !== 0 || diskEntries !== count) {
    throw zipError("Multi-part ZIP archives are not supported.");
  }
  if (count === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) {
    throw zipError("ZIP64 archives are not supported.");
  }
  if (count > maxEntries) throw zipError("The archive has too many entries.");
  const endOffset = size - tailLength + end;
  if (directorySize > MAX_CENTRAL_DIRECTORY_BYTES || directoryOffset + directorySize > endOffset) {
    throw zipError("The archive's ZIP directory is invalid.");
  }
  const directory = await readExactly(handle, directoryOffset, directorySize);
  const entries: Array<ZipEntry> = [];
  let at = 0;
  for (let index = 0; index < count; index += 1) {
    if (at + 46 > directory.length || directory.readUInt32LE(at) !== CENTRAL_DIRECTORY_ENTRY) {
      throw zipError("The archive's ZIP directory is invalid.");
    }
    const flags = directory.readUInt16LE(at + 8);
    const compressedSize = directory.readUInt32LE(at + 20);
    const uncompressedSize = directory.readUInt32LE(at + 24);
    const nameLength = directory.readUInt16LE(at + 28);
    const extraLength = directory.readUInt16LE(at + 30);
    const commentLength = directory.readUInt16LE(at + 32);
    const localHeaderOffset = directory.readUInt32LE(at + 42);
    const next = at + 46 + nameLength + extraLength + commentLength;
    if (next > directory.length) throw zipError("The archive's ZIP directory is invalid.");
    if (
      compressedSize === 0xffffffff ||
      uncompressedSize === 0xffffffff ||
      localHeaderOffset === 0xffffffff
    ) {
      throw zipError("ZIP64 archives are not supported.");
    }
    let name: string;
    try {
      name = utf8.decode(directory.subarray(at + 46, at + 46 + nameLength));
    } catch (cause) {
      throw zipError("The archive has an entry whose name is not UTF-8.", cause);
    }
    entries.push({
      name,
      isDirectory: name.endsWith("/"),
      unixMode: directory.readUInt32LE(at + 38) >>> 16,
      compressionMethod: directory.readUInt16LE(at + 10),
      // Bit 0: encrypted; bit 6: strong encryption.
      encrypted: (flags & 0b100_0001) !== 0,
      compressedSize,
      uncompressedSize,
      crc32: directory.readUInt32LE(at + 16),
      localHeaderOffset,
    });
    at = next;
  }
  return { entries, dataEnd: directoryOffset };
};

/**
 * The `/`-separated path an entry names, relative to the extraction root, or
 * undefined when it is unsafe on any platform: absolute, a drive or stream
 * name, `..`/`.` segments, backslashes, control characters, or empty segments.
 */
export const safeZipEntryPath = (name: string): string | undefined => {
  const trimmed = name.endsWith("/") ? name.slice(0, -1) : name;
  if (
    trimmed === "" ||
    trimmed.length > 4096 ||
    trimmed.startsWith("/") ||
    /[\\:\p{Cc}]/u.test(trimmed)
  ) {
    return undefined;
  }
  const segments = trimmed.split("/");
  if (segments.length > 64 || segments.some((s) => s === "" || s === "." || s === "..")) {
    return undefined;
  }
  return trimmed;
};

/** Counts and checksums a member as it streams, failing as soon as it outgrows its record. */
class VerifiedEntry extends Transform {
  private readonly entry: ZipEntry;
  private bytes = 0;
  private crc = 0;
  constructor(entry: ZipEntry) {
    super();
    this.entry = entry;
  }
  override _transform(chunk: Buffer, _encoding: BufferEncoding, done: TransformCallback) {
    this.bytes += chunk.byteLength;
    if (this.bytes > this.entry.uncompressedSize) {
      done(zipError("An archive entry is larger than its recorded size."));
      return;
    }
    this.crc = NodeZlib.crc32(chunk, this.crc);
    done(null, chunk);
  }
  override _flush(done: TransformCallback) {
    done(
      this.bytes !== this.entry.uncompressedSize || this.crc >>> 0 !== this.entry.crc32 >>> 0
        ? zipError("An archive entry failed its size or CRC-32 check.")
        : null,
    );
  }
}

/** Where an entry's data starts, after re-checking its local header. */
const entryDataStart = async (handle: FileHandle, entry: ZipEntry, dataEnd: number) => {
  if (entry.localHeaderOffset + 30 > dataEnd) throw zipError("An archive entry is out of bounds.");
  const header = await readExactly(handle, entry.localHeaderOffset, 30);
  if (header.readUInt32LE(0) !== LOCAL_FILE_HEADER) {
    throw zipError("An archive entry has an invalid local header.");
  }
  if ((header.readUInt16LE(6) & 0b100_0001) !== 0) {
    throw zipError("The archive has an encrypted entry.");
  }
  const start = entry.localHeaderOffset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
  if (start + entry.compressedSize > dataEnd) throw zipError("An archive entry is out of bounds.");
  return start;
};

// Streams own their file descriptors: a stream over a shared `FileHandle`
// keeps it referenced, so closing that handle would wait forever under Node.
const extractFile = async (input: {
  readonly archivePath: string;
  readonly handle: FileHandle;
  readonly entry: ZipEntry;
  readonly dataEnd: number;
  readonly target: string;
  readonly signal: AbortSignal;
}) => {
  const { entry } = input;
  const start = await entryDataStart(input.handle, entry, input.dataEnd);
  const verifier = new VerifiedEntry(entry);
  // Created owner-only and exclusively, so an entry never replaces or follows anything.
  const writer = createWriteStream(input.target, { flags: "wx", mode: 0o600 });
  if (entry.compressedSize === 0) {
    verifier.end();
    await pipeline(verifier, writer, { signal: input.signal });
  } else {
    const reader = createReadStream(input.archivePath, {
      start,
      end: start + entry.compressedSize - 1,
    });
    await (entry.compressionMethod === DEFLATED
      ? pipeline(reader, NodeZlib.createInflateRaw(), verifier, writer, { signal: input.signal })
      : pipeline(reader, verifier, writer, { signal: input.signal }));
  }
  // Executables and libraries keep their exec bits.
  await NodeFs.chmod(input.target, entry.unixMode & EXTRACTED_MODE_MASK || 0o644);
};

export interface ExtractZipArchiveInput {
  readonly archivePath: string;
  /** Created by the extraction; must not exist yet. */
  readonly destination: string;
  /**
   * A top directory every entry must sit under, stripped from the extracted
   * paths. Entries outside it make the archive unsafe.
   */
  readonly stripPrefix?: string | undefined;
  readonly maxEntries: number;
  /** Bound on the sum of every member's uncompressed size. */
  readonly maxTotalBytes: number;
}

const extract = async (input: ExtractZipArchiveInput, signal: AbortSignal) => {
  const handle = await NodeFs.open(input.archivePath, "r").catch((cause: unknown) => {
    throw zipError("The archive could not be opened.", cause, "io");
  });
  try {
    const { entries, dataEnd } = await readCentralDirectory(handle, input.maxEntries);
    const destination = NodePath.resolve(input.destination);
    const unsafe = () => zipError("The archive contains an unexpected or unsafe entry.");
    // Validated in full before anything is written.
    const planned = new Set<string>();
    let totalBytes = 0;
    const plan = entries.flatMap((entry) => {
      const name =
        input.stripPrefix === undefined
          ? entry.name
          : entry.name.startsWith(input.stripPrefix)
            ? entry.name.slice(input.stripPrefix.length)
            : undefined;
      if (name === undefined) throw unsafe();
      // The stripped top directory itself.
      if (name === "" && entry.isDirectory) return [];
      const relative = safeZipEntryPath(name);
      const unixType = entry.unixMode & UNIX_TYPE_MASK;
      if (
        relative === undefined ||
        entry.encrypted ||
        (unixType !== 0 && unixType !== (entry.isDirectory ? UNIX_DIRECTORY : UNIX_REGULAR_FILE)) ||
        (!entry.isDirectory &&
          entry.compressionMethod !== STORED &&
          entry.compressionMethod !== DEFLATED) ||
        (entry.isDirectory && entry.uncompressedSize !== 0) ||
        (entry.compressionMethod === STORED && entry.compressedSize !== entry.uncompressedSize)
      ) {
        throw unsafe();
      }
      const target = NodePath.resolve(destination, ...relative.split("/"));
      if (!target.startsWith(`${destination}${NodePath.sep}`) || planned.has(relative)) {
        throw unsafe();
      }
      planned.add(relative);
      totalBytes += entry.uncompressedSize;
      if (totalBytes > input.maxTotalBytes) throw zipError("The archive unpacks too large.");
      return [{ entry, relative, target }];
    });
    await NodeFs.mkdir(destination, { mode: 0o755 });
    const files: Array<string> = [];
    for (const { entry, relative, target } of plan) {
      signal.throwIfAborted();
      if (entry.isDirectory) {
        await NodeFs.mkdir(target, { recursive: true, mode: 0o755 });
        continue;
      }
      await NodeFs.mkdir(NodePath.dirname(target), { recursive: true, mode: 0o755 });
      await extractFile({ archivePath: input.archivePath, handle, entry, dataEnd, target, signal });
      files.push(relative);
    }
    return files;
  } finally {
    await handle.close();
  }
};

/**
 * Unpacks a local ZIP into a new `destination` directory, entry by entry.
 * Rejects the whole archive when any entry is unsafe: a path outside the
 * destination or the expected top directory, a symlink or special file, an
 * encrypted entry, a method other than store or deflate, or sizes past the
 * limits. Members are checked against their recorded size and CRC-32 as they
 * stream. Returns the extracted files' relative paths. On failure the
 * destination may hold a partial tree; callers extract into staging.
 */
export const extractZipArchive = Effect.fn("zipArchive.extract")(function* (
  input: ExtractZipArchiveInput,
) {
  return yield* Effect.tryPromise({
    try: (signal) => extract(input, signal),
    catch: (cause) =>
      isZipArchiveError(cause)
        ? cause
        : isInflateError(cause)
          ? zipError("An archive entry is not valid deflate data.", cause)
          : zipError("The archive could not be unpacked.", cause, "io"),
  });
});
