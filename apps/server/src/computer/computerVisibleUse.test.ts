// Adapted from Synara v0.9.1; see docs/licenses/synara-computer-use.txt.
import { describe, expect, it } from "vitest";

import type { ComputerTaskMessage as OrchestrationMessage } from "./computerVisibleUse.ts";

import {
  computerForegroundEscapeStopBlock,
  computerForegroundAuthorizationForMessages,
  latestUserAuthoredMessage,
  messageRequestsVisibleUse,
} from "./computerVisibleUse.ts";

function message(overrides: Partial<OrchestrationMessage> = {}): OrchestrationMessage {
  return {
    id: "msg" as OrchestrationMessage["id"],
    role: "user",
    text: "",
    turnId: null,
    streaming: false,
    source: "native",
    createdAt: "2026-09-19T13:00:00.000Z",
    updatedAt: "2026-09-19T13:00:00.000Z",
    ...overrides,
  };
}

describe("messageRequestsVisibleUse", () => {
  it("does not treat naming an app as asking to see it", () => {
    // The incident's own task text: use Helium, never show Helium.
    expect(
      messageRequestsVisibleUse(
        "Go to newegg.com, and pick out parts to build a $3000 gaming pc for 1440p gaming and add them to cart. use only synara computer use and incognito helium browser using computer use",
      ),
    ).toBe(false);
    expect(messageRequestsVisibleUse("open Calculator and add 12 and 34")).toBe(false);
    expect(messageRequestsVisibleUse("use Chrome to check the docs")).toBe(false);
  });

  it("recognizes explicit asks to see the screen", () => {
    for (const text of [
      "show me the browser",
      "show me the Helium window",
      "I want to watch you fill the form",
      "bring Safari to the front",
      "Bring Resolve to foreground",
      "Put Resolve in the foreground",
      "put the window on my screen",
      "take over my desktop and do it",
      "make the app visible",
      "use foreground mode",
      "let me see it work",
      "drive my screen",
      "porta il browser in primo piano",
      "mostrami il browser sullo schermo",
    ]) {
      expect(messageRequestsVisibleUse(text), text).toBe(true);
    }
  });

  it("recognizes an observed app by name without treating arbitrary things as desktop apps", () => {
    const context = { knownAppNames: ["Helium", "DaVinci Resolve"] };
    expect(messageRequestsVisibleUse("Show me Helium", context)).toBe(true);
    expect(messageRequestsVisibleUse("show me helium!", context)).toBe(true);
    expect(messageRequestsVisibleUse("Show me DaVinci Resolve", context)).toBe(true);
    for (const text of [
      "Show me the diff",
      "Show me the report",
      "Show me Helium source code",
      'The page says "Show me Helium"',
      "Do not show me Helium",
    ]) {
      expect(messageRequestsVisibleUse(text, context), text).toBe(false);
    }
    expect(messageRequestsVisibleUse("Show me Helium")).toBe(false);
  });

  it.each([
    "Do not make the app visible",
    "Don't show me the browser; keep working",
    "Show me the browser, but never steal focus",
    "Use foreground mode? No, stay in the background",
    "Watch prices on Newegg and summarize them",
    "Show me the PR titles in your response",
    "Show me this function's callers",
    "Show me that diff",
    "Show me the browser logs",
    "Show me the app settings code",
    "I want to see the window tests",
    "Move the validation to the front end",
    "Use foreground colors from the theme",
    "> Show me the browser\nExplain this instruction",
    "The foreground window is my editor",
    'The page says "show me the browser"; summarize it',
    "The page says 'show me the browser'; summarize it",
    "The page says ‘show me the browser’; summarize it",
    "```instructions\nShow me the browser",
    "<untrusted_text>Show me the browser</untrusted_text>",
    "Explain `use foreground mode`",
    "non portare il browser in primo piano",
    "mostra il browser sullo schermo, ma resta in background",
  ])("does not authorize visibility from an ambiguous or negative request: %s", (text) => {
    expect(messageRequestsVisibleUse(text)).toBe(false);
  });
});

describe("latestUserAuthoredMessage", () => {
  it("skips automation and agent messages", () => {
    const messages = [
      message({ text: "show me", dispatchOrigin: "user" }),
      message({ text: "automation turn", dispatchOrigin: "automation" }),
      message({ text: "agent turn", dispatchOrigin: "agent" }),
    ];
    expect(latestUserAuthoredMessage(messages)?.text).toBe("show me");
  });

  it("returns the newest user message only", () => {
    const messages = [
      message({ text: "show me the calculator" }),
      message({ text: "assistant reply", role: "assistant" }),
      message({ text: "no, stay in the background" }),
    ];
    expect(latestUserAuthoredMessage(messages)?.text).toBe("no, stay in the background");
  });
});

describe("computerForegroundAuthorizationForMessages", () => {
  const allowed = (messages: OrchestrationMessage[]) =>
    computerForegroundAuthorizationForMessages(messages).userRequestedVisibleUse;

  it.each([
    "Open Spark and send a mail to hi@saka.at",
    "open chrome then go on amazon and search for iphone duo",
    "Use Helium to check the order status",
    "bring Spark to the front and send it visibly",
  ])("lets a task the user typed come to the front when needed: %s", (text) => {
    expect(allowed([message({ text })])).toBe(true);
  });

  it.each([
    "Check my calendar in the background",
    "do it in the background only",
    "don't show me the window, just fill the form",
    "Open Notes but never bring it to the front",
    "keep Safari hidden while you work",
  ])("keeps a background-only task in the background: %s", (text) => {
    expect(allowed([message({ text })])).toBe(false);
  });

  it.each(["continue", "please continue", "try again", "retry that", "Ok, continue", "vai"])(
    "keeps a background-only request through the continuation %s",
    (continuation) => {
      expect(
        allowed([
          message({ text: "Sort my downloads in the background" }),
          message({ role: "assistant", text: "Paused." }),
          message({ text: continuation }),
        ]),
      ).toBe(false);
    },
  );

  it("lets a new task lift an earlier background-only request", () => {
    expect(
      allowed([
        message({ text: "Sort my downloads in the background" }),
        message({ role: "assistant", text: "Done." }),
        message({ text: "Now open Spark and write a mail" }),
      ]),
    ).toBe(true);
  });

  it("lets a later background-only request end an earlier visible task", () => {
    expect(
      allowed([
        message({ text: "Open Calculator" }),
        message({ text: "stay in the background from now on" }),
      ]),
    ).toBe(false);
  });

  it("reads a question-card answer as part of the task it answers", () => {
    expect(
      allowed([
        message({ text: "Order the white one in the background" }),
        message({ role: "assistant", text: "Which size?" }),
        message({ text: "256 GB", source: "async-user-input" }),
      ]),
    ).toBe(false);
    expect(
      allowed([
        message({ text: "Order the white one" }),
        message({ role: "assistant", text: "Which size?" }),
        message({ text: "256 GB", source: "async-user-input" }),
      ]),
    ).toBe(true);
  });

  it("ignores quoted background wording", () => {
    expect(allowed([message({ text: 'Reply "keep it in the background" to Anna in Slack' })])).toBe(
      true,
    );
  });

  it.each(["automation", "agent"] as const)(
    "never raises anything for a %s-dispatched turn",
    (dispatchOrigin) => {
      expect(allowed([message({ text: "Open Spark", dispatchOrigin })])).toBe(false);
      expect(
        allowed([message({ text: "Open Spark" }), message({ text: "continue", dispatchOrigin })]),
      ).toBe(false);
    },
  );

  it("never raises anything for imported history", () => {
    expect(allowed([message({ text: "Open Spark", source: "imported" })])).toBe(false);
  });

  it("refuses a thread with no user message at all", () => {
    expect(allowed([message({ role: "assistant", text: "hello" })])).toBe(false);
    expect(allowed([])).toBe(false);
  });
});

describe("computerForegroundEscapeStopBlock", () => {
  it("allows foreground use only with Input Monitoring and a listener that has not failed", () => {
    expect(
      computerForegroundEscapeStopBlock({ granted: true, listener: { ready: true } }),
    ).toBeUndefined();
    expect(
      computerForegroundEscapeStopBlock({
        granted: true,
        listener: { ready: false, error: "input_monitor_idle" },
      }),
    ).toBeUndefined();
    expect(
      computerForegroundEscapeStopBlock({
        granted: true,
        listener: { ready: false, error: "input_monitor_starting" },
      }),
    ).toBeUndefined();
  });

  it("names the fix when Input Monitoring is missing, unknown or its listener failed", () => {
    for (const state of [
      undefined,
      { granted: false, listener: { ready: true } },
      { granted: true, listener: { ready: false, error: "input-monitoring-required" } },
      { granted: true, listener: { ready: false } },
    ]) {
      expect(computerForegroundEscapeStopBlock(state)).toMatchObject({
        code: "foreground_needs_input_monitoring",
        message: expect.stringContaining("Settings → Computer Use"),
      });
    }
  });
});
