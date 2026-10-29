import {
  BROWSER_ELEMENT_MAX_NAME_LENGTH,
  BROWSER_ELEMENT_MAX_PAGE_TITLE_LENGTH,
  BROWSER_ELEMENT_MAX_ROLE_LENGTH,
  BROWSER_ELEMENT_MAX_SELECTOR_LENGTH,
  BROWSER_ELEMENT_MAX_TAG_LENGTH,
  BROWSER_ELEMENT_MAX_TEXT_LENGTH,
  ProjectBrowserPickedElement,
} from "@ryco/contracts/project-browser";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import {
  looksSensitiveBrowserText,
  normalizeBrowserElementPick,
  sanitizeBrowserElementUrl,
} from "./browserElementReference.ts";

const page = { url: "https://app.example.com/settings/2", title: "Settings" };
const raw = (fields: Record<string, unknown> = {}) => ({
  selector: "#save",
  tagName: "BUTTON",
  role: "button",
  name: "Save changes",
  text: "Save changes",
  box: { x: 10, y: 20, width: 120, height: 32 },
  ...fields,
});
const normalize = (fields: Record<string, unknown> = {}, at: Partial<typeof page> = {}) =>
  normalizeBrowserElementPick(raw(fields), { ...page, ...at });
const isWellFormed = (value: string) =>
  !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(value);

describe("normalizeBrowserElementPick", () => {
  it("keeps a plain element and takes its URL and title from the page argument", () => {
    const element = normalizeBrowserElementPick(
      { ...raw(), url: "https://evil.example/", pageTitle: "Spoofed" },
      page,
    );
    expect(element).toEqual({
      url: "https://app.example.com/settings/2",
      pageTitle: "Settings",
      selector: "#save",
      tagName: "button",
      role: "button",
      name: "Save changes",
      text: "Save changes",
      box: { x: 10, y: 20, width: 120, height: 32 },
    });
    expect(Schema.decodeUnknownSync(ProjectBrowserPickedElement)(element)).toEqual(element);
  });

  it("returns null without a URL, selector or tag", () => {
    expect(normalize({}, { url: "file:///etc/passwd" })).toBeNull();
    expect(normalize({}, { url: "not a url" })).toBeNull();
    expect(normalize({ selector: "" })).toBeNull();
    expect(normalize({ selector: " \n " })).toBeNull();
    expect(normalize({ selector: 42 })).toBeNull();
    expect(normalize({ tagName: null })).toBeNull();
    expect(normalizeBrowserElementPick(null, page)).toBeNull();
    expect(normalizeBrowserElementPick("button", page)).toBeNull();
    expect(normalizeBrowserElementPick([raw()], page)).toBeNull();
  });

  it("collapses control characters and whitespace into single spaces", () => {
    const element = normalize({
      name: "  Save\u0000\u0085changes\u2028now\n\t ",
      text: "Line one\r\nLine\u2029two",
      role: "\u0007button\u007f",
    });
    expect(element?.name).toBe("Save changes now");
    expect(element?.text).toBe("Line one Line two");
    expect(element?.role).toBe("button");
  });

  it("lowercases the tag and turns empty optional fields into null", () => {
    const element = normalize({ tagName: "MY-Element", role: "", name: "   ", text: undefined });
    expect(element?.tagName).toBe("my-element");
    expect(element?.role).toBeNull();
    expect(element?.name).toBeNull();
    expect(element?.text).toBeNull();
  });

  it("cuts every field to its cap, without splitting a surrogate pair", () => {
    const element = normalize({
      tagName: "x".repeat(100),
      role: "r".repeat(100),
      name: `${"a".repeat(BROWSER_ELEMENT_MAX_NAME_LENGTH - 1)}\u{1F600}b`,
      text: "t".repeat(1_000),
    });
    expect(element?.tagName).toHaveLength(BROWSER_ELEMENT_MAX_TAG_LENGTH);
    expect(element?.role).toHaveLength(BROWSER_ELEMENT_MAX_ROLE_LENGTH);
    expect(element?.name).toBe("a".repeat(BROWSER_ELEMENT_MAX_NAME_LENGTH - 1));
    expect(element?.text).toHaveLength(BROWSER_ELEMENT_MAX_TEXT_LENGTH);
    const title = normalize({}, { title: "T".repeat(500) })?.pageTitle;
    expect(title).toHaveLength(BROWSER_ELEMENT_MAX_PAGE_TITLE_LENGTH);
  });

  it("drops a word the cut would split", () => {
    const text = `${"a".repeat(275)} bcdefghij`;
    expect(normalize({ text })?.text).toBe("a".repeat(275));
    // A word longer than the look-back is cut where it is.
    expect(normalize({ text: `a ${"b".repeat(400)}` })?.text).toBe(`a ${"b".repeat(278)}`);
  });

  it("replaces lone surrogates", () => {
    const element = normalize({ name: "Save \uD800 now", text: "\uDC00tail" });
    expect(element?.name).toBe("Save \uFFFD now");
    expect(element?.text).toBe("\uFFFDtail");
  });

  it("rejects raw strings over four times their cap and selectors over the cap", () => {
    const cap = BROWSER_ELEMENT_MAX_NAME_LENGTH;
    expect(normalize({ name: "n".repeat(cap * 4) })?.name).toHaveLength(cap);
    expect(normalize({ name: "n".repeat(cap * 4 + 1) })?.name).toBeNull();
    expect(
      normalize({ text: " ".repeat(BROWSER_ELEMENT_MAX_TEXT_LENGTH * 4 + 1) })?.text,
    ).toBeNull();
    expect(normalize({ tagName: "x".repeat(BROWSER_ELEMENT_MAX_TAG_LENGTH * 4 + 1) })).toBeNull();
    const selector = `#${"s".repeat(BROWSER_ELEMENT_MAX_SELECTOR_LENGTH - 1)}`;
    expect(normalize({ selector })?.selector).toBe(selector);
    expect(normalize({ selector: `${selector}s` })).toBeNull();
  });

  it.each(["INPUT", "textarea", "Select", "option"])("never keeps the text of a %s", (tagName) => {
    expect(normalize({ tagName, text: "hunter2" })?.text).toBeNull();
  });

  it.each([
    ["an email address", "Contact alice@example.com"],
    ["a bearer token", "Bearer abc.def"],
    ["a password", "password=hunter2"],
    ["a card number", "Card 4111 1111 1111 1111"],
    ["a run of 16 digits", "4111111111111111"],
    ["an API key", "Your api key"],
    ["a JWT", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.sig"],
  ])("drops a name, text or title that contains %s", (_label, value) => {
    expect(looksSensitiveBrowserText(value)).toBe(true);
    const element = normalize({ name: value, text: value }, { title: value });
    expect(element?.name).toBeNull();
    expect(element?.text).toBeNull();
    expect(element?.pageTitle).toBe("");
  });

  it("checks sensitive text before cutting it", () => {
    const text = `${"a".repeat(270)} alice@example.com`;
    expect(normalize({ text })?.text).toBeNull();
  });

  it("keeps ordinary text", () => {
    for (const value of ["Order #12345", "Save", "Call 555-0100", "2024-10-24"])
      expect(looksSensitiveBrowserText(value)).toBe(false);
  });

  it("rounds and clamps the box and drops a non-finite one", () => {
    expect(normalize({ box: { x: 10.4, y: -0.4, width: 99.5, height: 1e9 } })?.box).toEqual({
      x: 10,
      y: 0,
      width: 100,
      height: 1_000_000,
    });
    expect(normalize({ box: { x: -2e9, y: 5, width: -3, height: 4 } })?.box).toEqual({
      x: -1_000_000,
      y: 5,
      width: 0,
      height: 4,
    });
    for (const box of [
      { x: Number.NaN, y: 0, width: 1, height: 1 },
      { x: 0, y: Number.POSITIVE_INFINITY, width: 1, height: 1 },
      { x: "1", y: 0, width: 1, height: 1 },
      { x: 0, y: 0, width: 1 },
      null,
      [0, 0, 1, 1],
    ])
      expect(normalize({ box })?.box).toBeNull();
    expect(Object.is(normalize({ box: { x: -0.2, y: 0, width: 0, height: 0 } })?.box?.x, 0)).toBe(
      true,
    );
  });
});

describe("sanitizeBrowserElementUrl", () => {
  it("drops credentials, query and hash", () => {
    expect(
      sanitizeBrowserElementUrl(
        "https://alice:secret@app.example.com:8443/settings/2?token=abc&tab=billing#section",
      ),
    ).toBe("https://app.example.com:8443/settings/2");
    expect(sanitizeBrowserElementUrl("http://localhost:3000/#/settings")).toBe(
      "http://localhost:3000/",
    );
  });

  it.each([
    ["/projects/acme-web", "/projects/acme-web"],
    ["/settings/2", "/settings/2"],
    ["/blog/2024/10/hello-world", "/blog/2024/10/hello-world"],
    ["/users/alice%40example.com/settings", "/users/REDACTED/settings"],
    ["/u/alice%40example.com/settings", "/u/REDACTED/settings"],
    ["/u/alice@example.com", "/u/REDACTED"],
    ["/view/eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2ln", "/view/REDACTED"],
    ["/orders/123e4567-e89b-12d3-a456-426614174000/items", "/orders/REDACTED/items"],
    ["/files/a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8", "/files/REDACTED"],
    [`/docs/${"x".repeat(97)}`, "/docs/REDACTED"],
    ["/reset/abc123", "/reset/REDACTED"],
    ["/invite/welcome-team/accept", "/invite/REDACTED/accept"],
    ["/token/xyz/next", "/REDACTED/REDACTED/next"],
    ["/api/secret-stuff", "/api/REDACTED"],
    ["/password-reset/step-2", "/REDACTED/REDACTED"],
    ["/user-settings/notifications", "/user-settings/REDACTED"],
    ["/bad%escape/ok", "/bad%escape/ok"],
  ])("rewrites the path %s to %s", (path, expected) => {
    expect(sanitizeBrowserElementUrl(`https://app.example.com${path}`)).toBe(
      `https://app.example.com${expected}`,
    );
  });

  it.each([
    "file:///etc/passwd",
    "javascript:alert(1)",
    "data:text/html,hi",
    "about:blank",
    "chrome://settings",
    "not a url",
    "",
  ])("rejects %s", (value) => {
    expect(sanitizeBrowserElementUrl(value)).toBeNull();
  });

  it("rejects a sanitized URL over the URL cap", () => {
    const longPath = Array.from({ length: 100 }, () => "segment-name-that-is-long").join("/");
    expect(
      normalize({}, { url: `https://app.example.com/${longPath}?q=${"x".repeat(9_000)}` }),
    ).toBeNull();
    expect(
      normalize({}, { url: `https://app.example.com/settings?q=${"x".repeat(9_000)}` })?.url,
    ).toBe("https://app.example.com/settings");
  });
});

describe("idempotence", () => {
  const urls = [
    "https://alice:secret@app.example.com:8443/settings/2?token=abc#section",
    "https://app.example.com/reset/token/abc",
    "https://app.example.com/users/alice%40example.com/settings",
    "https://app.example.com/password-reset/REDACTED/x",
    "https://app.example.com/a%2Fb/%E2%9C%93/REDACTED",
    "http://localhost:3000/",
    "https://app.example.com/bad%escape/ok",
  ];
  const elements: Array<[Record<string, unknown>, Partial<typeof page>]> = [
    [{}, {}],
    [{ name: `${"a".repeat(255)}\u{1F600}b`, text: `${"a".repeat(275)} bcdefghij` }, {}],
    [
      { name: "Save\u0000\u0085changes", text: "\uD800 x", role: "  " },
      { title: "T ".repeat(300) },
    ],
    [{ tagName: "INPUT", text: "secret", name: "alice@example.com" }, { title: "Bearer x" }],
    [{ box: { x: 10.4, y: -0.4, width: 99.5, height: 1e9 } }, {}],
    [{ text: `a ${"b".repeat(400)}` }, {}],
    ...urls.map((url): [Record<string, unknown>, Partial<typeof page>] => [{}, { url }]),
  ];

  it("sanitizes a sanitized URL to itself", () => {
    for (const url of urls) {
      const once = sanitizeBrowserElementUrl(url);
      expect(once).not.toBeNull();
      expect(sanitizeBrowserElementUrl(once!)).toBe(once);
    }
  });

  it("normalizes a normalized element to itself", () => {
    for (const [fields, at] of elements) {
      const once = normalize(fields, at);
      expect(once).not.toBeNull();
      const twice = normalizeBrowserElementPick(once, { url: once!.url, title: once!.pageTitle });
      expect(twice).toEqual(once);
      for (const value of [once!.pageTitle, once!.name, once!.text].filter((v) => v !== null))
        expect(isWellFormed(value)).toBe(true);
      expect(Schema.decodeUnknownSync(ProjectBrowserPickedElement)(once)).toEqual(once);
    }
  });
});
