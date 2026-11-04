/**
 * ProjectSetupCommand - runs an import's setup command (the exact text the user or the approved
 * plan pinned) in the new project's root, unattended.
 *
 * It runs through the terminal manager's shell resolver (`$SHELL -lc`, the default shell on
 * Windows) with stdin closed, and the environment terminals get plus the project script
 * variables: nothing of the server's own `RYCO_*`, `VITE_*`, `PORT` or `ELECTRON_RUN_AS_NODE`
 * reaches it. Interrupting it cancels (see `ProjectCopyProcess`).
 *
 * @module ProjectSetupCommand
 */
import { Context } from "effect";
import type { Effect } from "effect";

import type { ProjectSetupCommandError } from "../Errors.ts";
import type { ProjectCopyProcessObserver } from "./ProjectCopyProcess.ts";

export interface ProjectSetupCommandInput {
  /** At most `PROJECT_COPY_SETUP_COMMAND_MAX_CHARS`. */
  readonly command: string;
  /** The working directory, and the project and worktree root of the script variables. */
  readonly projectRoot: string;
  /** Default 30 minutes. */
  readonly timeoutMs?: number | undefined;
  readonly observer?: ProjectCopyProcessObserver | undefined;
}

export interface ProjectSetupCommandResult {
  readonly outcome: "succeeded" | "failed" | "timed-out";
  /** Null when it was killed (timed out) or ended by a signal. */
  readonly exitCode: number | null;
  /** The last readable lines, terminal escapes stripped (`TerminalOutputTail`). */
  readonly outputTail: string;
}

export interface ProjectSetupCommandShape {
  /** Runs it to the end; a command that fails or times out is a result, not an error. */
  readonly run: (
    input: ProjectSetupCommandInput,
  ) => Effect.Effect<ProjectSetupCommandResult, ProjectSetupCommandError>;
}

export class ProjectSetupCommand extends Context.Service<
  ProjectSetupCommand,
  ProjectSetupCommandShape
>()("ryco/projectCopy/Services/ProjectSetupCommand") {}
