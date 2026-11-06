import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  COMPUTER_APP_APPROVALS_FILE,
  addComputerAppApproval,
  computerAppApprovalKey,
  computerAppDisplayName,
  readComputerAppApprovals,
  removeComputerAppApproval,
} from "./computerAppApprovals.ts";

let directory: string | undefined;
afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});
async function path() {
  directory = await mkdtemp(join(tmpdir(), "ryco-app-approvals-"));
  return join(directory, COMPUTER_APP_APPROVALS_FILE);
}

describe("computer app approvals", () => {
  it("normalizes names and keys", () => {
    expect(computerAppDisplayName("/Applications/Google  Chrome.app/")).toBe("Google Chrome");
    expect(computerAppApprovalKey("Safari.app")).toBe("safari");
  });

  it("adds, de-duplicates, lists newest first and removes", async () => {
    const file = await path();
    expect(await readComputerAppApprovals(file)).toEqual([]);
    await addComputerAppApproval(file, "Safari", () => new Date("2026-11-06T00:00:00Z"));
    await addComputerAppApproval(file, "Notes", () => new Date("2026-11-06T00:01:00Z"));
    await addComputerAppApproval(file, "safari.app", () => new Date("2026-11-06T00:02:00Z"));
    expect(await readComputerAppApprovals(file)).toEqual([
      { key: "safari", name: "safari", allowedAt: "2026-11-06T00:02:00.000Z" },
      { key: "notes", name: "Notes", allowedAt: "2026-11-06T00:01:00.000Z" },
    ]);
    expect((await removeComputerAppApproval(file, "safari")).map((app) => app.key)).toEqual([
      "notes",
    ]);
    expect(JSON.parse(await readFile(file, "utf8")).apps).toHaveLength(1);
  });

  it("keeps concurrent writers in order", async () => {
    const file = await path();
    await Promise.all([
      addComputerAppApproval(file, "Safari"),
      addComputerAppApproval(file, "Notes"),
      removeComputerAppApproval(file, "safari"),
    ]);
    expect((await readComputerAppApprovals(file)).map((app) => app.key)).toEqual(["notes"]);
  });

  it("drops entries whose key does not match their name", async () => {
    const file = await path();
    await writeFile(
      file,
      JSON.stringify({
        apps: [
          { key: "terminal", name: "Safari", allowedAt: "x" },
          { key: "notes", name: "Notes", allowedAt: "x" },
          "junk",
        ],
      }),
    );
    expect((await readComputerAppApprovals(file)).map((app) => app.key)).toEqual(["notes"]);
    await writeFile(file, "not json");
    expect(await readComputerAppApprovals(file)).toEqual([]);
  });
});
