import { describe, expect, it } from "vite-plus/test";

import {
  type ActivityInput,
  QUIET_MS,
  TTY_QUIET_MS,
  assessActivity,
  extractSignIn,
  looksLikeShellPrompt,
} from "./activity.ts";

const input = (overrides: Partial<ActivityInput> = {}): ActivityInput => ({
  running: true,
  quietMs: 5_000,
  beforeCursor: "",
  afterCursor: "",
  tail: [],
  alternate: false,
  outputSinceStart: true,
  ...overrides,
});

/** The cursor waits at the end of `line`, which is also the last line of the screen. */
const atPrompt = (line: string, overrides: Partial<ActivityInput> = {}): ActivityInput =>
  input({ beforeCursor: line, tail: line.trim() === "" ? [] : [line], ...overrides });

describe("assessActivity: tty evidence", () => {
  it("reads echo off in line mode as a secret prompt, whatever the text says", () => {
    const activity = assessActivity(
      atPrompt("Continue: ", {
        quietMs: TTY_QUIET_MS,
        inputMode: { echo: false, canonical: true },
      }),
    );
    expect(activity).toMatchObject({
      kind: "waiting-for-input",
      secret: true,
      evidence: "tty",
      prompt: "Continue:",
    });
  });

  it("uses the tty only after a short pause", () => {
    const activity = assessActivity(
      atPrompt("Continue: ", { quietMs: 100, inputMode: { echo: false, canonical: true } }),
    );
    expect(activity.evidence).not.toBe("tty");
    expect(activity.kind).toBe("working");
  });

  it("does not treat raw mode (echo and line mode off) as secret", () => {
    const activity = assessActivity(
      atPrompt("? Pick a color ", { inputMode: { echo: false, canonical: false } }),
    );
    expect(activity.secret).toBe(false);
    expect(activity.evidence).not.toBe("tty");
  });

  it("does not treat echo on as secret", () => {
    const activity = assessActivity(
      atPrompt("building", { inputMode: { echo: true, canonical: true } }),
    );
    expect(activity).toMatchObject({ kind: "silent", secret: false });
  });
});

describe("assessActivity: secret prompts on the cursor line", () => {
  it.each([
    "Password:",
    "Password: ",
    "[sudo] password for ann: ",
    "Enter passphrase for key '/home/a/.ssh/id_ed25519': ",
    "ann@host's password: ",
    "Enter PIN: ",
    "Paste your API token: ",
    "Verification code: ",
  ])("%j is a secret prompt", (line) => {
    const activity = assessActivity(atPrompt(line));
    expect(activity).toMatchObject({
      kind: "waiting-for-input",
      secret: true,
      evidence: "screen",
      prompt: line.trim(),
    });
  });
});

describe("assessActivity: what is not a secret prompt", () => {
  it("ignores a log line with a secret word once the output moved to a new line", () => {
    const activity = assessActivity(
      input({
        beforeCursor: "",
        tail: ["Refreshing token for user ann", "stored password hash: ok"],
      }),
    );
    expect(activity.secret).toBe(false);
    expect(activity.kind).toBe("silent");
  });

  it("reads output still arriving as working, even with a secret word", () => {
    const activity = assessActivity(atPrompt("Generating token…", { quietMs: QUIET_MS - 1 }));
    expect(activity).toMatchObject({ kind: "working", secret: false });
  });

  it.each(["Downloading [=====>    ] 45%", "Receiving objects:  45% (450/1000)"])(
    "reads the progress bar %j as silent",
    (line) => {
      const activity = assessActivity(atPrompt(line));
      expect(activity).toMatchObject({ kind: "silent", secret: false });
    },
  );

  it("does not match pin inside a longer word", () => {
    const activity = assessActivity(atPrompt("Pinning dependencies"));
    expect(activity).toMatchObject({ kind: "silent", secret: false });
  });

  it("ignores a secret word in an older line when the cursor line has none", () => {
    const activity = assessActivity(
      input({
        beforeCursor: "Installing packages",
        tail: ["Password: ********", "Installing packages"],
      }),
    );
    expect(activity).toMatchObject({ kind: "silent", secret: false });
  });

  it("ignores a secret word that is not at the end of the line", () => {
    const activity = assessActivity(atPrompt("token: refreshed, continuing with the build"));
    expect(activity.secret).toBe(false);
  });

  it("does not take a prompt from a cursor sitting inside a line", () => {
    const activity = assessActivity(
      input({ beforeCursor: "Password:", afterCursor: " rest of line", tail: ["Password: rest"] }),
    );
    expect(activity.secret).toBe(false);
  });
});

describe("assessActivity: choice prompts", () => {
  it.each(["Continue? [y/N] ", "Overwrite file (y/n)", "Press Enter to continue"])(
    "%j waits for input, not a secret",
    (line) => {
      const activity = assessActivity(atPrompt(line));
      expect(activity).toMatchObject({
        kind: "waiting-for-input",
        secret: false,
        evidence: "screen",
      });
    },
  );

  it("sees an inquirer list in the tail even with the cursor elsewhere", () => {
    const activity = assessActivity(
      input({
        beforeCursor: "",
        tail: ["? Pick one (Use arrow keys)", "❯ first", "  second"],
      }),
    );
    expect(activity).toMatchObject({
      kind: "waiting-for-input",
      secret: false,
      prompt: "second",
    });
  });

  it("reads a REPL prompt as waiting", () => {
    expect(assessActivity(atPrompt("mysql> ")).kind).toBe("waiting-for-input");
  });
});

describe("assessActivity: states", () => {
  it("is idle when nothing runs", () => {
    expect(assessActivity(atPrompt("Password: ", { running: false }))).toEqual({
      kind: "idle",
      secret: false,
      evidence: "none",
      quietSeconds: 5,
    });
  });

  it("is full-screen on the alternate screen", () => {
    expect(assessActivity(input({ alternate: true, quietMs: 0 })).kind).toBe("full-screen");
  });

  it("is working while output arrives", () => {
    expect(assessActivity(atPrompt("Continue? [y/N] ", { quietMs: 500 })).kind).toBe("working");
  });

  it("rounds quiet seconds to tenths", () => {
    expect(assessActivity(input({ quietMs: 1_234 })).quietSeconds).toBe(1.2);
  });
});

describe("extractSignIn", () => {
  it("finds the link and the device code of a device flow", () => {
    const tail = [
      "! First copy your one-time code: ABCD-1234",
      "Open https://github.com/login/device in your browser.",
    ];
    const hint = extractSignIn(tail);
    expect(hint?.urls).toContain("https://github.com/login/device");
    expect(hint?.codes).toContain("ABCD-1234");
  });

  it("trims trailing punctuation from links", () => {
    const hint = extractSignIn(["Sign in at https://example.com/activate."]);
    expect(hint?.urls).toEqual(["https://example.com/activate"]);
  });

  it("returns nothing without sign-in words", () => {
    expect(extractSignIn(["See https://example.com/docs", "Build ABCD-1234 done"])).toBe(undefined);
  });

  it("is reported as waiting for input", () => {
    const tail = [
      "! First copy your one-time code: ABCD-1234",
      "Open https://github.com/login/device",
    ];
    const activity = assessActivity(input({ beforeCursor: "", tail }));
    expect(activity.kind).toBe("waiting-for-input");
    expect(activity.signIn?.codes).toContain("ABCD-1234");
  });
});

describe("looksLikeShellPrompt", () => {
  it.each(["$ ", "user@host:~% ", "❯ ", "PS C:\\> "])("%j is a shell prompt", (line) => {
    expect(looksLikeShellPrompt(line, "")).toBe(true);
  });

  it.each(["", "building..."])("%j is not a shell prompt", (line) => {
    expect(looksLikeShellPrompt(line, "")).toBe(false);
  });

  it("is not a prompt when text follows the cursor", () => {
    expect(looksLikeShellPrompt("$ ", "ls -la")).toBe(false);
  });
});
