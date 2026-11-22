import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  BROWSER_HANDOFF_WITHHELD_PATH,
  BROWSER_HANDOFF_WITHHELD_TEXT,
  BrowserTabDiagnostics,
  DIAGNOSTICS_OUTPUT_MAX_BYTES,
  MAX_DIAGNOSTIC_ENTRIES,
  boundedUrl,
} from "./browserDiagnostics.ts";

function recorder() {
  let time = 1_000;
  const diagnostics = new BrowserTabDiagnostics(() => time);
  return {
    diagnostics,
    advance: (ms: number) => {
      time += ms;
    },
  };
}
const log = (text: string, type = "log") => ({ type, args: [{ type: "string", value: text }] });
const request = (requestId: string, url: string, extra: Record<string, unknown> = {}) => ({
  requestId,
  loaderId: "loader-1",
  type: "Fetch",
  request: { url, method: "GET", headers: { cookie: "secret" }, postData: "body" },
  ...extra,
});

describe("console", () => {
  it("records console calls, exceptions and log entries with bounded text", () => {
    const { diagnostics } = recorder();
    diagnostics.onMessage("Runtime.consoleAPICalled", {
      type: "error",
      args: [
        { type: "string", value: "fixture-error" },
        { type: "object", value: { a: 1 } },
        { type: "number", description: "42" },
      ],
      stackTrace: {
        callFrames: [{ url: "https://app.test/main.js?token=abc", lineNumber: 3, columnNumber: 7 }],
      },
    });
    diagnostics.onMessage("Runtime.exceptionThrown", {
      exceptionDetails: { text: "Uncaught", exception: { description: "TypeError: boom" } },
    });
    diagnostics.onMessage("Log.entryAdded", {
      entry: { level: "warning", text: "x".repeat(5000) },
    });
    const { entries, truncated, droppedCount } = diagnostics.read("console", 100);
    expect(truncated).toBe(false);
    expect(droppedCount).toBe(0);
    expect(entries).toEqual([
      expect.objectContaining({
        kind: "console",
        level: "error",
        text: 'fixture-error {"a":1} 42',
        url: "https://app.test/main.js?token=[REDACTED]",
        lineNumber: 3,
        columnNumber: 7,
      }),
      expect.objectContaining({ level: "exception", text: "TypeError: boom" }),
      expect.objectContaining({ level: "warn", text: "x".repeat(4096) }),
    ]);
    expect(diagnostics.read("network", 100).entries).toEqual([]);
  });

  it("keeps the newest 1 000 entries and counts the dropped ones per kind", () => {
    const { diagnostics } = recorder();
    for (let index = 0; index < MAX_DIAGNOSTIC_ENTRIES + 25; index += 1)
      diagnostics.onMessage("Runtime.consoleAPICalled", log(`line ${index}`));
    const read = diagnostics.read("console", 200);
    expect(read.droppedCount).toBe(25);
    expect(read.truncated).toBe(true);
    expect(read.entries).toHaveLength(200);
    expect(read.entries.at(-1)).toEqual(expect.objectContaining({ text: "line 1024" }));
    expect(read.entries[0]).toEqual(expect.objectContaining({ text: "line 825" }));
    // Network drops are not console drops.
    expect(diagnostics.read("network", 10)).toEqual(
      expect.objectContaining({ droppedCount: 0, truncated: false, entries: [] }),
    );
  });

  it("skips the messages a new session replays and keeps each message's own time", () => {
    const { diagnostics } = recorder();
    const at = (ms: number) => Date.UTC(2026, 9, 24, 10, 0, 0, ms);
    const exception = (time: number) => ({
      timestamp: time,
      exceptionDetails: { text: "Uncaught", exception: { description: "Error: one" } },
    });
    const session = () => {
      diagnostics.onMessage("Runtime.consoleAPICalled", { ...log("first"), timestamp: at(1) });
      diagnostics.onMessage("Log.entryAdded", {
        entry: { level: "error", text: "net::ERR_FAILED", timestamp: at(2) },
      });
      diagnostics.onMessage("Runtime.exceptionThrown", exception(at(3)));
    };
    session();
    // The session ended; the next one's Runtime.enable and Log.enable replay what the page stored.
    diagnostics.resetSession();
    session();
    // Logged while no session was open: new, and stamped with when it happened.
    diagnostics.onMessage("Runtime.consoleAPICalled", { ...log("meanwhile"), timestamp: at(500) });
    diagnostics.onMessage("Runtime.consoleAPICalled", log("no timestamp"));
    // Console capture resumed after the idle quiesce replays too.
    diagnostics.beforeConsoleReplay();
    diagnostics.onMessage("Runtime.consoleAPICalled", { ...log("meanwhile"), timestamp: at(500) });
    const { entries } = diagnostics.read("console", 100);
    expect(entries.map((entry) => (entry.kind === "console" ? entry.text : ""))).toEqual([
      "first",
      "net::ERR_FAILED",
      "Error: one",
      "meanwhile",
      "no timestamp",
    ]);
    expect(entries[0]?.timestamp).toBe(new Date(at(1)).toISOString());
    expect(entries[3]?.timestamp).toBe(new Date(at(500)).toISOString());
    // A cleared recorder starts over.
    diagnostics.clear();
    session();
    expect(diagnostics.read("console", 100).entries).toHaveLength(3);
  });

  it("redacts credentials in console text when it is read", () => {
    const { diagnostics } = recorder();
    diagnostics.onMessage(
      "Runtime.consoleAPICalled",
      log("login Bearer abc.def.ghi with token=s3cr3t-value and sk-abcdefghijklmnop"),
    );
    diagnostics.onMessage("Runtime.exceptionThrown", {
      exceptionDetails: {
        exception: { description: "Error: boom\n at https://app.test/a.js?token=xyz789:1:2" },
      },
    });
    const texts = diagnostics
      .read("console", 10)
      .entries.map((entry) => (entry.kind === "console" ? entry.text : ""));
    expect(texts[0]).toContain("login Bearer [redacted]");
    for (const secret of ["abc.def.ghi", "s3cr3t-value", "sk-abcdefghijklmnop"])
      expect(texts[0]).not.toContain(secret);
    expect(texts[1]).toContain("Error: boom");
    expect(texts[1]).not.toContain("xyz789");
  });

  it("caps one read at 64 KiB of JSON and keeps the newest entries", () => {
    const { diagnostics } = recorder();
    for (let index = 0; index < 100; index += 1)
      diagnostics.onMessage("Log.entryAdded", {
        entry: { level: "info", text: `${index} `.padEnd(4000, "y") },
      });
    const read = diagnostics.read("console", 100);
    expect(Buffer.byteLength(JSON.stringify(read), "utf8")).toBeLessThanOrEqual(
      DIAGNOSTICS_OUTPUT_MAX_BYTES,
    );
    expect(read.truncated).toBe(true);
    expect(read.entries.length).toBeGreaterThan(10);
    expect(read.entries.length).toBeLessThan(100);
    expect(read.entries.at(-1)).toEqual(
      expect.objectContaining({ text: expect.stringMatching(/^99 /) }),
    );
  });
});

describe("network", () => {
  it("redacts credentials, fragments, query values and non-web schemes", () => {
    expect(boundedUrl("https://user:pass@app.test/a?token=secret&x=1&x=2#frag")).toBe(
      "https://app.test/a?token=[REDACTED]&x=[REDACTED]&x=[REDACTED]",
    );
    expect(boundedUrl("javascript:alert(document.cookie)")).toBe("javascript:[redacted]");
    expect(boundedUrl("data:text/html,<script>secret</script>")).toBe("data:[redacted]");
    expect(boundedUrl("not a url")).toBe("invalid:[redacted]");
    expect(boundedUrl("")).toBe("about:blank");
  });

  it("redacts credentials in URL paths when it is read", () => {
    const { diagnostics } = recorder();
    // In parts, so secret scanners do not read the fixture as a real webhook.
    const webhook = [
      "https://hooks.slack.com/",
      "services/T00000000/B00000000/",
      "XXXXXXXXXXXXXXXXXXXXXXXX",
    ].join("");
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.abcdefghijklmnopqrstu";
    diagnostics.onMessage("Network.requestWillBeSent", request("1", webhook));
    diagnostics.onMessage(
      "Network.requestWillBeSent",
      request("2", `https://api.example.com/verify/${jwt}?token=secret`),
    );
    const urls = diagnostics
      .read("network", 10)
      .entries.map((entry) => (entry.kind === "network" ? entry.url : ""));
    expect(urls[0]).not.toContain("XXXXXXXXXXXXXXXXXXXXXXXX");
    expect(urls[1]).not.toContain(jwt);
    // Query values were taken out when the request was recorded; their markers stay as they are.
    expect(urls[1]).toMatch(/\?token=\[REDACTED\]$/u);
  });

  it("records requests, responses and failures without headers or bodies", () => {
    const { diagnostics, advance } = recorder();
    diagnostics.onMessage(
      "Network.requestWillBeSent",
      request("1", "https://app.test/slow?token=secret"),
    );
    diagnostics.onMessage("Network.requestWillBeSent", request("2", "https://app.test/broken"));
    advance(812.4);
    diagnostics.onMessage("Network.responseReceived", {
      requestId: "1",
      type: "Fetch",
      response: {
        url: "https://app.test/slow?token=secret",
        status: 200,
        mimeType: "text/plain",
        headers: { "set-cookie": "s" },
      },
    });
    diagnostics.onMessage("Network.loadingFinished", { requestId: "1" });
    diagnostics.onMessage("Network.loadingFailed", {
      requestId: "2",
      errorText: "net::ERR_FAILED",
    });
    const { entries } = diagnostics.read("network", 100);
    expect(entries).toEqual([
      expect.objectContaining({
        phase: "request",
        requestId: "1",
        url: "https://app.test/slow?token=[REDACTED]",
        method: "GET",
        resourceType: "Fetch",
      }),
      expect.objectContaining({ phase: "request", requestId: "2" }),
      expect.objectContaining({
        phase: "response",
        requestId: "1",
        status: 200,
        mimeType: "text/plain",
        durationMs: 812,
      }),
      expect.objectContaining({
        phase: "failure",
        requestId: "2",
        url: "https://app.test/broken",
        errorText: "net::ERR_FAILED",
        durationMs: 812,
      }),
    ]);
    const serialized = JSON.stringify(entries);
    expect(serialized).not.toContain("secret");
    expect(serialized).not.toContain("cookie");
    expect(serialized).not.toContain("body");
  });

  it("is idle only after 500 ms without tracked requests while the page is not loading", () => {
    const { diagnostics, advance } = recorder();
    advance(600);
    expect(diagnostics.networkIdle(false)).toEqual({ idle: true, inFlight: 0, quietMs: 600 });
    expect(diagnostics.networkIdle(true).idle).toBe(false);
    diagnostics.onMessage("Network.requestWillBeSent", request("1", "https://app.test/api"));
    advance(1_000);
    expect(diagnostics.networkIdle(false)).toEqual({ idle: false, inFlight: 1, quietMs: 1_000 });
    diagnostics.onMessage("Network.loadingFinished", { requestId: "1" });
    advance(499);
    expect(diagnostics.networkIdle(false)).toEqual({ idle: false, inFlight: 0, quietMs: 499 });
    advance(1);
    expect(diagnostics.networkIdle(false).idle).toBe(true);
  });

  it("never counts WebSocket or EventSource streams as in flight", () => {
    const { diagnostics, advance } = recorder();
    diagnostics.onMessage(
      "Network.requestWillBeSent",
      request("ws", "wss://app.test/hmr", { type: "WebSocket" }),
    );
    diagnostics.onMessage(
      "Network.requestWillBeSent",
      request("sse", "https://app.test/events", { type: "EventSource" }),
    );
    advance(500);
    expect(diagnostics.networkIdle(false)).toEqual({ idle: true, inFlight: 0, quietMs: 500 });
    // They are still logged.
    expect(
      diagnostics
        .read("network", 10)
        .entries.map((entry) => entry.kind === "network" && entry.requestId),
    ).toEqual(["ws", "sse"]);
  });

  it("drops other loaders' requests when the main frame commits a new document", () => {
    const { diagnostics, advance } = recorder();
    diagnostics.onMessage("Network.requestWillBeSent", request("old", "https://app.test/old"));
    diagnostics.onMessage(
      "Network.requestWillBeSent",
      request("new", "https://app.test/new", { loaderId: "loader-2" }),
    );
    // A child frame's navigation changes nothing.
    diagnostics.onMessage("Page.frameNavigated", {
      frame: { id: "child", parentId: "main", loaderId: "loader-3" },
    });
    expect(diagnostics.networkIdle(false).inFlight).toBe(2);
    diagnostics.onMessage("Page.frameNavigated", { frame: { id: "main", loaderId: "loader-2" } });
    expect(diagnostics.networkIdle(false).inFlight).toBe(1);
    diagnostics.onMessage("Network.loadingFinished", { requestId: "new" });
    advance(500);
    expect(diagnostics.networkIdle(false).idle).toBe(true);
  });

  it("forgets in-flight requests on a new session and keeps the entries", () => {
    const { diagnostics, advance } = recorder();
    diagnostics.onMessage("Network.requestWillBeSent", request("1", "https://app.test/api"));
    advance(1_000);
    diagnostics.resetSession();
    expect(diagnostics.networkIdle(false)).toEqual({ idle: false, inFlight: 0, quietMs: 0 });
    advance(500);
    expect(diagnostics.networkIdle(false).idle).toBe(true);
    expect(diagnostics.read("network", 10).entries).toHaveLength(1);
    diagnostics.clear();
    expect(diagnostics.read("network", 10).entries).toEqual([]);
  });
});

describe("hand-off withholding", () => {
  const T0 = Date.UTC(2026, 10, 21, 9, 0, 0);
  const at = (ms: number) => {
    vi.setSystemTime(T0 + ms);
  };
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  const consoleTexts = (diagnostics: BrowserTabDiagnostics) =>
    diagnostics
      .read("console", 100)
      .entries.map((entry) => (entry.kind === "console" ? entry.text : ""));

  it("keeps only the level of console messages and the origin of requests while the user has the tab", () => {
    const { diagnostics } = recorder();
    diagnostics.onMessage("Runtime.consoleAPICalled", log("before"));
    diagnostics.onMessage("Network.requestWillBeSent", request("before", "https://app.test/home"));
    diagnostics.beginWithholding();
    at(1_000);
    // A second begin keeps the running hand-off and its counts.
    diagnostics.beginWithholding();
    diagnostics.onMessage("Runtime.consoleAPICalled", {
      ...log("password is hunter2", "error"),
      stackTrace: {
        callFrames: [{ url: "https://auth.app.test/login.js", lineNumber: 3, columnNumber: 7 }],
      },
    });
    diagnostics.onMessage("Log.entryAdded", {
      entry: { level: "warning", text: "otp 123456", url: "https://auth.app.test/otp" },
    });
    diagnostics.onMessage("Runtime.exceptionThrown", {
      exceptionDetails: { exception: { description: "Error: user me@x.test" } },
    });
    diagnostics.onMessage(
      "Network.requestWillBeSent",
      request("login", "https://auth.app.test/session/new?email=me%40x.test", {
        request: { url: "https://auth.app.test/session/new?email=me%40x.test", method: "POST" },
      }),
    );
    diagnostics.onMessage("Network.responseReceived", {
      requestId: "login",
      type: "Document",
      response: { url: "https://auth.app.test/session/new", status: 302, mimeType: "text/html" },
    });
    diagnostics.onMessage("Network.requestWillBeSent", request("me", "https://api.app.test/v1/me"));
    diagnostics.onMessage("Network.loadingFailed", {
      requestId: "me",
      errorText: "net::ERR_ABORTED",
    });
    // Requests count on their request phase, messages each.
    expect(diagnostics.endWithholding()).toEqual({ requests: 2, messages: 3 });
    // Nothing runs any more.
    expect(diagnostics.endWithholding()).toEqual({ requests: 0, messages: 0 });

    const consoleRead = diagnostics.read("console", 100).entries;
    const withheldAt = new Date(T0 + 1_000).toISOString();
    expect(consoleRead).toEqual([
      expect.objectContaining({ kind: "console", level: "log", text: "before" }),
      {
        kind: "console",
        timestamp: withheldAt,
        level: "error",
        text: BROWSER_HANDOFF_WITHHELD_TEXT,
      },
      {
        kind: "console",
        timestamp: withheldAt,
        level: "warn",
        text: BROWSER_HANDOFF_WITHHELD_TEXT,
      },
      {
        kind: "console",
        timestamp: withheldAt,
        level: "exception",
        text: BROWSER_HANDOFF_WITHHELD_TEXT,
      },
    ]);
    const withheldUrl = (origin: string) => `${origin}/${BROWSER_HANDOFF_WITHHELD_PATH}`;
    const networkRead = diagnostics.read("network", 100).entries;
    expect(networkRead).toEqual([
      expect.objectContaining({
        phase: "request",
        requestId: "before",
        url: "https://app.test/home",
      }),
      {
        kind: "network",
        timestamp: withheldAt,
        phase: "request",
        requestId: "login",
        url: withheldUrl("https://auth.app.test"),
        method: "POST",
      },
      {
        kind: "network",
        timestamp: withheldAt,
        phase: "response",
        requestId: "login",
        url: withheldUrl("https://auth.app.test"),
        method: "POST",
        status: 302,
      },
      {
        kind: "network",
        timestamp: withheldAt,
        phase: "request",
        requestId: "me",
        url: withheldUrl("https://api.app.test"),
        method: "GET",
      },
      {
        kind: "network",
        timestamp: withheldAt,
        phase: "failure",
        requestId: "me",
        url: withheldUrl("https://api.app.test"),
        method: "GET",
      },
    ]);
    const serialized = JSON.stringify([consoleRead, networkRead]);
    for (const secret of [
      "hunter2",
      "123456",
      "me@x.test",
      "email",
      "session/new",
      "v1/me",
      "login.js",
    ])
      expect(serialized).not.toContain(secret);
  });

  it("still withholds what belongs to the hand-off after it ended, and nothing else", () => {
    const { diagnostics } = recorder();
    diagnostics.beginWithholding();
    at(1_000);
    diagnostics.onMessage("Runtime.consoleAPICalled", { ...log("during"), timestamp: T0 + 1_000 });
    diagnostics.onMessage(
      "Network.requestWillBeSent",
      request("slow", "https://app.test/callback?code=abc"),
    );
    diagnostics.onMessage("Network.requestWillBeSent", request("doomed", "https://app.test/token"));
    at(5_000);
    expect(diagnostics.endWithholding()).toEqual({ requests: 2, messages: 1 });

    at(6_000);
    // Responses and failures of requests the page sent while the user had the tab.
    diagnostics.onMessage("Network.responseReceived", {
      requestId: "slow",
      response: { url: "https://app.test/callback?code=abc", status: 200 },
    });
    diagnostics.onMessage("Network.loadingFailed", {
      requestId: "doomed",
      errorText: "net::ERR_FAILED",
    });
    // A new request is the agent's again.
    diagnostics.onMessage(
      "Network.requestWillBeSent",
      request("after", "https://app.test/dashboard?tab=1"),
    );
    diagnostics.onMessage("Network.responseReceived", {
      requestId: "after",
      response: { url: "https://app.test/dashboard?tab=1", status: 200 },
    });
    // A new session replays the page's stored console messages: the one captured already is
    // skipped, one logged inside the hand-off's window while no session listened is withheld,
    // ones before or after it are kept.
    diagnostics.resetSession();
    diagnostics.onMessage("Runtime.consoleAPICalled", { ...log("during"), timestamp: T0 + 1_000 });
    diagnostics.onMessage("Runtime.consoleAPICalled", {
      ...log("detached secret"),
      timestamp: T0 + 2_000,
    });
    diagnostics.onMessage("Log.entryAdded", {
      entry: { level: "info", text: "detached log", timestamp: T0 + 5_000 },
    });
    diagnostics.onMessage("Runtime.consoleAPICalled", { ...log("later"), timestamp: T0 + 6_000 });
    diagnostics.onMessage("Log.entryAdded", {
      entry: { level: "info", text: "earlier", timestamp: T0 - 1_000 },
    });
    diagnostics.onMessage("Runtime.consoleAPICalled", log("now"));

    expect(consoleTexts(diagnostics)).toEqual([
      BROWSER_HANDOFF_WITHHELD_TEXT,
      BROWSER_HANDOFF_WITHHELD_TEXT,
      BROWSER_HANDOFF_WITHHELD_TEXT,
      "later",
      "earlier",
      "now",
    ]);
    const network = diagnostics.read("network", 100).entries;
    expect(
      network.map((entry) => entry.kind === "network" && [entry.requestId, entry.phase, entry.url]),
    ).toEqual([
      ["slow", "request", `https://app.test/${BROWSER_HANDOFF_WITHHELD_PATH}`],
      ["doomed", "request", `https://app.test/${BROWSER_HANDOFF_WITHHELD_PATH}`],
      ["slow", "response", `https://app.test/${BROWSER_HANDOFF_WITHHELD_PATH}`],
      ["doomed", "failure", `https://app.test/${BROWSER_HANDOFF_WITHHELD_PATH}`],
      ["after", "request", "https://app.test/dashboard?tab=[REDACTED]"],
      ["after", "response", "https://app.test/dashboard?tab=[REDACTED]"],
    ]);
    expect(network[2]).toEqual(expect.objectContaining({ status: 200 }));
    expect(network[3]).not.toHaveProperty("errorText");
    expect(network[4]).toEqual(expect.objectContaining({ resourceType: "Fetch" }));
    // Entries after the hand-off are not counted for it.
    expect(diagnostics.endWithholding()).toEqual({ requests: 0, messages: 0 });
  });

  it("counts each hand-off on its own", () => {
    const { diagnostics } = recorder();
    diagnostics.beginWithholding();
    diagnostics.onMessage("Runtime.consoleAPICalled", log("one"));
    expect(diagnostics.endWithholding()).toEqual({ requests: 0, messages: 1 });
    at(10_000);
    diagnostics.onMessage("Runtime.consoleAPICalled", log("between"));
    diagnostics.beginWithholding();
    diagnostics.onMessage("Network.requestWillBeSent", request("r", "https://app.test/a"));
    expect(diagnostics.endWithholding()).toEqual({ requests: 1, messages: 0 });
    expect(consoleTexts(diagnostics)).toEqual([BROWSER_HANDOFF_WITHHELD_TEXT, "between"]);
  });
});
