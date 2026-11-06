import { ComputerConsentReply } from "@ryco/contracts";
import * as Schema from "effect/Schema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  COMPUTER_CONSENT_APPS_PER_TASK,
  COMPUTER_CONSENT_EXPIRY_MS,
  COMPUTER_CONSENT_OPEN_LIMIT,
  COMPUTER_CONSENT_WAIT_MS,
  ComputerConsentSheets,
  ComputerTaskConsent,
  type ComputerConsentPresenter,
  type ComputerConsentPrompt,
  type ComputerConsentRequest,
} from "./taskConsent.ts";

type Shown = Awaited<ReturnType<ComputerConsentPrompt>>;

interface Dialog {
  readonly request: ComputerConsentRequest;
  readonly signal: AbortSignal;
  answer(result: Shown): void;
}

type Target = "Safari" | "Notes" | "unnamed" | "clipboard";
const requestFor = (target: Target): ComputerConsentRequest =>
  target === "clipboard"
    ? { kind: "clipboard" }
    : target === "unnamed"
      ? { kind: "app", app: { key: "\u0000mac", name: "your Mac", canAlwaysAllow: false } }
      : { kind: "app", app: { key: target.toLowerCase(), name: target, canAlwaysAllow: true } };

const PENDING = { approved: false, outcome: "pending", retryable: true };
const ACCEPT = { approved: true, outcome: "accept", retryable: false };
const CHAT = { ...ACCEPT, scope: "chat" };
const ALWAYS = { ...ACCEPT, scope: "always" };
const DECLINE = { approved: false, outcome: "decline", retryable: false };

/**
 * A stand-in for the Electron sheet: it is on screen at once, stays open until
 * the test answers it, and closes as a Cancel when its signal fires, as
 * `showMessageBox` does.
 */
function scriptedDialogs() {
  const dialogs: Dialog[] = [];
  const show = (request: ComputerConsentRequest, signal: AbortSignal, onShown: () => void) =>
    new Promise<Shown>((resolve) => {
      onShown();
      signal.addEventListener("abort", () => resolve("decline"), { once: true });
      dialogs.push({ request, signal, answer: resolve });
    });
  return { dialogs, show };
}

/** Every reply must be one the server's strict decoder accepts. */
async function decoded(pending: Promise<ComputerConsentReply>) {
  const reply = await pending;
  expect(Schema.decodeUnknownSync(ComputerConsentReply)(reply)).toEqual(reply);
  expect(reply.approved).toBe(reply.outcome === "accept");
  return reply;
}

function fixture() {
  const controller = new AbortController();
  const { dialogs, show } = scriptedDialogs();
  const prompt = vi.fn<ComputerConsentPrompt>(show);
  const consent = new ComputerTaskConsent(prompt, controller.signal);
  const request = (target: Target = "Safari") => decoded(consent.request(requestFor(target)));
  return { controller, dialogs, prompt, consent, request };
}

/** Several tasks sharing the real one-at-a-time sheet queue. */
function sheetsFixture() {
  const { dialogs, show } = scriptedDialogs();
  const present = vi.fn<ComputerConsentPresenter>(show as unknown as ComputerConsentPresenter);
  const sheets = new ComputerConsentSheets(present);
  const task = () => {
    const controller = new AbortController();
    const consent = new ComputerTaskConsent(sheets.prompt, controller.signal);
    return {
      controller,
      request: (target: Target = "Safari") => decoded(consent.request(requestFor(target))),
    };
  };
  return { dialogs, present, sheets, task };
}

describe("ComputerTaskConsent", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("shares one dialog per app between concurrent requests and keeps no grant itself", async () => {
    const { dialogs, prompt, request } = fixture();
    const first = request();
    const second = request();
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(dialogs[0]!.request).toEqual(requestFor("Safari"));
    dialogs[0]!.answer("accept");
    expect(await first).toEqual(CHAT);
    expect(await second).toEqual(CHAT);
    // The backend remembers the answer; a later request asks the desktop again.
    const later = request();
    expect(prompt).toHaveBeenCalledTimes(2);
    dialogs[1]!.answer("always");
    expect(await later).toEqual(ALWAYS);
  });

  it("asks separately for each app", async () => {
    const { dialogs, prompt, request } = fixture();
    const safari = request("Safari");
    const notes = request("Notes");
    expect(prompt).toHaveBeenCalledTimes(2);
    dialogs[1]!.answer("decline");
    dialogs[0]!.answer("always");
    expect(await notes).toEqual(DECLINE);
    expect(await safari).toEqual(ALWAYS);
  });

  it("never reports Always allow for a target it could not name", async () => {
    const { dialogs, request } = fixture();
    const unnamed = request("unnamed");
    dialogs[0]!.answer("always");
    expect(await unnamed).toEqual(CHAT);
  });

  it("keeps an answer that lands after every request stopped waiting for the next request", async () => {
    const { dialogs, prompt, request } = fixture();
    const first = request();
    await vi.advanceTimersByTimeAsync(COMPUTER_CONSENT_WAIT_MS);
    expect(await first).toEqual(PENDING);
    dialogs[0]!.answer("always");
    await vi.advanceTimersByTimeAsync(0);
    expect(await request()).toEqual(ALWAYS);
    expect(prompt).toHaveBeenCalledTimes(1);
    // Claimed once: the next request opens a new dialog.
    void request();
    expect(prompt).toHaveBeenCalledTimes(2);
  });

  it("drops an uncollected answer after a desktop interruption but keeps an open dialog", async () => {
    const { consent, dialogs, prompt, request } = fixture();
    const first = request();
    await vi.advanceTimersByTimeAsync(COMPUTER_CONSENT_WAIT_MS);
    expect(await first).toEqual(PENDING);
    dialogs[0]!.answer("always");
    await vi.advanceTimersByTimeAsync(0);
    consent.discardUnclaimedAnswers();
    // The answer predates the lock: the next request asks again.
    const next = request();
    expect(prompt).toHaveBeenCalledTimes(2);
    // A dialog still open across the interruption counts when answered.
    consent.discardUnclaimedAnswers();
    dialogs[1]!.answer("accept");
    expect(await next).toEqual(CHAT);
  });

  it("refuses only the clipboard request whose dialog was cancelled", async () => {
    const { dialogs, prompt, request } = fixture();
    const clipboard = request("clipboard");
    expect(dialogs[0]!.request.kind).toBe("clipboard");
    dialogs[0]!.answer("decline");
    expect(await clipboard).toEqual(DECLINE);
    const app = request();
    dialogs[1]!.answer("accept");
    expect(await app).toEqual(CHAT);
    // A clipboard request is never covered by an app answer, nor carries a scope.
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

    // The turn stops asking about this app: no third dialog. Another app still asks.
    expect(await request()).toEqual({ approved: false, outcome: "expired", retryable: false });
    expect(prompt).toHaveBeenCalledTimes(2);
    void request("Notes");
    expect(prompt).toHaveBeenCalledTimes(3);
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
    expect(await accepted).toEqual(CHAT);
  });

  it("stops asking after three dialogs in a row could not be shown", async () => {
    const controller = new AbortController();
    const prompt = vi.fn<ComputerConsentPrompt>(async () => "unavailable");
    const consent = new ComputerTaskConsent(prompt, controller.signal);
    const unavailable = (retryable: boolean) => ({
      approved: false,
      outcome: "unavailable",
      retryable,
    });
    const safari = () => decoded(consent.request(requestFor("Safari")));
    expect(await safari()).toEqual(unavailable(true));
    expect(await safari()).toEqual(unavailable(true));
    expect(await safari()).toEqual(unavailable(false));
    // The agent was told to stop; asking again does not even try.
    expect(await safari()).toEqual(unavailable(false));
    expect(prompt).toHaveBeenCalledTimes(3);
    // Clipboard consent keeps its own count.
    expect(await decoded(consent.request(requestFor("clipboard")))).toEqual(unavailable(true));
    expect(prompt).toHaveBeenCalledTimes(4);
  });

  it("restarts the unshown count once a dialog reaches the user", async () => {
    const { dialogs, prompt, request } = fixture();
    for (const result of ["unavailable", "busy"] as const) {
      const refused = request();
      dialogs.at(-1)!.answer(result);
      expect((await refused).retryable).toBe(true);
    }
    const shown = request();
    await vi.advanceTimersByTimeAsync(COMPUTER_CONSENT_WAIT_MS);
    expect(await shown).toEqual(PENDING);
    dialogs.at(-1)!.answer("unavailable");
    await vi.advanceTimersByTimeAsync(0);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const refused = request();
      dialogs.at(-1)!.answer("busy");
      expect(await refused).toEqual({ approved: false, outcome: "busy", retryable: true });
    }
    expect(prompt).toHaveBeenCalledTimes(5);
  });

  it("gives each concurrent clipboard dialog its own expiry verdict", async () => {
    const { prompt, request } = fixture();
    const first = request("clipboard");
    const second = request("clipboard");
    await vi.advanceTimersByTimeAsync(COMPUTER_CONSENT_WAIT_MS);
    // The first expiry is the one the agent may still ask again after.
    expect(await first).toEqual({ approved: false, outcome: "expired", retryable: true });
    expect(await second).toEqual({ approved: false, outcome: "expired", retryable: false });
    expect(prompt).toHaveBeenCalledTimes(2);
  });

  it("treats a prompt that throws as unavailable", async () => {
    const controller = new AbortController();
    const prompt = vi
      .fn<ComputerConsentPrompt>()
      .mockRejectedValueOnce(new Error("window closed"))
      .mockResolvedValueOnce("accept");
    const consent = new ComputerTaskConsent(prompt, controller.signal);
    expect(await consent.request(requestFor("Safari"))).toEqual({
      approved: false,
      outcome: "unavailable",
      retryable: true,
    });
    expect(await consent.request(requestFor("Safari"))).toEqual(CHAT);
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
    dialogs[0]!.answer("always");
    controller.abort();
    expect(await first).toEqual({ approved: false, outcome: "stopped", retryable: false });
  });

  it("refuses requests for more apps than one turn may ask about", async () => {
    const controller = new AbortController();
    const prompt = vi.fn<ComputerConsentPrompt>(async () => "decline");
    const consent = new ComputerTaskConsent(prompt, controller.signal);
    for (let index = 0; index <= COMPUTER_CONSENT_APPS_PER_TASK; index += 1)
      await consent.request({
        kind: "app",
        app: { key: `app-${index}`, name: `App ${index}`, canAlwaysAllow: true },
      });
    expect(
      await consent.request({
        kind: "app",
        app: { key: "one-more", name: "One more", canAlwaysAllow: true },
      }),
    ).toEqual({ approved: false, outcome: "busy", retryable: false });
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
    // App approval still has its own dialog and its own re-request.
    const app = request();
    expect(prompt).toHaveBeenCalledTimes(3);
    dialogs[2]!.answer("accept");
    expect(await app).toEqual(CHAT);
  });
});

describe("ComputerConsentSheets", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows one dialog at a time and starts a queued dialog's lifetime when it appears", async () => {
    const { dialogs, present, task } = sheetsFixture();
    const first = task();
    const second = task();
    const firstRequest = first.request();
    const queued = second.request();
    await vi.advanceTimersByTimeAsync(0);
    expect(present).toHaveBeenCalledTimes(1);

    // The second task waits behind the first sheet without spending its five minutes.
    await vi.advanceTimersByTimeAsync(COMPUTER_CONSENT_WAIT_MS);
    expect(await firstRequest).toEqual(PENDING);
    expect(await queued).toEqual(PENDING);
    await vi.advanceTimersByTimeAsync(4 * 60_000);
    const answered = first.request();
    dialogs[0]!.answer("accept");
    expect(await answered).toEqual(CHAT);
    await vi.advanceTimersByTimeAsync(0);
    expect(present).toHaveBeenCalledTimes(2);
    expect(dialogs[1]!.signal.aborted).toBe(false);

    // Its full lifetime runs from the moment it is on screen.
    const waiting = second.request();
    await vi.advanceTimersByTimeAsync(COMPUTER_CONSENT_EXPIRY_MS - 1_000);
    expect(dialogs[1]!.signal.aborted).toBe(false);
    expect(await waiting).toEqual(PENDING);
    const late = second.request();
    dialogs[1]!.answer("accept");
    expect(await late).toEqual(CHAT);
  });

  it("reports a clipboard dialog that never reached the screen as busy, not expired", async () => {
    const { dialogs, present, task } = sheetsFixture();
    const holder = task();
    const asker = task();
    const held = holder.request();
    await vi.advanceTimersByTimeAsync(0);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const clipboard = asker.request("clipboard");
      await vi.advanceTimersByTimeAsync(COMPUTER_CONSENT_WAIT_MS);
      expect(await clipboard).toEqual({ approved: false, outcome: "busy", retryable: true });
    }
    expect(present).toHaveBeenCalledTimes(1);
    dialogs[0]!.answer("decline");
    await held;

    // Neither unseen dialog used up the clipboard re-request.
    for (const expected of [true, false]) {
      const clipboard = asker.request("clipboard");
      await vi.advanceTimersByTimeAsync(COMPUTER_CONSENT_WAIT_MS);
      expect(await clipboard).toEqual({
        approved: false,
        outcome: "expired",
        retryable: expected,
      });
    }
    expect(present).toHaveBeenCalledTimes(3);
  });

  it("keeps the queue order when a waiting dialog leaves early", async () => {
    const { dialogs, present, task } = sheetsFixture();
    const showing = task();
    const leaving = task();
    const last = task();
    const shown = showing.request();
    const left = leaving.request();
    const behind = last.request();
    await vi.advanceTimersByTimeAsync(0);
    leaving.controller.abort();
    expect(await left).toEqual({ approved: false, outcome: "stopped", retryable: false });
    await vi.advanceTimersByTimeAsync(0);
    // The first sheet is still on screen, so the third must keep waiting.
    expect(present).toHaveBeenCalledTimes(1);
    dialogs[0]!.answer("accept");
    expect(await shown).toEqual(CHAT);
    await vi.advanceTimersByTimeAsync(0);
    expect(present).toHaveBeenCalledTimes(2);
    dialogs[1]!.answer("accept");
    expect(await behind).toEqual(CHAT);
  });

  it("refuses a dialog beyond the open limit without queueing it", async () => {
    const { present, task } = sheetsFixture();
    const tasks = Array.from({ length: COMPUTER_CONSENT_OPEN_LIMIT }, () => task());
    for (const each of tasks) void each.request();
    await vi.advanceTimersByTimeAsync(0);
    expect(await task().request()).toEqual({ approved: false, outcome: "busy", retryable: true });
    expect(present).toHaveBeenCalledTimes(1);
    for (const each of tasks) each.controller.abort();
    await vi.advanceTimersByTimeAsync(0);
  });
});
