import { createHash } from "node:crypto";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { gunzipSync, inflateRawSync } from "node:zlib";
import { Schema } from "effect";
import {
  AcpRegistryAgentId,
  AcpRegistryVersion,
  type AcpRegistryAgent,
  type AcpRegistryInstallation,
  type AcpRegistryInstallInput,
} from "@ryco/contracts";

export const ACP_REGISTRY_URL =
  "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json";
const MAX_DOWNLOAD = 256 * 1024 * 1024;
const MAX_EXTRACTED = 512 * 1024 * 1024;
const MAX_FILES = 20_000;
const DOWNLOAD_HOSTS = new Set([
  "cdn.agentclientprotocol.com",
  "github.com",
  "release-assets.githubusercontent.com",
  "objects.githubusercontent.com",
  "downloads.poolside.ai",
  "dl.google.com",
  "sfc-repo.snowflakecomputing.com",
  "downloads.cursor.com",
  "static.devin.ai",
]);
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const Binary = Schema.Struct({
  archive: Schema.String,
  sha256: Schema.optionalKey(Schema.String),
  cmd: Schema.String,
  args: Schema.optionalKey(Schema.Array(Schema.String)),
  env: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
});
const Entry = Schema.Struct({
  id: AcpRegistryAgentId,
  version: AcpRegistryVersion,
  name: Schema.String,
  description: Schema.String,
  repository: Schema.optionalKey(Schema.String),
  website: Schema.optionalKey(Schema.String),
  icon: Schema.optionalKey(Schema.String),
  license: Schema.optionalKey(Schema.String),
  distribution: Schema.Struct({ binary: Schema.optionalKey(Schema.Record(Schema.String, Binary)) }),
});
const Index = Schema.Struct({ agents: Schema.Array(Schema.Unknown) });
const Manifest = Schema.Struct({
  agentId: AcpRegistryAgentId,
  version: AcpRegistryVersion,
  sha256: Schema.String,
  command: Schema.String,
  args: Schema.Array(Schema.String),
  env: Schema.Record(Schema.String, Schema.String),
  files: Schema.Record(Schema.String, Schema.String),
});
type Entry = typeof Entry.Type;
type Binary = typeof Binary.Type;
export interface AcpRegistryCommand {
  readonly sha256: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly version: string;
}

function downloadUrl(value: string) {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    (url.port && url.port !== "443") ||
    !DOWNLOAD_HOSTS.has(url.hostname)
  )
    throw new Error("Registry download URL is not an approved HTTPS origin.");
  return url;
}
async function download(
  url: string,
  max: number,
  fetcher: (input: string | URL | Request, init?: RequestInit) => Promise<Response>,
): Promise<Buffer> {
  for (let redirects = 0; redirects <= 5; redirects++) {
    const response = await fetcher(downloadUrl(url), {
      redirect: "manual",
      signal: AbortSignal.timeout(120_000),
    });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      const location = response.headers.get("location");
      if (!location) throw new Error("Registry download returned an invalid redirect.");
      url = new URL(location, url).href;
      continue;
    }
    if (!response.ok || !response.body)
      throw new Error(`Registry download failed (${response.status}).`);
    if (Number(response.headers.get("content-length")) > max) {
      await response.body.cancel();
      throw new Error("Registry download exceeds size limit.");
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > max) throw new Error("Registry download exceeds size limit.");
        chunks.push(value);
      }
    } finally {
      await reader.cancel();
    }
    return Buffer.concat(chunks);
  }
  throw new Error("Registry download exceeded redirect limit.");
}
/** Treat every archive name as untrusted on every platform, including Windows. */
export function safeAcpRegistryPath(value: string): string {
  const clean = value.replace(/^(\.\/)+/, "").replace(/\/$/, "");
  if (
    !clean ||
    clean.length > 4096 ||
    clean.split("/").length > 64 ||
    clean.includes("\\") ||
    clean.includes(":") ||
    [...clean].some((character) => character.charCodeAt(0) < 32) ||
    clean.startsWith("/") ||
    clean
      .split("/")
      .some(
        (p) =>
          !p ||
          p === "." ||
          p === ".." ||
          /[. ]$/.test(p) ||
          /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p),
      )
  )
    throw new Error("Unsafe registry archive path.");
  return clean;
}
/** Extract regular files only; never invoke an archive tool or allow link/device entries. */
export function extractAcpRegistryArchive(
  bytes: Buffer,
  archive: string,
  command: string,
): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  const names = new Set<string>();
  let size = 0;
  const add = (name: string, data: Buffer, directory = false) => {
    if (directory && (name === "./" || name === ".")) return;
    const safe = safeAcpRegistryPath(name);
    if (names.has(safe)) throw new Error("Duplicate registry archive path.");
    names.add(safe);
    if (names.size > MAX_FILES) throw new Error("Registry archive contains too many entries.");
    if (directory) return;
    size += data.length;
    if (size > MAX_EXTRACTED) throw new Error("Registry archive exceeds extraction size limit.");
    files.set(safe, data);
  };
  const pathname = new URL(archive).pathname.toLowerCase();
  if (/\.(tar\.gz|tgz)$/.test(pathname)) {
    const tar = gunzipSync(bytes, { maxOutputLength: MAX_EXTRACTED });
    for (let offset = 0; offset + 512 <= tar.length;) {
      const header = tar.subarray(offset, offset + 512);
      if (header.every((byte) => byte === 0)) break;
      const string = (start: number, end: number) =>
        header.subarray(start, end).toString("utf8").replace(/\0.*$/s, "");
      const expected = Number.parseInt(string(148, 156).trim(), 8);
      const actual = header.reduce((sum, byte, i) => sum + (i >= 148 && i < 156 ? 32 : byte), 0);
      if (expected !== actual) throw new Error("Invalid tar header checksum.");
      const length = Number.parseInt(string(124, 136).trim(), 8);
      if (!Number.isSafeInteger(length) || length < 0 || offset + 512 + length > tar.length)
        throw new Error("Invalid tar entry size.");
      const type = header[156];
      if (type !== 0 && type !== 48 && type !== 53)
        throw new Error("Registry archive contains unsupported links or special entries.");
      const prefix = string(345, 500);
      add(
        `${prefix ? `${prefix}/` : ""}${string(0, 100)}`,
        tar.subarray(offset + 512, offset + 512 + length),
        type === 53,
      );
      offset += 512 + Math.ceil(length / 512) * 512;
    }
  } else if (pathname.endsWith(".zip")) {
    // Read the central directory so Unix mode bits cannot conceal symlinks.
    let end = bytes.length - 22;
    while (end >= Math.max(0, bytes.length - 65557) && bytes.readUInt32LE(end) !== 0x06054b50)
      end--;
    if (end < 0 || bytes.readUInt32LE(end) !== 0x06054b50)
      throw new Error("Invalid zip directory.");
    if (bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6))
      throw new Error("Multipart zip is unsupported.");
    const count = bytes.readUInt16LE(end + 10);
    if (count > MAX_FILES) throw new Error("Registry archive contains too many entries.");
    let offset = bytes.readUInt32LE(end + 16);
    for (let i = 0; i < count; i++) {
      if (offset + 46 > end || bytes.readUInt32LE(offset) !== 0x02014b50)
        throw new Error("Invalid zip entry.");
      const flags = bytes.readUInt16LE(offset + 8),
        method = bytes.readUInt16LE(offset + 10);
      const compressed = bytes.readUInt32LE(offset + 20),
        length = bytes.readUInt32LE(offset + 24);
      const nameLength = bytes.readUInt16LE(offset + 28),
        extra = bytes.readUInt16LE(offset + 30),
        comment = bytes.readUInt16LE(offset + 32);
      const mode = bytes.readUInt32LE(offset + 38) >>> 16;
      if ((mode & 0xf000) !== 0 && (mode & 0xf000) !== 0x8000 && (mode & 0xf000) !== 0x4000)
        throw new Error("Registry archive contains links or special entries.");
      if (flags & 1 || length > MAX_EXTRACTED - size)
        throw new Error("Unsupported or oversized zip entry.");
      const name = bytes.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
      const local = bytes.readUInt32LE(offset + 42);
      if (local + 30 > bytes.length || bytes.readUInt32LE(local) !== 0x04034b50)
        throw new Error("Invalid zip local header.");
      const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
      if (start + compressed > bytes.length) throw new Error("Invalid zip data size.");
      const encoded = bytes.subarray(start, start + compressed);
      const data =
        method === 0
          ? encoded
          : method === 8
            ? inflateRawSync(encoded, { maxOutputLength: Math.max(1, length) })
            : undefined;
      if (!data || data.length !== length)
        throw new Error("Unsupported or invalid zip compression.");
      add(name, data, name.endsWith("/"));
      offset += 46 + nameLength + extra + comment;
    }
  } else {
    if (/\.(tar|bz2|tbz2|xz|dmg|pkg|deb|rpm|msi|appimage)$/.test(pathname))
      throw new Error("Unsupported registry archive format.");
    add(command, bytes);
  }
  if (!files.has(safeAcpRegistryPath(command)))
    throw new Error("Registry executable is missing from the archive.");
  return files;
}

export function makeAcpRegistryCatalog(options: {
  installationRoot: string;
  fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  platform?: string;
}) {
  const fetcher = options.fetch ?? fetch;
  const platform =
    options.platform ??
    `${process.platform === "win32" ? "windows" : process.platform}-${process.arch === "arm64" ? "aarch64" : process.arch === "x64" ? "x86_64" : process.arch}`;
  const root = path.resolve(options.installationRoot);
  const installing = new Map<string, Promise<AcpRegistryInstallation>>();
  const identity = (input: AcpRegistryInstallInput) => {
    Schema.decodeUnknownSync(AcpRegistryAgentId)(input.agentId);
    Schema.decodeUnknownSync(AcpRegistryVersion)(input.version);
    return path.join(root, input.agentId, input.version, platform);
  };
  let cachedIndex: { entries: readonly Entry[]; at: number } | undefined;
  const index = async (refresh = false): Promise<readonly Entry[]> => {
    if (!refresh && cachedIndex && Date.now() - cachedIndex.at < 60_000) return cachedIndex.entries;
    const raw = Schema.decodeUnknownSync(Index)(
      JSON.parse((await download(ACP_REGISTRY_URL, 4 * 1024 * 1024, fetcher)).toString("utf8")),
    ).agents;
    if (raw.length > 2_000) throw new Error("Registry index contains too many entries.");
    const entries: Entry[] = [];
    const seen = new Set<string>();
    for (const value of raw) {
      try {
        const entry = Schema.decodeUnknownSync(Entry)(value);
        if (!seen.has(entry.id)) {
          entries.push(entry);
          seen.add(entry.id);
        }
      } catch {
        /* One malformed publisher entry must not hide other agents. */
      }
    }
    cachedIndex = { entries, at: Date.now() };
    return entries;
  };
  const binaryFor = (entry: Entry): Binary => {
    const binary = entry.distribution.binary?.[platform];
    if (!binary)
      throw new Error(
        "No checksum-verifiable binary is published for this platform. Package-runner distributions are not installed.",
      );
    if (!binary.sha256 || !/^[a-f\d]{64}$/i.test(binary.sha256))
      throw new Error("Publisher has not supplied a SHA-256 checksum for this binary.");
    downloadUrl(binary.archive);
    safeAcpRegistryPath(binary.cmd);
    if (/\.(tar|bz2|tbz2|xz|dmg|pkg|deb|rpm|msi|appimage)$/i.test(new URL(binary.archive).pathname))
      throw new Error(
        "This archive format is not supported; tar.gz, zip, and raw binaries are supported.",
      );
    return binary;
  };
  const ensureDirectory = async (directory: string) => {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const stat = await fs.lstat(directory);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      (await fs.realpath(directory)) !== directory
    )
      throw new Error("Registry installation directory must not contain symlinks.");
  };
  const resolveInstalled = async (input: AcpRegistryInstallInput): Promise<AcpRegistryCommand> => {
    const directory = identity(input);
    for (const dir of [root, directory]) {
      if ((await fs.lstat(dir)).isSymbolicLink() || (await fs.realpath(dir)) !== dir)
        throw new Error("Registry installation directory must not contain symlinks.");
    }
    let totalRead = 0;
    const readRegular = async (name: string) => {
      const filename = path.join(directory, safeAcpRegistryPath(name));
      if ((await fs.realpath(filename)) !== filename)
        throw new Error("Registry installation contains a symlink.");
      const handle = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = await handle.stat();
        totalRead += stat.size;
        if (
          !stat.isFile() ||
          totalRead > MAX_EXTRACTED + 4 * 1024 * 1024 ||
          (name === ".ryco-manifest.json" && stat.size > 4 * 1024 * 1024)
        )
          throw new Error("Invalid installed registry file.");
        return await handle.readFile();
      } finally {
        await handle.close();
      }
    };
    const manifest = Schema.decodeUnknownSync(Manifest)(
      JSON.parse((await readRegular(".ryco-manifest.json")).toString("utf8")),
    );
    if (
      manifest.agentId !== input.agentId ||
      manifest.version !== input.version ||
      !/^[a-f\d]{64}$/.test(manifest.sha256)
    )
      throw new Error("Registry installation identity does not match the pinned version.");
    const command = safeAcpRegistryPath(manifest.command);
    if (!manifest.files[command] || Object.keys(manifest.files).length > MAX_FILES)
      throw new Error("Registry installation has no verified executable.");
    let foundFiles = 0;
    const inspectTree = async (relative = ""): Promise<void> => {
      for (const entry of await fs.readdir(path.join(directory, relative), {
        withFileTypes: true,
      })) {
        const name = relative ? `${relative}/${entry.name}` : entry.name;
        if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile()))
          throw new Error("Registry installation contains symlinks or special files.");
        if (++foundFiles > MAX_FILES * 2)
          throw new Error("Registry installation contains too many files.");
        if (entry.isDirectory()) await inspectTree(name);
        else if (name !== ".ryco-manifest.json" && !Object.hasOwn(manifest.files, name))
          throw new Error("Registry installation contains an unverified file.");
      }
    };
    await inspectTree();
    for (const [name, checksum] of Object.entries(manifest.files))
      if (digest(await readRegular(name)) !== checksum)
        throw new Error("Registry installation checksum mismatch; reinstall the pinned version.");
    return {
      sha256: manifest.sha256,
      command: path.join(directory, command),
      args: manifest.args,
      env: manifest.env,
      version: manifest.version,
    };
  };
  const install = (input: AcpRegistryInstallInput): Promise<AcpRegistryInstallation> => {
    const directory = identity(input);
    const pending = installing.get(directory);
    if (pending) return pending;
    const operation = (async () => {
      const entry = (await index(true)).find(
        (entry) => entry.id === input.agentId && entry.version === input.version,
      );
      if (!entry)
        throw new Error(
          "The selected registry version is no longer available; refresh and explicitly select a version.",
        );
      const binary = binaryFor(entry);
      const bytes = await download(binary.archive, MAX_DOWNLOAD, fetcher);
      const sha256 = digest(bytes);
      if (sha256 !== binary.sha256!.toLowerCase())
        throw new Error("Registry archive SHA-256 checksum mismatch.");
      const files = extractAcpRegistryArchive(bytes, binary.archive, binary.cmd);
      if (files.has(".ryco-manifest.json"))
        throw new Error("Registry archive uses a reserved filename.");
      await ensureDirectory(root);
      await ensureDirectory(path.dirname(directory));
      const staging = await fs.mkdtemp(path.join(root, ".install-"));
      try {
        const checksums: Record<string, string> = Object.create(null);
        for (const [name, data] of files) {
          const filename = path.join(staging, name);
          await fs.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
          await fs.writeFile(filename, data, { flag: "wx", mode: 0o700 });
          checksums[name] = digest(data);
        }
        const manifest = {
          agentId: entry.id,
          version: entry.version,
          sha256,
          command: safeAcpRegistryPath(binary.cmd),
          args: binary.args ?? [],
          env: binary.env ?? {},
          files: checksums,
        };
        await fs.writeFile(path.join(staging, ".ryco-manifest.json"), JSON.stringify(manifest), {
          flag: "wx",
          mode: 0o600,
        });
        // Never replace a live pinned installation; duplicate calls verify the existing copy.
        try {
          await fs.rename(staging, directory);
        } catch (error) {
          if (
            !(
              error instanceof Error &&
              "code" in error &&
              (error.code === "EEXIST" || error.code === "ENOTEMPTY")
            )
          )
            throw error;
          const existing = await resolveInstalled(input);
          if (existing.sha256 !== sha256)
            throw new Error(
              "This pinned version is already installed with a different archive checksum.",
              { cause: error },
            );
        }
        await resolveInstalled(input);
        return { agentId: entry.id, version: entry.version, sha256 };
      } finally {
        await fs.rm(staging, { recursive: true, force: true });
      }
    })();
    installing.set(directory, operation);
    void operation.finally(() => installing.delete(directory)).catch(() => {});
    return operation;
  };
  const search = async (query = ""): Promise<readonly AcpRegistryAgent[]> => {
    const entries = (await index())
      .filter((entry) =>
        `${entry.id} ${entry.name} ${entry.description}`
          .toLowerCase()
          .includes(query.trim().toLowerCase()),
      )
      .slice(0, 100);
    const result: AcpRegistryAgent[] = [];
    for (const entry of entries) {
      let unavailableReason: string | undefined;
      try {
        binaryFor(entry);
      } catch (error) {
        unavailableReason = error instanceof Error ? error.message : "Distribution unavailable.";
      }
      let installed = false;
      // Discovery only reads bounded installation metadata. Integrity is checked in full at launch.
      try {
        const directory = identity({ agentId: entry.id, version: entry.version });
        const filename = path.join(directory, ".ryco-manifest.json");
        if ((await fs.realpath(filename)) !== filename) throw new Error("Symlink installation.");
        const handle = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          if ((await handle.stat()).size > 4 * 1024 * 1024)
            throw new Error("Oversized installation manifest.");
          const manifest = Schema.decodeUnknownSync(Manifest)(
            JSON.parse(await handle.readFile("utf8")),
          );
          installed = manifest.agentId === entry.id && manifest.version === entry.version;
        } finally {
          await handle.close();
        }
      } catch {
        /* Absent or invalid installation metadata is not installed. */
      }
      const { distribution: _distribution, ...metadata } = entry;
      result.push({
        ...metadata,
        installed,
        installable: unavailableReason === undefined,
        ...(unavailableReason ? { unavailableReason } : {}),
      });
    }
    return result;
  };
  return { search, install, resolveInstalled };
}
