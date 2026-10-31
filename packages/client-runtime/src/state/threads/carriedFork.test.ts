import {
  type EnvironmentId,
  MessageId,
  ProjectId,
  type RepositoryIdentity,
  ThreadForkError,
  type ThreadForkResult,
  ThreadId,
  TurnId,
} from "@ryco/contracts";
import {
  CARRIED_THREAD_HISTORY_MAX_MESSAGES,
  CARRIED_THREAD_TEXT_MAX_CHARS,
  type CarriedThreadHistory,
} from "@ryco/contracts/thread-fork-carried";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  buildCarriedForkInput,
  buildCarriedThreadHistory,
  carriedForkBranch,
  carriedForkKey,
  carriedForkModel,
  carriedForkSignature,
  type CarriedForkTargetCandidate,
  listCarriedForkTargets,
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
    connected: true,
    allowed: true,
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
        candidate("c-offline", { connected: false }),
        candidate("d-viewer", { allowed: false }),
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

describe("carriedForkBranch", () => {
  it("needs a branch on origin with nothing left to push", () => {
    const status = { isRepo: true, refName: "feature/login", hasUpstream: true, aheadCount: 0 };
    expect(carriedForkBranch(status)).toEqual({
      kind: "ready",
      branch: "feature/login",
      baseRef: "origin/feature/login",
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
        start: { kind: "base-ref", baseRef: "origin/feature/login" },
      },
    });
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
