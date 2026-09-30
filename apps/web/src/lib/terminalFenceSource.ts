/** Use the renderer's AST span, never a second markdown parser. The parser owns
 * indentation/nesting; retain original CRLF bytes when the logical content agrees. */
export function terminalFenceSource(
  markdown: string,
  start: number | undefined,
  end: number | undefined,
  renderedCode: string,
): string | undefined {
  if (start === undefined || end === undefined) return undefined;
  const fence = markdown.slice(start, end);
  const lines = fence.split(/\r?\n/);
  const opening = /^ {0,3}(`{3,}|~{3,})/.exec(lines[0] ?? "")?.[1];
  // AST positions identify the code node; enclosing quote/list prefixes on the
  // final source line are presentation syntax, not snippet bytes.
  const closing = (lines.at(-1) ?? "").replace(/^[\t ]*(?:>[\t ]*)*/, "").trim();
  if (
    !opening ||
    lines.length < 2 ||
    closing.length < opening.length ||
    [...closing].some((character) => character !== opening[0])
  )
    return undefined;
  const parsed = renderedCode.endsWith("\n") ? renderedCode.slice(0, -1) : renderedCode;
  const body = fence.slice(fence.indexOf("\n") + 1, fence.lastIndexOf("\n")).replace(/\r$/, "");
  return body.replace(/\r\n/g, "\n") === parsed ? body : parsed;
}
