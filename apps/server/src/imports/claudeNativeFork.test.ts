import { expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { nativeContext } from "./forkReconciliation.ts";
import { parseHistory } from "./sourceHistory.ts";
import { forkClaudeNative, verifyClaudeNative } from "./claudeNativeFork.ts";

it("uses the real SDK to fork into the target cwd's native store without changing the source", async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "ryco-sdk-import-")));
  try {
    const source = path.join(root, "old-project"),
      target = path.join(root, "new-project");
    await mkdir(target);
    const sourceDir = path.join(root, "projects", source.replace(/[^a-zA-Z0-9]/g, "-"));
    await mkdir(sourceDir, { recursive: true });
    const id = "11111111-1111-4111-8111-111111111111",
      user = "22222222-2222-4222-8222-222222222222",
      answer = "33333333-3333-4333-8333-333333333333";
    const contents =
      [
        {
          type: "user",
          uuid: user,
          parentUuid: null,
          sessionId: id,
          cwd: source,
          timestamp: "2026-01-01T00:00:00Z",
          message: { role: "user", content: "Synthetic fixture question" },
        },
        {
          type: "assistant",
          uuid: answer,
          parentUuid: user,
          sessionId: id,
          cwd: source,
          timestamp: "2026-01-01T00:01:00Z",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Synthetic fixture answer" }],
            stop_reason: "end_turn",
          },
        },
      ]
        .map((row) => JSON.stringify(row))
        .join("\n") + "\n";
    const sourceFile = path.join(sourceDir, `${id}.jsonl`);
    await writeFile(sourceFile, contents);
    const fork = await forkClaudeNative({
      root,
      sourceFile,
      sourceId: id,
      lastMessageId: answer,
      cwd: target,
      key: "a".repeat(64),
    });
    expect(fork).not.toBe(id);
    expect(await readFile(sourceFile, "utf8")).toBe(contents);
    expect(await readdir(sourceDir)).toEqual([`${id}.jsonl`]);
    const targetFile = path.join(
      root,
      "projects",
      target.replace(/[^a-zA-Z0-9]/g, "-"),
      `${fork}.jsonl`,
    );
    const copied = await readFile(targetFile, "utf8");
    expect(copied).toContain("Synthetic fixture answer");
    const history = parseHistory("claudeAgent", copied);
    expect(history.forkedFromId).toBe(id);
    expect(history.messages).toHaveLength(2);
    expect(history.id).toBe(fork);
    expect(copied).not.toContain(`"uuid":"${answer}"`);
    expect(nativeContext("claudeAgent", copied)).toBe(nativeContext("claudeAgent", contents));
    expect(
      await verifyClaudeNative({ root, cwd: target, candidateId: fork, candidateFile: targetFile }),
    ).toBe(true);
    expect(
      await verifyClaudeNative({ root, cwd: source, candidateId: fork, candidateFile: targetFile }),
    ).toBe(false);
    expect(
      await verifyClaudeNative({ root, cwd: target, candidateId: id, candidateFile: targetFile }),
    ).toBe(false);
    expect(await readFile(sourceFile, "utf8")).toBe(contents);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
