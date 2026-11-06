/**
 * The plain-folder side of a cross-node project export (ProjectExportLive): what a copy of a
 * folder that is not a git repository carries, and the gzipped tar (`folder-archive`) built
 * from it.
 *
 * The walk never follows symlinks (they travel as links), never enters the dependency and cache
 * folders a setup recreates (`PROJECT_COPY_FOLDER_LEFT_OUT_NAMES`) or the project's metadata
 * folder, and leaves out sockets, FIFOs and devices. Files named like secrets (`.env*`) stay
 * behind unless opted in, as a git copy treats its ignored files. The tar is written by the
 * `tar` package (loaded on first use) from the walk's own list, so what the inspection counted
 * is what the archive holds; a file that vanished in between is skipped.
 *
 * @module exportFolder
 */
import * as fsp from "node:fs/promises";
import nodePath from "node:path";

import {
  PROJECT_COPY_FOLDER_LEFT_OUT_FILE_NAMES,
  PROJECT_COPY_FOLDER_LEFT_OUT_NAMES,
  PROJECT_COPY_FOLDER_MAX_BYTES,
  PROJECT_COPY_FOLDER_MAX_FILES,
  PROJECT_COPY_MAX_IGNORED_FILE_BYTES,
  ProjectCopyRelativePath,
  type ProjectExportFolder,
  type ProjectExportIgnoredCandidate,
} from "@ryco/contracts/project-copy";
import { Effect, Schema } from "effect";

import { PROJECT_EXPORT_SKIP_REASON, projectCopyIo } from "./exportGit.ts";

/** The walk stops (as "over limit") past this, rather than hold up the dialog. */
const FOLDER_SCAN_TIME_BUDGET_MS = 30 * 1000;
const FOLDER_SCAN_MAX_DEPTH = 64;
const LEFT_OUT_LISTED_MAX = 20;
const CANDIDATES_MAX = 100;

const LEFT_OUT_DIRECTORIES = new Set(PROJECT_COPY_FOLDER_LEFT_OUT_NAMES);
const LEFT_OUT_FILES = new Set(PROJECT_COPY_FOLDER_LEFT_OUT_FILE_NAMES);
const isRelativePath = Schema.is(ProjectCopyRelativePath);
// oxlint-disable-next-line no-control-regex -- control characters are what it refuses
const UNPORTABLE_NAME = /[\\\x00-\x1f\x7f]/;

/**
 * A file a copy carries only when asked: `.env`, `.env.local`, `.envrc`, …, but not the
 * templates projects commit next to them (`.env.example`).
 */
export const isFolderOptInName = (name: string): boolean =>
  name.startsWith(".env") && !/\.(?:example|sample|template|dist|defaults)$/i.test(name);

export interface FolderScan {
  /** Relative, slash-separated: directories (before their contents), files and symlinks. */
  readonly entries: ReadonlyArray<string>;
  /** Opt-in files found, each a regular file of at most 1 MiB; never in `entries`. */
  readonly candidates: ReadonlyArray<ProjectExportIgnoredCandidate>;
  readonly folder: ProjectExportFolder;
}

/**
 * Walks `root` depth first. `metadataDir` (the project's own folder, relative) is left out with
 * the dependency and cache folders. Stops as "over limit" past the file, byte or time budget.
 */
export const scanFolder = (input: {
  readonly root: string;
  readonly metadataDir: string;
  readonly nowMs?: () => number;
}): Effect.Effect<FolderScan> =>
  Effect.promise(async () => {
    const now = input.nowMs ?? Date.now;
    const deadline = now() + FOLDER_SCAN_TIME_BUDGET_MS;
    const metadataDir = input.metadataDir.replaceAll("\\", "/").replace(/\/+$/, "");
    const entries: string[] = [];
    const candidates: ProjectExportIgnoredCandidate[] = [];
    const leftOut: string[] = [];
    let fileCount = 0;
    let totalBytes = 0;
    let overLimit = false;
    const leave = (relative: string) => {
      if (leftOut.length < LEFT_OUT_LISTED_MAX) leftOut.push(relative);
    };
    // Directories still to read, relative ("" is the root), deepest last so the walk is pre-order.
    const stack: Array<{ readonly relative: string; readonly depth: number }> = [
      { relative: "", depth: 0 },
    ];
    walk: while (stack.length > 0) {
      const { relative, depth } = stack.pop()!;
      const absolute =
        relative === "" ? input.root : nodePath.join(input.root, ...relative.split("/"));
      const dirents = await fsp.readdir(absolute, { withFileTypes: true }).catch(() => null);
      if (dirents === null) {
        // Unreadable: it travels as an empty folder (its own entry is already listed).
        continue;
      }
      const children: Array<{ readonly relative: string; readonly depth: number }> = [];
      for (const dirent of dirents.toSorted((left, right) => (left.name < right.name ? -1 : 1))) {
        if (now() > deadline) {
          overLimit = true;
          break walk;
        }
        const name = dirent.name;
        const child = relative === "" ? name : `${relative}/${name}`;
        // A name another OS can't hold travels nowhere (a backslash is a separator on Windows).
        if (UNPORTABLE_NAME.test(name)) {
          leave(child);
          continue;
        }
        if (dirent.isDirectory()) {
          if (LEFT_OUT_DIRECTORIES.has(name) || child === metadataDir) {
            leave(child);
            continue;
          }
          entries.push(child);
          if (depth + 1 < FOLDER_SCAN_MAX_DEPTH)
            children.push({ relative: child, depth: depth + 1 });
          continue;
        }
        if (dirent.isSymbolicLink()) {
          entries.push(child);
          continue;
        }
        // Sockets, FIFOs and devices never travel.
        if (!dirent.isFile() || LEFT_OUT_FILES.has(name)) continue;
        const info = await fsp.lstat(nodePath.join(absolute, name)).catch(() => null);
        if (info === null || !info.isFile()) continue;
        if (isFolderOptInName(name)) {
          if (
            info.size <= PROJECT_COPY_MAX_IGNORED_FILE_BYTES &&
            isRelativePath(child) &&
            candidates.length < CANDIDATES_MAX
          ) {
            candidates.push({ path: child, byteLength: info.size });
          }
          continue;
        }
        fileCount += 1;
        totalBytes += info.size;
        if (
          fileCount > PROJECT_COPY_FOLDER_MAX_FILES ||
          totalBytes > PROJECT_COPY_FOLDER_MAX_BYTES
        ) {
          overLimit = true;
          break walk;
        }
        entries.push(child);
      }
      // Pushed in reverse so the first child is read next.
      for (let index = children.length - 1; index >= 0; index -= 1) stack.push(children[index]!);
    }
    return {
      entries,
      candidates,
      folder: {
        fileCount,
        totalBytes,
        leftOut,
        skippedReason: overLimit ? PROJECT_EXPORT_SKIP_REASON.overLimit : null,
      },
    };
  });

/**
 * Writes the scan's entries, plus the opted-in `includePaths`, below `root` as a gzipped tar at
 * `file`: portable headers (no owners), symlinks as links, file modes kept.
 */
export const buildFolderArchive = (input: {
  readonly root: string;
  readonly scan: FolderScan;
  readonly includePaths: ReadonlyArray<string>;
  readonly file: string;
}) =>
  projectCopyIo("Packing the folder", async () => {
    const tar = await import("tar");
    // Opted-in files go in after the walk's own entries: their folders are already listed.
    const entries = [...input.scan.entries, ...input.includePaths];
    await tar.create(
      {
        gzip: true,
        file: input.file,
        cwd: input.root,
        portable: true,
        noDirRecurse: true,
        follow: false,
        // A file that vanished since the walk is skipped, not fatal.
        strict: false,
        onwarn: () => undefined,
      },
      // tar refuses an empty list: an empty folder travels as its own root entry.
      entries.length === 0 ? ["."] : entries,
    );
  });
