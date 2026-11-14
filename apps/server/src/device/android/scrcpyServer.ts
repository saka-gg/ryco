/**
 * The scrcpy-server build Ryco runs on Android emulators: one pinned release,
 * fetched once from GitHub, verified by SHA-256 and cached under the Ryco home.
 *
 * scrcpy (https://github.com/Genymobile/scrcpy) is Apache-2.0; Ryco downloads
 * the unmodified server jar and does not redistribute it (THIRD_PARTY_NOTICES.md).
 * The client side of its protocol lives in `scrcpyProtocol.ts` and must change
 * together with this pin: scrcpy's protocol is internal and version-locked.
 *
 * @module device/android/scrcpyServer
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import * as path from "node:path";

import { resolveRycoBaseDir } from "../../os-jank.ts";

export const SCRCPY_SERVER_VERSION = "5.0.1";
export const SCRCPY_SERVER_SHA256 =
  "764eb6f79811d5211fe9df341120882ba9994c7a61b897d7bf3fb662e53bc536";
export const SCRCPY_SERVER_URL = `https://github.com/Genymobile/scrcpy/releases/download/v${SCRCPY_SERVER_VERSION}/scrcpy-server-v${SCRCPY_SERVER_VERSION}`;
/** Where the jar lives on the device: versioned, so an old push is never reused. */
export const SCRCPY_DEVICE_PATH = `/data/local/tmp/ryco-scrcpy-server-v${SCRCPY_SERVER_VERSION}.jar`;
/** The release asset is about 720 KiB; anything far larger is not it. */
const MAX_DOWNLOAD_BYTES = 8 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 60_000;

/** `<RYCO_HOME or ~/.ryco>/cache/android`: shared by every Android helper artifact. */
export function androidCacheRoot(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  return path.join(resolveRycoBaseDir(env.RYCO_HOME, home), "cache", "android");
}

export type FetchBytes = (url: string, signal: AbortSignal) => Promise<Uint8Array>;

const fetchBytes: FetchBytes = async (url, signal) => {
  const response = await fetch(url, { signal, redirect: "follow" });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const length = Number(response.headers.get("content-length") ?? "0");
  if (length > MAX_DOWNLOAD_BYTES) throw new Error("download is larger than expected");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_DOWNLOAD_BYTES) throw new Error("download is larger than expected");
  return bytes;
};

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export class ScrcpyServerUnavailableError extends Error {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "ScrcpyServerUnavailableError";
  }
}

/**
 * Resolves the verified jar on disk, downloading it the first time. Concurrent
 * callers share one download; a failure is remembered for a minute so a
 * machine without network does not retry on every attach.
 */
export class ScrcpyServerArtifact {
  private pending: Promise<string> | null = null;
  private failure: { readonly at: number; readonly error: Error } | null = null;
  private readonly cacheDirectory: string;
  private readonly fetch: FetchBytes;
  private readonly now: () => number;

  constructor(
    options: {
      readonly cacheDirectory?: string;
      readonly fetch?: FetchBytes;
      readonly now?: () => number;
    } = {},
  ) {
    this.cacheDirectory = options.cacheDirectory ?? path.join(androidCacheRoot(), "scrcpy");
    this.fetch = options.fetch ?? fetchBytes;
    this.now = options.now ?? Date.now;
  }

  get filePath(): string {
    return path.join(this.cacheDirectory, `scrcpy-server-v${SCRCPY_SERVER_VERSION}`);
  }

  resolve(): Promise<string> {
    if (this.failure && this.now() - this.failure.at < 60_000)
      return Promise.reject(this.failure.error);
    this.pending ??= this.load().then(
      (file) => {
        this.failure = null;
        return file;
      },
      (error: unknown) => {
        this.pending = null;
        const failure =
          error instanceof ScrcpyServerUnavailableError
            ? error
            : new ScrcpyServerUnavailableError(String(error), { cause: error });
        this.failure = { at: this.now(), error: failure };
        throw failure;
      },
    );
    return this.pending;
  }

  private async load(): Promise<string> {
    const target = this.filePath;
    const cached = await readFile(target).catch(() => null);
    if (cached && sha256(cached) === SCRCPY_SERVER_SHA256) return target;
    if (cached) await rm(target, { force: true });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
    timer.unref?.();
    let bytes: Uint8Array;
    try {
      bytes = await this.fetch(SCRCPY_SERVER_URL, controller.signal);
    } catch (cause) {
      throw new ScrcpyServerUnavailableError(
        `Could not download scrcpy-server ${SCRCPY_SERVER_VERSION} for Android video (${cause instanceof Error ? cause.message : String(cause)}).`,
        { cause },
      );
    } finally {
      clearTimeout(timer);
    }
    const digest = sha256(bytes);
    if (digest !== SCRCPY_SERVER_SHA256)
      throw new ScrcpyServerUnavailableError(
        `The downloaded scrcpy-server ${SCRCPY_SERVER_VERSION} failed its checksum (got ${digest}).`,
      );
    await mkdir(this.cacheDirectory, { recursive: true });
    const temporary = `${target}.${randomUUID()}.partial`;
    await writeFile(temporary, bytes, { mode: 0o644 });
    await rename(temporary, target).catch(async (error: unknown) => {
      await rm(temporary, { force: true });
      throw error;
    });
    return target;
  }
}
