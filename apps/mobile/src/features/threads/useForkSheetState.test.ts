import type { ThreadForkAttemptController } from "@ryco/client-runtime/state/threads";
import { EnvironmentId, MessageId, ThreadId, TurnId } from "@ryco/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { ForkSheetHandle } from "./forkDestinationModel";

// The hook called as a plain function across "renders" of one screen instance, with `useState`
// kept the way React keeps it (no React renderer exists in this suite).

const hooks = vi.hoisted(() => ({ state: undefined as unknown, initialized: false }));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useState: <T>(initial: T) => {
      if (!hooks.initialized) {
        hooks.state = initial;
        hooks.initialized = true;
      }
      const set = (next: T | ((current: T) => T)) => {
        hooks.state =
          typeof next === "function" ? (next as (current: T) => T)(hooks.state as T) : next;
      };
      return [hooks.state as T, set];
    },
  };
});

import { useForkSheetState } from "./useForkSheetState";

const environmentId = EnvironmentId.make("env-fork");
const threadA = ThreadId.make("thread-a");
const threadB = ThreadId.make("thread-b");

const sheetOnA: ForkSheetHandle = {
  request: {
    environmentId,
    sourceThreadId: threadA,
    sourceTitle: "A",
    messageId: MessageId.make("reply-a"),
    turnId: TurnId.make("turn-a"),
    excerpt: "",
  },
  controller: {} as ThreadForkAttemptController,
  visible: true,
};

beforeEach(() => {
  hooks.state = undefined;
  hooks.initialized = false;
});

describe("useForkSheetState", () => {
  it("never brings a sheet back after the screen was retargeted to another thread and back", () => {
    const [, setSheet] = useForkSheetState({ environmentId, threadId: threadA });
    setSheet(sheetOnA);
    expect(useForkSheetState({ environmentId, threadId: threadA })[0]).toBe(sheetOnA);

    // A deep link retargets this screen to B: A's sheet is not shown there...
    expect(useForkSheetState({ environmentId, threadId: threadB })[0]).toBeNull();
    // ...and coming back to A does not pop it open again on its own.
    expect(useForkSheetState({ environmentId, threadId: threadA })[0]).toBeNull();
  });

  it("keeps a sheet while the screen stays on its thread", () => {
    const [, setSheet] = useForkSheetState({ environmentId, threadId: threadA });
    setSheet(sheetOnA);
    setSheet((current) => (current ? { ...current, visible: false } : current));
    expect(useForkSheetState({ environmentId, threadId: threadA })[0]).toMatchObject({
      visible: false,
      request: sheetOnA.request,
    });
  });
});
