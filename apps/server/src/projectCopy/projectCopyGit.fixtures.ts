/**
 * Real-git fixtures for the project copy tests: temporary repositories, a fake `ssh` that never
 * opens a connection, and scoped environment variables.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { Duration, Effect } from "effect";

/** Fixture git runs never sign (the developer's global config may sign through an agent). */
const FIXTURE_GIT_ENV = {
  ...process.env,
  LC_ALL: "C",
  LANG: "C",
  GIT_CONFIG_COUNT: "2",
  GIT_CONFIG_KEY_0: "commit.gpgsign",
  GIT_CONFIG_VALUE_0: "false",
  GIT_CONFIG_KEY_1: "tag.gpgsign",
  GIT_CONFIG_VALUE_1: "false",
};

export function git(cwd: string, ...args: ReadonlyArray<string>): string {
  return execFileSync("git", args, {
    cwd,
    env: FIXTURE_GIT_ENV,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

/** The exit code of a git command that may fail. */
export function gitStatus(cwd: string, ...args: ReadonlyArray<string>): number {
  try {
    execFileSync("git", args, { cwd, env: FIXTURE_GIT_ENV, stdio: "ignore" });
    return 0;
  } catch (error) {
    return typeof (error as { status?: unknown }).status === "number"
      ? (error as { status: number }).status
      : -1;
  }
}

export interface TempRoots {
  readonly make: (prefix: string) => string;
  readonly cleanup: () => void;
}

/** Temporary directories (realpath'd: macOS tmp is a symlink) removed by `cleanup`. */
export function tempRoots(): TempRoots {
  const roots: Array<string> = [];
  return {
    make: (prefix) => {
      const root = realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
      roots.push(root);
      return root;
    },
    cleanup: () => {
      for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
    },
  };
}

/** A repository on `main` with a commit identity and signing off. */
export function initRepository(directory: string, options?: { readonly bare?: boolean }): string {
  mkdirSync(directory, { recursive: true });
  git(directory, "init", "--quiet", "--initial-branch=main", ...(options?.bare ? ["--bare"] : []));
  for (const [key, value] of [
    ["user.name", "Project Copy Fixture"],
    ["user.email", "copy@example.invalid"],
    ["commit.gpgsign", "false"],
    ["tag.gpgsign", "false"],
  ] as const) {
    git(directory, "config", key, value);
  }
  return directory;
}

/** Writes `files` (relative path → content) and commits them; returns the new HEAD. */
export function commitFiles(
  repository: string,
  files: Readonly<Record<string, string | Uint8Array>>,
  message: string,
): string {
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(repository, relative);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  git(repository, "add", "-A");
  git(repository, "commit", "--quiet", "-m", message);
  return git(repository, "rev-parse", "HEAD");
}

/**
 * The export's patch: staged, unstaged and untracked changes plus `forcePaths` (opted-in ignored
 * files) against HEAD, from a temporary index, written to `output` by git.
 */
export function writeChangesPatch(
  repository: string,
  output: string,
  forcePaths: ReadonlyArray<string> = [],
): void {
  const index = path.join(path.dirname(output), `${path.basename(output)}.index`);
  const env = { ...FIXTURE_GIT_ENV, GIT_INDEX_FILE: index };
  const run = (...args: ReadonlyArray<string>) =>
    execFileSync("git", args, { cwd: repository, env, stdio: "ignore" });
  run("read-tree", "HEAD");
  run("add", "-A");
  if (forcePaths.length > 0) run("add", "--force", "--", ...forcePaths);
  run("diff", "--binary", "--cached", "--no-color", "--no-ext-diff", `--output=${output}`, "HEAD");
  rmSync(index, { force: true });
}

/**
 * A fake `ssh` (named `ssh`, so git treats it as OpenSSH) in its own directory. It never opens
 * a connection: `FAKE_SSH_MODE` makes it print an ssh failure or hang, and otherwise it runs
 * git's remote command locally inside `FAKE_SSH_ROOT`, so `git@fakehost:<path>` serves
 * `$FAKE_SSH_ROOT/<path>`. With `FAKE_SSH_LOG` set it appends its arguments there.
 */
export function writeFakeSsh(root: string): { readonly binDir: string; readonly path: string } {
  const binDir = path.join(root, "fake-ssh-bin");
  mkdirSync(binDir, { recursive: true });
  const shim = path.join(binDir, "ssh");
  writeFileSync(
    shim,
    `#!/bin/sh
if [ -n "$FAKE_SSH_LOG" ]; then printf '%s\\n' "$*" >> "$FAKE_SSH_LOG"; fi
case "$FAKE_SSH_MODE" in
  host-key)
    echo "No ED25519 host key is known for fakehost and you have requested strict checking." >&2
    echo "Host key verification failed." >&2
    exit 255 ;;
  denied)
    echo "git@fakehost: Permission denied (publickey)." >&2
    exit 255 ;;
  leak)
    echo "fatal: unable to access 'https://x-token:ghp_secret@fakehost/o/r.git/': denied" >&2
    exit 128 ;;
  hang)
    echo $$ > "$FAKE_SSH_PID_FILE"
    exec sleep 600 ;;
esac
for last; do :; done
cd "$FAKE_SSH_ROOT" || exit 1
exec sh -c "$last"
`,
  );
  chmodSync(shim, 0o755);
  return { binDir, path: shim };
}

/** Runs `effect` with these variables set in `process.env` (undefined: unset), then restores them. */
export const withProcessEnv =
  (variables: Readonly<Record<string, string | undefined>>) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        const previous = new Map<string, string | undefined>();
        for (const [key, value] of Object.entries(variables)) {
          previous.set(key, process.env[key]);
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
        return previous;
      }),
      () => effect,
      (previous) =>
        Effect.sync(() => {
          for (const [key, value] of previous) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
          }
        }),
    );

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Polls `condition` every 50 ms until it holds; fails after `timeoutMs`. */
export const waitFor = (
  condition: () => boolean,
  description: string,
  timeoutMs = 10_000,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const deadline = Date.now() + timeoutMs;
    while (!condition()) {
      if (Date.now() > deadline) return yield* Effect.die(`timed out waiting for ${description}`);
      yield* Effect.sleep(Duration.millis(50));
    }
  });

/**
 * Runs `call` with `latencyMs` of wall-clock delay, half before and half after, like a client far
 * from the node. Only for the opt-in throughput benchmark: the delay is what it measures.
 */
export const withSimulatedLatency = async <T>(
  latencyMs: number,
  call: () => Promise<T>,
): Promise<T> => {
  const delay = () => new Promise<void>((resolve) => setTimeout(resolve, latencyMs / 2));
  await delay();
  const result = await call();
  await delay();
  return result;
};
