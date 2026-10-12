/**
 * Architecture guard: a whole shell snapshot (every live thread's summary, sessions, latest
 * turns, priorities) is what clients subscribe to, not a generic server-side lookup. Server code
 * that needs projects, workspaces or thread placement reads them through `readProjectShells`,
 * `readWorkspacePlacement` or another narrow query instead.
 *
 * The callers listed below still need thread summaries (status, pending work, liveness, model
 * selection), or compare a whole snapshot's sequence. The list is a ratchet: a new caller, or
 * another call in a listed file, fails this test; so does a listed call that is gone, so the
 * list stays exact.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vite-plus/test";

const sourceRoot = fileURLToPath(new URL("../..", import.meta.url));

const ALLOWED_SHELL_SNAPSHOT_CALLERS: Readonly<Record<string, { count: number; why: string }>> = {
  "ws/orchestrationRpc.ts": { count: 1, why: "the shell subscription itself" },
  "hubConnector/ThreadReadCacheSync.ts": { count: 1, why: "mirrors the shell for the hub" },
  "orchestration/Services/ProjectionSnapshotQuery.ts": {
    count: 3,
    why: "narrow-read fallbacks for test doubles",
  },
  "orchestration/Layers/CheckpointReactor.ts": {
    count: 1,
    why: "restore safety judges every live thread's busy state",
  },
  "workspace/WorkspaceLifecycle.ts": { count: 1, why: "workspace inspection uses thread status" },
  "workspace/managedWorktreeMigration.ts": {
    count: 1,
    why: "a checkout is idle only when no thread has pending work",
  },
  "storage/StorageService.ts": {
    count: 1,
    why: "the cleanup inventory protects checkouts by thread state",
  },
  "agentControl/workspaceLifecycle.ts": { count: 1, why: "workspace inspection" },
  "agentControl/Layers/AgentControlDiagnostics.ts": {
    count: 1,
    why: "threads by provider instance",
  },
  "agentControl/Layers/AgentControlActionValidator.ts": {
    count: 1,
    why: "validates plans against thread state",
  },
  "agentControl/Mcp/threadReads.ts": { count: 1, why: "lists threads with their status" },
};

const SHELL_SNAPSHOT_CALL = /\.getShellSnapshot\s*\(/g;

function* sourceFiles(directory: string): Generator<string> {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "testing") continue;
      yield* sourceFiles(fullPath);
    } else if (
      entry.name.endsWith(".ts") &&
      !entry.name.endsWith(".test.ts") &&
      // Test fixtures build whole servers and read state the way a test asserts it.
      !entry.name.endsWith(".fixtures.ts") &&
      !entry.name.endsWith(".d.ts")
    ) {
      yield fullPath;
    }
  }
}

describe("getShellSnapshot callers", () => {
  it("stays limited to the callers that need whole thread summaries", () => {
    const found: Record<string, number> = {};
    for (const file of sourceFiles(sourceRoot)) {
      const relative = path.relative(sourceRoot, file).split(path.sep).join("/");
      // The implementation defines it; it never calls itself.
      if (relative === "orchestration/Layers/ProjectionSnapshotQuery.ts") continue;
      const count = readFileSync(file, "utf8").match(SHELL_SNAPSHOT_CALL)?.length ?? 0;
      if (count > 0) found[relative] = count;
    }
    const allowed = Object.fromEntries(
      Object.entries(ALLOWED_SHELL_SNAPSHOT_CALLERS).map(([file, { count }]) => [file, count]),
    );
    expect(found).toEqual(allowed);
  });
});
