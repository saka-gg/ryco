import type { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { connect } from "node:net";
import { PassThrough } from "node:stream";
import type { CuaPreviewTarget } from "@ryco/shared/cuaDriverProtocol";
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("electron", () => ({}));
import {
  COMPUTER_FRAME_TAP_MAX_CONCURRENT,
  ComputerFrameTapPool,
  createFrameReader,
} from "./computerFrameTap.ts";

const frame = (bytes: number[]) => {
  const header = Buffer.alloc(4);
  header.writeUInt32LE(bytes.length);
  return Buffer.concat([header, Buffer.from(bytes)]);
};

it("splits whole, batched and fragmented frames", () => {
  const frames: number[][] = [];
  const malformed = vi.fn();
  const read = createFrameReader((jpeg) => frames.push([...jpeg]), malformed);
  read(Buffer.concat([frame([1, 2]), frame([3])]));
  const split = Buffer.concat([frame([4, 5, 6]), frame([7])]);
  // Byte by byte: the header itself arrives in pieces.
  for (let index = 0; index < split.length; index += 1) read(split.subarray(index, index + 1));
  expect(frames).toEqual([[1, 2], [3], [4, 5, 6], [7]]);
  expect(malformed).not.toHaveBeenCalled();
});

it("stops on a malformed length and forgets a partial frame on reset", () => {
  const frames: number[][] = [];
  const malformed = vi.fn();
  const read = createFrameReader((jpeg) => frames.push([...jpeg]), malformed);
  read(frame([1, 2, 3]).subarray(0, 5));
  read.reset();
  read(frame([9]));
  expect(frames).toEqual([[9]]);
  read(Buffer.alloc(4));
  expect(malformed).toHaveBeenCalledOnce();
  read(frame([8]));
  expect(frames).toEqual([[9]]);
});

class FakeHelper extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  exited = false;
  readonly args: readonly string[];
  constructor(args: readonly string[]) {
    super();
    this.args = args;
  }
  get windowId(): number {
    return Number(this.args[this.args.indexOf("--window-id") + 1]);
  }
  get socketPath(): string {
    return this.args[this.args.indexOf("--out") + 1]!;
  }
  kill(): boolean {
    if (!this.exited) {
      this.exited = true;
      setImmediate(() => {
        this.emit("exit", 0, null);
        this.emit("close", 0, null);
      });
    }
    return true;
  }
}

function poolFixture() {
  const helpers: FakeHelper[] = [];
  const frames: { threadId: string; windowId: number; seq: number }[] = [];
  const errors: { threadId: string; error: unknown }[] = [];
  const pool = new ComputerFrameTapPool({
    helperPath: "/fake/helper",
    spawn: ((_path: string, args: readonly string[]) => {
      const helper = new FakeHelper(args);
      helpers.push(helper);
      return helper;
    }) as unknown as typeof spawn,
    onFrame: (frame, target) =>
      frames.push({ threadId: target.task.threadId, windowId: frame.windowId, seq: frame.seq }),
    onError: (threadId, error) => errors.push({ threadId, error }),
  });
  const live = () => helpers.filter((helper) => !helper.exited);
  const liveWindows = () =>
    live()
      .map((helper) => helper.windowId)
      .toSorted((left, right) => left - right);
  return { pool, helpers, frames, errors, live, liveWindows };
}

const target = (threadId: string, windowId: number, turnId = "turn"): CuaPreviewTarget => ({
  task: { threadId, turnId },
  pid: 100,
  windowId,
});

async function sendFrame(helper: FakeHelper, bytes: number[]): Promise<void> {
  const socket = connect(helper.socketPath);
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  socket.end(frame(bytes));
}

describe("ComputerFrameTapPool", () => {
  let fixture: ReturnType<typeof poolFixture> | undefined;
  afterEach(async () => {
    await fixture?.pool.dispose();
    fixture = undefined;
  });

  it("runs one tap per visible thread on that thread's own window", async () => {
    fixture = poolFixture();
    const { pool, helpers, frames, liveWindows } = fixture;
    pool.setVisible("a", true);
    pool.setVisible("b", true);
    pool.setTarget(target("a", 1));
    pool.setTarget(target("b", 2));
    await vi.waitFor(() => expect(liveWindows()).toEqual([1, 2]));
    // A thread's new action retargets its own tap and leaves the other one alone.
    pool.setTarget(target("a", 3));
    await vi.waitFor(() => expect(liveWindows()).toEqual([2, 3]));
    expect(helpers).toHaveLength(3);
    await sendFrame(
      helpers.find((helper) => helper.windowId === 2)!,
      [1],
    );
    await sendFrame(
      helpers.find((helper) => helper.windowId === 3)!,
      [2],
    );
    await vi.waitFor(() => expect(frames).toHaveLength(2));
    expect(frames.map(({ threadId, windowId }) => [threadId, windowId]).toSorted()).toEqual([
      ["a", 3],
      ["b", 2],
    ]);
    expect(pool.frameAt("a")).toBeGreaterThan(0);
  });

  it("holds no tap for a hidden thread and starts one on its last target when shown", async () => {
    fixture = poolFixture();
    const { pool, helpers, liveWindows } = fixture;
    pool.setTarget(target("a", 1));
    pool.setTarget(target("a", 2));
    // No slot means no tap object exists that could spawn a helper later.
    expect(pool.activeThreads()).toEqual([]);
    expect(helpers).toHaveLength(0);
    pool.setVisible("a", true);
    await vi.waitFor(() => expect(liveWindows()).toEqual([2]));
    pool.setVisible("a", false);
    await vi.waitFor(() => expect(liveWindows()).toEqual([]));
    expect(pool.target("a")?.windowId).toBe(2);
  });

  it("evicts the least recently updated tap for a fifth visible thread", async () => {
    fixture = poolFixture();
    const { pool, live, liveWindows, errors } = fixture;
    for (const [index, threadId] of ["a", "b", "c", "d"].entries()) {
      pool.setVisible(threadId, true);
      pool.setTarget(target(threadId, index + 1));
    }
    await vi.waitFor(() => expect(liveWindows()).toEqual([1, 2, 3, 4]));
    pool.setTarget(target("a", 11)); // a is now the most recent; b is the least.
    await vi.waitFor(() => expect(liveWindows()).toEqual([2, 3, 4, 11]));
    pool.setVisible("e", true);
    pool.setTarget(target("e", 5));
    expect(live().length).toBeLessThanOrEqual(COMPUTER_FRAME_TAP_MAX_CONCURRENT);
    await vi.waitFor(() => expect(liveWindows()).toEqual([3, 4, 5, 11]));
    expect(pool.activeThreads().toSorted()).toEqual(["a", "c", "d", "e"]);
    // The evicted thread keeps acting on still frames without taking a tap back.
    pool.setTarget(target("b", 6));
    expect(pool.activeThreads().toSorted()).toEqual(["a", "c", "d", "e"]);
    // A freed slot goes back to it, on its latest window.
    pool.setVisible("c", false);
    await vi.waitFor(() => expect(liveWindows()).toEqual([4, 5, 6, 11]));
    expect(errors).toEqual([]);
  });

  it("ends one thread's task and leaves the other thread's tap running", async () => {
    fixture = poolFixture();
    const { pool, liveWindows } = fixture;
    pool.setVisible("a", true);
    pool.setVisible("b", true);
    pool.setTarget(target("a", 1));
    pool.setTarget(target("b", 2));
    await vi.waitFor(() => expect(liveWindows()).toEqual([1, 2]));
    await pool.endTask({ threadId: "a", turnId: "older-turn" });
    expect(liveWindows()).toEqual([1, 2]);
    await pool.endTask({ threadId: "a", turnId: "turn" });
    expect(liveWindows()).toEqual([2]);
    expect(pool.target("a")).toBeUndefined();
    expect(pool.target("b")?.windowId).toBe(2);
  });

  it("stops every tap on stopAll and dispose", async () => {
    fixture = poolFixture();
    const { pool, liveWindows } = fixture;
    pool.setVisible("a", true);
    pool.setVisible("b", true);
    pool.setTarget(target("a", 1));
    pool.setTarget(target("b", 2));
    await vi.waitFor(() => expect(liveWindows()).toEqual([1, 2]));
    await pool.stopAll();
    expect(liveWindows()).toEqual([]);
    expect(pool.target("a")).toBeUndefined();
    // Still visible: the next action starts a tap again.
    pool.setTarget(target("b", 3));
    await vi.waitFor(() => expect(liveWindows()).toEqual([3]));
    await pool.dispose();
    expect(liveWindows()).toEqual([]);
    pool.setTarget(target("b", 4));
    expect(pool.activeThreads()).toEqual([]);
    expect(pool.target("b")).toBeUndefined();
  });

  it("reports a tap failure only on its own thread and never respawns that target", async () => {
    fixture = poolFixture();
    const { pool, helpers, errors, liveWindows } = fixture;
    pool.setVisible("a", true);
    pool.setVisible("b", true);
    pool.setTarget(target("a", 1));
    pool.setTarget(target("b", 2));
    await vi.waitFor(() => expect(liveWindows()).toEqual([1, 2]));
    const failing = helpers.find((helper) => helper.windowId === 1)!;
    failing.stdout.write(`${JSON.stringify({ type: "error", code: "window_gone" })}\n`);
    await vi.waitFor(() => expect(errors).toHaveLength(1));
    expect(errors[0]?.threadId).toBe("a");
    failing.kill();
    await vi.waitFor(() => expect(liveWindows()).toEqual([2]));
    // A dead target is refused synchronously; the other thread's retarget is the milestone.
    pool.setTarget(target("a", 1));
    pool.setTarget(target("b", 7));
    await vi.waitFor(() => expect(liveWindows()).toEqual([7]));
    expect(
      helpers.map((helper) => helper.windowId).toSorted((left, right) => left - right),
    ).toEqual([1, 2, 7]);
  });
});
