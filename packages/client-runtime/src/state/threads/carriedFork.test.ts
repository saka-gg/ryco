import {
  type EnvironmentApi,
  type EnvironmentId,
  EventId,
  MessageId,
  type OrchestrationThreadActivity,
  ProjectId,
  type RepositoryIdentity,
  THREAD_FORKED_ACTIVITY_KIND,
  ThreadForkError,
  type ThreadForkResult,
  ThreadId,
  TurnId,
} from "@ryco/contracts";
import {
  CARRIED_THREAD_HISTORY_MAX_MESSAGES,
  CARRIED_THREAD_TEXT_MAX_CHARS,
  CarriedThreadSource,
  type CarriedThreadHistory,
} from "@ryco/contracts/thread-fork-carried";
import * as Schema from "effect/Schema";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  buildCarriedForkInput,
  buildCarriedThreadHistory,
  carriedForkBranch,
  carriedForkBranchPushable,
  carriedForkKey,
  carriedForkModel,
  carriedForkSignature,
  carriedForkSource,
  type CarriedForkTargetCandidate,
  listCarriedForkTargets,
  readCarriedForkSource,
  runCarriedFork,
  settleCarriedForkKey,
} from "./carriedFork.ts";

const A = "environment-a" as EnvironmentId;
const turn = (index: number) => TurnId.make(`turn-${index}`);
const at = (seconds: number) => new Date(Date.UTC(2026, 9, 1, 10, 0, seconds)).toISOString();

const source: CarriedThreadHistory["source"] = {
  machineLabel: "Machine A",
  threadTitle: "Feature work",
  threadId: ThreadId.make("thread-on-a"),
  environmentId: A,
};
const model = { driver: "codex", model: "gpt-fixture" } as CarriedThreadHistory["model"];

function message(
  index: number,
  role: "user" | "assistant" | "system",
  turnIndex: number | null,
  seconds: number,
  text = `${role} ${index}`,
) {
  return {
    id: MessageId.make(`message-${index}`),
    role,
    text,
    turnId: turnIndex === null ? null : turn(turnIndex),
    createdAt: at(seconds),
    streaming: false,
  };
}

const conversation = [
  message(1, "user", 1, 0),
  message(2, "assistant", 1, 3),
  message(3, "system", null, 4),
  message(4, "user", 2, 10),
  message(5, "assistant", 2, 13),
  message(6, "user", 3, 20),
  message(7, "assistant", 3, 23),
];

const build = (overrides: Partial<Parameters<typeof buildCarriedThreadHistory>[0]> = {}) =>
  buildCarriedThreadHistory({
    messages: conversation.toReversed(),
    proposedPlans: [],
    turnOutcomes: [],
    boundaryMessageId: MessageId.make("message-5"),
    source,
    model,
    runtimeMode: "approval-required",
    interactionMode: "default",
    ...overrides,
  });

describe("buildCarriedThreadHistory", () => {
  it("stops at the picked reply, in order, with user and assistant text only", () => {
    const built = build({
      proposedPlans: [
        {
          id: "plan-1",
          turnId: turn(1),
          planMarkdown: "Plan one",
          createdAt: at(2),
          implementedAt: at(11),
        },
        {
          id: "plan-3",
          turnId: turn(3),
          planMarkdown: "After the reply",
          createdAt: at(21),
          implementedAt: null,
        },
      ],
      turnOutcomes: [
        { turnId: turn(1), state: "interrupted" },
        { turnId: turn(2), state: "error" },
        { turnId: turn(3), state: "error" },
      ],
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.history.messages.map((entry) => entry.text)).toEqual([
      "user 1",
      "assistant 2",
      "user 4",
      "assistant 5",
    ]);
    expect(built.history.proposedPlans).toEqual([
      { turnId: turn(1), planMarkdown: "Plan one", createdAt: at(2), implementedAt: at(11) },
    ]);
    // Only carried turns before the picked one; the picked turn completed.
    expect(built.history.turnOutcomes).toEqual([{ turnId: turn(1), state: "interrupted" }]);
    expect(built.history).toMatchObject({ source, model, runtimeMode: "approval-required" });
  });

  it("shortens a long text and refuses a conversation over the limits or without the reply", () => {
    const long = build({
      messages: [message(1, "user", 1, 0), message(2, "assistant", 1, 3, "x".repeat(250_000))],
      boundaryMessageId: MessageId.make("message-2"),
    });
    expect(long.ok && long.history.messages[1]!.text.length).toBe(CARRIED_THREAD_TEXT_MAX_CHARS);
    const many = build({
      messages: Array.from({ length: CARRIED_THREAD_HISTORY_MAX_MESSAGES + 2 }, (_, index) =>
        message(index, index % 2 === 0 ? "user" : "assistant", Math.floor(index / 2), index),
      ),
      boundaryMessageId: MessageId.make(`message-${CARRIED_THREAD_HISTORY_MAX_MESSAGES + 1}`),
    });
    expect(many).toMatchObject({ ok: false, reason: "too-large" });
    expect(build({ boundaryMessageId: MessageId.make("message-4") })).toMatchObject({
      ok: false,
      reason: "boundary-missing",
    });
  });
});

const identity = (canonicalKey: string): RepositoryIdentity =>
  ({
    canonicalKey,
    locator: { kind: "remote", url: canonicalKey },
  }) as unknown as RepositoryIdentity;

function candidate(
  environmentId: string,
  overrides: Partial<CarriedForkTargetCandidate> = {},
): CarriedForkTargetCandidate {
  return {
    environmentId: environmentId as EnvironmentId,
    label: environmentId,
    access: { hosted: false, role: "owner", phase: "connected" },
    supported: true,
    chatsAvailable: true,
    providers: [
      { instanceId: "codex", driver: "codex", enabled: true, label: "Codex" },
      { instanceId: "work-codex", driver: "codex", enabled: true },
    ],
    projects: [
      {
        id: ProjectId.make(`project-${environmentId}`),
        cwd: `/repos/${environmentId}/app`,
        repositoryIdentity: identity("github.com/acme/app"),
        isChat: false,
      },
    ],
    ...overrides,
  };
}

describe("listCarriedForkTargets", () => {
  const sourceProject = {
    isChat: false as const,
    projectId: ProjectId.make("project-a"),
    cwd: "/Users/me/app",
    repositoryIdentity: identity("github.com/acme/app"),
  };

  it("leaves out machines that are offline, viewer-only, too old or have no copy of the project", () => {
    const targets = listCarriedForkTargets({
      sourceEnvironmentId: A,
      source: sourceProject,
      driver: "codex",
      candidates: [
        candidate("environment-a"),
        candidate("b-ready"),
        candidate("c-offline", { access: { hosted: false, role: "owner", phase: "disconnected" } }),
        candidate("c-connecting", {
          access: { hosted: false, role: "operator", phase: "connecting" },
        }),
        candidate("d-viewer", { access: { hosted: false, role: "viewer", phase: "connected" } }),
        candidate("d-no-role", { access: { hosted: false, role: null, phase: "connected" } }),
        candidate("d-hosted-not-ready", { access: { hosted: true, allowed: false } }),
        candidate("e-old", { supported: false }),
        candidate("f-other-repo", {
          projects: [
            {
              id: ProjectId.make("other"),
              cwd: "/repos/other",
              repositoryIdentity: identity("github.com/acme/other"),
              isChat: false,
            },
          ],
        }),
        candidate("g-ambiguous", {
          projects: [
            {
              id: ProjectId.make("copy-1"),
              cwd: "/repos/one",
              repositoryIdentity: identity("github.com/acme/app"),
              isChat: false,
            },
            {
              id: ProjectId.make("copy-2"),
              cwd: "/repos/two",
              repositoryIdentity: identity("github.com/acme/app"),
              isChat: false,
            },
          ],
        }),
      ],
    });
    expect(targets.map((target) => target.environmentId)).toEqual(["b-ready"]);
    expect(targets[0]).toMatchObject({ projectId: "project-b-ready", enabled: true });
  });

  it("offers an operator's machine, and a hosted one its session allows", () => {
    const targets = listCarriedForkTargets({
      sourceEnvironmentId: A,
      source: sourceProject,
      driver: "codex",
      candidates: [
        candidate("b-operator", {
          access: { hosted: false, role: "operator", phase: "connected" },
        }),
        candidate("c-hosted", { access: { hosted: true, allowed: true } }),
      ],
    });
    expect(targets.map((target) => target.environmentId)).toEqual(["b-operator", "c-hosted"]);
  });

  it("maps the source's codex instance to the target's codex instance by driver", () => {
    const sourceProviders = [{ instanceId: "my-codex", driver: "codex" }];
    const carried = carriedForkModel(
      { instanceId: "my-codex" as never, model: "gpt-x" },
      sourceProviders,
    );
    expect(carried).toEqual({ driver: "codex", model: "gpt-x" });
    const [target, missing] = listCarriedForkTargets({
      sourceEnvironmentId: A,
      source: sourceProject,
      driver: carried!.driver,
      candidates: [
        candidate("b"),
        candidate("c", {
          providers: [{ instanceId: "claude", driver: "claudeAgent", enabled: true }],
        }),
      ],
    });
    expect(target).toMatchObject({
      instance: { instanceId: "codex", label: "Codex" },
      enabled: true,
    });
    expect(missing).toMatchObject({ instance: null, enabled: false });
  });

  it("offers a chat only to machines with chats", () => {
    const targets = listCarriedForkTargets({
      sourceEnvironmentId: A,
      source: { isChat: true },
      driver: "codex",
      candidates: [candidate("b"), candidate("c", { chatsAvailable: false })],
    });
    expect(targets.map((target) => [target.environmentId, target.projectId])).toEqual([
      ["b", null],
    ]);
  });
});

const HEAD = "a".repeat(40);

describe("carriedForkBranch", () => {
  it("needs a branch on origin with nothing left to push", () => {
    const status = {
      isRepo: true,
      refName: "feature/login",
      hasUpstream: true,
      upstreamRef: "origin/feature/login",
      headCommit: HEAD,
      aheadCount: 0,
    };
    expect(carriedForkBranch(status)).toEqual({
      kind: "ready",
      branch: "feature/login",
      baseRef: "origin/feature/login",
      commit: HEAD,
    });
    expect(carriedForkBranch({ ...status, aheadCount: 2 })).toEqual({
      kind: "unpushed",
      branch: "feature/login",
      aheadCount: 2,
    });
    expect(carriedForkBranch({ ...status, hasUpstream: false }).kind).toBe("no-upstream");
    expect(carriedForkBranch({ ...status, refName: null }).kind).toBe("no-branch");
    expect(carriedForkBranch(null).kind).toBe("loading");
    const built = build();
    if (!built.ok) throw new Error("expected a history");
    expect(
      buildCarriedForkInput({
        forkKey: "fork-0123456789abcdef",
        target: { projectId: ProjectId.make("project-b") },
        branch: carriedForkBranch({ ...status, aheadCount: 1 }),
        history: built.history,
      }),
    ).toBeNull();
    expect(
      buildCarriedForkInput({
        forkKey: "fork-0123456789abcdef",
        target: { projectId: ProjectId.make("project-b") },
        branch: carriedForkBranch(status),
        history: built.history,
      }),
    ).toMatchObject({
      projectId: "project-b",
      destination: {
        kind: "new-worktree",
        start: { kind: "base-ref", baseRef: "origin/feature/login", commit: HEAD },
      },
    });
  });

  it("needs the upstream to be the branch of the same name on origin", () => {
    const status = {
      isRepo: true,
      refName: "main",
      hasUpstream: true,
      upstreamRef: "upstream/main",
      headCommit: HEAD,
      aheadCount: 0,
    };
    // A local main that tracks another remote is not on origin, whatever its counts say.
    const other = carriedForkBranch(status);
    expect(other).toEqual({ kind: "other-upstream", branch: "main", upstreamRef: "upstream/main" });
    expect(carriedForkBranchPushable(other)).toBe(false);
    expect(carriedForkBranch({ ...status, upstreamRef: "origin/release" }).kind).toBe(
      "other-upstream",
    );
    // An older node names no upstream and no commit: the branch counts as not pushed.
    const { upstreamRef: _upstreamRef, headCommit: _headCommit, ...older } = status;
    const unnamed = carriedForkBranch(older);
    expect(unnamed).toEqual({ kind: "no-upstream", branch: "main" });
    expect(carriedForkBranchPushable(unnamed)).toBe(true);
    expect(
      carriedForkBranch({ ...status, upstreamRef: "origin/main", headCommit: undefined }),
    ).toEqual({ kind: "no-upstream", branch: "main" });
    expect(carriedForkBranch({ ...status, upstreamRef: "origin/main" }).kind).toBe("ready");
  });
});

describe("carriedForkSource", () => {
  it("bounds the machine name and title without leaving a space where they were cut", () => {
    const sourceFields = {
      threadId: ThreadId.make("thread-on-a"),
      environmentId: A,
    };
    const built = carriedForkSource({
      ...sourceFields,
      machineLabel: `${"m".repeat(119)} and more`,
      threadTitle: `  ${"t".repeat(199)} tail`,
    });
    expect(built.machineLabel).toBe("m".repeat(119));
    expect(built.threadTitle).toBe("t".repeat(199));
    expect(Schema.is(CarriedThreadSource)(built)).toBe(true);
    expect(
      carriedForkSource({ ...sourceFields, machineLabel: "   ", threadTitle: "  " }),
    ).toMatchObject({ machineLabel: "Another machine", threadTitle: "Untitled" });
  });
});

describe("readCarriedForkSource", () => {
  const forkedActivity = (id: string, outcomeTurn: TurnId): OrchestrationThreadActivity =>
    ({
      id: EventId.make(id),
      tone: "info",
      kind: THREAD_FORKED_ACTIVITY_KIND,
      summary: "Forked",
      payload: {
        schemaVersion: 1,
        sourceThreadId: "thread-original",
        sourceMessageId: "message-original",
        sourceTurnId: "turn-original",
        sourceTitle: "Original",
        inheritedMessageCount: 2,
        inheritedTurnOutcomes: [{ turnId: outcomeTurn, state: "interrupted" }],
        providerContext: "handoff",
        checkout: { kind: "current-checkout", worktreePath: null, branch: null },
        notices: [],
      },
      turnId: null,
      createdAt: at(1),
    }) as unknown as OrchestrationThreadActivity;
  const toolActivity = (id: string): OrchestrationThreadActivity =>
    ({
      id: EventId.make(id),
      tone: "tool",
      kind: "tool.completed",
      summary: "Ran a tool",
      payload: {},
      turnId: turn(3),
      createdAt: at(30),
    }) as unknown as OrchestrationThreadActivity;

  it("finds the fork's record of interrupted turns behind later activity", async () => {
    const page = (hasMoreBefore: boolean) => ({
      oldestCursor: hasMoreBefore ? "cursor-1" : null,
      newestCursor: null,
      hasMoreBefore,
    });
    const thread = {
      id: ThreadId.make("thread-on-a"),
      title: "Feature work",
      modelSelection: { instanceId: "codex", model: "gpt-fixture" },
      runtimeMode: "approval-required",
      interactionMode: "default",
      latestTurn: null,
      messages: [],
      proposedPlans: [],
      checkpoints: [],
    };
    const getThreadWindow = vi.fn((input: { readonly limits: { readonly activities: number } }) =>
      Promise.resolve({
        snapshotSequence: 9,
        // Only the newest activities fit the window; the fork's record is older.
        thread: {
          ...thread,
          activities: [toolActivity("tool-1")].slice(0, input.limits.activities),
        },
        history: {
          messages: page(false),
          proposedPlans: page(false),
          activities: page(true),
          checkpoints: page(false),
        },
      }),
    );
    const getThreadHistoryPage = vi.fn((input: { readonly collection: string }) =>
      Promise.resolve({
        snapshotSequence: 9,
        collection: input.collection,
        items: [forkedActivity("forked-1", turn(1))],
        page: page(false),
      }),
    );
    const api = {
      orchestration: { getThreadWindow, getThreadHistoryPage },
    } as unknown as EnvironmentApi;
    const read = await readCarriedForkSource({
      api,
      threadId: ThreadId.make("thread-on-a"),
      signal: new AbortController().signal,
      isCurrent: () => true,
    });
    expect(read.turnOutcomes).toEqual([{ turnId: turn(1), state: "interrupted" }]);
    expect(getThreadHistoryPage).toHaveBeenCalledWith(
      expect.objectContaining({ collection: "activities" }),
    );
  });
});

describe("carried fork keys and calls", () => {
  const signature = carriedForkSignature({
    sourceEnvironmentId: A,
    sourceThreadId: ThreadId.make("thread-on-a"),
    sourceMessageId: MessageId.make("message-5"),
    targetEnvironmentId: "b" as EnvironmentId,
    projectId: ProjectId.make("project-b"),
    baseRef: "origin/feature",
    commit: HEAD,
  });

  it("keeps the key for a retry until a new attempt is safe", async () => {
    let minted = 0;
    const mint = () => `fork-${String(++minted).padStart(16, "0")}`;
    const first = carriedForkKey(signature, mint);
    expect(carriedForkKey(signature, mint)).toBe(first);
    const built = build();
    if (!built.ok) throw new Error("expected a history");
    const input = buildCarriedForkInput({
      forkKey: first,
      target: { projectId: null },
      branch: null,
      history: built.history,
    })!;
    const running = await runCarriedFork({
      api: {
        forkCarried: vi.fn(() =>
          Promise.reject(
            new ThreadForkError({
              reason: "preparation-failed",
              message: "busy",
              retryable: true,
              attempt: "running",
            }),
          ),
        ),
      },
      input,
    });
    settleCarriedForkKey(signature, running);
    expect(carriedForkKey(signature, mint)).toBe(first);
    const result = { threadId: ThreadId.make("fork-on-b") } as ThreadForkResult;
    const succeeded = await runCarriedFork({
      api: { forkCarried: () => Promise.resolve(result) },
      input,
    });
    expect(succeeded).toEqual({ status: "succeeded", result });
    settleCarriedForkKey(signature, succeeded);
    expect(carriedForkKey(signature, mint)).not.toBe(first);
  });

  it("mints a new key once the node refused the old one for another request", async () => {
    let minted = 0;
    const mint = () => `fork-conflict-${String(++minted).padStart(8, "0")}`;
    const conflictSignature = `${signature}\u0000conflict`;
    const first = carriedForkKey(conflictSignature, mint);
    const built = build();
    if (!built.ok) throw new Error("expected a history");
    // The title changed before Retry: the node holds the key for the earlier request.
    for (const attempt of ["none", "running"] as const) {
      const conflict = await runCarriedFork({
        api: {
          forkCarried: () =>
            Promise.reject(
              new ThreadForkError({
                reason: "idempotency-conflict",
                message: "conflict",
                retryable: false,
                attempt,
              }),
            ),
        },
        input: buildCarriedForkInput({
          forkKey: carriedForkKey(conflictSignature, mint),
          target: { projectId: null },
          branch: null,
          history: built.history,
        })!,
      });
      settleCarriedForkKey(conflictSignature, conflict);
    }
    expect(minted).toBe(2);
    expect(carriedForkKey(conflictSignature, mint)).not.toBe(first);
  });

  it("sends nothing when the target's connection changed since the dialog showed it", async () => {
    const forkCarried = vi.fn();
    const built = build();
    if (!built.ok) throw new Error("expected a history");
    const outcome = await runCarriedFork({
      api: { forkCarried },
      input: buildCarriedForkInput({
        forkKey: "fork-0123456789abcdef",
        target: { projectId: null },
        branch: null,
        history: built.history,
      })!,
      assertMutationReady: () => {
        throw new Error("changed");
      },
    });
    expect(outcome).toMatchObject({ status: "refused", awaiting: true });
    expect(forkCarried).not.toHaveBeenCalled();
  });
});
