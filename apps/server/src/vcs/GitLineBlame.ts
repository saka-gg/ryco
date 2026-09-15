import { authorizeGitReadWorkspace } from "./GitReadWorkspace.ts";
import type { WorkspaceAccessPolicy } from "../workspace/Services/WorkspaceAccessPolicy.ts";
import { Effect, Option, Schema } from "effect";
import {
  GitCommandError,
  GitReadLineBlameInput,
  type GitReadLineBlameResult,
} from "@ryco/contracts";
import type { GitVcsDriverShape } from "./GitVcsDriver.ts";

const unavailable = (reason: string): GitReadLineBlameResult => ({ kind: "unavailable", reason });

/** Parse only metadata before the content record; malformed/truncated output is never attribution. */
export function parseLineBlame(stdout: string, requestedLine: number): GitReadLineBlameResult {
  const lines = stdout.split("\n");
  const header = /^(?<oid>[0-9a-f]{40}|[0-9a-f]{64}) \d+ (?<line>\d+) 1$/.exec(lines[0] ?? "");
  const oid = header?.groups?.oid;
  if (!oid || Number(header?.groups?.line) !== requestedLine || /^0+$/.test(oid))
    return unavailable("No committed provenance is available for this line.");
  const content = lines.findIndex((line) => line.startsWith("\t"));
  if (content < 0) return unavailable("Incomplete blame response.");
  const fields = new Map(
    lines.slice(1, content).map((line) => {
      const space = line.indexOf(" ");
      return [line.slice(0, space), line.slice(space + 1)];
    }),
  );
  const author = fields.get("author");
  const summary = fields.get("summary");
  if (author === undefined || summary === undefined)
    return unavailable("Incomplete blame metadata.");
  if (summary.startsWith("ryco checkpoint ref="))
    return unavailable("Checkpoint snapshots do not establish committed provenance.");
  const rawTime = fields.get("author-time");
  const seconds = rawTime && /^-?\d+$/.test(rawTime) ? Number(rawTime) : NaN;
  const date = new Date(seconds * 1000);
  return {
    kind: "committed",
    oid,
    author,
    summary,
    authorTime: Number.isFinite(date.getTime()) ? date.toISOString() : null,
  };
}

/** Uses only the supplied immutable OID, and never reads the index or working file. */
export const readGitLineBlame = Effect.fn("readGitLineBlame")(function* (
  execute: GitVcsDriverShape["execute"],
  input: GitReadLineBlameInput,
): Effect.fn.Return<GitReadLineBlameResult, GitCommandError, WorkspaceAccessPolicy> {
  const fail = (detail: string) =>
    new GitCommandError({
      operation: "readLineBlame",
      cwd: input.cwd,
      command: "git blame",
      detail,
    });
  if (Option.isNone(Schema.decodeUnknownOption(GitReadLineBlameInput)(input)))
    return yield* fail(
      "An immutable commit ID, relative file path and positive line are required.",
    );
  const cwd = yield* authorizeGitReadWorkspace(execute, input.cwd, "readLineBlame");
  const run = (args: readonly string[], maxOutputBytes = 4096) =>
    execute({
      operation: "readLineBlame",
      cwd,
      args,
      env: { GIT_OPTIONAL_LOCKS: "0" },
      timeoutMs: 10_000,
      maxOutputBytes,
    });
  if ((yield* run(["cat-file", "-t", input.oid])).stdout.trim() !== "commit")
    return yield* fail("The displayed object is not a commit. Refresh the comparison.");
  const entry = (yield* run(
    ["--literal-pathspecs", "ls-tree", "-z", input.oid, "--", input.filePath],
    8192,
  )).stdout;
  if (!/^100(?:644|755) blob [0-9a-f]+\t[^\0]+\0$/.test(entry))
    return unavailable("Blame is available only for regular text files at this revision.");
  // Bound the file read as well as blame output; do not follow historical or working-tree symlinks.
  const blob = (yield* run(["cat-file", "blob", `${input.oid}:${input.filePath}`], 2_000_000))
    .stdout;
  if (blob.includes("\0")) return unavailable("Blame is unavailable for binary files.");
  const lineCount = blob.length === 0 ? 0 : blob.split("\n").length - (blob.endsWith("\n") ? 1 : 0);
  if (input.line > lineCount)
    return unavailable("This line does not exist at the displayed revision.");
  const result = yield* run(
    [
      "-c",
      "blame.ignoreRevsFile=",
      "blame",
      "--porcelain",
      "--no-textconv",
      "--root",
      "-L",
      `${input.line},${input.line}`,
      input.oid,
      "--",
      input.filePath,
    ],
    64_000,
  );
  return parseLineBlame(result.stdout, input.line);
});
