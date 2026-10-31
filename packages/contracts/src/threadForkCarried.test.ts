import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import { describe, expect, it } from "vite-plus/test";

import { ThreadForkCarriedRequest, ThreadForkedActivityPayload } from "./threadFork.ts";
import { CARRIED_THREAD_HISTORY_MAX_BYTES, ThreadForkCarriedInput } from "./threadForkCarried.ts";
import { RELAY_MAX_RPC_MESSAGE_BYTES } from "./relayConstants.ts";

const carriedPayload = {
  schemaVersion: 1,
  sourceThreadId: "fork-abc:origin",
  sourceMessageId: "carried-0003",
  sourceTurnId: "turn-on-a-2",
  sourceTitle: "Feature work",
  inheritedMessageCount: 4,
  providerContext: "handoff",
  checkout: {
    kind: "new-worktree",
    worktreeId: "worktree-fork-abc",
    worktreePath: "/worktrees/repo/fork",
    branch: "ryco/fork-abcdef12",
    start: "base-ref",
    baseRef: "origin/feature",
  },
  notices: [],
  origin: {
    kind: "other-machine",
    machineLabel: "Machine A",
    sourceEnvironmentId: "environment-a",
    sourceThreadId: "thread-on-a",
    sourceThreadTitle: "Feature work",
  },
};

describe("carried fork contracts", () => {
  it("round-trips a provenance with an origin, and an older decoder still reads it", () => {
    const decoded = Schema.decodeUnknownSync(ThreadForkedActivityPayload)(carriedPayload);
    expect(decoded.origin).toEqual(carriedPayload.origin);
    expect(Schema.encodeSync(ThreadForkedActivityPayload)(decoded)).toEqual(carriedPayload);

    // The payload schema as clients before carried forks know it: no `origin` key.
    const olderPayload = ThreadForkedActivityPayload.mapFields(Struct.omit(["origin"]));
    const older = Schema.decodeUnknownSync(olderPayload)(carriedPayload);
    expect(older).toMatchObject({ sourceTitle: "Feature work", providerContext: "handoff" });
    expect(older).not.toHaveProperty("origin");
  });

  it("keeps the carried conversation opaque on the wire and under the relay's frame", () => {
    expect(CARRIED_THREAD_HISTORY_MAX_BYTES).toBeLessThan(RELAY_MAX_RPC_MESSAGE_BYTES);
    const request = Schema.decodeUnknownSync(ThreadForkCarriedRequest)({
      forkKey: "carried-key-000001",
      projectId: null,
      destination: { kind: "new-chat" },
      history: { anything: ["the node decodes it after access"] },
    });
    expect(request.history).toEqual({ anything: ["the node decodes it after access"] });
    expect(request.destination).toEqual({ kind: "new-chat" });
    expect(() =>
      Schema.decodeUnknownSync(ThreadForkCarriedInput)({
        forkKey: "carried-key-000001",
        projectId: null,
        destination: { kind: "current-checkout" },
        history: {},
      }),
    ).toThrow();
  });
});
