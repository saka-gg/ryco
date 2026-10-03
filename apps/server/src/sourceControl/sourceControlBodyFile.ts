import { Effect, type FileSystem } from "effect";
import { SourceControlProviderError, type SourceControlProviderKind } from "@ryco/contracts";

/**
 * Stage a Markdown body in a temp file for CLIs that take `--body-file`, and
 * always remove it afterwards. Bodies never travel as argv: argv is visible in
 * process listings and echoed back inside process-runner failure messages.
 */
export const withSourceControlBodyFile = <A, E>(
  fileSystem: FileSystem.FileSystem,
  input: {
    readonly provider: SourceControlProviderKind;
    readonly operation: string;
    readonly prefix: string;
    readonly body: string;
  },
  useBodyFile: (bodyFile: string) => Effect.Effect<A, E>,
): Effect.Effect<A, E | SourceControlProviderError> =>
  Effect.gen(function* () {
    const bodyFile = yield* fileSystem.makeTempFile({ prefix: input.prefix, suffix: ".md" }).pipe(
      Effect.mapError(
        (cause) =>
          new SourceControlProviderError({
            provider: input.provider,
            operation: input.operation,
            detail: "Failed to create a temp file for the body.",
            cause,
          }),
      ),
    );
    const work = Effect.gen(function* () {
      yield* fileSystem.writeFileString(bodyFile, input.body).pipe(
        Effect.mapError(
          (cause) =>
            new SourceControlProviderError({
              provider: input.provider,
              operation: input.operation,
              detail: "Failed to write the body temp file.",
              cause,
            }),
        ),
      );
      return yield* useBodyFile(bodyFile);
    });
    return yield* work.pipe(
      Effect.ensuring(fileSystem.remove(bodyFile).pipe(Effect.catch(() => Effect.void))),
    );
  });
