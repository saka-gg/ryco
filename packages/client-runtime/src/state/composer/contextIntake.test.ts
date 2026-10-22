import { EnvironmentId, ThreadId } from "@ryco/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { createComposerContextIntake, type ComposerContextItem } from "./contextIntake.ts";
import { createFileReference } from "./fileReference.ts";

const thread = { environmentId: EnvironmentId.make("env-1"), threadId: ThreadId.make("thread-1") };
const otherThread = { ...thread, threadId: ThreadId.make("thread-2") };
const reference = createFileReference({ path: "a.ts", lineStart: 1, lineEnd: 1, lines: ["x"] });
if (!reference) throw new Error("Expected a file reference.");
const item: ComposerContextItem = { kind: "file-reference", reference };

describe("createComposerContextIntake", () => {
  it("delivers to the thread's registered composer only", () => {
    const intake = createComposerContextIntake();
    expect(intake.canDeliver(thread)).toBe(false);
    expect(intake.deliver(thread, item)).toBe(false);

    const receiver = vi.fn(() => true);
    const release = intake.register(thread, receiver);
    expect(intake.canDeliver(thread)).toBe(true);
    expect(intake.canDeliver(otherThread)).toBe(false);
    expect(intake.deliver(thread, item)).toBe(true);
    expect(receiver).toHaveBeenCalledWith(item);
    expect(intake.deliver(otherThread, item)).toBe(false);

    release();
    expect(intake.canDeliver(thread)).toBe(false);
    expect(intake.deliver(thread, item)).toBe(false);
    expect(receiver).toHaveBeenCalledTimes(1);
  });

  it("passes on a receiver's refusal", () => {
    const intake = createComposerContextIntake();
    intake.register(thread, () => false);
    expect(intake.deliver(thread, item)).toBe(false);
  });

  it("lets the latest registration take over and hands back on release", () => {
    const intake = createComposerContextIntake();
    const first = vi.fn(() => true);
    const second = vi.fn(() => true);
    const releaseFirst = intake.register(thread, first);
    const releaseSecond = intake.register(thread, second);
    intake.deliver(thread, item);
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();

    releaseSecond();
    releaseSecond();
    intake.deliver(thread, item);
    expect(first).toHaveBeenCalledTimes(1);
    releaseFirst();
    expect(intake.canDeliver(thread)).toBe(false);
  });

  it("notifies subscribers on register and release", () => {
    const intake = createComposerContextIntake();
    const listener = vi.fn();
    const unsubscribe = intake.subscribe(listener);
    const release = intake.register(thread, () => true);
    release();
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
    intake.register(thread, () => true);
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
