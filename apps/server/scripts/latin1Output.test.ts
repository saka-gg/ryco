import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { beforeAll, describe, expect, it } from "vite-plus/test";

import { escapeNonLatin1 } from "./latin1Output.ts";

// The bundler's own parser (the plugin uses it through `this.parse`), reached
// through tsdown because rolldown is not a direct dependency.
let parse: (code: string) => unknown;
beforeAll(async () => {
  const requireFromServer = createRequire(new URL("../package.json", import.meta.url));
  const requireFromTsdown = createRequire(requireFromServer.resolve("tsdown/package.json"));
  const rolldownDir = path.dirname(requireFromTsdown.resolve("rolldown/package.json"));
  const module = (await import(
    pathToFileURL(path.join(rolldownDir, "dist/parse-ast-index.mjs")).href
  )) as { readonly parseAst: (code: string) => unknown };
  parse = (code) => module.parseAst(code);
});

const nonLatin1 = (code: string) => [...code].filter((char) => char.codePointAt(0)! > 0xff);

/** Evaluates a module-shaped snippet and returns its `result` binding. */
const evaluate = (code: string): unknown => new Function(`${code}\nreturn result;`)();

describe("Latin-1 bundle output", () => {
  it("leaves Latin-1 chunks untouched", () => {
    expect(escapeNonLatin1("const a = 'café';", parse)).toBeNull();
  });

  it("escapes strings, untagged templates, regexes and comments without changing meaning", () => {
    const source = [
      "// em — dash in a comment",
      "const dash = 'a — b → c';",
      'const emoji = "\u{1F600}";',
      "const template = `x … ${dash.length} \u{1F680}`;",
      "const plain = /[–—]/.test('—');",
      "const unicode = /^\u{1F600}$/u.test('\u{1F600}');",
      "const result = { dash, emoji, template, plain, unicode };",
    ].join("\n");
    const result = escapeNonLatin1(source, parse);
    expect(result).not.toBeNull();
    expect(nonLatin1(result!.code)).toEqual([]);
    expect(result!.preserved).toBe(0);
    expect(evaluate(result!.code)).toEqual(evaluate(source));
  });

  it("escapes identifiers, using code point escapes for astral characters", () => {
    const source = "const π = 3; const \u{1D453} = π + 1; const result = { π, \u{1D453} };";
    const result = escapeNonLatin1(source, parse)!;
    expect(nonLatin1(result.code)).toEqual([]);
    expect(result.code).toContain("\\u{1D453}");
    expect(evaluate(result.code)).toEqual(evaluate(source));
  });

  it("keeps characters that a backslash already escapes", () => {
    const source = [
      // Identity escapes: an inserted `\u` sequence would turn into literal text.
      "const identity = '\\—';",
      "const pattern = /[\\–]/.test('–');",
      // An escaped backslash before the character leaves it unescaped.
      "const pair = '\\\\—';",
      // A line continuation contributes nothing to the string.
      "const continued = 'a\\\u2028b';",
      // Comments carry no escapes, so they are always rewritten.
      "// Windows paths look like C:\\…",
      "const result = { identity, pattern, pair, continued };",
    ].join("\n");
    const result = escapeNonLatin1(source, parse)!;
    expect(result.preserved).toBe(3);
    expect(nonLatin1(result.code)).toEqual(["—", "–", "\u2028"]);
    expect(result.code).toContain("C:\\\\u2026");
    expect(evaluate(result.code)).toEqual(evaluate(source));
    expect(evaluate(source)).toEqual({
      identity: "—",
      pattern: true,
      pair: "\\—",
      continued: "ab",
    });
  });

  it("keeps tagged template text, which a tag can read raw", () => {
    const source = [
      "const raw = String.raw`a — b`;",
      "const tagged = ((strings) => strings.raw[0])`…`;",
      "const inner = String.raw`${'—'.length}`;",
      "const result = { raw, tagged, inner, after: '—' };",
    ].join("\n");
    const result = escapeNonLatin1(source, parse)!;
    expect(result.preserved).toBe(2);
    expect(nonLatin1(result.code)).toEqual(["—", "…"]);
    expect(evaluate(result.code)).toEqual(evaluate(source));
  });
});
