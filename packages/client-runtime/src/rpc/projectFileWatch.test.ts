import type { ProjectFileChangeEvent } from "@ryco/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  PROJECT_FILE_WATCH_INITIAL_RETRY_MS,
  PROJECT_FILE_WATCH_MAX_RETRY_ATTEMPTS,
  PROJECT_FILE_WATCH_MAX_RETRY_MS,
  type ProjectFileChangeSubscribe,
  watchProjectFile,
} from "./projectFileWatch.ts";

type Options = Parameters<ProjectFileChangeSubscribe>[2];

/** A connection's subscribe: records each subscription and lets the test drive it. */
function fakeConnection() {
  const subscriptions: Array<{
    readonly input: { readonly cwd: string; readonly relativePath: string };
    readonly emit: (event: ProjectFileChangeEvent) => void;
    readonly fail: (error: unknown) => void;
    readonly stop: ReturnType<typeof vi.fn>;
  }> = [];
  const subscribe: ProjectFileChangeSubscribe = (input, listener, options?: Options) => {
    const stop = vi.fn();
    subscriptions.push({
      input,
      emit: listener,
      // What the transport does with a failure no reconnect can fix.
      fail: (error) => {
        options?.classifyFailure?.(error);
        options?.onError?.();
      },
      stop,
    });
    return stop;
  };
  return { subscribe, subscriptions };
}

const watchFailure = (reason: string) => ({
  _tag: "ProjectWatchFileError",
  reason,
  message: "The file's folder cannot be watched now.",
});

const input = { cwd: "/repo", relativePath: "src/app.ts" };
const current: ProjectFileChangeEvent = { type: "current", version: "sha256:a" };

afterEach(() => {
  vi.useRealTimers();
});

describe("watchProjectFile", () => {
  it("shares one subscription per file and connection, and closes it with its last listener", async () => {
    const connection = fakeConnection();
    const first = vi.fn();
    const second = vi.fn();
    const stopFirst = watchProjectFile(connection.subscribe, input, first);
    connection.subscriptions[0]?.emit(current);
    const stopSecond = watchProjectFile(connection.subscribe, input, second);

    expect(connection.subscriptions).toHaveLength(1);
    expect(first).toHaveBeenCalledWith(current);
    // A listener that joins later learns the file's state at once.
    await Promise.resolve();
    expect(second).toHaveBeenCalledWith(current);

    const changed: ProjectFileChangeEvent = { type: "changed", version: "sha256:b" };
    connection.subscriptions[0]?.emit(changed);
    expect(first).toHaveBeenLastCalledWith(changed);
    expect(second).toHaveBeenLastCalledWith(changed);

    stopFirst();
    expect(connection.subscriptions[0]?.stop).not.toHaveBeenCalled();
    stopSecond();
    expect(connection.subscriptions[0]?.stop).toHaveBeenCalledOnce();

    // The next listener starts a fresh subscription.
    watchProjectFile(connection.subscribe, input, vi.fn());
    expect(connection.subscriptions).toHaveLength(2);
  });

  it("keeps other files and other connections apart", () => {
    const connection = fakeConnection();
    const other = fakeConnection();
    watchProjectFile(connection.subscribe, input, vi.fn());
    watchProjectFile(connection.subscribe, { ...input, relativePath: "src/other.ts" }, vi.fn());
    watchProjectFile(connection.subscribe, { ...input, cwd: "/repo-worktree" }, vi.fn());
    watchProjectFile(other.subscribe, input, vi.fn());

    expect(connection.subscriptions.map((subscription) => subscription.input)).toEqual([
      input,
      { ...input, relativePath: "src/other.ts" },
      { ...input, cwd: "/repo-worktree" },
    ]);
    expect(other.subscriptions).toHaveLength(1);
  });

  it("tries an unavailable watch again with backoff, and an event resets the attempts", async () => {
    vi.useFakeTimers();
    const connection = fakeConnection();
    const listener = vi.fn();
    watchProjectFile(connection.subscribe, input, listener);

    const delays: number[] = [];
    for (let attempt = 0; attempt < PROJECT_FILE_WATCH_MAX_RETRY_ATTEMPTS; attempt += 1) {
      const before = connection.subscriptions.length;
      connection.subscriptions.at(-1)?.fail(watchFailure("unavailable"));
      const startedAt = Date.now();
      await vi.advanceTimersToNextTimerAsync();
      expect(connection.subscriptions).toHaveLength(before + 1);
      delays.push(Date.now() - startedAt);
    }
    expect(delays).toEqual([
      PROJECT_FILE_WATCH_INITIAL_RETRY_MS,
      PROJECT_FILE_WATCH_INITIAL_RETRY_MS * 2,
      PROJECT_FILE_WATCH_INITIAL_RETRY_MS * 4,
      PROJECT_FILE_WATCH_MAX_RETRY_MS / 2,
      PROJECT_FILE_WATCH_MAX_RETRY_MS,
    ]);

    // Out of attempts: no more tries.
    connection.subscriptions.at(-1)?.fail(watchFailure("unavailable"));
    await vi.advanceTimersByTimeAsync(PROJECT_FILE_WATCH_MAX_RETRY_MS * 4);
    expect(connection.subscriptions).toHaveLength(PROJECT_FILE_WATCH_MAX_RETRY_ATTEMPTS + 1);
  });

  it("starts the attempts over once the node reports the file again", async () => {
    vi.useFakeTimers();
    const connection = fakeConnection();
    watchProjectFile(connection.subscribe, input, vi.fn());
    for (let attempt = 0; attempt < PROJECT_FILE_WATCH_MAX_RETRY_ATTEMPTS - 1; attempt += 1) {
      connection.subscriptions.at(-1)?.fail(watchFailure("unavailable"));
      await vi.advanceTimersToNextTimerAsync();
    }
    connection.subscriptions.at(-1)?.emit(current);
    const before = connection.subscriptions.length;
    connection.subscriptions.at(-1)?.fail(watchFailure("unavailable"));

    await vi.advanceTimersByTimeAsync(PROJECT_FILE_WATCH_INITIAL_RETRY_MS);
    expect(connection.subscriptions).toHaveLength(before + 1);
  });

  it.each(["outside-root", "limit"])("does not try a %s watch again", async (reason) => {
    vi.useFakeTimers();
    const connection = fakeConnection();
    watchProjectFile(connection.subscribe, input, vi.fn());
    connection.subscriptions[0]?.fail(watchFailure(reason));
    // Nor an error that is not the watch's own (a role the node refused).
    watchProjectFile(connection.subscribe, { ...input, relativePath: "b.ts" }, vi.fn());
    connection.subscriptions[1]?.fail({ _tag: "AuthRpcError", message: "Not allowed." });

    await vi.advanceTimersByTimeAsync(PROJECT_FILE_WATCH_MAX_RETRY_MS * 4);
    expect(connection.subscriptions).toHaveLength(2);
  });

  it("drops a pending try when its last listener leaves", async () => {
    vi.useFakeTimers();
    const connection = fakeConnection();
    const stop = watchProjectFile(connection.subscribe, input, vi.fn());
    connection.subscriptions[0]?.fail(watchFailure("unavailable"));
    stop();

    await vi.advanceTimersByTimeAsync(PROJECT_FILE_WATCH_MAX_RETRY_MS * 4);
    expect(connection.subscriptions).toHaveLength(1);
  });
});
