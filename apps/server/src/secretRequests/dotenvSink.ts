/**
 * Where an agent's requested secret is written: one `KEY='value'` line in a dotenv file of the
 * requesting thread's own checkout (docs/secret-requests.md).
 *
 * Each check, and what it defends against:
 * - The file is a relative path of plain segments (letters, digits, `.`, `_`, `-`, `@`, `+`):
 *   no absolute path, `..`, backslash, control character, glob or Git pathspec magic, and no
 *   segment ending in a dot (Windows drops trailing dots, so `.git.` would be `.git` there).
 * - Its name looks like a dotenv file (`.env`, `.env.*`, `*.env`, `.dev.vars`) and does not end
 *   in a code or config extension (`.env.js`, `.env.json`, ...), so a request can not turn a
 *   source file or a config file into the sink.
 * - No segment is `.git` (any case: macOS and Windows file systems fold case), so the value
 *   never lands in Git's own files or hooks.
 * - The checkout is resolved by realpath, every existing segment below it is `lstat`ed and must
 *   not be a link, the parent must exist (nothing is created) and resolve to itself, and the
 *   target must be absent or a regular file whose realpath is itself: the write cannot follow a
 *   link out of the checkout, and on a file system that folds case `prod.env` cannot open an
 *   existing `Prod.env`.
 * - The file's folder must belong to the checkout's own Git repository (`rev-parse
 *   --show-toplevel`), not to a repository nested in it (an ignored `vendor/` clone, a
 *   submodule), whose own index could track the file.
 * - `git check-ignore` must report the file ignored (it reports a tracked file as not ignored),
 *   and `git ls-files ':(icase)<file>'` must list nothing: no file Git tracks under that name in
 *   any letter case, deleted from the working tree or not. A folder that is not a Git
 *   repository is refused.
 * - The value is at most 16 KiB, has no control characters but tab and newline, no `$` and no
 *   backslash (dotenv-expand, which Vite and Next.js run, and python-dotenv expand them even in
 *   single quotes), and is quoted so the common loaders read it back as typed (see
 *   {@link encodeDotenvValue}); anything else is refused.
 * - The answer must be for the checkout the request was opened for ({@link checkoutIdentity}):
 *   after the thread's worktree was removed or the thread moved, nothing is written elsewhere.
 * - The file is replaced atomically: a fresh `O_EXCL | O_NOFOLLOW` temporary file with mode 0600
 *   in the repository's Git directory (`rev-parse --git-path`, which neither a commit nor
 *   `git add -A` ever reads; beside the file under a name Git ignores when that directory is on
 *   another file system), fsynced, the checks repeated, renamed over the file, and the folder
 *   fsynced. The result is mode 0600, a reader never sees a half-written file, and other lines
 *   are kept.
 * - Writes into one file run one at a time in this process; a temporary file a crash left
 *   behind is removed by the next write (and at startup) once it is old enough that it cannot be
 *   another writer's.
 *
 * Errors carry a reason only, never the value or a path.
 *
 * @module secretRequests/dotenvSink
 */
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants as FsConstants, promises as fs } from "node:fs";
import path from "node:path";

import {
  SECRET_REQUEST_FILE_MAX_CHARS,
  SECRET_REQUEST_VALUE_MAX_BYTES,
  type SecretRequestFailureReason,
} from "@ryco/contracts/secret-request";

/** A dotenv file larger than this is refused instead of read into memory. */
export const DOTENV_FILE_MAX_BYTES = 1024 * 1024;
/**
 * A temporary file younger than this may belong to a write in progress (another node process
 * sharing the checkout), so leftover cleanup does not touch it.
 */
export const LEFTOVER_TEMPORARY_MIN_AGE_MS = 10_000;
const GIT_CHECK_TIMEOUT_MS = 10_000;

export class DotenvSinkError extends Error {
  readonly reason: SecretRequestFailureReason;
  constructor(reason: SecretRequestFailureReason) {
    super(reason);
    this.name = "DotenvSinkError";
    this.reason = reason;
  }
}

const fail = (reason: SecretRequestFailureReason): never => {
  throw new DotenvSinkError(reason);
};

const SEGMENT = /^[A-Za-z0-9._@+-]+$/;
const DOTENV_NAME = /^(?:\.env(?:\.[A-Za-z0-9_-]+)*|[A-Za-z0-9_-]+\.env|\.dev\.vars)$/;
/** Names Windows opens as a device whatever follows the dot (`con.env`, `nul`). */
const WINDOWS_DEVICE_NAME = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/iu;
/**
 * Extensions that make a dotenv-looking name a program, a module or a config file another tool
 * loads (`.env.js`, `.env.json`, `.env.sh`): never a sink.
 */
const CODE_EXTENSIONS: ReadonlySet<string> = new Set([
  "bash",
  "bat",
  "c",
  "cc",
  "cfg",
  "cjs",
  "cmd",
  "conf",
  "cpp",
  "cs",
  "cts",
  "fish",
  "go",
  "h",
  "htm",
  "html",
  "ini",
  "java",
  "js",
  "json",
  "json5",
  "jsonc",
  "jsx",
  "kt",
  "kts",
  "lua",
  "md",
  "mdx",
  "mjs",
  "mts",
  "php",
  "pl",
  "plist",
  "ps1",
  "psm1",
  "py",
  "pyw",
  "rb",
  "rs",
  "sh",
  "swift",
  "toml",
  "ts",
  "tsx",
  "xml",
  "yaml",
  "yml",
  "zsh",
]);

/**
 * The checks that need no file system: the path's shape and name. Returns the normalized
 * relative path (forward slashes) or `null`.
 */
export function normalizeDotenvRelativePath(file: string): string | null {
  if (file.length === 0 || file.length > SECRET_REQUEST_FILE_MAX_CHARS) return null;
  const segments = file.split("/");
  for (const segment of segments) {
    // A trailing dot also covers `.`, `..`, `...` and `.git.` (Windows drops trailing dots).
    if (!SEGMENT.test(segment) || segment.endsWith(".")) return null;
    if (segment.toLowerCase() === ".git" || WINDOWS_DEVICE_NAME.test(segment)) return null;
  }
  const name = segments.at(-1)!;
  if (!DOTENV_NAME.test(name)) return null;
  if (CODE_EXTENSIONS.has(name.slice(name.lastIndexOf(".") + 1).toLowerCase())) return null;
  return segments.join("/");
}

/**
 * The opaque identity of a checkout (its realpath), recorded with a request so an answer is
 * written only into the checkout the request was opened for. 32 hex characters: never a path.
 */
export function checkoutIdentity(root: string): string {
  return createHash("sha256")
    .update(`ryco-secret-checkout\u0000${root}`)
    .digest("hex")
    .slice(0, 32);
}

/**
 * A value as one dotenv assignment's right-hand side, or the reason it cannot be one:
 * - a `$` or a backslash is refused: dotenv-expand (run by Vite and Next.js) expands `$NAME` and
 *   python-dotenv expands `${NAME}` and unescapes `\\` even inside single quotes, so no quoting
 *   keeps them as typed;
 * - no single quote and no line break: `'value'`, which dotenv, Node's `--env-file`, Bun,
 *   python-dotenv and Docker read as typed (`#` kept);
 * - otherwise, with no `"` or backtick: `"value"` with each line break written `\n`, which those
 *   loaders turn back into a line break (multi-line keys such as PEM files);
 * - anything else is refused rather than written in a form some loader would misread.
 */
export function encodeDotenvValue(
  value: string,
): { readonly encoded: string } | { readonly reason: SecretRequestFailureReason } {
  if (value.length === 0) return { reason: "empty-value" };
  if (Buffer.byteLength(value, "utf8") > SECRET_REQUEST_VALUE_MAX_BYTES) {
    return { reason: "value-too-long" };
  }
  // Tab and newline only: a carriage return or NUL would split or end the line in some loaders.
  // eslint-disable-next-line no-control-regex -- control characters are exactly what it refuses
  if (/[\u0000-\u0008\u000b-\u001f\u007f]/u.test(value)) return { reason: "value-characters" };
  if (/[$\\]/u.test(value)) return { reason: "value-expansion" };
  if (!value.includes("'") && !value.includes("\n")) return { encoded: `'${value}'` };
  if (/["`]/u.test(value)) return { reason: "value-quoting" };
  return { encoded: `"${value.replaceAll("\n", "\\n")}"` };
}

/** Trims what a paste adds around a value (spaces, tabs, line breaks), as the card shows it. */
export function normalizeSecretValue(value: string): string {
  return value.trim();
}

const assignmentPattern = (key: string) => new RegExp(`^(\\s*)(export\\s+)?${key}\\s*=(.*)$`, "u");

/** Whether a value quoted with `quote` closes on this line (from `from` on). */
function closesOnLine(rest: string, quote: string, from: number): boolean {
  for (let index = from; index < rest.length; index += 1) {
    const char = rest[index]!;
    if (quote === '"' && char === "\\") {
      index += 1;
      continue;
    }
    if (char === quote) return true;
  }
  return false;
}

/**
 * `content` with `key` assigned `encoded`: the first assignment is replaced in place (keeping an
 * `export ` prefix), later assignments of the same key are removed (so every loader reads the new
 * value), and other lines stay as they were. A quoted value spanning several lines counts as one
 * assignment. A file without the key gets the line appended.
 */
export function upsertDotenvAssignment(content: string, key: string, encoded: string): string {
  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  const lines = content.length === 0 ? [] : content.split(/\r?\n/u);
  if (lines.length > 0 && lines.at(-1) === "") lines.pop();
  const pattern = assignmentPattern(key);
  const output: string[] = [];
  let replaced = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const match = pattern.exec(line);
    if (match === null) {
      output.push(line);
      continue;
    }
    // Skip the continuation lines of a multi-line quoted value.
    const rest = match[3]!.trimStart();
    const quote = rest[0];
    if (quote === '"' || quote === "'" || quote === "`") {
      if (!closesOnLine(rest, quote, 1)) {
        while (index + 1 < lines.length) {
          index += 1;
          if (closesOnLine(lines[index]!, quote, 0)) break;
        }
      }
    }
    if (replaced) continue;
    replaced = true;
    output.push(`${match[1]}${match[2] ?? ""}${key}=${encoded}`);
  }
  if (!replaced) output.push(`${key}=${encoded}`);
  return `${output.join(eol)}${eol}`;
}

const errorCode = (cause: unknown): unknown =>
  typeof cause === "object" && cause !== null && "code" in cause ? cause.code : undefined;
const isEnoent = (cause: unknown) => errorCode(cause) === "ENOENT";

export interface DotenvTarget {
  /** The checkout, by realpath. */
  readonly root: string;
  /** The normalized path relative to `root`, as Git gets it. */
  readonly relative: string;
  /** `root` joined with `relative`: its parent is a real directory inside `root`. */
  readonly target: string;
  /** Whether the file exists already (a regular file named exactly `target`). */
  readonly exists: boolean;
  /** {@link checkoutIdentity} of `root`. */
  readonly checkoutId: string;
}

/** Fails unless every existing segment from `root` down to `target` is a real directory/file. */
async function assertNoLinks(root: string, relative: string): Promise<{ exists: boolean }> {
  const segments = relative.split("/");
  let current = root;
  for (let index = 0; index < segments.length; index += 1) {
    current = path.join(current, segments[index]!);
    const last = index === segments.length - 1;
    let info;
    try {
      info = await fs.lstat(current);
    } catch (cause) {
      // The file itself may be new; a missing directory is refused (nothing is created).
      if (isEnoent(cause) && last) return { exists: false };
      if (isEnoent(cause)) return fail("unsafe-path");
      throw cause;
    }
    if (info.isSymbolicLink()) return fail("unsafe-path");
    if (!last && !info.isDirectory()) return fail("unsafe-path");
    if (last && !info.isFile()) return fail("not-regular-file");
  }
  return { exists: true };
}

/**
 * The link and name checks, run when resolving and again right before the rename: no link on
 * the way, the parent inside the root and its own realpath, and an existing file named exactly
 * as asked. On a file system that folds case `prod.env` opens `Prod.env`, whose realpath tells.
 */
async function assertPathUnchanged(root: string, relative: string): Promise<{ exists: boolean }> {
  const { exists } = await assertNoLinks(root, relative);
  const target = path.join(root, ...relative.split("/"));
  const parent = path.dirname(target);
  const insideRoot = parent === root || parent.startsWith(`${root}${path.sep}`);
  if (!insideRoot || (await fs.realpath(parent)) !== parent) return fail("unsafe-path");
  if (exists && (await fs.realpath(target)) !== target) return fail("name-case");
  return { exists };
}

/** Variables that would point Git at another repository than the folder it runs in. */
const GIT_LOCATION_VARIABLES = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_COMMON_DIR",
  "GIT_OBJECT_DIRECTORY",
  "GIT_NAMESPACE",
];

function gitEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
  };
  for (const name of GIT_LOCATION_VARIABLES) delete env[name];
  return env;
}

/** Runs a read-only Git command in `cwd`; a repository's config runs no hook for it. */
function runGit(
  cwd: string,
  args: ReadonlyArray<string>,
): Promise<{ readonly code: number; readonly stdout: string }> {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false", ...args],
      {
        cwd,
        encoding: "utf8",
        maxBuffer: 1024 * 1024,
        timeout: GIT_CHECK_TIMEOUT_MS,
        windowsHide: true,
        env: gitEnvironment(),
      },
      (error, stdout) => {
        if (error === null) return resolve({ code: 0, stdout });
        const code = (error as { code?: unknown }).code;
        resolve({ code: typeof code === "number" ? code : -1, stdout: "" });
      },
    );
  });
}

const firstLine = (stdout: string) => stdout.split(/\r?\n/u)[0] ?? "";

/** The working tree root of the repository `cwd` belongs to, by realpath, or null. */
async function repositoryTopLevel(cwd: string): Promise<string | null> {
  const result = await runGit(cwd, ["rev-parse", "--show-toplevel"]);
  const top = firstLine(result.stdout);
  if (result.code !== 0 || top.length === 0) return null;
  return fs.realpath(top).catch(() => null);
}

/**
 * The Git checks: the file's folder belongs to the checkout's own repository (not a repository
 * nested in it, whose index could track the file), Git ignores the file, and Git tracks no
 * file of that name in any letter case.
 */
async function assertIgnoredByGit(root: string, relative: string, parent: string): Promise<void> {
  const top = await repositoryTopLevel(root);
  if (top === null) return fail("not-git");
  if (parent !== root && (await repositoryTopLevel(parent)) !== top) {
    return fail("other-repository");
  }
  const ignored = await runGit(root, ["check-ignore", "-q", "--", relative]);
  if (ignored.code === 1) return fail("not-ignored");
  if (ignored.code !== 0) return fail("not-git");
  // `check-ignore` misses a tracked `Prod.env` asked for as `prod.env`, and a tracked file
  // deleted from the working tree: the index decides.
  const tracked = await runGit(root, ["ls-files", "-z", "--", `:(icase,literal)${relative}`]);
  if (tracked.code !== 0) return fail("not-git");
  if (tracked.stdout.length > 0) return fail("tracked");
}

/**
 * Every check of the module comment that needs no value: run when the agent asks (so it hears
 * about a bad file at once) and again, with the write, when the user answers.
 */
export async function resolveDotenvTarget(input: {
  readonly checkout: string;
  readonly file: string;
}): Promise<DotenvTarget> {
  const relative = normalizeDotenvRelativePath(input.file);
  if (relative === null) return fail("unsafe-path");
  let root: string;
  try {
    root = await fs.realpath(input.checkout);
    if (!(await fs.stat(root)).isDirectory()) return fail("no-checkout");
  } catch (cause) {
    if (cause instanceof DotenvSinkError) throw cause;
    return fail("no-checkout");
  }
  try {
    const { exists } = await assertPathUnchanged(root, relative);
    const target = path.join(root, ...relative.split("/"));
    await assertIgnoredByGit(root, relative, path.dirname(target));
    return { root, relative, target, exists, checkoutId: checkoutIdentity(root) };
  } catch (cause) {
    if (cause instanceof DotenvSinkError) throw cause;
    return fail("unsafe-path");
  }
}

const noFollow = () => (process.platform === "win32" ? 0 : FsConstants.O_NOFOLLOW);

async function readExisting(target: string): Promise<string> {
  const handle = await fs.open(target, FsConstants.O_RDONLY | noFollow());
  try {
    const info = await handle.stat();
    if (!info.isFile()) return fail("not-regular-file");
    if (info.size > DOTENV_FILE_MAX_BYTES) return fail("file-too-large");
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const GIT_TEMPORARY_PREFIX = "ryco-secret";
const GIT_TEMPORARY_NAME = new RegExp(`^${GIT_TEMPORARY_PREFIX}-${UUID}\\.tmp$`, "u");
const besideTemporaryName = (base: string) =>
  new RegExp(`^\\.?${escapeRegExp(base)}\\.ryco-${UUID}\\.tmp$`, "u");

/**
 * The directory for a write's temporary file: the repository's own Git directory for this
 * working tree (`rev-parse --git-path`), which no commit, checkpoint or `git add -A` reads.
 */
async function gitTemporaryDirectory(root: string): Promise<string | null> {
  const result = await runGit(root, ["rev-parse", "--git-path", GIT_TEMPORARY_PREFIX]);
  const gitPath = firstLine(result.stdout);
  if (result.code !== 0 || gitPath.length === 0) return null;
  const directory = path.dirname(path.resolve(root, gitPath));
  const info = await fs.stat(directory).catch(() => null);
  return info?.isDirectory() === true ? directory : null;
}

/**
 * Removes the temporary files a crashed write left behind (they hold the whole new file): only
 * names this module creates, only regular files, and only ones older than
 * {@link LEFTOVER_TEMPORARY_MIN_AGE_MS}, so another writer's file in progress is left alone.
 */
async function removeLeftoverTemporaries(
  locations: ReadonlyArray<{ readonly directory: string; readonly pattern: RegExp }>,
): Promise<void> {
  const now = Date.now();
  for (const { directory, pattern } of locations) {
    const names = await fs.readdir(directory).catch(() => [] as string[]);
    for (const name of names) {
      if (!pattern.test(name)) continue;
      const candidate = path.join(directory, name);
      const info = await fs.lstat(candidate).catch(() => null);
      if (info?.isFile() !== true || now - info.mtimeMs < LEFTOVER_TEMPORARY_MIN_AGE_MS) continue;
      await fs.unlink(candidate).catch(() => undefined);
    }
  }
}

const leftoverLocations = (gitDirectory: string | null, parent: string, base: string) => [
  ...(gitDirectory === null ? [] : [{ directory: gitDirectory, pattern: GIT_TEMPORARY_NAME }]),
  { directory: parent, pattern: besideTemporaryName(base) },
];

/**
 * A temporary name beside the file that Git ignores, for when the Git directory is on another
 * file system (a rename cannot cross file systems). None ignored: the write is refused rather
 * than leave the value where `git add -A` would pick it up.
 */
async function ignoredTemporaryBeside(target: DotenvTarget): Promise<string> {
  const base = path.basename(target.target);
  const folder = path.posix.dirname(target.relative);
  const id = randomUUID();
  for (const name of [`${base}.ryco-${id}.tmp`, `.${base}.ryco-${id}.tmp`]) {
    const relative = folder === "." ? name : `${folder}/${name}`;
    const ignored = await runGit(target.root, ["check-ignore", "-q", "--", relative]);
    if (ignored.code === 0) return path.join(path.dirname(target.target), name);
  }
  return fail("write-failed");
}

/** Makes a rename durable: fsyncs the folder that holds the new entry (not on Windows). */
async function syncDirectory(directory: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await fs.open(directory, FsConstants.O_RDONLY).catch(() => undefined);
  if (handle === undefined) return;
  await handle.sync().catch(() => undefined);
  await handle.close().catch(() => undefined);
}

/**
 * Writes `content` into a fresh temporary file and renames it over the target, after the link
 * and name checks once more. `cross-device` when the temporary file's folder is on another file
 * system than the target (nothing is left behind then).
 */
async function replaceThroughTemporary(
  target: DotenvTarget,
  temporary: string,
  content: string,
): Promise<"replaced" | "cross-device"> {
  let handle: fs.FileHandle | undefined;
  let created = false;
  try {
    handle = await fs.open(
      temporary,
      FsConstants.O_WRONLY | FsConstants.O_CREAT | FsConstants.O_EXCL | noFollow(),
      0o600,
    );
    created = true;
    // The mode given to open is masked by the umask; set it exactly.
    await handle.chmod(0o600);
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    // The checks again, right before the rename: nothing swapped a link or a name in meanwhile.
    await assertPathUnchanged(target.root, target.relative);
    try {
      await fs.rename(temporary, target.target);
    } catch (cause) {
      if (errorCode(cause) === "EXDEV") return "cross-device";
      throw cause;
    }
    created = false;
    await syncDirectory(path.dirname(target.target));
    return "replaced";
  } finally {
    await handle?.close().catch(() => undefined);
    if (created) await fs.unlink(temporary).catch(() => undefined);
  }
}

// Writes into one file, one at a time in this process: a read-modify-write that overlapped
// another would drop the other's key.
const fileLocks = new Map<string, Promise<void>>();

async function withFileLock<A>(key: string, run: () => Promise<A>): Promise<A> {
  const previous = fileLocks.get(key) ?? Promise.resolve();
  const turn = Promise.withResolvers<void>();
  const tail = previous.then(() => turn.promise);
  fileLocks.set(key, tail);
  await previous;
  try {
    return await run();
  } finally {
    turn.resolve();
    if (fileLocks.get(key) === tail) fileLocks.delete(key);
  }
}

/**
 * The lock key of a checkout's file: its path from the checkout's realpath, case folded, so
 * `.env` and `.ENV` (one file where the file system folds case) share it.
 */
async function fileLockKey(checkout: string, relative: string): Promise<string> {
  const root = await fs.realpath(checkout).catch(() => path.resolve(checkout));
  return path.join(root, ...relative.split("/")).toLowerCase();
}

/**
 * Writes `KEY=<encoded value>` into the request's file, atomically and with mode 0600, after
 * every check again, and only into the checkout `checkoutId` names. The value never leaves this
 * function except into the file (and its temporary file, removed on every path).
 */
export async function writeDotenvSecret(input: {
  readonly checkout: string;
  readonly file: string;
  readonly key: string;
  readonly value: string;
  /** The {@link checkoutIdentity} recorded when the request was opened. */
  readonly checkoutId: string;
}): Promise<void> {
  const encoded = encodeDotenvValue(input.value);
  if ("reason" in encoded) return fail(encoded.reason);
  const relative = normalizeDotenvRelativePath(input.file);
  if (relative === null) return fail("unsafe-path");
  await withFileLock(await fileLockKey(input.checkout, relative), async () => {
    const resolved = await resolveDotenvTarget(input);
    if (resolved.checkoutId !== input.checkoutId) return fail("checkout-changed");
    try {
      const current = resolved.exists ? await readExisting(resolved.target) : "";
      const next = upsertDotenvAssignment(current, input.key, encoded.encoded);
      const parent = path.dirname(resolved.target);
      const gitDirectory = await gitTemporaryDirectory(resolved.root);
      await removeLeftoverTemporaries(
        leftoverLocations(gitDirectory, parent, path.basename(resolved.target)),
      );
      if (gitDirectory !== null) {
        const temporary = path.join(gitDirectory, `${GIT_TEMPORARY_PREFIX}-${randomUUID()}.tmp`);
        if ((await replaceThroughTemporary(resolved, temporary, next)) === "replaced") return;
      }
      const beside = await ignoredTemporaryBeside(resolved);
      if ((await replaceThroughTemporary(resolved, beside, next)) === "replaced") return;
      return fail("write-failed");
    } catch (cause) {
      if (cause instanceof DotenvSinkError) throw cause;
      return fail("write-failed");
    }
  });
}

/**
 * Startup's sweep for one request's file: removes the temporary files a crash left behind in the
 * checkout's Git directory and beside the file (same rules as a write's own sweep). Never fails.
 */
export async function removeDotenvSecretLeftovers(input: {
  readonly checkout: string;
  readonly file: string;
}): Promise<void> {
  const relative = normalizeDotenvRelativePath(input.file);
  if (relative === null) return;
  try {
    const root = await fs.realpath(input.checkout);
    await assertNoLinks(root, relative);
    const target = path.join(root, ...relative.split("/"));
    const parent = path.dirname(target);
    if ((await fs.realpath(parent)) !== parent) return;
    const gitDirectory = await gitTemporaryDirectory(root);
    await removeLeftoverTemporaries(leftoverLocations(gitDirectory, parent, path.basename(target)));
  } catch {
    // Nothing to sweep where the path is unsafe or gone.
  }
}
