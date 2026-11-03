import { describe, expect, it } from "vite-plus/test";

import { nonInteractiveShellCommand, resolveShellCandidates } from "./terminalShell.ts";

function decodePowerShellScript(args: ReadonlyArray<string>): string {
  const encoded = args[args.indexOf("-EncodedCommand") + 1] ?? "";
  return Buffer.from(encoded, "base64").toString("utf16le");
}

describe("nonInteractiveShellCommand", () => {
  it("runs a POSIX shell as a login shell, csh without the login flag", () => {
    expect(
      nonInteractiveShellCommand({ shell: "/bin/zsh", args: ["-o", "nopromptsp"] }, "ls", "darwin"),
    ).toEqual({
      command: "/bin/zsh",
      args: ["-l", "-c", "ls"],
    });
    expect(nonInteractiveShellCommand({ shell: "/bin/tcsh" }, "ls", "darwin")).toEqual({
      command: "/bin/tcsh",
      args: ["-c", "ls"],
    });
  });

  it("encodes the command for PowerShell and keeps a native command's exit code", () => {
    const command = `npm install; echo "done 'quoted'"`;
    const invocation = nonInteractiveShellCommand(
      { shell: "pwsh.exe", args: ["-NoLogo"] },
      command,
      "win32",
    );
    expect(invocation.command).toBe("pwsh.exe");
    expect(invocation.args.slice(0, 4)).toEqual([
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
    ]);
    const script = decodePowerShellScript(invocation.args);
    expect(script.startsWith(`${command}\n`)).toBe(true);
    expect(script).toContain("exit $LASTEXITCODE");
    // PowerShell as a POSIX login shell gets the same treatment.
    expect(
      nonInteractiveShellCommand({ shell: "/usr/local/bin/pwsh" }, "ls", "darwin").args,
    ).toContain("-EncodedCommand");
  });

  it("hands cmd.exe the command line through the spawner's shell option", () => {
    const cmd = "C:\\Windows\\System32\\cmd.exe";
    expect(nonInteractiveShellCommand({ shell: cmd }, "npm install", "win32")).toEqual({
      command: "npm install",
      args: [],
      shell: cmd,
    });
  });

  it("covers every Windows fallback the terminal manager tries", () => {
    const env = { SystemRoot: "C:\\Windows", ComSpec: "C:\\Windows\\System32\\cmd.exe" };
    const kinds = resolveShellCandidates(() => "pwsh.exe", "win32", env).map((candidate) => {
      const invocation = nonInteractiveShellCommand(candidate, "echo hi", "win32");
      return invocation.shell !== undefined
        ? "cmd"
        : invocation.args.includes("-EncodedCommand")
          ? "powershell"
          : "other";
    });
    expect(kinds).not.toContain("other");
    expect(kinds).toContain("cmd");
  });
});
