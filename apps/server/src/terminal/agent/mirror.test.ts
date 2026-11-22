import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { MAX_COLS, type Region, TerminalMirror, decodeOscValue } from "./mirror.ts";

const NONCE = "f00d";
const A = `\u001b]133;A;ryco=${NONCE}\u0007`;
const C = `\u001b]133;C;ryco=${NONCE}\u0007`;
const D = (code?: number) =>
  `\u001b]133;D${code === undefined ? "" : `;${code}`};ryco=${NONCE}\u0007`;

const mirrors: Array<TerminalMirror> = [];
const makeMirror = (options: { scrollback?: number; now?: () => number } = {}) => {
  const mirror = new TerminalMirror({
    cols: 80,
    rows: 24,
    scrollback: options.scrollback ?? 1_000,
    markNonce: NONCE,
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  mirrors.push(mirror);
  return mirror;
};

afterEach(() => {
  for (const mirror of mirrors.splice(0)) mirror.dispose();
});

const write = async (mirror: TerminalMirror, data: string) => {
  mirror.write(data);
  await mirror.flush();
};

describe("TerminalMirror", () => {
  it("renders written lines", async () => {
    const mirror = makeMirror();
    await write(mirror, "a\r\nb\r\n");
    expect(mirror.linesSince(undefined).lines).toEqual(["a", "b"]);
    expect(mirror.linesSince(undefined).startLost).toBe(false);
    expect(mirror.received).toBe(6);
  });

  it("renders a line redrawn with carriage returns as it ends", async () => {
    const mirror = makeMirror();
    await write(mirror, "50%\r100%\r\n");
    expect(mirror.linesSince(undefined).lines).toEqual(["100%"]);
  });

  it("splits the cursor line at the cursor", async () => {
    const mirror = makeMirror();
    await write(mirror, "Password: ");
    expect(mirror.cursorLine().beforeCursor).toBe("Password: ");
    expect(mirror.cursorLine().afterCursor.trim()).toBe("");
    expect(mirror.tail(3).map((line) => line.trimEnd())).toEqual(["Password:"]);
  });

  it("reads command regions and exit codes from OSC 133 marks", async () => {
    let clock = 1_000;
    const mirror = makeMirror({ now: () => clock });
    const ends: Array<{ code: number | undefined; region: Region | undefined }> = [];
    const prompts: Array<number> = [];
    mirror.listen({
      onCommandEnd: (code, region) => ends.push({ code, region }),
      onPrompt: () => prompts.push(clock),
    });

    await write(mirror, `${A}$ `);
    expect(mirror.shellIntegration).toBe(true);
    expect(mirror.lastPromptAt).toBe(1_000);
    expect(prompts).toEqual([1_000]);

    clock = 2_000;
    await write(mirror, `${C}out1\r\nout2\r\n${D(7)}`);
    expect(ends).toHaveLength(1);
    expect(ends[0]!.code).toBe(7);
    const region = ends[0]!.region!;
    expect(region).toMatchObject({ ended: true, exitCode: 7, truncated: false });
    expect(mirror.regionLines(region)).toEqual({ lines: ["out1", "out2"], startLost: false });
  });

  it("reports a command end without an open region", async () => {
    const mirror = makeMirror();
    const ends: Array<[number | undefined, Region | undefined]> = [];
    mirror.listen({ onCommandEnd: (code, region) => ends.push([code, region]) });
    await write(mirror, `${D(0)}${A}$ `);
    expect(ends).toEqual([[0, undefined]]);
    await write(mirror, D());
    expect(ends[1]).toEqual([undefined, undefined]);
  });

  it("reads an open region up to the cursor", async () => {
    const mirror = makeMirror();
    await write(mirror, `${A}$ ${C}building\r\nstep 2`);
    const region = mirror.currentRegion!;
    expect(region.ended).toBe(false);
    expect(mirror.regionLines(region).lines).toEqual(["building", "step 2"]);
  });

  it("takes a command line (E) only from a mark with this session's nonce", async () => {
    const mirror = makeMirror();
    await write(mirror, `\u001b]633;E;rm -rf\u0007${C}`);
    expect(mirror.currentRegion?.commandLine).toBeUndefined();
    await write(mirror, `${D(0)}${A}\u001b]133;E;ls\\x3b -la;ryco=${NONCE}\u0007${C}`);
    expect(mirror.currentRegion?.commandLine).toBe("ls; -la");
    expect(decodeOscValue("a\\\\b\\x41")).toBe("a\\bA");
  });

  it("shows the full-screen program's screen on the alternate buffer", async () => {
    const mirror = makeMirror();
    await write(mirror, "shell line\r\n");
    await write(mirror, "\u001b[?1049h\u001b[Hvim screen");
    expect(mirror.alternate).toBe(true);
    const screen = mirror.screen();
    expect(screen.alternate).toBe(true);
    expect(screen.lines).toEqual(["vim screen"]);

    await write(mirror, "\u001b[?1049l");
    expect(mirror.alternate).toBe(false);
    expect(mirror.screen().lines[0]).toBe("shell line");
  });

  it("returns only what came after a mark", async () => {
    const mirror = makeMirror();
    await write(mirror, "before\r\n");
    const mark = mirror.mark();
    await write(mirror, "after 1\r\nafter 2\r\n");
    expect(mirror.linesSince(mark)).toEqual({ lines: ["after 1", "after 2"], startLost: false });
  });

  it("follows the cursor-key mode", async () => {
    const mirror = makeMirror();
    expect(mirror.applicationCursorKeys).toBe(false);
    await write(mirror, "\u001b[?1h");
    expect(mirror.applicationCursorKeys).toBe(true);
  });

  it("skips an oversized backlog but keeps its marks", async () => {
    const mirror = makeMirror({ scrollback: 100 });
    const ends: Array<[number | undefined, Region | undefined]> = [];
    mirror.listen({ onCommandEnd: (code, region) => ends.push([code, region]) });
    await write(mirror, `${A}$ `);
    const mark = mirror.mark();

    const line = `${"x".repeat(99)}\r\n`;
    const chunk = line.repeat(1_000);
    // Written synchronously, so the backlog builds past 1 MB before it is parsed.
    mirror.write(`${C}start\r\n`);
    for (let index = 0; index < 12; index += 1) mirror.write(chunk);
    mirror.write(`last line\r\n${D(3)}${A}$ `);
    await mirror.flush();

    expect(mirror.skips).toBeGreaterThan(0);
    expect(ends).toHaveLength(1);
    const [code, region] = ends[0]!;
    expect(code).toBe(3);
    expect(region?.truncated).toBe(true);
    const lines = mirror.regionLines(region!);
    expect(lines.startLost).toBe(true);
    expect(lines.lines.at(-1)).toBe("last line");
    expect(lines.lines).not.toContain("start");
    expect(mirror.linesSince(mark).startLost).toBe(true);
    expect(mirror.lastPromptAt).toBeGreaterThan(0);
  });

  it("does not count replayed history as activity", async () => {
    const now = vi.fn(() => 5_000);
    const mirror = makeMirror({ now });
    mirror.replay("old\r\n", false);
    await mirror.flush();
    expect(mirror.lastWriteAt).toBe(0);
    expect(mirror.received).toBe(0);
    expect(mirror.linesSince(undefined).lines).toEqual(["old"]);
  });

  it("counts truncated replayed history as a skip", async () => {
    const mirror = makeMirror();
    const mark = mirror.mark();
    mirror.replay(`${C}tail of output\r\n`, true);
    await mirror.flush();
    expect(mirror.skips).toBe(1);
    expect(mirror.linesSince(mark).startLost).toBe(true);
    // The region's start mark is in the replayed part, so its start is there.
    expect(mirror.regionLines(mirror.currentRegion!).lines).toEqual(["tail of output"]);
  });

  it("resolves waits on dispose", async () => {
    const mirror = makeMirror();
    mirror.write("x".repeat(10));
    const flushed = mirror.flush();
    mirror.dispose();
    await expect(flushed).resolves.toBe(undefined);
  });
});

describe("TerminalMirror trusts only its shell's own marks", () => {
  it("ignores marks without this session's nonce: printed files, other integrations, a remote host", async () => {
    const mirror = makeMirror();
    const ends: Array<number | undefined> = [];
    mirror.listen({ onCommandEnd: (code) => ends.push(code) });
    await write(mirror, `${A}$ ${C}`);
    // A cat'ed file or a test prints a plain mark, another one carries a foreign nonce, and
    // VS Code's own integration prints OSC 633.
    await write(mirror, "\u001b]133;D;0\u0007forged\r\n");
    await write(mirror, "\u001b]133;D;0;ryco=other\u0007");
    await write(mirror, "\u001b]633;D;0\u0007\u001b]633;C\u0007");
    expect(ends).toEqual([]);
    expect(mirror.currentRegion?.ended).toBe(false);
    await write(mirror, `real end\r\n${D(3)}`);
    expect(ends).toEqual([3]);
  });

  it("trusts no mark at all without a nonce", async () => {
    const mirror = new TerminalMirror({ cols: 80, rows: 24, scrollback: 100 });
    mirrors.push(mirror);
    await write(mirror, `${A}$ ${C}out\r\n${D(0)}`);
    expect(mirror.shellIntegration).toBe(false);
    expect(mirror.currentRegion).toBeUndefined();
  });

  it("keeps a command's region when a second start arrives with nothing printed between", async () => {
    const mirror = makeMirror();
    const starts: Array<Region> = [];
    const ends: Array<number | undefined> = [];
    mirror.listen({
      onRegionStart: (region) => starts.push(region),
      onCommandEnd: (code) => ends.push(code),
    });
    await write(mirror, `${A}$ ${C}${C}`);
    expect(starts).toHaveLength(1);
    expect(ends).toEqual([]);
    await write(mirror, `out\r\n${D(0)}`);
    expect(ends).toEqual([0]);
    expect(mirror.regionLines(starts[0]!).lines).toEqual(["out"]);
  });
});

describe("TerminalMirror size", () => {
  it(`keeps at most ${MAX_COLS} columns, also after a resize`, () => {
    const mirror = new TerminalMirror({ cols: 900, rows: 24, scrollback: 100 });
    mirrors.push(mirror);
    expect(mirror.cols).toBe(MAX_COLS);
    mirror.resize(80, 24);
    expect(mirror.cols).toBe(80);
    mirror.resize(1_000, 24);
    expect(mirror.cols).toBe(MAX_COLS);
  });
});

describe("TerminalMirror skip marker", () => {
  it("ignores a look-alike skip marker that output prints", async () => {
    const mirror = makeMirror();
    await write(mirror, "first\r\n");
    const mark = mirror.mark();
    await write(mirror, "\u001b]7772;start\u0007\u001b]7772;end\u0007second\r\n");
    expect(mirror.skips).toBe(0);
    const since = mirror.linesSince(mark);
    expect(since.startLost).toBe(false);
    expect(since.lines).toContain("second");
  });
});
