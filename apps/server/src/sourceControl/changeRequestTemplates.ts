/**
 * Pull request (merge request) templates, read from a repository's committed tree: GitHub's
 * default file and `PULL_REQUEST_TEMPLATE/` directories in `.github`, the root and `docs`, and
 * GitLab's `.gitlab/merge_request_templates/`. Untrusted repository text, bounded in count and
 * bytes (Synara `PrTemplateDetection.ts`, T3 Code's GitLab reader).
 *
 * Only committed objects are read, never a working-tree path, so repository-controlled symlinks
 * and path races cannot reach the filesystem. Nothing here ever fetches: every read runs with
 * `GIT_NO_LAZY_FETCH=1`, and a partial clone is not read at all with a Git too old to honour it.
 *
 * GitManager imports this module on first use (`makeChangeRequestTemplates`), so boot never
 * loads it (guarded in `serverBundleBoundaries.test.ts`).
 */
import { Effect, Option } from "effect";
import {
  CHANGE_REQUEST_TEMPLATE_LIST_MAX,
  CHANGE_REQUEST_TEMPLATE_MAX_BYTES,
  GIT_REF_NAME_PATTERN,
  type ChangeRequestTemplate,
  type ChangeRequestTemplateListInput,
  type ChangeRequestTemplateListResult,
  type SourceControlProviderKind,
} from "@ryco/contracts";
import { LRUCache } from "@ryco/shared/lruCache";
import { timeoutWhileResponsiveOption } from "@ryco/shared/responsiveDeadline";
import { truncateUnicodeSafe } from "@ryco/shared/String";

import type { TextGenerationPolicy } from "../textGeneration/TextGenerationPolicy.ts";
import { withChangeRequestTemplate } from "../textGeneration/TextGenerationPresets.ts";
import type { ExecuteGitInput, GitVcsDriverShape } from "../vcs/GitVcsDriver.ts";

/** Larger template files are skipped without being read (Synara `BLOB_READ_MAX_BYTES`). */
export const CHANGE_REQUEST_TEMPLATE_BLOB_MAX_BYTES = 100_000;
/** One tree listing, names only; a longer one gives no templates. */
export const CHANGE_REQUEST_TEMPLATE_TREE_LIST_MAX_BYTES = 1_000_000;
/**
 * Per git process, and for the whole read. Only time the server could run counts, so a stall or
 * a machine sleep never drops templates the git children already read.
 */
const TEMPLATE_READ_TIMEOUT_MS = 5_000;
const TEMPLATE_CACHE_MAX_ENTRIES = 64;
const TEMPLATE_CACHE_MAX_BYTES = 2 * 1024 * 1024;
/** Git 2.44 added `GIT_NO_LAZY_FETCH`; an older Git fetches a partial clone's missing objects. */
const NO_LAZY_FETCH_GIT_VERSION = [2, 44] as const;
const TEMPLATE_READ_ENV = { GIT_OPTIONAL_LOCKS: "0", GIT_NO_LAZY_FETCH: "1" } as const;

const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const REGULAR_BLOB_MODES = new Set(["100644", "100755"]);
const TREE_MODE = "040000";
const GITHUB_TEMPLATE_ROOTS = [".github", "", "docs"] as const;
const GITHUB_DEFAULT_FILE = /^pull_request_template\.(?:md|txt)$/iu;
const GITHUB_TEMPLATE_DIRECTORY = /^pull_request_template$/iu;
const GITHUB_DIRECTORY_TEMPLATE_FILE = /\.(?:md|txt)$/iu;
const GITLAB_TEMPLATE_DIRECTORY = ".gitlab/merge_request_templates";
const GITLAB_TEMPLATE_FILE = /\.md$/iu;
const GITLAB_DEFAULT_FILE = /^default\.md$/iu;
const TEMPLATE_NAME_MAX_CHARS = 256;
const TEMPLATE_PATH_MAX_CHARS = 1024;
const DEFAULT_TEMPLATE_NAME = "Default";

export type ChangeRequestTemplateLayout = "github" | "gitlab";

/** The template layout of a host; null for hosts whose templates Ryco does not read yet. */
export function changeRequestTemplateLayout(
  kind: SourceControlProviderKind,
): ChangeRequestTemplateLayout | null {
  return kind === "github" ? "github" : kind === "gitlab" ? "gitlab" : null;
}

export interface ChangeRequestTemplateSet {
  /** The host's default templates first, then the others by path; at most 16. */
  readonly templates: ReadonlyArray<ChangeRequestTemplate>;
  /** There were more than 16 candidates; the rest were not read. */
  readonly overflow: boolean;
}

export const EMPTY_CHANGE_REQUEST_TEMPLATE_SET: ChangeRequestTemplateSet = Object.freeze({
  templates: [],
  overflow: false,
});

/**
 * The template a generated description follows, never a guess: the host's single default
 * template; on GitHub without one, the only template there is. Several defaults, several
 * templates, or more than could be read give none (Synara, T3 Code). The create dialog starts
 * a new description from the same template (`generationTemplatePath` of the list).
 */
export function selectTemplateForGeneration(
  set: ChangeRequestTemplateSet,
  layout: ChangeRequestTemplateLayout,
): ChangeRequestTemplate | null {
  const defaults = set.templates.filter((template) => template.isDefault);
  if (defaults.length > 0) return defaults.length === 1 ? defaults[0]! : null;
  if (layout !== "github" || set.overflow) return null;
  return set.templates.length === 1 ? set.templates[0]! : null;
}

function isBranchName(name: string): boolean {
  return name.length > 0 && name.length <= 256 && GIT_REF_NAME_PATTERN.test(name);
}

/** A fully qualified ref (or HEAD) that no revision syntax can hide in. */
export function isTemplateRefCandidate(ref: string): boolean {
  return ref === "HEAD" || (ref.startsWith("refs/") && ref.length <= 512 && isBranchName(ref));
}

/** Branch namespaces a base already given as a full ref may name (never tags, notes or stash). */
const BRANCH_REF_PREFIXES = ["refs/heads/", "refs/remotes/"] as const;

/**
 * The refs whose tree supplies templates, in order: the base branch on the remote the change
 * request targets, then the local base branch; none when neither exists, never the checkout's
 * own branch, so a feature branch cannot supply its own template. Without a base, the remote's
 * default branch, else HEAD. Only fully qualified refs, so a branch name can never be read as
 * revision syntax (`:/text`, `main:path`, `@{…}`) or resolve to a tag of the same name; a base
 * given as a full ref must name a local or remote-tracking branch.
 */
export function changeRequestTemplateRefCandidates(input: {
  readonly baseBranch: string | null | undefined;
  readonly remoteName: string | null | undefined;
}): ReadonlyArray<string> {
  const remoteName = input.remoteName ?? "";
  const remote = remoteName !== "." && isBranchName(remoteName) ? remoteName : null;
  const base = input.baseBranch?.trim() ?? "";
  const candidates: string[] = [];
  if (base.length === 0) {
    if (remote !== null) candidates.push(`refs/remotes/${remote}/HEAD`);
    candidates.push("HEAD");
  } else if (BRANCH_REF_PREFIXES.some((prefix) => base.startsWith(prefix))) {
    candidates.push(base);
  } else if (isBranchName(base)) {
    if (remote !== null) candidates.push(`refs/remotes/${remote}/${base}`);
    candidates.push(`refs/heads/${base}`);
  }
  return candidates.filter(isTemplateRefCandidate);
}

interface GitTreeEntry {
  readonly mode: string;
  readonly type: string;
  readonly objectId: string;
  readonly path: string;
}

/** `git ls-tree -z` records (`<mode> <type> <oid>\t<path>`), SHA-1 or SHA-256 ids. */
export function parseTreeEntries(output: string): ReadonlyArray<GitTreeEntry> {
  const entries: GitTreeEntry[] = [];
  for (const record of output.split("\0")) {
    const tab = record.indexOf("\t");
    if (tab < 0) continue;
    const [mode, type, objectId, extra] = record.slice(0, tab).split(" ");
    const path = record.slice(tab + 1);
    if (!mode || !type || !objectId || extra !== undefined || path.length === 0) continue;
    if (!OBJECT_ID.test(objectId)) continue;
    entries.push({ mode, type, objectId, path });
  }
  return entries;
}

export type ObjectInfo = { readonly type: string; readonly size: number | null } | "missing";

/**
 * `git cat-file --batch-check` lines: `<oid> <type> <size>` or `<input> missing`, keyed by the
 * first field. A size that is not a plain number is unknown (null).
 */
export function parseBatchCheck(output: string): ReadonlyMap<string, ObjectInfo> {
  const objects = new Map<string, ObjectInfo>();
  for (const line of output.split("\n")) {
    const fields = line.trim().split(" ");
    const [name, type, size] = fields;
    if (!name) continue;
    if (fields.length === 2 && type === "missing") {
      objects.set(name, "missing");
      continue;
    }
    if (fields.length !== 3 || !type) continue;
    const parsed = /^\d+$/u.test(size ?? "") ? Number(size) : Number.NaN;
    objects.set(name, { type, size: Number.isSafeInteger(parsed) ? parsed : null });
  }
  return objects;
}

const NEWLINE = 0x0a;
const textDecoder = new TextDecoder("utf-8");

/**
 * `git cat-file --batch` output: per object `<oid> <type> <size>\n<contents>\n`, or
 * `<oid> missing\n`. Missing objects are left out; reading stops at the first malformed or
 * cut-off record.
 */
export function parseCatFileBatch(bytes: Uint8Array): ReadonlyMap<string, Uint8Array> {
  const objects = new Map<string, Uint8Array>();
  let offset = 0;
  while (offset < bytes.length) {
    const headerEnd = bytes.indexOf(NEWLINE, offset);
    if (headerEnd < 0) break;
    const header = textDecoder.decode(bytes.subarray(offset, headerEnd)).split(" ");
    offset = headerEnd + 1;
    if (header.length === 2 && header[1] === "missing") continue;
    const [objectId, , sizeText] = header;
    if (header.length !== 3 || !objectId || !/^\d+$/u.test(sizeText ?? "")) break;
    const size = Number(sizeText);
    if (!Number.isSafeInteger(size) || offset + size + 1 > bytes.length) break;
    objects.set(objectId, bytes.subarray(offset, offset + size));
    offset += size;
    if (bytes[offset] !== NEWLINE) break;
    offset += 1;
  }
  return objects;
}

/** At most `maxBytes` of UTF-8, cut before a character that would not fit (Synara `truncateUtf8`). */
export function truncateUtf8(
  bytes: Uint8Array,
  maxBytes: number,
): { readonly text: string; readonly truncated: boolean } {
  if (bytes.length <= maxBytes) return { text: textDecoder.decode(bytes), truncated: false };
  let end = Math.max(0, maxBytes);
  // Back up over continuation bytes to the start of the character that crosses the limit.
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return { text: textDecoder.decode(bytes.subarray(0, end)), truncated: true };
}

/**
 * A template's body: bounded, with `\n` line ends (a text box would turn `\r\n` into `\n` and
 * make an untouched template look edited), and trimmed; null for binary (NUL) or blank content.
 */
export function templateBody(
  bytes: Uint8Array,
): { readonly body: string; readonly truncated: boolean } | null {
  if (bytes.includes(0)) return null;
  const { text, truncated } = truncateUtf8(bytes, CHANGE_REQUEST_TEMPLATE_MAX_BYTES);
  const body = text.replace(/\r\n?/gu, "\n").trim();
  return body.length === 0 ? null : { body, truncated };
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function parentPath(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash);
}

// A display name is one line of plain text.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]+/gu;

/** File name without its extension, else the whole file name; trimmed, at most 256 characters. */
export function templateDisplayName(path: string): string {
  const file = baseName(path).replace(CONTROL_CHARACTERS, " ");
  const dot = file.lastIndexOf(".");
  const stem = (dot > 0 ? file.slice(0, dot) : file).trim();
  const name = stem.length > 0 ? stem : file.trim();
  return truncateUnicodeSafe(name, TEMPLATE_NAME_MAX_CHARS).trim() || DEFAULT_TEMPLATE_NAME;
}

interface TemplateCandidate {
  readonly path: string;
  readonly objectId: string;
  /** A host default file; `location` is the directory it sits in (GitHub's order). */
  readonly isDefault: boolean;
  readonly location: string;
}

function isRegularBlob(entry: GitTreeEntry): boolean {
  return entry.type === "blob" && REGULAR_BLOB_MODES.has(entry.mode);
}

function isUsablePath(path: string): boolean {
  return path.length <= TEMPLATE_PATH_MAX_CHARS && path.trim() === path;
}

/**
 * GitHub candidates in a listing of the three template roots and their template directories:
 * default files and the regular `.md`/`.txt` files directly inside a `PULL_REQUEST_TEMPLATE`
 * directory (names case-insensitive). Template directories the listing named without listing
 * their files are returned for a second listing.
 */
export function collectGitHubCandidates(entries: ReadonlyArray<GitTreeEntry>): {
  readonly candidates: ReadonlyArray<TemplateCandidate>;
  readonly unlistedDirectories: ReadonlyArray<string>;
} {
  const candidates: TemplateCandidate[] = [];
  const unlistedDirectories: string[] = [];
  const roots: ReadonlyArray<string> = GITHUB_TEMPLATE_ROOTS;
  for (const entry of entries) {
    if (!isUsablePath(entry.path)) continue;
    const parent = parentPath(entry.path);
    const name = baseName(entry.path);
    if (roots.includes(parent)) {
      if (isRegularBlob(entry) && GITHUB_DEFAULT_FILE.test(name)) {
        candidates.push({ ...entry, isDefault: true, location: parent });
      } else if (entry.mode === TREE_MODE && GITHUB_TEMPLATE_DIRECTORY.test(name)) {
        unlistedDirectories.push(entry.path);
      }
      continue;
    }
    if (
      roots.includes(parentPath(parent)) &&
      GITHUB_TEMPLATE_DIRECTORY.test(baseName(parent)) &&
      isRegularBlob(entry) &&
      GITHUB_DIRECTORY_TEMPLATE_FILE.test(name)
    ) {
      candidates.push({ ...entry, isDefault: false, location: parent });
    }
  }
  return { candidates, unlistedDirectories };
}

/** GitLab candidates: the `.md` files directly in `.gitlab/merge_request_templates`. */
export function collectGitLabCandidates(
  entries: ReadonlyArray<GitTreeEntry>,
): ReadonlyArray<TemplateCandidate> {
  return entries.flatMap((entry) =>
    isUsablePath(entry.path) &&
    parentPath(entry.path) === GITLAB_TEMPLATE_DIRECTORY &&
    isRegularBlob(entry) &&
    GITLAB_TEMPLATE_FILE.test(baseName(entry.path))
      ? [
          {
            ...entry,
            isDefault: GITLAB_DEFAULT_FILE.test(baseName(entry.path)),
            location: GITLAB_TEMPLATE_DIRECTORY,
          },
        ]
      : [],
  );
}

/** GitHub's order: default files by location (`.github`, root, `docs`), then the rest by path. */
function orderCandidates(
  candidates: ReadonlyArray<TemplateCandidate>,
): ReadonlyArray<TemplateCandidate> {
  const roots: ReadonlyArray<string> = GITHUB_TEMPLATE_ROOTS;
  const rank = (candidate: TemplateCandidate) =>
    candidate.isDefault ? Math.max(0, roots.indexOf(candidate.location)) : roots.length;
  const unique = new Map(candidates.map((candidate) => [candidate.path, candidate]));
  return [...unique.values()].toSorted(
    (left, right) =>
      rank(left) - rank(right) || (left.path < right.path ? -1 : left.path > right.path ? 1 : 0),
  );
}

/**
 * The templates of the read candidates: the default files of the first location that has a
 * usable one (the file GitHub applies; several there are listed, and generation uses none),
 * then the other templates.
 */
export function buildTemplateSet(input: {
  readonly candidates: ReadonlyArray<TemplateCandidate>;
  readonly contents: ReadonlyMap<string, Uint8Array>;
  readonly overflow: boolean;
}): ChangeRequestTemplateSet {
  const read = input.candidates.flatMap((candidate) => {
    const bytes = input.contents.get(candidate.objectId);
    const body = bytes ? templateBody(bytes) : null;
    return body ? [{ candidate, ...body }] : [];
  });
  const winningLocation = read.find((template) => template.candidate.isDefault)?.candidate.location;
  const defaults = read.filter(
    (template) => template.candidate.isDefault && template.candidate.location === winningLocation,
  );
  const others = read.filter((template) => !template.candidate.isDefault);
  const toTemplate = (
    template: (typeof read)[number],
    isDefault: boolean,
  ): ChangeRequestTemplate => ({
    path: template.candidate.path,
    name:
      isDefault && defaults.length === 1
        ? DEFAULT_TEMPLATE_NAME
        : isDefault
          ? truncateUnicodeSafe(baseName(template.candidate.path), TEMPLATE_NAME_MAX_CHARS)
          : templateDisplayName(template.candidate.path),
    isDefault,
    body: template.body,
    truncated: template.truncated,
  });
  return {
    templates: [
      ...defaults.map((template) => toTemplate(template, true)),
      ...others.map((template) => toTemplate(template, false)),
    ],
    overflow: input.overflow,
  };
}

/** `git version 2.44.0`, `git version 2.39.3 (Apple Git-146)`, `git version 2.45.1.windows.1`. */
export function parseGitVersion(output: string): readonly [number, number] | null {
  const match = /^git version (\d+)\.(\d+)/u.exec(output.trim());
  return match ? [Number(match[1]), Number(match[2])] : null;
}

export function gitHonoursNoLazyFetch(version: readonly [number, number]): boolean {
  const [major, minor] = version;
  const [minMajor, minMinor] = NO_LAZY_FETCH_GIT_VERSION;
  return major > minMajor || (major === minMajor && minor >= minMinor);
}

const isTruthyConfig = (value: string | null) =>
  value !== null && ["true", "yes", "on", "1"].includes(value.trim().toLowerCase());

function templateSetBytes(set: ChangeRequestTemplateSet): number {
  return set.templates.reduce(
    (total, template) => total + 2 * (template.body.length + template.path.length) + 128,
    128,
  );
}

export type ChangeRequestTemplateGit = Pick<GitVcsDriverShape, "execute" | "readConfigSnapshot">;

export interface ChangeRequestTemplateReader {
  /**
   * The templates in the tree of the first ref candidate that resolves. Never fails: errors,
   * timeouts and unreadable repositories give no templates. Results are cached by tree id, so
   * a repeated read of an unchanged base costs one git process.
   */
  readonly read: (input: {
    readonly cwd: string;
    readonly layout: ChangeRequestTemplateLayout;
    readonly refCandidates: ReadonlyArray<string>;
  }) => Effect.Effect<ChangeRequestTemplateSet>;
}

/** One reader per server (GitManager's), so the pull request step and the dialog share a cache. */
export function makeChangeRequestTemplateReader(
  git: ChangeRequestTemplateGit,
): ChangeRequestTemplateReader {
  const cache = new LRUCache<ChangeRequestTemplateSet>(
    TEMPLATE_CACHE_MAX_ENTRIES,
    TEMPLATE_CACHE_MAX_BYTES,
  );
  // The git binary does not change under a running server; a failed probe is tried again.
  let honoursNoLazyFetch: boolean | null = null;

  const run = (
    cwd: string,
    operation: string,
    args: ReadonlyArray<string>,
    options: Pick<
      ExecuteGitInput,
      "stdin" | "stdoutBytes" | "maxOutputBytes" | "truncateOutputAtMaxBytes"
    > = {},
  ) =>
    git.execute({
      operation: `changeRequestTemplates.${operation}`,
      cwd,
      args,
      env: TEMPLATE_READ_ENV,
      readOnly: true,
      allowNonZeroExit: true,
      timeoutMs: TEMPLATE_READ_TIMEOUT_MS,
      maxOutputBytes: 64 * 1024,
      ...options,
    });

  /** False only for a partial clone with a Git that would fetch its missing objects. */
  const neverFetches = (cwd: string) =>
    Effect.gen(function* () {
      if (honoursNoLazyFetch === null) {
        const version = parseGitVersion((yield* run(cwd, "gitVersion", ["version"])).stdout);
        if (version !== null) honoursNoLazyFetch = gitHonoursNoLazyFetch(version);
      }
      if (honoursNoLazyFetch === true) return true;
      const config = yield* git.readConfigSnapshot(cwd);
      const partialClone =
        config.get("extensions.partialclone") !== null ||
        config.remoteNames.some((remote) =>
          isTruthyConfig(config.get(`remote.${remote}.promisor`)),
        );
      return !partialClone;
    });

  /** The tree of the first candidate that resolves, in one process. */
  const resolveTree = (cwd: string, refs: ReadonlyArray<string>) =>
    run(cwd, "resolveTree", ["cat-file", "--batch-check"], {
      stdin: `${refs.map((ref) => `${ref}^{tree}`).join("\n")}\n`,
    }).pipe(
      Effect.map((result) => {
        if (result.exitCode !== 0) return null;
        for (const line of result.stdout.split("\n")) {
          const [objectId, type] = line.trim().split(" ");
          if (objectId && type === "tree" && OBJECT_ID.test(objectId)) return objectId;
        }
        return null;
      }),
    );

  /** Names only (no `-l`, which would read every blob's size and fetch in a partial clone). */
  const listTree = (cwd: string, operation: string, treeId: string, paths: ReadonlyArray<string>) =>
    run(cwd, operation, ["ls-tree", "-z", "--full-tree", treeId, "--", ...paths], {
      maxOutputBytes: CHANGE_REQUEST_TEMPLATE_TREE_LIST_MAX_BYTES,
      truncateOutputAtMaxBytes: true,
    }).pipe(
      Effect.map((result) =>
        result.exitCode === 0 && !result.stdoutTruncated ? parseTreeEntries(result.stdout) : null,
      ),
    );

  const listCandidates = (cwd: string, layout: ChangeRequestTemplateLayout, treeId: string) =>
    Effect.gen(function* () {
      if (layout === "gitlab") {
        const entries = yield* listTree(cwd, "listGitLab", treeId, [
          `${GITLAB_TEMPLATE_DIRECTORY}/`,
        ]);
        return entries === null ? null : collectGitLabCandidates(entries);
      }
      // One listing covers the roots and their template directories in the usual spellings.
      const entries = yield* listTree(cwd, "listGitHub", treeId, [
        ".",
        ".github/",
        "docs/",
        ...GITHUB_TEMPLATE_ROOTS.flatMap((root) =>
          ["PULL_REQUEST_TEMPLATE", "pull_request_template"].map((directory) =>
            root ? `${root}/${directory}/` : `${directory}/`,
          ),
        ),
      ]);
      if (entries === null) return null;
      const first = collectGitHubCandidates(entries);
      if (first.unlistedDirectories.length === 0) return first.candidates;
      // Template directories spelled otherwise (`Pull_Request_Template/`).
      const more = yield* listTree(
        cwd,
        "listGitHubDirectories",
        treeId,
        first.unlistedDirectories.map((directory) => `${directory}/`),
      );
      return more === null
        ? first.candidates
        : [...first.candidates, ...collectGitHubCandidates(more).candidates];
    });

  /** The templates of one tree; `complete` is false when an object was missing (partial clone). */
  const readTree = (cwd: string, layout: ChangeRequestTemplateLayout, treeId: string) =>
    Effect.gen(function* () {
      const listed = yield* listCandidates(cwd, layout, treeId);
      if (listed === null) return null;
      const ordered = orderCandidates(listed);
      const overflow = ordered.length > CHANGE_REQUEST_TEMPLATE_LIST_MAX;
      const kept = ordered.slice(0, CHANGE_REQUEST_TEMPLATE_LIST_MAX);
      if (kept.length === 0) return { set: { templates: [], overflow }, complete: true };

      const objectIds = [...new Set(kept.map((candidate) => candidate.objectId))];
      const sizes = yield* run(cwd, "sizes", ["cat-file", "--batch-check"], {
        stdin: `${objectIds.join("\n")}\n`,
      });
      if (sizes.exitCode !== 0) return null;
      const info = parseBatchCheck(sizes.stdout);
      let complete = true;
      const readable = objectIds.flatMap((objectId) => {
        const object = info.get(objectId);
        if (object === undefined || object === "missing") {
          complete = false;
          return [];
        }
        return object.type === "blob" &&
          object.size !== null &&
          object.size <= CHANGE_REQUEST_TEMPLATE_BLOB_MAX_BYTES
          ? [{ objectId, size: object.size }]
          : [];
      });
      let contents: ReadonlyMap<string, Uint8Array> = new Map();
      if (readable.length > 0) {
        const blobs = yield* run(cwd, "contents", ["cat-file", "--batch"], {
          stdin: `${readable.map((blob) => blob.objectId).join("\n")}\n`,
          stdoutBytes: true,
          // Exactly what the kept blobs need: their sizes plus a header and newline each.
          maxOutputBytes: readable.reduce((total, blob) => total + blob.size + 160, 0),
        });
        if (blobs.exitCode !== 0 || !blobs.stdoutBytes) return null;
        contents = parseCatFileBatch(blobs.stdoutBytes);
        if (readable.some((blob) => !contents.has(blob.objectId))) complete = false;
      }
      return { set: buildTemplateSet({ candidates: kept, contents, overflow }), complete };
    });

  return {
    read: (input) =>
      Effect.gen(function* () {
        const refs = input.refCandidates.filter(isTemplateRefCandidate);
        if (refs.length === 0) return EMPTY_CHANGE_REQUEST_TEMPLATE_SET;
        if (!(yield* neverFetches(input.cwd))) return EMPTY_CHANGE_REQUEST_TEMPLATE_SET;
        const treeId = yield* resolveTree(input.cwd, refs);
        if (treeId === null) return EMPTY_CHANGE_REQUEST_TEMPLATE_SET;
        // Keyed by the tree's content id: a cached entry is never stale.
        const key = `${input.layout}\0${treeId}`;
        const cached = cache.get(key);
        if (cached !== null) return cached;
        const result = yield* readTree(input.cwd, input.layout, treeId);
        if (result === null) return EMPTY_CHANGE_REQUEST_TEMPLATE_SET;
        // An incomplete read (objects missing from a partial clone) is tried again next time.
        if (result.complete) cache.set(key, result.set, templateSetBytes(result.set));
        return result.set;
      }).pipe(
        timeoutWhileResponsiveOption(TEMPLATE_READ_TIMEOUT_MS),
        Effect.map(Option.getOrElse(() => EMPTY_CHANGE_REQUEST_TEMPLATE_SET)),
        Effect.catch((error) =>
          Effect.logDebug("change request templates: read failed", {
            cwd: input.cwd,
            detail: error.message,
          }).pipe(Effect.as(EMPTY_CHANGE_REQUEST_TEMPLATE_SET)),
        ),
      ),
  };
}

/** Where a pull request's templates come from. */
export interface ChangeRequestTemplateLookup {
  readonly cwd: string;
  /** The checkout's host; templates are read only for hosts with a known layout. */
  readonly host: { readonly kind: SourceControlProviderKind };
  /** The branch the change request targets; none for the remote's default branch. */
  readonly baseBranch: string | null | undefined;
  /** The remote that holds the base branch. */
  readonly remoteName: string | null;
}

const NO_CHANGE_REQUEST_TEMPLATES: ChangeRequestTemplateListResult = Object.freeze({
  templates: [],
  generationTemplatePath: null,
});

export interface ChangeRequestTemplates {
  /**
   * Every template of the base branch's tree, for the create dialog, which opens change
   * requests against `origin`, and the one a generated description would follow. Never fails:
   * an unknown host or a failed read lists none.
   */
  readonly list: (
    input: ChangeRequestTemplateListInput,
    host: Effect.Effect<{ readonly kind: SourceControlProviderKind }, Error>,
  ) => Effect.Effect<ChangeRequestTemplateListResult>;
  /**
   * The pull request step's policy: the writing policy with the template a generated
   * description follows added, when there is exactly one to follow. Resolves the writing
   * policy and reads the template concurrently; a failed read leaves the policy as it is.
   */
  readonly withTemplate: (
    policy: Effect.Effect<TextGenerationPolicy | undefined>,
    lookup: ChangeRequestTemplateLookup,
  ) => Effect.Effect<TextGenerationPolicy | undefined>;
}

/** One instance per server (GitManager's), so the pull request step and the dialog share a cache. */
export function makeChangeRequestTemplates(git: ChangeRequestTemplateGit): ChangeRequestTemplates {
  const reader = makeChangeRequestTemplateReader(git);
  const read = (
    lookup: ChangeRequestTemplateLookup,
  ): Effect.Effect<{
    readonly set: ChangeRequestTemplateSet;
    readonly layout: ChangeRequestTemplateLayout;
  } | null> => {
    const layout = changeRequestTemplateLayout(lookup.host.kind);
    return layout === null
      ? Effect.succeed(null)
      : reader
          .read({
            cwd: lookup.cwd,
            layout,
            refCandidates: changeRequestTemplateRefCandidates(lookup),
          })
          .pipe(Effect.map((set) => ({ set, layout })));
  };
  return {
    list: (input, host) =>
      host.pipe(
        Effect.flatMap((resolved) =>
          read({
            cwd: input.cwd,
            host: resolved,
            baseBranch: input.baseRefName,
            remoteName: "origin",
          }),
        ),
        Effect.map((result): ChangeRequestTemplateListResult =>
          result === null
            ? NO_CHANGE_REQUEST_TEMPLATES
            : {
                templates: result.set.templates,
                generationTemplatePath:
                  selectTemplateForGeneration(result.set, result.layout)?.path ?? null,
              },
        ),
        Effect.catch(() => Effect.succeed(NO_CHANGE_REQUEST_TEMPLATES)),
      ),
    withTemplate: (policy, lookup) =>
      Effect.all(
        [
          policy,
          read(lookup).pipe(
            Effect.map((result) =>
              result === null ? null : selectTemplateForGeneration(result.set, result.layout),
            ),
          ),
        ],
        { concurrency: 2 },
      ).pipe(
        Effect.map(([resolved, template]) =>
          template === null ? resolved : withChangeRequestTemplate(resolved, template),
        ),
      ),
  };
}
