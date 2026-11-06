// Adapted from Synara v0.9.1; see docs/licenses/synara-computer-use.txt.
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface, type Interface } from "node:readline";
import {
  cuaComputerTaskKey,
  type CuaComputerTask,
  type CuaPreviewTarget,
} from "@ryco/shared/cuaDriverProtocol";

import { stopNativeHelper } from "./stopNativeHelper.ts";

/** Channel carrying live JPEG frames to the renderer: {windowId, seq, jpeg}. */
export const COMPUTER_PREVIEW_FRAME_CHANNEL = "desktop:computer:preview-frame";

const FRAME_TAP_MAX_FRAME_BYTES = 4 * 1024 * 1024;
const MAX_DEAD_TARGETS = 256;

export interface ComputerPreviewFrame {
  task: CuaComputerTask;
  targetKey: string;
  windowId: number;
  seq: number;
  jpeg: Uint8Array;
}

export interface ComputerFrameTapHost {
  update(target: CuaPreviewTarget): void;
  endTask(task: CuaComputerTask): Promise<void>;
  stop(): Promise<void>;
  dispose(): Promise<void>;
}

interface ActiveTap {
  child: ChildProcess;
  server: Server;
  socketPath: string;
  lines: Interface;
  connection: Socket | undefined;
  task: CuaComputerTask;
  key: string;
  windowId: number;
  exited: boolean;
  retiring: boolean;
}

function tapTargetKey(target: CuaPreviewTarget): string {
  return `${cuaComputerTaskKey(target.task)}:${target.pid}:${target.windowId}`;
}

/** Whether ending `ended` covers `candidate`; without a turnId it covers every turn of the thread. */
function taskEndCovers(ended: CuaComputerTask, candidate: CuaComputerTask): boolean {
  return (
    candidate.threadId === ended.threadId &&
    (ended.turnId === undefined || candidate.turnId === ended.turnId)
  );
}

/** The task formally ended; its failure memory ends with it. */
function forgetDeadTargets(deadTargets: Set<string>, task: CuaComputerTask): void {
  const deadPrefix =
    task.turnId === undefined
      ? `[${JSON.stringify(task.threadId)},`
      : `${cuaComputerTaskKey(task)}:`;
  for (const key of deadTargets) {
    if (key.startsWith(deadPrefix)) deadTargets.delete(key);
  }
}

/** A private (0700) directory for tap sockets, created on first use. */
class FrameSocketDirectory {
  private directory: string | undefined;
  private pending: Promise<string> | undefined;

  get(): Promise<string> {
    if (this.directory) return Promise.resolve(this.directory);
    if (!this.pending) {
      const pending = (async () => {
        const directory = await mkdtemp(join(tmpdir(), "synara-frames-"));
        await chmod(directory, 0o700);
        this.directory = directory;
        return directory;
      })();
      this.pending = pending;
      pending.catch(() => {
        if (this.pending === pending) this.pending = undefined;
      });
    }
    return this.pending;
  }

  async remove(): Promise<void> {
    const directory = this.directory;
    this.directory = undefined;
    this.pending = undefined;
    if (directory) await rm(directory, { recursive: true, force: true });
  }
}

interface ComputerFrameTapOptions {
  helperPath: string;
  send: (channel: string, frame: ComputerPreviewFrame) => void;
  onError: (error: unknown) => void;
  spawn?: typeof spawn;
  /** Shared by a pool's taps; a tap given one never removes it. */
  socketDirectory?: FrameSocketDirectory;
  /** Shared by a pool's taps so dead-target memory outlives one thread's tap. */
  deadTargets?: Set<string>;
}

/**
 * Splits the tap socket's byte stream into length-prefixed (u32 LE) JPEG
 * frames. Chunks wait unjoined until their frame is complete, so a frame
 * split across many socket reads is copied once, not once per read (Synara
 * #2021). A zero or oversized length is malformed and stops the reader.
 */
export function createFrameReader(
  onFrame: (jpeg: Buffer) => void,
  onMalformed: () => void,
): ((chunk: Buffer) => void) & { reset(): void } {
  let chunks: Buffer[] = [];
  let buffered = 0;
  let stopped = false;
  const reset = () => {
    chunks = [];
    buffered = 0;
  };
  const read = (chunk: Buffer) => {
    if (stopped) return;
    chunks.push(chunk);
    buffered += chunk.length;
    for (;;) {
      if (buffered < 4) return;
      if (chunks[0]!.length < 4) chunks = [Buffer.concat(chunks, buffered)];
      const length = chunks[0]!.readUInt32LE(0);
      if (length === 0 || length > FRAME_TAP_MAX_FRAME_BYTES) {
        stopped = true;
        reset();
        onMalformed();
        return;
      }
      if (buffered < 4 + length) return;
      const joined = chunks.length === 1 ? chunks[0]! : Buffer.concat(chunks, buffered);
      const rest = joined.subarray(4 + length);
      chunks = rest.length > 0 ? [rest] : [];
      buffered = rest.length;
      onFrame(joined.subarray(4, 4 + length));
    }
  };
  return Object.assign(read, { reset });
}

/**
 * One task, one target, one helper process. Frames travel helper -> unix
 * socket -> renderer; they never enter the driver request path or its
 * operation queue. A dead tap stays dead for its target: update() for the
 * same key never respawns it.
 */
export class ComputerFrameTap implements ComputerFrameTapHost {
  private desired: CuaPreviewTarget | undefined;
  private active: ActiveTap | undefined;
  private reconciling: Promise<void> | undefined;
  private failure: unknown;
  private revision = 0;
  private appliedRevision = -1;
  private sequence = 0;
  private readonly directory: FrameSocketDirectory;
  private readonly ownsDirectory: boolean;
  private readonly deadTargets: Set<string>;

  private readonly options: ComputerFrameTapOptions;
  constructor(options: ComputerFrameTapOptions) {
    this.options = options;
    this.ownsDirectory = !options.socketDirectory;
    this.directory = options.socketDirectory ?? new FrameSocketDirectory();
    this.deadTargets = options.deadTargets ?? new Set<string>();
  }

  update(target: CuaPreviewTarget): void {
    if (this.deadTargets.has(tapTargetKey(target))) return;
    this.desired = target;
    this.revision += 1;
    void this.reconcile().catch(this.options.onError);
  }

  async endTask(task: CuaComputerTask): Promise<void> {
    const matches = (candidate: CuaComputerTask) => taskEndCovers(task, candidate);
    if (this.desired && !matches(this.desired.task)) return;
    if (!this.desired && this.active && !matches(this.active.task)) return;
    forgetDeadTargets(this.deadTargets, task);
    await this.stop();
  }

  async stop(): Promise<void> {
    this.desired = undefined;
    this.revision += 1;
    await this.reconcile();
  }

  async dispose(): Promise<void> {
    await this.stop();
    if (this.ownsDirectory) await this.directory.remove();
  }

  private reconcile(): Promise<void> {
    if (this.reconciling) return this.reconciling;
    const work = Promise.resolve().then(() => this.run());
    const tracked = work.finally(() => {
      if (this.reconciling === tracked) this.reconciling = undefined;
      if (!this.failure && this.appliedRevision !== this.revision) return this.reconcile();
    });
    this.reconciling = tracked;
    return tracked;
  }

  private async run(): Promise<void> {
    for (;;) {
      const current = this.active;
      const target = this.desired;
      if (current && (!target || current.exited || current.key !== tapTargetKey(target))) {
        try {
          await this.retire(current);
          if (this.active === current) this.active = undefined;
          this.failure = undefined;
        } catch (error) {
          this.failure = error;
          throw error;
        }
        continue;
      }
      if (!target) {
        this.failure = undefined;
        this.appliedRevision = this.revision;
        return;
      }
      if (this.failure) throw this.failure;
      if (!current) {
        try {
          this.active = await this.start(target);
        } catch (error) {
          this.failure = error;
          throw error;
        }
      }
      if (target === this.desired) {
        this.appliedRevision = this.revision;
        return;
      }
    }
  }

  private async start(target: CuaPreviewTarget): Promise<ActiveTap> {
    const directory = await this.directory.get();
    const socketPath = join(directory, `tap-${randomUUID().slice(0, 8)}.sock`);
    let state: ActiveTap | undefined;
    const server = createServer((socket) => {
      if (state) this.attach(state, socket);
      else socket.destroy();
    });
    server.on("error", (error) => {
      if (state) this.kill(state, error);
      else this.options.onError(error);
    });
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(socketPath, resolve);
      });
      await chmod(socketPath, 0o600);
    } catch (error) {
      server.close(() => undefined);
      await rm(socketPath, { force: true }).catch(() => undefined);
      throw error;
    }
    const child = (this.options.spawn ?? spawn)(
      this.options.helperPath,
      [
        "--computer-frames",
        "--window-id",
        String(target.windowId),
        "--pid",
        String(target.pid),
        "--out",
        socketPath,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    if (!child.stdout) {
      server.close(() => undefined);
      await rm(socketPath, { force: true }).catch(() => undefined);
      throw new Error("Computer frame tap helper has no output channel.");
    }
    const lines = createInterface({ input: child.stdout });
    state = {
      child,
      server,
      socketPath,
      lines,
      connection: undefined,
      task: target.task,
      key: tapTargetKey(target),
      windowId: target.windowId,
      exited: false,
      retiring: false,
    };
    const tap = state;
    child.on("error", (error) => this.kill(tap, error));
    // Helper exit ends the tap no matter the cause: the protocol has no
    // graceful-stop event, so every exit is terminal for this target.
    child.once("exit", () => this.kill(tap, undefined));
    child.once("close", () => lines.close());
    child.stderr?.resume();
    lines.on("line", (line) => this.helperLine(tap, line));
    // Claim the slot before returning: a helper connect racing the caller's
    // own assignment would otherwise be rejected as an unknown peer.
    this.active = tap;
    return tap;
  }

  private attach(state: ActiveTap, socket: Socket): void {
    if (state.connection || state.retiring || this.active !== state) {
      socket.destroy();
      return;
    }
    state.connection = socket;
    socket.on("error", () => undefined);
    const read = createFrameReader(
      (jpeg) => this.deliver(state, jpeg),
      () => this.kill(state, new Error("Computer frame tap sent a malformed frame.")),
    );
    socket.on("data", read);
    socket.once("close", () => {
      read.reset();
      if (state.connection === socket) state.connection = undefined;
    });
  }

  private deliver(state: ActiveTap, jpeg: Uint8Array): void {
    if (this.active !== state || state.retiring || state.exited) return;
    this.sequence += 1;
    try {
      this.options.send(COMPUTER_PREVIEW_FRAME_CHANNEL, {
        task: state.task,
        targetKey: state.key,
        windowId: state.windowId,
        seq: this.sequence,
        jpeg,
      });
    } catch (error) {
      this.options.onError(error);
    }
  }

  private helperLine(state: ActiveTap, line: string): void {
    if (line.length > 4096 || this.active !== state) return;
    try {
      const message = JSON.parse(line) as { type?: string; code?: string };
      if (message.type === "error") {
        this.kill(state, new Error(`Computer frame tap: ${message.code ?? "capture failed"}`));
      }
    } catch {
      /* Only protocol lines emitted by the owned helper are consumed. */
    }
  }

  /** Unexpected helper death poisons only this target; retire() kills are exempt. */
  private kill(state: ActiveTap, error: unknown): void {
    const wasExited = state.exited;
    state.exited = true;
    if (error !== undefined) this.options.onError(error);
    if (this.active !== state || state.retiring || wasExited) return;
    this.rememberDead(state.key);
    if (this.desired && tapTargetKey(this.desired) === state.key) {
      this.desired = undefined;
      this.revision += 1;
    }
    void this.reconcile().catch(this.options.onError);
  }

  private rememberDead(key: string): void {
    this.deadTargets.add(key);
    while (this.deadTargets.size > MAX_DEAD_TARGETS)
      this.deadTargets.delete(this.deadTargets.values().next().value!);
  }

  private async retire(state: ActiveTap): Promise<void> {
    state.retiring = true;
    state.connection?.destroy();
    state.connection = undefined;
    try {
      await stopNativeHelper(state.child, () => state.exited);
    } finally {
      state.lines.close();
      if (state.server.listening) {
        await new Promise<void>((resolve) => state.server.close(() => resolve()));
      }
      await rm(state.socketPath, { force: true });
    }
  }
}

/** At most this many live frame-tap helper processes run at once, across all threads. */
export const COMPUTER_FRAME_TAP_MAX_CONCURRENT = 4;
/** Threads whose latest target the pool remembers; the oldest idle ones are forgotten first. */
const MAX_REMEMBERED_THREADS = 256;

export interface ComputerFrameTapPoolOptions {
  helperPath: string;
  /** Frames of the thread's current target only, while its preview is visible. */
  onFrame: (frame: ComputerPreviewFrame, target: CuaPreviewTarget) => void;
  /** Errors of one thread's tap, reported for that thread only. */
  onError: (threadId: string, error: unknown) => void;
  spawn?: typeof spawn;
  now?: () => number;
}

interface PoolThread {
  target: CuaPreviewTarget;
  /** Pool-wide order of target updates: the smallest is the least recently updated. */
  touched: number;
  changedAt: number;
  frameAt: number;
}

interface PoolSlot {
  tap: ComputerFrameTap;
  /** A slot waits unstarted while retiring helpers still hold the process budget. */
  started: boolean;
}

/**
 * One live tap per visible thread, each on that thread's own latest target,
 * with at most COMPUTER_FRAME_TAP_MAX_CONCURRENT helper processes (live plus
 * still retiring). When a newly visible or newly acting thread needs a tap
 * and none is free, it evicts the least recently updated tap; the evicted
 * thread falls back to still frames and only gets a tap back when one frees
 * up or its preview is shown again, so a crowd of busy threads never trades
 * helpers on every action. Hidden threads hold no tap.
 */
export class ComputerFrameTapPool {
  private readonly threads = new Map<string, PoolThread>();
  private readonly visible = new Set<string>();
  private readonly evicted = new Set<string>();
  private readonly slots = new Map<string, PoolSlot>();
  private readonly retiring = new Set<Promise<void>>();
  private readonly directory = new FrameSocketDirectory();
  private readonly deadTargets = new Set<string>();
  private touches = 0;
  private sequence = 0;
  private disposed = false;

  private readonly options: ComputerFrameTapPoolOptions;
  constructor(options: ComputerFrameTapPoolOptions) {
    this.options = options;
  }

  /** The thread's latest target, live or not. */
  target(threadId: string): CuaPreviewTarget | undefined {
    return this.threads.get(threadId)?.target;
  }

  /** When the thread's target last changed; 0 when it has none. */
  changedAt(threadId: string): number {
    return this.threads.get(threadId)?.changedAt ?? 0;
  }

  /** When the thread's live tap last delivered a frame of its current target; 0 when never. */
  frameAt(threadId: string): number {
    return this.threads.get(threadId)?.frameAt ?? 0;
  }

  /** Threads that hold a tap slot (started or waiting for the process budget). */
  activeThreads(): string[] {
    return [...this.slots.keys()];
  }

  setTarget(target: CuaPreviewTarget): void {
    if (this.disposed) return;
    const threadId = target.task.threadId;
    const previous = this.threads.get(threadId);
    this.touches += 1;
    // Re-insert so Map order stays least-recently-updated first.
    this.threads.delete(threadId);
    this.threads.set(threadId, {
      target,
      touched: this.touches,
      changedAt: this.now(),
      frameAt:
        previous && tapTargetKey(previous.target) === tapTargetKey(target) ? previous.frameAt : 0,
    });
    this.forgetIdleThreads();
    if (!this.visible.has(threadId)) return;
    const slot = this.slots.get(threadId);
    if (slot) {
      if (slot.started) slot.tap.update(target);
    } else this.claim(threadId);
    this.pump();
  }

  setVisible(threadId: string, visible: boolean): void {
    if (this.disposed || this.visible.has(threadId) === visible) return;
    if (visible) {
      this.visible.add(threadId);
      // Showing a preview is a fresh demand: it may evict even after an earlier eviction.
      this.evicted.delete(threadId);
      if (this.threads.has(threadId)) this.claim(threadId);
      this.pump();
      return;
    }
    this.visible.delete(threadId);
    this.evicted.delete(threadId);
    this.releaseInBackground(threadId);
    this.fill();
  }

  /** Forget the thread's target (it moved to a non-native surface) and stop its tap. */
  async clear(threadId: string): Promise<void> {
    this.threads.delete(threadId);
    this.evicted.delete(threadId);
    const released = this.release(threadId);
    this.fill();
    await released;
  }

  /** End one task (or every turn of its thread without a turnId); other threads keep their taps. */
  async endTask(task: CuaComputerTask): Promise<void> {
    forgetDeadTargets(this.deadTargets, task);
    const thread = this.threads.get(task.threadId);
    if (!thread || !taskEndCovers(task, thread.target.task)) return;
    await this.clear(task.threadId);
  }

  async stopAll(): Promise<void> {
    this.threads.clear();
    this.evicted.clear();
    const releases = [...this.slots.keys()].map((threadId) => this.release(threadId));
    const earlier = [...this.retiring];
    await Promise.all([...releases, ...earlier]);
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.visible.clear();
    await this.stopAll();
    await this.directory.remove();
  }

  /** Give the visible thread a slot, evicting the least recently updated tap when allowed. */
  private claim(threadId: string): void {
    if (this.slots.has(threadId)) return;
    if (this.slots.size >= COMPUTER_FRAME_TAP_MAX_CONCURRENT) {
      if (this.evicted.has(threadId)) return;
      const victim = this.leastRecentlyUpdatedSlot();
      if (!victim) return;
      this.evicted.add(victim);
      this.releaseInBackground(victim);
    }
    this.evicted.delete(threadId);
    this.slots.set(threadId, { tap: this.createTap(threadId), started: false });
  }

  /** Free slots go to waiting visible threads, most recently updated first; never evicts. */
  private fill(): void {
    if (this.disposed) return;
    const waiting = [...this.threads.keys()]
      .filter((threadId) => this.visible.has(threadId) && !this.slots.has(threadId))
      .toReversed();
    for (const threadId of waiting) {
      if (this.slots.size >= COMPUTER_FRAME_TAP_MAX_CONCURRENT) break;
      this.evicted.delete(threadId);
      this.slots.set(threadId, { tap: this.createTap(threadId), started: false });
    }
    this.pump();
  }

  /** Start waiting slots while live plus retiring helpers stay within the budget. */
  private pump(): void {
    if (this.disposed) return;
    let processes = this.retiring.size;
    for (const slot of this.slots.values()) if (slot.started) processes += 1;
    for (const [threadId, slot] of this.slots) {
      if (slot.started) continue;
      if (processes >= COMPUTER_FRAME_TAP_MAX_CONCURRENT) return;
      const thread = this.threads.get(threadId);
      if (!thread) continue;
      slot.started = true;
      processes += 1;
      slot.tap.update(thread.target);
    }
  }

  private leastRecentlyUpdatedSlot(): string | undefined {
    let victim: string | undefined;
    let oldest = Number.POSITIVE_INFINITY;
    for (const threadId of this.slots.keys()) {
      const touched = this.threads.get(threadId)?.touched ?? 0;
      if (touched < oldest) {
        oldest = touched;
        victim = threadId;
      }
    }
    return victim;
  }

  private createTap(threadId: string): ComputerFrameTap {
    const tap: ComputerFrameTap = new ComputerFrameTap({
      helperPath: this.options.helperPath,
      socketDirectory: this.directory,
      deadTargets: this.deadTargets,
      ...(this.options.spawn ? { spawn: this.options.spawn } : {}),
      onError: (error) => this.options.onError(threadId, error),
      send: (_channel, frame) => {
        const thread = this.threads.get(threadId);
        if (
          this.slots.get(threadId)?.tap !== tap ||
          !this.visible.has(threadId) ||
          !thread ||
          frame.targetKey !== tapTargetKey(thread.target)
        )
          return;
        thread.frameAt = this.now();
        this.sequence += 1;
        this.options.onFrame({ ...frame, seq: this.sequence }, thread.target);
      },
    });
    return tap;
  }

  /** Stop the thread's tap; the returned promise rejects when its helper would not stop. */
  private release(threadId: string): Promise<void> {
    const slot = this.slots.get(threadId);
    if (!slot) return Promise.resolve();
    this.slots.delete(threadId);
    const disposed = slot.tap.dispose();
    if (!slot.started) return disposed;
    const settled: Promise<void> = disposed
      .catch(() => undefined)
      .finally(() => {
        this.retiring.delete(settled);
        this.pump();
      });
    this.retiring.add(settled);
    return disposed;
  }

  private releaseInBackground(threadId: string): void {
    void this.release(threadId).catch((error: unknown) => this.options.onError(threadId, error));
  }

  /** Bound remembered targets: forget the least recently updated threads without a slot. */
  private forgetIdleThreads(): void {
    if (this.threads.size <= MAX_REMEMBERED_THREADS) return;
    for (const threadId of this.threads.keys()) {
      if (this.threads.size <= MAX_REMEMBERED_THREADS) return;
      if (this.slots.has(threadId) || this.visible.has(threadId)) continue;
      this.threads.delete(threadId);
      this.evicted.delete(threadId);
    }
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }
}
