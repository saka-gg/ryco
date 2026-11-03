import { describe, expect, it } from "vitest";

import { quoteShellWord } from "./shellQuote.ts";

describe("quoteShellWord", () => {
  // A Windows node's terminal is PowerShell: a quote inside single quotes is doubled there.
  it("quotes only words a shell would split or expand", () => {
    expect(quoteShellWord("/home/ada/.ryco-2", "linux")).toBe("/home/ada/.ryco-2");
    expect(quoteShellWord("/home/ada/it's here", "linux")).toBe(`'/home/ada/it'\\''s here'`);
    expect(quoteShellWord("/tmp/$HOME", "darwin")).toBe("'/tmp/$HOME'");
    expect(quoteShellWord("C:\\Users\\ada\\.ryco", "win32")).toBe("C:\\Users\\ada\\.ryco");
    expect(quoteShellWord("C:\\Users\\o'brien", "win32")).toBe("'C:\\Users\\o''brien'");
  });
});
