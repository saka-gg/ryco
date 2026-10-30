/**
 * Pure helpers for every client's Files view of a change request: file status
 * labels, path splitting and host links, the reading-order file tree, and how
 * the host's size refusals and very large files are recognised. Parsing the
 * patch itself is the client's (the web uses `@pierre/diffs`).
 */

// ── Files ─────────────────────────────────────────────────────────────

export type PullRequestFileStatus = "added" | "deleted" | "modified" | "renamed";

export const FILE_STATUS_LETTER: Record<PullRequestFileStatus, string> = {
  added: "A",
  deleted: "D",
  modified: "M",
  renamed: "R",
};

export const FILE_STATUS_LABEL: Record<PullRequestFileStatus, string> = {
  added: "Added",
  deleted: "Deleted",
  modified: "Modified",
  renamed: "Renamed",
};

/** `apps/web/src/` + `index.css`: the directory keeps its trailing slash. */
export function splitFilePath(path: string): { readonly directory: string; readonly name: string } {
  const slash = path.lastIndexOf("/");
  return slash === -1
    ? { directory: "", name: path }
    : { directory: path.slice(0, slash + 1), name: path.slice(slash + 1) };
}

/** The file at the head commit on the host (`…/blob/<sha>/<path>`), from the PR URL. */
export function fileAtHeadUrl(
  pullRequestUrl: string | null | undefined,
  headSha: string | null | undefined,
  path: string,
): string | null {
  if (!pullRequestUrl || !headSha) return null;
  const match = /^(https?:\/\/[^?#]+?)\/pull\/\d+/u.exec(pullRequestUrl);
  if (!match) return null;
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  return `${match[1]}/blob/${headSha}/${encodedPath}`;
}

// ── Reading order and the tree ────────────────────────────────────────

export interface ReviewFileTreeFile {
  readonly kind: "file";
  readonly path: string;
  readonly name: string;
  readonly depth: number;
}

export interface ReviewFileTreeDirectory {
  readonly kind: "directory";
  readonly path: string;
  /** Compacted: single-child directory chains read as one row (`apps/web/src`). */
  readonly name: string;
  readonly depth: number;
  readonly children: ReadonlyArray<ReviewFileTreeNode>;
}

export type ReviewFileTreeNode = ReviewFileTreeFile | ReviewFileTreeDirectory;

interface MutableDirectory {
  readonly path: string;
  readonly name: string;
  /** Insertion order: directories and files interleaved as first seen. */
  readonly entries: Array<MutableDirectory | string>;
  readonly directories: Map<string, MutableDirectory>;
}

/**
 * The file tree in reading order: entries appear where their first file does
 * (paths are expected in `orderChangeRequestFiles` order), so the tree and the
 * diff below it read the same way top to bottom and the scroll-spy plate only
 * ever moves down as you read. Single-child directory chains are compacted.
 */
export function buildReviewFileTree(
  paths: ReadonlyArray<string>,
): ReadonlyArray<ReviewFileTreeNode> {
  const root: MutableDirectory = { path: "", name: "", entries: [], directories: new Map() };
  for (const path of paths) {
    const segments = path.split("/").filter((segment) => segment.length > 0);
    if (segments.length === 0) continue;
    let directory = root;
    for (const segment of segments.slice(0, -1)) {
      let next = directory.directories.get(segment);
      if (!next) {
        next = {
          path: directory.path ? `${directory.path}/${segment}` : segment,
          name: segment,
          entries: [],
          directories: new Map(),
        };
        directory.directories.set(segment, next);
        directory.entries.push(next);
      }
      directory = next;
    }
    directory.entries.push(path);
  }

  const toNodes = (directory: MutableDirectory, depth: number): ReviewFileTreeNode[] =>
    directory.entries.map((entry): ReviewFileTreeNode => {
      if (typeof entry === "string") {
        return { kind: "file", path: entry, name: splitFilePath(entry).name, depth };
      }
      let compacted = entry;
      let name = entry.name;
      while (compacted.entries.length === 1 && typeof compacted.entries[0] !== "string") {
        compacted = compacted.entries[0] as MutableDirectory;
        name = `${name}/${compacted.name}`;
      }
      return {
        kind: "directory",
        path: compacted.path,
        name,
        depth,
        children: toNodes(compacted, depth + 1),
      };
    });
  return toNodes(root, 0);
}

/** Files of a tree, top to bottom. */
export function reviewFileTreePaths(nodes: ReadonlyArray<ReviewFileTreeNode>): string[] {
  const paths: string[] = [];
  const visit = (list: ReadonlyArray<ReviewFileTreeNode>) => {
    for (const node of list) {
      if (node.kind === "file") paths.push(node.path);
      else visit(node.children);
    }
  };
  visit(nodes);
  return paths;
}

/** The tree flattened into rows (directories, then their files), as the tree pane renders it. */
export function flattenReviewFileTree(
  nodes: ReadonlyArray<ReviewFileTreeNode>,
): ReadonlyArray<ReviewFileTreeNode> {
  const rows: ReviewFileTreeNode[] = [];
  const visit = (list: ReadonlyArray<ReviewFileTreeNode>) => {
    for (const node of list) {
      rows.push(node);
      if (node.kind === "directory") visit(node.children);
    }
  };
  visit(nodes);
  return rows;
}

/**
 * Case-insensitive filter over paths. Every whitespace-separated term must
 * appear in the path, so `rail tsx` finds `…/PullRequestStackRail.tsx`.
 */
export function filterFilePaths(
  paths: ReadonlyArray<string>,
  query: string,
): ReadonlyArray<string> {
  const terms = query
    .toLowerCase()
    .split(/\s+/u)
    .filter((term) => term.length > 0);
  if (terms.length === 0) return paths;
  return paths.filter((path) => {
    const haystack = path.toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
}

/** J/K: the file before or after `path` in reading order (clamped, no wrap). */
export function adjacentFilePath(
  paths: ReadonlyArray<string>,
  path: string | null,
  direction: 1 | -1,
): string | null {
  if (paths.length === 0) return null;
  const index = path === null ? -1 : paths.indexOf(path);
  if (index === -1) return direction === 1 ? (paths[0] ?? null) : (paths.at(-1) ?? null);
  const next = index + direction;
  return next >= 0 && next < paths.length ? (paths[next] ?? null) : null;
}

// ── Diff load failures ────────────────────────────────────────────────

const OVERSIZED_DIFF_PATTERN =
  /too large|too_large|exceed(?:s|ed)? the maximum|maximum number of (?:lines|files)|\b406\b|diff is taking too long/iu;

/**
 * The host refuses diffs past its size limits (GitHub: 20k lines / 300
 * files, HTTP 406). That is not a failure to retry: the reader is sent to the
 * host instead.
 */
export function isOversizedDiffError(message: string | null | undefined): boolean {
  return message != null && OVERSIZED_DIFF_PATTERN.test(message);
}

/** Lines past which a single file starts collapsed (it is still one click away). */
export const LARGE_FILE_CHANGED_LINES = 1500;
