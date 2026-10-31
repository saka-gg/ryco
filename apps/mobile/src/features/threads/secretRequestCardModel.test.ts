import { SecretRequestId, ThreadId, type EnvironmentApi } from "@ryco/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { SecretRequestError } from "@ryco/contracts";

import {
  answerThreadSecretRequest,
  mobileSecretRequestCards,
  SecretRequestUnavailableError,
  sendSecretRequestAnswer,
} from "./secretRequestCardModel";

const threadId = ThreadId.make("thread-1");
const requestId = SecretRequestId.make(`secret-request-${"d".repeat(32)}`);
const VALUE = ["typed", "on", "the", "phone"].join("-");
const activities = [
  {
    id: "requested",
    kind: "secret.requested",
    createdAt: "2026-10-31T08:00:00.000Z",
    turnId: "turn-1",
    payload: {
      requestId,
      key: "SUPABASE_KEY",
      purpose: "Read the database",
      file: ".env",
      expiresAt: "2026-11-01T08:00:00.000Z",
      checkoutId: "c".repeat(32),
    },
  },
];
const now = Date.parse("2026-10-31T09:00:00.000Z");

describe("mobile secret request cards", () => {
  it("lists the thread's unanswered requests and lets the owner answer them", () => {
    const view = mobileSecretRequestCards({
      activities,
      nowMs: now,
      nodeSupports: true,
      role: "owner",
      mutationReady: true,
      promptsDisabled: false,
    });
    expect(view.requests.map((request) => request.key)).toEqual(["SUPABASE_KEY"]);
    expect(view.access).toEqual({ canAnswer: true, reason: null });
  });

  it("keeps the card read-only for other roles, cached views and older nodes", () => {
    const base = {
      activities,
      nowMs: now,
      nodeSupports: true,
      role: "owner" as const,
      mutationReady: true,
      promptsDisabled: false,
    };
    // A direct pairing that is not the node's owner is a viewer to it.
    for (const role of ["client", "operator", "viewer", undefined] as const) {
      expect(mobileSecretRequestCards({ ...base, role }).access.canAnswer, String(role)).toBe(
        false,
      );
    }
    expect(mobileSecretRequestCards({ ...base, promptsDisabled: true }).access).toEqual({
      canAnswer: false,
      reason: "Reconnect to answer.",
    });
    expect(mobileSecretRequestCards({ ...base, nodeSupports: false }).access.canAnswer).toBe(false);
    expect(mobileSecretRequestCards({ ...base, activities: undefined }).requests).toEqual([]);
    expect(
      mobileSecretRequestCards({ ...base, nowMs: Date.parse("2026-11-01T08:00:00.000Z") }).requests,
    ).toEqual([]);
  });

  it("sends the trimmed value once, and nothing for a blank one", async () => {
    const answerSecretRequest = vi.fn(async () => ({
      status: "provided" as const,
      file: ".env",
      key: "SUPABASE_KEY",
    }));
    const api = { threads: { answerSecretRequest } } as unknown as Pick<EnvironmentApi, "threads">;
    await expect(
      answerThreadSecretRequest({
        api,
        threadId,
        requestId,
        answer: { type: "provide", value: `${VALUE}\n` },
      }),
    ).resolves.toMatchObject({ status: "provided" });
    expect(answerSecretRequest).toHaveBeenCalledTimes(1);
    expect(answerSecretRequest).toHaveBeenCalledWith({
      threadId,
      requestId,
      answer: { type: "provide", value: VALUE },
    });
    await expect(
      answerThreadSecretRequest({
        api,
        threadId,
        requestId,
        answer: { type: "provide", value: " " },
      }),
    ).resolves.toBeNull();
    expect(answerSecretRequest).toHaveBeenCalledTimes(1);
  });

  it("refuses on a node without the answer RPC", async () => {
    await expect(
      answerThreadSecretRequest({
        api: { threads: {} } as unknown as Pick<EnvironmentApi, "threads">,
        threadId,
        requestId,
        answer: { type: "decline" },
      }),
    ).rejects.toBeInstanceOf(SecretRequestUnavailableError);
  });
});

describe("the card's send", () => {
  it("turns every outcome into a result, never a throw, and never echoes the value", async () => {
    const answered = await sendSecretRequestAnswer({
      api: () =>
        ({
          threads: {
            answerSecretRequest: async () => ({
              status: "declined" as const,
              file: ".env",
              key: "SUPABASE_KEY",
            }),
          },
        }) as unknown as Pick<EnvironmentApi, "threads">,
      threadId,
      requestId,
      answer: { type: "decline" },
    });
    expect(answered).toEqual({ kind: "answered", outcome: "declined" });

    const refused = await sendSecretRequestAnswer({
      api: () =>
        ({
          threads: {
            answerSecretRequest: async () => {
              throw new SecretRequestError({ reason: "not-ignored" });
            },
          },
        }) as unknown as Pick<EnvironmentApi, "threads">,
      threadId,
      requestId,
      answer: { type: "provide", value: VALUE },
    });
    expect(refused).toEqual({
      kind: "failed",
      error: "Git does not ignore that file, so Ryco will not write a secret there.",
    });

    // A value sent over an unencrypted connection: the node's words, shown on the card as is
    // (the card keeps the typed value; it clears it only once the node took it).
    const unencrypted = await sendSecretRequestAnswer({
      api: () =>
        ({
          threads: {
            answerSecretRequest: async () => {
              throw new SecretRequestError({ reason: "unencrypted-connection" });
            },
          },
        }) as unknown as Pick<EnvironmentApi, "threads">,
      threadId,
      requestId,
      answer: { type: "provide", value: VALUE },
    });
    expect(unencrypted).toEqual({
      kind: "failed",
      error:
        "Secrets need an end-to-end encrypted connection: update the app, open Ryco on the computer it runs on, or connect to that computer over HTTPS or Tailscale.",
    });

    // No connection: finding the API throws, and the transport's text is never shown.
    const offline = await sendSecretRequestAnswer({
      api: () => {
        throw new Error(`socket closed while sending ${VALUE}`);
      },
      threadId,
      requestId,
      answer: { type: "provide", value: VALUE },
    });
    expect(offline.kind).toBe("failed");
    expect(JSON.stringify(offline)).not.toContain(VALUE);
    expect(
      await sendSecretRequestAnswer({
        api: () => ({ threads: {} }) as unknown as Pick<EnvironmentApi, "threads">,
        threadId,
        requestId,
        answer: { type: "provide", value: "  " },
      }),
    ).toEqual({ kind: "nothing" });
  });
});
