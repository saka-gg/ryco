import { describe, expect, it } from "vite-plus/test";

import {
  DIRECT_ORIGIN_PLACEHOLDER,
  hookActionsSnippet,
  hookCloudRow,
  hookCurlSnippet,
  hookDirectUrl,
  hookGithubFields,
  hookOutcomeRefused,
  hookOutcomeWords,
  hookSnippetUrl,
  hookViaWords,
  maskedSecret,
} from "./webhookPanel.logic";

const PATH = "/api/automation-hooks/h00k";
const CLOUD = "https://hub.example/hooks/h00k";

describe("a webhook's words", () => {
  it("says every outcome, refusals in the error tone", () => {
    expect(hookOutcomeWords("started")).toBe("started a run");
    expect(hookOutcomeWords("awaiting-approval")).toBe("waiting for approval");
    expect(hookOutcomeWords("duplicate")).toBe("duplicate, nothing new ran");
    expect(hookOutcomeWords("ping")).toBe("GitHub ping");
    expect(hookOutcomeWords("unauthorized")).toBe("refused: bad signature");
    expect(hookOutcomeWords("not-accepting")).toBe("refused: paused");
    expect(hookOutcomeWords("rate-limited")).toBe("refused: rate limited");
    expect(hookOutcomeWords("busy")).toBe("refused for now: a run was still waiting or starting");
    expect(hookOutcomeWords("too-large")).toBe("refused: too large");
    expect(hookOutcomeWords("failed")).toBe("failed");
    expect(hookOutcomeRefused("started")).toBe(false);
    expect(hookOutcomeRefused("ping")).toBe(false);
    expect(hookOutcomeRefused("unauthorized")).toBe(true);
    expect(hookOutcomeRefused("busy")).toBe(true);
    expect(hookViaWords("cloud")).toBe("through the Hub");
    expect(hookViaWords("direct")).toBe("directly");
  });

  it("shows the Cloud row by the Hub's state, and none without a Hub", () => {
    expect(hookCloudRow({ cloudUrl: CLOUD, cloudState: "registered" })).toEqual({
      url: CLOUD,
      note: null,
    });
    expect(hookCloudRow({ cloudUrl: CLOUD, cloudState: "pending" })?.note).toBe(
      "Registering with the Hub…",
    );
    expect(hookCloudRow({ cloudUrl: CLOUD, cloudState: "paused" })?.note).toBe(
      "Paused: the Hub refuses requests until you resume it.",
    );
    expect(hookCloudRow({ cloudUrl: CLOUD, cloudState: "unsupported" })).toEqual({
      url: null,
      note: "The Cloud URL isn't available yet: this Hub doesn't support webhooks.",
    });
    expect(hookCloudRow({ cloudUrl: null, cloudState: "none" })).toBeNull();
  });

  it("composes the direct URL from the node's origin, or says where the address goes", () => {
    expect(hookDirectUrl("http://studio.local:3773/", PATH)).toEqual({
      url: `http://studio.local:3773${PATH}`,
      display: `http://studio.local:3773${PATH}`,
      hint: null,
    });
    expect(hookDirectUrl("http://127.0.0.1:3773", PATH).hint).toMatch(/only on this machine/);
    expect(hookDirectUrl("http://localhost:5173", PATH).hint).toMatch(/only on this machine/);
    const unknown = hookDirectUrl(null, PATH);
    expect(unknown.url).toBeNull();
    expect(unknown.display).toBe(`${DIRECT_ORIGIN_PLACEHOLDER}${PATH}`);
    expect(unknown.hint).toMatch(/Tailscale/);
    expect(hookDirectUrl("not a url", PATH).url).toBeNull();
  });

  it("posts snippets to the Cloud URL while the Hub takes it, else directly", () => {
    const direct = hookDirectUrl("http://studio.local:3773", PATH);
    expect(hookSnippetUrl(hookCloudRow({ cloudUrl: CLOUD, cloudState: "pending" }), direct)).toBe(
      CLOUD,
    );
    expect(
      hookSnippetUrl(hookCloudRow({ cloudUrl: CLOUD, cloudState: "unsupported" }), direct),
    ).toBe(`http://studio.local:3773${PATH}`);
    expect(hookSnippetUrl(null, hookDirectUrl(null, PATH))).toBe(
      `${DIRECT_ORIGIN_PLACEHOLDER}${PATH}`,
    );
  });
});

describe("a webhook's snippets", () => {
  const SECRET = "s3cr3t-value";

  it("signs a curl request with the secret from the environment, never inline", () => {
    const snippet = hookCurlSnippet(CLOUD);
    expect(snippet).toContain(`curl -fsS -X POST '${CLOUD}'`);
    expect(snippet).toContain(`-hmac "$RYCO_HOOK_SECRET"`);
    expect(snippet).toContain(`-H "x-hub-signature-256: $sig"`);
    expect(snippet).not.toContain(SECRET);
    // A quote in the URL cannot end the shell word.
    expect(hookCurlSnippet("https://x/it's")).toContain(`'https://x/it'\\''s'`);
  });

  it("gives a GitHub Actions step that signs its body with the repository secret", () => {
    const snippet = hookActionsSnippet(CLOUD);
    expect(snippet).toContain("RYCO_HOOK_SECRET: ${{ secrets.RYCO_HOOK_SECRET }}");
    expect(snippet).toContain(`RYCO_HOOK_URL: '${CLOUD}'`);
    expect(snippet).toContain(`curl -fsS -X POST "$RYCO_HOOK_URL"`);
    expect(snippet).not.toContain(SECRET);
  });

  it("fills GitHub's webhook form field by field", () => {
    const fields = hookGithubFields(CLOUD);
    expect(fields.map((field) => [field.label, field.copy])).toEqual([
      ["Payload URL", "value"],
      ["Content type", "value"],
      ["Secret", "secret"],
      ["Events", null],
    ]);
    expect(fields[0]?.value).toBe(CLOUD);
    expect(fields[1]?.value).toBe("application/json");
    expect(fields.some((field) => field.value.includes(SECRET))).toBe(false);
  });

  it("hides the secret behind dots", () => {
    expect(maskedSecret(SECRET)).toBe("•".repeat(SECRET.length));
    expect(maskedSecret("x".repeat(64))).toHaveLength(24);
    expect(maskedSecret("ab")).toHaveLength(8);
  });
});
