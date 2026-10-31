import { defaultParseSearch, defaultStringifySearch } from "@tanstack/react-router";

/**
 * The router's search serialization, with one exception for prompt links.
 *
 * The router's default reads every query value as JSON and writes it back the same way, and on
 * the first load it rewrites the address to that form before any view reads it: a link's
 * `prompt=123` became the number 123 and then `"123"` with quotes, and `prompt=true`, `null` or
 * a JSON object were dropped. A prompt link's keys are text a person wrote, so they are read and
 * written exactly as they are in the address. The parser and the rest of the link code stay out
 * of this module, which the boot bundle carries.
 */

/** The keys a prompt link carries (`PROMPT_LINK_PARAM_KEYS` in `@ryco/shared/promptLinks`). */
export const PROMPT_LINK_SEARCH_KEYS = ["prompt", "repo", "pr", "provider", "model"] as const;

export type PromptLinkRouteSearch = Partial<
  Record<(typeof PROMPT_LINK_SEARCH_KEYS)[number], string | undefined>
>;

const isPromptLinkKey = (key: string) =>
  (PROMPT_LINK_SEARCH_KEYS as ReadonlyArray<string>).includes(key);

/** `defaultParseSearch`, except that a prompt link's keys keep their text. */
export function parseRouterSearch(searchStr: string): Record<string, unknown> {
  const search: Record<string, unknown> = defaultParseSearch(searchStr);
  const raw = new URLSearchParams(searchStr.startsWith("?") ? searchStr.slice(1) : searchStr);
  for (const key of PROMPT_LINK_SEARCH_KEYS) {
    const value = raw.get(key);
    if (value !== null) search[key] = value;
  }
  return search;
}

/** `defaultStringifySearch`, except that a prompt link's keys are written as their text. */
export function stringifyRouterSearch(search: Record<string, unknown>): string {
  const rest: Record<string, unknown> = {};
  const raw = new URLSearchParams();
  for (const [key, value] of Object.entries(search)) {
    if (isPromptLinkKey(key) && typeof value === "string") raw.set(key, value);
    else rest[key] = value;
  }
  const query = [defaultStringifySearch(rest).replace(/^\?/, ""), raw.toString()]
    .filter((part) => part.length > 0)
    .join("&");
  return query.length > 0 ? `?${query}` : "";
}

/**
 * The `/new` route's search: only the link's own keys, as the text they arrived as. The view
 * parses them (`parseNewThreadLink`), so nothing here judges their content.
 */
export function validatePromptLinkSearch(search: Record<string, unknown>): PromptLinkRouteSearch {
  const result: PromptLinkRouteSearch = {};
  for (const key of PROMPT_LINK_SEARCH_KEYS) {
    const value = search[key];
    if (typeof value === "string") result[key] = value;
  }
  return result;
}
