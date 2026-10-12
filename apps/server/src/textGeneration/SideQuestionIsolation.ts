import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { TextGenerationError } from "@ryco/contracts";

/**
 * Operations that run as lightweight, isolated CLI calls: no user config,
 * project instructions, MCP servers, plugins, hooks or tools, in an empty
 * directory. Side questions always do; titles and branch names try it first
 * and fall back to the full configuration (see `withFullConfigFallback`).
 */
export type LightweightTextGenerationOperation =
  | "answerSideQuestion"
  | "generateThreadTitle"
  | "generateBranchName";

/** The system prompt that replaces the provider's coding-agent prompt for a lightweight call. */
export function lightweightSystemPrompt(operation: string): string {
  return operation === "answerSideQuestion"
    ? "Answer only from the supplied context. You have no tools or mutation authority."
    : "Name the user's request as asked, from the supplied message only. You have no tools or mutation authority.";
}

/** Never pass main-turn control credentials to an independent side process. */
export function sideQuestionEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(environment).filter(
      ([key]) =>
        !key.startsWith("RYCO_") &&
        !key.startsWith("T3CODE_") &&
        !["CODEX_THREAD_ID", "CLAUDE_CODE_SESSION_ID"].includes(key),
    ),
  );
}

/** An empty working directory keeps project instructions out of a lightweight call. */
export const isolatedTextGenerationDirectory = (operation: LightweightTextGenerationOperation) =>
  Effect.acquireRelease(
    Effect.tryPromise({
      try: () => mkdtemp(join(tmpdir(), "ryco-side-question-")),
      catch: (cause) =>
        new TextGenerationError({
          operation,
          detail: "Could not create an isolated text generation directory.",
          cause,
        }),
    }),
    (path) => Effect.promise(() => rm(path, { recursive: true, force: true })).pipe(Effect.ignore),
  );

export const sideQuestionDirectory = isolatedTextGenerationDirectory("answerSideQuestion");

/**
 * Runs a lightweight call and, when it fails for a reason the user's own
 * configuration may fix (custom model providers, API key helpers, settings
 * env), the same request once more with that configuration. A timeout is
 * final: the full configuration would only be slower.
 */
export const withFullConfigFallback = <A, R1, R2>(input: {
  readonly operation: LightweightTextGenerationOperation;
  readonly lightweight: Effect.Effect<A, TextGenerationError, R1>;
  readonly full: Effect.Effect<A, TextGenerationError, R2>;
  readonly isTimeout: (error: TextGenerationError) => boolean;
}): Effect.Effect<A, TextGenerationError, R1 | R2> =>
  input.lightweight.pipe(
    Effect.catch((error) =>
      input.isTimeout(error)
        ? Effect.fail(error)
        : Effect.logDebug("lightweight text generation failed; retrying with full config", {
            operation: input.operation,
            detail: error.detail,
          }).pipe(Effect.andThen(input.full)),
    ),
  );
