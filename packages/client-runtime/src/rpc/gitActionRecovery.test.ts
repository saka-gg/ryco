import {
  EnvironmentId,
  type GitActionProgressEvent,
  type GitActionRecoveryState,
  type GitRunStackedActionInput,
  type GitRunStackedActionResult,
} from "@ryco/contracts";
import { GitActionResultUnavailableError, GitCommandError } from "@ryco/contracts/git";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  GIT_ACTION_RESUME_HORIZON_MS,
  GIT_ACTION_RESUME_RETRY_MIN_MS,
  GitActionRecovery,
  type GitActionRecoveryAttachmentInput,
} from "./gitActionRecovery.ts";
import { RpcRequestRefusedError } from "./protocol.ts";
import { RpcTransportDisposedError } from "./wsTransport.ts";

const ENV = EnvironmentId.make("env-git-recovery");
const OTHER_ENV = EnvironmentId.make("env-git-recovery-other");
const ACTION_ID = "6f1c0d3e-8a5b-4c2d-9e7f-1a2b3c4d5e6f";

const input: GitRunStackedActionInput = {
  actionId: ACTION_ID,
  cwd: "/repo",
  action: "push",
};
const result = { action: "push", pushed: true } as unknown as GitRunStackedActionResult;

function event(kind: "action_started" | "phase_started" | "action_finished", label = "Pushing") {
  if (kind === "action_started") {
    return { actionId: ACTION_ID, cwd: "/repo", action: "push", kind, phases: ["push"] };
  }
  if (kind === "phase_started") {
    return { actionId: ACTION_ID, cwd: "/repo", action: "push", kind, phase: "push", label };
  }
  return { actionId: ACTION_ID, cwd: "/repo", action: "push", kind, result };
}

/** What a socket failure rejects a pending request with. */
const dropped = () => Object.assign(new Error("SocketCloseError"), { _tag: "RpcClientError" });

interface Call {
  readonly input: GitRunStackedActionInput;
  readonly emit: (progress: ReturnType<typeof event>) => void;
  readonly resolve: (value: GitRunStackedActionResult) => void;
  readonly reject: (error: unknown) => void;
}

function fakeConnection(
  options: {
    readonly environmentId?: EnvironmentId;
    readonly ready?: boolean;
    readonly supportsRecoverable?: boolean;
    readonly accountBound?: boolean;
  } = {},
) {
  let ready = options.ready ?? true;
  let current = true;
  const listeners = new Set<() => void>();
  const starts: Call[] = [];
  const resumes: Call[] = [];
  const record =
    (calls: Call[]) =>
    (
      callInput: GitRunStackedActionInput,
      callOptions?: { readonly onProgress?: (progress: GitActionProgressEvent) => void },
    ) =>
      new Promise<GitRunStackedActionResult>((resolve, reject) => {
        calls.push({
          input: callInput,
          emit: (progress) => callOptions?.onProgress?.(progress as GitActionProgressEvent),
          resolve,
          reject,
        });
      });
  const git = {
    runStackedAction: vi.fn(record(starts)),
    resumeStackedAction: vi.fn(record(resumes)),
  };
  const markUncertain = vi.fn<() => void>();
  const attachment: GitActionRecoveryAttachmentInput = {
    environmentId: options.environmentId ?? ENV,
    git,
    markUncertain,
    readiness: {
      read: () => ready,
      subscribe: (listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    },
    isCurrent: () => current,
    supportsRecoverable: () => options.supportsRecoverable ?? true,
    accountBound: options.accountBound ?? false,
  };
  return {
    git,
    starts,
    resumes,
    markUncertain,
    attachment,
    setReady: (next: boolean) => {
      ready = next;
      for (const listener of Array.from(listeners)) listener();
    },
    setCurrent: (next: boolean) => {
      current = next;
    },
    readinessListeners: () => listeners.size,
  };
}

function observe() {
  const states: GitActionRecoveryState[] = [];
  const progress: GitActionProgressEvent[] = [];
  return {
    states,
    progress,
    options: (recoverable = true) => ({
      ...(recoverable ? { recoverable: true } : {}),
      onRecoveryState: (state: GitActionRecoveryState) => states.push(state),
      onProgress: (next: GitActionProgressEvent) => progress.push(next),
    }),
    kinds: () => progress.map((next) => next.kind),
  };
}

/** Lets pending promise callbacks run. */
async function flush() {
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
}

let recovery: GitActionRecovery;

beforeEach(() => {
  vi.useFakeTimers();
  recovery = new GitActionRecovery();
});

afterEach(() => {
  recovery.resetForTests();
  vi.useRealTimers();
});

describe("GitActionRecovery", () => {
  it("sends recoverable only when the caller asks and the node supports it", async () => {
    const connection = fakeConnection();
    const { runStackedAction } = recovery.attach(connection.attachment);
    const seen = observe();

    const run = runStackedAction(input, seen.options());
    expect(connection.starts[0]!.input).toEqual({ ...input, recoverable: true });
    connection.starts[0]!.resolve(result);

    await expect(run).resolves.toBe(result);
    expect(seen.states).toEqual([{ kind: "started", recoverable: true }]);
  });

  it("keeps a run request-owned unless its caller asks, whatever the input says", async () => {
    const connection = fakeConnection();
    const { runStackedAction } = recovery.attach(connection.attachment);
    const seen = observe();

    const run = runStackedAction({ ...input, recoverable: true }, seen.options(false));
    expect(connection.starts[0]!.input).toEqual(input);
    connection.starts[0]!.emit(event("phase_started"));
    const failure = dropped();
    connection.starts[0]!.reject(failure);

    await expect(run).rejects.toBe(failure);
    expect(seen.states).toEqual([{ kind: "started", recoverable: false }]);
    expect(seen.kinds()).toEqual(["phase_started"]);
    expect(connection.git.resumeStackedAction).not.toHaveBeenCalled();
  });

  it("stays request-owned on a node without the capability, and a drop fails the run", async () => {
    const connection = fakeConnection({ supportsRecoverable: false });
    const { runStackedAction } = recovery.attach(connection.attachment);
    const seen = observe();

    const run = runStackedAction(input, seen.options());
    expect(connection.starts[0]!.input).toEqual(input);
    const failure = dropped();
    connection.starts[0]!.reject(failure);

    await expect(run).rejects.toBe(failure);
    expect(seen.states).toEqual([{ kind: "started", recoverable: false }]);
    expect(connection.git.resumeStackedAction).not.toHaveBeenCalled();
  });

  it("follows a dropped action again once its connection is ready, without running it twice", async () => {
    const connection = fakeConnection();
    const { runStackedAction } = recovery.attach(connection.attachment);
    const seen = observe();
    expect(connection.readinessListeners()).toBe(0);

    const run = runStackedAction(input, seen.options());
    connection.starts[0]!.emit(event("action_started"));
    connection.starts[0]!.emit(event("phase_started"));
    connection.setReady(false);
    connection.starts[0]!.reject(dropped());
    await flush();

    // Not ready: nothing is sent, and readiness is observed only while the action waits.
    expect(connection.git.resumeStackedAction).not.toHaveBeenCalled();
    expect(seen.states).toEqual([{ kind: "started", recoverable: true }, { kind: "reconnecting" }]);
    expect(connection.readinessListeners()).toBe(1);

    connection.setReady(true);
    await flush();
    expect(connection.git.resumeStackedAction).toHaveBeenCalledTimes(1);
    expect(connection.resumes[0]!.input).toEqual(input);
    expect(connection.readinessListeners()).toBe(0);
    connection.resumes[0]!.emit(event("action_started"));
    connection.resumes[0]!.emit(event("phase_started"));
    connection.resumes[0]!.emit(event("action_finished"));
    connection.resumes[0]!.resolve(result);

    await expect(run).resolves.toBe(result);
    expect(connection.git.runStackedAction).toHaveBeenCalledTimes(1);
    expect(seen.states).toEqual([
      { kind: "started", recoverable: true },
      { kind: "reconnecting" },
      { kind: "reattached" },
    ]);
    expect(seen.kinds()).toEqual([
      "action_started",
      "phase_started",
      "action_started",
      "phase_started",
      "action_finished",
    ]);
  });

  it("reports the node's missing receipt and an older node as unavailable", async () => {
    const connection = fakeConnection();
    const { runStackedAction } = recovery.attach(connection.attachment);

    const missing = new GitActionResultUnavailableError({ actionId: ACTION_ID, reason: "missing" });
    const first = runStackedAction(input, { recoverable: true });
    connection.starts[0]!.reject(dropped());
    await flush();
    connection.resumes[0]!.reject(missing);
    await expect(first).rejects.toBe(missing);

    const second = runStackedAction(input, { recoverable: true });
    connection.starts[1]!.reject(dropped());
    await flush();
    connection.resumes[1]!.reject(new Error("Unknown request tag: git.resumeStackedAction"));
    await expect(second).rejects.toMatchObject({
      _tag: "GitActionResultUnavailableError",
      actionId: ACTION_ID,
      reason: "unsupported",
    });
    expect(connection.git.runStackedAction).toHaveBeenCalledTimes(2);
  });

  it("rejects a definite start failure at once and never resumes it", async () => {
    const connection = fakeConnection();
    const { runStackedAction } = recovery.attach(connection.attachment);
    const failures = [
      new GitCommandError({
        operation: "push",
        command: "git push",
        cwd: "/repo",
        detail: "rejected",
      }),
      new RpcRequestRefusedError("awaiting-session"),
      new RpcTransportDisposedError(),
      { _tag: "GitManagerError", message: "A Git action is already running in this checkout." },
    ];
    for (const [index, failure] of failures.entries()) {
      const run = runStackedAction(input, { recoverable: true });
      connection.starts[index]!.reject(failure);
      await expect(run).rejects.toBe(failure);
    }
    await flush();
    expect(connection.git.resumeStackedAction).not.toHaveBeenCalled();
  });

  it("forwards nothing from a replaced generation and follows again on the new connection", async () => {
    const stale = fakeConnection();
    const staleAttachment = recovery.attach(stale.attachment);
    const seen = observe();

    const run = staleAttachment.runStackedAction(input, seen.options());
    stale.starts[0]!.emit(event("phase_started", "Committing"));
    // Superseded before it is disposed: its events no longer count.
    stale.setCurrent(false);
    stale.setReady(false);
    stale.starts[0]!.emit(event("phase_started", "Pushing"));
    staleAttachment.detach();
    stale.starts[0]!.reject(new Error("All fibers interrupted without error"));
    await flush();

    const fresh = fakeConnection({ ready: false });
    recovery.attach(fresh.attachment);
    await flush();
    expect(fresh.git.resumeStackedAction).not.toHaveBeenCalled();
    fresh.setReady(true);
    await flush();
    fresh.resumes[0]!.emit(event("action_finished"));
    fresh.resumes[0]!.resolve(result);

    await expect(run).resolves.toBe(result);
    expect(stale.git.resumeStackedAction).not.toHaveBeenCalled();
    expect(
      seen.progress.map((next) => (next.kind === "phase_started" ? next.label : next.kind)),
    ).toEqual(["Committing", "action_finished"]);
  });

  it("resumes on an older ready connection when a newer attempt comes and goes unready", async () => {
    const registered = fakeConnection();
    const { runStackedAction } = recovery.attach(registered.attachment);

    const run = runStackedAction(input, { recoverable: true });
    registered.setReady(false);
    registered.starts[0]!.reject(dropped());
    await flush();

    // An overlapping attempt attaches after it, never becomes ready and is discarded.
    const discarded = fakeConnection({ ready: false });
    const discardedAttachment = recovery.attach(discarded.attachment);
    registered.setReady(true);
    await flush();
    discardedAttachment.detach();

    expect(discarded.git.resumeStackedAction).not.toHaveBeenCalled();
    expect(registered.git.resumeStackedAction).toHaveBeenCalledTimes(1);
    registered.resumes[0]!.resolve(result);
    await expect(run).resolves.toBe(result);

    // The same when the discarded attempt goes before the older connection is ready.
    const again = runStackedAction(input, { recoverable: true });
    registered.setReady(false);
    registered.starts[1]!.reject(dropped());
    await flush();
    recovery.attach(fakeConnection({ ready: false }).attachment).detach();
    registered.setReady(true);
    await flush();
    expect(registered.git.resumeStackedAction).toHaveBeenCalledTimes(2);
    registered.resumes[1]!.resolve(result);
    await expect(again).resolves.toBe(result);
  });

  it("prefers the newest ready connection of the environment, never another environment's", async () => {
    const older = fakeConnection();
    const { runStackedAction } = recovery.attach(older.attachment);
    const newer = fakeConnection();
    recovery.attach(newer.attachment);
    const other = fakeConnection({ environmentId: OTHER_ENV });
    recovery.attach(other.attachment);

    const run = runStackedAction(input, { recoverable: true });
    older.starts[0]!.reject(dropped());
    await flush();

    expect(newer.git.resumeStackedAction).toHaveBeenCalledTimes(1);
    expect(older.git.resumeStackedAction).not.toHaveBeenCalled();
    expect(other.git.resumeStackedAction).not.toHaveBeenCalled();
    newer.resumes[0]!.resolve(result);
    await expect(run).resolves.toBe(result);
  });

  it("waits again after a refusal for now or a forbidden answer from a replaced connection", async () => {
    const first = fakeConnection();
    const firstAttachment = recovery.attach(first.attachment);
    const run = firstAttachment.runStackedAction(input, { recoverable: true });
    first.starts[0]!.reject(dropped());
    await flush();

    // Refused only for now: retried on the same connection after the retry delay.
    expect(first.git.resumeStackedAction).toHaveBeenCalledTimes(1);
    first.resumes[0]!.reject(new RpcRequestRefusedError("awaiting-session"));
    await flush();
    expect(first.git.resumeStackedAction).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(GIT_ACTION_RESUME_RETRY_MIN_MS);
    expect(first.git.resumeStackedAction).toHaveBeenCalledTimes(2);

    // The connection was replaced while the resume was in flight: its refusal is no answer.
    first.setCurrent(false);
    firstAttachment.detach();
    first.resumes[1]!.reject(new RpcRequestRefusedError("forbidden"));
    await flush();
    const second = fakeConnection();
    recovery.attach(second.attachment);
    await flush();
    expect(second.git.resumeStackedAction).toHaveBeenCalledTimes(1);
    second.resumes[0]!.resolve(result);
    await expect(run).resolves.toBe(result);
  });

  it("retries a ready connection that dropped the resume after a delay that grows", async () => {
    const connection = fakeConnection();
    const { runStackedAction } = recovery.attach(connection.attachment);
    const run = runStackedAction(input, { recoverable: true });
    connection.starts[0]!.reject(dropped());
    await flush();

    connection.resumes[0]!.reject(dropped());
    await flush();
    await vi.advanceTimersByTimeAsync(GIT_ACTION_RESUME_RETRY_MIN_MS - 1);
    expect(connection.git.resumeStackedAction).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(connection.git.resumeStackedAction).toHaveBeenCalledTimes(2);

    connection.resumes[1]!.reject(dropped());
    await flush();
    await vi.advanceTimersByTimeAsync(GIT_ACTION_RESUME_RETRY_MIN_MS);
    expect(connection.git.resumeStackedAction).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(GIT_ACTION_RESUME_RETRY_MIN_MS);
    expect(connection.git.resumeStackedAction).toHaveBeenCalledTimes(3);

    // A connection that went down and came back is a fresh attempt: no delay.
    connection.resumes[2]!.reject(dropped());
    await flush();
    connection.setReady(false);
    connection.setReady(true);
    await flush();
    expect(connection.git.resumeStackedAction).toHaveBeenCalledTimes(4);
    connection.resumes[3]!.resolve(result);
    await expect(run).resolves.toBe(result);
  });

  it("reports reconnecting again when a followed action drops a second time", async () => {
    const connection = fakeConnection();
    const { runStackedAction } = recovery.attach(connection.attachment);
    const seen = observe();
    const run = runStackedAction(input, seen.options());
    connection.starts[0]!.reject(dropped());
    await flush();
    connection.resumes[0]!.emit(event("phase_started"));
    connection.setReady(false);
    connection.resumes[0]!.reject(dropped());
    await flush();
    connection.setReady(true);
    await flush();
    connection.resumes[1]!.emit(event("action_finished"));
    connection.resumes[1]!.resolve(result);

    await expect(run).resolves.toBe(result);
    expect(seen.states.map((state) => state.kind)).toEqual([
      "started",
      "reconnecting",
      "reattached",
      "reconnecting",
      "reattached",
    ]);
  });

  it("rejects an unknown failure from a ready, current connection instead of looping", async () => {
    const connection = fakeConnection();
    const { runStackedAction } = recovery.attach(connection.attachment);
    const run = runStackedAction(input, { recoverable: true });
    connection.starts[0]!.reject(dropped());
    await flush();
    const defect = new Error("Unexpected response from the node");
    connection.resumes[0]!.reject(defect);

    await expect(run).rejects.toBe(defect);
    await vi.advanceTimersByTimeAsync(GIT_ACTION_RESUME_RETRY_MIN_MS * 4);
    expect(connection.git.resumeStackedAction).toHaveBeenCalledTimes(1);
  });

  it("gives up as expired when nothing is ready within the horizon", async () => {
    const connection = fakeConnection();
    const attached = recovery.attach(connection.attachment);
    const run = attached.runStackedAction(input, { recoverable: true });
    connection.setReady(false);
    connection.starts[0]!.reject(dropped());
    const outcome = expect(run).rejects.toMatchObject({
      _tag: "GitActionResultUnavailableError",
      reason: "expired",
    });
    await vi.advanceTimersByTimeAsync(GIT_ACTION_RESUME_HORIZON_MS - 1);
    // A new connection gives the action another horizon.
    const late = fakeConnection({ ready: false });
    recovery.attach(late.attachment);
    await vi.advanceTimersByTimeAsync(GIT_ACTION_RESUME_HORIZON_MS - 1);
    await flush();
    expect(connection.git.resumeStackedAction).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await outcome;
    expect(late.git.resumeStackedAction).not.toHaveBeenCalled();
    expect(connection.readinessListeners()).toBe(0);
    expect(late.readinessListeners()).toBe(0);
  });

  it("ends waiting hosted actions with the account session and leaves direct ones waiting", async () => {
    const hosted = fakeConnection({ accountBound: true });
    const direct = fakeConnection({ environmentId: OTHER_ENV });
    const hostedRun = recovery
      .attach(hosted.attachment)
      .runStackedAction(input, { recoverable: true });
    const directRun = recovery
      .attach(direct.attachment)
      .runStackedAction(input, { recoverable: true });
    hosted.setReady(false);
    direct.setReady(false);
    hosted.starts[0]!.reject(dropped());
    direct.starts[0]!.reject(dropped());
    await flush();

    recovery.endAccountSession();
    await expect(hostedRun).rejects.toMatchObject({
      _tag: "GitActionResultUnavailableError",
      reason: "ended",
    });
    direct.setReady(true);
    await flush();
    direct.resumes[0]!.resolve(result);
    await expect(directRun).resolves.toBe(result);
    expect(hosted.git.resumeStackedAction).not.toHaveBeenCalled();
  });

  it("makes delivery unknown for a request-owned action lost with its connection only", async () => {
    const connection = fakeConnection();
    const { runStackedAction } = recovery.attach(connection.attachment);

    // A recoverable start the relay dropped is followed again: its outcome is the resume's.
    const followed = runStackedAction(input, { recoverable: true });
    connection.starts[0]!.reject(dropped());
    await flush();
    connection.resumes[0]!.resolve(result);
    await expect(followed).resolves.toBe(result);
    expect(connection.markUncertain).not.toHaveBeenCalled();

    // Nothing follows a request-owned one again.
    const owned = runStackedAction(input);
    const failure = dropped();
    connection.starts[1]!.reject(failure);
    await expect(owned).rejects.toBe(failure);
    expect(connection.markUncertain).toHaveBeenCalledOnce();
  });

  it("leaves delivery alone when a request-owned action's failure is its outcome", async () => {
    const connection = fakeConnection();
    const { runStackedAction } = recovery.attach(connection.attachment);
    const outcomes = [
      new GitCommandError({
        operation: "push",
        command: "git push",
        cwd: "/repo",
        detail: "rejected",
      }),
      new RpcRequestRefusedError("awaiting-session"),
      new RpcTransportDisposedError(),
      // The node interrupted it on a live connection, on its way down.
      new Error("All fibers interrupted without error"),
    ];
    for (const [index, outcome] of outcomes.entries()) {
      const run = runStackedAction(input);
      connection.starts[index]!.reject(outcome);
      await expect(run).rejects.toBe(outcome);
    }
    expect(connection.markUncertain).not.toHaveBeenCalled();
  });

  it("makes delivery unknown for a request-owned action its connection's teardown interrupted", async () => {
    const interrupted = () => new Error("All fibers interrupted without error");
    // Suspension replaces the connection's generation before it disposes the client.
    const replaced = fakeConnection();
    const replacedRun = recovery.attach(replaced.attachment).runStackedAction(input);
    replaced.setCurrent(false);
    replaced.starts[0]!.reject(interrupted());
    await expect(replacedRun).rejects.toThrow("interrupted");
    expect(replaced.markUncertain).toHaveBeenCalledOnce();

    const disposed = fakeConnection();
    const attached = recovery.attach(disposed.attachment);
    const disposedRun = attached.runStackedAction(input);
    attached.detach();
    disposed.starts[0]!.reject(interrupted());
    await expect(disposedRun).rejects.toThrow("interrupted");
    expect(disposed.markUncertain).toHaveBeenCalledOnce();
  });

  it("holds nothing for a request-owned action of an account session that ended", async () => {
    const connection = fakeConnection({ accountBound: true });
    const run = recovery.attach(connection.attachment).runStackedAction(input);
    // Signing out ends the account session before it disposes the connections.
    recovery.endAccountSession();
    const failure = dropped();
    connection.starts[0]!.reject(failure);
    await expect(run).rejects.toBe(failure);
    expect(connection.markUncertain).not.toHaveBeenCalled();
  });
});
