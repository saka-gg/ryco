import { describe, expect, it } from "vite-plus/test";

import {
  claudeEntryBeforePrompt,
  claudeTurnCutoff,
  isClaudeCutoffInChain,
} from "./claudeTranscriptCutoff.ts";

// prompt-1 opens turn 1 (with a tool round trip), prompt-2 turn 2 (with a steer), prompt-3 turn 3.
const chain = [
  "prompt-1",
  "assistant-1a",
  "tool-result-1",
  "assistant-1b",
  "prompt-2",
  "assistant-2a",
  "steer-2",
  "assistant-2b",
  "compact-boundary",
  "prompt-3",
  "assistant-3",
];

describe("claudeEntryBeforePrompt", () => {
  it("finds the entry a rewind before a prompt resumes at", () => {
    expect(claudeEntryBeforePrompt(chain, "prompt-2")).toEqual({
      kind: "entry",
      uuid: "assistant-1b",
    });
    expect(claudeEntryBeforePrompt(chain, "prompt-1")).toEqual({ kind: "chain-start" });
    expect(claudeEntryBeforePrompt(chain, "unknown")).toEqual({ kind: "missing" });
    expect(claudeEntryBeforePrompt([], "prompt-1")).toEqual({ kind: "missing" });
  });
});

describe("claudeTurnCutoff", () => {
  it("ends a turn just before the next turn's prompt, keeping its tool results and steers", () => {
    expect(
      claudeTurnCutoff({
        chainUuids: chain,
        turnPromptUuid: "prompt-1",
        laterTurnIds: ["prompt-2", "prompt-3"],
      }),
    ).toEqual({ uuid: "assistant-1b", index: 3, atTail: false });
    expect(
      claudeTurnCutoff({
        chainUuids: chain,
        turnPromptUuid: "prompt-2",
        laterTurnIds: ["prompt-3"],
      }),
    ).toEqual({ uuid: "compact-boundary", index: 8, atTail: false });
  });

  it("ends the newest turn at the chain's tail, and says so", () => {
    expect(
      claudeTurnCutoff({ chainUuids: chain, turnPromptUuid: "prompt-3", laterTurnIds: [] }),
    ).toEqual({ uuid: "assistant-3", index: 10, atTail: true });
  });

  it("uses the earliest later prompt even when later turn ids arrive out of order", () => {
    expect(
      claudeTurnCutoff({
        chainUuids: chain,
        turnPromptUuid: "prompt-1",
        laterTurnIds: ["prompt-3", "prompt-2"],
      }),
    ).toMatchObject({ uuid: "assistant-1b", atTail: false });
  });

  it("refuses a turn that is not in this session", () => {
    expect(
      claudeTurnCutoff({
        chainUuids: chain,
        turnPromptUuid: "import:key:turn:1",
        laterTurnIds: [],
      }),
    ).toBeNull();
    expect(claudeTurnCutoff({ chainUuids: [], turnPromptUuid: "prompt-1", laterTurnIds: [] })).toBe(
      null,
    );
  });

  it("refuses when a later turn cannot be placed (a promptless wake turn), never keeping its output", () => {
    expect(
      claudeTurnCutoff({
        chainUuids: chain,
        turnPromptUuid: "prompt-2",
        laterTurnIds: ["wake-turn", "prompt-3"],
      }),
    ).toBeNull();
  });

  it("refuses a chain where a later turn's prompt precedes the selected one", () => {
    expect(
      claudeTurnCutoff({
        chainUuids: chain,
        turnPromptUuid: "prompt-2",
        laterTurnIds: ["prompt-1"],
      }),
    ).toBeNull();
  });
});

describe("isClaudeCutoffInChain", () => {
  // Pinned at the tail while turn 2 was the newest.
  const pinned = { uuid: "assistant-2b", index: 7 };
  const atPin = chain.slice(0, 8);

  it("keeps a pinned cutoff while later turns are appended", () => {
    expect(
      isClaudeCutoffInChain({ chainUuids: atPin, turnPromptUuid: "prompt-2", cutoff: pinned }),
    ).toBe(true);
    // The source ran on: the pinned entry, not the new tail, still ends turn 2.
    expect(
      isClaudeCutoffInChain({ chainUuids: chain, turnPromptUuid: "prompt-2", cutoff: pinned }),
    ).toBe(true);
    expect(
      claudeTurnCutoff({ chainUuids: chain, turnPromptUuid: "prompt-2", laterTurnIds: [] })?.uuid,
    ).toBe("assistant-3");
  });

  it("refuses a rewritten chain or a prompt after the cutoff", () => {
    const rewound = [...chain.slice(0, 5), "assistant-2-retry", "assistant-2c", "x", "y"];
    expect(
      isClaudeCutoffInChain({ chainUuids: rewound, turnPromptUuid: "prompt-2", cutoff: pinned }),
    ).toBe(false);
    expect(
      isClaudeCutoffInChain({ chainUuids: chain, turnPromptUuid: "prompt-3", cutoff: pinned }),
    ).toBe(false);
    expect(
      isClaudeCutoffInChain({
        chainUuids: chain.slice(0, 5),
        turnPromptUuid: "prompt-2",
        cutoff: pinned,
      }),
    ).toBe(false);
  });
});
