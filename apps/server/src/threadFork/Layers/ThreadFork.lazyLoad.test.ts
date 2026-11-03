/**
 * The fork code that loads with `import()` (the carried fork chunk, the native fork chunk) can
 * fail to load, for example when an update replaced the files under a running node. That fails
 * the fork as retryable, with a reason a client can show, never as a defect.
 */
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  type CarriedThreadHistory,
  ProjectId,
  ProviderDriverKind,
  ThreadForkError,
  ThreadId,
} from "@ryco/contracts";
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  createForkHarness,
  fakeNative,
  type ForkHarness,
  historyAt,
  seedCompletedTurn,
  seedNativeBinding,
  seedProject,
  seedThread,
} from "../threadFork.fixtures.ts";

vi.mock("../carriedFork.ts", () => {
  throw new Error("simulated missing chunk");
});
vi.mock("../nativeFork.ts", () => {
  throw new Error("simulated missing chunk");
});

const LOAD_FAILED =
  "This machine could not load the code for forks right now. Try again in a moment.";

const roots: string[] = [];
const harnesses: ForkHarness[] = [];

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((harness) => harness.dispose()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempRoot() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "ryco-fork-lazy-load-")));
  roots.push(root);
  return root;
}

const history: CarriedThreadHistory = {
  schemaVersion: 1,
  source: {
    machineLabel: "Machine A",
    threadTitle: "Feature work",
    threadId: "thread-on-a" as CarriedThreadHistory["source"]["threadId"],
    environmentId: "environment-a" as CarriedThreadHistory["source"]["environmentId"],
  },
  messages: [
    { role: "user", text: "Start", createdAt: historyAt(0), turnId: null },
    {
      role: "assistant",
      text: "Started",
      createdAt: historyAt(3),
      turnId: "turn-on-a-1" as NonNullable<CarriedThreadHistory["messages"][number]["turnId"]>,
    },
  ],
  proposedPlans: [],
  turnOutcomes: [],
  model: { driver: ProviderDriverKind.make("codex"), model: "gpt-fixture" },
  runtimeMode: "approval-required",
  interactionMode: "default",
};

describe("ThreadFork code that fails to load", () => {
  it("answers a carried fork with a retryable failure", async () => {
    const root = await tempRoot();
    const h = await createForkHarness({ chatsRoot: path.join(root, "chats") });
    harnesses.push(h);
    const error = await h.run(
      Effect.flip(
        h.forks.forkCarried({
          forkKey: "carried-lazy-load-0001",
          projectId: null,
          destination: { kind: "new-chat" },
          history,
        }),
      ),
    );
    expect(error).toBeInstanceOf(ThreadForkError);
    expect(error).toMatchObject({
      reason: "preparation-failed",
      retryable: true,
      attempt: "none",
      message: LOAD_FAILED,
    });
    expect(await h.ledgerRows()).toEqual([]);
  });

  it("stops a native fork before its provider call, retryable", async () => {
    const root = await tempRoot();
    const workspace = path.join(root, "workspace");
    await mkdir(workspace);
    const native = fakeNative();
    const h = await createForkHarness({ service: { native: native.native } });
    harnesses.push(h);
    const projectId = ProjectId.make("lazy-load-project");
    const sourceThreadId = ThreadId.make("lazy-load-source");
    await seedProject(h, { projectId, workspaceRoot: workspace });
    await seedThread(h, { threadId: sourceThreadId, projectId });
    const turn = await seedCompletedTurn(h, { threadId: sourceThreadId, index: 1 });
    await seedNativeBinding(h, {
      threadId: sourceThreadId,
      instance: "codex",
      cwd: workspace,
      nativeId: "codex-source",
    });
    const error = await h.run(
      Effect.flip(
        h.forks.fork({
          forkKey: "fork-lazy-load-native-0001",
          sourceThreadId,
          sourceMessageId: turn.replyId,
          destination: { kind: "current-checkout" },
        }),
      ),
    );
    expect(error).toBeInstanceOf(ThreadForkError);
    expect(error).toMatchObject({
      reason: "preparation-failed",
      retryable: true,
      message: LOAD_FAILED,
    });
    expect(native.calls).toEqual([]);
    // Stopped before the native call was claimed: a retry can still fork natively.
    expect((await h.ledgerRows()).map((row) => row.phase)).not.toContain("provider-forking");
  });
});
