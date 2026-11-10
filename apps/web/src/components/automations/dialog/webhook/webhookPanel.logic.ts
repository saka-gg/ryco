/**
 * What a webhook schedule's panel says (`docs/automation-webhooks.md`, "For
 * the user"): its URLs, the last request in words, and the ready-made
 * snippets. Pure; the panel only renders it. A snippet never carries the
 * secret itself: it reads `$RYCO_HOOK_SECRET` (or the repository secret of
 * that name), so copying one never leaks it into a shell history or a file.
 */
import type { AutomationHookRequestOutcome, AutomationHookView } from "@ryco/contracts";

/** The address a sender reaches this machine at, when the app knows none it can use. */
export const DIRECT_ORIGIN_PLACEHOLDER = "<this machine's address>";

const OUTCOME_WORDS: Readonly<Record<AutomationHookRequestOutcome, string>> = {
  started: "started a run",
  "awaiting-approval": "waiting for approval",
  duplicate: "duplicate, nothing new ran",
  ping: "GitHub ping",
  unauthorized: "refused: bad signature",
  "not-accepting": "refused: paused",
  "rate-limited": "refused: rate limited",
  busy: "refused for now: a run was still waiting or starting",
  "too-large": "refused: too large",
  failed: "failed",
};

/** What the node did with a request, in words ("started a run", "refused: bad signature"). */
export function hookOutcomeWords(outcome: AutomationHookRequestOutcome): string {
  return OUTCOME_WORDS[outcome];
}

/** Whether the outcome is a refusal or a failure (said in the error tone). */
export function hookOutcomeRefused(outcome: AutomationHookRequestOutcome): boolean {
  return (
    outcome === "unauthorized" ||
    outcome === "not-accepting" ||
    outcome === "rate-limited" ||
    outcome === "busy" ||
    outcome === "too-large" ||
    outcome === "failed"
  );
}

/** How a request came: "through the Hub" or "directly". */
export function hookViaWords(via: "cloud" | "direct"): string {
  return via === "cloud" ? "through the Hub" : "directly";
}

/**
 * The Cloud row: null when there is none (no Hub). `url` is null when the
 * Hub cannot take requests for it at all (it predates webhooks); `note` says
 * why a URL does not work yet, or works only later.
 */
export interface HookCloudRow {
  readonly url: string | null;
  readonly note: string | null;
}

export function hookCloudRow(
  view: Pick<AutomationHookView, "cloudUrl" | "cloudState">,
): HookCloudRow | null {
  switch (view.cloudState) {
    case "none":
      return null;
    case "unsupported":
      return {
        url: null,
        note: "The Cloud URL isn't available yet: this Hub doesn't support webhooks.",
      };
    case "registered":
      return view.cloudUrl ? { url: view.cloudUrl, note: null } : null;
    case "pending":
      return view.cloudUrl ? { url: view.cloudUrl, note: "Registering with the Hub…" } : null;
    case "paused":
      return view.cloudUrl
        ? { url: view.cloudUrl, note: "Paused: the Hub refuses requests until you resume it." }
        : null;
  }
}

/** Loopback hosts: an address only this machine reaches. */
function isLoopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return (
    host === "localhost" || host.endsWith(".localhost") || host === "::1" || host.startsWith("127.")
  );
}

/**
 * The direct URL: the node's own HTTP origin (as this app reaches it) and the
 * hook's path. Without an origin (a hosted reader goes through the Hub) the
 * path follows a placeholder; a loopback origin works only on this machine.
 */
export interface HookDirectUrl {
  /** Null when the origin is unknown: `display` then holds the placeholder. */
  readonly url: string | null;
  readonly display: string;
  readonly hint: string | null;
}

export function hookDirectUrl(origin: string | null, directPath: string): HookDirectUrl {
  let parsed: URL | null = null;
  if (origin) {
    try {
      parsed = new URL(origin);
    } catch {
      parsed = null;
    }
  }
  if (!parsed || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) {
    return {
      url: null,
      display: `${DIRECT_ORIGIN_PLACEHOLDER}${directPath}`,
      hint: "Put the address senders reach this machine at in front: its name on your network or its Tailscale address.",
    };
  }
  const url = `${parsed.origin}${directPath}`;
  return {
    url,
    display: url,
    hint: isLoopbackHost(parsed.hostname)
      ? "This address works only on this machine. Other senders use its name on your network or its Tailscale address instead."
      : null,
  };
}

/**
 * The URL a snippet posts to: the Cloud URL while the Hub takes requests for
 * it (or will, once registered), else the direct URL (or its placeholder).
 */
export function hookSnippetUrl(cloud: HookCloudRow | null, direct: HookDirectUrl): string {
  return cloud?.url ?? direct.url ?? direct.display;
}

/** A shell word in single quotes. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** A YAML scalar in single quotes. */
function yamlQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** The signing line both shell snippets share (GitHub's `X-Hub-Signature-256` format). */
const SIGN_LINE = `sig="sha256=$(printf '%s' "$body" | openssl dgst -sha256 -hmac "$RYCO_HOOK_SECRET" -r | cut -d' ' -f1)"`;

/** A signed test request from a shell; the secret comes from `$RYCO_HOOK_SECRET`. */
export function hookCurlSnippet(url: string): string {
  return [
    `body='{"event":"test"}'`,
    SIGN_LINE,
    `curl -fsS -X POST ${shellQuote(url)} -H 'content-type: application/json' \\`,
    `  -H "x-hub-signature-256: $sig" --data-binary "$body"`,
  ].join("\n");
}

/** A GitHub Actions step that signs its body with the repository secret `RYCO_HOOK_SECRET`. */
export function hookActionsSnippet(url: string): string {
  return [
    "- name: Call the Ryco automation",
    "  env:",
    "    RYCO_HOOK_SECRET: ${{ secrets.RYCO_HOOK_SECRET }}",
    `    RYCO_HOOK_URL: ${yamlQuote(url)}`,
    "  run: |",
    `    body=$(jq -nc --arg ref "$GITHUB_REF_NAME" --arg sha "$GITHUB_SHA" '{ref: $ref, sha: $sha}')`,
    `    ${SIGN_LINE}`,
    `    curl -fsS -X POST "$RYCO_HOOK_URL" -H 'content-type: application/json' \\`,
    `      -H "x-hub-signature-256: $sig" --data-binary "$body"`,
  ].join("\n");
}

/** GitHub's "Add webhook" form, field by field; the secret is copied from the panel. */
export interface HookGithubField {
  readonly label: string;
  readonly value: string;
  /** What Copy puts on the clipboard; null: nothing to copy (a choice to make in the form). */
  readonly copy: "value" | "secret" | null;
}

export function hookGithubFields(url: string): readonly HookGithubField[] {
  return [
    { label: "Payload URL", value: url, copy: "value" },
    { label: "Content type", value: "application/json", copy: "value" },
    { label: "Secret", value: "This webhook's secret", copy: "secret" },
    {
      label: "Events",
      value: "Just the push event, or the events you choose",
      copy: null,
    },
  ];
}

/** The secret, hidden: one dot per character, at most 24. */
export function maskedSecret(secret: string): string {
  return "•".repeat(Math.min(24, Math.max(8, secret.length)));
}
