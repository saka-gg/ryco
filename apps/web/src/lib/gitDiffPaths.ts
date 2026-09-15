/** Decode exactly one Git C-quoted header path. Unquoted backslashes are literal. */
function decodeHeaderPath(raw: string): string | null {
  if (!raw.startsWith('"')) return raw;
  if (!raw.endsWith('"')) return null;
  const bytes: number[] = [];
  const escapes: Record<string, string> = {
    a: "\x07",
    b: "\b",
    f: "\f",
    n: "\n",
    r: "\r",
    t: "\t",
    v: "\v",
    '"': '"',
    "\\": "\\",
  };
  for (let i = 1; i < raw.length - 1; i++) {
    const char = raw[i]!;
    if (char === '"') return null;
    if (char !== "\\") {
      const code = raw.codePointAt(i)!;
      bytes.push(...new TextEncoder().encode(String.fromCodePoint(code)));
      if (code > 0xffff) i++;
      continue;
    }
    const next = raw[++i];
    if (next === undefined) return null;
    if (/[0-7]/.test(next)) {
      const octal = raw.slice(i, i + 3);
      if (!/^[0-7]{3}$/.test(octal) || parseInt(octal, 8) > 255) return null;
      bytes.push(parseInt(octal, 8));
      i += 2;
    } else {
      const decoded = escapes[next];
      if (decoded === undefined) return null;
      bytes.push(...new TextEncoder().encode(decoded));
    }
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(bytes));
  } catch {
    return null;
  }
}
function repositoryPath(raw: string, prefix: "a/" | "b/"): string | null {
  const decoded = decodeHeaderPath(raw);
  return decoded?.startsWith(prefix) ? decoded.slice(2) : null;
}
/** Null means ambiguous/unsupported: retain a raw patch, never guess a filesystem target. */
export function gitDiffPaths(segment: string): { name: string; prevName?: string } | null {
  const header = segment.split(/^@@ /m, 1)[0] ?? "";
  const oldHeader = /^--- (.*)$/m.exec(header)?.[1];
  const newHeader = /^\+\+\+ (.*)$/m.exec(header)?.[1];
  let oldPath: string | null;
  let newPath: string | null;
  if (oldHeader !== undefined && newHeader !== undefined) {
    // Git terminates unquoted space-containing paths with a tab. Control characters
    // inside actual filenames are C-quoted; timestamps are outside this Git format.
    const oldRaw = oldHeader.endsWith("\t") ? oldHeader.slice(0, -1) : oldHeader;
    const newRaw = newHeader.endsWith("\t") ? newHeader.slice(0, -1) : newHeader;
    oldPath = oldRaw === "/dev/null" ? null : repositoryPath(oldRaw, "a/");
    newPath = newRaw === "/dev/null" ? null : repositoryPath(newRaw, "b/");
    if (
      (oldRaw !== "/dev/null" && oldPath === null) ||
      (newRaw !== "/dev/null" && newPath === null)
    )
      return null;
  } else {
    const raw = /^diff --git (.*)$/m.exec(header)?.[1];
    if (!raw) return null;
    // Consider only separators outside quotes; reject multiple valid interpretations.
    const candidates: { oldPath: string; newPath: string }[] = [];
    let quoted = false;
    for (let i = 0; i < raw.length; i++) {
      if (quoted && raw[i] === "\\") {
        i++;
        continue;
      }
      if (raw[i] === '"') quoted = !quoted;
      if (quoted || raw[i] !== " ") continue;
      const left = repositoryPath(raw.slice(0, i), "a/");
      const right = repositoryPath(raw.slice(i + 1), "b/");
      if (left !== null && right !== null) candidates.push({ oldPath: left, newPath: right });
    }
    if (candidates.length !== 1) return null;
    ({ oldPath, newPath } = candidates[0]!);
  }
  const name = newPath ?? oldPath;
  if (!name) return null;
  return oldPath !== null && oldPath !== name ? { name, prevName: oldPath } : { name };
}
