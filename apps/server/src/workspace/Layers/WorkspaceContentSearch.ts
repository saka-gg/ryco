import { lstat, realpath } from "node:fs/promises";

import { Effect, Layer, Option, Path, Stream } from "effect";
import * as Semaphore from "effect/Semaphore";

import type { ProjectContentMatch, ProjectSearchContentResult, VcsError } from "@ryco/contracts";
import { openRegularFile } from "@ryco/shared/regularFile";

import { GIT_PROCESS_LIMIT } from "../../processGovernor.ts";
import type { VcsDriverShape, VcsWorkspaceContentSearchOptions } from "../../vcs/VcsDriver.ts";
import { VcsDriverRegistry } from "../../vcs/VcsDriverRegistry.ts";
import {
  decodeContentSearchCursor,
  encodeContentSearchCursor,
  makeLiteralMatcher,
  type ContentSearchCursor,
  type LiteralMatcher,
} from "../contentSearchText.ts";
import { indexAfterPath } from "../pathOrder.ts";
import {
  WorkspaceContentSearch,
  WorkspaceContentSearchCursorError,
  WorkspaceContentSearchError,
  type WorkspaceContentSearchShape,
} from "../Services/WorkspaceContentSearch.ts";
import { WorkspaceEntries } from "../Services/WorkspaceEntries.ts";
import { WorkspacePaths } from "../Services/WorkspacePaths.ts";
import { IGNORED_DIRECTORY_NAMES, isPathInIgnoredDirectory } from "./WorkspaceEntries.ts";
import { isLikelyBinaryPreview, WORKSPACE_PREVIEW_MAX_BYTES } from "./WorkspaceFileSystem.ts";

/**
 * One page's budget from request to answer, waits for a search slot and a cold
 * index included: a page answers long before a hosted relay's 5 s stall probe,
 * and a timed-out page carries a cursor to continue from.
 */
const CONTENT_SEARCH_TIME_BUDGET_MS = 1_000;
/** Matching lines kept per file, and never more than a page holds. */
const CONTENT_SEARCH_MAX_MATCHES_PER_FILE = 100;
/** Files one search reads at once. */
const CONTENT_SEARCH_SCAN_CONCURRENCY = 8;
/**
 * Searches running at once on the node; a client interrupts the searches it
 * supersedes. Each may hold a git child, so the git pool (two children at
 * least) always keeps room for other reads.
 */
const CONTENT_SEARCH_MAX_CONCURRENT = Math.min(2, GIT_PROCESS_LIMIT - 1);
/** The Files panel cannot open longer paths, so they are not searched. */
const CONTENT_SEARCH_MAX_PATH_LENGTH = 512;

const CONTENT_SEARCH_TEXT_DECODER = new TextDecoder("utf-8");
const FIRST_PAGE: ContentSearchCursor = { afterPath: "", scanIndex: false };
const EXCLUDED_TOP_LEVEL_NAMES = [...IGNORED_DIRECTORY_NAMES];

/** A file a source finished, in path order. One without matches still moves the cursor past it. */
export interface ContentSearchFile {
  readonly path: string;
  readonly matches: ReadonlyArray<ProjectContentMatch>;
}

/**
 * Collects whole files into one page, which resumes after the last file it
 * took. A file whose matches would overflow the page ends it, unless it is the
 * page's first file: a full page always moves past at least one file.
 */
export function makeContentSearchPage(afterPath: string, limit: number) {
  const matches: ProjectContentMatch[] = [];
  let lastPath = afterPath;
  let full = false;
  return {
    /** Takes the next file; false once the page is full. */
    add: (file: ContentSearchFile): boolean => {
      if (matches.length > 0 && matches.length + file.matches.length > limit) {
        full = true;
        return false;
      }
      matches.push(...file.matches);
      lastPath = file.path;
      full = matches.length >= limit;
      return !full;
    },
    /** The path the page resumes after so far. */
    lastPath: () => lastPath,
    result: (end: {
      readonly timedOut: boolean;
      readonly partial: boolean;
      readonly scanIndex: boolean;
    }): ProjectSearchContentResult => ({
      matches,
      ...(full || end.timedOut
        ? {
            nextCursor: encodeContentSearchCursor({
              afterPath: lastPath,
              scanIndex: end.scanIndex,
            }),
          }
        : {}),
      ...(end.timedOut ? { timedOut: true } : {}),
      ...(end.partial ? { partial: true } : {}),
    }),
  };
}

/** Never empty, padded or too long: the Files panel could not open the path. */
function isSearchablePath(path: string): boolean {
  return path.length > 0 && path.length <= CONTENT_SEARCH_MAX_PATH_LENGTH && path.trim() === path;
}

function* searchablePaths(paths: ReadonlyArray<string>, start: number): Generator<string> {
  for (let index = start; index < paths.length; index += 1) {
    const path = paths[index];
    if (path !== undefined && isSearchablePath(path)) yield path;
  }
}

/** A regular file small enough to preview, as the index scanner would read it. */
const isPreviewableFile = (absolutePath: string): Promise<boolean> =>
  lstat(absolutePath).then(
    (stat) => stat.isFile() && stat.size <= WORKSPACE_PREVIEW_MAX_BYTES,
    () => false,
  );

/**
 * The file's text, or null unless it is a regular file (a final link is not
 * followed) small enough to preview that does not look binary. A link in its
 * folder path is followed, so callers first check that the folder stays in the
 * workspace.
 */
async function readSearchableText(absolutePath: string): Promise<string | null> {
  const opened = await openRegularFile(absolutePath).catch(() => null);
  if (opened === null) return null;
  const { handle, stat } = opened;
  try {
    if (stat.size > WORKSPACE_PREVIEW_MAX_BYTES) return null;
    // Only the size it had when opened: a file growing meanwhile cannot balloon the read.
    const bytes = Buffer.allocUnsafe(stat.size);
    let length = 0;
    while (length < bytes.byteLength) {
      const { bytesRead } = await handle.read(bytes, length, bytes.byteLength - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    const contents = bytes.subarray(0, length);
    return isLikelyBinaryPreview(contents) ? null : CONTENT_SEARCH_TEXT_DECODER.decode(contents);
  } catch {
    return null;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

export const makeWorkspaceContentSearch = Effect.gen(function* () {
  const path = yield* Path.Path;
  const workspacePaths = yield* WorkspacePaths;
  const workspaceEntries = yield* WorkspaceEntries;
  const vcsRegistry = yield* VcsDriverRegistry;
  const searchPermits = yield* Semaphore.make(CONTENT_SEARCH_MAX_CONCURRENT);

  /**
   * Whether a workspace file's folder resolves inside the workspace, as the
   * Files panel requires to open the file. An index path can pass through a
   * folder link: git lists tracked paths whatever the checkout now holds
   * there, and a walked folder can become a link while its index is cached.
   * One lookup per folder.
   */
  const makeFolderContainment = (root: string) => {
    let realRoot: Promise<string> | undefined;
    const folders = new Map<string, Promise<boolean>>();
    const staysInside = (realRootPath: string, realFolder: string) => {
      const relative = path.relative(realRootPath, realFolder);
      return (
        relative.length === 0 ||
        (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
      );
    };
    return (relativePath: string): Promise<boolean> => {
      const folder = path.dirname(relativePath);
      if (folder === ".") return Promise.resolve(true);
      let inside = folders.get(folder);
      if (inside === undefined) {
        realRoot ??= realpath(root);
        inside = Promise.all([realRoot, realpath(path.join(root, folder))]).then(
          ([realRootPath, realFolder]) => staysInside(realRootPath, realFolder),
          () => false,
        );
        folders.set(folder, inside);
      }
      return inside;
    };
  };

  /** The root's VCS search (git grep), or null to scan the index. */
  const detectVcsSearch = (root: string) =>
    vcsRegistry.detect({ cwd: root }).pipe(
      Effect.map((handle) => handle?.driver.streamWorkspaceContentMatches ?? null),
      Effect.catch(() => Effect.succeed(null)),
    );

  /**
   * The VCS search's files, limited to the files the index scanner reads: one
   * too large to preview, or outside the workspace, counts as a file without
   * matches.
   */
  const searchVcsFiles = (
    streamMatches: NonNullable<VcsDriverShape["streamWorkspaceContentMatches"]>,
    root: string,
    options: VcsWorkspaceContentSearchOptions,
    matcher: LiteralMatcher,
  ): Stream.Stream<ContentSearchFile, VcsError> => {
    const isInside = makeFolderContainment(root);
    return streamMatches(root, options).pipe(
      Stream.filter((file) => isSearchablePath(file.path) && !isPathInIgnoredDirectory(file.path)),
      Stream.mapEffect((file) =>
        Effect.promise(async () =>
          (await isInside(file.path)) ? isPreviewableFile(path.join(root, file.path)) : false,
        ).pipe(
          Effect.map((previewable) => ({
            path: file.path,
            matches: previewable
              ? file.lines.map((line) => matcher.matchFoundLine(file.path, line))
              : [],
          })),
        ),
      ),
    );
  };

  /**
   * Every searchable index file after `afterPath`, in order, read a few at a
   * time. An unreadable file, or one outside the workspace, counts as one
   * without matches.
   */
  const scanIndexFiles = (
    root: string,
    paths: ReadonlyArray<string>,
    afterPath: string,
    matcher: LiteralMatcher,
    maxMatchesPerFile: number,
  ): Stream.Stream<ContentSearchFile> => {
    const isInside = makeFolderContainment(root);
    return Stream.fromIterable(searchablePaths(paths, indexAfterPath(paths, afterPath))).pipe(
      Stream.mapEffect(
        (relativePath) =>
          Effect.promise(async () =>
            (await isInside(relativePath))
              ? readSearchableText(path.join(root, relativePath))
              : null,
          ).pipe(
            Effect.map((text) => ({
              path: relativePath,
              matches:
                text === null ? [] : matcher.findMatches(relativePath, text, maxMatchesPerFile),
            })),
          ),
        { concurrency: CONTENT_SEARCH_SCAN_CONCURRENCY },
      ),
    );
  };

  const search: WorkspaceContentSearchShape["search"] = Effect.fn("WorkspaceContentSearch.search")(
    function* (input) {
      const cursor =
        input.cursor === undefined ? FIRST_PAGE : decodeContentSearchCursor(input.cursor);
      if (cursor === null) {
        return yield* new WorkspaceContentSearchCursorError({ cwd: input.cwd });
      }
      const options = {
        caseSensitive: input.caseSensitive === true,
        wholeWord: input.wholeWord === true,
      };
      const matcher = makeLiteralMatcher(input.query, options);
      const maxMatchesPerFile = Math.min(CONTENT_SEARCH_MAX_MATCHES_PER_FILE, input.limit);
      const page = makeContentSearchPage(cursor.afterPath, input.limit);
      let partial = false;
      let scanIndex = cursor.scanIndex;
      // git cannot resume where it stopped: a page it ran out of time on continues
      // by scanning the index, which moves past files without matches too.
      let searchingVcs = false;
      const finished = yield* Effect.gen(function* () {
        const root = yield* workspacePaths.normalizeWorkspaceRoot(input.cwd).pipe(
          Effect.mapError(
            (cause) =>
              new WorkspaceContentSearchError({
                cwd: input.cwd,
                operation: "workspaceContentSearch.normalizeWorkspaceRoot",
                detail: cause.message,
                cause,
              }),
          ),
        );
        const streamMatches = scanIndex ? null : yield* detectVcsSearch(root);
        if (streamMatches !== null) {
          searchingVcs = true;
          const searched = yield* Stream.runForEachWhile(
            searchVcsFiles(
              streamMatches,
              root,
              {
                query: input.query,
                ...options,
                afterPath: cursor.afterPath,
                maxLinesPerFile: maxMatchesPerFile,
                excludedTopLevelNames: EXCLUDED_TOP_LEVEL_NAMES,
              },
              matcher,
            ),
            (file) => Effect.sync(() => page.add(file)),
          ).pipe(
            Effect.as(true),
            Effect.catch((error) =>
              Effect.logWarning("content search: git grep failed; scanning the index", {
                cwd: input.cwd,
                detail: error.message,
              }).pipe(Effect.as(false)),
            ),
          );
          searchingVcs = false;
          if (searched) return;
          // The scan continues after the last file git finished, here and on later pages.
          scanIndex = true;
        }
        const files = yield* workspaceEntries.readSearchFiles(root).pipe(
          Effect.mapError(
            (cause) =>
              new WorkspaceContentSearchError({
                cwd: input.cwd,
                operation: "workspaceContentSearch.readSearchFiles",
                detail: cause.detail,
                cause,
              }),
          ),
        );
        partial = files.partial;
        yield* Stream.runForEachWhile(
          scanIndexFiles(root, files.paths, page.lastPath(), matcher, maxMatchesPerFile),
          (file) => Effect.sync(() => page.add(file)),
        );
      }).pipe(searchPermits.withPermits(1), Effect.timeoutOption(CONTENT_SEARCH_TIME_BUDGET_MS));
      const timedOut = Option.isNone(finished);
      return page.result({
        timedOut,
        partial,
        scanIndex: scanIndex || (timedOut && searchingVcs),
      });
    },
  );

  return { search } satisfies WorkspaceContentSearchShape;
});

export const WorkspaceContentSearchLive = Layer.effect(
  WorkspaceContentSearch,
  makeWorkspaceContentSearch,
);
