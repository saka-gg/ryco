import { describe, expect, it } from "vite-plus/test";

import { makeGitGrepOutputParser, type GitGrepOutputOptions } from "./gitGrepOutput.ts";

const record = (path: string | Uint8Array, lineNumber: number, column: number, text: string) =>
  Buffer.concat([
    typeof path === "string" ? Buffer.from(path) : path,
    Buffer.from(`\0${lineNumber}\0${column}\0`),
    Buffer.from(text),
    Buffer.from("\n"),
  ]);

const parse = (chunks: ReadonlyArray<Uint8Array>, options: Partial<GitGrepOutputOptions> = {}) => {
  const parser = makeGitGrepOutputParser({ afterPath: "", maxLinesPerFile: 100, ...options });
  return [...chunks.flatMap((chunk) => parser.push(chunk)), ...parser.end()];
};

const line = (lineNumber: number, text: string, matchStart: number) => ({
  lineNumber,
  text,
  matchStart,
  cutStart: false,
  cutEnd: false,
});

describe("makeGitGrepOutputParser", () => {
  const output = Buffer.concat([
    record("a.ts", 1, 1, "needle"),
    record("a.ts", 12, 8, "héllo needle"),
    record("dir/b c.ts", 3, 5, "tab\tneedle\0after"),
    record("é.ts", 2, 1, "needle\r"),
  ]);
  const expected = [
    { path: "a.ts", lines: [line(1, "needle", 0), line(12, "héllo needle", 6)] },
    { path: "dir/b c.ts", lines: [line(3, "tab\tneedle\0after", 4)] },
    { path: "é.ts", lines: [line(2, "needle", 0)] },
  ];

  it("groups matching lines by file, with each line's first match in UTF-16 units", () => {
    // A NUL inside the text is text; a CRLF line's \r is not.
    expect(parse([output])).toEqual(expected);
  });

  it("parses the same files whatever the chunk boundaries", () => {
    for (let split = 1; split < output.length; split += 1) {
      expect(parse([output.subarray(0, split), output.subarray(split)])).toEqual(expected);
    }
    expect(parse([...output].map((byte) => Uint8Array.of(byte)))).toEqual(expected);
  });

  it("emits a file once the next file starts", () => {
    const parser = makeGitGrepOutputParser({ afterPath: "", maxLinesPerFile: 100 });
    expect(parser.push(record("a.ts", 1, 1, "needle"))).toEqual([]);
    expect(parser.push(record("b.ts", 1, 1, "needle"))).toEqual([
      { path: "a.ts", lines: [line(1, "needle", 0)] },
    ]);
    expect(parser.end()).toEqual([{ path: "b.ts", lines: [line(1, "needle", 0)] }]);
  });

  it("skips files at or before the cursor path in byte order", () => {
    const files = parse(
      [
        Buffer.concat([
          record("a.ts", 1, 1, "needle"),
          record("b.ts", 1, 1, "needle"),
          record("b/a.ts", 1, 1, "needle"),
          record("c.ts", 1, 1, "needle"),
        ]),
      ],
      { afterPath: "b.ts" },
    );
    expect(files.map((file) => file.path)).toEqual(["b/a.ts", "c.ts"]);
  });

  it("keeps the first lines of a file up to the cap", () => {
    const files = parse(
      [
        Buffer.concat([
          record("a.ts", 1, 1, "needle"),
          record("a.ts", 2, 1, "needle"),
          record("a.ts", 3, 1, "needle"),
          record("b.ts", 9, 1, "needle"),
        ]),
      ],
      { maxLinesPerFile: 2 },
    );
    expect(files.map((file) => [file.path, file.lines.map((kept) => kept.lineNumber)])).toEqual([
      ["a.ts", [1, 2]],
      ["b.ts", [9]],
    ]);
  });

  it("keeps a window around the first match of a huge line", () => {
    const huge = `${"a".repeat(5_000_000)}needle${"b".repeat(5_000_000)}`;
    const bytes = record("bundle.js", 1, 5_000_001, huge);
    const chunks: Uint8Array[] = [];
    for (let start = 0; start < bytes.length; start += 65_536) {
      chunks.push(bytes.subarray(start, start + 65_536));
    }

    const [file] = parse(chunks);
    const [kept] = file?.lines ?? [];
    expect(kept?.text.length).toBe(4_096);
    expect(kept?.matchStart).toBe(512);
    expect(kept?.text.slice(512, 518)).toBe("needle");
    expect(kept?.cutStart).toBe(true);
    expect(kept?.cutEnd).toBe(true);
  });

  it("never cuts a character in half at the window's edges", () => {
    // `€` is three bytes: both window edges fall inside one.
    const text = `${"€".repeat(1_000)}needle${"€".repeat(3_000)}`;
    const [file] = parse([record("a.ts", 1, 3_001, text)]);
    const [kept] = file?.lines ?? [];
    expect(kept?.text).toBe(`${"€".repeat(170)}needle${"€".repeat(1_192)}`);
    expect(kept?.matchStart).toBe(170);
  });

  it("drops a record the output ended in, a path that is not UTF-8 and an overlong path", () => {
    const files = parse([
      Buffer.concat([
        record(Uint8Array.of(0x61, 0xff, 0x2e, 0x74), 1, 1, "needle"),
        record("a".repeat(5_000), 1, 1, "needle"),
        record("b.ts", 1, 1, "needle"),
        Buffer.from("c.ts\u00001\u00001\u0000need"),
      ]),
    ]);
    expect(files).toEqual([{ path: "b.ts", lines: [line(1, "needle", 0)] }]);
  });
});
