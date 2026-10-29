import { describe, expect, it } from "vite-plus/test";
import {
  BrowserTabDiagnostics,
  DIAGNOSTICS_OUTPUT_MAX_BYTES,
  MAX_DIAGNOSTIC_ENTRIES,
  boundedUrl,
  truncateUtf8,
} from "./browserDiagnostics.ts";

it("cuts text to a UTF-8 byte budget without splitting a code point", () => {
  expect(truncateUtf8("short", 100)).toBe("short");
  expect(truncateUtf8("ééé", 5)).toBe("éé");
  expect(truncateUtf8("a😀b", 4)).toBe("a");
  expect(truncateUtf8("a😀b", 5)).toBe("a😀");
  expect(Buffer.byteLength(truncateUtf8("é".repeat(2_600), 4_096), "utf8")).toBe(4_096);
});

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
