// Runs the desktop's hand-off page scripts (@ryco/shared/browserHandoff) in real Chromium. Test
// only: no web runtime module imports them.
import {
  BROWSER_SCRUB_SCRIPT,
  BROWSER_SIGN_IN_PROBE,
  BROWSER_TRACK_SECRET_FIELDS_SCRIPT,
  browserProbeExpression,
  browserSignInNeed,
  parseBrowserProbe,
  parseBrowserSignInSignals,
  selectorReadsFieldValues,
} from "@ryco/shared/browserHandoff";
import { afterEach, describe, expect, it } from "vite-plus/test";

// The desktop evaluates these strings in the page's main world; so does this test.
const run = (script: string): unknown => new Function(`return ${script}`)();

const fixtures: HTMLElement[] = [];
function mount(html: string): HTMLElement {
  const fixture = document.createElement("div");
  fixture.innerHTML = html;
  document.body.append(fixture);
  fixtures.push(fixture);
  return fixture;
}

/** Types into a field the way a page sees it: the value setter, then an input event. */
function type(field: HTMLInputElement, value: string) {
  field.value = value;
  field.dispatchEvent(new Event("input", { bubbles: true }));
}

afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.remove();
});

describe("hand-off scrub", () => {
  it("empties password and one-time-code fields and leaves other fields alone", () => {
    const form = mount(`
      <input id="email" autocomplete="username">
      <input id="password" type="password">
      <input id="code" autocomplete="one-time-code">`);
    const field = (id: string) => form.querySelector<HTMLInputElement>(`#${id}`)!;
    type(field("email"), "someone@example.com");
    type(field("password"), "correct-horse");
    type(field("code"), "123456");
    const inputs: string[] = [];
    field("password").addEventListener("input", () => inputs.push(field("password").value));
    expect(run(BROWSER_SCRUB_SCRIPT)).toBe(2);
    expect(field("password").value).toBe("");
    expect(field("code").value).toBe("");
    expect(field("email").value).toBe("someone@example.com");
    // Frameworks that keep the value in state hear the change, like typing.
    expect(inputs).toEqual([""]);
  });

  it("also empties a password field the user switched to visible during the hand-off", async () => {
    const form = mount(`<input id="password" type="password"><input id="plain">`);
    const password = form.querySelector<HTMLInputElement>("#password")!;
    const plain = form.querySelector<HTMLInputElement>("#plain")!;
    // The hand-off starts: its fields are marked and watched.
    run(BROWSER_TRACK_SECRET_FIELDS_SCRIPT);
    type(password, "correct-horse");
    type(plain, "not a secret");
    // The "show password" eye: the field becomes type=text with no password autocomplete.
    password.type = "text";
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(run(BROWSER_SCRUB_SCRIPT)).toBe(1);
    expect(password.value).toBe("");
    expect(plain.value).toBe("not a secret");
  });

  it("marks a field that became a password field after the start, and reaches shadow roots", async () => {
    const host = mount(`<div id="host"></div><input id="late">`);
    const shadow = host.querySelector("#host")!.attachShadow({ mode: "open" });
    shadow.innerHTML = `<input id="inner" type="password">`;
    run(BROWSER_TRACK_SECRET_FIELDS_SCRIPT);
    const late = host.querySelector<HTMLInputElement>("#late")!;
    late.type = "password";
    await new Promise((resolve) => setTimeout(resolve, 0));
    type(late, "secret-one");
    late.type = "text";
    await new Promise((resolve) => setTimeout(resolve, 0));
    const inner = shadow.querySelector<HTMLInputElement>("#inner")!;
    type(inner, "secret-two");
    expect(run(BROWSER_SCRUB_SCRIPT)).toBe(2);
    expect([late.value, inner.value]).toEqual(["", ""]);
  });
});

describe("hand-off probes", () => {
  it("reports the condition and the page without reading field values", () => {
    mount(`<h1>Welcome back</h1><input type="password" value="kept-private">`);
    const probe = parseBrowserProbe(
      run(browserProbeExpression({ text: "welcome BACK", gone: "Sign in" }, true)),
    );
    expect(probe).toMatchObject({ text: true, gone: true, heading: "Welcome back" });
    expect(probe?.secretFields).toBe(1);
    expect(JSON.stringify(probe)).not.toContain("kept-private");
  });

  it("spots a sign-in dialog and a one-time-code field", () => {
    mount(`<div role="dialog"><p>Log in to continue</p><input name="email"></div>`);
    const dialog = parseBrowserSignInSignals(run(BROWSER_SIGN_IN_PROBE))!;
    expect(browserSignInNeed(dialog)).toBe("sign-in");
    mount(`<input autocomplete="one-time-code">`);
    expect(browserSignInNeed(parseBrowserSignInSignals(run(BROWSER_SIGN_IN_PROBE))!)).toBe(
      "verification",
    );
  });
});

describe("done_when.selector in Chromium", () => {
  /** A sign-in form whose field holds `value` (attribute, mirrored attributes and property). */
  function form(value: string, level: string): HTMLElement {
    const fixture = mount(`
      <form id="login" class="c" role="form" name="login">
        <input id="f" class="c" name="q" type="text" value="${value}" data-value="${value}"
          aria-valuenow="${level}" placeholder="p" aria-label="User" data-testid="user">
        <a href="/x">x</a><button type="submit" disabled>Go</button>
      </form>`);
    fixture.querySelector<HTMLInputElement>("#f")!.value = value;
    return fixture;
  }
  /** What a selector matches in a form, by element position; "invalid" when Chromium refuses it. */
  function matches(selector: string, value: string, level: string): string {
    const fixture = form(value, level);
    try {
      const all = [...fixture.querySelectorAll("*")];
      return [...fixture.querySelectorAll(selector)].map((node) => all.indexOf(node)).join(",");
    } catch {
      return "invalid";
    } finally {
      fixture.remove();
    }
  }
  const leaks = (selector: string) =>
    matches(selector, "abc", "1") !== matches(selector, "xyz", "2");

  it("refuses the bypasses that do read the value here", () => {
    for (const selector of [
      ':is("\n), [value^=a], :is(")',
      ':is("\r), [value^=a], :is(")',
      ':is("\f), [value^=a], :is(")',
      'input[/**/value^="a"]',
      'input[value/**/^="a"]',
      "input[v\\61lue^=a]",
      "[data-value^=a]",
    ]) {
      // Each one tells the two values apart in Chromium, so the check must refuse it.
      expect(leaks(selector), JSON.stringify(selector)).toBe(true);
      expect(selectorReadsFieldValues(selector), JSON.stringify(selector)).toBe(true);
    }
  });

  it("accepts no selector that matches differently for two values (seeded ASCII fuzz)", () => {
    const pieces = [
      "input",
      "form",
      "a",
      "*",
      "#f",
      "#login",
      ".c",
      " ",
      " > ",
      ", ",
      "+",
      "~",
      "[name=q]",
      "[type=text]",
      '[href="/x"]',
      "[aria-label=User]",
      "[data-testid=user]",
      "[value^=a]",
      "[value^=x]",
      "[data-value^=a]",
      "[aria-valuenow=1]",
      "[placeholder]",
      ":is(",
      ":not(",
      ":has(",
      ":where(",
      ")",
      ":first-child",
      ":nth-child(2n+1)",
      ":disabled",
      ":enabled",
      ":checked",
      ":placeholder-shown",
      ":-internal-autofill-selected",
      '"',
      "'",
      "\n",
      "\r",
      "\f",
      "\t",
      "/*",
      "*/",
      "\\",
      "[",
      "]",
      "=",
      "^=",
    ];
    let seed = 23;
    const next = (n: number) => {
      seed = (seed * 48_271) % 2_147_483_647;
      return seed % n;
    };
    let accepted = 0;
    let valid = 0;
    for (let run = 0; run < 4_000; run += 1) {
      let selector = "";
      const length = 1 + next(8);
      for (let index = 0; index < length; index += 1) {
        // Mostly pieces, sometimes any ASCII character, control characters included.
        selector += next(5) === 0 ? String.fromCharCode(next(128)) : pieces[next(pieces.length)]!;
      }
      if (selectorReadsFieldValues(selector)) continue;
      accepted += 1;
      const first = matches(selector, "abc", "1");
      if (first !== "invalid") valid += 1;
      expect(matches(selector, "xyz", "2"), JSON.stringify(selector)).toBe(first);
    }
    // The run must exercise real, valid selectors, not only refusals.
    expect(accepted).toBeGreaterThan(300);
    expect(valid).toBeGreaterThan(100);
  });
});
