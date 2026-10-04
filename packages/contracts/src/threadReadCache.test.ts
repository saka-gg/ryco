import { Schema } from "effect";
import { describe, expect, it } from "vite-plus/test";

import {
  ThreadReadCacheContent,
  ThreadReadCacheSnapshotInput,
  ThreadReadCacheShellResponse,
  ThreadReadCacheThreadResponse,
} from "./threadReadCache.ts";

const message = {
  id: "message-1",
  role: "assistant",
  text: "Cached answer",
  createdAt: "2026-10-04T00:00:00.000Z",
};
const envelope = { protocolVersion: 1, generation: 2, revision: 3, storedAt: 123 };

describe("thread read cache contracts", () => {
  it("strips live authority and attachment data from cached messages", () => {
    const decoded = Schema.decodeUnknownSync(ThreadReadCacheThreadResponse)({
      ...envelope,
      threadId: "thread-1",
      snapshot: {
        messages: [{ ...message, streaming: true, attachments: [{ url: "secret" }] }],
        session: { status: "ready" },
      },
    });
    expect(decoded.snapshot).toEqual({ messages: [message] });
  });

  it("rejects message count, text budget and duplicate IDs", () => {
    const decode = Schema.decodeUnknownSync(ThreadReadCacheContent);
    expect(() =>
      decode({ messages: Array.from({ length: 151 }, (_, i) => ({ ...message, id: `m-${i}` })) }),
    ).toThrow();
    expect(() => decode({ messages: [{ ...message, text: "x".repeat(1_000_001) }] })).toThrow();
    expect(() => decode({ messages: [message, message] })).toThrow();
  });

  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1, Infinity])(
    "rejects invalid generation %s",
    (generation) => {
      expect(() =>
        Schema.decodeUnknownSync(ThreadReadCacheThreadResponse)({
          ...envelope,
          generation,
          threadId: "thread-1",
          snapshot: { messages: [] },
        }),
      ).toThrow();
    },
  );

  it("bounds authenticated upload batches and validates canonical proof lengths", () => {
    const proof = {
      nodeId: `node_${"a".repeat(22)}`,
      protocolMajor: 1,
      protocolMinor: 3,
      nonce: "A".repeat(43),
      signature: "A".repeat(86),
    };
    const item = { kind: "deleted", revision: 1, threadId: "thread-1" };
    const decode = Schema.decodeUnknownSync(ThreadReadCacheSnapshotInput);
    expect(decode({ proof, generation: 1, items: [item] }).items).toHaveLength(1);
    expect(() => decode({ proof, generation: 1, items: [] })).toThrow();
    expect(() =>
      decode({ proof, generation: 1, items: Array.from({ length: 17 }, () => item) }),
    ).toThrow();
    expect(() =>
      decode({ proof: { ...proof, nonce: "A".repeat(42) }, generation: 1, items: [item] }),
    ).toThrow();
    expect(() =>
      decode({
        proof: { ...proof, signature: `${"A".repeat(85)}B` },
        generation: 1,
        items: [item],
      }),
    ).toThrow();
  });

  it("bounds the canonical shell project count", () => {
    const project = {
      id: "project-1",
      title: "Project",
      workspaceRoot: "/workspace",
      defaultModelSelection: null,
      scripts: [],
      createdAt: message.createdAt,
      updatedAt: message.createdAt,
    };
    const decode = Schema.decodeUnknownSync(ThreadReadCacheShellResponse);
    const response = {
      ...envelope,
      snapshot: {
        snapshotSequence: 1,
        projects: Array.from({ length: 2_000 }, () => project),
        threads: [],
        updatedAt: message.createdAt,
      },
    };
    expect(decode(response).snapshot.projects).toHaveLength(2_000);
    expect(() =>
      decode({
        ...response,
        snapshot: { ...response.snapshot, projects: [...response.snapshot.projects, project] },
      }),
    ).toThrow();
  });

  it("decodes the canonical bounded shell without restoring live readiness", () => {
    const snapshot = {
      snapshotSequence: 1,
      projects: [],
      threads: [],
      updatedAt: message.createdAt,
    };
    expect(
      Schema.decodeUnknownSync(ThreadReadCacheShellResponse)({ ...envelope, snapshot }).snapshot,
    ).toEqual(snapshot);
  });
});
