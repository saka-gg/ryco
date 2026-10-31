import { DEFAULT_HOSTED_APP_ORIGIN } from "./hostedApp.ts";

/**
 * Prompt links open Ryco from outside it with a prompt ready to send. They never send it: a
 * link from a stranger fills a draft, and the user reads it and presses Send. A link also
 * cannot pick a runtime mode, a branch or a worktree; those stay the user's own defaults. Only
 * a pull request link names where the draft runs, and that checkout happens on Send.
 *
 *   https://<ryco>/new?prompt=…&repo=owner/name&provider=codex&model=gpt-5.5
 *   https://<ryco>/new?pr=owner/name/123&prompt=…
 *
 * Web reads the `/new` route's query with {@link parseNewThreadLink}; the native app reads the
 * same keys from its `tasks/new` route. Resolving a link against the user's projects, threads
 * and providers is `@ryco/client-runtime/promptLinks`.
 */

/** URLs stay well under the limits browsers and link shorteners apply. */
export const PROMPT_LINK_MAX_PROMPT_LENGTH = 8_000;

/** The query keys a prompt link uses. */
export const PROMPT_LINK_PARAM_KEYS = ["prompt", "repo", "pr", "provider", "model"] as const;
export type PromptLinkParamKey = (typeof PROMPT_LINK_PARAM_KEYS)[number];

export interface PromptLinkRepository {
  readonly owner: string;
  readonly name: string;
}

export interface PromptLinkPullRequest extends PromptLinkRepository {
  readonly number: number;
}

/** A prompt as it arrived, after hidden characters were removed. */
export interface LinkedPrompt {
  readonly text: string;
  /** How many invisible characters were removed. Any count above zero is a warning sign. */
  readonly hiddenCharacters: number;
}

export type NewThreadLink =
  | {
      readonly kind: "new";
      readonly prompt: LinkedPrompt;
      readonly repository: PromptLinkRepository | null;
      /** A provider driver kind such as `codex`, or one of the user's instance ids. */
      readonly provider: string | null;
      /** Only with a provider: a model of that provider, by its slug or its name. */
      readonly model: string | null;
    }
  | {
      readonly kind: "pull-request";
      readonly pullRequest: PromptLinkPullRequest;
      readonly prompt: LinkedPrompt | null;
    };

export type PromptLinkResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: string };

// Zero-width and bidi controls, tag and variation-selector blocks, and other characters that
// render as nothing. A model reads them; the person checking the draft cannot see them, which
// makes them the usual way to hide instructions in a prompt. Three of them do visible work in
// the right place, so `sanitizeLinkedPrompt` keeps them only there: U+FE0E/U+FE0F after an emoji,
// the zero-width joiner inside an emoji sequence, and the zero-width non-joiner between letters
// of the scripts that spell with it (Persian, Arabic, Indic). Tab and newline stay. Line and
// paragraph separators become plain newlines first, so the draft shows the break the model reads.
const HIDDEN_CHARACTERS =
  // oxlint-disable-next-line no-control-regex, no-misleading-character-class -- these are the characters it removes.
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180B-\u180F\u200B\u200E\u200F\u202A-\u202E\u2060-\u206F\u3164\uFE00-\uFE0D\uFEFF\uFFA0\uFFF0-\uFFFB\u{1BCA0}-\u{1BCA3}\u{1D173}-\u{1D17A}\u{E0000}-\u{E0FFF}]/gu;

const ZERO_WIDTH_JOINER = "\u200D";
const ZERO_WIDTH_NON_JOINER = "\u200C";
const TEXT_PRESENTATION = "\uFE0E";
const EMOJI_PRESENTATION = "\uFE0F";
const KEYCAP = 0x20e3;

// Numeric ranges throughout, because Hermes lacks Unicode property escapes.

/** Pictographs, symbols and skin tones: what an emoji sequence is built from. */
const isEmojiBase = (codePoint: number | undefined) =>
  codePoint !== undefined &&
  ((codePoint >= 0x1f000 && codePoint <= 0x1faff) ||
    (codePoint >= 0x2190 && codePoint <= 0x2bff) ||
    // ©, ®, ‼, ⁉, ™, ℹ, 〰, 〽, ㊗, ㊙: symbols with an emoji form outside those blocks.
    [0xa9, 0xae, 0x203c, 0x2049, 0x2122, 0x2139, 0x3030, 0x303d, 0x3297, 0x3299].includes(
      codePoint,
    ));

/** `#`, `*` and digits: the bases of keycap emoji (`1`, U+FE0F, U+20E3). */
const isKeycapBase = (codePoint: number | undefined) =>
  codePoint !== undefined &&
  (codePoint === 0x23 || codePoint === 0x2a || (codePoint >= 0x30 && codePoint <= 0x39));

/** Letters and marks of the scripts that use the zero-width non-joiner in their spelling. */
const isNonJoinerScript = (codePoint: number | undefined) =>
  codePoint !== undefined &&
  ((codePoint >= 0x0600 && codePoint <= 0x08ff) || // Arabic, Syriac, Thaana and their extensions
    (codePoint >= 0x0900 && codePoint <= 0x0dff) || // Devanagari through Sinhala
    (codePoint >= 0xfb50 && codePoint <= 0xfdff) || // Arabic presentation forms A
    (codePoint >= 0xfe70 && codePoint <= 0xfefc)); // Arabic presentation forms B

/** Whether a character that is invisible on its own does visible work where it stands. */
function keepsInvisibleCharacter(characters: ReadonlyArray<string>, index: number): boolean {
  const character = characters[index];
  const previous = characters[index - 1]?.codePointAt(0);
  const next = characters[index + 1]?.codePointAt(0);
  switch (character) {
    case ZERO_WIDTH_JOINER:
      // Inside an emoji sequence, such as a family; a presentation selector may precede it.
      return (
        (isEmojiBase(previous) ||
          (characters[index - 1] === EMOJI_PRESENTATION &&
            isEmojiBase(characters[index - 2]?.codePointAt(0)))) &&
        isEmojiBase(next)
      );
    case ZERO_WIDTH_NON_JOINER:
      return isNonJoinerScript(previous) && isNonJoinerScript(next);
    case TEXT_PRESENTATION:
    case EMOJI_PRESENTATION:
      // Right after the emoji it styles (never after another selector), or inside a keycap.
      return isEmojiBase(previous) || (isKeycapBase(previous) && next === KEYCAP);
    default:
      return true;
  }
}

/** Removes characters a reader cannot see, and counts them. */
export function sanitizeLinkedPrompt(raw: string): LinkedPrompt {
  let hiddenCharacters = 0;
  const visible = Array.from(
    raw.replace(/\r\n?|[\u2028\u2029]/g, "\n").replace(HIDDEN_CHARACTERS, () => {
      hiddenCharacters++;
      return "";
    }),
  );
  const text = visible
    .filter((_, index) => {
      const kept = keepsInvisibleCharacter(visible, index);
      if (!kept) hiddenCharacters++;
      return kept;
    })
    .join("");
  return { text: text.trim(), hiddenCharacters };
}

// GitHub's own rules for owners and repository names.
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const NAME = /^[A-Za-z0-9._-]{1,100}$/;
// Driver kinds and instance ids share this slug rule (`ProviderDriverKind`, `ProviderInstanceId`).
const PROVIDER = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;
// A model slug (`gpt-5.5`, `claude-opus-4-6[1m]`, `anthropic/claude`) or its display name.
const MODEL = /^[A-Za-z0-9][A-Za-z0-9 ._:/@+()[\]-]{0,127}$/;

function repositoryOf(owner: string, name: string): PromptLinkRepository | null {
  const trimmedName = name.replace(/\.git$/i, "");
  if (!OWNER.test(owner) || !NAME.test(trimmedName) || /^\.+$/.test(trimmedName)) return null;
  return { owner, name: trimmedName };
}

/** `owner/name`, or a GitHub repository URL. */
export function parsePromptLinkRepository(value: string): PromptLinkRepository | null {
  const trimmed = value.trim();
  const match =
    /^https?:\/\/(?:www\.)?github\.com\/([^/?#]+)\/([^/?#]+)\/?$/i.exec(trimmed) ??
    /^([^/\s]+)\/([^/\s]+)$/.exec(trimmed);
  return match?.[1] && match[2] ? repositoryOf(match[1], match[2]) : null;
}

/** `owner/name/123`, `owner/name#123`, or a GitHub pull request URL. */
export function parsePromptLinkPullRequest(value: string): PromptLinkPullRequest | null {
  const trimmed = value.trim();
  const match =
    /^https?:\/\/(?:www\.)?github\.com\/([^/?#]+)\/([^/?#]+)\/pull\/(\d+)(?:[/?#].*)?$/i.exec(
      trimmed,
    ) ?? /^([^/\s#]+)\/([^/\s#]+)(?:\/|#)(\d+)$/.exec(trimmed);
  if (!match?.[1] || !match[2] || !match[3]) return null;
  const repository = repositoryOf(match[1], match[2]);
  const number = Number(match[3]);
  return repository && Number.isSafeInteger(number) && number > 0
    ? { ...repository, number }
    : null;
}

/**
 * The repository as Ryco keys it: `normalizeGitRemoteUrl`'s form of its GitHub remote
 * (`github.com/owner/name`, lower case), which is what a project's repository identity holds.
 */
export function promptLinkRepositoryKey(repository: PromptLinkRepository): string {
  return `github.com/${repository.owner}/${repository.name}`.toLowerCase();
}

/** `owner/name`, as the user knows the repository. */
export function promptLinkRepositoryName(repository: PromptLinkRepository): string {
  return `${repository.owner}/${repository.name}`;
}

/** The pull request's page on GitHub. */
export function promptLinkPullRequestUrl(pullRequest: PromptLinkPullRequest): string {
  return `https://github.com/${pullRequest.owner}/${pullRequest.name}/pull/${pullRequest.number}`;
}

function readPrompt(params: URLSearchParams): PromptLinkResult<LinkedPrompt | null> {
  const raw = params.get("prompt");
  if (raw === null) return { ok: true, value: null };
  if (raw.length > PROMPT_LINK_MAX_PROMPT_LENGTH) {
    return {
      ok: false,
      error: `This prompt is longer than ${PROMPT_LINK_MAX_PROMPT_LENGTH.toLocaleString("en-US")} characters, so Ryco did not open it.`,
    };
  }
  const prompt = sanitizeLinkedPrompt(raw);
  if (prompt.text.length === 0 && prompt.hiddenCharacters > 0) {
    return {
      ok: false,
      error:
        "This prompt had only hidden characters, so it may be malicious. Ryco did not open it.",
    };
  }
  return { ok: true, value: prompt.text.length > 0 ? prompt : null };
}

const optionalParam = (params: URLSearchParams, key: PromptLinkParamKey) =>
  params.get(key)?.trim() || null;

/** Reads the query of a `/new` link, as a `?…` string or as its params. */
export function parseNewThreadLink(
  search: string | URLSearchParams,
): PromptLinkResult<NewThreadLink> {
  const params = typeof search === "string" ? new URLSearchParams(search) : search;
  const prompt = readPrompt(params);
  if (!prompt.ok) return prompt;
  const pr = params.get("pr");
  if (pr !== null) {
    const pullRequest = parsePromptLinkPullRequest(pr);
    if (pullRequest === null) {
      return { ok: false, error: "This link names a pull request Ryco cannot read." };
    }
    return { ok: true, value: { kind: "pull-request", pullRequest, prompt: prompt.value } };
  }
  if (prompt.value === null) return { ok: false, error: "This link has no prompt." };
  const repo = params.get("repo");
  const repository = repo === null ? null : parsePromptLinkRepository(repo);
  if (repo !== null && repository === null) {
    return { ok: false, error: "This link names a repository Ryco cannot read." };
  }
  const provider = optionalParam(params, "provider");
  if (provider !== null && !PROVIDER.test(provider)) {
    return { ok: false, error: "This link names a provider Ryco cannot read." };
  }
  const model = provider === null ? null : optionalParam(params, "model");
  if (model !== null && !MODEL.test(model)) {
    return { ok: false, error: "This link names a model Ryco cannot read." };
  }
  return {
    ok: true,
    value: { kind: "new", prompt: prompt.value, repository, provider, model },
  };
}

/**
 * Rebuilds a link's query from decoded route params (the native app's navigation params), so
 * the parser reads the same input on every surface. Null when the params carry no prompt link.
 */
export function promptLinkSearchFromParams(
  params: Readonly<Record<string, unknown>> | undefined,
): URLSearchParams | null {
  const search = new URLSearchParams();
  let found = false;
  for (const key of PROMPT_LINK_PARAM_KEYS) {
    const raw = params?.[key];
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (typeof value !== "string") continue;
    search.set(key, value);
    found = true;
  }
  return found ? search : null;
}

/** A shareable `/new` link. The prompt is not cut: callers check its length first. */
export function buildNewThreadLink(input: {
  readonly prompt: string;
  readonly repository?: PromptLinkRepository | null;
  readonly provider?: string | null;
  readonly model?: string | null;
  /** The Ryco site the link opens; the hosted app when absent. */
  readonly origin?: string;
}): string {
  const url = new URL("/new", input.origin ?? DEFAULT_HOSTED_APP_ORIGIN);
  url.searchParams.set("prompt", input.prompt);
  if (input.repository) url.searchParams.set("repo", promptLinkRepositoryName(input.repository));
  if (input.provider) {
    url.searchParams.set("provider", input.provider);
    if (input.model) url.searchParams.set("model", input.model);
  }
  return url.toString();
}
