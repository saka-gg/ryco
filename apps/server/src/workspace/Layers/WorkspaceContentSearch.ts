import { Effect, Layer, Option, Path, Stream } from "effect";
import * as Semaphore from "effect/Semaphore";

import type { ProjectContentMatch, ProjectSearchContentResult } from "@ryco/contracts";
import { openRegularFile } from "@ryco/shared/regularFile";

import {
  decodeContentSearchCursor,
  encodeContentSearchCursor,
  makeLiteralMatcher,
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
/** Searches running at once on the node; a client interrupts the searches it supersedes. */
const CONTENT_SEARCH_MAX_CONCURRENT = 2;
/** The Files panel cannot open longer paths, so they are not searched. */
const CONTENT_SEARCH_MAX_PATH_LENGTH = 512;

const CONTENT_SEARCH_TEXT_DECODER = new TextDecoder("utf-8");

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
    result: (end: {
      readonly timedOut: boolean;
      readonly partial: boolean;
    }): ProjectSearchContentResult => ({
      matches,
      ...(full || end.timedOut ? { nextCursor: encodeContentSearchCursor(lastPath) } : {}),
      ...(end.timedOut ? { timedOut: true } : {}),
      ...(end.partial ? { partial: true } : {}),
    }),
  };
}

function* searchablePaths(paths: ReadonlyArray<string>, start: number): Generator<string> {
  for (let index = start; index < paths.length; index += 1) {
    const path = paths[index];
    if (
      path !== undefined &&
      path.length > 0 &&
      path.length <= CONTENT_SEARCH_MAX_PATH_LENGTH &&
      path.trim() === path
    ) {
      yield path;
    }
  }
}

/**
 * The file's text, or null unless it is a regular file (a final link is not
 * followed) small enough to preview that does not look binary. Index paths
 * never pass through a link: neither git nor the folder walk descends into one.
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
  const searchPermits = yield* Semaphore.make(CONTENT_SEARCH_MAX_CONCURRENT);

  /**
   * Every searchable index file after `afterPath`, in order, read a few at a
   * time. An unreadable file counts as one without matches.
   */
  const scanIndexFiles = (
    root: string,
    paths: ReadonlyArray<string>,
    afterPath: string,
    matcher: LiteralMatcher,
    maxMatchesPerFile: number,
  ): Stream.Stream<ContentSearchFile> =>
    Stream.fromIterable(searchablePaths(paths, indexAfterPath(paths, afterPath))).pipe(
      Stream.mapEffect(
        (relativePath) =>
          Effect.promise(() => readSearchableText(path.join(root, relativePath))).pipe(
            Effect.map((text) => ({
              path: relativePath,
              matches:
                text === null ? [] : matcher.findMatches(relativePath, text, maxMatchesPerFile),
            })),
          ),
        { concurrency: CONTENT_SEARCH_SCAN_CONCURRENCY },
      ),
    );

  const search: WorkspaceContentSearchShape["search"] = Effect.fn("WorkspaceContentSearch.search")(
    function* (input) {
      const afterPath = input.cursor === undefined ? "" : decodeContentSearchCursor(input.cursor);
      if (afterPath === null) {
        return yield* new WorkspaceContentSearchCursorError({ cwd: input.cwd });
      }
      const matcher = makeLiteralMatcher(input.query, {
        caseSensitive: input.caseSensitive === true,
        wholeWord: input.wholeWord === true,
      });
      const page = makeContentSearchPage(afterPath, input.limit);
      let partial = false;
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
          scanIndexFiles(
            root,
            files.paths,
            afterPath,
            matcher,
            Math.min(CONTENT_SEARCH_MAX_MATCHES_PER_FILE, input.limit),
          ),
          (file) => Effect.sync(() => page.add(file)),
        );
      }).pipe(searchPermits.withPermits(1), Effect.timeoutOption(CONTENT_SEARCH_TIME_BUDGET_MS));
      return page.result({ timedOut: Option.isNone(finished), partial });
    },
  );

  return { search } satisfies WorkspaceContentSearchShape;
});

export const WorkspaceContentSearchLive = Layer.effect(
  WorkspaceContentSearch,
  makeWorkspaceContentSearch,
);
