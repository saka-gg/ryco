/**
 * Boundary parity: the node accepts a fork from exactly the replies clients offer "Fork from here"
 * on. Both sides read the reply a turn ended on from `@ryco/shared/turnReply`; these shapes
 * (carriers, steers including image-only ones, system notes, several replies in one turn) are
 * where a second rule would drift.
 */
import { deriveForkableReplyMessageIds } from "@ryco/client-runtime/state/threads";
import { type ChatAttachment, MessageId, type OrchestrationMessage, TurnId } from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import { type ForkBoundaryTurn, resolveForkBoundary } from "./forkBoundary.ts";
import { message, turnRow } from "./forkHistory.fixtures.ts";

const image: ChatAttachment = {
  type: "image",
  id: "attachment-image",
  name: "screen.png",
  mimeType: "image/png",
  sizeBytes: 1024,
};

type Shape = "reply" | "carrier" | "steer" | "image-steer" | "system" | "queued";

/** One turn: its prompt, then `shape` in order. `expected` names the one forkable entry. */
interface Scenario {
  readonly name: string;
  readonly shape: ReadonlyArray<Shape>;
  /** Index into `shape` of the reply the turn ended on, or null when none is forkable. */
  readonly expected: number | null;
}

const SCENARIOS: ReadonlyArray<Scenario> = [
  { name: "a single reply", shape: ["reply"], expected: 0 },
  { name: "commentary, then the reply", shape: ["reply", "reply"], expected: 1 },
  { name: "three replies", shape: ["reply", "reply", "reply"], expected: 2 },
  { name: "a carrier after the reply", shape: ["reply", "carrier"], expected: 0 },
  { name: "carriers around the reply", shape: ["carrier", "reply", "carrier"], expected: 1 },
  { name: "only carriers", shape: ["carrier", "carrier"], expected: 1 },
  { name: "a system note after the reply", shape: ["reply", "system"], expected: 0 },
  {
    name: "a system note and a carrier after the reply",
    shape: ["reply", "system", "carrier"],
    expected: 0,
  },
  { name: "a steer answered by a later reply", shape: ["reply", "steer", "reply"], expected: 2 },
  { name: "a steer after the last reply", shape: ["reply", "steer"], expected: null },
  {
    name: "an image-only steer after the last reply",
    shape: ["reply", "image-steer"],
    expected: null,
  },
  {
    name: "an image-only steer answered by a later reply",
    shape: ["reply", "image-steer", "reply"],
    expected: 2,
  },
  { name: "a steer, then a carrier", shape: ["reply", "steer", "carrier"], expected: null },
  {
    name: "a carrier, then an image-only steer",
    shape: ["carrier", "image-steer"],
    expected: null,
  },
  {
    name: "a steer answered only by a carrier",
    shape: ["carrier", "steer", "carrier"],
    expected: 2,
  },
  { name: "only a system note", shape: ["system"], expected: null },
  {
    name: "a queued prompt without a turn after the reply",
    shape: ["reply", "queued"],
    expected: 0,
  },
];

const timestamp = (index: number) => new Date(Date.UTC(2026, 9, 11, 10, 0, index)).toISOString();

interface Built {
  readonly messages: ReadonlyArray<OrchestrationMessage>;
  readonly turns: ReadonlyArray<ForkBoundaryTurn>;
  /** Per scenario: the turn's own entries (not its prompt), and the expected forkable id. */
  readonly cases: ReadonlyArray<{
    readonly scenario: Scenario;
    readonly entryIds: ReadonlyArray<MessageId>;
    readonly expectedId: MessageId | null;
  }>;
}

/** The scenarios as consecutive completed turns of one thread, in creation order. */
function build(scenarios: ReadonlyArray<Scenario>): Built {
  const messages: OrchestrationMessage[] = [];
  const turns: ForkBoundaryTurn[] = [];
  const cases: Array<Built["cases"][number]> = [];
  const push = (id: string, role: OrchestrationMessage["role"], fields = {}) => {
    const createdAt = timestamp(messages.length);
    messages.push(message(id, role, 0, { createdAt, updatedAt: createdAt, ...fields }));
    return MessageId.make(id);
  };
  for (const [turnIndex, scenario] of scenarios.entries()) {
    const turnId = TurnId.make(`turn-${turnIndex}`);
    const promptId = `prompt-${turnIndex}`;
    turns.push(turnRow(turnId, 0, promptId, { requestedAt: timestamp(messages.length) }));
    push(promptId, "user");
    const entryIds = scenario.shape.map((shape, index) => {
      const id = `turn-${turnIndex}-${index}-${shape}`;
      switch (shape) {
        case "reply":
          return push(id, "assistant", { turnId });
        case "carrier":
          return push(id, "assistant", { turnId, text: "", attachments: [image] });
        case "steer":
          return push(id, "user", { turnId, dispatchMode: "steer" });
        case "image-steer":
          return push(id, "user", {
            turnId,
            dispatchMode: "steer",
            text: "",
            attachments: [image],
          });
        case "system":
          return push(id, "system", { turnId });
        case "queued":
          return push(id, "user", { dispatchMode: "queue" });
      }
    });
    cases.push({
      scenario,
      entryIds,
      expectedId: scenario.expected === null ? null : entryIds[scenario.expected]!,
    });
  }
  return { messages, turns, cases };
}

/** What a client offers: the shared derivation over its loaded (client-shaped) messages. */
function clientForkable(built: Built): ReadonlySet<MessageId> {
  const latest = built.turns.at(-1)!;
  return deriveForkableReplyMessageIds({
    messages: built.messages.map((entry) => ({
      id: entry.id,
      role: entry.role,
      text: entry.text,
      streaming: entry.streaming,
      turnId: entry.turnId,
      ...(entry.attachments === undefined ? {} : { attachments: [...entry.attachments] }),
    })),
    latestTurn: { turnId: latest.turnId!, state: "completed" },
    session: {},
  });
}

/** What the node accepts: every message the boundary resolver takes as a fork point. */
function serverForkable(built: Built): ReadonlySet<MessageId> {
  return new Set(
    built.messages.flatMap((entry) =>
      resolveForkBoundary({
        messages: built.messages,
        turns: built.turns,
        session: { activeTurnId: null, status: "ready" },
        messageId: entry.id,
      }).ok
        ? [entry.id]
        : [],
    ),
  );
}

const expectedForkable = (built: Built) =>
  new Set(built.cases.flatMap((entry) => (entry.expectedId === null ? [] : [entry.expectedId])));

describe("fork boundary parity between the node and clients", () => {
  it.each(SCENARIOS.map((scenario) => [scenario.name, scenario] as const))(
    "a turn with %s",
    (_name, scenario) => {
      const built = build([scenario]);
      const expected = [...expectedForkable(built)];
      expect([...clientForkable(built)]).toEqual(expected);
      expect([...serverForkable(built)]).toEqual(expected);
    },
  );

  it("agrees on every reply of a thread holding all the shapes, one turn each", () => {
    const built = build(SCENARIOS);
    const expected = [...expectedForkable(built)].toSorted();
    expect([...clientForkable(built)].toSorted()).toEqual(expected);
    expect([...serverForkable(built)].toSorted()).toEqual(expected);
  });

  it("refuses every entry of a turn the clients do not offer, with a boundary error", () => {
    const built = build(SCENARIOS);
    const offered = clientForkable(built);
    for (const entry of built.messages) {
      if (offered.has(entry.id)) continue;
      const result = resolveForkBoundary({
        messages: built.messages,
        turns: built.turns,
        session: { activeTurnId: null, status: "ready" },
        messageId: entry.id,
      });
      expect(result.ok ? "accepted" : result.reason).toBe("boundary-unsupported");
    }
  });

  it("inherits the boundary turn's trailing carriers and system notes, and no later turn", () => {
    const built = build([
      { name: "trailing", shape: ["reply", "system", "carrier"], expected: 0 },
      { name: "next", shape: ["reply"], expected: 0 },
    ]);
    const result = resolveForkBoundary({
      messages: built.messages,
      turns: built.turns,
      session: { activeTurnId: null, status: "ready" },
      messageId: built.cases[0]!.expectedId!,
    });
    if (!result.ok) throw new Error(result.detail);
    expect(result.inheritedMessages.map((entry) => entry.id)).toEqual([
      "prompt-0",
      ...built.cases[0]!.entryIds,
    ]);
  });
});
