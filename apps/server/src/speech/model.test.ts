import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
const fixtures = vi.hoisted(() => ({ verify: vi.fn() }));
vi.mock("node:fs", () => ({ createReadStream: fixtures.verify }));
import { createModelReadiness, modelPath } from "./model.ts";
const directories: string[] = [];
afterEach(async () => {
  for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true });
});
it("coalesces concurrent readiness requests and never hashes missing/wrong-size files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ryco-voice-test-"));
  directories.push(directory);
  const ready = createModelReadiness(directory);
  const first = ready();
  expect(ready()).toBe(first);
  expect(await first).toBe(false);
  await writeFile(modelPath(directory), "invalid");
  expect(await ready()).toBe(false);
  expect(fixtures.verify).not.toHaveBeenCalled();
});
