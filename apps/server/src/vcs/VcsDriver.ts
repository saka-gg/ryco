import { Context, type Effect } from "effect";

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
  readonly listRemotes: (cwd: string) => Effect.Effect<VcsListRemotesResult, VcsError>;
  readonly filterIgnoredPaths: (
    cwd: string,
    relativePaths: ReadonlyArray<string>,
  ) => Effect.Effect<ReadonlyArray<string>, VcsError>;
  readonly initRepository: (input: VcsInitInput) => Effect.Effect<void, VcsError>;
}

export class VcsDriver extends Context.Service<VcsDriver, VcsDriverShape>()("ryco/vcs/VcsDriver") {}
