/**
 * Path containment checks for the server's file-system guards (workspace escape, static file
 * serving, attachment staging, restore targets, storage cleanup).
 *
 * Two forms, because the call sites differ in what they are given:
 * - {@link isPathInside} compares lexically through `path.relative`, so it resolves and
 *   normalizes both paths first (`a/../b`, trailing separators, relative inputs).
 * - {@link isCanonicalPathInside} compares strings by prefix and normalizes nothing; callers pass
 *   paths that are already canonical (realpath'd or resolved).
 *
 * Neither folds case. Call sites that compare case-insensitively fold both paths themselves
 * before calling, so a case-sensitive volume never gets a wider allow-guard by accident.
 *
 * Both take named arguments: the order of `root` and `candidate` used to differ between copies.
 */
import * as NodePath from "node:path";

/** The parts of a path module the checks use; `node:path` by default, `path.win32` in tests. */
export interface PathContainmentApi {
  readonly sep: string;
  readonly relative: (from: string, to: string) => string;
  readonly isAbsolute: (path: string) => boolean;
}

export interface PathContainmentInput {
  readonly root: string;
  readonly candidate: string;
  /** Whether `candidate` equal to `root` counts as inside. Every caller states it. */
  readonly allowRoot: boolean;
}

/**
 * Whether `candidate` lies inside `root` (or is `root`, when `allowRoot`), compared through
 * `path.relative`. A child whose name merely starts with two dots (`..foo`) is inside.
 */
export const isPathInside = (
  input: PathContainmentInput & { readonly path?: PathContainmentApi },
): boolean => {
  const pathApi = input.path ?? NodePath;
  const relative = pathApi.relative(input.root, input.candidate);
  // `node:path` returns "" for the same path; "." is accepted too for other path modules.
  if (relative === "" || relative === ".") return input.allowRoot;
  return (
    relative !== ".." && !relative.startsWith(`..${pathApi.sep}`) && !pathApi.isAbsolute(relative)
  );
};

/**
 * Whether the canonical path `candidate` is `root` (when `allowRoot`) or starts with `root`
 * followed by a separator. A root that already ends in a separator (a volume root) is used as is.
 */
export const isCanonicalPathInside = (
  input: PathContainmentInput & { readonly sep?: string },
): boolean => {
  const { root, candidate } = input;
  if (candidate === root) return input.allowRoot;
  const sep = input.sep ?? NodePath.sep;
  return candidate.startsWith(root.endsWith(sep) ? root : root + sep);
};
