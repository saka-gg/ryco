import { SecretRequestError, SecretRequestId } from "@ryco/contracts/secret-request";
import { ThreadId } from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  hasSecretRequestActivity,
  secretRequestAnswerAccess,
  secretRequestAnswerInput,
  secretRequestCards,
  secretRequestFailureText,
  secretRequestOutcomeText,
  secretRequestPrivacyNote,
} from "./secretRequests.ts";

const threadId = ThreadId.make("thread-1");
const requestId = SecretRequestId.make(`secret-request-${"c".repeat(32)}`);
const VALUE = ["typed", "by", "the", "owner"].join("-");

const requested = {
  id: "requested",
  kind: "secret.requested",
  createdAt: "2026-10-31T08:00:00.000Z",
  turnId: "turn-1",
  payload: {
    requestId,
    key: "OPENAI_API_KEY",
    purpose: "Run the evals",
    file: ".env.local",
    expiresAt: "2026-11-01T08:00:00.000Z",
    checkoutId: "c".repeat(32),
  },
};

describe("secret request cards", () => {
  it("shows a card per unanswered, unexpired request", () => {
    expect(hasSecretRequestActivity([{ kind: "tool.completed" }])).toBe(false);
    expect(hasSecretRequestActivity([requested])).toBe(true);
    const now = Date.parse("2026-10-31T09:00:00.000Z");
    expect(secretRequestCards([requested], now)).toEqual([
      expect.objectContaining({ requestId, key: "OPENAI_API_KEY", file: ".env.local" }),
    ]);
    expect(secretRequestCards([requested], Date.parse("2026-11-01T08:00:00.000Z"))).toEqual([]);
    const answered = {
      id: "resolved",
      kind: "secret.resolved",
      createdAt: "2026-10-31T08:01:00.000Z",
      payload: { requestId, status: "provided" },
    };
    expect(secretRequestCards([requested, answered], now)).toEqual([]);
  });

  it("builds the answer payload, trimming the value and refusing a blank one", () => {
    expect(
      secretRequestAnswerInput(threadId, requestId, { type: "provide", value: ` ${VALUE}\n` }),
    ).toEqual({ threadId, requestId, answer: { type: "provide", value: VALUE } });
    expect(secretRequestAnswerInput(threadId, requestId, { type: "provide", value: " \n" })).toBe(
      null,
    );
    expect(secretRequestAnswerInput(threadId, requestId, { type: "decline" })).toEqual({
      threadId,
      requestId,
      answer: { type: "decline" },
    });
  });

  it("shows only the node's own refusals and never repeats what was typed", () => {
    expect(secretRequestFailureText(new SecretRequestError({ reason: "not-ignored" }))).toBe(
      "Git does not ignore that file, so Ryco will not write a secret there.",
    );
    // The node's refusal of a value sent over an unencrypted connection, shown as is.
    expect(
      secretRequestFailureText(new SecretRequestError({ reason: "unencrypted-connection" })),
    ).toBe(
      "Secrets can only be sent over an encrypted connection. Open Ryco on the computer it runs on, or connect over HTTPS or Tailscale.",
    );
    // A transport or encoding error could describe the payload: generic copy instead.
    const leaky = new Error(`Expected a string, got "${VALUE}"`);
    expect(secretRequestFailureText(leaky)).not.toContain(VALUE);
    expect(secretRequestFailureText({ _tag: "ParseError", message: VALUE })).not.toContain(VALUE);
    expect(secretRequestFailureText(undefined)).toBe(
      "Could not answer the request. Check the connection and try again.",
    );
  });

  it("lets only the owner answer, on a node that supports it and a ready connection", () => {
    const ready = { nodeSupports: true, mutationReady: true } as const;
    expect(secretRequestAnswerAccess({ ...ready, role: "owner" })).toEqual({
      canAnswer: true,
      reason: null,
    });
    for (const role of ["operator", "viewer", undefined] as const) {
      expect(secretRequestAnswerAccess({ ...ready, role }).canAnswer, String(role)).toBe(false);
    }
    expect(secretRequestAnswerAccess({ ...ready, role: "owner", nodeSupports: false }).reason).toBe(
      "Update this node to answer secret requests.",
    );
    expect(
      secretRequestAnswerAccess({
        ...ready,
        role: "owner",
        mutationReady: false,
        mutationReason: "Reconnecting…",
      }),
    ).toEqual({ canAnswer: false, reason: "Reconnecting…" });
  });

  it("says where the value went", () => {
    expect(secretRequestOutcomeText(requested.payload, "provided")).toBe(
      "Saved OPENAI_API_KEY to .env.local",
    );
    expect(secretRequestOutcomeText(requested.payload, "declined")).toBe("Declined OPENAI_API_KEY");
  });

  it("promises only what is true: the agent's code on the node can read the file", () => {
    const note = secretRequestPrivacyNote(".env.local");
    expect(note).toBe(
      "Written to .env.local on your node, where the agent's code can read it. Not kept in the chat.",
    );
    expect(note).not.toMatch(/never shown/iu);
  });
});
