import { describe, expect, it } from "vite-plus/test";

import { createOffThreadDiffParser, type DiffParseWorkerLike } from "../lib/diffParseOffThread";
import { getRenderablePatch } from "../lib/diffParsing";

describe("off-thread diff parse worker", () => {
  it("parses a patch in a real worker with the same result as the page", async () => {
    const patch = Array.from({ length: 50 }, (_, index) =>
      [
        `diff --git a/src/f${index}.ts b/src/f${index}.ts`,
        "index 1111111..2222222 100644",
        `--- a/src/f${index}.ts`,
        `+++ b/src/f${index}.ts`,
        "@@ -1 +1 @@",
        "-old",
        "+new",
      ].join("\n"),
    ).join("\n");
    let answers = 0;
    const parser = createOffThreadDiffParser({
      createWorker: () => {
        const worker = new Worker(new URL("../lib/diffParse.worker.ts", import.meta.url), {
          type: "module",
        });
        worker.addEventListener("message", () => {
          answers += 1;
        });
        return worker as unknown as DiffParseWorkerLike;
      },
    });
    const parsed = await parser.parse(patch, "diff-panel");
    // The worker answered; nothing fell back to the page.
    expect(answers).toBe(1);
    expect(parsed).toEqual(getRenderablePatch(patch, "diff-panel"));
    parser.dispose();
  });
});
