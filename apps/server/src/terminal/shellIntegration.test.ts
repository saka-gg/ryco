import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vite-plus/test";

import {
  SHELL_INTEGRATION_VERSION,
  SHELL_MARK_NONCE_ENV,
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
      "/other/state/shell-integration/v3/zsh/",
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
      path.join("v3", "zsh", ".zshenv"),
      path.join("v3", "zsh", ".zprofile"),
      path.join("v3", "zsh", ".zshrc"),
      path.join("v3", "bash", "ryco.bash"),
    ]);
    const byName = new Map(files.map((file) => [path.basename(file.path), file.content]));
    expect(byName.get(".zshenv")).toContain('builtin source "$ZDOTDIR/.zshenv"');
    expect(byName.get(".zshrc")).toContain("133;%s;ryco=");
    expect(byName.get(".zshrc")).toContain('__ryco_mark "D;$ret"');
    expect(byName.get("ryco.bash")).toContain('. "$HOME/.bashrc"');
    expect(byName.get("ryco.bash")).toContain("133;%s;ryco=");
    expect(byName.get("ryco.bash")).toContain("$(__ryco_mark C)");
  });

  it("matches what withShellIntegration points at", () => {
    const paths = shellIntegrationFiles().map((file) => path.join(DIR, file.path));
    expect(paths).toContain(path.join(ZDOTDIR, ".zshrc"));
    expect(paths).toContain(BASH_RC);
  });
});

describe("shell marks' nonce", () => {
  it("hands zsh and bash the nonce through the environment", () => {
    const zsh = withShellIntegration({ shell: "/bin/zsh" }, {}, "/state", "darwin", "abc");
    const bash = withShellIntegration({ shell: "/bin/bash" }, {}, "/state", "linux", "abc");
    expect(zsh?.env[SHELL_MARK_NONCE_ENV]).toBe("abc");
    expect(bash?.env[SHELL_MARK_NONCE_ENV]).toBe("abc");
    expect(withShellIntegration({ shell: "/bin/bash" }, {}, "/state", "linux")?.env).toEqual({});
  });

  it("is in every mark, printed by one function the nonce lives in", () => {
    for (const file of shellIntegrationFiles()) {
      for (const mark of file.content.matchAll(/133;[^'"\n]*/g)) {
        expect(mark[0]).toContain("ryco=");
      }
      // Never a literal or variable in a prompt string.
      expect(file.content).not.toMatch(/PS0="[^\n]*ryco=/);
    }
  });
});

// Real shells, started interactively with a user whose startup files turn on nounset.
const realShellCases = [
  {
    shell: "/bin/zsh",
    args: ["-o", "nopromptsp"],
    hooks: "typeset -p precmd_functions preexec_functions",
  },
  { shell: "/bin/bash", args: [], hooks: "declare -p PROMPT_COMMAND" },
].filter((entry) => process.platform !== "win32" && existsSync(entry.shell));

describe.runIf(realShellCases.length > 0)("startup files under nounset", () => {
  it.each(realShellCases)(
    "$shell installs its hooks without unbound-variable errors",
    ({ shell, args, hooks }) => {
      const root = mkdtempSync(path.join(os.tmpdir(), "ryco-si-nounset-"));
      try {
        const home = path.join(root, "home");
        mkdirSync(home);
        writeFileSync(path.join(home, ".zshenv"), "setopt nounset\n");
        writeFileSync(
          path.join(home, ".zshrc"),
          "setopt nounset\nunset precmd_functions preexec_functions\n",
        );
        writeFileSync(path.join(home, ".bashrc"), "set -u\n");
        const dir = path.join(root, "state");
        for (const file of shellIntegrationFiles()) {
          mkdirSync(path.dirname(path.join(dir, file.path)), { recursive: true });
          writeFileSync(path.join(dir, file.path), file.content);
        }
        const spawn = withShellIntegration(
          { shell, args },
          {
            PATH: process.env.PATH ?? "/usr/bin:/bin",
            HOME: home,
            TERM: "xterm-256color",
            TERM_PROGRAM: "ryco",
          },
          dir,
          process.platform,
          "n0nce",
        )!;
        const result = spawnSync(
          spawn.shell,
          [
            ...spawn.args,
            "-i",
            "-c",
            `${hooks}; echo "nonce=\${${SHELL_MARK_NONCE_ENV}-gone} nonce-var=\${__ryco_nonce-gone} ps0=[\${PS0-}]"`,
          ],
          {
            env: spawn.env,
            cwd: home,
            encoding: "utf8",
            timeout: 10_000,
          },
        );
        const output = `${result.stdout}${result.stderr}`;
        expect(output).not.toMatch(/ryco\.bash.*(unbound|not set)|v3\/zsh.*(unbound|not set)/);
        expect(output).toContain("__ryco_precmd");
        expect(output).toContain("nonce=gone");
        expect(output).toContain("nonce-var=gone");
        // bash's PS0 calls the mark function; it never holds the nonce itself.
        expect(/ps0=\[[^\]]*\]/.exec(output)?.[0]).not.toContain("n0nce");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});
