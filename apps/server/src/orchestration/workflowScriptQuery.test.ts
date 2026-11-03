import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import type { ServerSettings } from "@ryco/contracts";
import { Effect } from "effect";
import { afterAll, assert, describe, it } from "vite-plus/test";
import { makeNamedPipe, settleBeforeNamedPipeDeadline } from "../testing/namedPipe.ts";
import { readWorkflowScript, workflowScriptRootsFromSettings } from "./workflowScriptQuery.ts";

// A dedicated sandbox root passed via the roots override, so the test never
// writes into the real ~/.claude/projects.
const sandbox = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "wf-script-test-"));
const root = NodePath.join(sandbox, "projects");
NodeFS.mkdirSync(root, { recursive: true });
const scriptPath = NodePath.join(root, "run.js");
NodeFS.writeFileSync(scriptPath, "export const meta = {};\n");
const outside = NodePath.join(sandbox, "wf-outside.js");
NodeFS.writeFileSync(outside, "evil\n");
const link = NodePath.join(root, "sneaky.js");
NodeFS.symlinkSync(outside, link);
if (!NodeFS.lstatSync(link).isSymbolicLink()) {
  throw new Error("test setup: sneaky.js must be a symlink");
}

const roots = [root];

afterAll(() => {
  NodeFS.rmSync(sandbox, { recursive: true, force: true });
});

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);
const runExit = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(Effect.exit(effect));

describe("readWorkflowScript containment", () => {
  it("serves a real script under the projects root", async () => {
    const result = await run(readWorkflowScript({ scriptPath, roots }));
    assert.include(result.contents, "export const meta");
    assert.equal(result.truncated, false);
  });

  it("rejects relative and non-js paths", async () => {
    const relative = await runExit(readWorkflowScript({ scriptPath: "run.js", roots }));
    assert.equal(relative._tag, "Failure");
    const nonJs = await runExit(
      readWorkflowScript({ scriptPath: scriptPath.replace(".js", ".ts"), roots }),
    );
    assert.equal(nonJs._tag, "Failure");
  });

  it("rejects paths outside the root and symlink escapes", async () => {
    const escaped = await runExit(readWorkflowScript({ scriptPath: outside, roots }));
    assert.equal(escaped._tag, "Failure");
    // A symlink INSIDE the root pointing outside must fail specifically on
    // realpath re-containment — a "not-found" would mean the link was
    // never exercised and the assertion proves nothing.
    const sneaky = await run(
      readWorkflowScript({ scriptPath: link, roots }).pipe(
        Effect.flip,
        Effect.map((error) => error.reason),
      ),
    );
    assert.equal(sneaky, "outside-root");
  });

  it("fails closed when no root resolves", async () => {
    const missingRoot = NodePath.join(sandbox, "does-not-exist");
    const result = await run(
      readWorkflowScript({ scriptPath, roots: [missingRoot] }).pipe(
        Effect.flip,
        Effect.map((error) => error.reason),
      ),
    );
    assert.equal(result, "root-unavailable");
  });

  it.skipIf(process.platform === "win32")(
    "refuses a named pipe without waiting for a writer",
    async () => {
      const fifo = NodePath.join(root, "pipe.js");
      makeNamedPipe(fifo);
      const result = await settleBeforeNamedPipeDeadline(fifo, () =>
        run(
          readWorkflowScript({ scriptPath: fifo, roots }).pipe(
            Effect.flip,
            Effect.map((error) => error.reason),
          ),
        ),
      );
      assert.equal(result, "not-regular-file");
    },
  );
});

describe("workflowScriptRootsFromSettings", () => {
  it("includes the legacy providers.claudeAgent homePath for unmigrated deployments", () => {
    const roots = workflowScriptRootsFromSettings({
      providers: { claudeAgent: { homePath: "~/custom-claude-home" } },
      providerInstances: {},
    } as unknown as Pick<ServerSettings, "providerInstances" | "providers">);
    assert.include(
      roots,
      NodePath.join(NodeOS.homedir(), "custom-claude-home", ".claude", "projects"),
    );
  });

  it("includes per-instance Claude homePath overrides alongside the default root", () => {
    const roots = workflowScriptRootsFromSettings({
      providers: { claudeAgent: {} },
      providerInstances: {
        "claude-work": { driver: "claudeAgent", config: { homePath: "/opt/claude-work" } },
      },
    } as unknown as Pick<ServerSettings, "providerInstances" | "providers">);
    assert.include(roots, NodePath.join(NodeOS.homedir(), ".claude", "projects"));
    assert.include(roots, NodePath.join("/opt/claude-work", ".claude", "projects"));
  });
});
