import {
  AuthRpcError,
  CheckpointRef,
  MessageId,
  ProjectId,
  ThreadForkError,
  ThreadId,
  TurnId,
  type ThreadForkInput,
  type ThreadForkResult,
} from "@ryco/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { RpcRequestRefusedError } from "../../rpc/protocol.ts";
import { RpcTransportDisposedError } from "../../rpc/wsTransport.ts";
import { isMaterializableCheckpointSummary } from "./checkpointSummary.ts";
import {
  buildThreadForkInput,
  classifyThreadForkError,
  createThreadForkKey,
  defaultThreadForkBaseRef,
  defaultThreadForkOption,
  deriveForkableReplyMessageIds,
  describeThreadForkFailure,
  effectiveThreadForkOption,
  listThreadForkDestinations,
  listThreadForkWorktreeStarts,
  readThreadForkApi,
  resolveThreadForkApi,
  resolveThreadForkSourceGit,
  runThreadFork,
  THREAD_FORK_COPY,
  THREAD_FORK_EXCERPT_MAX_CHARS,
  threadForkBoundaryQuote,
  threadForkBusyLabel,
  threadForkFailureMessage,
  threadForkReplyExcerpt,
  threadForkRequestSignature,
  type ThreadForkApi,
  type ThreadForkReplyContext,
} from "./threadFork.ts";
import type { ChatMessage } from "./types.ts";

const turn = (id: string) => TurnId.make(id);

function message(
  id: string,
  role: ChatMessage["role"],
  turnId: string | null,
  overrides: Partial<ChatMessage> = {},
): ChatMessage {
  return {
    id: MessageId.make(id),
    role,
    text: id,
    turnId: turnId === null ? null : turn(turnId),
    createdAt: "2026-10-11T00:00:00.000Z",
    streaming: false,
    ...overrides,
  };
}

const conversation = [
  message("user-1", "user", "turn-1"),
  message("commentary-1", "assistant", "turn-1"),
  message("reply-1", "assistant", "turn-1"),
  message("user-2", "user", "turn-2"),
  message("reply-2", "assistant", "turn-2"),
  message("system-2", "system", "turn-2"),
];
const settled = {
  latestTurn: { turnId: turn("turn-2"), state: "completed" as const },
  session: null,
};

const ids = (messages: ReadonlyArray<ChatMessage>, context: Partial<ThreadForkReplyContext> = {}) =>
  [...deriveForkableReplyMessageIds({ ...settled, ...context, messages })].toSorted();

describe("deriveForkableReplyMessageIds", () => {
  it("offers the terminal reply of each completed turn, including the latest one", () => {
    // A later system notice in the same turn does not make the reply mid-turn.
    expect(ids(conversation)).toEqual(["reply-1", "reply-2"]);
  });

  it("never offers user messages, mid-turn commentary, streaming or turnless rows", () => {
    const messages = [
      ...conversation,
      message("user-3", "user", "turn-3"),
      message("live", "assistant", "turn-3", { streaming: true }),
      message("legacy", "assistant", null),
    ];
    expect(ids(messages, { latestTurn: { turnId: turn("turn-3"), state: "running" } })).toEqual([
      "reply-1",
      "reply-2",
    ]);
  });

  it("never offers the reply of a running, interrupted or failed latest turn", () => {
    for (const state of ["running", "interrupted", "error"] as const) {
      expect(ids(conversation, { latestTurn: { turnId: turn("turn-2"), state } })).toEqual([
        "reply-1",
      ]);
    }
    expect(ids(conversation, { session: { activeTurnId: turn("turn-2") } })).toEqual(["reply-1"]);
  });

  it("never offers a reply followed by a steer in the same turn", () => {
    expect(ids([...conversation, message("steer", "user", "turn-2")])).toEqual(["reply-1"]);
  });

  describe("turns that publish a page or file next to their reply", () => {
    const page = (id: string, turnId: string) =>
      message(id, "assistant", turnId, {
        text: " ",
        attachments: [
          {
            type: "file",
            id: `${id}-file`,
            name: "page.html",
            mimeType: "text/html",
            sizeBytes: 1,
          },
        ] as never,
      });

    it("offers the text reply when the page was published after it, never the page", () => {
      // Codex opens its reply before it publishes the page: the blank carrier comes last.
      expect(
        ids([
          ...conversation,
          message("user-3", "user", "turn-3"),
          message("final", "assistant", "turn-3"),
          page("page", "turn-3"),
        ]),
      ).toEqual(["final", "reply-1", "reply-2"]);
    });

    it("offers the text reply when the page came first", () => {
      expect(
        ids([
          ...conversation,
          message("user-3", "user", "turn-3"),
          page("page", "turn-3"),
          message("final", "assistant", "turn-3"),
        ]),
      ).toEqual(["final", "reply-1", "reply-2"]);
    });

    it("offers the latest page of a turn that answered with pages only", () => {
      expect(
        ids([
          ...conversation,
          message("user-3", "user", "turn-3"),
          page("page-1", "turn-3"),
          page("page-2", "turn-3"),
        ]),
      ).toEqual(["page-2", "reply-1", "reply-2"]);
    });

    it("still refuses a turn whose reply or page was followed by a steer", () => {
      const steer = message("steer", "user", "turn-3");
      expect(
        ids([
          ...conversation,
          message("user-3", "user", "turn-3"),
          message("final", "assistant", "turn-3"),
          page("page", "turn-3"),
          steer,
        ]),
      ).toEqual(["reply-1", "reply-2"]);
      expect(
        ids([...conversation, message("user-3", "user", "turn-3"), page("page", "turn-3"), steer]),
      ).toEqual(["reply-1", "reply-2"]);
    });

    it("counts an image-only steer as a steer", () => {
      const imageSteer = message("image-steer", "user", "turn-3", {
        text: "",
        attachments: [
          { type: "image", id: "img", name: "a.png", mimeType: "image/png", sizeBytes: 1 },
        ] as never,
      });
      expect(
        ids([
          ...conversation,
          message("user-3", "user", "turn-3"),
          message("final", "assistant", "turn-3"),
          imageSteer,
        ]),
      ).toEqual(["reply-1", "reply-2"]);
    });
  });
});

describe("isMaterializableCheckpointSummary", () => {
  const ref = CheckpointRef.make("refs/ryco/checkpoints/thread/turn/2");
  it("accepts a captured checkpoint and rejects placeholders and failures", () => {
    expect(isMaterializableCheckpointSummary({ status: "ready", checkpointRef: ref })).toBe(true);
    expect(isMaterializableCheckpointSummary({ checkpointRef: ref })).toBe(true);
    expect(isMaterializableCheckpointSummary({ status: "missing", checkpointRef: ref })).toBe(
      false,
    );
    expect(isMaterializableCheckpointSummary({ status: "error", checkpointRef: ref })).toBe(false);
    expect(
      isMaterializableCheckpointSummary({
        status: "ready",
        checkpointRef: CheckpointRef.make("provider-diff:event-1"),
      }),
    ).toBe(false);
    expect(isMaterializableCheckpointSummary({ status: "ready" })).toBe(false);
    expect(isMaterializableCheckpointSummary(undefined)).toBe(false);
  });
});

describe("listThreadForkDestinations", () => {
  const base = {
    isChat: false,
    isGitRepo: true as boolean | null,
    chatsAvailable: true,
    sourceWorktreePath: null as string | null,
    sourceBranch: "main" as string | null,
  };

  it("offers a projectless chat a new chat only", () => {
    expect(listThreadForkDestinations({ ...base, isChat: true })).toEqual([
      expect.objectContaining({ kind: "new-chat", enabled: true }),
    ]);
    expect(listThreadForkDestinations({ ...base, isChat: true, chatsAvailable: false })).toEqual([
      expect.objectContaining({
        kind: "new-chat",
        enabled: false,
        disabledReason: THREAD_FORK_COPY.destinations.chatsUnavailable,
      }),
    ]);
  });

  it("offers a non-Git project its folder only", () => {
    expect(listThreadForkDestinations({ ...base, isGitRepo: false })).toEqual([
      expect.objectContaining({ kind: "current-checkout", label: "This folder", enabled: true }),
    ]);
  });

  it("offers a Git project its checkout and a new worktree", () => {
    const [current, worktree] = listThreadForkDestinations(base);
    expect(current).toMatchObject({ kind: "current-checkout", label: "The current checkout" });
    expect(current?.description).toContain("main");
    expect(worktree).toMatchObject({ kind: "new-worktree", enabled: true });
    expect(worktree).not.toHaveProperty("disabledReason");
    expect(
      listThreadForkDestinations({ ...base, sourceWorktreePath: "/worktrees/a" })[0]?.label,
    ).toBe("This worktree");
  });

  it("keeps the worktree disabled until Git is confirmed", () => {
    const options = listThreadForkDestinations({ ...base, isGitRepo: null });
    expect(options.map((option) => option.kind)).toEqual(["current-checkout", "new-worktree"]);
    expect(options[1]).toMatchObject({ enabled: false, disabledReason: "Checking Git…" });
    expect(defaultThreadForkOption(options)?.kind).toBe("current-checkout");
  });
});

describe("worktree starts", () => {
  it("defaults to the checkpoint only when the turn has one", () => {
    expect(
      defaultThreadForkOption(listThreadForkWorktreeStarts({ checkpointAvailable: true }))?.kind,
    ).toBe("checkpoint");
    const without = listThreadForkWorktreeStarts({ checkpointAvailable: false });
    expect(without[0]).toMatchObject({ kind: "checkpoint", enabled: false });
    expect(defaultThreadForkOption(without)?.kind).toBe("base-ref");
  });

  it("prefills the base ref with the source branch or HEAD", () => {
    expect(defaultThreadForkBaseRef(" feature/x ")).toBe("feature/x");
    expect(defaultThreadForkBaseRef(null)).toBe("HEAD");
    expect(defaultThreadForkBaseRef("  ")).toBe("HEAD");
  });

  it("labels the busy state by destination", () => {
    expect(threadForkBusyLabel("new-worktree")).toBe("Preparing worktree…");
    expect(threadForkBusyLabel("current-checkout")).toBe("Creating fork…");
  });
});

describe("fork requests", () => {
  const forkKey = createThreadForkKey(() => "0123456789abcdef0123456789abcdef");
  const source = {
    forkKey,
    sourceThreadId: ThreadId.make("source"),
    sourceMessageId: MessageId.make("reply-1"),
  };

  it("mints keys from injected randomness and refuses weak input", () => {
    expect(forkKey).toBe("fork-0123456789abcdef0123456789abcdef");
    expect(() => createThreadForkKey(() => "abc")).toThrow();
    expect(() => createThreadForkKey(() => "not hex at all, really")).toThrow();
  });

  it("builds each destination", () => {
    expect(
      buildThreadForkInput({ ...source, selection: { destination: "current-checkout" } }),
    ).toEqual({ ok: true, input: { ...source, destination: { kind: "current-checkout" } } });
    expect(buildThreadForkInput({ ...source, selection: { destination: "new-chat" } })).toEqual({
      ok: true,
      input: { ...source, destination: { kind: "new-chat" } },
    });
    expect(
      buildThreadForkInput({
        ...source,
        selection: { destination: "new-worktree", worktreeStart: "checkpoint", baseRef: "ignored" },
      }),
    ).toEqual({
      ok: true,
      input: { ...source, destination: { kind: "new-worktree", start: { kind: "checkpoint" } } },
    });
    expect(
      buildThreadForkInput({
        ...source,
        selection: { destination: "new-worktree", worktreeStart: "base-ref", baseRef: " main " },
      }),
    ).toEqual({
      ok: true,
      input: {
        ...source,
        destination: { kind: "new-worktree", start: { kind: "base-ref", baseRef: "main" } },
      },
    });
  });

  it("explains a selection that cannot be sent yet", () => {
    const worktree = (worktreeStart: "base-ref" | null, baseRef?: string) =>
      buildThreadForkInput({
        ...source,
        selection: { destination: "new-worktree", worktreeStart, baseRef },
      });
    expect(worktree(null)).toEqual({ ok: false, message: THREAD_FORK_COPY.worktreeStartRequired });
    expect(worktree("base-ref", "  ")).toEqual({
      ok: false,
      message: THREAD_FORK_COPY.worktreeStarts.baseRefRequired,
    });
    expect(worktree("base-ref", "x".repeat(257))).toEqual({
      ok: false,
      message: THREAD_FORK_COPY.worktreeStarts.baseRefTooLong,
    });
  });
});

describe("runThreadFork", () => {
  const input: ThreadForkInput = {
    forkKey: "fork-0123456789abcdef0123456789abcdef",
    sourceThreadId: ThreadId.make("source"),
    sourceMessageId: MessageId.make("reply-1"),
    destination: { kind: "current-checkout" },
  };
  const result: ThreadForkResult = {
    threadId: ThreadId.make("fork-thread"),
    projectId: ProjectId.make("project"),
    replayed: false,
    providerContext: "native",
    checkout: { kind: "current-checkout", worktreePath: null, branch: "main" },
    notices: [],
  };

  function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((onResolve, onReject) => {
      resolve = onResolve;
      reject = onReject;
    });
    return { promise, resolve, reject };
  }

  it("sends the request once for concurrent calls with the same key and request", async () => {
    const pending = deferred<ThreadForkResult>();
    const api: ThreadForkApi = { fork: vi.fn(() => pending.promise) };
    const first = runThreadFork({ api, input });
    const second = runThreadFork({ api, input });
    expect(second).toBe(first);
    pending.resolve(result);
    await expect(first).resolves.toEqual({ status: "succeeded", result });
    expect(api.fork).toHaveBeenCalledTimes(1);
    expect(api.fork).toHaveBeenCalledWith(input);

    // A settled call is not cached: a later retry asks the node again (it replays).
    await runThreadFork({ api, input });
    expect(api.fork).toHaveBeenCalledTimes(2);
  });

  it("lets the node answer a different request under the same key", async () => {
    const api: ThreadForkApi = { fork: vi.fn(() => new Promise<ThreadForkResult>(() => {})) };
    const first = runThreadFork({ api, input });
    const other = runThreadFork({ api, input: { ...input, destination: { kind: "new-chat" } } });
    expect(other).not.toBe(first);
    expect(api.fork).toHaveBeenCalledTimes(2);
  });

  it("checks readiness right before sending and sends nothing when it changed", async () => {
    const api: ThreadForkApi = { fork: vi.fn(async () => result) };
    const outcome = await runThreadFork({
      api,
      input,
      assertMutationReady: () => {
        throw new Error("The connection changed during Claude resume review.");
      },
    });
    expect(outcome).toMatchObject({
      status: "refused",
      awaiting: true,
      message: THREAD_FORK_COPY.connectionChanged,
    });
    expect(api.fork).not.toHaveBeenCalled();
  });

  it("classifies typed node refusals by reason and attempt, never by message", async () => {
    const api: ThreadForkApi = {
      fork: vi.fn(async () => {
        throw new ThreadForkError({
          message: "git worktree add failed: path exists",
          reason: "preparation-failed",
          retryable: true,
          attempt: "running",
        });
      }),
    };
    const outcome = await runThreadFork({ api, input });
    expect(outcome).toEqual({
      status: "failed",
      reason: "preparation-failed",
      retryable: true,
      attempt: "running",
      message: `${THREAD_FORK_COPY.errors["preparation-failed"]} ${THREAD_FORK_COPY.attempts.running}`,
      detail: "git worktree add failed: path exists",
    });
    expect(describeThreadForkFailure(outcome as never)).toMatchObject({
      canRetry: true,
      suggestBaseRef: false,
    });
  });

  it("suggests a base ref when the checkpoint cannot start a worktree", () => {
    const outcome = classifyThreadForkError(
      new ThreadForkError({
        message: "x",
        reason: "checkpoint-unavailable",
        retryable: false,
        attempt: "none",
      }),
    );
    expect(describeThreadForkFailure(outcome)).toEqual({
      message: `${THREAD_FORK_COPY.errors["checkpoint-unavailable"]} ${THREAD_FORK_COPY.attempts.none}`,
      canRetry: false,
      suggestBaseRef: true,
    });
  });

  it("treats a typed refusal without a readable attempt as uncertain", () => {
    expect(
      classifyThreadForkError({
        _tag: "ThreadForkError",
        message: "x",
        reason: "preparation-failed",
        retryable: true,
      }),
    ).toMatchObject({ status: "uncertain" });
  });

  it("treats requests that never ran as refused", () => {
    expect(classifyThreadForkError(new RpcRequestRefusedError("awaiting-session"))).toMatchObject({
      status: "refused",
      awaiting: true,
    });
    expect(classifyThreadForkError(new RpcRequestRefusedError("forbidden"))).toMatchObject({
      status: "refused",
      awaiting: false,
    });
    expect(classifyThreadForkError(new RpcTransportDisposedError())).toMatchObject({
      status: "refused",
      awaiting: true,
    });
    const forbidden = classifyThreadForkError(
      new AuthRpcError({ message: "Operator access required.", status: 403 }),
    );
    expect(forbidden).toMatchObject({
      status: "refused",
      awaiting: false,
      message: THREAD_FORK_COPY.refusedForbidden,
    });
    expect(describeThreadForkFailure(forbidden).canRetry).toBe(false);
  });

  it("reports every other failure as uncertain and retryable with the same key", async () => {
    for (const error of [
      { _tag: "RpcClientError", message: "socket closed" },
      new Error("All fibers interrupted without error"),
      { _tag: "ThreadForkError", reason: "from-a-newer-node", retryable: false },
      "unexpected",
    ]) {
      const outcome = classifyThreadForkError(error);
      expect(outcome).toMatchObject({ status: "uncertain", message: THREAD_FORK_COPY.uncertain });
      expect(describeThreadForkFailure(outcome)).toMatchObject({ canRetry: true });
    }
    const api: ThreadForkApi = {
      fork: () => {
        throw new Error("synchronous transport failure");
      },
    };
    await expect(runThreadFork({ api, input })).resolves.toMatchObject({ status: "uncertain" });
  });
});

describe("threadForkFailureMessage", () => {
  const LEFT_BEHIND = /nothing was left behind/i;

  it("claims nothing was left behind only when the node stopped the attempt", () => {
    const stopped = threadForkFailureMessage({
      reason: "preparation-failed",
      retryable: true,
      attempt: "stopped",
    });
    expect(stopped).toMatch(LEFT_BEHIND);
    expect(stopped).toMatch(/retry/i);
    for (const attempt of ["none", "running"] as const) {
      for (const retryable of [true, false]) {
        expect(
          threadForkFailureMessage({ reason: "preparation-failed", retryable, attempt }),
        ).not.toMatch(LEFT_BEHIND);
      }
    }
  });

  it("says a running attempt is still being prepared and that Retry checks on it", () => {
    const running = threadForkFailureMessage({
      reason: "source-busy",
      retryable: true,
      attempt: "running",
    });
    expect(running).toContain(THREAD_FORK_COPY.attempts.running);
    expect(running).not.toMatch(/nothing was created/i);
  });

  it("offers no retry in the copy of a final refusal", () => {
    const final = threadForkFailureMessage({
      reason: "preparation-failed",
      retryable: false,
      attempt: "stopped",
    });
    expect(final).not.toMatch(/retry|try again/i);
  });

  it("never claims anything about the node for a deleted fork or a conflicting key", () => {
    expect(
      threadForkFailureMessage({ reason: "deleted", retryable: false, attempt: "stopped" }),
    ).toBe(THREAD_FORK_COPY.errors.deleted);
    expect(
      threadForkFailureMessage({
        reason: "idempotency-conflict",
        retryable: false,
        attempt: "running",
      }),
    ).toContain(THREAD_FORK_COPY.attempts.runningElsewhere);
  });

  it("never tells the user to close the dialog and fork again", () => {
    for (const reason of Object.keys(THREAD_FORK_COPY.errors)) {
      expect(THREAD_FORK_COPY.errors[reason as keyof typeof THREAD_FORK_COPY.errors]).not.toMatch(
        /left behind|fork again/i,
      );
    }
  });
});

describe("dialog helpers", () => {
  it("quotes the reply as one bounded paragraph without splitting a character", () => {
    expect(threadForkReplyExcerpt("  a\n\n b  ")).toBe("a b");
    const long = "x".repeat(400);
    expect(threadForkReplyExcerpt(long)).toBe(`${"x".repeat(THREAD_FORK_EXCERPT_MAX_CHARS - 1)}…`);
    // An emoji straddling the cut is dropped whole instead of leaving half a surrogate pair.
    const emoji = `${"x".repeat(8)}😀tail`;
    expect(threadForkReplyExcerpt(emoji, 10)).toBe(`${"x".repeat(8)}…`);
  });

  it("keeps the chosen option while it is enabled, else falls back to the first enabled", () => {
    const options = listThreadForkDestinations({
      isChat: false,
      isGitRepo: null,
      chatsAvailable: true,
      sourceWorktreePath: null,
      sourceBranch: "main",
    });
    expect(effectiveThreadForkOption(options, "new-worktree")).toBe("current-checkout");
    expect(effectiveThreadForkOption(options, "current-checkout")).toBe("current-checkout");
    expect(effectiveThreadForkOption(options, null)).toBe("current-checkout");
  });

  it("resolves Git from a loaded status only, and a failed read as no repository", () => {
    expect(resolveThreadForkSourceGit({ isChat: true, status: { data: null, error: null } })).toBe(
      false,
    );
    expect(
      resolveThreadForkSourceGit({
        isChat: false,
        status: { data: { isRepo: true }, error: null },
      }),
    ).toBe(true);
    expect(resolveThreadForkSourceGit({ isChat: false, status: { data: null, error: null } })).toBe(
      null,
    );
    expect(
      resolveThreadForkSourceGit({ isChat: false, status: { data: null, error: new Error("x") } }),
    ).toBe(false);
  });

  it("signs a request by everything but its key", () => {
    const base = {
      sourceThreadId: ThreadId.make("source"),
      sourceMessageId: MessageId.make("reply-1"),
    };
    const sign = (destination: ThreadForkInput["destination"], forkKey = "fork-aaaaaaaaaaaaaaaa") =>
      threadForkRequestSignature({ ...base, forkKey, destination } as ThreadForkInput);
    expect(sign({ kind: "current-checkout" })).toBe(
      sign({ kind: "current-checkout" }, "fork-bbbbbbbbbbbbbbbb"),
    );
    expect(sign({ kind: "new-worktree", start: { kind: "checkpoint" } })).not.toBe(
      sign({ kind: "new-worktree", start: { kind: "base-ref", baseRef: "main" } }),
    );
  });
});

describe("readThreadForkApi", () => {
  it("returns the environment's threads API only when it can fork", () => {
    const threads = {
      setManualBucket: vi.fn(),
      setManualPosition: vi.fn(),
      fork: vi.fn(),
    };
    expect(readThreadForkApi({ threads } as never)).toBe(threads);
    expect(readThreadForkApi({ threads: { ...threads, fork: undefined } } as never)).toBeNull();
    expect(readThreadForkApi({} as never)).toBeNull();
    expect(readThreadForkApi(undefined)).toBeNull();
  });
});

describe("resolveThreadForkApi", () => {
  it("returns the fork API, else the refusal a send records", () => {
    const threads = { fork: vi.fn() };
    expect(resolveThreadForkApi(() => ({ threads }) as never)).toBe(threads);
    // No live client (none registered, or one being replaced): wait for the connection.
    const disconnected = {
      refusal: {
        status: "refused",
        awaiting: true,
        message: THREAD_FORK_COPY.connectionChanged,
      },
    };
    expect(resolveThreadForkApi(() => undefined)).toMatchObject(disconnected);
    expect(
      resolveThreadForkApi(() => {
        throw new Error("Environment API not found");
      }),
    ).toMatchObject(disconnected);
    // A client that cannot fork at all.
    expect(resolveThreadForkApi(() => ({ threads: {} }) as never)).toMatchObject({
      refusal: { status: "refused", awaiting: false, message: THREAD_FORK_COPY.errors.unavailable },
    });
  });
});

describe("threadForkBoundaryQuote", () => {
  const page = (id: string, title: string) => ({
    type: "file" as const,
    id,
    name: `${id}.html`,
    mimeType: "text/html",
    sizeBytes: 10,
    htmlRender: { title, height: 400 },
  });
  const file = {
    type: "file" as const,
    id: "csv",
    name: "data.csv",
    mimeType: "text/csv",
    sizeBytes: 1,
  };

  it("quotes the reply's text", () => {
    expect(threadForkBoundaryQuote(conversation, MessageId.make("reply-1"))).toBe("reply-1");
    expect(threadForkBoundaryQuote(conversation, MessageId.make("missing"))).toBe("");
  });

  it("quotes what a page-only or file-only reply published", () => {
    const messages = [
      message("user-1", "user", "turn-1"),
      message("page-1", "assistant", "turn-1", {
        text: " ",
        attachments: [page("p", "Report"), file],
      }),
    ];
    expect(threadForkBoundaryQuote(messages, MessageId.make("page-1"))).toBe("Report, data.csv");
  });

  it("quotes the page for a blank reply under it", () => {
    const messages = [
      message("user-1", "user", "turn-1"),
      message("page-1", "assistant", "turn-1", { text: "", attachments: [page("p", "Coverage")] }),
      message("blank-1", "assistant", "turn-1", { text: "" }),
      // Another turn's page is not this reply's.
      message("page-2", "assistant", "turn-2", { text: "", attachments: [page("q", "Other")] }),
    ];
    expect(threadForkBoundaryQuote(messages, MessageId.make("blank-1"))).toBe("Coverage");
    expect(
      threadForkBoundaryQuote(
        [message("blank-0", "assistant", null, { text: "" })],
        MessageId.make("blank-0"),
      ),
    ).toBe("");
  });
});
