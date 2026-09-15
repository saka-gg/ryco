import { ChildProcessSpawner } from "effect/unstable/process";
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { GitCommandError, WS_METHODS } from "@ryco/contracts";
import type { WsRpcContext } from "./context.ts";
import { makeGitHandlers } from "./gitRpc.ts";
import {
  WorkspaceAccessPolicy,
  WorkspaceAccessDeniedError,
  type WorkspaceAccessPolicyShape,
} from "../workspace/Services/WorkspaceAccessPolicy.ts";
import { authorizeGitReadWorkspace } from "../vcs/GitReadWorkspace.ts";
import { rpcAccessFor } from "./RpcAccessPolicy.ts";

const input = { cwd: "/requested", oid: "a".repeat(40), filePath: "a/file.ts", line: 1 };
describe("source-control read authorization", () => {
  for (const method of [WS_METHODS.vcsReadLineBlame, WS_METHODS.vcsReadComparison]) {
    for (const denied of ["role", "workspace", "none"] as const) {
      it.effect(`${method} checks role and workspace before reading (${denied})`, () =>
        Effect.gen(function* () {
          let pathReads = 0;
          let gitReads = 0;
          const read = () =>
            authorizeGitReadWorkspace(
              () =>
                Effect.succeed({
                  exitCode: ChildProcessSpawner.ExitCode(0),
                  stdoutTruncated: false,
                  stderrTruncated: false,
                  stdout: "/canonical\n",
                  stderr: "",
                }),
              input.cwd,
              method,
            ).pipe(
              Effect.map((cwd) => {
                gitReads++;
                expect(cwd).toBe("/canonical");
                return { kind: "unavailable" as const, reason: "fixture" };
              }),
            );
          const ctx = {
            ownerEffect: (_method: string, work: Effect.Effect<unknown>) =>
              denied === "role"
                ? Effect.fail(
                    new GitCommandError({
                      cwd: input.cwd,
                      command: "test",
                      operation: "authorization",
                      detail: "denied",
                    }),
                  )
                : work,
            gitWorkflow: { readLineBlame: read, readComparison: read },
          } as unknown as WsRpcContext;
          const policy = {
            assertExistingPath: () =>
              Effect.suspend(() => {
                pathReads++;
                return denied === "workspace"
                  ? Effect.fail(
                      new WorkspaceAccessDeniedError({
                        operation: method,
                        requestedPath: input.cwd,
                        accessRoot: "/allowed",
                        reason: "outsideRoot",
                      }),
                    )
                  : Effect.succeed("/canonical");
              }),
          } as unknown as WorkspaceAccessPolicyShape;
          const handlers = makeGitHandlers(ctx);
          const work =
            method === WS_METHODS.vcsReadLineBlame
              ? handlers[method](input).pipe(Effect.asVoid)
              : handlers[method]({
                  cwd: input.cwd,
                  selection: { ref: "main", mode: "direct" },
                  ignoreWhitespace: false,
                }).pipe(Effect.asVoid);
          const outcome = yield* work.pipe(
            Effect.provideService(WorkspaceAccessPolicy, policy),
            Effect.result,
          );
          expect(outcome._tag).toBe(denied === "none" ? "Success" : "Failure");
          expect(pathReads).toBe(denied === "role" ? 0 : denied === "workspace" ? 1 : 2);
          expect(gitReads).toBe(denied === "none" ? 1 : 0);
          expect(rpcAccessFor(method)).toBe("operator");
        }),
      );
    }
  }
});
