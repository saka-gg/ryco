import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { Effect } from "effect";
import { afterAll, assert, describe, it } from "vite-plus/test";
import { makeNamedPipe, settleBeforeNamedPipeDeadline } from "../testing/namedPipe.ts";
import { readTaskOutput } from "./taskOutputQuery.ts";

// A dedicated sandbox root passed via the roots override, so the test never
// reads the real harness tmp dirs or ~/.claude/projects.
const sandbox = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "task-output-test-"));
const root = NodePath.join(sandbox, "tasks");
NodeFS.mkdirSync(root, { recursive: true });
const outputPath = NodePath.join(root, "run.output");
NodeFS.writeFileSync(outputPath, "hello output\n");
const outside = NodePath.join(sandbox, "outside.output");
NodeFS.writeFileSync(outside, "evil\n");
const link = NodePath.join(root, "sneaky.output");
NodeFS.symlinkSync(outside, link);

const roots = [root];

// Mirrors the constants in taskOutputQuery.ts; the tests below construct
// files sized against them, so a cap change should fail here loudly.
const TAIL_BYTE_CAP = 64 * 1024;
const CHUNK_BYTE_CAP = 256 * 1024;

afterAll(() => {
  NodeFS.rmSync(sandbox, { recursive: true, force: true });
});

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);
const runFlip = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(Effect.flip(effect));

describe("readTaskOutput containment", () => {
  it("serves a real output file under the root", async () => {
    const result = await run(readTaskOutput({ outputPath, roots }));
    assert.equal(result.chunk, "hello output\n");
    assert.equal(result.nextOffset, result.size);
    assert.equal(result.truncatedHead, false);
    // Success echoes the client's path, never the realpath.
    assert.equal(result.outputPath, outputPath);
  });

  it("rejects relative and wrong-extension paths", async () => {
    const relative = await runFlip(readTaskOutput({ outputPath: "run.output", roots }));
    assert.equal(relative.reason, "invalid-path");
    const wrongExtension = await runFlip(
      readTaskOutput({ outputPath: outputPath.replace(".output", ".txt"), roots }),
    );
    assert.equal(wrongExtension.reason, "invalid-path");
  });

  it("rejects paths outside the root and symlink escapes with the requested path", async () => {
    const escaped = await runFlip(readTaskOutput({ outputPath: outside, roots }));
    assert.equal(escaped.reason, "outside-root");
    // A symlink INSIDE the root pointing outside must fail on realpath
    // re-containment, and the failure must echo the requested path — the
    // resolved target stays server-side.
    const sneaky = await runFlip(readTaskOutput({ outputPath: link, roots }));
    assert.equal(sneaky.reason, "outside-root");
    assert.equal(sneaky.outputPath, link);
  });

  it("fails closed when no root resolves", async () => {
    const missingRoot = NodePath.join(sandbox, "does-not-exist");
    const result = await runFlip(readTaskOutput({ outputPath, roots: [missingRoot] }));
    assert.equal(result.reason, "root-unavailable");
  });

  it.skipIf(process.platform === "win32")(
    "refuses a named pipe without waiting for a writer",
    async () => {
      const fifo = NodePath.join(root, "pipe.output");
      makeNamedPipe(fifo);
      const result = await settleBeforeNamedPipeDeadline(fifo, () =>
        runFlip(readTaskOutput({ outputPath: fifo, roots })),
      );
      assert.equal(result.reason, "not-regular-file");
      assert.equal(result.outputPath, fifo);
    },
  );
});

describe("readTaskOutput windows", () => {
  it("continues from a prior nextOffset and clamps offsets past EOF", async () => {
    const growing = NodePath.join(root, "growing.output");
    NodeFS.writeFileSync(growing, "first");
    const first = await run(readTaskOutput({ outputPath: growing, roots }));
    assert.equal(first.chunk, "first");
    NodeFS.appendFileSync(growing, " second");
    const second = await run(
      readTaskOutput({ outputPath: growing, offset: first.nextOffset, roots }),
    );
    assert.equal(second.chunk, " second");
    assert.equal(second.nextOffset, second.size);
    // Rotation/truncation: an offset past EOF yields an empty chunk.
    const past = await run(readTaskOutput({ outputPath: growing, offset: 10_000, roots }));
    assert.equal(past.chunk, "");
    assert.equal(past.nextOffset, past.size);
  });

  it("tails large files with truncatedHead and codepoint-aligned start", async () => {
    // "ab" then 3-byte € repeated: size - TAIL_BYTE_CAP lands mid-character
    // (65536 ≡ 1 mod 3), so the head must skip continuation bytes instead
    // of decoding a replacement character.
    const big = NodePath.join(root, "big.output");
    const euros = Math.ceil((TAIL_BYTE_CAP + 9000) / 3);
    NodeFS.writeFileSync(big, `ab${"€".repeat(euros)}`);
    const result = await run(readTaskOutput({ outputPath: big, roots }));
    assert.equal(result.truncatedHead, true);
    assert.notInclude(result.chunk, "�");
    assert.equal(result.chunk.at(0), "€");
    assert.equal(result.nextOffset, result.size);
  });

  it("reassembles a multi-byte character split by the chunk cap losslessly", async () => {
    // 'a'-fill up to two bytes short of the cap, then a 4-byte emoji
    // straddling the cap boundary, then a tail marker.
    const split = NodePath.join(root, "split.output");
    const prefix = "a".repeat(CHUNK_BYTE_CAP - 2);
    NodeFS.writeFileSync(split, `${prefix}🦊end`);
    const first = await run(readTaskOutput({ outputPath: split, offset: 0, roots }));
    // The incomplete emoji is held back, not decoded as replacement chars.
    assert.equal(first.chunk, prefix);
    assert.equal(first.nextOffset, CHUNK_BYTE_CAP - 2);
    const second = await run(
      readTaskOutput({ outputPath: split, offset: first.nextOffset, roots }),
    );
    assert.equal(first.chunk + second.chunk, `${prefix}🦊end`);
    assert.equal(second.nextOffset, second.size);
  });

  it("emits the residue of a permanently incomplete trailing sequence at EOF", async () => {
    // A writer killed mid-write leaves a dangling lead byte; the reader
    // must still converge (nextOffset === size) instead of holding the
    // tail back forever and pinning a `while (nextOffset < size)` poll.
    const torn = NodePath.join(root, "torn.output");
    NodeFS.writeFileSync(torn, Buffer.concat([Buffer.from("done"), Buffer.from([0xf0, 0x9f])]));
    const result = await run(readTaskOutput({ outputPath: torn, roots }));
    assert.equal(result.nextOffset, result.size);
    assert.include(result.chunk, "done");
    assert.include(result.chunk, "�");
  });
});
