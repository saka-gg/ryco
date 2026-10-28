import type { DesktopQuitRunningChat } from "@ryco/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  buildRunningChatsQuitDialog,
  createQuitGuardRequester,
  createRunningChatsQuitConfirmation,
  createSystemShutdownNotice,
  parseQuitGuardReply,
  parseRunningChatsReport,
  QUIT_CONTINUE_SETTING_TIMEOUT_MS,
  QUIT_RUNNING_CHATS_TIMEOUT_MS,
  type QuitDialogOptions,
  type QuitGuardRequestOutcome,
  type QuitRunningChats,
  sanitizeChatTitle,
} from "./quitConfirmation.ts";
import type { QuitGuardRequest, QuitGuardRequestBody } from "./quitGuardChannels.ts";

type KnownReport = Extract<QuitRunningChats, { kind: "known" }>;

function chat(index: number, overrides: Partial<DesktopQuitRunningChat> = {}) {
  return { threadId: `thread-${index}`, title: `Chat ${index}`, status: "working", ...overrides };
}

function knownReport(overrides: Partial<KnownReport> = {}): KnownReport {
  const chats = overrides.chats ?? [chat(1) as DesktopQuitRunningChat];
  return {
    kind: "known",
    runningCount: chats.length,
    resumableCount: chats.filter((entry) => entry.status === "working").length,
    chats,
    otherNodesRunningCount: 0,
    continueThreadsAfterRestart: false,
    ...overrides,
  };
}

describe("sanitizeChatTitle", () => {
  it("puts a title on one line without control characters", () => {
    expect(sanitizeChatTitle("Fix\nthe\tbuild\u0007  now\u2028please\u0085")).toBe(
      "Fix the build now please",
    );
    expect(sanitizeChatTitle("  padded  ")).toBe("padded");
  });

  it("drops bidi and other format characters but keeps emoji joiners", () => {
    // U+202E reverses the rest of the line; U+2066..U+2069 isolate it.
    expect(sanitizeChatTitle("invoice\u202Etxt.exe")).toBe("invoicetxt.exe");
    expect(sanitizeChatTitle("a\u2066b\u2069c\u200Ed\u200Fe\uFEFF\u00ADf")).toBe("abcdef");
    const family = "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}";
    expect(sanitizeChatTitle(`Plan ${family}`)).toBe(`Plan ${family}`);
  });

  it("replaces lone surrogates", () => {
    expect(sanitizeChatTitle("broken \uD800 text")).toBe("broken \uFFFD text");
  });

  it("cuts long titles at 80 code points without splitting an emoji", () => {
    const long = `${"a".repeat(78)}\u{1F600}\u{1F600}\u{1F600}`;
    const cut = sanitizeChatTitle(long);
    expect(Array.from(cut)).toHaveLength(80);
    expect(cut).toBe(`${"a".repeat(78)}\u{1F600}…`);
    expect(sanitizeChatTitle("b".repeat(80))).toBe("b".repeat(80));
  });

  it("names an empty title", () => {
    expect(sanitizeChatTitle("")).toBe("Untitled chat");
    expect(sanitizeChatTitle(" \n\t\u202E ")).toBe("Untitled chat");
  });
});

describe("parseRunningChatsReport", () => {
  it("reads malformed answers as invalid", () => {
    expect(parseRunningChatsReport(null).kind).toBe("invalid");
    expect(parseRunningChatsReport("known").kind).toBe("invalid");
    expect(parseRunningChatsReport({ status: "known" }).kind).toBe("invalid");
    for (const runningCount of [-1, Number.NaN, 1.5, Number.POSITIVE_INFINITY, "2"]) {
      expect(
        parseRunningChatsReport({
          status: "known",
          runningCount,
          chats: [],
          otherNodesRunningCount: 0,
        }).kind,
      ).toBe("invalid");
    }
    expect(
      parseRunningChatsReport({
        status: "known",
        runningCount: 0,
        chats: [],
        otherNodesRunningCount: -2,
      }).kind,
    ).toBe("invalid");
  });

  it("passes unknown and unavailable through", () => {
    expect(parseRunningChatsReport({ status: "unknown" })).toEqual({ kind: "unknown" });
    expect(parseRunningChatsReport({ status: "unavailable" })).toEqual({ kind: "unavailable" });
  });

  it("keeps at most 8 valid chats and never counts fewer than it lists", () => {
    const chats = Array.from({ length: 12 }, (_, index) => chat(index));
    const report = parseRunningChatsReport({
      status: "known",
      runningCount: 3,
      resumableCount: 3,
      chats: [{ threadId: "", title: "no id" }, { title: "missing" }, ...chats],
      otherNodesRunningCount: 2,
      continueThreadsAfterRestart: true,
    });
    expect(report).toMatchObject({
      kind: "known",
      runningCount: 8,
      resumableCount: 3,
      otherNodesRunningCount: 2,
      continueThreadsAfterRestart: true,
    });
    expect(report.kind === "known" && report.chats.map((entry) => entry.threadId)).toEqual(
      chats.slice(0, 8).map((entry) => entry.threadId),
    );
  });

  it("sanitizes titles, lists unknown statuses as not continued and caps the resumable count", () => {
    const report = parseRunningChatsReport({
      status: "known",
      runningCount: 2,
      resumableCount: 9,
      chats: [
        { threadId: "a", title: "line\nbreak", status: "mystery" },
        { threadId: "b", title: 42, status: "approval" },
      ],
      otherNodesRunningCount: 0,
      continueThreadsAfterRestart: "yes",
    });
    expect(report).toEqual({
      kind: "known",
      runningCount: 2,
      resumableCount: 2,
      chats: [
        { threadId: "a", title: "line break", status: "connecting" },
        { threadId: "b", title: "Untitled chat", status: "approval" },
      ],
      otherNodesRunningCount: 0,
      continueThreadsAfterRestart: null,
    });
  });

  it("promises no continuation when the resumable count is missing", () => {
    const report = parseRunningChatsReport({
      status: "known",
      runningCount: 2,
      chats: [chat(1), { ...chat(2), status: "mystery" }],
      otherNodesRunningCount: 0,
      continueThreadsAfterRestart: false,
    });
    expect(report.kind === "known" && report.resumableCount).toBe(0);
    expect(report.kind === "known" && report.chats.map((entry) => entry.status)).toEqual([
      "working",
      "connecting",
    ]);
    const plan = buildRunningChatsQuitDialog({
      appName: "Ryco",
      report: report as KnownReport,
    });
    expect(plan.offersContinue).toBe(false);
    expect(plan.options.detail).toBe(["Quitting stops them:", "• Chat 1", "• Chat 2"].join("\n"));
  });
});

describe("buildRunningChatsQuitDialog", () => {
  it("asks about one working chat and offers to continue it", () => {
    const plan = buildRunningChatsQuitDialog({ appName: "Ryco", report: knownReport() });
    expect(plan.quitResponse).toBe(0);
    expect(plan.offersContinue).toBe(true);
    expect(plan.options).toEqual({
      type: "warning",
      title: "Quit Ryco",
      message: "Quit Ryco while 1 chat is still running?",
      detail: [
        "Quitting stops it:",
        "• Chat 1",
        "",
        "If you check the box and Ryco starts again within 30 minutes, it tries to continue this chat. This turns on “Continue after restart” in Settings.",
      ].join("\n"),
      buttons: ["Quit", "Cancel"],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
      checkboxLabel: "Try to continue this chat when Ryco starts again",
      checkboxChecked: false,
    });
  });

  it("lists 8 of 10 chats, marks waiting ones and counts the rest", () => {
    const chats = [
      chat(1, { status: "approval" }),
      chat(2, { status: "input" }),
      ...Array.from({ length: 6 }, (_, index) => chat(index + 3)),
    ] as DesktopQuitRunningChat[];
    const plan = buildRunningChatsQuitDialog({
      appName: "Ryco",
      report: knownReport({ chats, runningCount: 10, resumableCount: 8 }),
    });
    expect(plan.options.message).toBe("Quit Ryco while 10 chats are still running?");
    const lines = plan.options.detail.split("\n");
    expect(lines[0]).toBe("Quitting stops them:");
    expect(lines[1]).toBe("• Chat 1 (waiting for your approval)");
    expect(lines[2]).toBe("• Chat 2 (waiting for your answer)");
    expect(lines[9]).toBe("• and 2 more");
    expect(lines.at(-1)).toBe(
      "If you check the box and Ryco starts again within 30 minutes, it tries to continue the 8 chats that are working. This turns on “Continue after restart” in Settings. Chats waiting for your approval or answer are not continued.",
    );
    expect(plan.options.checkboxLabel).toBe(
      "Try to continue the 8 chats that are working when Ryco starts again",
    );
  });

  it("uses the plural for several chats that can all be continued", () => {
    const plan = buildRunningChatsQuitDialog({
      appName: "Ryco",
      report: knownReport({ chats: [chat(1), chat(2)] as DesktopQuitRunningChat[] }),
    });
    expect(plan.options.checkboxLabel).toBe("Try to continue these chats when Ryco starts again");
    expect(plan.options.detail).toContain("it tries to continue these chats.");
  });

  it("offers no checkbox when every chat waits for a person", () => {
    const plan = buildRunningChatsQuitDialog({
      appName: "Ryco",
      report: knownReport({
        chats: [chat(1, { status: "approval" }), chat(2, { status: "input" })] as never,
        resumableCount: 0,
      }),
    });
    expect(plan.offersContinue).toBe(false);
    expect(plan.options.checkboxLabel).toBeUndefined();
    expect(plan.options.checkboxChecked).toBeUndefined();
    expect(plan.options.detail).not.toContain("continue");
  });

  it("names one working chat among waiting ones", () => {
    const plan = buildRunningChatsQuitDialog({
      appName: "Ryco",
      report: knownReport({
        chats: [chat(1), chat(2, { status: "approval" })] as DesktopQuitRunningChat[],
      }),
    });
    expect(plan.options.checkboxLabel).toBe(
      "Try to continue the chat that is working when Ryco starts again",
    );
  });

  it("names why the other chats are not continued only when it knows every one of them", () => {
    const starting = buildRunningChatsQuitDialog({
      appName: "Ryco",
      report: knownReport({
        chats: [chat(1), chat(2, { status: "connecting" })] as DesktopQuitRunningChat[],
      }),
    });
    expect(starting.options.detail).not.toContain("approval or answer");
    expect(starting.options.detail.split("\n").at(-1)).toMatch(
      / Other chats are not continued\.$/u,
    );

    const mixed = buildRunningChatsQuitDialog({
      appName: "Ryco",
      report: knownReport({
        chats: [
          chat(1),
          chat(2, { status: "approval" }),
          chat(3, { status: "connecting" }),
        ] as DesktopQuitRunningChat[],
      }),
    });
    expect(mixed.options.detail).not.toContain("approval or answer");
    expect(mixed.options.detail).toContain(" Other chats are not continued.");

    // Two of the three chats it does not continue are not listed: their statuses are unknown.
    const unlisted = buildRunningChatsQuitDialog({
      appName: "Ryco",
      report: knownReport({
        chats: [chat(1), chat(2, { status: "input" })] as DesktopQuitRunningChat[],
        runningCount: 4,
        resumableCount: 1,
      }),
    });
    expect(unlisted.options.detail).not.toContain("approval or answer");
    expect(unlisted.options.detail).toContain(" Other chats are not continued.");

    const waiting = buildRunningChatsQuitDialog({
      appName: "Ryco",
      report: knownReport({
        chats: [chat(1), chat(2, { status: "input" })] as DesktopQuitRunningChat[],
      }),
    });
    expect(waiting.options.detail).toContain(
      " Chats waiting for your approval or answer are not continued.",
    );
  });

  it("promises to try, never that a chat is continued, since the node may skip one", () => {
    // A delegated task or a turn that used computer control is `working` but not continued.
    for (const continueThreadsAfterRestart of [false, true, null]) {
      const plan = buildRunningChatsQuitDialog({
        appName: "Ryco",
        report: knownReport({ continueThreadsAfterRestart }),
      });
      expect(plan.options.detail).toContain("it tries to continue this chat");
      expect(plan.options.detail).not.toMatch(/it continues|to continue this chat if/u);
      expect(plan.options.checkboxLabel).toBe(
        continueThreadsAfterRestart === true
          ? undefined
          : "Try to continue this chat when Ryco starts again",
      );
    }
  });

  it("only informs while the setting is already on, so the dialog never turns it off", () => {
    const plan = buildRunningChatsQuitDialog({
      appName: "Ryco",
      report: knownReport({ continueThreadsAfterRestart: true }),
    });
    expect(plan.offersContinue).toBe(false);
    expect(plan.options.checkboxLabel).toBeUndefined();
    expect(plan.options.detail.split("\n").at(-1)).toBe(
      "If Ryco starts again within 30 minutes, it tries to continue this chat (“Continue after restart” in Settings).",
    );
  });

  it("treats a setting it could not read as off", () => {
    const plan = buildRunningChatsQuitDialog({
      appName: "Ryco",
      report: knownReport({ continueThreadsAfterRestart: null }),
    });
    expect(plan.offersContinue).toBe(true);
    expect(plan.options.checkboxChecked).toBe(false);
  });

  it("mentions other nodes only when chats run there", () => {
    const quiet = buildRunningChatsQuitDialog({ appName: "Ryco", report: knownReport() });
    expect(quiet.options.detail).not.toContain("other nodes");
    const busy = buildRunningChatsQuitDialog({
      appName: "Ryco",
      report: knownReport({ otherNodesRunningCount: 3 }),
    });
    expect(busy.options.detail.split("\n").slice(2, 4)).toEqual([
      "",
      "Chats on other nodes keep running.",
    ]);
  });
});

describe("createQuitGuardRequester", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  interface FakeTarget {
    readonly name: string;
    gone: (() => void) | null;
    readonly sent: QuitGuardRequest[];
    accepts: boolean;
    crashed: boolean;
  }

  function target(name: string): FakeTarget {
    return { name, gone: null, sent: [], accepts: true, crashed: false };
  }

  function requester() {
    let next = 0;
    const unsubscribed: string[] = [];
    const instance = createQuitGuardRequester<FakeTarget>({
      send: (receiver, request) => {
        if (!receiver.accepts) return false;
        receiver.sent.push(request);
        return true;
      },
      watchGone: (receiver, onGone) => {
        if (receiver.crashed) {
          onGone();
          return () => unsubscribed.push(receiver.name);
        }
        receiver.gone = onGone;
        return () => {
          receiver.gone = null;
          unsubscribed.push(receiver.name);
        };
      },
      createRequestId: () => `request-${(next += 1)}`,
    });
    return { instance, unsubscribed };
  }

  const runningChats: QuitGuardRequestBody = { kind: "running-chats" };

  it("settles with the reply of the asked target only", async () => {
    const { instance, unsubscribed } = requester();
    const asked = target("asked");
    const other = target("other");
    const outcome = instance.request(asked, runningChats, QUIT_RUNNING_CHATS_TIMEOUT_MS);
    expect(asked.sent).toEqual([{ kind: "running-chats", requestId: "request-1" }]);
    const reply = { requestId: "request-1", kind: "running-chats", report: { status: "unknown" } };
    instance.receive(other, reply);
    instance.receive(asked, { ...reply, requestId: "request-9" });
    instance.receive(asked, { ...reply, kind: "continue-after-restart", saved: true });
    instance.receive(asked, { requestId: "request-1" });
    instance.receive(asked, reply);
    instance.receive(asked, { ...reply, report: { status: "unavailable" } });
    await expect(outcome).resolves.toEqual({ kind: "reply", reply });
    expect(asked.gone).toBeNull();
    expect(unsubscribed).toEqual(["asked"]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("times out at exactly the bound", async () => {
    const { instance, unsubscribed } = requester();
    const asked = target("asked");
    let outcome: QuitGuardRequestOutcome | null = null;
    void instance.request(asked, runningChats, QUIT_RUNNING_CHATS_TIMEOUT_MS).then((value) => {
      outcome = value;
    });
    await vi.advanceTimersByTimeAsync(QUIT_RUNNING_CHATS_TIMEOUT_MS - 1);
    expect(outcome).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(outcome).toEqual({ kind: "timeout" });
    expect(unsubscribed).toEqual(["asked"]);
    // A late reply is ignored.
    instance.receive(asked, { requestId: "request-1", kind: "running-chats", report: null });
  });

  it("settles gone when the target goes away", async () => {
    const { instance, unsubscribed } = requester();
    const asked = target("asked");
    const outcome = instance.request(asked, runningChats, QUIT_RUNNING_CHATS_TIMEOUT_MS);
    asked.gone?.();
    await expect(outcome).resolves.toEqual({ kind: "gone" });
    expect(unsubscribed).toEqual(["asked"]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("settles at once when the target is already gone or cannot receive", async () => {
    const { instance, unsubscribed } = requester();
    const crashed = target("crashed");
    crashed.crashed = true;
    await expect(
      instance.request(crashed, runningChats, QUIT_CONTINUE_SETTING_TIMEOUT_MS),
    ).resolves.toEqual({ kind: "gone" });
    expect(crashed.sent).toEqual([]);
    const closed = target("closed");
    closed.accepts = false;
    await expect(
      instance.request(closed, runningChats, QUIT_CONTINUE_SETTING_TIMEOUT_MS),
    ).resolves.toEqual({ kind: "send-failed" });
    expect(unsubscribed).toEqual(["crashed", "closed"]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reads reply envelopes defensively", () => {
    expect(parseQuitGuardReply({ requestId: "", kind: "running-chats" })).toBeNull();
    expect(parseQuitGuardReply({ requestId: "x".repeat(129), kind: "running-chats" })).toBeNull();
    expect(parseQuitGuardReply({ requestId: "a", kind: "continue-after-restart" })).toBeNull();
    expect(
      parseQuitGuardReply({
        requestId: "a",
        kind: "continue-after-restart",
        saved: false,
        error: "e".repeat(500),
      }),
    ).toEqual({
      requestId: "a",
      kind: "continue-after-restart",
      saved: false,
      error: "e".repeat(200),
    });
    // The error reaches a log line: one line, no control or bidi characters.
    expect(
      parseQuitGuardReply({
        requestId: "a",
        kind: "continue-after-restart",
        saved: false,
        error: "disk\nfull\u202E\r\n2026-10-24 forged line\u0000",
      }),
    ).toMatchObject({ error: "disk full 2026-10-24 forged line" });
  });
});

describe("createRunningChatsQuitConfirmation", () => {
  const FIXTURE_TITLE = "Secret project codename";

  function harness(input: {
    readonly target?: { window: string; contents: string } | null;
    readonly query?: QuitGuardRequestOutcome;
    readonly write?: QuitGuardRequestOutcome;
    readonly dialog?: { response: number; checkboxChecked: boolean };
    readonly onDialog?: () => void;
  }) {
    const events: string[] = [];
    const logs: string[] = [];
    const requests: QuitGuardRequestBody[] = [];
    const dialogs: Array<{ window: string; options: QuitDialogOptions }> = [];
    const confirmation = createRunningChatsQuitConfirmation<string, string>({
      findTarget: () =>
        input.target === undefined ? { window: "window", contents: "contents" } : input.target,
      requester: {
        request: async (_target, body) => {
          requests.push(body);
          events.push(`request:${body.kind}`);
          if (body.kind === "running-chats") {
            return (
              input.query ?? {
                kind: "reply",
                reply: {
                  requestId: "r",
                  kind: "running-chats",
                  report: {
                    status: "known",
                    runningCount: 1,
                    resumableCount: 1,
                    chats: [{ threadId: "t", title: FIXTURE_TITLE, status: "working" }],
                    otherNodesRunningCount: 0,
                    continueThreadsAfterRestart: false,
                  },
                },
              }
            );
          }
          return (
            input.write ?? {
              kind: "reply",
              reply: {
                requestId: "w",
                kind: "continue-after-restart",
                saved: true,
                error: undefined,
              },
            }
          );
        },
      },
      showDialog: async (window, options) => {
        events.push("dialog");
        dialogs.push({ window, options });
        input.onDialog?.();
        return input.dialog ?? { response: 0, checkboxChecked: false };
      },
      reveal: (window) => events.push(`reveal:${window}`),
      appName: "Ryco",
      log: (line) => logs.push(line),
      now: () => 0,
    });
    return { confirmation, events, logs, requests, dialogs };
  }

  const reply = (report: unknown): QuitGuardRequestOutcome => ({
    kind: "reply",
    reply: { requestId: "r", kind: "running-chats", report },
  });

  it("returns null synchronously when there is no window to ask", () => {
    const { confirmation, requests } = harness({ target: null });
    expect(confirmation.confirm(new AbortController().signal)).toBeNull();
    expect(requests).toEqual([]);
  });

  it.each<[string, QuitGuardRequestOutcome]>([
    ["unknown", reply({ status: "unknown" })],
    ["unavailable", reply({ status: "unavailable" })],
    ["invalid", reply({ status: "known" })],
    [
      "nothing running",
      reply({
        status: "known",
        runningCount: 0,
        resumableCount: 0,
        chats: [],
        otherNodesRunningCount: 4,
        continueThreadsAfterRestart: false,
      }),
    ],
    ["timeout", { kind: "timeout" }],
    ["gone", { kind: "gone" }],
    ["send-failed", { kind: "send-failed" }],
  ])("quits without a dialog when %s", async (_name, query) => {
    const { confirmation, dialogs, logs } = harness({ query });
    await expect(confirmation.confirm(new AbortController().signal)).resolves.toBe(true);
    expect(dialogs).toEqual([]);
    expect(logs[0]).toMatch(/^quit confirmation: query status=\S+ (running=0 )?ms=0$/);
  });

  it("reveals the window, then shows the dialog on it", async () => {
    const { confirmation, events, dialogs, logs } = harness({});
    await expect(confirmation.confirm(new AbortController().signal)).resolves.toBe(true);
    expect(events).toEqual(["request:running-chats", "reveal:window", "dialog"]);
    expect(dialogs[0]?.window).toBe("window");
    expect(dialogs[0]?.options.detail).toContain(FIXTURE_TITLE);
    expect(logs).toEqual([
      "quit confirmation: query status=known running=1 ms=0",
      "quit confirmation: quit running=1",
    ]);
  });

  it("keeps running on Cancel and writes nothing", async () => {
    const { confirmation, requests, logs } = harness({
      dialog: { response: 1, checkboxChecked: true },
    });
    await expect(confirmation.confirm(new AbortController().signal)).resolves.toBe(false);
    expect(requests).toEqual([{ kind: "running-chats" }]);
    expect(logs.at(-1)).toBe("quit confirmation: cancelled running=1");
  });

  it("writes nothing when the box stays unchecked", async () => {
    const { confirmation, requests } = harness({ dialog: { response: 0, checkboxChecked: false } });
    await expect(confirmation.confirm(new AbortController().signal)).resolves.toBe(true);
    expect(requests).toEqual([{ kind: "running-chats" }]);
  });

  it("turns the setting on before quitting when the box is checked", async () => {
    let finishWrite!: (outcome: QuitGuardRequestOutcome) => void;
    const events: string[] = [];
    const confirmation = createRunningChatsQuitConfirmation<string, string>({
      findTarget: () => ({ window: "window", contents: "contents" }),
      requester: {
        request: (_target, body) => {
          events.push(JSON.stringify(body));
          if (body.kind === "running-chats") {
            return Promise.resolve(
              reply({
                status: "known",
                runningCount: 1,
                resumableCount: 1,
                chats: [{ threadId: "t", title: "Chat", status: "working" }],
                otherNodesRunningCount: 0,
                continueThreadsAfterRestart: false,
              }),
            );
          }
          return new Promise((resolve) => {
            finishWrite = resolve;
          });
        },
      },
      showDialog: async () => ({ response: 0, checkboxChecked: true }),
      reveal: () => undefined,
      appName: "Ryco",
      log: (line) => events.push(line),
      now: () => 0,
    });
    let settled: boolean | null = null;
    void confirmation.confirm(new AbortController().signal)!.then((value) => {
      settled = value;
    });
    await vi.waitFor(() =>
      expect(events).toContain(JSON.stringify({ kind: "continue-after-restart", enabled: true })),
    );
    await Promise.resolve();
    expect(settled).toBeNull();
    finishWrite({
      kind: "reply",
      reply: { requestId: "w", kind: "continue-after-restart", saved: true, error: undefined },
    });
    await vi.waitFor(() => expect(settled).toBe(true));
    expect(events).toContain("quit confirmation: continue-after-restart=on saved=true");
  });

  it.each<[string, QuitGuardRequestOutcome, string]>([
    ["times out", { kind: "timeout" }, "saved=false reason=timeout"],
    [
      "fails",
      {
        kind: "reply",
        reply: { requestId: "w", kind: "continue-after-restart", saved: false, error: "boom" },
      },
      "saved=false reason=error message=boom",
    ],
    [
      "fails without a message",
      {
        kind: "reply",
        reply: { requestId: "w", kind: "continue-after-restart", saved: false, error: undefined },
      },
      "saved=false reason=error",
    ],
  ])("still quits when the setting write %s", async (_name, write, logged) => {
    const { confirmation, logs } = harness({
      write,
      dialog: { response: 0, checkboxChecked: true },
    });
    await expect(confirmation.confirm(new AbortController().signal)).resolves.toBe(true);
    expect(logs).toContain(`quit confirmation: continue-after-restart=on ${logged}`);
  });

  it("never writes while the setting is already on", async () => {
    const { confirmation, requests, dialogs } = harness({
      query: reply({
        status: "known",
        runningCount: 1,
        resumableCount: 1,
        chats: [{ threadId: "t", title: "Chat", status: "working" }],
        otherNodesRunningCount: 0,
        continueThreadsAfterRestart: true,
      }),
      dialog: { response: 0, checkboxChecked: true },
    });
    await expect(confirmation.confirm(new AbortController().signal)).resolves.toBe(true);
    expect(dialogs[0]?.options.checkboxLabel).toBeUndefined();
    expect(requests).toEqual([{ kind: "running-chats" }]);
  });

  it("quits without a dialog when an urgent quit aborted the query", async () => {
    const controller = new AbortController();
    controller.abort();
    const { confirmation, dialogs } = harness({});
    await expect(confirmation.confirm(controller.signal)).resolves.toBe(true);
    expect(dialogs).toEqual([]);
  });

  it("quits without writing when an urgent quit closed the dialog", async () => {
    const controller = new AbortController();
    const { confirmation, requests, logs } = harness({
      dialog: { response: 1, checkboxChecked: true },
      onDialog: () => controller.abort(),
    });
    await expect(confirmation.confirm(controller.signal)).resolves.toBe(true);
    expect(requests).toEqual([{ kind: "running-chats" }]);
    expect(logs.at(-1)).toBe("quit confirmation: superseded by an urgent quit");
  });

  it("rejects when the dialog fails, so the quit goes ahead", async () => {
    const confirmation = createRunningChatsQuitConfirmation<string, string>({
      findTarget: () => ({ window: "window", contents: "contents" }),
      requester: {
        request: async () =>
          reply({
            status: "known",
            runningCount: 1,
            resumableCount: 1,
            chats: [{ threadId: "t", title: "Chat", status: "working" }],
            otherNodesRunningCount: 0,
            continueThreadsAfterRestart: false,
          }),
      },
      showDialog: () => Promise.reject(new Error("window destroyed")),
      reveal: () => undefined,
      appName: "Ryco",
      log: () => undefined,
    });
    await expect(confirmation.confirm(new AbortController().signal)).rejects.toThrow(
      "window destroyed",
    );
  });

  it("brings the open dialog's window forward on request, and nothing otherwise", async () => {
    let revealDuringDialog: (() => void) | null = null;
    const { confirmation, events } = harness({
      onDialog: () => revealDuringDialog?.(),
    });
    confirmation.revealDialog();
    expect(events).toEqual([]);
    revealDuringDialog = confirmation.revealDialog;
    await confirmation.confirm(new AbortController().signal);
    expect(events.filter((event) => event === "reveal:window")).toHaveLength(2);
    confirmation.revealDialog();
    expect(events.filter((event) => event === "reveal:window")).toHaveLength(2);
  });

  it("never logs chat titles", async () => {
    const { confirmation, logs } = harness({ dialog: { response: 0, checkboxChecked: true } });
    await confirmation.confirm(new AbortController().signal);
    const cancelled = harness({ dialog: { response: 1, checkboxChecked: false } });
    await cancelled.confirmation.confirm(new AbortController().signal);
    for (const line of [...logs, ...cancelled.logs]) expect(line).not.toContain(FIXTURE_TITLE);
  });
});

describe("createSystemShutdownNotice", () => {
  it("is urgent only for its window after a notice", () => {
    let nowMs = 1_000;
    const notice = createSystemShutdownNotice({ windowMs: 30_000, now: () => nowMs });
    expect(notice.active()).toBe(false);
    notice.mark();
    nowMs += 30_000;
    expect(notice.active()).toBe(true);
    nowMs += 1;
    expect(notice.active()).toBe(false);
  });
});
