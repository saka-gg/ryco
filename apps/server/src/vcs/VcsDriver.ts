import { Context, type Effect, type Stream } from "effect";

import type {
  VcsDriverCapabilities,
  VcsError,
  VcsInitInput,
  VcsListRemotesResult,
  VcsListWorkspaceFilesResult,
  VcsRepositoryIdentity,
} from "@ryco/contracts";
import * as VcsProcess from "./VcsProcess.ts";

export interface VcsListWorkspaceFilesOptions {
  /** List tracked files only: answered from the index without walking the working tree. */
  readonly trackedOnly?: boolean;
}

export interface VcsWorkspaceContentSearchOptions {
  /** Literal text; it never travels in a process's arguments. */
  readonly query: string;
  readonly caseSensitive: boolean;
  /** Whole words by `git grep -w`'s rule: ASCII letters, digits and `_` are word characters. */
  readonly wholeWord: boolean;
  /** Only files after this path in UTF-8 byte order; "" for every file. */
  readonly afterPath: string;
  readonly maxLinesPerFile: number;
  /** Files and folders directly in the searched folder that are never searched. */
  readonly excludedTopLevelNames: ReadonlyArray<string>;
}

/** A line containing the query: the whole line, or a window of a long one around its first match. */
export interface VcsWorkspaceContentLine {
  readonly lineNumber: number;
  /** Without the line ending. */
  readonly text: string;
  /** Where the first match starts in `text`, in UTF-16 code units. */
  readonly matchStart: number;
  /** The window leaves out the start of the line. */
  readonly cutStart: boolean;
  /** The window leaves out the end of the line. */
  readonly cutEnd: boolean;
}

export interface VcsWorkspaceContentFile {
  /** Relative to the searched folder, `/`-separated. */
  readonly path: string;
  readonly lines: ReadonlyArray<VcsWorkspaceContentLine>;
}

export interface VcsDriverShape {
  readonly capabilities: VcsDriverCapabilities;
  readonly execute: (
    input: Omit<VcsProcess.VcsProcessInput, "command">,
  ) => Effect.Effect<VcsProcess.VcsProcessOutput, VcsError>;
  readonly detectRepository: (cwd: string) => Effect.Effect<VcsRepositoryIdentity | null, VcsError>;
  readonly isInsideWorkTree: (cwd: string) => Effect.Effect<boolean, VcsError>;
  /**
   * Non-ignored workspace files, each listed once: tracked files first, then
   * untracked ones. Tracked files that match ignore rules are excluded.
   */
  readonly listWorkspaceFiles: (
    cwd: string,
    options?: VcsListWorkspaceFilesOptions,
  ) => Effect.Effect<VcsListWorkspaceFilesResult, VcsError>;
  /**
   * Workspace files containing the query, in UTF-8 byte order of their paths,
   * each emitted once all its matching lines are read. It searches the same
   * files as {@link listWorkspaceFiles}, read from the working tree; binary
   * files and links are skipped. Stopping the stream stops the search.
   */
  readonly streamWorkspaceContentMatches?: (
    cwd: string,
    options: VcsWorkspaceContentSearchOptions,
  ) => Stream.Stream<VcsWorkspaceContentFile, VcsError>;
  readonly listRemotes: (cwd: string) => Effect.Effect<VcsListRemotesResult, VcsError>;
  readonly filterIgnoredPaths: (
    cwd: string,
    relativePaths: ReadonlyArray<string>,
  ) => Effect.Effect<ReadonlyArray<string>, VcsError>;
  readonly initRepository: (input: VcsInitInput) => Effect.Effect<void, VcsError>;
}

export class VcsDriver extends Context.Service<VcsDriver, VcsDriverShape>()("ryco/vcs/VcsDriver") {}
