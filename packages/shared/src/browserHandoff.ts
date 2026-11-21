/**
 * The rules of handing a Ryco browser tab to the user (`ryco_browser` action `handoff`): the
 * condition that ends a hand-off by itself (`done_when`), the page probe that checks it, when a
 * page looks like a place to sign in, and the sentences the agent reads at the end. Pure, so the
 * node (validation, the result) and the desktop (the probe, the sign-in hint) share one copy.
 *
 * @module browserHandoff
 */
import type { UserActionNeed, UserActionOutcome } from "@ryco/contracts/user-action-request";

/** Ends the hand-off by itself once every given part holds. */
export interface BrowserDoneWhen {
  /**
   * The tab's URL without query and fragment contains this or matches this glob (`*`), or the
   * full URL matches `/regex/flags`. Without the query, because sign-in URLs carry the address to
   * return to.
   */
  readonly url?: string | undefined;
  /** This text is visible on the page (case-insensitive). */
  readonly text?: string | undefined;
  /** This text is no longer visible on the page (case-insensitive). */
  readonly gone?: string | undefined;
  /** An element matching this CSS selector exists. */
  readonly selector?: string | undefined;
}

export const BROWSER_DONE_WHEN_MAX_CHARS = 512;
/** A met condition counts once the page has loaded, or after this long if it never finishes. */
export const BROWSER_HANDOFF_SETTLE_MS = 4_000;

/** What the page probe reports. Fields of parts that were not asked for are absent. */
export interface BrowserPageProbe {
  readonly href: string;
  readonly title: string;
  readonly ready: string;
  readonly text?: boolean;
  readonly gone?: boolean;
  /** "invalid" when the selector does not parse. */
  readonly selector?: boolean | "invalid";
  readonly heading?: string;
  /** Visible password and one-time-code fields. */
  readonly secretFields?: number;
}

const isRegexPattern = (pattern: string) => /^\/.+\/[a-z]*$/u.test(pattern);

/** A matcher for `BrowserDoneWhen.url`: substring, glob (`*`) or `/regex/flags`. Throws on a bad regex. */
export function browserUrlMatcher(pattern: string): (url: string) => boolean {
  const regex = /^\/(.+)\/([a-z]*)$/u.exec(pattern);
  if (regex) {
    const compiled = new RegExp(regex[1] ?? "", regex[2]);
    return (url) => compiled.test(url);
  }
  if (pattern.includes("*")) {
    const compiled = new RegExp(
      `^${pattern
        .split("*")
        .map((part) => part.replace(/[.+?^${}()|[\]\\]/gu, "\\$&"))
        .join(".*")}$`,
      "u",
    );
    return (url) => compiled.test(url);
  }
  return (url) => url.includes(pattern);
}

/** See `BrowserDoneWhen.url`. */
export function browserUrlHolds(pattern: string, href: string): boolean {
  return browserUrlMatcher(pattern)(isRegexPattern(pattern) ? href : href.replace(/[?#].*$/u, ""));
}

/**
 * Checks the condition before anything is handed over. Returns a message for the agent, or
 * undefined when it is fine (or absent).
 */
export function validateBrowserDoneWhen(
  condition: BrowserDoneWhen | undefined,
): string | undefined {
  if (condition === undefined) return undefined;
  const given = (["url", "text", "gone", "selector"] as const).filter(
    (key) => typeof condition[key] === "string" && condition[key] !== "",
  );
  if (given.length === 0) {
    return "done_when needs at least one of url, text, gone or selector (or leave it out to wait for the user).";
  }
  for (const key of given) {
    if ((condition[key] ?? "").length > BROWSER_DONE_WHEN_MAX_CHARS) {
      return `done_when.${key} is longer than ${BROWSER_DONE_WHEN_MAX_CHARS} characters.`;
    }
  }
  if (condition.url) {
    try {
      browserUrlMatcher(condition.url);
    } catch (error) {
      return `done_when.url is not a valid regular expression: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  // Attribute selectors on `value` (or pseudo-classes that read input state) could test what the
  // user types: frameworks mirror it into the attribute.
  if (
    condition.selector &&
    /\[\s*value\b|:(?:placeholder-shown|valid|invalid|user-valid|user-invalid|in-range|out-of-range|blank|autofill|-webkit-autofill)\b/iu.test(
      condition.selector,
    )
  ) {
    return "done_when.selector cannot test field values: what the user types stays private. Test for an element of the page after sign-in instead.";
  }
  return undefined;
}

/** True when the probe says every given part of the condition holds. */
export function browserDoneWhenHolds(
  condition: BrowserDoneWhen,
  probe: Pick<BrowserPageProbe, "href" | "text" | "gone" | "selector">,
): boolean {
  if (condition.url && !browserUrlHolds(condition.url, probe.href)) return false;
  if (condition.text && probe.text !== true) return false;
  if (condition.gone && probe.gone !== true) return false;
  if (condition.selector && probe.selector !== true) return false;
  return true;
}

/** Password, one-time-code and payment-secret fields: never echoed, emptied after a hand-off. */
export const BROWSER_SECRET_FIELD_SELECTOR =
  'input[type=password i], input[autocomplete~="current-password" i], input[autocomplete~="new-password" i], input[autocomplete~="one-time-code" i], input[autocomplete~="cc-number" i], input[autocomplete~="cc-csc" i]';

/**
 * An expression that reports the page's state as a JSON string (`BrowserPageProbe`): always URL,
 * title and readiness; the condition's parts; with `describe`, the main heading and how many
 * secret fields are visible. Reads no field values.
 */
export function browserProbeExpression(
  condition: BrowserDoneWhen | undefined,
  describe: boolean,
): string {
  const text = condition?.text ? condition.text.toLowerCase() : null;
  const gone = condition?.gone ? condition.gone.toLowerCase() : null;
  const selector = condition?.selector || null;
  return `(() => {
  const r = { href: location.href, title: document.title, ready: document.readyState };
  const TEXT = ${JSON.stringify(text)}, GONE = ${JSON.stringify(gone)}, SEL = ${JSON.stringify(selector)};
  if (TEXT !== null || GONE !== null) {
    const body = document.body ? document.body.innerText.toLowerCase() : '';
    if (TEXT !== null) r.text = body.includes(TEXT);
    if (GONE !== null) r.gone = !body.includes(GONE);
  }
  if (SEL !== null) { try { r.selector = !!document.querySelector(SEL); } catch { r.selector = 'invalid'; } }
  if (${describe}) {
    const h = document.querySelector('h1') || document.querySelector('h2') || document.querySelector('[role=heading]');
    r.heading = h ? h.innerText.replace(/\\s+/g, ' ').trim().slice(0, 120) : '';
    r.secretFields = [...document.querySelectorAll(${JSON.stringify(BROWSER_SECRET_FIELD_SELECTOR)})].filter(e => { const b = e.getBoundingClientRect(); return b.width > 2 && b.height > 2 && getComputedStyle(e).visibility !== 'hidden'; }).length;
  }
  return JSON.stringify(r);
})()`;
}

export function parseBrowserProbe(value: unknown): BrowserPageProbe | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const probe = JSON.parse(value) as BrowserPageProbe;
    return typeof probe.href === "string" && typeof probe.title === "string" ? probe : undefined;
  } catch {
    return undefined;
  }
}

// ------------------------------------------------------------------------------- sign-in pages

/** What the sign-in probe found on the page (`BROWSER_SIGN_IN_PROBE`). */
export interface BrowserSignInSignals {
  readonly href: string;
  /** Identifies the document and route: a same-document route change gives a new one. */
  readonly page: string;
  readonly passwords: number;
  readonly oneTimeCodes: number;
  readonly webauthn: number;
  readonly captcha: boolean;
  /** A visible dialog with a password field or a sign-in button. */
  readonly loginModal: boolean;
}

/**
 * The cheap probe the hint runs after open, navigate, observe and click: visible password,
 * one-time-code and passkey fields, captcha frames and sign-in dialogs. Reads no field values.
 */
export const BROWSER_SIGN_IN_PROBE = `(() => {
  const shown = e => { const b = e.getBoundingClientRect(); return b.width > 2 && b.height > 2 && getComputedStyle(e).visibility !== 'hidden'; };
  const count = sel => [...document.querySelectorAll(sel)].filter(shown).length;
  const otp = count('input[autocomplete~="one-time-code" i], input[name*="otp" i], input[id*="otp" i], input[name*="totp" i], input[name*="2fa" i], input[name*="mfa" i]');
  const captcha = [...document.querySelectorAll('iframe[src]')].some(f => /(?:google\\.com|recaptcha\\.net)\\/recaptcha|hcaptcha\\.com|challenges\\.cloudflare\\.com/i.test(f.src)) || !!document.querySelector('.g-recaptcha, .h-captcha, .cf-turnstile');
  const dialogs = [...document.querySelectorAll('dialog[open], [role=dialog], [aria-modal=true]')].filter(shown);
  const loginModal = dialogs.some(d => d.querySelector('input[type=password i]') || /\\b(sign|log)\\s?in\\b/i.test((d.innerText || '').slice(0, 2000)) && d.querySelector('input'));
  return JSON.stringify({ href: location.href, page: String(performance.timeOrigin) + location.pathname, passwords: count('input[type=password i]'), oneTimeCodes: otp, webauthn: count('input[autocomplete~="webauthn" i]'), captcha, loginModal });
})()`;

export function parseBrowserSignInSignals(value: unknown): BrowserSignInSignals | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const signals = JSON.parse(value) as BrowserSignInSignals;
    return typeof signals.href === "string" && typeof signals.page === "string"
      ? signals
      : undefined;
  } catch {
    return undefined;
  }
}

const IDP_HOSTS: readonly RegExp[] = [
  /^login\.microsoftonline\.(com|us|de)$/u,
  /^login\.(windows|chinacloudapi)\.net$/u,
  /^login\.live\.com$/u,
  /^accounts\.google\.com$/u,
  /^appleid\.apple\.com$/u,
  /\.okta(preview)?\.com$/u,
  /\.auth0\.com$/u,
  /\.onelogin\.com$/u,
  /\.pingone\.(com|eu)$/u,
  /\.duosecurity\.com$/u,
  /^(login|signin|sso|auth|adfs|sts|idp|keycloak)\./u,
];

const IDP_PATHS =
  /\/(adfs\/ls|oauth2?\/(v2\.0\/)?authorize|protocol\/openid-connect\/auth|saml2?\/(sso|login)|idp\/sso|(log-?in|sign-?in|sso|session\/new|two[-_]?factor|2fa|mfa|verify)(\.\w+)?\/?$)/iu;

/** Why the page looks like it needs the user, most specific first; null when it does not. */
export function browserSignInNeed(signals: BrowserSignInSignals): UserActionNeed | null {
  if (signals.captcha) return "captcha";
  if (signals.oneTimeCodes > 0 || signals.webauthn > 0) return "verification";
  if (signals.passwords > 0 || signals.loginModal) return "sign-in";
  let url: URL;
  try {
    url = new URL(signals.href);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (IDP_HOSTS.some((host) => host.test(url.hostname)) || IDP_PATHS.test(url.pathname)) {
    return /two[-_]?factor|2fa|mfa|verify/iu.test(url.pathname) ? "verification" : "sign-in";
  }
  return null;
}

const NEED_WORDS: Record<UserActionNeed, string> = {
  "sign-in": "a sign-in page",
  verification: "a verification step (one-time code or passkey)",
  captcha: "a captcha",
  consent: "a consent screen",
  input: "a step for the user",
};

/**
 * The hint appended to a result: hand the tab over for real accounts, sign in yourself only with
 * test credentials you were given, and never ask for credentials in chat.
 */
export function browserSignInHint(tab: string, need: UserActionNeed): string {
  return `${tab} shows ${NEED_WORDS[need]}. If you were given test credentials for this app (a local dev app, a test account), go ahead. Otherwise do not sign in yourself and never ask for passwords or codes in chat: hand the tab to the user with ryco_browser action "handoff" (tab, requestId, message, need:"${need}", done_when such as {url:"/dashboard"} for what you expect after it), then keep calling it with the same requestId until it ends.`;
}

// -------------------------------------------------------------------------------- the result

const clip = (value: string, max: number) =>
  value.length > max ? `${value.slice(0, max - 1)}…` : value;

function formatWaited(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1_000));
  if (seconds < 90) return `${seconds} s`;
  return `${Math.round(seconds / 60)} min`;
}

/** The first sentence of the result: how the hand-off ended, and what to do next. */
export function describeBrowserHandoffOutcome(
  outcome: UserActionOutcome,
  tab: string,
  waitedMs: number,
): string {
  const after = formatWaited(waitedMs);
  switch (outcome) {
    case "condition-met":
      return `done_when matched after ${after}: the user finished in ${tab}, which is yours again.`;
    case "done":
      return `The user said they are done (after ${after}); ${tab} is yours again. Observe it before you continue.`;
    case "declined":
      return `The user declined ("Won't do") after ${after}; ${tab} is yours again. Do not ask again: continue without it, or ask the user in chat what they would prefer.`;
    case "timeout":
      return `No answer from the user within ${after}; the request was withdrawn and ${tab} is yours again. Ask the user in chat before you hand it over again.`;
    case "closed":
      return `${tab} was closed (after ${after}). Open a new tab if you still need the page.`;
    case "cancelled":
      return `The hand-off of ${tab} was withdrawn; the tab is yours again.`;
  }
}

/** `Page now: <url> — "<title>", heading "…" (still loading).` and a warning when a login form stays. */
export function describeBrowserPage(
  probe: BrowserPageProbe | undefined,
  fallbackUrl: string,
  outcome: UserActionOutcome,
): string {
  if (!probe) return `Page now: ${clip(fallbackUrl, 300)}.`;
  const title = probe.title.trim();
  const heading =
    probe.heading && probe.heading !== title ? `, heading "${clip(probe.heading, 100)}"` : "";
  const loading = probe.ready !== "complete" ? " (still loading)" : "";
  const lines = [
    `Page now: ${clip(probe.href || fallbackUrl, 300)}${title ? ` — "${clip(title, 120)}"` : ""}${heading}${loading}.`,
  ];
  if ((probe.secretFields ?? 0) > 0 && (outcome === "done" || outcome === "condition-met")) {
    lines.push("It still shows a password or code field, so the sign-in may not be complete.");
  }
  return lines.join(" ");
}

/** What was kept private while the user had the tab, or "" when nothing was. */
export function describeBrowserHandoffPrivacy(
  withheld: { readonly requests: number; readonly messages: number },
  scrubbed: number,
): string {
  const parts: string[] = [];
  if (withheld.requests > 0) {
    parts.push(
      `${withheld.requests === 1 ? "the request" : `the ${withheld.requests} requests`} the page sent ${withheld.requests === 1 ? "is" : "are"} listed by origin only`,
    );
  }
  if (withheld.messages > 0) {
    parts.push(
      `${withheld.messages === 1 ? "its console message is" : `its ${withheld.messages} console messages are`} withheld`,
    );
  }
  if (scrubbed > 0) {
    parts.push(
      `${scrubbed === 1 ? "a password or code field still on the page was" : `${scrubbed} password or code fields still on the page were`} emptied`,
    );
  }
  return parts.length === 0 ? "" : `While the user had the tab, ${parts.join("; ")}.`;
}
