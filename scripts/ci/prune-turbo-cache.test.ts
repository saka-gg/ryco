import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { DEFAULT_MAX_AGE_MS, pruneTurboCache } from "./prune-turbo-cache.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-10-20T12:00:00Z");
const OLD = NOW - DEFAULT_MAX_AGE_MS - 60 * 60_000;
const RECENT = NOW - 60_000;

let root: string;
let cacheDir: string;
let runsDir: string;

function writeEntry(hash: string, mtimeMs: number): void {
  for (const name of [`${hash}.tar.zst`, `${hash}-meta.json`, `${hash}-manifest.json`]) {
    const path = join(cacheDir, name);
    writeFileSync(path, "x".repeat(10));
    utimesSync(path, mtimeMs / 1000, mtimeMs / 1000);
  }
}

// Mirrors the parts of a Turbo 2.10 `--summarize` file the pruner reads.
function writeSummary(
  name: string,
  hashes: readonly string[],
  execution: { attempted: number; exitCode: number } = { attempted: hashes.length, exitCode: 0 },
): void {
  mkdirSync(runsDir, { recursive: true });
  writeFileSync(
    join(runsDir, `${name}.json`),
    JSON.stringify({
      execution,
      tasks: hashes.map((hash) => ({ hash, cache: { status: "HIT" } })),
    }),
  );
}

// The next job restores the saved cache but starts with no run summaries.
function startNextJob(): void {
  rmSync(runsDir, { recursive: true, force: true });
}

function cacheFiles(): string[] {
  return readdirSync(cacheDir).toSorted();
}

function cachedHashes(): string[] {
  return [...new Set(cacheFiles().map((name) => name.slice(0, 16)))];
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ryco-prune-turbo-cache-"));
  cacheDir = join(root, "cache");
  runsDir = join(root, "runs");
  mkdirSync(cacheDir);
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

describe("Turbo cache pruning", () => {
  it("keeps exactly the entries this job's runs used, whatever their age", () => {
    writeEntry("aaaa000000000001", OLD);
    writeEntry("aaaa000000000002", RECENT);
    writeEntry("bbbb000000000001", RECENT);
    writeEntry("dead000000000001", RECENT);
    writeEntry("dead000000000002", OLD);
    writeSummary("build", ["aaaa000000000001", "aaaa000000000002"]);
    writeSummary("typecheck", ["bbbb000000000001", "ffff000000000001"]);

    expect(pruneTurboCache({ cacheDir, runsDir, now: NOW })).toEqual({
      mode: "summaries",
      keptEntries: 3,
      keptBytes: 90,
      removedEntries: 2,
      removedBytes: 60,
    });
    expect(cachedHashes()).toEqual(["aaaa000000000001", "aaaa000000000002", "bbbb000000000001"]);
    expect(cacheFiles()).toHaveLength(9);
    // Used entries are stamped, so their age now counts from this use.
    expect(new Set(cacheFiles().map((name) => statSync(join(cacheDir, name)).mtimeMs))).toEqual(
      new Set([NOW]),
    );
  });

  it("without summaries, keeps what was used within the window of the cache's last use", () => {
    writeEntry("aaaa000000000001", OLD);
    writeEntry("aaaa000000000002", RECENT);

    expect(pruneTurboCache({ cacheDir, runsDir, now: NOW })).toMatchObject({
      mode: "age",
      keptEntries: 1,
      removedEntries: 1,
    });
    expect(cacheFiles()).toEqual([
      "aaaa000000000002-manifest.json",
      "aaaa000000000002-meta.json",
      "aaaa000000000002.tar.zst",
    ]);
  });

  it("keeps long-lived entries a previous run used when a later job writes no summary", () => {
    writeEntry("aaaa000000000001", OLD);
    writeEntry("aaaa000000000002", OLD);
    writeEntry("dead000000000001", OLD);
    writeSummary("build", ["aaaa000000000001", "aaaa000000000002"]);
    pruneTurboCache({ cacheDir, runsDir, now: NOW });

    // A scope that runs rarely, failing this time before Turbo starts.
    startNextJob();
    writeEntry("dead000000000002", NOW - DEFAULT_MAX_AGE_MS - 60_000);

    expect(pruneTurboCache({ cacheDir, runsDir, now: NOW + 10 * DAY_MS })).toMatchObject({
      mode: "age",
      keptEntries: 2,
      removedEntries: 1,
    });
    expect(cachedHashes()).toEqual(["aaaa000000000001", "aaaa000000000002"]);
  });

  it("also keeps what the previous run used when a failed run did not list every task", () => {
    writeEntry("aaaa000000000001", OLD);
    writeEntry("bbbb000000000001", OLD);
    writeEntry("bbbb000000000002", OLD);
    writeSummary("build", ["aaaa000000000001", "bbbb000000000001", "bbbb000000000002"]);
    pruneTurboCache({ cacheDir, runsDir, now: NOW });

    startNextJob();
    const later = NOW + 10 * DAY_MS;
    writeEntry("cccc000000000001", later);
    writeEntry("dead000000000001", NOW - DEFAULT_MAX_AGE_MS - 60_000);
    writeSummary("failed", ["aaaa000000000001", "cccc000000000001"], {
      attempted: 12,
      exitCode: 1,
    });

    expect(pruneTurboCache({ cacheDir, runsDir, now: later })).toMatchObject({
      mode: "summaries+age",
      keptEntries: 4,
      removedEntries: 1,
    });
    expect(cachedHashes()).toEqual([
      "aaaa000000000001",
      "bbbb000000000001",
      "bbbb000000000002",
      "cccc000000000001",
    ]);
    // Entries kept only by age keep their mtime, so they still age out.
    expect(statSync(join(cacheDir, "bbbb000000000001.tar.zst")).mtimeMs).toBe(NOW);
    expect(statSync(join(cacheDir, "aaaa000000000001.tar.zst")).mtimeMs).toBe(later);
  });

  it("treats a run that selected no tasks as no evidence", () => {
    writeEntry("aaaa000000000001", OLD);
    writeEntry("aaaa000000000002", OLD);
    writeSummary("typecheck-affected", [], { attempted: 0, exitCode: 0 });

    expect(pruneTurboCache({ cacheDir, runsDir, now: NOW })).toMatchObject({
      mode: "age",
      keptEntries: 2,
      removedEntries: 0,
    });

    // Next to a run that did use entries, it still makes the evidence partial.
    writeEntry("bbbb000000000001", RECENT);
    writeSummary("build", ["bbbb000000000001"]);
    expect(pruneTurboCache({ cacheDir, runsDir, now: NOW })).toMatchObject({
      mode: "summaries+age",
      keptEntries: 3,
      removedEntries: 0,
    });
  });

  it("treats an unreadable or reshaped summary as incomplete and warns", () => {
    writeEntry("aaaa000000000001", OLD);
    writeEntry("bbbb000000000001", RECENT);
    writeSummary("ok", ["aaaa000000000001"]);
    writeFileSync(join(runsDir, "truncated.json"), '{"tasks": [');
    writeFileSync(join(runsDir, "renamed.json"), JSON.stringify({ tasks: [{ taskHash: "x" }] }));

    expect(pruneTurboCache({ cacheDir, runsDir, now: NOW })).toMatchObject({
      mode: "summaries+age",
      keptEntries: 2,
      removedEntries: 0,
    });
    expect(vi.mocked(console.log).mock.calls.flat().join("\n")).toContain(
      "::warning::Unrecognized Turbo run summary renamed.json",
    );
  });

  it("leaves files and directories that are not Turbo entries alone", () => {
    writeEntry("dead000000000001", OLD);
    for (const name of ["README", "dead000000000001.tar.zst.tmp", "dead000000000001-other.json"]) {
      writeFileSync(join(cacheDir, name), "keep");
      utimesSync(join(cacheDir, name), OLD / 1000, OLD / 1000);
    }
    mkdirSync(join(cacheDir, "dead000000000002.tar.zst"));
    writeSummary("build", ["aaaa000000000001"]);

    expect(pruneTurboCache({ cacheDir, runsDir, now: NOW })).toMatchObject({
      mode: "summaries",
      removedEntries: 1,
    });
    expect(cacheFiles()).toEqual([
      "README",
      "dead000000000001-other.json",
      "dead000000000001.tar.zst.tmp",
      "dead000000000002.tar.zst",
    ]);
  });

  it("does nothing when the cache directory does not exist", () => {
    rmSync(cacheDir, { recursive: true });
    writeSummary("build", ["aaaa000000000001"]);

    expect(pruneTurboCache({ cacheDir, runsDir, now: NOW })).toEqual({
      mode: "summaries",
      keptEntries: 0,
      keptBytes: 0,
      removedEntries: 0,
      removedBytes: 0,
    });
  });
});
