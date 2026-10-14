import { describe, expect, it } from "vite-plus/test";

import { TerminalOutputTail } from "./worktreeSetupOutputTail.ts";

describe("TerminalOutputTail", () => {
  it("strips colour, cursor and title escapes, also when a chunk splits one", () => {
    const tail = new TerminalOutputTail();
    tail.push("\u001b]0;zsh\u0007\u001b[1m$\u001b[0m bun ins");
    tail.push("tall\u001b[");
    tail.push("2Kdone\n");
    expect(tail.snapshot()).toEqual(["$ bun installdone"]);
  });

  it("lets a carriage return overwrite its line like a progress meter", () => {
    const tail = new TerminalOutputTail();
    expect(tail.push("Downloading 10%\rDownloading 55%")).toBe(true);
    expect(tail.snapshot()).toEqual(["Downloading 55%"]);
    tail.push("\rDownloading 100%\r\nDone\n");
    expect(tail.snapshot()).toEqual(["Downloading 100%", "Done"]);
  });

  it("keeps only the last lines and drops blank ones", () => {
    const tail = new TerminalOutputTail(2);
    tail.push("one\n\n   \ntwo\nthree\n");
    expect(tail.snapshot()).toEqual(["two", "three"]);
    expect(tail.push("\n")).toBe(false);
  });

  it("truncates a runaway line", () => {
    const tail = new TerminalOutputTail();
    tail.push(`${"x".repeat(500)}\n`);
    const [line] = tail.snapshot();
    expect(line?.length).toBe(240);
    expect(line?.endsWith("…")).toBe(true);
  });
});
