// @effect-diagnostics nodeBuiltinImport:off - Effect has no incremental digest, process probe, or host name.
/**
 * PreviewBrowser - Ryco's own pinned Chrome for Testing headless shell, which
 * HTML previews and render measurements run in. It is never a browser the
 * user installed.
 *
 * The first preview downloads it (~100 MB) from Google's Chrome for Testing
 * bucket into Ryco's machine-wide data directory, verifying the exact size and
 * SHA-256 of the pinned build, and unpacks it through a staging directory that
 * is published with one rename. A download that stops part-way is kept and
 * resumed by the next attempt, even when its server was killed. The install
 * belongs to the service, so it finishes even when the preview that started
 * it stops waiting.
 *
 * @module PreviewBrowser
 */
import * as NodeCrypto from "node:crypto";
import * as NodeOS from "node:os";

import {
  Cause,
  Clock,
  Context,
  Deferred,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Option,
  Path,
  Schema,
  Semaphore,
  Sink,
  Stream,
} from "effect";
import type { Duration } from "effect";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http";

import { ServerConfig } from "../config.ts";
import { extractZipArchive } from "../zipArchive.ts";
import { HTML_RENDER_WITHOUT_PREVIEW } from "./HtmlRender.ts";

// HTML previews only ever run Ryco's own pinned Chrome for Testing headless
// shell. To bump the pin, pick a version from
// https://googlechromelabs.github.io/chrome-for-testing/known-good-versions-with-downloads.json,
// download each platform's chrome-headless-shell zip, and replace the version
// and every byte count and SHA-256 below. Hosts drop the old build once the
// new one is installed and no server on the machine has used the old one for
// a week.
const VERSION = "154.0.8037.92";
const ARCHIVES = {
  linux64: {
    bytes: 120_477_194,
    sha256: "636aa5c79f2693632e9921b8bbb050038ba11672e02346c06c20f991aed096f9",
  },
  "linux-arm64": {
    bytes: 121_182_296,
    sha256: "0ed0e47d9e9f639197f508d62ada09e5c6b4c4c60edab3160a9312a733091df6",
  },
  "mac-arm64": {
    bytes: 99_221_129,
    sha256: "77da14e75d7f2568e6f7898d3df7cdc6faac74b15e903b2c9d486ebb6ca9b929",
  },
  "mac-x64": {
    bytes: 104_748_425,
    sha256: "a54292aaacbb77f76f6ef47558e7c51ab884044e0adacca315567f83c060bcc4",
  },
  win32: {
    bytes: 114_295_943,
    sha256: "56b30d2d6c35775ebf8dc3618680f6529e1c38c87f7feb28a16e9904273d51f7",
  },
  win64: {
    bytes: 120_822_223,
    sha256: "3ac2561f02d9d87aadc0399d00b9002d718a4c365624fa67db9e7bfaf6b1a568",
  },
} as const;

const DOWNLOAD_HOST = "storage.googleapis.com";
const DOWNLOAD_PATH_PREFIX = "/chrome-for-testing-public/";

const chromePlatform = (platform: NodeJS.Platform, arch: NodeJS.Architecture) => {
  switch (platform) {
    case "linux":
      return arch === "x64" ? "linux64" : arch === "arm64" ? "linux-arm64" : null;
    case "darwin":
      return arch === "arm64" ? "mac-arm64" : arch === "x64" ? "mac-x64" : null;
    case "win32":
      // There is no Windows arm64 build; Windows on Arm runs the x64 one under emulation.
      return arch === "ia32" ? "win32" : arch === "x64" || arch === "arm64" ? "win64" : null;
    default:
      return null;
  }
};

export interface PreviewBrowserRelease {
  readonly version: string;
  /** Chrome for Testing's platform name, which also names the archive's top directory. */
  readonly platform: string;
  readonly url: string;
  readonly bytes: number;
  readonly sha256: string;
}

export const previewBrowserRelease = (
  platform: NodeJS.Platform,
  arch: NodeJS.Architecture,
): PreviewBrowserRelease | null => {
  const chrome = chromePlatform(platform, arch);
  return chrome === null
    ? null
    : {
        version: VERSION,
        platform: chrome,
        url: `https://${DOWNLOAD_HOST}${DOWNLOAD_PATH_PREFIX}${VERSION}/${chrome}/chrome-headless-shell-${chrome}.zip`,
        ...ARCHIVES[chrome],
      };
};

/** Whether the browser may be downloaded from `value`: Chrome for Testing's public bucket over HTTPS only. */
export const isPreviewBrowserDownloadUrl = (value: string) => {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.hostname === DOWNLOAD_HOST &&
      url.port === "" &&
      url.username === "" &&
      url.password === "" &&
      url.search === "" &&
      url.pathname.startsWith(DOWNLOAD_PATH_PREFIX)
    );
  } catch {
    return false;
  }
};

const megabytes = (bytes: number) => Math.round(bytes / 1_000_000);

export class PreviewBrowserInstallError extends Schema.TaggedError<PreviewBrowserInstallError>()(
  "PreviewBrowserInstallError",
  { detail: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {
  override get message(): string {
    return `Ryco could not install its HTML preview browser: ${this.detail} Call ryco_html_preview again to retry.`;
  }
}
const isInstallError = Schema.is(PreviewBrowserInstallError);

export class PreviewBrowserInstallingError extends Schema.TaggedError<PreviewBrowserInstallingError>()(
  "PreviewBrowserInstallingError",
  { downloadedBytes: Schema.Number, totalBytes: Schema.Number, unpacking: Schema.Boolean },
) {
  override get message(): string {
    const progress = this.unpacking
      ? "unpacking"
      : `${megabytes(this.downloadedBytes)} of ${megabytes(this.totalBytes)} MB downloaded`;
    return `Ryco is installing its HTML preview browser (${progress}). Call ryco_html_preview again in a minute.`;
  }
}

export class PreviewBrowserUnsupportedError extends Schema.TaggedError<PreviewBrowserUnsupportedError>()(
  "PreviewBrowserUnsupportedError",
  { platform: Schema.String, arch: Schema.String },
) {
  override get message(): string {
    return `HTML previews are not available on ${this.platform}-${this.arch}: Chrome for Testing has no headless shell for it. ${HTML_RENDER_WITHOUT_PREVIEW}`;
  }
}

export type PreviewBrowserError =
  | PreviewBrowserInstallError
  | PreviewBrowserInstallingError
  | PreviewBrowserUnsupportedError;

export interface PreviewBrowserShape {
  /**
   * Path to the installed headless shell. The first call starts the install;
   * callers wait for it up to a bound and then get its progress instead,
   * while the install keeps running.
   */
  readonly executable: Effect.Effect<string, PreviewBrowserError>;
  /** The installed headless shell, if any. Never starts or waits on an install. */
  readonly installed: Effect.Effect<Option.Option<string>>;
}

export class PreviewBrowser extends Context.Service<PreviewBrowser, PreviewBrowserShape>()(
  "ryco/htmlRender/PreviewBrowser",
) {}

export interface PreviewBrowserOptions {
  /** Ryco's machine-wide data directory; the browser lives under `tools/`. */
  readonly baseDir: string;
  /** The build to install; `null` for a host Chrome for Testing has no build for. */
  readonly release?: PreviewBrowserRelease | null;
  /**
   * How long a caller waits on an install in progress. A preview must still
   * launch the browser inside the agent's 60 s tool-call limit.
   */
  readonly wait?: Duration.Input;
  readonly platform?: NodeJS.Platform;
  readonly arch?: NodeJS.Architecture;
  /** This server's process id, which names its installs' staging directories. */
  readonly pid?: number;
  /** Whether a process on this host is still running. */
  readonly isProcessAlive?: (pid: number) => boolean;
}

const DEFAULT_WAIT = "20 seconds";
// A download fails once nothing arrives for this long, so a slow but steady
// link still finishes; the total cap is only a backstop (about 270 kbit/s for
// the largest archive).
const DOWNLOAD_IDLE_TIMEOUT = "60 seconds";
const DOWNLOAD_MAX_DURATION = "60 minutes";
// Longer than any install can run: the download stops after 60 minutes.
const STAGING_STALE_AFTER_MS = 2 * 60 * 60_000;
const STAGING_PREFIX = ".install-";
const ARCHIVE_NAME = "download.zip";
// A download that stops part-way leaves what arrived in one file per version
// beside the installs, and the next attempt resumes it with a range request.
const PARTIAL_PREFIX = ".download-";
// Every server touches this file in the version it runs, at most this often,
// so a server pinning another version on this machine leaves that one be.
const LAST_USED_MARKER = ".last-used";
const MARK_USED_EVERY_MS = 60 * 60_000;
// Another version is removed only once no server has used it for this long.
const UNUSED_VERSION_STALE_AFTER_MS = 7 * 24 * 60 * 60_000;
const MAX_ARCHIVE_ENTRIES = 10_000;
// The headless shell unpacks to about 200-300 MB on every platform.
const MAX_UNPACKED_BYTES = 1024 * 1024 * 1024;

const NETWORK_FAILURE =
  "The download from storage.googleapis.com failed. Check this machine's network access.";
const SAVE_FAILURE = "Could not save the download. Check free disk space in Ryco's data directory.";

// Tells this host's installs from those of another host (a container, say)
// sharing the data directory, whose processes this one cannot see.
const HOST_TAG = NodeCrypto.createHash("sha256")
  .update(NodeOS.hostname())
  .digest("hex")
  .slice(0, 8);

/** How the staging directories of this host's installs of `version` start. */
const stagingPrefixOf = (version: string) => `${STAGING_PREFIX}${version}-${HOST_TAG}-`;

/**
 * The start of an install's staging directory name: the version it installs
 * and the process installing it, so another server can tell an install whose
 * process was killed, and resume its download, from one still running.
 */
export const previewBrowserStagingPrefix = (version: string, pid: number) =>
  `${stagingPrefixOf(version)}${pid}-`;

const processAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // Running, as another user.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

const wrapFailure = (detail: string) => (cause: unknown) =>
  isInstallError(cause) ? cause : new PreviewBrowserInstallError({ detail, cause });

const downloadStalled = () =>
  new PreviewBrowserInstallError({
    detail: `The download from storage.googleapis.com stalled: nothing arrived for ${DOWNLOAD_IDLE_TIMEOUT}. Check this machine's network access.`,
  });

/**
 * Whether a `206 Partial Content` answer holds exactly the rest of the pinned
 * archive from `offset` on, so its body may be appended to what is on disk.
 */
export const resumesPreviewBrowserDownload = (
  headers: Readonly<Record<string, string | undefined>>,
  offset: number,
  totalBytes: number,
) => {
  const encoding = headers["content-encoding"]?.trim().toLowerCase();
  if (encoding !== undefined && encoding !== "identity") return false;
  const range = /^bytes (\d+)-(\d+)\/(\d+)$/i.exec(headers["content-range"]?.trim() ?? "");
  return (
    range !== null &&
    Number(range[1]) === offset &&
    Number(range[2]) === totalBytes - 1 &&
    Number(range[3]) === totalBytes
  );
};

/** Whether an install that stopped keeps its archive for the next attempt to resume. */
interface DownloadedArchive {
  keep: boolean;
}

type InstallState =
  | { readonly _tag: "idle" }
  | {
      readonly _tag: "installing";
      readonly done: Deferred.Deferred<string, PreviewBrowserInstallError>;
    }
  | { readonly _tag: "installed"; readonly executable: string }
  | { readonly _tag: "failed"; readonly error: PreviewBrowserInstallError };

export const makePreviewBrowser = Effect.fn("PreviewBrowser.make")(function* (
  options: PreviewBrowserOptions,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const http = yield* HttpClient.HttpClient;
  // Installs belong to the service, so they finish even when no caller is still waiting.
  const serviceScope = yield* Effect.scope;
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const release =
    options.release === undefined ? previewBrowserRelease(platform, arch) : options.release;
  const wait = options.wait ?? DEFAULT_WAIT;
  const pid = options.pid ?? process.pid;
  const isProcessAlive = options.isProcessAlive ?? processAlive;
  const installRoot = path.join(
    options.baseDir,
    "tools",
    "chrome-headless-shell",
    release?.platform ?? `${platform}-${arch}`,
  );
  const executableName =
    platform === "win32" ? "chrome-headless-shell.exe" : "chrome-headless-shell";
  const gate = yield* Semaphore.make(1);
  let state: InstallState = { _tag: "idle" };
  const progress = { downloadedBytes: 0, unpacking: false };

  const executablePath = (release: PreviewBrowserRelease) =>
    path.join(installRoot, release.version, executableName);

  // The version directory appears by one rename of a fully unpacked tree, so a
  // runnable binary there is the complete-install marker.
  const installedExecutable = (release: PreviewBrowserRelease) => {
    const executable = executablePath(release);
    return fs.stat(executable).pipe(
      Effect.map((info) =>
        info.type === "File" && (platform === "win32" || (info.mode & 0o111) !== 0)
          ? Option.some(executable)
          : Option.none<string>(),
      ),
      Effect.orElseSucceed(() => Option.none<string>()),
    );
  };

  const partialPath = (release: PreviewBrowserRelease) =>
    path.join(installRoot, `${PARTIAL_PREFIX}${release.version}.zip`);

  const moveTo = (from: string, to: string) =>
    fs.rename(from, to).pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    );

  /**
   * Moves the download of an install of `release` on this host whose process
   * is gone (killed before it could keep its download, as quitting the
   * desktop app does to its server) to `archivePath`. Removes each such
   * install's staging directory, which nothing else uses any more.
   */
  const claimKilledInstall = (release: PreviewBrowserRelease, archivePath: string) =>
    Effect.gen(function* () {
      const prefix = stagingPrefixOf(release.version);
      for (const name of yield* fs.readDirectory(installRoot)) {
        if (!name.startsWith(prefix)) continue;
        const owner = Number(/^(\d+)-/.exec(name.slice(prefix.length))?.[1]);
        if (!(owner > 0) || owner === pid || isProcessAlive(owner)) continue;
        const staging = path.join(installRoot, name);
        const claimed = yield* moveTo(path.join(staging, ARCHIVE_NAME), archivePath);
        yield* fs.remove(staging, { recursive: true, force: true }).pipe(Effect.ignore);
        if (claimed) return true;
      }
      return false;
    }).pipe(Effect.orElseSucceed(() => false));

  /**
   * Moves the partial download an earlier attempt left behind to `archivePath`
   * and returns how many bytes it holds, 0 when there is none to resume: the
   * one an install that stopped kept, else a killed install's. The rename
   * hands it to exactly one install when several servers on this machine
   * start at once; the others start over.
   */
  const claimPartial = (release: PreviewBrowserRelease, archivePath: string) =>
    Effect.gen(function* () {
      const claimed =
        (yield* moveTo(partialPath(release), archivePath)) ||
        (yield* claimKilledInstall(release, archivePath));
      if (!claimed) return 0;
      // Only a plain file is appended to, never what a link points at.
      const linked = yield* fs.readLink(archivePath).pipe(
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      );
      const info = linked ? undefined : yield* fs.stat(archivePath);
      const size = info?.type === "File" ? Number(info.size) : undefined;
      if (size !== undefined && size <= release.bytes) return size;
      yield* fs.remove(archivePath, { recursive: true, force: true });
      return 0;
    }).pipe(Effect.orElseSucceed(() => 0));

  // A redirect, to any host, fails the download instead of being followed.
  const get = (release: PreviewBrowserRelease, offset: number) =>
    http
      .execute(
        offset === 0
          ? HttpClientRequest.get(release.url)
          : HttpClientRequest.get(release.url).pipe(
              HttpClientRequest.setHeader("range", `bytes=${offset}-`),
            ),
      )
      .pipe(
        Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
        Effect.timeoutOrElse({
          duration: DOWNLOAD_IDLE_TIMEOUT,
          orElse: () => Effect.fail(downloadStalled()),
        }),
        Effect.mapError(wrapFailure(NETWORK_FAILURE)),
      );

  // Lets go of a response whose body is not wanted: opening its stream and
  // closing it after a chunk aborts the request.
  const discardBody = (response: HttpClientResponse.HttpClientResponse) =>
    response.stream.pipe(Stream.take(1), Stream.runDrain, Effect.ignore);

  /**
   * The response to continue the archive from `offset`, and the offset its
   * body starts at: the rest of the archive when the server resumes it, else
   * the whole archive from zero.
   */
  const request = Effect.fnUntraced(function* (release: PreviewBrowserRelease, offset: number) {
    if (offset > 0) {
      const resumed = yield* get(release, offset);
      if (
        resumed.status === 206 &&
        resumesPreviewBrowserDownload(resumed.headers, offset, release.bytes)
      ) {
        return { response: resumed, offset };
      }
      if (resumed.status === 200) return { response: resumed, offset: 0 };
      // Any other answer cannot continue what is on disk, so start over.
      yield* discardBody(resumed);
    }
    const response = yield* get(release, 0);
    if (response.status !== 200) {
      yield* discardBody(response);
      return yield* new PreviewBrowserInstallError({
        detail: `storage.googleapis.com answered the download with HTTP ${response.status}. Check this machine's network access.`,
      });
    }
    return { response, offset: 0 };
  });

  /** The archive's exact size and SHA-256, read back from disk. */
  const verify = Effect.fnUntraced(function* (
    release: PreviewBrowserRelease,
    archivePath: string,
    archive: DownloadedArchive,
  ) {
    const size = Number(
      (yield* fs.stat(archivePath).pipe(Effect.mapError(wrapFailure(SAVE_FAILURE)))).size,
    );
    // What arrived is a true start of the archive; the next attempt resumes it.
    if (size < release.bytes) {
      return yield* new PreviewBrowserInstallError({
        detail:
          "The download from storage.googleapis.com ended early. Check this machine's network access.",
      });
    }
    const hash = NodeCrypto.createHash("sha256");
    yield* fs.stream(archivePath, { chunkSize: 1024 * 1024 }).pipe(
      Stream.runForEach((chunk) => Effect.sync(() => hash.update(chunk))),
      Effect.mapError(wrapFailure(SAVE_FAILURE)),
    );
    if (size !== release.bytes || hash.digest("hex") !== release.sha256) {
      archive.keep = false;
      return yield* new PreviewBrowserInstallError({
        detail: "The download failed its size or SHA-256 check. Nothing was installed.",
      });
    }
  });

  /**
   * Downloads the archive to `archivePath`, resuming a partial one an earlier
   * attempt left, and verifies the whole file. Clears `archive.keep` when what
   * is on disk can never become the pinned archive.
   */
  const download = Effect.fn("PreviewBrowser.download")(
    function* (release: PreviewBrowserRelease, archivePath: string, archive: DownloadedArchive) {
      if (!isPreviewBrowserDownloadUrl(release.url)) {
        return yield* new PreviewBrowserInstallError({
          detail: "Its download address is not Chrome for Testing's storage.googleapis.com bucket.",
        });
      }
      const onDisk = yield* claimPartial(release, archivePath);
      progress.downloadedBytes = onDisk;
      if (onDisk < release.bytes) {
        const { response, offset } = yield* request(release, onDisk);
        progress.downloadedBytes = offset;
        // Starting over: what was kept goes, and the new file is created fresh.
        if (offset === 0 && onDisk > 0) {
          yield* fs.remove(archivePath).pipe(Effect.mapError(wrapFailure(SAVE_FAILURE)));
        }
        const contentLength = response.headers["content-length"];
        const contentEncoding = response.headers["content-encoding"]?.trim().toLowerCase();
        if (
          (contentEncoding === undefined || contentEncoding === "identity") &&
          contentLength !== undefined &&
          Number(contentLength) !== release.bytes - offset
        ) {
          yield* discardBody(response);
          return yield* new PreviewBrowserInstallError({
            detail: "The download size did not match the pinned release.",
          });
        }
        yield* response.stream.pipe(
          Stream.timeoutOrElse({
            duration: DOWNLOAD_IDLE_TIMEOUT,
            orElse: () => Stream.fail(downloadStalled()),
          }),
          Stream.mapError(wrapFailure(NETWORK_FAILURE)),
          Stream.tap((chunk) =>
            Effect.suspend(() => {
              progress.downloadedBytes += chunk.byteLength;
              if (progress.downloadedBytes > release.bytes) {
                archive.keep = false;
                return Effect.fail(
                  new PreviewBrowserInstallError({
                    detail: "The download was larger than the pinned release.",
                  }),
                );
              }
              return Effect.void;
            }),
          ),
          // Writing the archive fails on this machine, not the network.
          Stream.run(
            fs
              .sink(archivePath, { flag: offset > 0 ? "a" : "wx", mode: 0o600 })
              .pipe(Sink.mapError(wrapFailure(SAVE_FAILURE))),
          ),
        );
      }
      yield* verify(release, archivePath, archive);
    },
    Effect.timeoutOrElse({
      duration: DOWNLOAD_MAX_DURATION,
      orElse: () =>
        Effect.fail(
          new PreviewBrowserInstallError({
            detail: `The download from storage.googleapis.com did not finish within ${DOWNLOAD_MAX_DURATION}. Check this machine's network access.`,
          }),
        ),
    }),
    Effect.mapError(wrapFailure(NETWORK_FAILURE)),
  );

  /** Leaves a download that got anywhere where the next attempt resumes it. */
  const keepPartial = (release: PreviewBrowserRelease, archivePath: string) =>
    fs.stat(archivePath).pipe(
      Effect.flatMap((info) =>
        info.type === "File" && Number(info.size) > 0
          ? fs.rename(archivePath, partialPath(release))
          : Effect.void,
      ),
      Effect.catch((cause) =>
        cause._tag === "PlatformError" && cause.reason._tag === "NotFound"
          ? Effect.void
          : Effect.logDebug("Could not keep a partial HTML preview browser download.", { cause }),
      ),
    );

  /**
   * Unpacks a verified archive. One that unpacks to no browser is never kept;
   * one that could not be written is, so the next attempt skips the download.
   */
  const extract = Effect.fn("PreviewBrowser.extract")(function* (
    release: PreviewBrowserRelease,
    archivePath: string,
    destination: string,
    archive: DownloadedArchive,
  ) {
    const files = yield* extractZipArchive({
      archivePath,
      destination,
      // Everything sits under the one top directory, which is stripped.
      stripPrefix: `chrome-headless-shell-${release.platform}/`,
      maxEntries: MAX_ARCHIVE_ENTRIES,
      maxTotalBytes: MAX_UNPACKED_BYTES,
    }).pipe(
      Effect.mapError((error) => {
        if (error.kind === "invalid") archive.keep = false;
        return new PreviewBrowserInstallError({
          detail:
            error.kind === "invalid"
              ? `The browser archive was rejected: ${error.detail}`
              : "Could not unpack the browser. Check free disk space in Ryco's data directory.",
          cause: error,
        });
      }),
    );
    if (!files.includes(executableName)) {
      archive.keep = false;
      return yield* new PreviewBrowserInstallError({
        detail: "The archive does not contain chrome-headless-shell.",
      });
    }
  });

  /** Moves an unpacked tree into place, unless another Ryco server finished first. */
  const publish = Effect.fn("PreviewBrowser.publish")(function* (
    release: PreviewBrowserRelease,
    unpacked: string,
  ) {
    if (Option.isSome(yield* installedExecutable(release))) return;
    const destination = path.join(installRoot, release.version);
    // A version directory without a runnable binary is incomplete and would block the rename.
    yield* fs.remove(destination, { recursive: true, force: true });
    yield* fs
      .rename(unpacked, destination)
      .pipe(
        Effect.catch((cause) =>
          installedExecutable(release).pipe(
            Effect.flatMap((installed) =>
              Option.isSome(installed) ? Effect.void : Effect.fail(cause),
            ),
          ),
        ),
      );
  });

  let markedUsedAt: number | undefined;
  /** Tells other servers sharing the install root that this server runs `release`. */
  const markUsed = (release: PreviewBrowserRelease) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      if (markedUsedAt !== undefined && now - markedUsedAt < MARK_USED_EVERY_MS) return;
      markedUsedAt = now;
      const marker = path.join(installRoot, release.version, LAST_USED_MARKER);
      yield* fs.writeFileString(marker, "");
      // Node reads a numeric time as seconds, so pass a Date.
      yield* fs.utimes(marker, new Date(now), new Date(now));
    }).pipe(
      Effect.catch((cause) =>
        Effect.logDebug("Could not mark the HTML preview browser as in use.", { cause }),
      ),
    );

  const modifiedAt = (target: string, fallback: number) =>
    fs
      .stat(target)
      .pipe(
        Effect.map((info) =>
          Option.match(info.mtime, { onNone: () => fallback, onSome: (date) => date.getTime() }),
        ),
      );

  // Older builds, their partial downloads, and abandoned staging directories.
  // Servers on this machine share the install root, and builds pinning other
  // versions may run beside this one: a staging directory touched within the
  // last two hours may be another server's install in progress, and a version
  // some server used within the last week (or installed or partly downloaded
  // then, before any marked it) is still that server's browser. Both stay.
  const removeStale = Effect.fn("PreviewBrowser.removeStale")(function* (
    release: PreviewBrowserRelease,
    which: "versions-and-staging" | "staging",
  ) {
    const entries = yield* fs.readDirectory(installRoot);
    const now = yield* Clock.currentTimeMillis;
    yield* Effect.forEach(
      entries.filter((name) => name !== release.version),
      (name) =>
        Effect.gen(function* () {
          const target = path.join(installRoot, name);
          const staging = name.startsWith(STAGING_PREFIX);
          if (!staging && which === "staging") return;
          const lastUsedAt = staging
            ? yield* modifiedAt(target, now)
            : yield* modifiedAt(path.join(target, LAST_USED_MARKER), now).pipe(
                Effect.catch(() => modifiedAt(target, now)),
              );
          const staleAfter = staging ? STAGING_STALE_AFTER_MS : UNUSED_VERSION_STALE_AFTER_MS;
          if (now - lastUsedAt < staleAfter) return;
          yield* fs.remove(target, { recursive: true, force: true });
        }).pipe(
          Effect.catch((cause) =>
            Effect.logWarning("Could not remove an old HTML preview browser.", { name, cause }),
          ),
        ),
      { discard: true },
    );
  });

  // An install that was killed mid-way (a crash, power loss, SIGKILL) leaves
  // its staging directory behind; the first server to find the browser
  // installed sweeps it, once per process.
  let sweptStaging = false;
  const sweepStagingOnce = (release: PreviewBrowserRelease) =>
    Effect.suspend(() => {
      if (sweptStaging) return Effect.void;
      sweptStaging = true;
      return removeStale(release, "staging").pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Could not sweep abandoned HTML preview browser installs.", { cause }),
        ),
        Effect.forkIn(serviceScope),
        Effect.asVoid,
      );
    });

  const install = Effect.fn("PreviewBrowser.install")(
    function* (release: PreviewBrowserRelease) {
      yield* fs.makeDirectory(installRoot, { recursive: true });
      yield* Effect.gen(function* () {
        // Staging shares the install root's file system so publishing is one rename.
        const staging = yield* fs.makeTempDirectoryScoped({
          directory: installRoot,
          prefix: previewBrowserStagingPrefix(release.version, pid),
        });
        const archivePath = path.join(staging, ARCHIVE_NAME);
        const unpacked = path.join(staging, "browser");
        const archive: DownloadedArchive = { keep: true };
        yield* Effect.gen(function* () {
          yield* download(release, archivePath, archive);
          progress.unpacking = true;
          yield* extract(release, archivePath, unpacked, archive);
          yield* publish(release, unpacked);
        }).pipe(
          // Before staging goes: an install that fails or is stopped (a lost
          // connection, a server restart) keeps what it downloaded for the next.
          Effect.onExit((exit) =>
            Exit.isFailure(exit) && archive.keep ? keepPartial(release, archivePath) : Effect.void,
          ),
        );
      }).pipe(Effect.scoped);
      // Another server's download of this version is of no use any more.
      yield* fs.remove(partialPath(release), { force: true }).pipe(Effect.ignore);
      yield* markUsed(release);
      yield* removeStale(release, "versions-and-staging");
      return executablePath(release);
    },
    Effect.mapError(wrapFailure("Could not save the browser in Ryco's data directory.")),
  );

  // Joins the current install or starts one. A failure is reported once, then cleared.
  const join = (release: PreviewBrowserRelease) =>
    gate.withPermit(
      Effect.gen(function* () {
        if (state._tag === "installing") return state;
        if (state._tag === "failed") {
          const failed = state;
          state = { _tag: "idle" };
          return failed;
        }
        const installed = yield* installedExecutable(release);
        if (Option.isSome(installed)) {
          state = { _tag: "installed", executable: installed.value };
          yield* sweepStagingOnce(release);
          return state;
        }
        const done = yield* Deferred.make<string, PreviewBrowserInstallError>();
        progress.downloadedBytes = 0;
        progress.unpacking = false;
        const installing: InstallState = { _tag: "installing", done };
        state = installing;
        yield* install(release).pipe(
          Effect.onExit((exit) =>
            gate
              .withPermit(
                Effect.sync(() => {
                  state = Exit.isSuccess(exit)
                    ? { _tag: "installed", executable: exit.value }
                    : {
                        _tag: "failed",
                        error: Option.getOrElse(
                          Cause.findErrorOption(exit.cause),
                          () => new PreviewBrowserInstallError({ detail: "The install stopped." }),
                        ),
                      };
                }),
              )
              .pipe(Effect.andThen(Deferred.done(done, exit))),
          ),
          Effect.tapCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.void
              : Effect.logWarning("Could not install the HTML preview browser.", { cause }),
          ),
          Effect.ignoreCause,
          // Server shutdown closes the service scope and stops an install in progress.
          Effect.interruptible,
          Effect.forkIn(serviceScope),
        );
        return installing;
      }),
    );

  // A waiter that saw the failure has reported it; the next call retries.
  const clearFailure = (error: PreviewBrowserInstallError) =>
    gate.withPermit(
      Effect.sync(() => {
        if (state._tag === "failed" && state.error === error) state = { _tag: "idle" };
      }),
    );

  const executable = Effect.gen(function* () {
    if (release === null) {
      return yield* new PreviewBrowserUnsupportedError({ platform, arch });
    }
    // Someone may have removed the browser since it was installed.
    if (state._tag === "installed" && Option.isNone(yield* installedExecutable(release))) {
      yield* gate.withPermit(
        Effect.sync(() => {
          if (state._tag === "installed") state = { _tag: "idle" };
        }),
      );
    }
    const current = yield* join(release);
    switch (current._tag) {
      case "installed":
        yield* markUsed(release);
        return current.executable;
      case "failed":
        return yield* current.error;
      case "installing":
        return yield* Deferred.await(current.done).pipe(
          Effect.tapError(clearFailure),
          Effect.timeoutOrElse({
            duration: wait,
            orElse: () =>
              Effect.fail(
                new PreviewBrowserInstallingError({
                  downloadedBytes: progress.downloadedBytes,
                  totalBytes: release.bytes,
                  unpacking: progress.unpacking,
                }),
              ),
          }),
        );
    }
  }).pipe(Effect.withSpan("PreviewBrowser.executable"));

  // Measuring runs the browser too, so it marks the version in use as well.
  const installed =
    release === null
      ? Effect.succeedNone
      : installedExecutable(release).pipe(
          Effect.tap((executable) => (Option.isSome(executable) ? markUsed(release) : Effect.void)),
        );

  return PreviewBrowser.of({ executable, installed });
});

/** The preview browser installed under Ryco's machine-wide `baseDir`, shared by every server on this machine. */
export const PreviewBrowserLive = Layer.effect(
  PreviewBrowser,
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    return yield* makePreviewBrowser({ baseDir: config.baseDir });
  }),
);
