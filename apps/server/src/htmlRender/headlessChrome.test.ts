import * as NodeVm from "node:vm";

import { describe, expect, it } from "vite-plus/test";

import {
  browserArguments,
  consoleEventReported,
  PAGE_ORIGIN,
  PAGE_SETUP_SCRIPT,
  pausedRequestAction,
  plainHttpOrigin,
} from "./headlessChrome.ts";

const PAGE = `${PAGE_ORIGIN}/page.html`;
const MAIN = "main-frame";

describe("pausedRequestAction", () => {
  it.each([
    ["serves the page to the main frame", PAGE, MAIN, "Document", true, "fulfill"],
    ["ignores the theme fragment", `${PAGE}#ryco-theme=%7B%7D`, MAIN, "Document", true, "fulfill"],
    ["lets the page fetch itself", PAGE, MAIN, "Fetch", true, "fulfill"],
    [
      "aborts the main frame leaving the page",
      "https://example.com/",
      MAIN,
      "Document",
      true,
      "abort",
    ],
    ["aborts a reload with a query", `${PAGE}?again`, MAIN, "Document", true, "abort"],
    ["aborts the main frame before a page is set", PAGE, MAIN, "Document", false, "abort"],
    [
      "lets a frame show another site",
      "https://example.com/",
      "child",
      "Document",
      true,
      "continue",
    ],
    [
      "never frames the made-up origin",
      `${PAGE_ORIGIN}/other.html`,
      "child",
      "Document",
      true,
      "fail",
    ],
    ["never frames the page in itself", PAGE, "child", "Document", true, "fail"],
    [
      "serves nothing else from the made-up origin",
      `${PAGE_ORIGIN}/x.js`,
      MAIN,
      "Script",
      true,
      "fail",
    ],
    [
      "lets the page load a plain-http resource",
      "http://cdn.example.com/chart.js",
      MAIN,
      "Script",
      true,
      "continue",
    ],
  ] as const)("%s", (_name, url, frameId, resourceType, hasPage, action) => {
    expect(pausedRequestAction({ url, frameId, resourceType, mainFrameId: MAIN, hasPage })).toBe(
      action,
    );
  });
});

describe("plainHttpOrigin", () => {
  it("names plain-http loads readers on HTTPS clients block, and nothing else", () => {
    expect(plainHttpOrigin("http://cdn.example.com/lib/chart.js?v=1")).toBe(
      "http://cdn.example.com",
    );
    expect(plainHttpOrigin("http://203.0.113.7:8080/a.png")).toBe("http://203.0.113.7:8080");
    expect(plainHttpOrigin("https://cdn.example.com/chart.js")).toBeUndefined();
    expect(plainHttpOrigin(PAGE)).toBeUndefined();
    expect(plainHttpOrigin(`${PAGE_ORIGIN}/other.js`)).toBeUndefined();
    expect(plainHttpOrigin("data:text/plain,x")).toBeUndefined();
  });
});

describe("PAGE_SETUP_SCRIPT", () => {
  /** Runs the script against a stand-in window, as Chrome runs it before page scripts. */
  const setUpPage = () => {
    class Document {
      get cookie() {
        return "";
      }
    }
    class IDBFactory {
      open() {
        return "opened";
      }
      deleteDatabase() {
        return "deleted";
      }
    }
    const window: Record<string, unknown> = {
      localStorage: {},
      sessionStorage: {},
      caches: {},
      indexedDB: new IDBFactory(),
      RTCPeerConnection: () => undefined,
      Document,
      IDBFactory,
      DOMException,
    };
    window.window = window;
    window.top = window;
    NodeVm.runInNewContext(PAGE_SETUP_SCRIPT, NodeVm.createContext(window));
    return { window, document: new Document(), indexedDB: window.indexedDB as IDBFactory };
  };

  const securityError = (read: () => unknown) => {
    try {
      read();
    } catch (error) {
      return error instanceof DOMException ? `${error.name}: ${error.message}` : String(error);
    }
    return "no error";
  };

  it("makes storage and cookies throw as they do in readers' sandboxed frame", () => {
    const { window, document, indexedDB } = setUpPage();
    const sandboxed = "The document is sandboxed and lacks the 'allow-same-origin' flag.";
    expect(securityError(() => window.localStorage)).toBe(
      `SecurityError: Failed to read the 'localStorage' property from 'Window': ${sandboxed}`,
    );
    expect(securityError(() => window.sessionStorage)).toBe(
      `SecurityError: Failed to read the 'sessionStorage' property from 'Window': ${sandboxed}`,
    );
    expect(securityError(() => window.caches)).toContain("SecurityError: ");
    expect(securityError(() => document.cookie)).toBe(
      `SecurityError: Failed to read the 'cookie' property from 'Document': ${sandboxed}`,
    );
    expect(
      securityError(() => {
        (document as { cookie: string }).cookie = "a=b";
      }),
    ).toBe(`SecurityError: Failed to set the 'cookie' property on 'Document': ${sandboxed}`);
    // As in Chromium, the factory is there, but opening a database is refused.
    expect(window.indexedDB).toBe(indexedDB);
    expect(securityError(() => indexedDB.open())).toBe(
      "SecurityError: Failed to execute 'open' on 'IDBFactory': access to the Indexed Database API is denied in this context.",
    );
    expect(securityError(() => indexedDB.deleteDatabase())).toContain("SecurityError: ");
    expect(window.RTCPeerConnection).toBeUndefined();
  });
});

describe("consoleEventReported", () => {
  // The starts of messages as the pinned browser writes them.
  it.each([
    ['{"method":"Runtime.consoleAPICalled","params":{"type":"log","args":[', true],
    ['{"method":"Runtime.consoleAPICalled","params":{"type":"error","args":[', true],
    ['{"method":"Runtime.consoleAPICalled","params":{"type":"count","args":[', false],
    ['{"method":"Runtime.consoleAPICalled","params":{"type":"constructor","args":[', false],
    ['{"method":"Runtime.exceptionThrown","params":{"timestamp":1,', true],
    ['{"method":"Log.entryAdded","params":{"entry":{"source":"network","level":"error",', true],
    [
      '{"method":"Log.entryAdded","params":{"entry":{"source":"violation","level":"verbose",',
      false,
    ],
    ['{"method":"Fetch.requestPaused","params":{"requestId":"interception-job-1.0",', undefined],
    ['{"id":7,"result":{"result":{"type":"string","value":"{\\"method\\":', undefined],
  ] as const)("%s → %s", (head, reported) => {
    expect(consoleEventReported(head)).toBe(reported);
  });
});

describe("browserArguments", () => {
  it("drives the browser over a pipe through the public-only proxy, sandboxed by default", () => {
    const flags = browserArguments({ noSandbox: false, proxyPort: 4321, profileDirectory: "/p" });
    expect(flags).toEqual(
      expect.arrayContaining([
        "--remote-debugging-pipe",
        "--block-new-web-contents",
        "--proxy-server=socks5://127.0.0.1:4321",
        "--proxy-bypass-list=<-loopback>",
        "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
        "--user-data-dir=/p",
      ]),
    );
    expect(flags.some((flag) => flag.startsWith("--remote-debugging-port"))).toBe(false);
    expect(flags).not.toContain("--no-sandbox");
    expect(browserArguments({ noSandbox: true, proxyPort: 1, profileDirectory: "/p" })).toContain(
      "--no-sandbox",
    );
  });
});
