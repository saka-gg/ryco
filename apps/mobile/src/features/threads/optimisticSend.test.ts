import type { EnvironmentId, MessageId, ThreadId } from "@ryco/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("expo-crypto", () => ({
  randomUUID: () => "00000000-0000-4000-8000-000000000000",
  getRandomBytes: (length: number) => new Uint8Array(length),
}));
vi.mock("expo-sqlite/kv-store", () => ({
  default: {
    getItem: async () => null,
    setItem: async () => undefined,
    removeItem: async () => undefined,
  },
}));

import {
  resetOptimisticUserMessagesForTests,
  useOptimisticUserMessagesStore,
} from "../../state/optimisticUserMessages";
import { startOptimisticDispatch, type OptimisticDispatchInput } from "./optimisticSend";

const REF = { environmentId: "env" as EnvironmentId, threadId: "thread" as ThreadId };
const KEY = "env:thread";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function input(overrides: Partial<OptimisticDispatchInput> = {}): OptimisticDispatchInput {
  return {
    threadRef: REF,
    messageId: "m1" as MessageId,
    createdAt: "2026-11-10T10:00:00.000Z",
    outgoingText: "hello",
    prompt: "hello",
    attachments: [],
    beginForegroundDispatch: () => ({ onBeforeTurnStart: vi.fn(), end: vi.fn() }),
    dispatch: async () => true,
    onFailed: vi.fn(),
    ...overrides,
  };
}

const entries = () => useOptimisticUserMessagesStore.getState().byThreadKey[KEY] ?? [];

beforeEach(() => resetOptimisticUserMessagesForTests());

describe("startOptimisticDispatch", () => {
  it("shows the message before the dispatch answers, then waits for the echo", async () => {
    const answer = deferred<boolean>();
    const end = vi.fn();
    const onSettled = vi.fn();
    const done = startOptimisticDispatch(
      input({
        beginForegroundDispatch: () => ({ onBeforeTurnStart: vi.fn(), end }),
        dispatch: () => answer.promise,
        onSettled,
      }),
    );
    expect(entries().map((entry) => [entry.message.id, entry.phase])).toEqual([["m1", "sending"]]);
    expect(end).not.toHaveBeenCalled();
    answer.resolve(true);
    await expect(done).resolves.toBe(true);
    expect(end).toHaveBeenCalledWith(true);
    expect(onSettled).toHaveBeenCalledWith(true);
    expect(entries().map((entry) => entry.phase)).toEqual(["dispatched"]);
  });

  it("hands the draft back with the reported error when the dispatch fails", async () => {
    const onFailed = vi.fn();
    const end = vi.fn();
    await expect(
      startOptimisticDispatch(
        input({
          prompt: "draft text",
          beginForegroundDispatch: () => ({ onBeforeTurnStart: vi.fn(), end }),
          dispatch: async ({ reportError }) => {
            reportError("Node refused");
            return false;
          },
          onFailed,
        }),
      ),
    ).resolves.toBe(false);
    expect(end).toHaveBeenCalledWith(false);
    expect(onFailed).toHaveBeenCalledTimes(1);
    expect(onFailed.mock.calls[0]![0].draft.prompt).toBe("draft text");
    expect(onFailed.mock.calls[0]![1]).toBe("Node refused");
  });

  it("treats a thrown dispatch as a failure", async () => {
    const onFailed = vi.fn();
    await startOptimisticDispatch(
      input({
        dispatch: async () => {
          throw new Error("socket closed");
        },
        onFailed,
      }),
    );
    expect(onFailed.mock.calls[0]![1]).toBe("socket closed");
  });

  it("passes the turn-start hook through to the outbox", async () => {
    const onBeforeTurnStart = vi.fn();
    await startOptimisticDispatch(
      input({
        beginForegroundDispatch: () => ({ onBeforeTurnStart, end: vi.fn() }),
        dispatch: async (hooks) => {
          hooks.onBeforeTurnStart();
          return true;
        },
      }),
    );
    expect(onBeforeTurnStart).toHaveBeenCalledTimes(1);
  });
});
