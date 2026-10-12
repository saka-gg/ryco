import {
  recordWsConnectionAttempt,
  recordWsConnectionOpened,
  resetWsConnectionStateForTests,
} from "@ryco/client-runtime/rpc";
import {
  openThreadForkAttempt,
  restoreThreadForkAttempt,
  submitThreadForkAttempt,
  updateThreadForkSelection,
  type ThreadForkAttemptBoundary,
  type ThreadForkAttemptState,
} from "@ryco/client-runtime/state/threads";
import {
  EnvironmentId,
  MessageId,
  ProjectId,
  ThreadForkError,
  ThreadId,
  type EnvironmentApi,
  type ThreadForkInput,
  type ThreadForkResult,
} from "@ryco/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

// The native fork call: every request goes through the shared fork-attempt state machine
// (`submitThreadForkAttempt`, which owns the key decision and the attempt registry) to the
// environment's `threads.fork`, over the sheet's mobile ports. What these prove is the key a
// request goes under as the sheet is used, never that one object is passed twice: a retry or a
// reopened sheet rebuilds its request from the machine's state, and must still reach the node
// under the key the node already holds.

const state = vi.hoisted(() => ({
  api: null as unknown,
  generation: {} as object | null,
  minted: 0,
}));

vi.mock("../../connection/environmentApi", () => ({
  ensureEnvironmentApi: () => {
    if (!state.api) throw new Error("Environment API not found");
    return state.api;
  },
}));
const connection = { shellSnapshotReadiness: { read: () => state.generation } };
vi.mock("../../runtime/bootstrap", () => ({
  createMobileConnectionRegistry: () => ({
    driver: { supervisor: { read: () => connection } },
  }),
}));
vi.mock("../../lib/uuid", () => ({
  randomHex: (byteLength: number) => {
    state.minted += 1;
    return state.minted.toString(16).padStart(byteLength * 2, "0");
  },
}));

import { captureThreadForkReadiness, mintThreadForkKey, mobileForkSheetPorts } from "./forkActions";

const environmentId = EnvironmentId.make("env-fork");
const result: ThreadForkResult = {
  threadId: ThreadId.make("fork-thread"),
  projectId: ProjectId.make("project-1"),
  replayed: false,
  providerContext: "native",
  checkout: { kind: "current-checkout", worktreePath: null, branch: "main" },
  notices: [],
};

let nextReply = 0;
/** Each test forks from its own reply: the attempt registry lives as long as the app. */
function boundary(): ThreadForkAttemptBoundary {
  nextReply += 1;
  return {
    environmentId,
    sourceThreadId: ThreadId.make("source-thread"),
    sourceMessageId: MessageId.make(`reply-${nextReply}`),
  };
}

/** One opening of the sheet: the attempt it continues or starts. */
function openSheet(at: ThreadForkAttemptBoundary): ThreadForkAttemptState {
  return openThreadForkAttempt({
    boundary: at,
    selection: { destination: "current-checkout" },
    defaultBaseRef: "main",
    mintKey: mintThreadForkKey,
  }).state;
}

/** One press, through the sheet's mobile ports as the shared controller sends it. */
async function send(
  attempt: ThreadForkAttemptState,
  assertMutationReady = captureThreadForkReadiness(environmentId),
) {
  const ports = mobileForkSheetPorts(environmentId);
  const submission = submitThreadForkAttempt({
    state: attempt,
    mintKey: ports.mintKey,
    api: ports.resolveApi(),
    assertMutationReady,
  });
  if (!submission.ok) throw new Error(`not sent: ${submission.reason}`);
  return { input: submission.input, settled: await submission.settled };
}

function connect() {
  recordWsConnectionAttempt("ws://fixture.invalid", { environmentId });
  recordWsConnectionOpened({ environmentId });
}

function node(...answers: ReadonlyArray<ThreadForkResult | Error>) {
  const fork = vi.fn<(input: ThreadForkInput) => Promise<ThreadForkResult>>();
  for (const answer of answers) {
    if (answer instanceof Error) fork.mockRejectedValueOnce(answer);
    else fork.mockResolvedValueOnce(answer);
  }
  state.api = { threads: { fork } } as unknown as EnvironmentApi;
  return fork;
}

beforeEach(() => {
  state.generation = {};
});
afterEach(() => {
  state.api = null;
  resetWsConnectionStateForTests();
});

describe("mobile fork actions", () => {
  it("mints a fork key from 16 random bytes, a fresh one each time", () => {
    const first = mintThreadForkKey();
    expect(first).toMatch(/^fork-[0-9a-f]{32}$/);
    expect(mintThreadForkKey()).not.toBe(first);
  });

  it("sends through the shared attempt machine to threads.fork", async () => {
    const fork = node(result);
    connect();
    const at = boundary();
    const attempt = openSheet(at);
    const sent = await send(attempt);
    expect(fork).toHaveBeenCalledExactlyOnceWith(sent.input);
    expect(sent.input.forkKey).toBe(attempt.forkKey);
    expect(sent.settled.phase).toBe("succeeded");
    // Kept until a sheet opened the fork it created.
    expect(restoreThreadForkAttempt(at)?.phase).toBe("succeeded");
  });

  it("retries an unknown outcome under the same key, also from a reopened sheet", async () => {
    const fork = node(new Error("socket closed"), new Error("socket closed"), result);
    connect();
    const at = boundary();
    const first = await send(
      updateThreadForkSelection(openSheet(at), {
        destination: "new-worktree",
        worktreeStart: "base-ref",
        baseRef: "release",
      }),
    );
    expect(first.settled.phase).toBe("uncertain");

    // Retry in the same sheet: the machine resends the request it bound.
    const retry = await send(first.settled);
    expect(retry.settled.phase).toBe("uncertain");

    // The sheet closed and "Fork from here" was tapped again: the registry hands the reopened
    // sheet the same attempt, whose request is rebuilt from it, not passed in.
    const reopened = openSheet(at);
    expect(reopened).toEqual(retry.settled);
    const third = await send(reopened);
    expect(third.settled.phase).toBe("succeeded");

    expect(fork).toHaveBeenCalledTimes(3);
    const [sentFirst, sentRetry, sentReopened] = fork.mock.calls.map(([input]) => input);
    expect(sentRetry).toEqual(sentFirst);
    expect(sentReopened).toEqual(sentFirst);
    expect(sentFirst?.destination).toEqual({
      kind: "new-worktree",
      start: { kind: "base-ref", baseRef: "release" },
    });
  });

  it("starts over under a new key only once the node stopped the attempt", async () => {
    const fork = node(
      new ThreadForkError({
        message: "git worktree add failed",
        reason: "preparation-failed",
        retryable: true,
        attempt: "stopped",
      }),
      result,
    );
    connect();
    const at = boundary();
    const first = await send(
      updateThreadForkSelection(openSheet(at), {
        destination: "new-worktree",
        worktreeStart: "checkpoint",
      }),
    );
    expect(first.settled).toMatchObject({ phase: "failed", bound: { nodeAttempt: "stopped" } });
    // Nothing is held for a stopped attempt, so a reopened sheet starts fresh.
    expect(restoreThreadForkAttempt(at)).toBeNull();

    const changed = await send(
      updateThreadForkSelection(first.settled, { destination: "current-checkout" }),
    );
    expect(changed.input.forkKey).not.toBe(first.input.forkKey);
    expect(fork.mock.calls[1]?.[0]).toEqual(changed.input);
  });

  it("classifies the node's typed refusal with the shared copy", async () => {
    node(
      new ThreadForkError({
        message: "turn has no checkpoint",
        reason: "checkpoint-unavailable",
        retryable: false,
        attempt: "none",
      }),
    );
    connect();
    const sent = await send(
      updateThreadForkSelection(openSheet(boundary()), {
        destination: "new-worktree",
        worktreeStart: "checkpoint",
      }),
    );
    expect(sent.settled.failure).toMatchObject({
      reason: "checkpoint-unavailable",
      retryable: false,
      attempt: "none",
      detail: "turn has no checkpoint",
    });
  });

  it("sends nothing once the reviewed connection's shell generation changed", async () => {
    const fork = node(result);
    connect();
    const assert = captureThreadForkReadiness(environmentId);
    state.generation = {};
    const sent = await send(openSheet(boundary()), assert);
    expect(sent.settled.refusal).toMatchObject({ awaiting: true });
    expect(fork).not.toHaveBeenCalled();
  });

  it("without a live client sends nothing and leaves an unknown outcome locked", async () => {
    const fork = node(new Error("socket closed"));
    connect();
    const at = boundary();
    const uncertain = (await send(openSheet(at))).settled;

    state.api = null; // The connection went away before the retry.
    const refused = await send(uncertain);
    expect(refused.settled).toMatchObject({
      phase: "uncertain",
      forkKey: uncertain.forkKey,
      refusal: { awaiting: true },
    });
    expect(restoreThreadForkAttempt(at)).toMatchObject({ phase: "uncertain" });
    expect(fork).toHaveBeenCalledOnce();
  });

  it("refuses as unavailable when the client cannot fork", async () => {
    state.api = { threads: {} } as unknown as EnvironmentApi;
    const sent = await send(openSheet(boundary()));
    expect(sent.settled).toMatchObject({ phase: "editing", refusal: { awaiting: false } });
  });
});
