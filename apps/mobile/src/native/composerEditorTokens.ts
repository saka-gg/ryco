import type { ComposerInlineToken } from "@ryco/shared/composerInlineTokens";
import { threadIdFromMentionPath } from "@ryco/shared/threadMentions";

import type { ComposerEditorProps } from "./ComposerEditor.types";

export interface ComposerEditorTokenChip {
  readonly type: ComposerInlineToken["type"];
  readonly source: string;
  readonly start: number;
  readonly end: number;
  readonly label: string;
  /** A file mention's type icon; skills and thread mentions draw none. */
  readonly iconUri: string | null;
}

function basename(path: string): string {
  const separator = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return separator >= 0 ? path.slice(separator + 1) : path;
}

export function skillLabelsByName(
  skills: NonNullable<ComposerEditorProps["skills"]>,
): ReadonlyMap<string, string> {
  return new Map(skills.map((skill) => [skill.name, skill.displayName?.trim() || skill.name]));
}

/**
 * What the native editor draws for each inline token: a skill's display name,
 * a mentioned thread's title (`@thread:<id>`), or a file mention's base name
 * with its file-type icon.
 */
export function composerEditorTokenChips(input: {
  readonly tokens: ReadonlyArray<ComposerInlineToken>;
  readonly skillLabels: ReadonlyMap<string, string>;
  readonly threadTitles: ReadonlyMap<string, string> | undefined;
  readonly fileIconUri: (path: string) => string;
}): ComposerEditorTokenChip[] {
  return input.tokens.map((token) => {
    const base = { type: token.type, source: token.source, start: token.start, end: token.end };
    if (token.type === "skill") {
      return { ...base, label: input.skillLabels.get(token.value) ?? token.value, iconUri: null };
    }
    const threadId = threadIdFromMentionPath(token.value);
    if (threadId) {
      return { ...base, label: input.threadTitles?.get(threadId) ?? "Thread", iconUri: null };
    }
    return { ...base, label: basename(token.value), iconUri: input.fileIconUri(token.value) };
  });
}
