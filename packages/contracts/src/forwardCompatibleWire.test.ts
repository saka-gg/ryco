import { Schema } from "effect";
import { RpcSchema } from "effect/rpc";
import { describe, expect, it } from "vite-plus/test";

import { isUnknownUnionMember, UnknownUnionMember } from "./baseSchemas.ts";
import {
  OrchestrationEvent,
  OrchestrationShellStreamItem,
  OrchestrationShellStreamWireItem,
  OrchestrationThreadStreamItem,
  OrchestrationThreadWindowStreamItem,
} from "./orchestration.ts";
import {
  WsAgentControlSubscribeProposalsRpc,
  WsGitRunStackedActionRpc,
  WsHostedRpcGroup,
  WsOrchestrationReplayEventsPageRpc,
  WsOrchestrationReplayEventsRpc,
  WsOrchestrationSubscribeShellRpc,
  WsOrchestrationSubscribeThreadRpc,
  WsOrchestrationSubscribeThreadWindowRpc,
  WsServerSubscribeLocalTaskChangesRpc,
  WsServerSubscribeNodeUpdateRpc,
  WsSubscribeAuthAccessRpc,
  WsSubscribeDeviceEventsRpc,
  WsSubscribeServerConfigRpc,
  WsSubscribeServerLifecycleRpc,
  WsSubscribeTerminalEventsRpc,
  WsSubscribeVcsStatusRpc,
  WsSubscribeWorktreeSetupRpc,
} from "./rpc.ts";
import { ServerConfigStreamEvent, ServerConfigStreamWireEvent } from "./server.ts";
import { TerminalEvent, TerminalWireEvent } from "./terminal.ts";

const at = "2026-10-22T00:00:00.000Z";
const eventBase = (sequence: number) => ({
  sequence,
  eventId: `event-${sequence}`,
  aggregateKind: "thread",
  aggregateId: "thread-1",
  occurredAt: at,
  commandId: null,
  causationEventId: null,
  correlationId: null,
  metadata: {},
});
const knownEvent = {
  ...eventBase(7),
  type: "thread.manualPositionSet",
  payload: { threadId: "thread-1", position: 2, changedAt: at },
};
// Types no build of this client knows, standing in for what a newer node adds.
const futureEvent = {
  ...eventBase(8),
  aggregateKind: "board",
  aggregateId: "board-1",
  type: "board.pinned",
  payload: { pinnedBy: "someone" },
};
const terminal = { threadId: "thread-1", terminalId: "default", createdAt: at };

const placeholder = (tag: string, value: string, kept: object = {}) =>
  Object.assign(new UnknownUnionMember(tag, value), kept);
const futureEventPlaceholder = placeholder("type", "board.pinned", {
  sequence: 8,
  aggregateKind: "board",
  aggregateId: "board-1",
});

/** What the client decodes a stream's chunks with, as the RPC client builds it. */
const streamSuccess = (rpc: { readonly successSchema: Schema.Constraint }) => {
  if (!RpcSchema.isStreamSchema(rpc.successSchema)) throw new Error("not a stream RPC");
  return rpc.successSchema.success;
};
const decodeChunk = (schema: Schema.Top) =>
  Schema.decodeUnknownSync(Schema.toCodecJson(Schema.NonEmptyArray(schema)) as never) as (
    values: unknown,
  ) => ReadonlyArray<unknown>;

interface WireUnionCase {
  readonly name: string;
  readonly schema: Schema.Top;
  /** The strict union the server (or its event store) builds, and a member it must reject. */
  readonly strict: { readonly schema: Schema.Top; readonly rejects: unknown };
  /** The RPC that carries it: clients must decode with the wire schema. */
  readonly rpc: { readonly _tag: string; readonly successSchema: Schema.Constraint };
  readonly known: readonly [unknown, ...ReadonlyArray<unknown>];
  readonly broken: ReadonlyArray<unknown>;
  readonly unknown: ReadonlyArray<{ readonly wire: unknown; readonly decoded: unknown }>;
}

/** Every server-to-client union a client decodes forward-compatibly. */
const cases: ReadonlyArray<WireUnionCase> = [
  {
    name: "thread stream items",
    schema: OrchestrationThreadStreamItem,
    strict: { schema: OrchestrationEvent, rejects: futureEvent },
    rpc: WsOrchestrationSubscribeThreadRpc,
    known: [
      { kind: "resumed", fromSequence: 3 },
      { kind: "event", event: knownEvent },
    ],
    broken: [
      { kind: "resumed", fromSequence: -1 },
      { kind: "event", event: { ...knownEvent, payload: {} } },
    ],
    unknown: [
      { wire: { kind: "snapshot-page", rows: [] }, decoded: placeholder("kind", "snapshot-page") },
      {
        wire: { kind: "event", event: futureEvent },
        decoded: { kind: "event", event: futureEventPlaceholder },
      },
    ],
  },
  {
    name: "thread window stream items",
    schema: OrchestrationThreadWindowStreamItem,
    strict: { schema: OrchestrationEvent, rejects: futureEvent },
    rpc: WsOrchestrationSubscribeThreadWindowRpc,
    known: [{ kind: "event", event: knownEvent }],
    broken: [{ kind: "event", event: { ...knownEvent, sequence: "seven" } }],
    unknown: [
      {
        wire: { kind: "event", event: futureEvent },
        decoded: { kind: "event", event: futureEventPlaceholder },
      },
    ],
  },
  {
    name: "shell stream items",
    schema: OrchestrationShellStreamWireItem,
    strict: {
      schema: OrchestrationShellStreamItem,
      rejects: { kind: "thread-teleported", sequence: 5, threadId: "thread-1" },
    },
    rpc: WsOrchestrationSubscribeShellRpc,
    known: [
      { kind: "thread-removed", sequence: 4, threadId: "thread-1" },
      { kind: "snapshot-end" },
    ],
    broken: [{ kind: "thread-removed", sequence: "four", threadId: "thread-1" }],
    unknown: [
      {
        wire: { kind: "thread-teleported", sequence: 5, threadId: "thread-1" },
        decoded: placeholder("kind", "thread-teleported", { sequence: 5 }),
      },
      { wire: { kind: "shell-hint", text: "hi" }, decoded: placeholder("kind", "shell-hint") },
    ],
  },
  {
    name: "server config stream events",
    schema: ServerConfigStreamWireEvent,
    strict: {
      schema: ServerConfigStreamEvent,
      rejects: { version: 1, type: "pluginsUpdated", payload: { plugins: [] } },
    },
    rpc: WsSubscribeServerConfigRpc,
    known: [{ version: 1, type: "keybindingsUpdated", payload: { keybindings: [], issues: [] } }],
    broken: [{ version: 1, type: "keybindingsUpdated", payload: {} }],
    unknown: [
      {
        wire: { version: 1, type: "pluginsUpdated", payload: { plugins: [] } },
        decoded: placeholder("type", "pluginsUpdated"),
      },
    ],
  },
  {
    name: "terminal events",
    schema: TerminalWireEvent,
    strict: { schema: TerminalEvent, rejects: { ...terminal, type: "bell" } },
    rpc: WsSubscribeTerminalEventsRpc,
    known: [{ ...terminal, type: "output", data: "ls\n" }],
    broken: [{ ...terminal, type: "output", data: 42 }],
    unknown: [{ wire: { ...terminal, type: "bell" }, decoded: placeholder("type", "bell") }],
  },
];

describe.each(cases)("forward-compatible $name", (wireCase) => {
  const decode = decodeChunk(wireCase.schema);
  const encode = Schema.encodeUnknownSync(Schema.toCodecJson(wireCase.schema) as never) as (
    value: unknown,
  ) => unknown;

  it("is what the client decodes the RPC with", () => {
    expect(streamSuccess(wireCase.rpc)).toBe(wireCase.schema);
  });

  it("decodes a member a newer node added to a placeholder, mid-chunk", () => {
    const [first, ...rest] = wireCase.known;
    expect(decode([first, ...wireCase.unknown.map(({ wire }) => wire), ...rest])).toEqual([
      first,
      ...wireCase.unknown.map(({ decoded }) => decoded),
      ...rest,
    ]);
  });

  it("still fails a known member whose payload is broken", () => {
    for (const broken of wireCase.broken) {
      expect(() => decode([broken])).toThrow();
    }
  });

  it("round-trips known members unchanged", () => {
    expect(decode(wireCase.known).map((value) => encode(value))).toEqual(wireCase.known);
  });

  it("never encodes a placeholder", () => {
    for (const { decoded } of wireCase.unknown) {
      expect(() => encode(decoded)).toThrow();
    }
  });

  it("leaves the strict union strict", () => {
    const decodeStrict = Schema.decodeUnknownSync(
      Schema.toCodecJson(wireCase.strict.schema) as never,
    );
    expect(() => decodeStrict(wireCase.strict.rejects)).toThrow();
  });
});

describe("forward-compatible orchestration event replays", () => {
  const decodeReplay = Schema.decodeUnknownSync(
    Schema.toCodecJson(WsOrchestrationReplayEventsRpc.successSchema),
  );
  const decodePage = Schema.decodeUnknownSync(
    Schema.toCodecJson(WsOrchestrationReplayEventsPageRpc.successSchema),
  );

  it("keeps an event type a newer node added in place, with its sequence", () => {
    const replayed = decodeReplay([knownEvent, futureEvent]);
    expect(replayed.map((event) => event.sequence)).toEqual([7, 8]);
    expect(replayed.map(isUnknownUnionMember)).toEqual([false, true]);
    expect(decodePage({ events: [futureEvent], nextSequence: 8, hasMore: false }).events).toEqual([
      futureEventPlaceholder,
    ]);
  });

  it("still fails a known event whose payload is broken", () => {
    expect(() => decodeReplay([{ ...knownEvent, payload: { threadId: "thread-1" } }])).toThrow();
  });
});

/**
 * Streams whose chunks a client still decodes strictly: a member or value a
 * newer node adds there fails the decode and ends that subscription on an
 * older client. Moving one to a forward-compatible union moves it to `cases`.
 */
const strictStreams = [
  WsAgentControlSubscribeProposalsRpc,
  WsGitRunStackedActionRpc,
  WsServerSubscribeLocalTaskChangesRpc,
  WsServerSubscribeNodeUpdateRpc,
  WsSubscribeAuthAccessRpc,
  WsSubscribeDeviceEventsRpc,
  WsSubscribeServerLifecycleRpc,
  WsSubscribeVcsStatusRpc,
  WsSubscribeWorktreeSetupRpc,
];

describe("streams a node sends a client", () => {
  it("are each forward-compatible or strict on purpose", () => {
    const streams = [...WsHostedRpcGroup.requests.values()]
      .filter((rpc) => RpcSchema.isStreamSchema(rpc.successSchema))
      .map((rpc) => rpc._tag);
    const decided = [...cases.map(({ rpc }) => rpc), ...strictStreams].map((rpc) => rpc._tag);
    // A new stream must join `cases` (forward-compatible) or `strictStreams`.
    expect(streams.toSorted()).toEqual(decided.toSorted());
  });
});
