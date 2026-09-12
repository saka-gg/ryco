import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { TextGenerationError } from "@ryco/contracts";

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

/** An empty working directory prevents project instructions from entering the snapshot. */
export const sideQuestionDirectory = Effect.acquireRelease(
  Effect.tryPromise({
    try: () => mkdtemp(join(tmpdir(), "ryco-side-question-")),
    catch: (cause) =>
      new TextGenerationError({
        operation: "answerSideQuestion",
        detail: "Could not create an isolated side question directory.",
        cause,
      }),
  }),
  (path) => Effect.promise(() => rm(path, { recursive: true, force: true })).pipe(Effect.ignore),
);
