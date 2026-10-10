import { authorizeGitReadWorkspace } from "./GitReadWorkspace.ts";
import type { WorkspaceAccessPolicy } from "../workspace/Services/WorkspaceAccessPolicy.ts";
import { Effect, Option, Schema } from "effect";
import {
  GitCommandError,
  GitReadImageBlobInput,
  type GitReadImageBlobResult,
  PROJECT_READ_FILE_BINARY_MAX_BYTES,
} from "@ryco/contracts";
import { detectRasterImageMimeType } from "../imageMime.ts";
import type { GitVcsDriverShape } from "./GitVcsDriver.ts";

const unavailable = (reason: string): GitReadImageBlobResult => ({ kind: "unavailable", reason });

/** Reads only an object already stored in the repository; never the index or working file. */
export const readGitImageBlob = Effect.fn("readGitImageBlob")(function* (
  execute: GitVcsDriverShape["execute"],
  input: GitReadImageBlobInput,
): Effect.fn.Return<GitReadImageBlobResult, GitCommandError, WorkspaceAccessPolicy> {
  if (Option.isNone(Schema.decodeUnknownOption(GitReadImageBlobInput)(input)))
    return yield* new GitCommandError({
      operation: "readImageBlob",
      cwd: input.cwd,
      command: "git cat-file",
      detail: "A blob object ID is required.",
    });
  const cwd = yield* authorizeGitReadWorkspace(execute, input.cwd, "readImageBlob");
  const run = (
    args: readonly string[],
    options?: { readonly allowNonZeroExit?: boolean; readonly stdoutBytes?: boolean },
  ) =>
    execute({
      operation: "readImageBlob",
      cwd,
      args,
      // A preview must not fetch from a promisor remote in a partial clone.
      env: { GIT_OPTIONAL_LOCKS: "0", GIT_NO_LAZY_FETCH: "1" },
      timeoutMs: 10_000,
      maxOutputBytes: options?.stdoutBytes ? PROJECT_READ_FILE_BINARY_MAX_BYTES : 4096,
      ...options,
    });
  // Peeling to a blob type-checks the object; a missing or ambiguous abbreviation fails here.
  const resolved = yield* run(["rev-parse", "--verify", "--quiet", `${input.oid}^{blob}`], {
    allowNonZeroExit: true,
  });
  const oid = resolved.stdout.trim();
  if (resolved.exitCode !== 0 || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(oid))
    return unavailable("This version is not stored in the repository.");
  const size = Number((yield* run(["cat-file", "-s", oid])).stdout.trim());
  if (!Number.isSafeInteger(size) || size > PROJECT_READ_FILE_BINARY_MAX_BYTES)
    return unavailable("This image is too large to preview.");
  const bytes = (yield* run(["cat-file", "blob", oid], { stdoutBytes: true })).stdoutBytes;
  const mimeType = bytes ? detectRasterImageMimeType(bytes) : null;
  if (!bytes || mimeType === null) return unavailable("Not a supported image.");
  return {
    kind: "image",
    dataBase64: Buffer.from(bytes).toString("base64"),
    mimeType,
    sizeBytes: bytes.byteLength,
  };
});
