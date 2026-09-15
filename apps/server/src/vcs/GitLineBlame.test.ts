import { ChildProcessSpawner } from "effect/unstable/process";
import { WorkspaceAccessPolicyLayer } from "../workspace/Layers/WorkspaceAccessPolicy.ts";
import {
  WorkspaceAccessPolicy,
  WorkspaceAccessDeniedError,
} from "../workspace/Services/WorkspaceAccessPolicy.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer } from "effect";
import { ServerConfig } from "../config.ts";
import * as Driver from "./GitVcsDriver.ts";
import { readGitLineBlame, parseLineBlame } from "./GitLineBlame.ts";
import { configureTestGitCommitIdentity } from "./testing/GitTestRepo.ts";
const layer = Driver.layer.pipe(
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "blame-test-" })),
  Layer.provideMerge(WorkspaceAccessPolicyLayer(undefined)),
  Layer.provideMerge(NodeServices.layer),
);

describe("line blame", () => {
  it("parses metadata without trusting source text and tolerates exotic timestamps", () => {
    const output = `${"a".repeat(64)} 2 20 1\nauthor Ada\nauthor-time 999999999999999999\nsummary Real summary\nfilename x\n\tsummary Fake\n`;
    expect(parseLineBlame(output, 20)).toEqual({
      kind: "committed",
      oid: "a".repeat(64),
      author: "Ada",
      summary: "Real summary",
      authorTime: null,
    });
    expect(
      parseLineBlame(output.replace("Real summary", "ryco checkpoint ref=refs/ryco/test"), 20).kind,
    ).toBe("unavailable");
    expect(parseLineBlame(output, 21).kind).toBe("unavailable");
    expect(parseLineBlame(output.replace("a".repeat(64), "0".repeat(64)), 20).kind).toBe(
      "unavailable",
    );
    expect(parseLineBlame(output.split("\t")[0]!, 20).kind).toBe("unavailable");
  });
  it.effect(
    "rejects a repository root outside the authorized subdirectory before reading objects",
    () =>
      Effect.gen(function* () {
        let reads = 0;
        const execute: Driver.GitVcsDriverShape["execute"] = (input) =>
          Effect.sync(() => {
            reads++;
            expect(input.args).toEqual(["rev-parse", "--show-toplevel"]);
            return {
              exitCode: ChildProcessSpawner.ExitCode(0),
              stdoutTruncated: false,
              stderrTruncated: false,
              stdout: "/outside-repository\n",
              stderr: "",
            };
          });
        const denied = yield* readGitLineBlame(execute, {
          cwd: "/outside-repository/allowed",
          oid: "a".repeat(40),
          filePath: "secret",
          line: 1,
        }).pipe(
          Effect.provideService(WorkspaceAccessPolicy, {
            accessRoot: "/outside-repository/allowed",
            isRestricted: true,
            assertPath: () => Effect.succeed("unused"),
            assertExistingPath: ({ path, operation }) =>
              path === "/outside-repository/allowed"
                ? Effect.succeed(path)
                : Effect.fail(
                    new WorkspaceAccessDeniedError({
                      requestedPath: path,
                      operation,
                      accessRoot: "/outside-repository/allowed",
                      reason: "outsideRoot",
                    }),
                  ),
          }),
          Effect.flip,
        );
        expect(denied.detail).toContain("access is restricted");
        expect(reads).toBe(1);
      }),
  );
  it.effect("reads old paths and frozen lines despite renames, dirty files and moving HEAD", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "ryco-blame-" });
      const driver = yield* Driver.GitVcsDriver;
      const git = (args: readonly string[]) => driver.execute({ operation: "test", cwd, args });
      yield* git(["init", "-b", "main"]);
      yield* configureTestGitCommitIdentity(cwd, (_, args) => git(args));
      yield* fs.writeFileString(`${cwd}/old.txt`, "first\nsecond\nthird\n");
      yield* git(["add", "."]);
      yield* git(["commit", "-m", "Original lines"]);
      const base = (yield* git(["rev-parse", "HEAD"])).stdout.trim();
      yield* git(["mv", "old.txt", "new.txt"]);
      yield* fs.writeFileString(`${cwd}/new.txt`, "inserted\nfirst\nthird\n");
      yield* git(["add", "."]);
      yield* git(["commit", "-m", "Rename and edit"]);
      const head = (yield* git(["rev-parse", "HEAD"])).stdout.trim();
      yield* fs.writeFileString(`${cwd}/new.txt`, "dirty\n");
      yield* git(["add", "."]);
      const status = (yield* git(["status", "--porcelain"])).stdout;
      const read = (oid: string, filePath: string, line: number) =>
        readGitLineBlame(driver.execute, { cwd, oid, filePath, line });
      expect(yield* read(base, "old.txt", 2)).toMatchObject({
        kind: "committed",
        oid: base,
        summary: "Original lines",
      });
      expect((yield* git(["status", "--porcelain"])).stdout).toBe(status);
      yield* git(["commit", "-m", "Move HEAD"]);
      expect(yield* read(head, "new.txt", 2)).toMatchObject({ kind: "committed", oid: base });
      expect((yield* read(base, "old.txt", 100)).kind).toBe("unavailable");
      expect((yield* read(base, "new.txt", 1)).kind).toBe("unavailable");
      expect(status).toContain("new.txt");
      yield* fs.makeDirectory(`${cwd}/a`);
      yield* fs.writeFileString(`${cwd}/file.ts`, "root\n");
      yield* git(["add", "."]);
      yield* git(["commit", "-m", "Root file"]);
      yield* fs.writeFileString(`${cwd}/a/file.ts`, "nested\n");
      yield* git(["add", "."]);
      yield* git(["commit", "-m", "Nested file"]);
      const nested = (yield* git(["rev-parse", "HEAD"])).stdout.trim();
      expect(yield* read(nested, "a/file.ts", 1)).toMatchObject({
        kind: "committed",
        summary: "Nested file",
      });
      expect(yield* read(nested, "file.ts", 1)).toMatchObject({
        kind: "committed",
        summary: "Root file",
      });
      yield* fs.writeFileString(`${cwd}/binary.bin`, "a\0b");
      yield* fs.symlink("new.txt", `${cwd}/link`);
      yield* fs.writeFileString(`${cwd}/-literal.txt`, "literal\n");
      yield* git(["add", "."]);
      yield* git(["commit", "-m", "Special files"]);
      const special = (yield* git(["rev-parse", "HEAD"])).stdout.trim();
      expect((yield* read(special, "binary.bin", 1)).kind).toBe("unavailable");
      expect((yield* read(special, "link", 1)).kind).toBe("unavailable");
      expect((yield* read(special, "-literal.txt", 1)).kind).toBe("committed");
      for (const oid of ["HEAD", "-h", "f".repeat(40)])
        yield* read(oid, "new.txt", 1).pipe(Effect.flip);
      yield* read(base, "../escape", 1).pipe(Effect.flip);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );
});
