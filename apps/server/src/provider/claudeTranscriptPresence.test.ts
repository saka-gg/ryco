import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { readClaudeTranscriptPresence } from "./claudeTranscriptPresence.ts";

const SESSION_ID = "550e8400-e29b-41d4-a716-446655440000";

describe("readClaudeTranscriptPresence", () => {
  const roots: string[] = [];
  const makeRoot = () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "ryco-claude-root-"));
    roots.push(root);
    return root;
  };
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("finds a transcript in any project directory", async () => {
    const root = makeRoot();
    mkdirSync(path.join(root, "projects", "-tmp-other"), { recursive: true });
    mkdirSync(path.join(root, "projects", "-tmp-project"), { recursive: true });
    writeFileSync(path.join(root, "projects", "-tmp-project", `${SESSION_ID}.jsonl`), "{}\n");

    expect(await readClaudeTranscriptPresence({ root, sessionId: SESSION_ID })).toBe("present");
  });

  it("reads a session no project directory holds as missing", async () => {
    const root = makeRoot();
    mkdirSync(path.join(root, "projects", "-tmp-project"), { recursive: true });
    writeFileSync(path.join(root, "projects", "-tmp-project", "other-session.jsonl"), "{}\n");
    // Stray files next to the project directories are not an error.
    writeFileSync(path.join(root, "projects", ".DS_Store"), "");

    expect(await readClaudeTranscriptPresence({ root, sessionId: SESSION_ID })).toBe("missing");
  });

  it("reads an empty projects directory as missing", async () => {
    const root = makeRoot();
    mkdirSync(path.join(root, "projects"), { recursive: true });

    expect(await readClaudeTranscriptPresence({ root, sessionId: SESSION_ID })).toBe("missing");
  });

  // A wrapper binary, a container or a CLAUDE_CONFIG_DIR set only inside a wrapper leaves this
  // root without the store the CLI uses: nothing says the transcript is gone.
  it("leaves the resume to Claude when the config root has no projects directory", async () => {
    const root = makeRoot();
    writeFileSync(path.join(root, "settings.json"), "{}\n");

    expect(await readClaudeTranscriptPresence({ root, sessionId: SESSION_ID })).toBe("unknown");
  });

  it("leaves the resume to Claude when its store cannot be read", async () => {
    const root = makeRoot();
    // No config root at all: nothing says this is the store the CLI uses.
    expect(
      await readClaudeTranscriptPresence({
        root: path.join(root, "absent"),
        sessionId: SESSION_ID,
      }),
    ).toBe("unknown");
    // A config root that is not a directory.
    writeFileSync(path.join(root, "file-root"), "");
    expect(
      await readClaudeTranscriptPresence({
        root: path.join(root, "file-root"),
        sessionId: SESSION_ID,
      }),
    ).toBe("unknown");
    // A session id that would leave the project directory.
    mkdirSync(path.join(root, "projects"), { recursive: true });
    expect(await readClaudeTranscriptPresence({ root, sessionId: "../escape" })).toBe("unknown");
    expect(await readClaudeTranscriptPresence({ root, sessionId: "" })).toBe("unknown");
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "reads an unreadable project directory as unknown",
    async () => {
      const root = makeRoot();
      const locked = path.join(root, "projects", "-tmp-locked");
      mkdirSync(locked, { recursive: true });
      chmodSync(locked, 0o000);
      try {
        expect(await readClaudeTranscriptPresence({ root, sessionId: SESSION_ID })).toBe("unknown");
      } finally {
        chmodSync(locked, 0o700);
      }
    },
  );
});
