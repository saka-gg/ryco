function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/** Read displayable text from MCP, Claude and ACP content blocks without dumping media bytes. */
export function extractToolContentText(value: unknown): string | undefined {
  if (!Array.isArray(value)) return text(value);
  const chunks: string[] = [];
  for (const entry of value) {
    const block = record(entry);
    if (!block) continue;
    const content = block.type === "content" ? record(block.content) : block;
    if (!content) continue;
    const resource = content.type === "resource" ? record(content.resource) : undefined;
    const chunk =
      content.type === "text" || content.type === "inputText" || content.type === undefined
        ? text(content.text)
        : text(resource?.text);
    if (chunk) chunks.push(chunk);
  }
  return chunks.length > 0 ? chunks.join("\n") : undefined;
}

/** Provider result envelopes only; arbitrary tool arguments are never treated as output. */
export function extractToolResultText(value: unknown): string | undefined {
  const direct = extractToolContentText(value);
  if (direct) return direct;
  const result = record(value);
  if (!result) return undefined;
  const streams = [text(result.stdout), text(result.stderr)].filter(
    (part): part is string => part !== undefined,
  );
  if (streams.length > 0) return streams.join("\n");
  for (const key of ["detailedContent", "content", "text", "markdown", "message", "summary"]) {
    const output = extractToolContentText(result[key]);
    if (output) return output;
  }
  // Structured MCP results are explicitly marked; never stringify the whole
  // envelope (which can also contain images, opaque data or transport metadata).
  if (result.structuredContent !== undefined && result.structuredContent !== null) {
    try {
      return JSON.stringify(result.structuredContent, null, 2);
    } catch {
      return undefined;
    }
  }
  return undefined;
}
