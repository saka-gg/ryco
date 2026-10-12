import { describe, expect, it } from "vite-plus/test";

import {
  isWindowsCommandNotFound,
  quoteWindowsShellArgument,
  runProcess,
} from "./processRunner.ts";

describe("runProcess", () => {
  it("fails when output exceeds max buffer in default mode", async () => {
    await expect(
      runProcess("node", ["-e", "process.stdout.write('x'.repeat(2048))"], { maxBufferBytes: 128 }),
    ).rejects.toThrow("exceeded stdout buffer limit");
  });

  it("truncates output when outputMode is truncate", async () => {
    const result = await runProcess("node", ["-e", "process.stdout.write('x'.repeat(2048))"], {
      maxBufferBytes: 128,
      outputMode: "truncate",
    });

    expect(result.code).toBe(0);
    expect(result.stdout.length).toBeLessThanOrEqual(128);
    expect(result.stdoutTruncated).toBe(true);
    expect(result.stderrTruncated).toBe(false);
  });
});

describe("isWindowsCommandNotFound", () => {
  it("matches the localized German cmd.exe error text", () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });

    try {
      expect(
        isWindowsCommandNotFound(
          1,
          "wird nicht als interner oder externer Befehl, betriebsfahiges Programm oder Batch-Datei erkannt",
        ),
      ).toBe(true);
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
    }
  });
});

describe("quoteWindowsShellArgument", () => {
  it("leaves simple arguments untouched", () => {
    expect(quoteWindowsShellArgument("rev-parse")).toBe("rev-parse");
    expect(quoteWindowsShellArgument("--show-toplevel")).toBe("--show-toplevel");
    expect(quoteWindowsShellArgument("C:\\repo\\src")).toBe("C:\\repo\\src");
  });

  it("quotes paths with spaces so cmd.exe passes them as one argument", () => {
    expect(quoteWindowsShellArgument("C:\\Users\\Jane Doe\\proj")).toBe(
      '"C:\\Users\\Jane Doe\\proj"',
    );
    // A trailing backslash must not escape the closing quote.
    expect(quoteWindowsShellArgument("C:\\Jane Doe\\")).toBe('"C:\\Jane Doe\\\\"');
  });

  it("leaves arguments with embedded quotes to their caller", () => {
    // cmd.exe has no `\"` escape: quoting these would hand `|` and `&` to cmd itself.
    const script = 'Write-Output "$($p.Id)|$($p.ParentId)"';
    expect(quoteWindowsShellArgument(script)).toBe(script);
    expect(quoteWindowsShellArgument("")).toBe('""');
  });
});
