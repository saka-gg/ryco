import { describe, expect, it } from "vite-plus/test";

import {
  buildNewThreadLink,
  parseNewThreadLink,
  parsePromptLinkPullRequest,
  parsePromptLinkRepository,
  PROMPT_LINK_MAX_PROMPT_LENGTH,
  promptLinkRepositoryKey,
  promptLinkSearchFromParams,
  sanitizeLinkedPrompt,
} from "./promptLinks.ts";

describe("sanitizeLinkedPrompt", () => {
  it("removes characters a reader cannot see and counts them", () => {
    const tagged = "rate me" + String.fromCodePoint(0xe0041, 0xe0042);
    expect(sanitizeLinkedPrompt(`a\u200Bb\u202Ec\uFEFF${tagged}`)).toEqual({
      text: "abcrate me",
      hiddenCharacters: 5,
    });
    // Bidi isolates and overrides, soft hyphen, control characters.
    expect(sanitizeLinkedPrompt("x\u2066y\u2069z\u00AD\u0007")).toEqual({
      text: "xyz",
      hiddenCharacters: 4,
    });
  });

  it("keeps line breaks and tabs, and turns other separators into newlines", () => {
    expect(sanitizeLinkedPrompt("a\u2028b\u2029c\r\nd\te")).toEqual({
      text: "a\nb\nc\nd\te",
      hiddenCharacters: 0,
    });
  });

  it("keeps emoji sequences intact", () => {
    const family = "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}";
    const heart = "\u2764\uFE0F";
    expect(sanitizeLinkedPrompt(`${family} ${heart}`)).toEqual({
      text: `${family} ${heart}`,
      hiddenCharacters: 0,
    });
    expect(sanitizeLinkedPrompt("a\u200Db").hiddenCharacters).toBe(1);
    expect(sanitizeLinkedPrompt("\u{1F468}\u200D").hiddenCharacters).toBe(1);
  });
});

describe("parseNewThreadLink", () => {
  it("reads a prompt with its optional repository and model", () => {
    expect(
      parseNewThreadLink(
        "?prompt=Fix+the+build&repo=https://github.com/saka-gg/ryco.git&provider=codex&model=gpt-5.5",
      ),
    ).toEqual({
      ok: true,
      value: {
        kind: "new",
        prompt: { text: "Fix the build", hiddenCharacters: 0 },
        repository: { owner: "saka-gg", name: "ryco" },
        provider: "codex",
        model: "gpt-5.5",
      },
    });
  });

  it("keeps the prompt text exactly, quotes and numbers included", () => {
    const result = parseNewThreadLink(`?prompt=${encodeURIComponent('"123" & = ?')}`);
    expect(result.ok && result.value.kind === "new" && result.value.prompt.text).toBe(
      '"123" & = ?',
    );
  });

  it("reads a model only together with a provider", () => {
    const result = parseNewThreadLink("?prompt=hi&model=gpt-5.5");
    expect(result.ok && result.value.kind === "new" && result.value.model).toBeNull();
  });

  it("reads a pull request link, whose prompt is optional", () => {
    for (const pr of [
      "saka-gg/ryco/42",
      "saka-gg/ryco%2342",
      "https://github.com/saka-gg/ryco/pull/42/files",
    ]) {
      expect(parseNewThreadLink(`?pr=${pr}&repo=other/repo`)).toEqual({
        ok: true,
        value: {
          kind: "pull-request",
          pullRequest: { owner: "saka-gg", name: "ryco", number: 42 },
          prompt: null,
        },
      });
    }
  });

  it("caps the prompt at 8,000 characters", () => {
    expect(PROMPT_LINK_MAX_PROMPT_LENGTH).toBe(8_000);
    expect(parseNewThreadLink(`?prompt=${"x".repeat(8_000)}`).ok).toBe(true);
    const tooLong = parseNewThreadLink(`?prompt=${"x".repeat(8_001)}`);
    expect(tooLong).toEqual({
      ok: false,
      error: "This prompt is longer than 8,000 characters, so Ryco did not open it.",
    });
  });

  it("refuses links it cannot open safely", () => {
    // No prompt, or one made only of hidden characters.
    expect(parseNewThreadLink("?repo=a/b").ok).toBe(false);
    expect(parseNewThreadLink("?prompt=%E2%80%8B%E2%80%8B").ok).toBe(false);
    // Repository and pull request slugs GitHub would not accept.
    expect(parseNewThreadLink("?prompt=x&repo=../etc").ok).toBe(false);
    expect(parseNewThreadLink("?prompt=x&repo=owner/..").ok).toBe(false);
    expect(parseNewThreadLink("?prompt=x&repo=-owner/name").ok).toBe(false);
    expect(parseNewThreadLink("?pr=owner/name/0").ok).toBe(false);
    expect(parseNewThreadLink("?pr=owner/name/abc").ok).toBe(false);
    // Provider and model slugs.
    expect(parseNewThreadLink("?prompt=x&provider=1codex").ok).toBe(false);
    expect(parseNewThreadLink("?prompt=x&provider=co%20dex").ok).toBe(false);
    expect(parseNewThreadLink(`?prompt=x&provider=${"a".repeat(65)}`).ok).toBe(false);
    expect(parseNewThreadLink("?prompt=x&provider=codex&model=%3Cscript%3E").ok).toBe(false);
    expect(parseNewThreadLink("?prompt=x&provider=codex&model=gpt%E2%80%8B5").ok).toBe(false);
  });
});

describe("repository slugs", () => {
  it("reads owner/name and GitHub URLs, and keys them the way remotes are keyed", () => {
    expect(parsePromptLinkRepository("Saka-GG/Ryco")).toEqual({ owner: "Saka-GG", name: "Ryco" });
    expect(parsePromptLinkRepository("https://www.github.com/a/b/")).toEqual({
      owner: "a",
      name: "b",
    });
    expect(parsePromptLinkRepository("https://gitlab.com/a/b")).toBeNull();
    expect(parsePromptLinkPullRequest("a/b#7")).toEqual({ owner: "a", name: "b", number: 7 });
    expect(promptLinkRepositoryKey({ owner: "Saka-GG", name: "Ryco" })).toBe(
      "github.com/saka-gg/ryco",
    );
  });
});

describe("link round trips", () => {
  it("builds a link that parses back to the same prompt", () => {
    const link = buildNewThreadLink({
      prompt: "Swear count & rating?",
      repository: { owner: "saka-gg", name: "ryco" },
      provider: "claudeAgent",
      model: "claude-opus-4-6",
      origin: "https://hub.example.test",
    });
    const url = new URL(link);
    expect(url.origin + url.pathname).toBe("https://hub.example.test/new");
    expect(parseNewThreadLink(url.search)).toEqual({
      ok: true,
      value: {
        kind: "new",
        prompt: { text: "Swear count & rating?", hiddenCharacters: 0 },
        repository: { owner: "saka-gg", name: "ryco" },
        provider: "claudeAgent",
        model: "claude-opus-4-6",
      },
    });
  });

  it("leaves a model out of a link without a provider", () => {
    const link = new URL(buildNewThreadLink({ prompt: "hi", model: "gpt-5.5" }));
    expect(link.searchParams.has("model")).toBe(false);
  });

  it("rebuilds the query from native route params", () => {
    const search = promptLinkSearchFromParams({
      prompt: "Fix the bug & add tests = done?",
      repo: ["saka-gg/ryco", "ignored/second"],
      provider: "codex",
      screen: "NewTask",
    });
    expect(search === null ? null : parseNewThreadLink(search)).toEqual({
      ok: true,
      value: {
        kind: "new",
        prompt: { text: "Fix the bug & add tests = done?", hiddenCharacters: 0 },
        repository: { owner: "saka-gg", name: "ryco" },
        provider: "codex",
        model: null,
      },
    });
    expect(promptLinkSearchFromParams({ environmentId: "env-1" })).toBeNull();
    expect(promptLinkSearchFromParams(undefined)).toBeNull();
  });
});
