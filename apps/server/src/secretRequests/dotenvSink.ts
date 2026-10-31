/**
 * Where an agent's requested secret is written: one `KEY='value'` line in a dotenv file of the
 * requesting thread's own checkout (docs/secret-requests.md).
 *
 * Each check, and what it defends against:
 * - The file is a relative path of plain segments (letters, digits, `.`, `_`, `-`, `@`, `+`):
 *   no absolute path, `..`, backslash, control character, glob or Git pathspec magic.
 * - Its name looks like a dotenv file (`.env`, `.env.*`, `*.env`, `.dev.vars`), so a request can
 *   not turn a source file or a config file into the sink.
 * - No segment is `.git` (any case: macOS and Windows file systems fold case), so the value
 *   never lands in Git's own files or hooks.
 * - The checkout is resolved by realpath, every existing segment below it is `lstat`ed and must
 *   not be a link, the parent must exist (nothing is created), and the target must be absent or
 *   a regular file: the write cannot follow a link out of the checkout.
 * - `git check-ignore` must report the file ignored. It reports a tracked file as not ignored,
 *   so the value is never written where a commit would pick it up. A folder that is not a Git
 *   repository is refused for the same reason.
 * - The value is at most 16 KiB, has no control characters but tab and newline, and is quoted
 *   so dotenv loaders read it literally (see {@link encodeDotenvValue}); anything else is refused.
 * - The file is replaced atomically: a fresh `O_EXCL | O_NOFOLLOW` temporary file with mode 0600
 *   next to it, fsynced, the checks repeated, then renamed over it. The result is mode 0600, and a
 *   reader never sees a half-written file. Other lines are kept.
 *
 * Errors carry a reason only, never the value or a path.
 *
 * @module secretRequests/dotenvSink
 */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants as FsConstants, promises as fs } from "node:fs";
import path from "node:path";

import {
  SECRET_REQUEST_FILE_MAX_CHARS,
  SECRET_REQUEST_VALUE_MAX_BYTES,
  type SecretRequestFailureReason,
} from "@ryco/contracts/secret-request";

/** A dotenv file larger than this is refused instead of read into memory. */
export const DOTENV_FILE_MAX_BYTES = 1024 * 1024;
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

/**
 * The checks that need no file system: the path's shape and name. Returns the normalized
 * relative path (forward slashes) or `null`.
 */
export function normalizeDotenvRelativePath(file: string): string | null {
  if (file.length === 0 || file.length > SECRET_REQUEST_FILE_MAX_CHARS) return null;
  const segments = file.split("/");
  for (const segment of segments) {
    if (!SEGMENT.test(segment) || segment === "." || segment === "..") return null;
    if (segment.toLowerCase() === ".git") return null;
  }
  if (!DOTENV_NAME.test(segments.at(-1)!)) return null;
  return segments.join("/");
}

/**
 * A value as one dotenv assignment's right-hand side, or the reason it cannot be one:
 * - no single quote and no line break: `'value'`, which dotenv, Node's `--env-file`, Bun,
 *   python-dotenv and Docker read literally (no escapes, no `$` expansion, `#` kept);
 * - otherwise, with no `"`, `\`, `$` or backtick: `"value"` with each line break written `\n`,
 *   which those loaders turn back into a line break (multi-line keys such as PEM files);
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
  if (!value.includes("'") && !value.includes("\n")) return { encoded: `'${value}'` };
  if (/["\\$`]/u.test(value)) return { reason: "value-quoting" };
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

const isEnoent = (cause: unknown) =>
  typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT";

export interface DotenvTarget {
  /** The checkout, by realpath. */
  readonly root: string;
  /** The normalized path relative to `root`, as `git check-ignore` gets it. */
  readonly relative: string;
  /** `root` joined with `relative`: its parent is a real directory inside `root`. */
  readonly target: string;
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

function gitCheckIgnore(root: string, relative: string): Promise<number> {
  return new Promise((resolve) => {
    execFile(
      "git",
      [
        // A repository's config must not run anything for this read (fsmonitor hooks).
        "-c",
        "core.fsmonitor=false",
        "-c",
        "core.untrackedCache=false",
        "check-ignore",
        "-q",
        "--",
        relative,
      ],
      {
        cwd: root,
        timeout: GIT_CHECK_TIMEOUT_MS,
        windowsHide: true,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
      },
      (error) => {
        if (error === null) return resolve(0);
        const code = (error as { code?: unknown }).code;
        resolve(typeof code === "number" ? code : -1);
      },
    );
  });
}

/**
 * Every check of the module comment that needs no value: run when the agent asks (so it hears
 * about a bad file at once) and again, with the write, when the user answers.
 */
export async function resolveDotenvTarget(input: {
  readonly checkout: string;
  readonly file: string;
}): Promise<DotenvTarget & { readonly exists: boolean }> {
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
    const { exists } = await assertNoLinks(root, relative);
    const target = path.join(root, ...relative.split("/"));
    // Belt and braces: the parent stays under the root and resolves to itself.
    const parent = path.dirname(target);
    const insideRoot = parent === root || parent.startsWith(`${root}${path.sep}`);
    if (!insideRoot || (await fs.realpath(parent)) !== parent) return fail("unsafe-path");
    const ignored = await gitCheckIgnore(root, relative);
    if (ignored === 1) return fail("not-ignored");
    if (ignored !== 0) return fail("not-git");
    return { root, relative, target, exists };
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

/**
 * The temporary file a crash left behind (it holds the value too). Only names this module
 * creates are removed, and only regular files.
 */
async function removeLeftoverTemporaries(parent: string, base: string): Promise<void> {
  const pattern = new RegExp(`^\\.${escapeRegExp(base)}\\.ryco-[0-9a-f-]{36}\\.tmp$`, "u");
  const names = await fs.readdir(parent).catch(() => [] as string[]);
  for (const name of names) {
    if (!pattern.test(name)) continue;
    const candidate = path.join(parent, name);
    const info = await fs.lstat(candidate).catch(() => null);
    if (info?.isFile()) await fs.unlink(candidate).catch(() => undefined);
  }
}

/**
 * Writes `KEY=<encoded value>` into the request's file, atomically and with mode 0600, after
 * every check again. The value never leaves this function except into the file.
 */
export async function writeDotenvSecret(input: {
  readonly checkout: string;
  readonly file: string;
  readonly key: string;
  readonly value: string;
}): Promise<void> {
  const encoded = encodeDotenvValue(input.value);
  if ("reason" in encoded) return fail(encoded.reason);
  const resolved = await resolveDotenvTarget(input);
  const parent = path.dirname(resolved.target);
  const base = path.basename(resolved.target);
  const temporary = path.join(parent, `.${base}.ryco-${randomUUID()}.tmp`);
  let handle: fs.FileHandle | undefined;
  let created = false;
  try {
    const current = resolved.exists ? await readExisting(resolved.target) : "";
    const next = upsertDotenvAssignment(current, input.key, encoded.encoded);
    await removeLeftoverTemporaries(parent, base);
    handle = await fs.open(
      temporary,
      FsConstants.O_WRONLY | FsConstants.O_CREAT | FsConstants.O_EXCL | noFollow(),
      0o600,
    );
    created = true;
    // The mode given to open is masked by the umask; set it exactly.
    await handle.chmod(0o600);
    await handle.writeFile(next, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    // The checks again, right before the rename: nothing swapped a link in meanwhile.
    await assertNoLinks(resolved.root, resolved.relative);
    if ((await fs.realpath(parent)) !== parent) return fail("unsafe-path");
    await fs.rename(temporary, resolved.target);
    created = false;
  } catch (cause) {
    if (cause instanceof DotenvSinkError) throw cause;
    return fail("write-failed");
  } finally {
    await handle?.close().catch(() => undefined);
    if (created) await fs.unlink(temporary).catch(() => undefined);
  }
}
