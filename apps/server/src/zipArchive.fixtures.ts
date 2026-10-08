// @effect-diagnostics nodeBuiltinImport:off - builds raw ZIP bytes for tests.
import * as NodeZlib from "node:zlib";

export interface ZipFixtureEntry {
  readonly name: string;
  readonly data?: string | Uint8Array;
  /** Unix mode, type bits included (e.g. 0o100755, 0o40755, 0o120777 for a symlink). */
  readonly mode?: number;
  /** 0 stores, 8 deflates; anything else is written as stored bytes under that method id. */
  readonly method?: number;
  readonly flags?: number;
  /** Overrides the recorded CRC-32 or uncompressed size, to forge a lying entry. */
  readonly crc32?: number;
  readonly uncompressedSize?: number;
}

/** A ZIP whose central directory carries Unix modes, like Chrome for Testing's archives. */
export const makeZip = (entries: ReadonlyArray<ZipFixtureEntry>): Buffer => {
  const records: Array<Buffer> = [];
  const directory: Array<Buffer> = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const data = Buffer.from(entry.data ?? "");
    const method = entry.method ?? 0;
    const stored = method === 8 ? NodeZlib.deflateRawSync(data) : data;
    const crc = entry.crc32 ?? NodeZlib.crc32(data);
    const size = entry.uncompressedSize ?? data.length;
    const flags = (entry.flags ?? 0) | 0x0800;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc >>> 0, 14);
    local.writeUInt32LE(stored.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc >>> 0, 16);
    central.writeUInt32LE(stored.length, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(((entry.mode ?? 0o100644) << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    records.push(local, name, stored);
    directory.push(central, name);
    offset += local.length + name.length + stored.length;
  }
  const centralDirectory = Buffer.concat(directory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...records, centralDirectory, end]);
};
