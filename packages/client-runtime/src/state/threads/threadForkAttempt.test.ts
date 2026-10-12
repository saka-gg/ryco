import {
  EnvironmentId,
  MessageId,
  ProjectId,
  ThreadForkError,
  ThreadId,
  type ThreadForkAttemptState as NodeAttemptState,
  type ThreadForkErrorReason,
  type ThreadForkInput,
  type ThreadForkKey,
  type ThreadForkResult,
} from "@ryco/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { RpcRequestRefusedError } from "../../rpc/protocol.ts";
import {
  classifyThreadForkError,
  listThreadForkDestinations,
  listThreadForkWorktreeStarts,
  THREAD_FORK_COPY,
  type ThreadForkOutcome,
} from "./threadFork.ts";
import {
  acknowledgeThreadForkAttempt,
  alignThreadForkSelection,
  applyThreadForkOutcome,
  beginThreadForkAttempt,
  forgetThreadForkAttempt,
  isThreadForkAttemptLocked,
  openThreadForkAttempt,
  prepareThreadForkSubmit,
  rememberThreadForkAttempt,
  restoreThreadForkAttempt,
  submitThreadForkAttempt,
  threadForkAttemptView,
  threadForkSelectionOfRequest,
  threadForkSendReadiness,
  updateThreadForkSelection,
  type ThreadForkAttemptBoundary,
  type ThreadForkAttemptState,
} from "./threadForkAttempt.ts";

const boundary: ThreadForkAttemptBoundary = {
  environmentId: EnvironmentId.make("environment-local"),
  sourceThreadId: ThreadId.make("source"),
  sourceMessageId: MessageId.make("reply-1"),
};

function keys() {
  let next = 0;
  return vi.fn((): ThreadForkKey => {
    next += 1;
    return `fork-${String(next).padStart(16, "0")}`;
  });
}

const result: ThreadForkResult = {
  threadId: ThreadId.make("fork-thread"),
  projectId: ProjectId.make("project"),
  replayed: false,
  providerContext: "native",
  checkout: { kind: "current-checkout", worktreePath: null, branch: "main" },
  notices: [],
};

function begin(mintKey = keys()) {
  return beginThreadForkAttempt({
    boundary,
    selection: { destination: "current-checkout" },
    defaultBaseRef: "main",
    mintKey,
  });
}

function submit(state: ThreadForkAttemptState, mintKey: () => ThreadForkKey) {
  const prepared = prepareThreadForkSubmit(state, mintKey);
  if (!prepared.ok) throw new Error(`not submittable: ${prepared.reason}`);
  return prepared;
}

function failed(
  reason: ThreadForkErrorReason,
  attempt: NodeAttemptState,
  retryable = true,
): ThreadForkOutcome {
  return classifyThreadForkError(
    new ThreadForkError({ message: `node: ${reason}`, reason, retryable, attempt }),
  );
}

const uncertain: ThreadForkOutcome = {
  status: "uncertain",
  message: THREAD_FORK_COPY.uncertain,
  error: new Error("socket closed"),
};
const refused: ThreadForkOutcome = classifyThreadForkError(
  new RpcRequestRefusedError("awaiting-acknowledgement"),
);

/** Submits the current selection and applies `outcome`; returns the settled state and input. */
function attempt(
  state: ThreadForkAttemptState,
  outcome: ThreadForkOutcome,
  mintKey: () => ThreadForkKey,
) {
  const prepared = submit(state, mintKey);
  return { input: prepared.input, state: applyThreadForkOutcome(prepared.state, outcome) };
}

const toNewWorktree = (state: ThreadForkAttemptState) =>
  updateThreadForkSelection(state, {
    destination: "new-worktree",
    worktreeStart: "checkpoint",
  });

afterEach(() => forgetThreadForkAttempt(boundary));

describe("fork attempt keys", () => {
  it("opens an editable attempt under a fresh key", () => {
    const mintKey = keys();
    const state = begin(mintKey);
    expect(state).toMatchObject({
      phase: "editing",
      bound: null,
      forkKey: "fork-0000000000000001",
    });
    expect(threadForkAttemptView(state)).toMatchObject({
      canEdit: true,
      canSubmit: true,
      canRetry: false,
      canDismiss: true,
      submitLabel: THREAD_FORK_COPY.submit,
      notice: null,
    });
  });

  it("locks the form and the key while a request is in flight", () => {
    const mintKey = keys();
    const prepared = submit(begin(mintKey), mintKey);
    expect(prepared.input).toMatchObject({
      forkKey: "fork-0000000000000001",
      destination: { kind: "current-checkout" },
    });
    expect(threadForkAttemptView(prepared.state)).toMatchObject({
      canEdit: false,
      canSubmit: false,
      canDismiss: false,
      busyLabel: THREAD_FORK_COPY.busy.creating,
    });
    expect(toNewWorktree(prepared.state)).toBe(prepared.state);
    expect(prepareThreadForkSubmit(prepared.state, mintKey)).toMatchObject({
      ok: false,
      reason: "busy",
    });
  });

  it("never mints a key after a retryable failure whose attempt is still running", () => {
    const mintKey = keys();
    const first = attempt(begin(mintKey), failed("source-busy", "running"), mintKey);
    expect(first.state.phase).toBe("running");
    expect(isThreadForkAttemptLocked(first.state)).toBe(true);
    // The selection cannot change, so no other request can go out under any key.
    expect(toNewWorktree(first.state)).toBe(first.state);
    const view = threadForkAttemptView(first.state);
    expect(view).toMatchObject({
      canEdit: false,
      canRetry: true,
      canSubmit: true,
      submitLabel: THREAD_FORK_COPY.checkAgain,
      notice: { tone: "warning", title: THREAD_FORK_COPY.titles.running },
    });
    expect(view.notice?.message).not.toMatch(/left behind|wasn't created/i);
    const retry = submit(first.state, mintKey);
    expect(retry.input).toEqual(first.input);
    expect(mintKey).toHaveBeenCalledTimes(1);
  });

  it("gives a changed request a new key after the node stopped the attempt", () => {
    const mintKey = keys();
    const first = attempt(
      toNewWorktree(begin(mintKey)),
      failed("preparation-failed", "stopped"),
      mintKey,
    );
    expect(first.state.phase).toBe("failed");
    expect(threadForkAttemptView(first.state)).toMatchObject({
      canEdit: true,
      canRetry: true,
      submitLabel: THREAD_FORK_COPY.retry,
      notice: { tone: "error", title: THREAD_FORK_COPY.titles.notCreated },
    });
    // Same request: a retry under the same key (the node restarts it).
    expect(submit(first.state, mintKey).input).toEqual(first.input);
    // Changed request: a key of its own, since the stopped key would answer idempotency-conflict.
    const changed = updateThreadForkSelection(first.state, { destination: "current-checkout" });
    expect(threadForkAttemptView(changed)).toMatchObject({
      canRetry: false,
      submitLabel: THREAD_FORK_COPY.submit,
    });
    const next = submit(changed, mintKey);
    expect(next.input.forkKey).toBe("fork-0000000000000002");
    expect(next.input.destination).toEqual({ kind: "current-checkout" });
    expect(next.state.forkKey).toBe("fork-0000000000000002");
  });

  it("keeps the key for any request when the node recorded nothing for it", () => {
    const mintKey = keys();
    const first = attempt(
      begin(mintKey),
      failed("destination-unavailable", "none", false),
      mintKey,
    );
    expect(first.state.bound).toBeNull();
    // Resending the same request would only repeat a final refusal.
    expect(threadForkAttemptView(first.state).canSubmit).toBe(false);
    const changed = updateThreadForkSelection(first.state, { destination: "new-chat" });
    expect(threadForkAttemptView(changed).canSubmit).toBe(true);
    expect(submit(changed, mintKey).input.forkKey).toBe(first.input.forkKey);
    expect(mintKey).toHaveBeenCalledTimes(1);
  });

  it("switches to a prefilled base ref under the same key when the checkpoint is refused", () => {
    const mintKey = keys();
    const first = attempt(
      toNewWorktree(begin(mintKey)),
      failed("checkpoint-unavailable", "none", false),
      mintKey,
    );
    expect(first.state).toMatchObject({
      phase: "failed",
      checkpointRefused: true,
      selection: { destination: "new-worktree", worktreeStart: "base-ref", baseRef: "main" },
    });
    expect(threadForkAttemptView(first.state)).toMatchObject({
      suggestBaseRef: true,
      canSubmit: true,
      submitLabel: THREAD_FORK_COPY.submit,
    });
    const next = submit(first.state, mintKey);
    expect(next.input).toEqual({
      ...first.input,
      destination: { kind: "new-worktree", start: { kind: "base-ref", baseRef: "main" } },
    });
  });

  it("gives the base-ref fallback a new key when the checkpoint failed after acceptance", () => {
    const mintKey = keys();
    const first = attempt(
      toNewWorktree(begin(mintKey)),
      failed("checkpoint-unavailable", "stopped", false),
      mintKey,
    );
    expect(first.state.selection).toMatchObject({ worktreeStart: "base-ref", baseRef: "main" });
    expect(submit(first.state, mintKey).input.forkKey).toBe("fork-0000000000000002");
  });

  it("keeps an unknown outcome locked to the same request and key", () => {
    const mintKey = keys();
    const first = attempt(begin(mintKey), uncertain, mintKey);
    expect(first.state.phase).toBe("uncertain");
    expect(toNewWorktree(first.state)).toBe(first.state);
    expect(threadForkAttemptView(first.state)).toMatchObject({
      locked: true,
      canEdit: false,
      canRetry: true,
      canDismiss: true,
      submitLabel: THREAD_FORK_COPY.retry,
      notice: { tone: "warning", title: THREAD_FORK_COPY.titles.uncertain },
    });
    expect(submit(first.state, mintKey).input).toEqual(first.input);
    expect(mintKey).toHaveBeenCalledTimes(1);
  });

  it("keeps the uncertain state when a retry is refused before it was sent", () => {
    const mintKey = keys();
    const first = attempt(begin(mintKey), uncertain, mintKey);
    const retried = attempt(first.state, refused, mintKey);
    expect(retried.state).toMatchObject({
      phase: "uncertain",
      forkKey: first.state.forkKey,
      bound: first.state.bound,
    });
    const view = threadForkAttemptView(retried.state);
    expect(view).toMatchObject({
      locked: true,
      canEdit: false,
      canRetry: true,
      notice: {
        title: THREAD_FORK_COPY.titles.uncertain,
        message: refused.status === "refused" ? refused.message : "",
        detail: THREAD_FORK_COPY.uncertain,
      },
    });
    expect(toNewWorktree(retried.state)).toBe(retried.state);
  });

  it("keeps a running attempt when a retry is refused before it was sent", () => {
    const mintKey = keys();
    const first = attempt(begin(mintKey), failed("source-busy", "running"), mintKey);
    const retried = attempt(first.state, refused, mintKey);
    expect(retried.state).toMatchObject({ phase: "running", bound: first.state.bound });
    expect(threadForkAttemptView(retried.state).canEdit).toBe(false);
  });

  it("returns a refused first submit to editing with nothing bound", () => {
    const mintKey = keys();
    const first = attempt(begin(mintKey), refused, mintKey);
    expect(first.state).toMatchObject({ phase: "editing", bound: null });
    expect(threadForkAttemptView(first.state)).toMatchObject({
      canEdit: true,
      notice: { title: THREAD_FORK_COPY.titles.notSent },
    });
  });

  it("unlocks only on a definitive answer for the same request", () => {
    const mintKey = keys();
    const first = attempt(begin(mintKey), uncertain, mintKey);
    const answered = attempt(first.state, failed("preparation-failed", "stopped"), mintKey);
    expect(answered.input).toEqual(first.input);
    expect(answered.state.phase).toBe("failed");
    expect(threadForkAttemptView(answered.state).canEdit).toBe(true);
    const created = attempt(answered.state, { status: "succeeded", result }, mintKey);
    expect(created.state).toMatchObject({ phase: "succeeded", result });
    expect(prepareThreadForkSubmit(created.state, mintKey)).toMatchObject({
      ok: false,
      reason: "settled",
    });
  });

  it("locks a key that holds a request this client never sent", () => {
    const mintKey = keys();
    const first = attempt(
      begin(mintKey),
      failed("idempotency-conflict", "running", false),
      mintKey,
    );
    expect(first.state.phase).toBe("running");
    expect(threadForkAttemptView(first.state)).toMatchObject({
      canEdit: false,
      canRetry: false,
      canSubmit: false,
      canDismiss: true,
    });
    expect(prepareThreadForkSubmit(first.state, mintKey)).toMatchObject({
      ok: false,
      reason: "locked",
    });
    // A conflicting key whose attempt stopped is abandoned for a new one.
    const stopped = attempt(
      begin(mintKey),
      failed("idempotency-conflict", "stopped", false),
      mintKey,
    );
    expect(submit(stopped.state, mintKey).input.forkKey).not.toBe(stopped.input.forkKey);
  });

  it("ignores an outcome that does not answer the submit in flight", () => {
    const mintKey = keys();
    const prepared = submit(begin(mintKey), mintKey);
    expect(applyThreadForkOutcome(prepared.state, uncertain, prepared.state.submission - 1)).toBe(
      prepared.state,
    );
    const settled = applyThreadForkOutcome(prepared.state, uncertain);
    expect(applyThreadForkOutcome(settled, { status: "succeeded", result })).toBe(settled);
  });

  it("shows the node's explanation of a preparation failure", () => {
    const mintKey = keys();
    const first = attempt(begin(mintKey), failed("preparation-failed", "stopped", false), mintKey);
    expect(threadForkAttemptView(first.state).notice).toMatchObject({
      title: THREAD_FORK_COPY.titles.notCreated,
      detail: "node: preparation-failed",
    });
    expect(threadForkAttemptView(first.state).notice?.message).not.toMatch(/retry/i);
  });

  it("reports an invalid selection instead of sending it", () => {
    const mintKey = keys();
    const state = updateThreadForkSelection(begin(mintKey), {
      destination: "new-worktree",
      worktreeStart: "base-ref",
      baseRef: "  ",
    });
    expect(threadForkAttemptView(state)).toMatchObject({
      canSubmit: false,
      selectionError: THREAD_FORK_COPY.worktreeStarts.baseRefRequired,
    });
    expect(prepareThreadForkSubmit(state, mintKey)).toMatchObject({ ok: false, reason: "invalid" });
  });
});

describe("fork attempt registry", () => {
  it("restores an unknown outcome after the dialog closes, with the same key and request", async () => {
    const mintKey = keys();
    const api = {
      fork: vi.fn(async (_input: ThreadForkInput): Promise<ThreadForkResult> => {
        throw new Error("socket closed");
      }),
    };
    const opened = openThreadForkAttempt({
      boundary,
      selection: { destination: "current-checkout" },
      defaultBaseRef: "main",
      mintKey,
    });
    expect(opened.settling).toBeNull();
    const submission = submitThreadForkAttempt({ state: opened.state, mintKey, api });
    if (!submission.ok) throw new Error("not submitted");
    expect(restoreThreadForkAttempt(boundary)?.phase).toBe("submitting");
    const settled = await submission.settled;
    expect(settled.phase).toBe("uncertain");

    // The dialog closes; reopening the same reply continues the attempt.
    const { state: reopened } = openThreadForkAttempt({
      boundary,
      selection: { destination: "new-chat" },
      defaultBaseRef: "main",
      mintKey,
    });
    expect(reopened).toBe(settled);
    expect(threadForkAttemptView(reopened).canEdit).toBe(false);
    const retry = submitThreadForkAttempt({ state: reopened, mintKey, api });
    if (!retry.ok) throw new Error("not submitted");
    expect(retry.input).toEqual(submission.input);
    expect(api.fork).toHaveBeenNthCalledWith(2, submission.input);
    expect(mintKey).toHaveBeenCalledTimes(1);
    await retry.settled;
  });

  it("records the outcome of a request whose dialog closed while it ran", async () => {
    const mintKey = keys();
    let answer!: (value: ThreadForkResult) => void;
    const api = {
      fork: vi.fn(
        () =>
          new Promise<ThreadForkResult>((resolve) => {
            answer = resolve;
          }),
      ),
    };
    const submission = submitThreadForkAttempt({ state: begin(mintKey), mintKey, api });
    if (!submission.ok) throw new Error("not submitted");
    // A reopened dialog finds the request in flight, together with the outcome it settles to.
    const reopened = openThreadForkAttempt({
      boundary,
      selection: { destination: "new-chat" },
      defaultBaseRef: "main",
      mintKey,
    });
    expect(reopened.state).toBe(submission.state);
    expect(reopened.settling).not.toBeNull();
    answer(result);
    await expect(reopened.settling).resolves.toMatchObject({ phase: "succeeded", result });
    // Nobody opened the created fork yet: the next opening for this reply opens it.
    expect(restoreThreadForkAttempt(boundary)).toMatchObject({ phase: "succeeded", result });
    const again = openThreadForkAttempt({
      boundary,
      selection: { destination: "new-chat" },
      defaultBaseRef: "main",
      mintKey,
    });
    expect(again).toMatchObject({ state: { phase: "succeeded", result }, settling: null });
    // No fresh attempt (and key) was opened for a reply whose fork exists.
    expect(mintKey).toHaveBeenCalledOnce();
    // Once a dialog opened it, the next fork from this reply is a new one.
    acknowledgeThreadForkAttempt(again.state);
    expect(restoreThreadForkAttempt(boundary)).toBeNull();
  });

  it("keeps the outcome a reopened dialog waits for, even when it lands before the dialog follows it", async () => {
    const mintKey = keys();
    let answer!: (value: ThreadForkResult) => void;
    const api = {
      fork: vi.fn(
        () =>
          new Promise<ThreadForkResult>((resolve) => {
            answer = resolve;
          }),
      ),
    };
    const submission = submitThreadForkAttempt({ state: begin(mintKey), mintKey, api });
    if (!submission.ok) throw new Error("not submitted");
    const reopened = openThreadForkAttempt({
      boundary,
      selection: { destination: "current-checkout" },
      defaultBaseRef: "main",
      mintKey,
    });
    // The node answers before the reopened dialog starts following its request.
    answer(result);
    await submission.settled;
    expect(reopened.state.phase).toBe("submitting");
    await expect(reopened.settling).resolves.toMatchObject({ phase: "succeeded", result });
    // Nothing turned the created fork into "may have been created".
    expect(restoreThreadForkAttempt(boundary)?.phase).toBe("succeeded");
  });

  it("treats a request recorded in flight that nothing settles as lost", () => {
    const mintKey = keys();
    const prepared = submit(begin(mintKey), mintKey);
    rememberThreadForkAttempt(prepared.state);
    const opened = openThreadForkAttempt({
      boundary,
      selection: { destination: "current-checkout" },
      defaultBaseRef: "main",
      mintKey,
    });
    expect(opened).toMatchObject({ state: { phase: "uncertain" }, settling: null });
    expect(opened.state.forkKey).toBe(prepared.input.forkKey);
    expect(restoreThreadForkAttempt(boundary)).toBe(opened.state);
  });

  it("remembers locked attempts and created forks nobody opened", () => {
    const mintKey = keys();
    const stopped = attempt(begin(mintKey), failed("preparation-failed", "stopped"), mintKey);
    rememberThreadForkAttempt(stopped.state);
    expect(restoreThreadForkAttempt(boundary)).toBeNull();
    const running = attempt(begin(mintKey), failed("preparation-failed", "running"), mintKey);
    rememberThreadForkAttempt(running.state);
    expect(restoreThreadForkAttempt(boundary)).toBe(running.state);
    expect(
      restoreThreadForkAttempt({ ...boundary, sourceMessageId: MessageId.make("reply-2") }),
    ).toBeNull();
    forgetThreadForkAttempt(boundary);
    expect(restoreThreadForkAttempt(boundary)).toBeNull();
    const created = attempt(begin(mintKey), { status: "succeeded", result }, mintKey);
    rememberThreadForkAttempt(created.state);
    expect(restoreThreadForkAttempt(boundary)).toBe(created.state);
  });

  it("forgets a created fork only for the attempt that created it", () => {
    const mintKey = keys();
    const created = attempt(begin(mintKey), { status: "succeeded", result }, mintKey);
    const other = attempt(begin(mintKey), { status: "succeeded", result }, mintKey);
    rememberThreadForkAttempt(created.state);
    acknowledgeThreadForkAttempt(other.state);
    expect(restoreThreadForkAttempt(boundary)).toBe(created.state);
    acknowledgeThreadForkAttempt(created.state);
    expect(restoreThreadForkAttempt(boundary)).toBeNull();
  });

  it("records a send without an API as a refusal that keeps an unknown outcome", async () => {
    const mintKey = keys();
    const first = attempt(begin(mintKey), uncertain, mintKey);
    const submission = submitThreadForkAttempt({
      state: first.state,
      mintKey,
      api: {
        refusal: {
          status: "refused",
          awaiting: true,
          message: THREAD_FORK_COPY.connectionChanged,
          error: null,
        },
      },
    });
    if (!submission.ok) throw new Error("not submitted");
    const settled = await submission.settled;
    expect(settled).toMatchObject({
      phase: "uncertain",
      forkKey: first.state.forkKey,
      bound: first.state.bound,
      refusal: { awaiting: true, message: THREAD_FORK_COPY.connectionChanged },
    });
    expect(restoreThreadForkAttempt(boundary)).toBe(settled);
  });
});

describe("fork send readiness", () => {
  it("checks an attempt's first send against the reviewed connection, every later one against the live one", () => {
    const opened = vi.fn();
    const live = vi.fn();
    const capture = vi.fn(() => live);
    const mintKey = keys();
    const fresh = begin(mintKey);
    expect(threadForkSendReadiness(fresh, { opened, capture })).toBe(opened);
    expect(capture).not.toHaveBeenCalled();
    // After any send (here one whose answer was lost), the user's press is what is reviewed.
    const lost = attempt(fresh, uncertain, mintKey);
    expect(threadForkSendReadiness(lost.state, { opened, capture })).toBe(live);
    expect(capture).toHaveBeenCalledOnce();
    // So after a send refused before it went out.
    const notSent = attempt(fresh, refused, mintKey);
    expect(threadForkSendReadiness(notSent.state, { opened, capture })).toBe(live);
  });
});

describe("fork form alignment", () => {
  const destinations = (isGitRepo: boolean | null) =>
    listThreadForkDestinations({
      isChat: false,
      isGitRepo,
      chatsAvailable: true,
      sourceWorktreePath: "/repo/.worktrees/feature",
      sourceBranch: "feature",
    });
  const starts = (checkpointAvailable: boolean) =>
    listThreadForkWorktreeStarts({ checkpointAvailable });

  it("shows the first enabled option while the choice is unavailable", () => {
    const state = toNewWorktree(begin());
    // "New worktree" waits for a confirmed repository.
    expect(
      alignThreadForkSelection(state, {
        destinations: destinations(null),
        worktreeStarts: starts(true),
      }).selection.destination,
    ).toBe("current-checkout");
    expect(
      alignThreadForkSelection(state, {
        destinations: destinations(true),
        worktreeStarts: starts(false),
      }).selection,
    ).toMatchObject({ destination: "new-worktree", worktreeStart: "base-ref" });
  });

  it("returns the attempt itself when the form already reads as it is", () => {
    const state = toNewWorktree(begin());
    expect(
      alignThreadForkSelection(state, {
        destinations: destinations(true),
        worktreeStarts: starts(true),
      }),
    ).toBe(state);
  });

  it("shows a locked attempt as the request the node may hold", () => {
    const mintKey = keys();
    const first = attempt(
      updateThreadForkSelection(begin(mintKey), {
        destination: "new-worktree",
        worktreeStart: "base-ref",
        baseRef: " release ",
      }),
      uncertain,
      mintKey,
    );
    // Git status is loading again after a reopen: the locked request still shows as sent.
    const shown = alignThreadForkSelection(first.state, {
      destinations: destinations(null),
      worktreeStarts: starts(false),
    });
    expect(shown.selection).toEqual({
      destination: "new-worktree",
      worktreeStart: "base-ref",
      baseRef: "release",
    });
    expect(threadForkSelectionOfRequest(first.input)).toEqual(shown.selection);
    expect(submit(shown, mintKey).input).toEqual(first.input);
  });

  it("maps every request back onto the form it was built from", () => {
    const request = (destination: ThreadForkInput["destination"]): ThreadForkInput => ({
      forkKey: "fork-0000000000000001",
      sourceThreadId: boundary.sourceThreadId,
      sourceMessageId: boundary.sourceMessageId,
      destination,
    });
    expect(threadForkSelectionOfRequest(request({ kind: "new-chat" }))).toEqual({
      destination: "new-chat",
    });
    expect(
      threadForkSelectionOfRequest(
        request({ kind: "new-worktree", start: { kind: "checkpoint" } }),
      ),
    ).toEqual({ destination: "new-worktree", worktreeStart: "checkpoint" });
  });
});
