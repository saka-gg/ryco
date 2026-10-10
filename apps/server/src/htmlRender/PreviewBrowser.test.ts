// @effect-diagnostics nodeBuiltinImport:off - hashes fixture archives.
import * as NodeCrypto from "node:crypto";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  DateTime,
  Deferred,
  Effect,
  Fiber,
  FileSystem,
  Option,
  Path,
  PlatformError,
  Queue,
  Sink,
  Stream,
} from "effect";
import type { Duration } from "effect";
import { TestClock } from "effect/testing";
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/unstable/http";

import { makeZip } from "../zipArchive.fixtures.ts";
import * as PreviewBrowser from "./PreviewBrowser.ts";

// POSIX modes cannot be checked on NTFS, so follow the host.
const hostPlatform: NodeJS.Platform = process.platform === "win32" ? "win32" : "linux";
const executableName =
  hostPlatform === "win32" ? "chrome-headless-shell.exe" : "chrome-headless-shell";
const ROOT = "chrome-headless-shell-fixture/";
const FIXTURE_URL =
  "https://storage.googleapis.com/chrome-for-testing-public/1.2.3/fixture/chrome-headless-shell-fixture.zip";

const browserArchive = makeZip([
  { name: ROOT, mode: 0o40755 },
  { name: `${ROOT}${executableName}`, data: "#!/bin/sh\n", mode: 0o100755, method: 8 },
  { name: `${ROOT}libEGL.so`, data: "library", mode: 0o100755 },
  { name: `${ROOT}locales/`, mode: 0o40755 },
  { name: `${ROOT}locales/en-US.pak`, data: "strings", mode: 0o100644, method: 8 },
]);

const sha256 = (bytes: Uint8Array) => NodeCrypto.createHash("sha256").update(bytes).digest("hex");

/** What the fake bucket answers one request with. */
interface FakeResponse {
  readonly status?: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body: Stream.Stream<Uint8Array, unknown>;
}

/** The rest of `archive` from `offset`, as the bucket resumes a download. */
const partialContent = (archive: Buffer, offset: number): FakeResponse => ({
  status: 206,
  headers: {
    "content-range": `bytes ${offset}-${archive.byteLength - 1}/${archive.byteLength}`,
    "content-length": String(archive.byteLength - offset),
  },
  body: Stream.make(archive.subarray(offset)),
});

const makeHarness = Effect.fn("test.makePreviewBrowser")(function* (
  options: {
    readonly archive?: Buffer;
    readonly sha256?: string;
    readonly url?: string;
    readonly body?: Stream.Stream<Uint8Array, unknown>;
    /** Answers each request by its `Range` header; overrides `body`. */
    readonly respond?: (range: string | undefined) => FakeResponse;
    readonly wait?: Duration.Input;
    readonly unsupported?: boolean;
    /** Another server's machine-wide data directory to share. */
    readonly baseDir?: string;
    readonly version?: string;
    readonly fileSystem?: (fs: FileSystem.FileSystem) => FileSystem.FileSystem;
    readonly pid?: number;
    readonly isProcessAlive?: (pid: number) => boolean;
  } = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const baseDir =
    options.baseDir ??
    (yield* fs.makeTempDirectoryScoped({ prefix: "ryco-preview-browser-test-" }));
  const archive = options.archive ?? browserArchive;
  const requests: Array<string> = [];
  const ranges: Array<string | undefined> = [];
  const browser = yield* PreviewBrowser.makePreviewBrowser({
    baseDir,
    platform: hostPlatform,
    arch: "x64",
    release: options.unsupported
      ? null
      : {
          version: options.version ?? "1.2.3",
          platform: "fixture",
          url: options.url ?? FIXTURE_URL,
          bytes: archive.byteLength,
          sha256: options.sha256 ?? sha256(archive),
        },
    ...(options.wait === undefined ? {} : { wait: options.wait }),
    ...(options.pid === undefined ? {} : { pid: options.pid }),
    ...(options.isProcessAlive === undefined ? {} : { isProcessAlive: options.isProcessAlive }),
  }).pipe(
    Effect.provideService(FileSystem.FileSystem, options.fileSystem?.(fs) ?? fs),
    Effect.provideService(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.sync(() => {
          requests.push(request.url);
          const range = request.headers.range;
          ranges.push(range);
          const answer: FakeResponse = options.respond?.(range) ?? {
            body: options.body ?? Stream.make(archive.subarray(0, 40), archive.subarray(40)),
          };
          const response = HttpClientResponse.fromWeb(
            request,
            new Response(null, { status: answer.status ?? 200, headers: answer.headers ?? {} }),
          );
          return Object.defineProperty(response, "stream", { value: answer.body });
        }),
      ),
    ),
  );
  const installRoot = path.join(baseDir, "tools", "chrome-headless-shell", "fixture");
  const partial = path.join(installRoot, ".download-1.2.3.zip");
  return { browser, fs, path, baseDir, installRoot, partial, requests, ranges };
});

/** A download that delivers `bytes` and then loses its connection. */
const brokenAfter = (bytes: number): Stream.Stream<Uint8Array, unknown> =>
  Stream.concat(
    Stream.make(browserArchive.subarray(0, bytes)),
    Stream.fail(new Error("connection reset")),
  );

it.layer(NodeServices.layer)("PreviewBrowser", (it) => {
  it.effect("installs a verified download with its file modes and then reuses it", () =>
    Effect.gen(function* () {
      const { browser, fs, path, installRoot, requests } = yield* makeHarness();
      const now = yield* DateTime.now;
      const ago = (parts: Partial<DateTime.DateTime.PartsForMath>) =>
        DateTime.toDate(DateTime.subtract(now, parts));
      const entry = Effect.fn(function* (name: string, modified: Date, lastUsed?: Date) {
        const target = path.join(installRoot, name);
        yield* fs.makeDirectory(target, { recursive: true });
        if (lastUsed !== undefined) {
          yield* fs.writeFileString(path.join(target, ".last-used"), "");
          yield* fs.utimes(path.join(target, ".last-used"), lastUsed, lastUsed);
        }
        yield* fs.utimes(target, modified, modified);
      });
      // Older builds: one no server marked for over a week, one another
      // build on this machine still uses, and one whose last use is old.
      yield* entry("1.0.0", ago({ days: 8 }));
      yield* entry("2.0.0", ago({ days: 30 }), ago({ days: 1 }));
      yield* entry("3.0.0", ago({ days: 1 }), ago({ days: 8 }));
      // Another server's install in progress, and one abandoned three hours ago.
      yield* entry(".install-other", ago({ minutes: 30 }));
      yield* entry(".install-abandoned", ago({ hours: 3 }));
      expect(yield* browser.installed).toEqual(Option.none());

      const executable = yield* browser.executable;

      const version = path.join(installRoot, "1.2.3");
      expect(executable).toBe(path.join(version, executableName));
      expect(yield* fs.readFileString(path.join(version, "locales", "en-US.pak"))).toBe("strings");
      if (hostPlatform !== "win32") {
        const mode = (file: string) =>
          fs.stat(path.join(version, file)).pipe(Effect.map((info) => info.mode & 0o777));
        expect(yield* mode(executableName)).toBe(0o755);
        expect(yield* mode("libEGL.so")).toBe(0o755);
        expect(yield* mode(path.join("locales", "en-US.pak"))).toBe(0o644);
      }
      // Unused builds and stale staging directories are gone; the rest stays.
      expect((yield* fs.readDirectory(installRoot)).toSorted()).toEqual([
        ".install-other",
        "1.2.3",
        "2.0.0",
      ]);
      expect(yield* fs.exists(path.join(version, ".last-used"))).toBe(true);
      expect(yield* browser.executable).toBe(executable);
      expect(yield* browser.installed).toEqual(Option.some(executable));
      expect(requests).toEqual([FIXTURE_URL]);
    }).pipe(Effect.scoped),
  );

  it.effect.each([
    { name: "a hash mismatch", sha256: "0".repeat(64) },
    {
      name: "an oversized download",
      body: Stream.make(browserArchive, Buffer.from("extra")),
    },
  ])("rejects $name, keeps nothing, and starts over on the next call", (testCase) =>
    Effect.gen(function* () {
      const { browser, fs, installRoot, requests, ranges } = yield* makeHarness(testCase);

      const error = yield* browser.executable.pipe(Effect.flip);

      expect(error._tag).toBe("PreviewBrowserInstallError");
      expect(error.message).toMatch(
        /^Ryco could not install its HTML preview browser: .+ Call ryco_html_preview again to retry\.$/,
      );
      expect(yield* fs.readDirectory(installRoot)).toEqual([]);
      yield* browser.executable.pipe(Effect.flip);
      expect(requests).toHaveLength(2);
      expect(ranges).toEqual([undefined, undefined]);
    }).pipe(Effect.scoped),
  );

  it.effect("resumes a download that lost its connection part-way with a range request", () =>
    Effect.gen(function* () {
      let attempt = 0;
      const { browser, fs, installRoot, partial, ranges } = yield* makeHarness({
        respond: (range) =>
          range === undefined
            ? { body: attempt++ === 0 ? brokenAfter(100) : Stream.make(browserArchive) }
            : partialContent(browserArchive, 100),
      });

      const error = yield* browser.executable.pipe(Effect.flip);
      expect(error.message).toContain(
        "The download from storage.googleapis.com failed. Check this machine's network access.",
      );
      // What arrived waits beside the installs, outside any staging directory.
      expect(yield* fs.readDirectory(installRoot)).toEqual([".download-1.2.3.zip"]);
      expect(Buffer.from(yield* fs.readFile(partial)).equals(browserArchive.subarray(0, 100))).toBe(
        true,
      );

      const executable = yield* browser.executable;

      expect(yield* fs.readFileString(executable)).toBe("#!/bin/sh\n");
      expect(ranges).toEqual([undefined, "bytes=100-"]);
      expect(yield* fs.readDirectory(installRoot)).toEqual(["1.2.3"]);
    }).pipe(Effect.scoped),
  );

  it.effect("resumes a download that ended early", () =>
    Effect.gen(function* () {
      const { browser, fs, partial, ranges } = yield* makeHarness({
        respond: (range) =>
          range === undefined
            ? { body: Stream.make(browserArchive.subarray(0, -1)) }
            : partialContent(browserArchive, browserArchive.byteLength - 1),
      });

      expect((yield* browser.executable.pipe(Effect.flip)).message).toContain(
        "The download from storage.googleapis.com ended early.",
      );
      expect(yield* fs.exists(partial)).toBe(true);
      yield* browser.executable;
      expect(ranges).toEqual([undefined, `bytes=${browserArchive.byteLength - 1}-`]);
    }).pipe(Effect.scoped),
  );

  it.effect("resumes a download a stopped server left, in the next server", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "ryco-preview-browser-test-" });
      const firstChunkSent = yield* Deferred.make<void>();
      // The first server stops mid-download, as when Ryco quits.
      const stopped = yield* Effect.gen(function* () {
        const { browser, partial } = yield* makeHarness({
          baseDir,
          wait: "2 hours",
          body: Stream.concat(
            Stream.make(browserArchive.subarray(0, 64)),
            Stream.fromEffect(
              Deferred.succeed(firstChunkSent, undefined).pipe(
                Effect.andThen(Effect.never),
                Effect.as(new Uint8Array()),
              ),
            ),
          ),
        });
        yield* Effect.forkScoped(browser.executable);
        yield* Deferred.await(firstChunkSent);
        return partial;
      }).pipe(Effect.scoped);

      expect((yield* fs.readFile(stopped)).byteLength).toBe(64);
      const restarted = yield* makeHarness({
        baseDir,
        respond: (range) =>
          range === "bytes=64-"
            ? partialContent(browserArchive, 64)
            : { body: Stream.fail(new Error("the resume was not requested")) },
      });
      expect(yield* restarted.browser.executable).toMatch(new RegExp(`${executableName}$`));
      expect(restarted.ranges).toEqual(["bytes=64-"]);
    }).pipe(Effect.scoped),
  );

  it.effect("names its staging directory after the version and the server installing it", () =>
    Effect.gen(function* () {
      const firstChunkSent = yield* Deferred.make<void>();
      const { browser, fs, path, installRoot } = yield* makeHarness({
        pid: 5000,
        wait: "2 hours",
        body: Stream.concat(
          Stream.make(browserArchive.subarray(0, 64)),
          Stream.fromEffect(
            Deferred.succeed(firstChunkSent, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.as(new Uint8Array()),
            ),
          ),
        ),
      });
      yield* Effect.forkScoped(browser.executable);
      yield* Deferred.await(firstChunkSent);

      const [staging, ...others] = yield* fs.readDirectory(installRoot);
      expect(others).toEqual([]);
      expect(staging).toMatch(
        new RegExp(
          `^${PreviewBrowser.previewBrowserStagingPrefix("1.2.3", 5000).replaceAll(".", "\\.")}`,
        ),
      );
      expect(yield* fs.readDirectory(path.join(installRoot, staging!))).toContain("download.zip");
    }).pipe(Effect.scoped),
  );

  it.effect("resumes the download of an install whose server was killed", () =>
    Effect.gen(function* () {
      // Another server on this machine (pid 4243) is still installing.
      const harness = yield* makeHarness({
        pid: 5000,
        isProcessAlive: (pid) => pid === 4243,
        respond: (range) =>
          range === "bytes=64-"
            ? partialContent(browserArchive, 64)
            : { body: Stream.fail(new Error("the resume was not requested")) },
      });
      const { fs, path, installRoot } = harness;
      const stagingOf = (pid: number, suffix: string) =>
        `${PreviewBrowser.previewBrowserStagingPrefix("1.2.3", pid)}${suffix}`;
      const install = Effect.fn(function* (name: string, downloaded: Uint8Array) {
        yield* fs.makeDirectory(path.join(installRoot, name, "browser"), { recursive: true });
        yield* fs.writeFile(path.join(installRoot, name, "download.zip"), downloaded);
      });
      // Killed mid-download, as quitting the desktop app ends its server.
      const killed = stagingOf(4242, "KILLED");
      yield* install(killed, browserArchive.subarray(0, 64));
      const running = stagingOf(4243, "RUNNING");
      yield* install(running, browserArchive.subarray(0, 100));
      // Another host sharing the data directory, whose processes this one cannot see.
      const tag = /-([0-9a-f]{8})-5000-$/.exec(
        PreviewBrowser.previewBrowserStagingPrefix("1.2.3", 5000),
      )![1]!;
      const otherHost = `.install-1.2.3-${tag === "00000000" ? "11111111" : "00000000"}-4242-HOST`;
      yield* install(otherHost, browserArchive.subarray(0, 100));

      yield* harness.browser.executable;

      expect(harness.ranges).toEqual(["bytes=64-"]);
      // The killed install is gone; the running one and the other host's stay.
      expect((yield* fs.readDirectory(installRoot)).toSorted()).toEqual(
        [otherHost, running, "1.2.3"].toSorted(),
      );
      expect((yield* fs.readFile(path.join(installRoot, running, "download.zip"))).byteLength).toBe(
        100,
      );
    }).pipe(Effect.scoped),
  );

  it.effect("leaves the download of another server's install in progress alone", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ pid: 5000, isProcessAlive: (pid) => pid === 4243 });
      const { fs, path, installRoot } = harness;
      const running = `${PreviewBrowser.previewBrowserStagingPrefix("1.2.3", 4243)}RUNNING`;
      yield* fs.makeDirectory(path.join(installRoot, running), { recursive: true });
      yield* fs.writeFile(
        path.join(installRoot, running, "download.zip"),
        browserArchive.subarray(0, 100),
      );

      yield* harness.browser.executable;

      expect(harness.ranges).toEqual([undefined]);
      expect((yield* fs.readFile(path.join(installRoot, running, "download.zip"))).byteLength).toBe(
        100,
      );
    }).pipe(Effect.scoped),
  );

  it.effect.each([
    {
      name: "the whole archive",
      resumed: () => ({ body: Stream.make(browserArchive) }),
      ranges: ["bytes=100-"],
    },
    {
      name: "a range that does not continue the download",
      resumed: () => ({ ...partialContent(browserArchive, 0), body: Stream.make(browserArchive) }),
      ranges: ["bytes=100-", undefined],
    },
    {
      name: "a range of a compressed body",
      resumed: () => {
        const answer = partialContent(browserArchive, 100);
        return { ...answer, headers: { ...answer.headers, "content-encoding": "gzip" } };
      },
      ranges: ["bytes=100-", undefined],
    },
    {
      name: "416 Range Not Satisfiable",
      resumed: () => ({ status: 416, body: Stream.empty }),
      ranges: ["bytes=100-", undefined],
    },
  ])("starts over when the resume is answered with $name", (testCase) =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        respond: (range) =>
          range === undefined ? { body: Stream.make(browserArchive) } : testCase.resumed(),
      });
      // A partial whose bytes are not the archive's: only a fresh download installs.
      yield* harness.fs.makeDirectory(harness.installRoot, { recursive: true });
      yield* harness.fs.writeFile(harness.partial, new Uint8Array(100).fill(0x58));

      yield* harness.browser.executable;

      expect(harness.ranges).toEqual(testCase.ranges);
      expect(yield* harness.fs.exists(harness.partial)).toBe(false);
    }).pipe(Effect.scoped),
  );

  it.effect("deletes a resumed download that fails its SHA-256 check", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        respond: (range) =>
          range === undefined
            ? { body: Stream.make(browserArchive) }
            : partialContent(browserArchive, 100),
      });
      yield* harness.fs.makeDirectory(harness.installRoot, { recursive: true });
      yield* harness.fs.writeFile(harness.partial, new Uint8Array(100).fill(0x58));

      expect((yield* harness.browser.executable.pipe(Effect.flip)).message).toContain(
        "The download failed its size or SHA-256 check. Nothing was installed.",
      );
      expect(yield* harness.fs.readDirectory(harness.installRoot)).toEqual([]);

      // The next call starts over instead of resuming the bad bytes.
      yield* harness.browser.executable;
      expect(harness.ranges).toEqual(["bytes=100-", undefined]);
    }).pipe(Effect.scoped),
  );

  it.effect("installs a kept download that is already complete without downloading", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* harness.fs.makeDirectory(harness.installRoot, { recursive: true });
      yield* harness.fs.writeFile(harness.partial, browserArchive);

      yield* harness.browser.executable;

      expect(harness.requests).toEqual([]);
      expect(yield* harness.fs.readDirectory(harness.installRoot)).toEqual(["1.2.3"]);
    }).pipe(Effect.scoped),
  );

  it.effect.skipIf(hostPlatform === "win32")(
    "never appends to a file a planted partial download links to",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        const target = harness.path.join(harness.baseDir, "victim.txt");
        yield* harness.fs.writeFileString(target, "keep me");
        yield* harness.fs.makeDirectory(harness.installRoot, { recursive: true });
        yield* harness.fs.symlink(target, harness.partial);

        yield* harness.browser.executable;

        expect(yield* harness.fs.readFileString(target)).toBe("keep me");
        expect(harness.ranges).toEqual([undefined]);
      }).pipe(Effect.scoped),
  );

  it.effect.each([
    { name: "a parent-directory entry", entry: `${ROOT}../escape` },
    { name: "an absolute entry", entry: "/escape" },
    { name: "an entry outside the top directory", entry: "escape" },
  ])("rejects an archive with $name", (testCase) =>
    Effect.gen(function* () {
      const archive = makeZip([
        { name: `${ROOT}${executableName}`, data: "#!/bin/sh\n", mode: 0o100755 },
        { name: testCase.entry, data: "escaped", mode: 0o100644 },
      ]);
      const { browser, fs, path, baseDir, installRoot } = yield* makeHarness({ archive });

      const error = yield* browser.executable.pipe(Effect.flip);

      expect(error).toMatchObject({ _tag: "PreviewBrowserInstallError" });
      expect(error.message).toContain("The browser archive was rejected");
      expect(yield* fs.readDirectory(installRoot)).toEqual([]);
      expect(yield* fs.exists(path.join(baseDir, "tools", "chrome-headless-shell", "escape"))).toBe(
        false,
      );
    }).pipe(Effect.scoped),
  );

  it.effect("rejects an archive without the headless shell", () =>
    Effect.gen(function* () {
      const archive = makeZip([{ name: `${ROOT}README`, data: "no browser here" }]);
      const { browser, fs, installRoot } = yield* makeHarness({ archive });
      expect((yield* browser.executable.pipe(Effect.flip)).message).toContain(
        "The archive does not contain chrome-headless-shell.",
      );
      expect(yield* fs.readDirectory(installRoot)).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.effect("never downloads from outside Chrome for Testing's bucket", () =>
    Effect.gen(function* () {
      const { browser, requests } = yield* makeHarness({
        url: "https://example.com/chrome-for-testing-public/chrome-headless-shell.zip",
      });
      expect((yield* browser.executable.pipe(Effect.flip)).message).toContain(
        "storage.googleapis.com",
      );
      expect(requests).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.effect("shares one install between callers and finishes it after they stop waiting", () =>
    Effect.gen(function* () {
      const firstChunkSent = yield* Deferred.make<void>();
      const finishDownload = yield* Deferred.make<void>();
      const { browser, requests } = yield* makeHarness({
        wait: "20 seconds",
        body: Stream.concat(
          Stream.make(browserArchive.subarray(0, 100)),
          Stream.fromEffect(
            Deferred.succeed(firstChunkSent, undefined).pipe(
              Effect.andThen(Deferred.await(finishDownload)),
              Effect.as(browserArchive.subarray(100)),
            ),
          ),
        ),
      });

      const callers = yield* Effect.forEach([1, 2], () =>
        Effect.forkChild(browser.executable.pipe(Effect.flip)),
      );
      yield* Deferred.await(firstChunkSent);
      yield* TestClock.adjust("20 seconds");
      for (const caller of callers) {
        const error = yield* Fiber.join(caller);
        expect(error).toMatchObject({
          _tag: "PreviewBrowserInstallingError",
          downloadedBytes: 100,
          unpacking: false,
        });
        expect(error.message).toMatch(
          /^Ryco is installing its HTML preview browser \(0 of 0 MB downloaded\)\. Call ryco_html_preview again in a minute\.$/,
        );
      }

      // The install belongs to the service, so it outlives the callers that gave up on it.
      yield* Deferred.succeed(finishDownload, undefined);
      expect(yield* browser.executable).toMatch(new RegExp(`${executableName}$`));
      expect(requests).toHaveLength(1);
    }).pipe(Effect.scoped),
  );

  it.effect("reinstalls when the installed browser was removed", () =>
    Effect.gen(function* () {
      const { browser, fs, requests } = yield* makeHarness();
      const executable = yield* browser.executable;
      yield* fs.remove(executable);
      expect(yield* browser.installed).toEqual(Option.none());
      expect(yield* browser.executable).toBe(executable);
      expect(requests).toHaveLength(2);
    }).pipe(Effect.scoped),
  );

  it.effect("leaves the version another build on this machine pins in place", () =>
    Effect.gen(function* () {
      const first = yield* makeHarness({ version: "1.2.3" });
      const second = yield* makeHarness({ baseDir: first.baseDir, version: "2.0.0" });

      const firstExecutable = yield* first.browser.executable;
      yield* second.browser.executable;
      expect(yield* first.browser.executable).toBe(firstExecutable);
      expect(yield* second.browser.executable).toMatch(new RegExp(`2\\.0\\.0.${executableName}$`));

      // Each installed once, and neither removed the other's build.
      expect(first.requests).toHaveLength(1);
      expect(second.requests).toHaveLength(1);
      expect((yield* first.fs.readDirectory(first.installRoot)).toSorted()).toEqual([
        "1.2.3",
        "2.0.0",
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect("sweeps an abandoned install once the browser is already installed", () =>
    Effect.gen(function* () {
      const { browser, fs, path, baseDir, installRoot } = yield* makeHarness();
      const executable = yield* browser.executable;
      // A server killed mid-install three hours ago, and one installing now.
      const now = yield* DateTime.now;
      const abandoned = path.join(installRoot, ".install-abandoned");
      const active = path.join(installRoot, ".install-active");
      yield* fs.makeDirectory(abandoned);
      yield* fs.writeFileString(path.join(abandoned, "download.zip"), "partial");
      yield* fs.makeDirectory(active);
      const threeHoursAgo = DateTime.toDate(DateTime.subtract(now, { hours: 3 }));
      yield* fs.utimes(abandoned, threeHoursAgo, threeHoursAgo);

      // A later server process finds the browser installed and downloads nothing.
      const restarted = yield* makeHarness({ baseDir });
      expect(yield* restarted.browser.executable).toBe(executable);
      for (let attempt = 0; attempt < 200 && (yield* fs.exists(abandoned)); attempt += 1) {
        yield* TestClock.withLive(Effect.sleep("10 millis"));
      }
      expect((yield* fs.readDirectory(installRoot)).toSorted()).toEqual([
        ".install-active",
        "1.2.3",
      ]);
      expect(restarted.requests).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.effect("says a download that could not be written is a local disk problem", () =>
    Effect.gen(function* () {
      const { browser, requests } = yield* makeHarness({
        fileSystem: (fs) => ({
          ...fs,
          sink: () =>
            Sink.fail(
              PlatformError.systemError({
                _tag: "Unknown",
                module: "FileSystem",
                method: "sink",
                description: "ENOSPC: no space left on device",
              }),
            ),
        }),
      });

      const error = yield* browser.executable.pipe(Effect.flip);

      expect(error.message).toBe(
        "Ryco could not install its HTML preview browser: Could not save the download. Check free disk space in Ryco's data directory. Call ryco_html_preview again to retry.",
      );
      expect(requests).toHaveLength(1);
    }).pipe(Effect.scoped),
  );

  it.effect("fails a download that stops receiving data for a minute", () =>
    Effect.gen(function* () {
      const stalled = yield* Deferred.make<void>();
      const { browser, fs, installRoot } = yield* makeHarness({
        wait: "2 hours",
        body: Stream.concat(
          Stream.make(browserArchive.subarray(0, 100)),
          Stream.fromEffect(
            Deferred.succeed(stalled, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.as(new Uint8Array()),
            ),
          ),
        ),
      });

      const caller = yield* Effect.forkChild(browser.executable.pipe(Effect.flip));
      yield* Deferred.await(stalled);
      // In two steps, so the idle timer fires even when it starts a moment late.
      yield* TestClock.adjust("30 seconds");
      yield* TestClock.adjust("31 seconds");
      const error = yield* Fiber.join(caller);

      expect(error.message).toBe(
        "Ryco could not install its HTML preview browser: The download from storage.googleapis.com stalled: nothing arrived for 60 seconds. Check this machine's network access. Call ryco_html_preview again to retry.",
      );
      // What did arrive is kept for the next attempt to resume.
      expect(yield* fs.readDirectory(installRoot)).toEqual([".download-1.2.3.zip"]);
    }).pipe(Effect.scoped),
  );

  it.effect("finishes a slow download that keeps receiving data past fifteen minutes", () =>
    Effect.gen(function* () {
      const chunks = 20;
      const size = Math.ceil(browserArchive.byteLength / chunks);
      const pulled = yield* Queue.unbounded<number>();
      const release = Array.from({ length: chunks }, () => Deferred.makeUnsafe<void>());
      const { browser, requests } = yield* makeHarness({
        wait: "2 hours",
        body: Stream.fromIterable(release.keys()).pipe(
          Stream.mapEffect((index) =>
            Queue.offer(pulled, index).pipe(
              Effect.andThen(Deferred.await(release[index]!)),
              Effect.as(browserArchive.subarray(index * size, (index + 1) * size)),
            ),
          ),
        ),
      });

      const caller = yield* Effect.forkChild(browser.executable);
      // A chunk every 59 seconds: about 20 minutes in all, never a minute idle.
      for (let chunk = 0; chunk < chunks; chunk += 1) {
        const index = yield* Queue.take(pulled);
        yield* TestClock.adjust("59 seconds");
        yield* Deferred.succeed(release[index]!, undefined);
      }

      expect(yield* Fiber.join(caller)).toMatch(new RegExp(`${executableName}$`));
      expect(requests).toHaveLength(1);
    }).pipe(Effect.scoped),
  );

  it.effect("reports hosts Chrome for Testing does not build for without downloading", () =>
    Effect.gen(function* () {
      const { browser, requests } = yield* makeHarness({ unsupported: true });
      const error = yield* browser.executable.pipe(Effect.flip);
      expect(error._tag).toBe("PreviewBrowserUnsupportedError");
      expect(error.message).toBe(
        "HTML previews are not available on linux-x64: Chrome for Testing has no headless shell for it. ryco_html_render still works without a preview; pass it height 2000, since an unmeasured frame shrinks to the page but never grows past height.",
      );
      expect(yield* browser.installed).toEqual(Option.none());
      expect(requests).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.effect("downloads with fetch redirects off, so a redirect fails the install", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "ryco-preview-browser-test-" });
      const calls: Array<{ readonly url: string; readonly redirect: string | undefined }> = [];
      const fetchStub: typeof globalThis.fetch = Object.assign(
        (input: string | URL | Request, init?: RequestInit) => {
          calls.push({ url: String(input), redirect: init?.redirect });
          return Promise.resolve(
            new Response(null, {
              status: 302,
              headers: { location: "https://attacker.example/chrome.zip" },
            }),
          );
        },
        { preconnect: globalThis.fetch.preconnect },
      );
      const browser = yield* PreviewBrowser.makePreviewBrowser({
        baseDir,
        platform: hostPlatform,
        arch: "x64",
        release: {
          version: "1.2.3",
          platform: "fixture",
          url: FIXTURE_URL,
          bytes: browserArchive.byteLength,
          sha256: sha256(browserArchive),
        },
      }).pipe(Effect.provide(FetchHttpClient.layer));

      const error = yield* browser.executable.pipe(
        Effect.flip,
        Effect.provideService(FetchHttpClient.Fetch, fetchStub),
      );

      expect(error._tag).toBe("PreviewBrowserInstallError");
      expect(error.message).toContain(
        "storage.googleapis.com answered the download with HTTP 302.",
      );
      expect(calls).toEqual([{ url: FIXTURE_URL, redirect: "manual" }]);
    }).pipe(Effect.scoped),
  );
});

it("pins one Chrome for Testing build per host", () => {
  const hosts = [
    ["linux", "x64"],
    ["linux", "arm64"],
    ["darwin", "arm64"],
    ["darwin", "x64"],
    ["win32", "x64"],
    ["win32", "arm64"],
    ["win32", "ia32"],
    ["linux", "ia32"],
    ["freebsd", "x64"],
  ] as const;
  expect(
    hosts.map(([platform, arch]) => PreviewBrowser.previewBrowserRelease(platform, arch)?.platform),
  ).toEqual([
    "linux64",
    "linux-arm64",
    "mac-arm64",
    "mac-x64",
    "win64",
    "win64",
    "win32",
    undefined,
    undefined,
  ]);
  const mac = PreviewBrowser.previewBrowserRelease("darwin", "arm64");
  expect(mac).toMatchObject({
    url: "https://storage.googleapis.com/chrome-for-testing-public/154.0.8037.92/mac-arm64/chrome-headless-shell-mac-arm64.zip",
    bytes: 99_221_129,
  });
  for (const [platform, arch] of hosts) {
    const release = PreviewBrowser.previewBrowserRelease(platform, arch);
    if (release) expect(PreviewBrowser.isPreviewBrowserDownloadUrl(release.url)).toBe(true);
  }
});

it("accepts only Chrome for Testing's public bucket as a download address", () => {
  for (const url of [
    "http://storage.googleapis.com/chrome-for-testing-public/x.zip",
    "https://storage.googleapis.com.evil.example/chrome-for-testing-public/x.zip",
    "https://storage.googleapis.com:8443/chrome-for-testing-public/x.zip",
    "https://user@storage.googleapis.com/chrome-for-testing-public/x.zip",
    "https://storage.googleapis.com/other-bucket/x.zip",
    "https://storage.googleapis.com/chrome-for-testing-public/x.zip?redirect=1",
    "not a url",
  ]) {
    expect(PreviewBrowser.isPreviewBrowserDownloadUrl(url)).toBe(false);
  }
});

it("tells the agent how far the install has come", () => {
  expect(
    new PreviewBrowser.PreviewBrowserInstallingError({
      downloadedBytes: 37_200_000,
      totalBytes: 99_221_129,
      unpacking: false,
    }).message,
  ).toBe(
    "Ryco is installing its HTML preview browser (37 of 99 MB downloaded). Call ryco_html_preview again in a minute.",
  );
  expect(
    new PreviewBrowser.PreviewBrowserInstallingError({
      downloadedBytes: 99_221_129,
      totalBytes: 99_221_129,
      unpacking: true,
    }).message,
  ).toContain("(unpacking)");
});

it("appends only a 206 that continues the download exactly where it stopped", () => {
  const resumes = (headers: Record<string, string>) =>
    PreviewBrowser.resumesPreviewBrowserDownload(headers, 100, 1_000);
  expect(resumes({ "content-range": "bytes 100-999/1000" })).toBe(true);
  expect(resumes({ "content-range": "bytes 100-999/1000", "content-encoding": "identity" })).toBe(
    true,
  );
  for (const headers of [
    {},
    { "content-range": "bytes 0-999/1000" },
    { "content-range": "bytes 100-998/1000" },
    { "content-range": "bytes 100-999/*" },
    { "content-range": "bytes 100-1000/1001" },
    { "content-range": "bytes */1000" },
    { "content-range": "bytes 100-999/1000", "content-encoding": "gzip" },
  ]) {
    expect(resumes(headers)).toBe(false);
  }
});
