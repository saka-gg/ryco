import {
  EventId,
  ProviderDriverKind,
  ThreadId,
  TurnId,
  type ProviderRuntimeEvent,
} from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  EMPTY_SYNC_REQUEST,
  MAX_SIGNAL_DIRECTORIES,
  UNTRACKED_TURN,
  combineTurnOverlaps,
  countedSignalEffect,
  decideThreadBranchAdoption,
  gitSyncTriggerFor,
  isAdoptableBranchName,
  isCommandOnlyRequest,
  makeThreadTurnOwnership,
  mergeThreadGitSyncRequests,
  vcsSignalEffect,
  type ThreadGitSyncRequest,
} from "./threadGitMetadata.ts";

const A = ThreadId.make("thread-a");
const B = ThreadId.make("thread-b");
const C = ThreadId.make("thread-c");

const decide = (input: Partial<Parameters<typeof decideThreadBranchAdoption>[0]>) =>
  decideThreadBranchAdoption({
    threadBranch: "feat/old",
    worktree: null,
    observedBranch: "feat/new",
    worktreeBranchPrefix: "ryco",
    ...input,
  });

describe("decideThreadBranchAdoption", () => {
  it("skips records that already hold the checkout's branch", () => {
    expect(decide({ threadBranch: "feat/x", observedBranch: "feat/x" })).toEqual({
      _tag: "skip",
      reason: "unchanged",
    });
    expect(
      decide({ threadBranch: "feat/x", worktree: { branch: "feat/x" }, observedBranch: "feat/x" }),
    ).toEqual({ _tag: "skip", reason: "unchanged" });
  });

  it("never adopts a detached or unreadable HEAD", () => {
    expect(decide({ observedBranch: null })).toEqual({ _tag: "skip", reason: "detached" });
    expect(decide({ observedBranch: undefined })).toEqual({ _tag: "skip", reason: "unreadable" });
  });

  it("never adopts a temporary branch, with the project's prefix or the legacy one", () => {
    expect(decide({ observedBranch: "team/1a2b3c4d", worktreeBranchPrefix: "team" })).toEqual({
      _tag: "skip",
      reason: "temporary",
    });
    expect(decide({ observedBranch: "ryco/deadbeef", worktreeBranchPrefix: "team" })).toEqual({
      _tag: "skip",
      reason: "temporary",
    });
  });

  it("follows a temporary branch to the agent's own branch, thread and workspace", () => {
    expect(
      decide({
        threadBranch: "ryco/1234abcd",
        worktree: { branch: "ryco/1234abcd" },
        observedBranch: "feat/agent",
      }),
    ).toEqual({
      _tag: "adopt",
      branch: "feat/agent",
      thread: { expectedBranch: "ryco/1234abcd" },
      worktree: { expectedBranch: "ryco/1234abcd" },
    });
  });

  it("follows one named branch to another", () => {
    expect(decide({ threadBranch: "feat/a", observedBranch: "feat/b" })).toEqual({
      _tag: "adopt",
      branch: "feat/b",
      thread: { expectedBranch: "feat/a" },
      worktree: null,
    });
  });

  it("updates only the record that is stale", () => {
    expect(
      decide({ threadBranch: "feat/a", worktree: { branch: "feat/b" }, observedBranch: "feat/b" }),
    ).toEqual({
      _tag: "adopt",
      branch: "feat/b",
      thread: { expectedBranch: "feat/a" },
      worktree: null,
    });
    expect(
      decide({ threadBranch: "feat/b", worktree: { branch: "feat/a" }, observedBranch: "feat/b" }),
    ).toEqual({
      _tag: "adopt",
      branch: "feat/b",
      thread: null,
      worktree: { expectedBranch: "feat/a" },
    });
  });

  it("records a branch for a thread that had none", () => {
    expect(decide({ threadBranch: null, observedBranch: "main" })).toEqual({
      _tag: "adopt",
      branch: "main",
      thread: { expectedBranch: null },
      worktree: null,
    });
  });

  it("refuses names git would refuse", () => {
    expect(decide({ observedBranch: "--orphan" })).toEqual({ _tag: "skip", reason: "invalid" });
  });
});

describe("isAdoptableBranchName", () => {
  it.each([
    "main",
    "feat/agent",
    "fix/issue-12_v2",
    "release/1.2.3",
    "user@host",
    "Ünïcode/branch",
    "a.b",
    "x-lock",
  ])("accepts %s", (name) => {
    expect(isAdoptableBranchName(name)).toBe(true);
  });

  it.each([
    "",
    "-x",
    "--orphan",
    "@",
    "HEAD",
    "a..b",
    "a@{1}",
    "with space",
    "tab\tname",
    "ctrl\u0001name",
    "del\u007fname",
    "a~1",
    "a^",
    "a:b",
    "a?",
    "a*",
    "a[0]",
    "a\\b",
    "/lead",
    "trail/",
    "a//b",
    ".hidden",
    "a/.hidden",
    "a.lock",
    "a.lock/b",
    "trail.",
  ])("refuses %j", (name) => {
    expect(isAdoptableBranchName(name)).toBe(false);
  });
});

describe("makeThreadTurnOwnership", () => {
  it("records overlaps both ways and returns them when the turn ends", () => {
    const ownership = makeThreadTurnOwnership();
    ownership.start(A, "a1");
    ownership.start(B, "b1");
    expect(ownership.current(A)).toEqual({
      tracked: true,
      overlaps: new Set([B]),
      overflowed: false,
    });
    expect(ownership.end(B, "b1")).toEqual({
      tracked: true,
      overlaps: new Set([A]),
      overflowed: false,
    });
    // B's turn ended, but A's turn overlapped it at some point.
    ownership.start(C, "c1");
    expect(ownership.end(A, "a1")).toEqual({
      tracked: true,
      overlaps: new Set([B, C]),
      overflowed: false,
    });
    expect(ownership.running()).toEqual([C]);
  });

  it("ignores a stray end of another turn and keeps the running one", () => {
    const ownership = makeThreadTurnOwnership();
    ownership.start(A, "a2");
    expect(ownership.end(A, "a1")).toBeNull();
    expect(ownership.running()).toEqual([A]);
    expect(ownership.end(A, "a2")?.tracked).toBe(true);
  });

  it("reports an end it never saw start as untracked", () => {
    const ownership = makeThreadTurnOwnership();
    expect(ownership.end(A, "a1")).toBe(UNTRACKED_TURN);
    expect(ownership.current(A)).toBeNull();
  });

  it("ignores a repeated end of a turn it already ended", () => {
    const ownership = makeThreadTurnOwnership();
    ownership.start(A, "a1");
    expect(ownership.end(A, "a1")?.tracked).toBe(true);
    // A stop followed by a completion of the same turn: the second end is no new turn.
    expect(ownership.end(A, "a1")).toBeNull();
    ownership.start(A, "a2");
    expect(ownership.endSession(A)?.tracked).toBe(true);
    // The session exit ended the turn first; the stop that follows changes nothing.
    expect(ownership.end(A, "a2")).toBeNull();
    // A turn it never saw start is still untracked.
    expect(ownership.end(A, "a3")).toBe(UNTRACKED_TURN);
  });

  it("ends a session's running turn, and nothing for an idle session", () => {
    const ownership = makeThreadTurnOwnership();
    expect(ownership.endSession(A)).toBeNull();
    ownership.start(A, "a1");
    ownership.start(B, "b1");
    expect(ownership.endSession(A)).toEqual({
      tracked: true,
      overlaps: new Set([B]),
      overflowed: false,
    });
    expect(ownership.running()).toEqual([B]);
  });

  it("is idempotent for a repeated start and carries overlaps into a replacing turn", () => {
    const ownership = makeThreadTurnOwnership();
    ownership.start(A, "a1");
    ownership.start(B, "b1");
    ownership.end(B, "b1");
    ownership.start(A, "a1");
    ownership.start(A, "a2");
    expect(ownership.end(A, "a2")?.overlaps).toEqual(new Set([B]));
  });

  it("forgets the oldest running turn past maxRunning", () => {
    const ownership = makeThreadTurnOwnership({ maxRunning: 2 });
    ownership.start(A, "a1");
    ownership.start(B, "b1");
    ownership.start(C, "c1");
    expect(ownership.running()).toEqual([B, C]);
    expect(ownership.end(A, "a1")).toBe(UNTRACKED_TURN);
  });

  it("marks a turn overflowed past maxOverlaps", () => {
    const ownership = makeThreadTurnOwnership({ maxOverlaps: 1 });
    ownership.start(A, "a1");
    ownership.start(B, "b1");
    ownership.start(C, "c1");
    expect(ownership.current(A)).toEqual({
      tracked: true,
      overlaps: new Set([B]),
      overflowed: true,
    });
  });
});

describe("combineTurnOverlaps", () => {
  it("unions overlaps and is tracked only when both windows are", () => {
    const tracked = { tracked: true, overlaps: new Set([A]), overflowed: false };
    expect(
      combineTurnOverlaps(tracked, { tracked: true, overlaps: new Set([B]), overflowed: true }),
    ).toEqual({ tracked: true, overlaps: new Set([A, B]), overflowed: true });
    expect(combineTurnOverlaps(tracked, UNTRACKED_TURN)).toEqual({
      tracked: false,
      overlaps: new Set([A]),
      overflowed: false,
    });
  });
});

describe("mergeThreadGitSyncRequests", () => {
  it("ORs flags, merges command effects and combines turn ends", () => {
    const first: ThreadGitSyncRequest = {
      ...EMPTY_SYNC_REQUEST,
      command: { local: true, remote: false },
      turnEnd: {
        overlap: { tracked: true, overlaps: new Set([A]), overflowed: false },
        aborted: false,
      },
    };
    const second: ThreadGitSyncRequest = {
      turnStart: true,
      command: { local: false, remote: true },
      signals: null,
      turnEnd: {
        overlap: { tracked: true, overlaps: new Set([B]), overflowed: false },
        aborted: true,
      },
      remoteDue: true,
    };
    expect(mergeThreadGitSyncRequests(undefined, first)).toBe(first);
    expect(mergeThreadGitSyncRequests(first, second)).toEqual({
      turnStart: true,
      command: { local: true, remote: true },
      signals: null,
      turnEnd: {
        overlap: { tracked: true, overlaps: new Set([A, B]), overflowed: false },
        aborted: true,
      },
      remoteDue: true,
    });
  });

  it("keeps signals apart by directory, merging effects per directory", () => {
    const signal = (cwd: string, local: boolean, remote: boolean): ThreadGitSyncRequest => ({
      ...EMPTY_SYNC_REQUEST,
      signals: new Map([[cwd, { local, remote }]]),
    });
    const merged = [
      signal("/repo", true, false),
      signal("/elsewhere", false, true),
      signal("/repo", false, true),
    ].reduce<ThreadGitSyncRequest | undefined>(mergeThreadGitSyncRequests, undefined);
    expect(merged).toEqual({
      ...EMPTY_SYNC_REQUEST,
      signals: new Map([
        ["/repo", { local: true, remote: true }],
        ["/elsewhere", { local: false, remote: true }],
      ]),
    });
    // A command and a signal stay apart: only the signal waits for its directory check.
    expect(
      mergeThreadGitSyncRequests(
        { ...EMPTY_SYNC_REQUEST, command: { local: true, remote: false } },
        signal("/repo", false, true),
      ),
    ).toEqual({
      ...EMPTY_SYNC_REQUEST,
      command: { local: true, remote: false },
      signals: new Map([["/repo", { local: false, remote: true }]]),
    });
  });

  it("counts signals past the directory cap without a check", () => {
    let request: ThreadGitSyncRequest | undefined;
    for (let index = 0; index < MAX_SIGNAL_DIRECTORIES; index += 1) {
      request = mergeThreadGitSyncRequests(request, {
        ...EMPTY_SYNC_REQUEST,
        signals: new Map([[`/dir-${index}`, { local: true, remote: false }]]),
      });
    }
    request = mergeThreadGitSyncRequests(request, {
      ...EMPTY_SYNC_REQUEST,
      signals: new Map([["/one-too-many", { local: false, remote: true }]]),
    });
    // A directory already kept still merges in place.
    request = mergeThreadGitSyncRequests(request, {
      ...EMPTY_SYNC_REQUEST,
      signals: new Map([["/dir-0", { local: false, remote: true }]]),
    });
    expect(request?.signals?.size).toBe(MAX_SIGNAL_DIRECTORIES);
    expect(request?.signals?.has("/one-too-many")).toBe(false);
    expect(request?.signals?.get("/dir-0")).toEqual({ local: true, remote: true });
    expect(request?.command).toEqual({ local: false, remote: true });
  });

  it("merges the effects of the signals whose directory counts", () => {
    const signals = new Map([
      ["/repo/src", { local: true, remote: false }],
      ["/repo", { local: false, remote: true }],
      ["/elsewhere", { local: true, remote: true }],
    ]);
    expect(countedSignalEffect(null, () => true)).toBeNull();
    expect(countedSignalEffect(signals, () => false)).toBeNull();
    expect(countedSignalEffect(signals, (cwd) => cwd.startsWith("/repo"))).toEqual({
      local: true,
      remote: true,
    });
    expect(countedSignalEffect(signals, (cwd) => cwd === "/repo/src")).toEqual({
      local: true,
      remote: false,
    });
  });

  it("settles only command-only requests", () => {
    expect(
      isCommandOnlyRequest({ ...EMPTY_SYNC_REQUEST, command: { local: true, remote: false } }),
    ).toBe(true);
    expect(
      isCommandOnlyRequest({
        ...EMPTY_SYNC_REQUEST,
        signals: new Map([["/repo", { local: false, remote: true }]]),
      }),
    ).toBe(true);
    expect(
      isCommandOnlyRequest({
        ...EMPTY_SYNC_REQUEST,
        signals: new Map([["/repo", { local: false, remote: true }]]),
        remoteDue: true,
      }),
    ).toBe(false);
    expect(
      isCommandOnlyRequest({
        ...EMPTY_SYNC_REQUEST,
        turnStart: true,
        command: { local: true, remote: false },
      }),
    ).toBe(false);
    expect(isCommandOnlyRequest(EMPTY_SYNC_REQUEST)).toBe(false);
  });
});

const base = {
  eventId: EventId.make("event-1"),
  provider: ProviderDriverKind.make("codex"),
  threadId: A,
  createdAt: "2026-10-28T00:00:00.000Z",
};
const event = (value: Record<string, unknown>) => ({ ...base, ...value }) as ProviderRuntimeEvent;

describe("vcsSignalEffect", () => {
  it.each([
    [{ kind: "commit" }, { local: true, remote: false }],
    [{ kind: "merge" }, { local: true, remote: false }],
    [{ kind: "rebase" }, { local: true, remote: false }],
    // A kind a newer CLI adds still means something changed: re-read the checkout.
    [{ kind: "squash" }, { local: true, remote: false }],
    [{ kind: "push" }, { local: false, remote: true }],
    [
      { kind: "change-request", action: "created" },
      { local: false, remote: true },
    ],
    [
      { kind: "change-request", action: "merged" },
      { local: false, remote: true },
    ],
    [
      { kind: "change-request", action: "pushed" },
      { local: false, remote: true },
    ],
    [{ kind: "change-request" }, { local: false, remote: true }],
    [
      { kind: "change-request", action: "checked-out" },
      { local: true, remote: true },
    ],
  ])("%j", (payload, effect) => {
    expect(vcsSignalEffect(payload)).toEqual(effect);
  });
});

describe("gitSyncTriggerFor", () => {
  it("maps turn boundaries with a turn id, and only those", () => {
    const turnId = TurnId.make("turn-1");
    expect(gitSyncTriggerFor(event({ type: "turn.started", turnId, payload: {} }))).toEqual({
      kind: "turn-start",
      turnId,
    });
    expect(
      gitSyncTriggerFor(event({ type: "turn.completed", turnId, payload: { state: "completed" } })),
    ).toEqual({ kind: "turn-end", turnId, aborted: false });
    expect(
      gitSyncTriggerFor(event({ type: "turn.aborted", turnId, payload: { reason: "stopped" } })),
    ).toEqual({ kind: "turn-end", turnId, aborted: true });
    // An untargeted completion (Claude's resume handshake) proves no turn.
    expect(
      gitSyncTriggerFor(event({ type: "turn.completed", payload: { state: "completed" } })),
    ).toBeNull();
    expect(gitSyncTriggerFor(event({ type: "turn.started", payload: {} }))).toBeNull();
    expect(gitSyncTriggerFor(event({ type: "session.exited", payload: {} }))).toEqual({
      kind: "session-exit",
    });
  });

  it("classifies finished commands from every provider shape", () => {
    const completed = (data: unknown, extra: Record<string, unknown> = {}) =>
      gitSyncTriggerFor(
        event({
          type: "item.completed",
          payload: { itemType: "command_execution", status: "completed", data, ...extra },
        }),
      );
    expect(completed({ item: { command: "git checkout -b feat/x" } })).toEqual({
      kind: "command",
      effect: { local: true, remote: false },
    });
    expect(completed({ toolName: "Bash", input: { command: "gh pr create --fill" } })).toEqual({
      kind: "command",
      effect: { local: false, remote: true },
    });
    expect(completed({ item: { command: "git status" } })).toBeNull();
    expect(completed({ item: { command: "git push" } }, { status: "declined" })).toBeNull();
    expect(completed(undefined, { detail: "git commit -m x <exited with exit code 0>" })).toEqual({
      kind: "command",
      effect: { local: true, remote: false },
    });
  });

  it("gives Copilot tool completions no mid-turn trigger (they carry no command)", () => {
    expect(
      gitSyncTriggerFor(
        event({
          type: "item.completed",
          payload: {
            itemType: "dynamic_tool_call",
            status: "completed",
            title: "Tool call",
            data: { toolCallId: "call-1", success: true, result: { content: "pushed" } },
          },
        }),
      ),
    ).toBeNull();
  });

  it("turns a provider's git signal into a command with the directory it ran in", () => {
    const signal = (payload: Record<string, unknown>) =>
      gitSyncTriggerFor(event({ type: "vcs.state.changed", payload }));
    expect(signal({ kind: "commit", cwd: "/repo" })).toEqual({
      kind: "command",
      effect: { local: true, remote: false },
      cwd: "/repo",
    });
    // No directory: it counts like a command's text.
    expect(signal({ kind: "push" })).toEqual({
      kind: "command",
      effect: { local: false, remote: true },
    });
    expect(signal({ kind: "change-request", action: "created" })).toEqual({
      kind: "command",
      effect: { local: false, remote: true },
    });
  });

  it("ignores deltas, retryable errors and everything else", () => {
    expect(
      gitSyncTriggerFor(
        event({
          type: "content.delta",
          payload: { streamKind: "assistant_text", delta: "git push" },
        }),
      ),
    ).toBeNull();
    expect(
      gitSyncTriggerFor(event({ type: "runtime.error", payload: { message: "x" } })),
    ).toBeNull();
  });
});
