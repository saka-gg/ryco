/**
 * Ryco's Android UI tree reader: built once per source version from the
 * user's SDK and a JDK, pushed to each emulator, and kept running while an
 * agent reads the screen.
 *
 * - Build: javac (JAVA_HOME, macOS `java_home`, Android Studio's bundled JBR,
 *   or PATH) against the newest `platforms/android-N/android.jar` (N >= 30),
 *   then d8 from the newest build-tools. Cached under
 *   `<Ryco home>/cache/android/ui-helper/<source hash>/`.
 * - Run: one `app_process` per emulator holding a UiAutomation connection.
 *   Android allows one UiAutomation at a time, so the reader exits after
 *   `ANDROID_UI_HELPER_IDLE_MS` without a request and hands the device back to
 *   the user's own test tools.
 *
 * Without a JDK or build-tools the backend falls back to `uiautomator dump`
 * (about 2 s per read), so the helper is a speedup, never a requirement.
 *
 * @module device/android/androidUiHelper
 */
import { type ChildProcess, execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import * as path from "node:path";

import { ANDROID_UI_HELPER_CLASS, ANDROID_UI_HELPER_SOURCE } from "./androidUiHelperSource.ts";
import { androidCacheRoot } from "./scrcpyServer.ts";

export const ANDROID_UI_HELPER_HASH = createHash("sha256")
  .update(ANDROID_UI_HELPER_SOURCE)
  .digest("hex")
  .slice(0, 16);
export const ANDROID_UI_HELPER_DEVICE_PATH = `/data/local/tmp/ryco-ui-${ANDROID_UI_HELPER_HASH}.jar`;
export const ANDROID_UI_HELPER_IDLE_MS = 30_000;
const REQUEST_TIMEOUT_MS = 8_000;
const START_TIMEOUT_MS = 8_000;
const BUILD_RETRY_MS = 60_000;
const MAX_LINE_BYTES = 8 * 1024 * 1024;

export type BuildCommand = (
  command: string,
  args: readonly string[],
  options: { readonly env?: NodeJS.ProcessEnv; readonly timeoutMs?: number },
) => Promise<Buffer>;

const runBuildCommand: BuildCommand = (command, args, options) =>
  new Promise((resolve, reject) => {
    execFile(
      command,
      [...args],
      {
        encoding: "buffer",
        timeout: options.timeoutMs ?? 120_000,
        maxBuffer: 4 * 1024 * 1024,
        windowsHide: true,
        ...(options.env ? { env: options.env } : {}),
      },
      (error, stdout, stderr) => {
        if (error)
          reject(
            new Error(
              `${path.basename(command)}: ${stderr.toString().trim().slice(0, 600) || error.message}`,
            ),
          );
        else resolve(stdout);
      },
    );
  });

const versionKey = (value: string) =>
  value.split(/[.-]/u).map((part) => Number.parseInt(part, 10) || 0);
function newestFirst(a: string, b: string): number {
  const left = versionKey(a);
  const right = versionKey(b);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (right[index] ?? 0) - (left[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

export interface AndroidUiHelperBuildOptions {
  readonly sdk: string | undefined;
  readonly platform?: NodeJS.Platform;
  readonly env?: NodeJS.ProcessEnv;
  readonly cacheRoot?: string;
  readonly run?: BuildCommand;
  readonly now?: () => number;
}

/** Builds (once) and locates the helper jar; null with a reason when it cannot. */
export class AndroidUiHelperBuild {
  private pending: Promise<string> | null = null;
  private failure: { readonly at: number; readonly message: string } | null = null;
  private readonly platform: NodeJS.Platform;
  private readonly env: NodeJS.ProcessEnv;
  private readonly run: BuildCommand;
  private readonly now: () => number;
  readonly outputDirectory: string;
  private readonly options: AndroidUiHelperBuildOptions;

  constructor(options: AndroidUiHelperBuildOptions) {
    this.options = options;
    this.platform = options.platform ?? process.platform;
    this.env = options.env ?? process.env;
    this.run = options.run ?? runBuildCommand;
    this.now = options.now ?? Date.now;
    this.outputDirectory = path.join(
      options.cacheRoot ?? androidCacheRoot(this.env),
      "ui-helper",
      ANDROID_UI_HELPER_HASH,
    );
  }

  get jarPath(): string {
    return path.join(this.outputDirectory, "ryco-ui.jar");
  }

  /** Why the last build failed, while that answer is still current. */
  get lastFailure(): string | null {
    return this.failure && this.now() - this.failure.at < BUILD_RETRY_MS
      ? this.failure.message
      : null;
  }

  resolve(): Promise<string> {
    if (existsSync(this.jarPath)) return Promise.resolve(this.jarPath);
    const failure = this.lastFailure;
    if (failure !== null) return Promise.reject(new Error(failure));
    this.pending ??= this.build().then(
      (jar) => {
        this.pending = null;
        this.failure = null;
        return jar;
      },
      (error: unknown) => {
        this.pending = null;
        const message = error instanceof Error ? error.message : String(error);
        this.failure = { at: this.now(), message };
        throw error;
      },
    );
    return this.pending;
  }

  private exe(name: string): string {
    return this.platform === "win32" ? `${name}.exe` : name;
  }

  private async javaHomes(): Promise<string[]> {
    const homes: string[] = [];
    const configured = this.env.JAVA_HOME?.trim();
    if (configured) homes.push(configured);
    if (this.platform === "darwin") {
      const found = await this.run("/usr/libexec/java_home", [], { timeoutMs: 5_000 }).then(
        (output) => output.toString().trim(),
        () => "",
      );
      if (found) homes.push(found);
      homes.push("/Applications/Android Studio.app/Contents/jbr/Contents/Home");
      homes.push(
        path.join(
          homedir(),
          "Applications",
          "Android Studio.app",
          "Contents",
          "jbr",
          "Contents",
          "Home",
        ),
      );
    } else if (this.platform === "win32") {
      homes.push(
        path.join(this.env.ProgramFiles ?? "C:\\Program Files", "Android", "Android Studio", "jbr"),
      );
    } else {
      homes.push(path.join(homedir(), "android-studio", "jbr"), "/opt/android-studio/jbr");
    }
    return homes.filter((home) => existsSync(path.join(home, "bin", this.exe("javac"))));
  }

  private async newest(
    directory: string,
    accept: (name: string) => string | null,
  ): Promise<string | null> {
    const names = await readdir(directory).catch(() => [] as string[]);
    for (const name of names.toSorted(newestFirst)) {
      const candidate = accept(name);
      if (candidate !== null && existsSync(candidate)) return candidate;
    }
    return null;
  }

  private async build(): Promise<string> {
    const sdk = this.options.sdk;
    if (!sdk) throw new Error("No Android SDK found.");
    const javaHome = (await this.javaHomes())[0];
    if (!javaHome)
      throw new Error(
        "No JDK found to build Ryco's Android UI reader; set JAVA_HOME or install Android Studio (falling back to uiautomator, about 2 s per read).",
      );
    const androidJar = await this.newest(path.join(sdk, "platforms"), (name) => {
      const level = Number(/^android-(\d+)$/u.exec(name)?.[1] ?? "0");
      return level >= 30 ? path.join(sdk, "platforms", name, "android.jar") : null;
    });
    if (!androidJar)
      throw new Error(
        "Install an Android SDK Platform (API 30 or newer) to build Ryco's Android UI reader.",
      );
    const d8 = await this.newest(path.join(sdk, "build-tools"), (name) =>
      path.join(sdk, "build-tools", name, this.platform === "win32" ? "d8.bat" : "d8"),
    );
    if (!d8) throw new Error("Install Android SDK Build-Tools to build Ryco's Android UI reader.");

    const work = await mkdtemp(path.join(tmpdir(), "ryco-android-ui-"));
    try {
      const sourceFile = path.join(work, "src", "dev", "ryco", "UiHelper.java");
      await mkdir(path.dirname(sourceFile), { recursive: true });
      await writeFile(sourceFile, ANDROID_UI_HELPER_SOURCE);
      const classes = path.join(work, "classes");
      await mkdir(classes);
      const env = {
        ...this.env,
        JAVA_HOME: javaHome,
        PATH: `${path.join(javaHome, "bin")}${path.delimiter}${this.env.PATH ?? ""}`,
      };
      await this.run(
        path.join(javaHome, "bin", this.exe("javac")),
        [
          "--release",
          "8",
          "-nowarn",
          "-Xlint:-options",
          "-cp",
          androidJar,
          "-d",
          classes,
          sourceFile,
        ],
        { env },
      );
      const output = path.join(work, "out");
      await mkdir(output);
      await this.run(
        d8,
        [
          "--release",
          "--min-api",
          "21",
          "--lib",
          androidJar,
          "--output",
          path.join(output, "ryco-ui.jar"),
          path.join(classes, "dev", "ryco", "UiHelper.class"),
        ],
        { env },
      );
      await mkdir(this.outputDirectory, { recursive: true });
      const staged = path.join(this.outputDirectory, `ryco-ui.${randomUUID()}.partial`);
      // The temporary directory can be on another volume than the cache.
      await copyFile(path.join(output, "ryco-ui.jar"), staged);
      await rename(staged, this.jarPath);
      return this.jarPath;
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  }
}

export class AndroidUiHelperError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AndroidUiHelperError";
  }
}

/** One resident reader on one emulator; requests are answered strictly in order. */
export class AndroidUiHelperSession {
  private buffered = "";
  private readonly waiting: Array<{
    resolve: (line: string) => void;
    reject: (error: Error) => void;
  }> = [];
  private ended: string | null = null;
  private tail: Promise<unknown> = Promise.resolve();
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  private readonly child: ChildProcess;
  private readonly onIdle: () => void;

  private constructor(child: ChildProcess, onIdle: () => void) {
    this.child = child;
    this.onIdle = onIdle;
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      this.buffered += chunk;
      if (this.buffered.length > MAX_LINE_BYTES) {
        this.fail("The Android UI reader sent an oversized reply.");
        return;
      }
      let newline = this.buffered.indexOf("\n");
      while (newline >= 0) {
        const line = this.buffered.slice(0, newline).replace(/\r$/u, "");
        this.buffered = this.buffered.slice(newline + 1);
        this.waiting.shift()?.resolve(line);
        newline = this.buffered.indexOf("\n");
      }
    });
    let stderr = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-600);
    });
    child.once("exit", (code, signal) =>
      this.fail(
        `The Android UI reader exited (${signal ?? code})${stderr ? `: ${stderr.trim()}` : ""}`,
      ),
    );
    child.once("error", (error) =>
      this.fail(`The Android UI reader could not start: ${error.message}`),
    );
  }

  static async start(
    spawnAdb: (args: readonly string[]) => ChildProcess,
    transportId: string,
    onIdle: () => void,
  ): Promise<AndroidUiHelperSession> {
    const child = spawnAdb([
      "-t",
      transportId,
      "shell",
      `CLASSPATH=/system/framework/uiautomator.jar:${ANDROID_UI_HELPER_DEVICE_PATH} app_process / ${ANDROID_UI_HELPER_CLASS}`,
    ]);
    const session = new AndroidUiHelperSession(child, onIdle);
    const ready = await session.nextLine(START_TIMEOUT_MS).catch((error: unknown) => {
      session.close();
      throw error;
    });
    if (ready.trim() !== "READY") {
      session.close();
      throw new AndroidUiHelperError(`The Android UI reader did not start: ${ready.slice(0, 300)}`);
    }
    session.touch();
    return session;
  }

  get isOpen(): boolean {
    return this.ended === null;
  }

  private nextLine(timeoutMs: number): Promise<string> {
    if (this.ended !== null) return Promise.reject(new AndroidUiHelperError(this.ended));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.fail("The Android UI reader timed out.");
      }, timeoutMs);
      timer.unref?.();
      this.waiting.push({
        resolve: (line) => {
          clearTimeout(timer);
          resolve(line);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
    });
  }

  private touch(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.close();
      this.onIdle();
    }, ANDROID_UI_HELPER_IDLE_MS);
    this.idleTimer.unref?.();
  }

  /** The current screen as uiautomator XML. */
  dump(): Promise<string> {
    const request = this.tail.then(async () => {
      this.touch();
      const reply = this.nextLine(REQUEST_TIMEOUT_MS);
      this.child.stdin?.write("d\n");
      const line = await reply;
      if (line.startsWith("E ")) throw new AndroidUiHelperError(line.slice(2).slice(0, 600));
      return line;
    });
    this.tail = request.catch(() => undefined);
    return request;
  }

  private fail(message: string): void {
    if (this.ended !== null) return;
    this.ended = message;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    for (const waiter of this.waiting.splice(0)) waiter.reject(new AndroidUiHelperError(message));
    if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill("SIGTERM");
  }

  close(): void {
    if (this.ended === null && this.child.stdin?.writable) this.child.stdin.write("q\n");
    this.fail("The Android UI reader closed.");
  }
}
