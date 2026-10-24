import { ComputerConsentReply } from "@ryco/contracts";
import * as Schema from "effect/Schema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  COMPUTER_CONSENT_EXPIRY_MS,
  COMPUTER_CONSENT_WAIT_MS,
  ComputerTaskConsent,
  type ComputerConsentKind,
  type ComputerConsentPrompt,
} from "./taskConsent.ts";

type Shown = Awaited<ReturnType<ComputerConsentPrompt>>;

interface Dialog {
  readonly kind: ComputerConsentKind;
  readonly signal: AbortSignal;
  answer(result: Shown): void;
}

const PENDING = { approved: false, outcome: "pending", retryable: true };
const ACCEPT = { approved: true, outcome: "accept", retryable: false };
const DECLINE = { approved: false, outcome: "decline", retryable: false };

/**
 * A stand-in for the Electron sheet: it stays open until the test answers it,
 * and closes as a Cancel when its signal fires, as `showMessageBox` does.
 */
function fixture() {
  const controller = new AbortController();
  const dialogs: Dialog[] = [];
  const prompt = vi.fn<ComputerConsentPrompt>(
    (kind, signal) =>
      new Promise<Shown>((resolve) => {
        signal.addEventListener("abort", () => resolve("decline"), { once: true });
        dialogs.push({ kind, signal, answer: resolve });
      }),
  );
  const consent = new ComputerTaskConsent(prompt, controller.signal);
  /** Every reply must be one the server's strict decoder accepts. */
  const request = async (kind: ComputerConsentKind = "task") => {
    const reply = await consent.request(kind);
    expect(Schema.decodeUnknownSync(ComputerConsentReply)(reply)).toEqual(reply);
    expect(reply.approved).toBe(reply.outcome === "accept");
    return reply;
  };
  return { controller, dialogs, prompt, consent, request };
}

describe("ComputerTaskConsent", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("shares one routine dialog between concurrent requests and keeps the accept for the turn", async () => {
    const { dialogs, prompt, request } = fixture();
    const first = request();
    const second = request();
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(dialogs[0]!.kind).toBe("task");
    dialogs[0]!.answer("accept");
    expect(await first).toEqual(ACCEPT);
    expect(await second).toEqual(ACCEPT);
    expect(await request()).toEqual(ACCEPT);
    expect(prompt).toHaveBeenCalledTimes(1);
  });

  it("binds the turn on a routine Cancel and refuses clipboard access without another dialog", async () => {
    const { dialogs, prompt, request } = fixture();
    const first = request();
    dialogs[0]!.answer("decline");
    expect(await first).toEqual(DECLINE);
    expect(await request()).toEqual(DECLINE);
    expect(await request("clipboard")).toEqual(DECLINE);
    expect(prompt).toHaveBeenCalledTimes(1);
  });

  it("refuses only the clipboard request whose dialog was cancelled", async () => {
    const { dialogs, prompt, request } = fixture();
    const clipboard = request("clipboard");
    expect(dialogs[0]!.kind).toBe("clipboard");
    dialogs[0]!.answer("decline");
    expect(await clipboard).toEqual(DECLINE);
    const routine = request();
    dialogs[1]!.answer("accept");
    expect(await routine).toEqual(ACCEPT);
    // A clipboard request is never covered by the routine accept.
    const again = request("clipboard");
    expect(prompt).toHaveBeenCalledTimes(3);
    dialogs[2]!.answer("accept");
    expect(await again).toEqual(ACCEPT);
  });

  it("keeps an unanswered dialog open across requests and allows one re-request after it expires", async () => {
    const { dialogs, prompt, request } = fixture();
    const first = request();
    await vi.advanceTimersByTimeAsync(COMPUTER_CONSENT_WAIT_MS);
    expect(await first).toEqual(PENDING);
    expect(dialogs[0]!.signal.aborted).toBe(false);

    // The next call joins the same dialog instead of stacking another one.
    const joined = request();
    expect(prompt).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(COMPUTER_CONSENT_WAIT_MS);
    expect(await joined).toEqual(PENDING);

    // t = 290 s: this call is still waiting when the dialog closes at 300 s.
    await vi.advanceTimersByTimeAsync(
      COMPUTER_CONSENT_EXPIRY_MS - 2 * COMPUTER_CONSENT_WAIT_MS - 10_000,
    );
    const expiring = request();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(dialogs[0]!.signal.aborted).toBe(true);
    expect(await expiring).toEqual({ approved: false, outcome: "expired", retryable: true });
    expect(prompt).toHaveBeenCalledTimes(1);

    // The one re-request opens a fresh dialog.
    const reRequest = request();
    expect(prompt).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(COMPUTER_CONSENT_WAIT_MS);
    expect(await reRequest).toEqual(PENDING);
    await vi.advanceTimersByTimeAsync(
      COMPUTER_CONSENT_EXPIRY_MS - COMPUTER_CONSENT_WAIT_MS - 25_000,
    );
    const lastWaiter = request();
    await vi.advanceTimersByTimeAsync(25_000);
    expect(dialogs[1]!.signal.aborted).toBe(true);
    expect(await lastWaiter).toEqual({ approved: false, outcome: "expired", retryable: false });

    // The turn stops asking: no third dialog.
    expect(await request()).toEqual({ approved: false, outcome: "expired", retryable: false });
    expect(prompt).toHaveBeenCalledTimes(2);
  });

  it("counts an Allow given while a lock or listener restart revoked consent", async () => {
    const { consent, dialogs, prompt, request } = fixture();
    const first = request();
    consent.revokeGrant();
    dialogs[0]!.answer("accept");
    expect(await first).toEqual(ACCEPT);
    expect(await request()).toEqual(ACCEPT);
    expect(prompt).toHaveBeenCalledTimes(1);
  });

  it("asks again after an interruption revoked an accepted consent", async () => {
    const { consent, dialogs, prompt, request } = fixture();
    const first = request();
    dialogs[0]!.answer("accept");
    expect(await first).toEqual(ACCEPT);
    consent.revokeGrant();
    const second = request();
    expect(prompt).toHaveBeenCalledTimes(2);
    dialogs[1]!.answer("accept");
    expect(await second).toEqual(ACCEPT);
  });

  it("does not bind the turn when no dialog could be shown", async () => {
    const { dialogs, request } = fixture();
    const unavailable = request();
    dialogs[0]!.answer("unavailable");
    expect(await unavailable).toEqual({ approved: false, outcome: "unavailable", retryable: true });
    const busy = request();
    dialogs[1]!.answer("busy");
    expect(await busy).toEqual({ approved: false, outcome: "busy", retryable: true });
    const accepted = request();
    dialogs[2]!.answer("accept");
    expect(await accepted).toEqual(ACCEPT);
  });

  it("treats a prompt that throws as unavailable", async () => {
    const controller = new AbortController();
    const prompt = vi
      .fn<ComputerConsentPrompt>()
      .mockRejectedValueOnce(new Error("window closed"))
      .mockResolvedValueOnce("accept");
    const consent = new ComputerTaskConsent(prompt, controller.signal);
    expect(await consent.request("task")).toEqual({
      approved: false,
      outcome: "unavailable",
      retryable: true,
    });
    expect(await consent.request("task")).toEqual(ACCEPT);
  });

  it("closes an open dialog when the task stops and refuses later requests", async () => {
    const { controller, dialogs, prompt, request } = fixture();
    const first = request();
    controller.abort();
    expect(dialogs[0]!.signal.aborted).toBe(true);
    expect(await first).toEqual({ approved: false, outcome: "stopped", retryable: false });
    expect(await request()).toEqual({ approved: false, outcome: "stopped", retryable: false });
    expect(await request("clipboard")).toEqual({
      approved: false,
      outcome: "stopped",
      retryable: false,
    });
    expect(prompt).toHaveBeenCalledTimes(1);
  });

  it("an Allow on a stopped task does not approve", async () => {
    const { controller, dialogs, request } = fixture();
    const first = request();
    dialogs[0]!.answer("accept");
    controller.abort();
    expect(await first).toEqual({ approved: false, outcome: "stopped", retryable: false });
  });

  it("closes a clipboard dialog after one request's wait and counts its expiry separately", async () => {
    const { dialogs, prompt, request } = fixture();
    const first = request("clipboard");
    await vi.advanceTimersByTimeAsync(COMPUTER_CONSENT_WAIT_MS);
    expect(dialogs[0]!.signal.aborted).toBe(true);
    expect(await first).toEqual({ approved: false, outcome: "expired", retryable: true });
    const second = request("clipboard");
    await vi.advanceTimersByTimeAsync(COMPUTER_CONSENT_WAIT_MS);
    expect(await second).toEqual({ approved: false, outcome: "expired", retryable: false });
    expect(await request("clipboard")).toEqual({
      approved: false,
      outcome: "expired",
      retryable: false,
    });
    expect(prompt).toHaveBeenCalledTimes(2);
    // Routine consent still has its own dialog and its own re-request.
    const routine = request();
    expect(prompt).toHaveBeenCalledTimes(3);
    dialogs[2]!.answer("accept");
    expect(await routine).toEqual(ACCEPT);
  });
});
