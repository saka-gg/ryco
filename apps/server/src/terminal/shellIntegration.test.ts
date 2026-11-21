import path from "node:path";

import { describe, expect, it } from "vite-plus/test";

import {
  SHELL_INTEGRATION_VERSION,
  shellIntegrationDisabled,
  shellIntegrationFiles,
  withShellIntegration,
} from "./shellIntegration.ts";

const DIR = "/state/shell-integration";
const ZDOTDIR = path.join(DIR, SHELL_INTEGRATION_VERSION, "zsh");
const BASH_RC = path.join(DIR, SHELL_INTEGRATION_VERSION, "bash", "ryco.bash");

describe("withShellIntegration", () => {
  it("points zsh at Ryco's startup files", () => {
    const spawn = withShellIntegration(
      { shell: "/bin/zsh", args: ["-o", "nopromptsp"] },
      { HOME: "/home/ann", PATH: "/bin" },
      DIR,
      "darwin",
    );
    expect(spawn).toEqual({
      shell: "/bin/zsh",
      args: ["-o", "nopromptsp"],
      env: { HOME: "/home/ann", PATH: "/bin", ZDOTDIR },
    });
  });

  it("carries the user's own ZDOTDIR", () => {
    const spawn = withShellIntegration(
      { shell: "/usr/local/bin/zsh" },
      { ZDOTDIR: "/home/ann/.config/zsh" },
      DIR,
      "linux",
    );
    expect(spawn?.env).toEqual({ ZDOTDIR, RYCO_USER_ZDOTDIR: "/home/ann/.config/zsh" });
    expect(spawn?.args).toEqual([]);
  });

  it("ignores a ZDOTDIR inherited from a Ryco terminal", () => {
    for (const inherited of [
      "/other/state/shell-integration/v1/zsh",
      "/other/state/shell-integration/v2/zsh/",
      "",
    ]) {
      const spawn = withShellIntegration({ shell: "zsh" }, { ZDOTDIR: inherited }, DIR, "darwin");
      expect(spawn?.env).toEqual({ ZDOTDIR });
    }
  });

  it("starts bash with Ryco's init file", () => {
    const env = { HOME: "/home/ann" };
    expect(withShellIntegration({ shell: "/bin/bash", args: ["-l"] }, env, DIR, "linux")).toEqual({
      shell: "/bin/bash",
      args: ["-l", "--init-file", BASH_RC],
      env,
    });
  });

  it("leaves bash alone when its arguments choose startup files", () => {
    for (const flag of ["--rcfile", "--init-file", "--norc"]) {
      expect(
        withShellIntegration({ shell: "/bin/bash", args: [flag, "x"] }, {}, DIR, "linux"),
      ).toBe(null);
    }
  });

  it("leaves other shells and Windows alone", () => {
    expect(withShellIntegration({ shell: "/usr/bin/fish" }, {}, DIR, "linux")).toBe(null);
    expect(withShellIntegration({ shell: "/bin/sh" }, {}, DIR, "darwin")).toBe(null);
    expect(withShellIntegration({ shell: "C:\\msys\\bin\\bash.exe" }, {}, DIR, "win32")).toBe(null);
    expect(withShellIntegration({ shell: "/bin/zsh" }, {}, DIR, "win32")).toBe(null);
  });
});

describe("shellIntegrationDisabled", () => {
  it.each(["0", "false", "off", " OFF ", "False"])("%j turns it off", (value) => {
    expect(shellIntegrationDisabled({ RYCO_TERMINAL_SHELL_INTEGRATION: value })).toBe(true);
  });

  it.each([undefined, "", "1", "on", "true"])("%j keeps it on", (value) => {
    expect(shellIntegrationDisabled({ RYCO_TERMINAL_SHELL_INTEGRATION: value })).toBe(false);
  });
});

describe("shellIntegrationFiles", () => {
  it("writes the zsh startup files and the bash init file under the version", () => {
    const files = shellIntegrationFiles();
    expect(files.map((file) => file.path)).toEqual([
      path.join("v1", "zsh", ".zshenv"),
      path.join("v1", "zsh", ".zprofile"),
      path.join("v1", "zsh", ".zshrc"),
      path.join("v1", "bash", "ryco.bash"),
    ]);
    const byName = new Map(files.map((file) => [path.basename(file.path), file.content]));
    expect(byName.get(".zshenv")).toContain('builtin source "$ZDOTDIR/.zshenv"');
    expect(byName.get(".zshrc")).toContain("\\e]133;D;%s\\a");
    expect(byName.get(".zshrc")).toContain("\\e]133;C\\a");
    expect(byName.get("ryco.bash")).toContain('. "$HOME/.bashrc"');
    expect(byName.get("ryco.bash")).toContain("\\033]133;A\\007");
  });

  it("matches what withShellIntegration points at", () => {
    const paths = shellIntegrationFiles().map((file) => path.join(DIR, file.path));
    expect(paths).toContain(path.join(ZDOTDIR, ".zshrc"));
    expect(paths).toContain(BASH_RC);
  });
});
