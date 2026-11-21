import { describe, expect, it } from "vite-plus/test";

import {
  browserDoneWhenHolds,
  browserGlobMatches,
  selectorReadsFieldValues,
  browserProbeExpression,
  browserSignInHint,
  browserSignInNeed,
  browserUrlHolds,
  describeBrowserHandoffOutcome,
  describeBrowserHandoffPrivacy,
  describeBrowserPage,
  parseBrowserProbe,
  parseBrowserSignInSignals,
  validateBrowserDoneWhen,
  type BrowserSignInSignals,
} from "./browserHandoff.ts";

const signals = (overrides: Partial<BrowserSignInSignals> = {}): BrowserSignInSignals => ({
  href: "https://app.example.com/projects",
  page: "1700000000000/projects",
  passwords: 0,
  oneTimeCodes: 0,
  webauthn: 0,
  captcha: false,
  loginModal: false,
  ...overrides,
});

describe("done_when", () => {
  it("matches the URL without query and fragment, as a substring or a whole * glob", () => {
    const href = "https://jira.example.com/secure/Dashboard.jspa?next=%2Flogin#top";
    expect(browserUrlHolds("/secure/Dashboard", href)).toBe(true);
    expect(browserUrlHolds("login", href)).toBe(false);
    expect(browserUrlHolds("https://jira.example.com/*/Dashboard.jspa", href)).toBe(true);
    expect(browserUrlHolds("*/Dashboard", href)).toBe(false);
    // A path that looks like /…/ is a plain substring, never a regular expression.
    expect(browserUrlHolds("/secure/", href)).toBe(true);
  });

  it("matches globs without catastrophic backtracking", () => {
    expect(browserGlobMatches("a*b*c", "axxbyyc")).toBe(true);
    expect(browserGlobMatches("a*b*c", "axxbyy")).toBe(false);
    expect(browserGlobMatches("*", "")).toBe(true);
    // The pattern that makes a backtracking regex engine take forever: here it is quick.
    const pattern = `${"a*".repeat(200)}b`;
    const text = "a".repeat(8_000);
    const started = performance.now();
    expect(browserGlobMatches(pattern, text)).toBe(false);
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  it("needs every given part", () => {
    const condition = { url: "/dashboard", text: "Welcome" };
    expect(browserDoneWhenHolds(condition, { href: "https://a.test/dashboard", text: true })).toBe(
      true,
    );
    expect(browserDoneWhenHolds(condition, { href: "https://a.test/dashboard", text: false })).toBe(
      false,
    );
    expect(browserDoneWhenHolds({ gone: "Sign in" }, { href: "x", gone: true })).toBe(true);
    expect(browserDoneWhenHolds({ selector: "#app" }, { href: "x", selector: "invalid" })).toBe(
      false,
    );
  });

  it("refuses an empty condition, a bad regex and selectors that read field values", () => {
    expect(validateBrowserDoneWhen(undefined)).toBeUndefined();
    expect(validateBrowserDoneWhen({ url: "/home" })).toBeUndefined();
    expect(validateBrowserDoneWhen({})).toMatch(/at least one/);
    expect(validateBrowserDoneWhen({ url: "/(a+)+$/" })).toMatch(/not a regular expression/);
    expect(validateBrowserDoneWhen({ url: "/dashboard/" })).toBeUndefined();
    expect(validateBrowserDoneWhen({ selector: 'input[value^="a"]' })).toMatch(/field values/);
    expect(validateBrowserDoneWhen({ selector: "input:placeholder-shown" })).toMatch(
      /field values/,
    );
    expect(validateBrowserDoneWhen({ text: "x".repeat(513) })).toMatch(/longer than/);
  });

  it("refuses every attribute selector on value, in any namespace or spelling", () => {
    for (const selector of [
      "input[value]",
      'input[*|value^="a"]',
      'input[ns|value|="a"]',
      "input[ VALUE ]",
      "input[v\\61lue]",
      "input:placeholder-shown",
      "input:checked",
    ]) {
      expect(selectorReadsFieldValues(selector), selector).toBe(true);
    }
    for (const selector of ["nav.account", "[data-state=open]", "[aria-valuenow]", "#app main"]) {
      expect(selectorReadsFieldValues(selector), selector).toBe(false);
    }
  });

  it("builds a probe that reads no field values", () => {
    const expression = browserProbeExpression({ text: "Welcome", selector: "nav.account" }, true);
    expect(expression).toContain('"welcome"');
    expect(expression).not.toMatch(/\.value\b/);
    expect(
      parseBrowserProbe(JSON.stringify({ href: "https://a.test/", title: "A", ready: "complete" })),
    ).toMatchObject({ href: "https://a.test/" });
    expect(parseBrowserProbe("not json")).toBeUndefined();
  });
});

describe("sign-in detection", () => {
  it("spots password, one-time-code and passkey fields, captchas and login dialogs", () => {
    expect(browserSignInNeed(signals())).toBeNull();
    expect(browserSignInNeed(signals({ passwords: 1 }))).toBe("sign-in");
    expect(browserSignInNeed(signals({ loginModal: true }))).toBe("sign-in");
    expect(browserSignInNeed(signals({ oneTimeCodes: 6 }))).toBe("verification");
    expect(browserSignInNeed(signals({ webauthn: 1 }))).toBe("verification");
    expect(browserSignInNeed(signals({ captcha: true, passwords: 1 }))).toBe("captcha");
  });

  it("spots identity providers and login routes, also after a same-document route change", () => {
    expect(
      browserSignInNeed(signals({ href: "https://accounts.google.com/v3/signin/identifier" })),
    ).toBe("sign-in");
    expect(
      browserSignInNeed(
        signals({ href: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize?x=1" }),
      ),
    ).toBe("sign-in");
    expect(browserSignInNeed(signals({ href: "https://acme.okta.com/app/x" }))).toBe("sign-in");
    expect(browserSignInNeed(signals({ href: "http://localhost:3000/login" }))).toBe("sign-in");
    expect(browserSignInNeed(signals({ href: "https://app.example.com/account/2fa" }))).toBe(
      "verification",
    );
    expect(browserSignInNeed(signals({ href: "https://app.example.com/blog/login-tips" }))).toBe(
      null,
    );
    expect(browserSignInNeed(signals({ href: "file:///login" }))).toBeNull();
    expect(parseBrowserSignInSignals(JSON.stringify(signals()))).toMatchObject({
      page: "1700000000000/projects",
    });
  });

  it("words the hint for real accounts without asking for credentials", () => {
    const hint = browserSignInHint("tab-2", "sign-in");
    expect(hint).toContain('action "handoff"');
    expect(hint).toMatch(/test credentials/);
    expect(hint).toMatch(/never ask for passwords or codes in chat/);
  });
});

describe("hand-off result", () => {
  it("steers the agent by outcome", () => {
    expect(describeBrowserHandoffOutcome("declined", "tab-1", 5_000)).toMatch(/Do not ask again/);
    expect(describeBrowserHandoffOutcome("timeout", "tab-1", 600_000)).toMatch(
      /Ask the user in chat/,
    );
    expect(describeBrowserHandoffOutcome("condition-met", "tab-1", 12_000)).toMatch(/after 12 s/);
  });

  it("describes the page now and flags a sign-in that may not be complete", () => {
    const probe = {
      href: "https://a.test/login",
      title: "Sign in",
      ready: "complete",
      heading: "Welcome back",
      secretFields: 1,
    };
    expect(describeBrowserPage(probe, "x", "done")).toBe(
      'Page now: https://a.test/login — "Sign in", heading "Welcome back". It still shows a password or code field, so the sign-in may not be complete.',
    );
    expect(describeBrowserPage(undefined, "https://a.test/", "closed")).toBe(
      "Page now: https://a.test/.",
    );
    expect(describeBrowserHandoffPrivacy({ requests: 3, messages: 1 }, 1)).toBe(
      "While the user had the tab, the 3 requests the page sent are listed by origin only; its console message is withheld; a password or code field still on the page was emptied.",
    );
    expect(describeBrowserHandoffPrivacy({ requests: 0, messages: 0 }, 0)).toBe("");
  });
});
