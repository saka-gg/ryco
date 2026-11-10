import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";

import { MessageId, OrchestrationShellSnapshot, type OrchestrationMessage } from "@ryco/contracts";
import { ThreadReadCacheContent, ThreadReadCacheShell } from "@ryco/contracts/thread-read-cache";
import { ThreadReadCacheSnapshotItem } from "@ryco/contracts/thread-read-cache-upload";
import {
  applyThreadReadCacheShellPatch,
  applyThreadReadCacheThreadPatch,
} from "@ryco/shared/threadReadCachePatch";
import { Schema } from "effect";
import { describe, expect, it } from "vite-plus/test";

import {
  boundThreadReadCacheShell,
  createThreadReadCachePublisher,
  threadReadCacheContent,
  type ThreadReadCacheUpload,
} from "./ThreadReadCachePublisher.ts";

// The publisher against a Hub that stores and applies uploads the way the real
// one does (the shared patch functions, the contract schemas, the digest), so
// every patch is checked to reproduce exactly what a whole upload would store.

const time = (second: number) => new Date(Date.UTC(2026, 10, 10, 9, 0, second)).toISOString();

function threadRow(index: number, updatedAt: string, running = false) {
  return {
    id: `thread-${index}`,
    projectId: "project-1",
    title: `Investigate the relay case ${index % 37} and fix the flaky test`,
    modelSelection: { instanceId: "codex", model: "gpt-5" },
    runtimeMode: "full-access",
    branch: `feature/relay-${index}`,
    worktreePath: null,
    latestTurn: null,
    createdAt: time(0),
    updatedAt,
    session: running
      ? {
          threadId: `thread-${index}`,
          status: "running",
          providerName: "codex",
          runtimeMode: "full-access",
          activeTurnId: `turn-${index}`,
          lastError: null,
          updatedAt,
        }
      : null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
  };
}

function nodeShell(threads: number, sequence: number, running: ReadonlyArray<number>) {
  return Schema.decodeUnknownSync(OrchestrationShellSnapshot)({
    snapshotSequence: sequence,
    updatedAt: time(sequence % 60),
    projects: [
      {
        id: "project-1",
        title: "Ryco",
        workspaceRoot: "/work/ryco",
        defaultModelSelection: null,
        scripts: [],
        createdAt: time(0),
        updatedAt: time(0),
      },
    ],
    threads: Array.from({ length: threads }, (_, index) =>
      threadRow(
        index,
        running.includes(index) ? time(sequence % 60) : time(0),
        running.includes(index),
      ),
    ),
  });
}

function messages(thread: number, count: number, tail = ""): OrchestrationMessage[] {
  return Array.from({ length: count }, (_, index) => ({
    id: MessageId.make(`message-${thread}-${index}`),
    role: index % 3 === 0 ? "user" : "assistant",
    text:
      `Step ${index}: ran the relay suite for thread ${thread}; ` +
      "everything passed after the retry, see src/ws/index.ts for the change. ".repeat(6) +
      (index === count - 1 ? tail : ""),
    turnId: null,
    streaming: index === count - 1,
    createdAt: time(index % 60),
    updatedAt: time(index % 60),
  }));
}

const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("base64url");

/** A Hub that stores uploads as the real one does, and counts what it receives. */
function fakeHub(features: ReadonlyArray<string>) {
  let shell: { revision: number; value: ThreadReadCacheShell } | null = null;
  const threads = new Map<string, { revision: number; value: ThreadReadCacheContent }>();
  let plainBytes = 0;
  let deflatedBytes = 0;
  const upload = async (generation: number, items: ReadonlyArray<ThreadReadCacheUpload>) => {
    const body = JSON.stringify({ generation, items });
    plainBytes += Buffer.byteLength(body);
    deflatedBytes += deflateSync(body).byteLength;
    const stale: string[] = [];
    for (const raw of items) {
      const item = Schema.decodeUnknownSync(ThreadReadCacheSnapshotItem)(
        JSON.parse(JSON.stringify(raw)),
      );
      switch (item.kind) {
        case "shell":
          shell = { revision: item.revision, value: item.snapshot };
          break;
        case "thread":
          threads.set(item.threadId, { revision: item.revision, value: item.snapshot });
          break;
        case "shellPatch": {
          if (shell === null || shell.revision !== item.baseRevision) throw new Error("409");
          const applied = applyThreadReadCacheShellPatch(shell.value, item);
          if (applied.kind !== "ok") throw new Error(applied.reason);
          shell = {
            revision: item.revision,
            value: Schema.decodeUnknownSync(ThreadReadCacheShell)(applied.value),
          };
          break;
        }
        case "threadPatch": {
          const held = threads.get(item.threadId);
          if (held === undefined || held.revision !== item.baseRevision) {
            stale.push(item.threadId);
            break;
          }
          const applied = applyThreadReadCacheThreadPatch(held.value, item);
          if (applied.kind !== "ok") throw new Error(applied.reason);
          const value = Schema.decodeUnknownSync(ThreadReadCacheContent)(applied.value);
          if (digest(value) !== item.digest) throw new Error("409 digest");
          threads.set(item.threadId, { revision: item.revision, value });
          break;
        }
        case "deleted":
          threads.delete(item.threadId);
      }
    }
    return stale;
  };
  return {
    upload,
    begin: async () => ({ generation: 1, features }),
    shell: () => shell,
    thread: (id: string) => threads.get(id),
    evict: (id: string) => threads.delete(id),
    bytes: () => ({ plain: plainBytes, deflated: deflatedBytes }),
  };
}

function node(features: ReadonlyArray<string>, threads = 1_500, running = [0, 1, 2]) {
  const hub = fakeHub(features);
  let sequence = 1;
  let tail = "";
  let length = 150;
  let snapshot = nodeShell(threads, sequence, running);
  const publisher = createThreadReadCachePublisher({
    nodeId: () => "node-1",
    now: Date.now,
    readSequence: async () => sequence,
    readShell: async () => snapshot,
    readThread: async (threadId) => {
      const index = Number(threadId.slice("thread-".length));
      return {
        revision: sequence,
        messages: running.includes(index) ? messages(index, length, tail) : messages(index, 4),
      };
    },
    begin: hub.begin,
    upload: hub.upload,
  });
  /** The running threads stream: their last message grows, their rows change. */
  const stream = (step: number) => {
    sequence += 1;
    tail += ` streamed text ${step}`.repeat(4);
    snapshot = nodeShell(threads, sequence, running);
  };
  /** A new message in every running thread (the oldest of 150 drops out). */
  const addMessage = () => {
    sequence += 1;
    length += 1;
    snapshot = nodeShell(threads, sequence, running);
  };
  /** Everything a whole upload would store now. */
  const expected = (index: number) =>
    Schema.decodeUnknownSync(ThreadReadCacheContent)(
      threadReadCacheContent(
        running.includes(index) ? messages(index, length, tail) : messages(index, 4),
      ),
    );
  const expectedShell = () =>
    Schema.decodeUnknownSync(ThreadReadCacheShell)(boundThreadReadCacheShell(snapshot).snapshot);
  /** Synchronize until nothing is left to upload. */
  const settle = async () => {
    for (let round = 0; round < 200; round += 1) {
      const before = hub.bytes().plain;
      await publisher.synchronize();
      if (hub.bytes().plain === before) return;
    }
  };
  return { hub, publisher, stream, addMessage, expected, expectedShell, settle };
}

describe("cloud thread history patches (patch-v1)", () => {
  it("stores exactly what whole uploads store, through streaming, new messages and eviction", async () => {
    const n = node(["patch-v1", "deflate"], 40);
    await n.settle();
    for (let step = 0; step < 5; step += 1) {
      n.stream(step);
      await n.publisher.synchronize();
    }
    n.addMessage();
    await n.publisher.synchronize();
    // The Hub evicted a body under its byte cap: that thread goes whole again.
    n.hub.evict("thread-1");
    n.stream(9);
    await n.settle();
    expect(n.hub.shell()?.value).toEqual(n.expectedShell());
    for (const index of [0, 1, 2, 3, 39]) {
      expect(n.hub.thread(`thread-${index}`)?.value).toEqual(n.expected(index));
    }
  });

  it("uploads whole items to a Hub that announced no patches", async () => {
    const n = node([], 20);
    await n.settle();
    n.stream(0);
    const before = n.hub.bytes().plain;
    await n.publisher.synchronize();
    expect(n.hub.bytes().plain).toBeGreaterThan(before);
    expect(n.hub.thread("thread-0")?.value).toEqual(n.expected(0));
  });

  it("measures a streaming minute: whole uploads every second vs patches every 5 s (H4)", async () => {
    // Before: 60 uploads (one per second), each the whole list and every running thread's last
    // 150 messages, plain JSON. After: 12 uploads (every 5 s), each the changed rows and messages,
    // deflated. 1,500 threads, three of them streaming.
    const before = node([], 1_500);
    const after = node(["patch-v1", "deflate"], 1_500);
    await before.settle();
    await after.settle();
    const baseBefore = before.hub.bytes();
    const baseAfter = after.hub.bytes();
    for (let second = 1; second <= 60; second += 1) {
      before.stream(second);
      await before.publisher.synchronize();
      after.stream(second);
      if (second % 5 === 0) await after.publisher.synchronize();
    }
    const sent = (now: { plain: number; deflated: number }, base: typeof now) => ({
      plain: now.plain - base.plain,
      deflated: now.deflated - base.deflated,
    });
    const old = sent(before.hub.bytes(), baseBefore);
    const fresh = sent(after.hub.bytes(), baseAfter);
    console.info(
      `H4 streaming minute: ${old.plain} B plain before -> ${fresh.deflated} B deflated after ` +
        `(${fresh.plain} B before compression); backfill ${baseBefore.plain} -> ${baseAfter.deflated} B`,
    );
    expect(fresh.deflated).toBeLessThan(old.plain / 50);
    expect(after.hub.shell()?.value).toEqual(after.expectedShell());
    expect(after.hub.thread("thread-0")?.value).toEqual(after.expected(0));
  });
});
