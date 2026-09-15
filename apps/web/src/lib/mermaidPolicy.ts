/** Deliberately small, non-interactive Mermaid subset for untrusted messages. */
export const MERMAID_LIMITS = {
  sourceCharacters: 20_000,
  tokens: 400,
  statements: 200,
  lineCharacters: 1_000,
  edges: 100,
  cacheBytes: 5 * 1024 * 1024,
  cacheEntries: 50,
  pending: 32,
} as const;

export function isMermaidLanguage(language: string): boolean {
  return /^(mermaid|mmd)$/i.test(language);
}

export function isSupportedMermaidSource(source: string): boolean {
  if (source.length > MERMAID_LIMITS.sourceCharacters) return false;
  // Do not strip or reinterpret config: preserve the exact source as fallback.
  // Reject both legacy directives and their frontmatter replacement, including
  // malformed variants. Inline metadata enables images/icons and is excluded.
  if (
    /%%\s*\{|^\s*---|@|\\|\$\$|<[a-z!/]|&#?|\b(?:https?|data|javascript|file):|url\s*\(/im.test(
      source,
    )
  ) {
    return false;
  }
  if (/\b(?:click|classDef|class|style|linkStyle|links|link|callback|accDescr)\b/i.test(source)) {
    return false;
  }
  const lines = source.split(/[\n;]/);
  if (
    lines.length > MERMAID_LIMITS.statements ||
    lines.some((line) => line.length > MERMAID_LIMITS.lineCharacters)
  )
    return false;
  if ((source.match(/[\p{L}\p{N}_]+/gu)?.length ?? 0) > MERMAID_LIMITS.tokens) return false;
  const first = lines.find((line) => line.trim() && !line.trimStart().startsWith("%%"))?.trim();
  return (
    first !== undefined &&
    /^(?:(?:flowchart|graph)\s+(?:TB|TD|BT|RL|LR)\b|sequenceDiagram\b)/.test(first)
  );
}

/** Only explicit closed fences qualify; incomplete final messages stay readable code. */
export function isClosedMermaidFence(
  markdown: string,
  start: number | undefined,
  end: number | undefined,
): boolean {
  if (start === undefined || end === undefined) return false;
  const lines = markdown.slice(start, end).trimEnd().split("\n");
  if (lines.length < 2) return false;
  const opening = /^ {0,3}(`{3,}|~{3,})/.exec(lines[0]!);
  if (!opening) return false;
  const fence = opening[1]!;
  const closing = lines.at(-1)!.trim();
  return (
    closing.length >= fence.length && [...closing].every((character) => character === fence[0])
  );
}
