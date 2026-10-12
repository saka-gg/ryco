import type { ProjectEntry } from "@ryco/contracts";

import { normalizeWorkspaceRelativePath } from "./paths.ts";

export interface WorkspaceFileTreeNode {
  readonly path: string;
  readonly name: string;
  readonly kind: "file" | "directory";
  readonly children: readonly WorkspaceFileTreeNode[];
}

export interface VisibleWorkspaceFileTreeRow {
  readonly node: WorkspaceFileTreeNode;
  readonly depth: number;
}

export type WorkspaceFileTreeEntry = Pick<ProjectEntry, "path" | "kind">;

// One collator for every comparison: `localeCompare` with options resolves a
// collator per call, which dominates sorting large trees.
const NAME_COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

interface MutableTreeNode {
  readonly path: string;
  readonly name: string;
  kind: "file" | "directory";
  readonly children: Map<string, MutableTreeNode>;
}

function childPath(parentPath: string, segment: string): string {
  return parentPath.length > 0 ? `${parentPath}/${segment}` : segment;
}

function ensureDirectory(
  children: Map<string, MutableTreeNode>,
  parentPath: string,
  segment: string,
): MutableTreeNode {
  const existing = children.get(segment);
  if (existing) {
    // A segment that carries children can only be a directory: upgrade nodes the
    // listing introduced as files, and implicit ones synthesized out of order.
    existing.kind = "directory";
    return existing;
  }
  const created: MutableTreeNode = {
    path: childPath(parentPath, segment),
    name: segment,
    kind: "directory",
    children: new Map(),
  };
  children.set(segment, created);
  return created;
}

function toTreeNodes(children: Map<string, MutableTreeNode>): readonly WorkspaceFileTreeNode[] {
  const nodes = Array.from(children.values(), (node) => ({
    path: node.path,
    name: node.name,
    kind: node.kind,
    children: toTreeNodes(node.children),
  }));
  return nodes.toSorted((left, right) => {
    if (left.kind !== right.kind) return left.kind === "directory" ? -1 : 1;
    return NAME_COLLATOR.compare(left.name, right.name);
  });
}

/**
 * Builds the nested tree the browser renders from the node's flat entry list.
 * Intermediate directories are synthesized from the paths themselves because the
 * listing is allowed to omit them, and entries whose path fails normalization
 * are skipped rather than trusted.
 */
export function buildWorkspaceFileTree(
  entries: ReadonlyArray<WorkspaceFileTreeEntry>,
): readonly WorkspaceFileTreeNode[] {
  const root = new Map<string, MutableTreeNode>();

  for (const entry of entries) {
    const normalized = normalizeWorkspaceRelativePath(entry.path);
    if (normalized === null) continue;

    const segments = normalized.split("/");
    const directorySegments = entry.kind === "directory" ? segments : segments.slice(0, -1);

    let children = root;
    let parentPath = "";
    for (const segment of directorySegments) {
      const directory = ensureDirectory(children, parentPath, segment);
      children = directory.children;
      parentPath = directory.path;
    }

    if (entry.kind === "directory") continue;

    const name = segments.at(-1);
    if (name === undefined) continue;
    if (children.has(name)) continue;
    children.set(name, {
      path: normalized,
      name,
      kind: "file",
      children: new Map(),
    });
  }

  return toTreeNodes(root);
}

export function flattenWorkspaceFileTree(input: {
  readonly nodes: readonly WorkspaceFileTreeNode[];
  readonly expanded: ReadonlySet<string>;
}): readonly VisibleWorkspaceFileTreeRow[] {
  const rows: VisibleWorkspaceFileTreeRow[] = [];

  const visit = (nodes: readonly WorkspaceFileTreeNode[], depth: number): void => {
    for (const node of nodes) {
      rows.push({ node, depth });
      if (node.kind === "directory" && input.expanded.has(node.path)) {
        visit(node.children, depth + 1);
      }
    }
  };

  visit(input.nodes, 0);
  return rows;
}

/**
 * Seed expansion for a freshly loaded tree. Screens apply it only to an empty
 * set so a user's collapses are never re-opened by a background refetch.
 */
export function defaultExpandedWorkspaceTreePaths(
  nodes: readonly WorkspaceFileTreeNode[],
): ReadonlySet<string> {
  const expanded = new Set<string>();
  for (const node of nodes) {
    if (node.kind === "directory") expanded.add(node.path);
  }
  return expanded;
}

/** Directory paths leading to `path`, root-first, excluding the path itself. */
export function workspaceAncestorPaths(path: string): readonly string[] {
  const segments = path.split("/").filter((segment) => segment.length > 0);
  const ancestors: string[] = [];
  for (let index = 1; index < segments.length; index += 1) {
    ancestors.push(segments.slice(0, index).join("/"));
  }
  return ancestors;
}

export function countWorkspaceFiles(nodes: readonly WorkspaceFileTreeNode[]): number {
  let count = 0;
  for (const node of nodes) {
    count += node.kind === "file" ? 1 : countWorkspaceFiles(node.children);
  }
  return count;
}
