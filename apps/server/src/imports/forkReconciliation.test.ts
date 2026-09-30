import { afterEach, expect, it } from "vitest";
import { mkdtemp, realpath, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { makeForkScanner } from "./forkReconciliation.ts";
import { codexFixture, id } from "./sourceHistory.fixtures.ts";
import { IMPORT_LIMITS } from "./sourceHistory.ts";
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function root() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "ryco-fork-scan-")));
  roots.push(root);
  await mkdir(path.join(root, "sessions"));
  return root;
}
const nativeId = (index: number) =>
  `${index.toString(16).padStart(8, "0")}-1111-4111-8111-111111111111`;
it("requires all bounded pages before proving uniqueness and binds cursors to the pinned import", async () => {
  const dir = await root();
  for (let index = 0; index < 52; index++) {
    const copy = codexFixture().replaceAll(id, nativeId(index));
    await writeFile(
      path.join(dir, "sessions", `rollout-${nativeId(index)}.jsonl`),
      index === 51 ? copy.replace('"payload":{', `"payload":{"forked_from_id":"${id}",`) : copy,
    );
  }
  const scan = makeForkScanner(),
    input = {
      source: "codex" as const,
      sourceId: id,
      root: dir,
      key: "fixture",
      pinned: "fingerprint",
    };
  const first = await scan.page(input);
  expect(first.result.state).toBe("scanning");
  expect(first.result.adoptionToken).toBeNull();
  await expect(scan.candidate(first.token, input.key, input.pinned)).rejects.toThrow();
  await expect(scan.page({ ...input, key: "other-import", cursor: first.token })).rejects.toThrow();
  await expect(
    scan.page({ ...input, pinned: "changed-config", cursor: first.token }),
  ).rejects.toThrow();
  const last = await scan.page({ ...input, cursor: first.token });
  expect(last.result.state).toBe("unique");
  expect(last.result.nextCursor).toBeNull();
  expect((await scan.candidate(last.token, input.key, input.pinned)).history.id).toBe(nativeId(51));
  await expect(scan.page({ ...input, cursor: first.token })).rejects.toThrow();
});
it("preserves aggregate byte budgets and never proves uniqueness from a capped catalog", async () => {
  const dir = await root();
  const padding = (JSON.stringify({ type: "synthetic", data: "x".repeat(600_000) }) + "\n").repeat(
    20,
  );
  for (let index = 0; index < 3; index++)
    await writeFile(
      path.join(dir, "sessions", `rollout-${nativeId(index)}.jsonl`),
      codexFixture().replaceAll(id, nativeId(index)) + "\n" + padding,
    );
  const scan = makeForkScanner(),
    input = {
      source: "codex" as const,
      sourceId: id,
      root: dir,
      key: "fixture",
      pinned: "fingerprint",
    };
  const first = await scan.page(input);
  expect(first.result.state).toBe("scanning");
  expect((await scan.page({ ...input, cursor: first.token })).result.state).toBe("missing");
  const capped = await root();
  await Promise.all(
    Array.from({ length: IMPORT_LIMITS.files + 1 }, (_, index) =>
      writeFile(
        path.join(capped, "sessions", `rollout-${nativeId(index)}.jsonl`),
        codexFixture().replaceAll(id, nativeId(index)),
      ),
    ),
  );
  let page = await scan.page({ ...input, root: capped });
  while (page.result.nextCursor)
    page = await scan.page({ ...input, root: capped, cursor: page.result.nextCursor });
  expect(page.result.state).toBe("unknown");
  expect(page.result.adoptionToken).toBeNull();
});

it("keeps uniqueness unknown when linked archive entries cannot be inspected safely", async () => {
  const dir = await root(),
    outside = await root();
  const candidateId = nativeId(1);
  await writeFile(
    path.join(dir, "sessions", `rollout-${candidateId}.jsonl`),
    codexFixture()
      .replaceAll(id, candidateId)
      .replace('"payload":{', `"payload":{"forked_from_id":"${id}",`),
  );
  await symlink(path.join(outside, "sessions"), path.join(dir, "sessions", "linked"));
  const page = await makeForkScanner().page({
    source: "codex",
    root: dir,
    sourceId: id,
    key: "fixture",
    pinned: "fingerprint",
  });
  expect(page.result.state).toBe("unknown");
  expect(page.result.adoptionToken).toBeNull();
});
