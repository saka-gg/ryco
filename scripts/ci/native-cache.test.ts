import {
  existsSync,
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

import {
  chooseTrustedArtifact,
  main,
  pruneNativeCache,
  RESTORE_MARKER,
  restoreNativeCache,
  type RestoreDependencies,
  type RunArtifact,
  type WorkflowRun,
  writeRestoreMarker,
} from "./native-cache.ts";

const repository = "saka-gg/ryco";
const name = "native-cache-mac-arm64";
const now = new Date("2026-10-21T12:00:00Z");

function artifact(id: number, runId: number, overrides: Partial<RunArtifact> = {}): RunArtifact {
  return {
    id,
    name,
    expired: false,
    created_at: new Date(now.getTime() - (1000 - id) * 60_000).toISOString(),
    expires_at: "2027-01-01T00:00:00Z",
    workflow_run: { id: runId, head_branch: "main", repository_id: 1, head_repository_id: 1 },
    ...overrides,
  };
}

function run(id: number, overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id,
    path: ".github/workflows/release.yml",
    event: "workflow_dispatch",
    head_branch: "main",
    repository: { full_name: repository },
    head_repository: { full_name: repository },
    ...overrides,
  };
}

function choose(artifacts: readonly RunArtifact[], runs: readonly WorkflowRun[]) {
  return chooseTrustedArtifact({
    artifacts,
    runs: new Map(runs.map((value) => [value.id, value])),
    name,
    repository,
    now,
  });
}

describe("native cache artifact trust", () => {
  it("chooses the newest artifact from a release dispatch on main", () => {
    const choice = choose([artifact(1, 10), artifact(2, 20)], [run(10), run(20)]);
    expect(choice.artifact?.id).toBe(2);
  });

  it.each([
    ["another workflow", { path: ".github/workflows/pull-request-validation.yml" }],
    ["a dynamic workflow path", { path: "dynamic/release.yml" }],
    ["a branch", { head_branch: "feature/native" }],
    ["a pull request event", { event: "pull_request" }],
    ["a push event", { event: "push" }],
    ["a fork's head repository", { head_repository: { full_name: "attacker/ryco" } }],
    ["another repository", { repository: { full_name: "attacker/ryco" } }],
    ["a missing head repository", { head_repository: null }],
  ] satisfies [string, Partial<WorkflowRun>][])(
    "rejects artifacts from %s and falls back to an older trusted one",
    (_label, overrides) => {
      const choice = choose([artifact(1, 10), artifact(2, 20)], [run(10), run(20, overrides)]);
      expect(choice.artifact?.id).toBe(1);
      expect(choose([artifact(2, 20)], [run(20, overrides)])).toMatchObject({
        artifact: null,
        reason: expect.stringContaining("artifact 2 (run 20)"),
      });
    },
  );

  it("rejects listing summaries of branch and fork runs without trusting matching ones", () => {
    expect(
      choose(
        [
          artifact(1, 10, {
            workflow_run: { id: 10, head_branch: "main", repository_id: 1, head_repository_id: 2 },
          }),
          artifact(2, 20, {
            workflow_run: { id: 20, head_branch: "pr", repository_id: 1, head_repository_id: 1 },
          }),
        ],
        // Even a trusted-looking run record cannot override a contradicting listing.
        [run(10), run(20)],
      ),
    ).toMatchObject({ artifact: null, reason: expect.stringMatching(/branch pr.*fork run/u) });
    // A main-looking summary still needs the run record.
    expect(choose([artifact(1, 10)], [run(10, { event: "pull_request" })]).artifact).toBeNull();
  });

  it("rejects expired, misnamed, and run-less artifacts", () => {
    for (const candidate of [
      artifact(1, 10, { expired: true }),
      artifact(1, 10, { expires_at: "2026-10-21T11:59:59Z" }),
      artifact(1, 10, { expires_at: "not a date" }),
      artifact(1, 10, { name: `${name}-other` }),
    ]) {
      expect(choose([candidate], [run(10)])).toMatchObject({
        artifact: null,
        reason: `no unexpired artifact named ${name}`,
      });
    }
    expect(choose([artifact(1, 10, { workflow_run: null })], [])).toMatchObject({
      artifact: null,
      reason: expect.stringContaining("no workflow run"),
    });
  });

  it("asks for the newest candidate's run before considering older ones", () => {
    const choice = choose([artifact(1, 10), artifact(2, 20)], [run(10)]);
    expect(choice).toMatchObject({ artifact: null, pendingRunId: 20 });
  });

  it("rejects a run record that does not describe the artifact's run", () => {
    const runs = new Map([[10, run(11)]]);
    expect(
      chooseTrustedArtifact({ artifacts: [artifact(1, 10)], runs, name, repository, now }),
    ).toMatchObject({ artifact: null, reason: expect.stringContaining("run mismatch") });
  });
});

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ryco-native-cache-ci-test-"));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

function entry(directory: string, group: string, key: string, mtime?: Date) {
  const path = join(directory, group, key);
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "binary"), `${group}/${key}`);
  if (mtime) utimesSync(path, mtime, mtime);
  return path;
}

describe("native cache restore", () => {
  function dependencies(overrides: Partial<RestoreDependencies> = {}): RestoreDependencies {
    return {
      listArtifacts: async () => [artifact(1, 10), artifact(2, 20)],
      getRun: vi.fn(async (id: number) => run(id, id === 20 ? { head_branch: "pr" } : {})),
      download: vi.fn((_runId: number, _name: string, directory: string) => {
        entry(directory, "computer-use", "abc");
        entry(directory, "cua", "def");
      }),
      now: () => now,
      ...overrides,
    };
  }

  it("installs the trusted artifact's entries backdated to its creation", async () => {
    const dest = join(root, "native-builds/artifacts");
    const deps = dependencies();
    await expect(restoreNativeCache({ name, dest, repository }, deps)).resolves.toContain(
      "Restored 2",
    );
    expect(deps.getRun).toHaveBeenCalledTimes(2);
    expect(deps.download).toHaveBeenCalledWith(10, name, expect.any(String));
    const restored = statSync(join(dest, "cua/def")).mtimeMs;
    expect(Math.abs(restored - Date.parse(artifact(1, 10).created_at!))).toBeLessThan(1);
    // The staging directory never stays beside the cache.
    expect(readdirSync(join(root, "native-builds"))).toEqual(["artifacts"]);
  });

  it("keeps existing local entries", async () => {
    const dest = join(root, "artifacts");
    entry(dest, "cua", "def");
    writeFileSync(join(dest, "cua/def/binary"), "local");
    await restoreNativeCache({ name, dest, repository }, dependencies());
    expect(readdirSync(join(dest, "computer-use"))).toEqual(["abc"]);
    expect(statSync(join(dest, "cua/def/binary")).size).toBe("local".length);
  });

  it("leaves the cache untouched when no trusted artifact or download succeeds", async () => {
    const dest = join(root, "artifacts");
    await expect(
      restoreNativeCache(
        { name, dest, repository },
        dependencies({ getRun: async (id) => run(id, { event: "push" }) }),
      ),
    ).rejects.toThrow("no trusted");
    await expect(
      restoreNativeCache(
        { name, dest, repository },
        dependencies({
          download: (_runId, _name, directory) => {
            entry(directory, "cua", "partial");
            throw new Error("network");
          },
        }),
      ),
    ).rejects.toThrow("network");
    expect(existsSync(dest)).toBe(false);
    expect(readdirSync(root)).toEqual([]);
  });

  it("bounds run lookups when untrusted uploads flood the name", async () => {
    const getRun = vi.fn(async (id: number) => run(id, { event: "pull_request" }));
    await expect(
      restoreNativeCache(
        { name, dest: join(root, "artifacts"), repository },
        dependencies({
          listArtifacts: async () => Array.from({ length: 30 }, (_, id) => artifact(id, id + 100)),
          getRun,
        }),
      ),
    ).rejects.toThrow("stopped after 10 run lookups");
    expect(getRun).toHaveBeenCalledTimes(10);
  });

  it("warns, exits 0, and still writes the marker when restore cannot run", async () => {
    vi.stubEnv("GITHUB_REPOSITORY", repository);
    vi.stubEnv("GH_TOKEN", "");
    const output = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const dest = join(root, "artifacts");
    await expect(main(["restore", "--name", name, "--dest", dest])).resolves.toBe(0);
    expect(output.mock.calls.join("\n")).toMatch(/^::warning::.*GH_TOKEN is not set/mu);
    expect(existsSync(join(dest, RESTORE_MARKER))).toBe(true);
  });

  it("rejects malformed invocations", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(main(["restore", "--name", name])).resolves.toBe(2);
    await expect(main(["restore", "--name", "../x", "--dest", root])).resolves.toBe(2);
    await expect(main(["prune"])).resolves.toBe(2);
    await expect(main(["upload", "--dir", root])).resolves.toBe(2);
    await expect(main(["prune", "--dir", root, "--unknown"])).resolves.toBe(2);
  });
});

describe("native cache prune", () => {
  it("removes entries untouched since the marker and keeps reused or new ones", () => {
    const old = new Date(Date.now() - 60_000);
    const stale = entry(root, "computer-use", "stale", old);
    const reused = entry(root, "computer-use", "reused", old);
    const abandoned = entry(root, "cua", "only", old);
    entry(root, "resource-monitor-x86_64-apple-darwin", ".build-crashed", old);
    writeRestoreMarker(root, new Date(Date.now() - 30_000));
    utimesSync(reused, new Date(), new Date());
    const built = entry(root, "security", "new");

    expect(pruneNativeCache(root).toSorted()).toEqual([
      "computer-use/stale",
      "cua/only",
      "resource-monitor-x86_64-apple-darwin/.build-crashed",
    ]);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(reused)).toBe(true);
    expect(existsSync(built)).toBe(true);
    // Empty groups and the marker do not end up in the uploaded artifact.
    expect(existsSync(abandoned)).toBe(false);
    expect(readdirSync(root).toSorted()).toEqual(["computer-use", "security"]);
  });

  it("keeps an entry touched in the marker's own millisecond", () => {
    const markedAt = new Date();
    writeRestoreMarker(root, markedAt);
    const touched = entry(root, "cua", "same-tick", markedAt);
    expect(pruneNativeCache(root)).toEqual([]);
    expect(existsSync(touched)).toBe(true);
  });

  it("warns and leaves the cache alone without a restore marker", async () => {
    const output = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const kept = entry(root, "cua", "kept", new Date(0));
    await expect(main(["prune", "--dir", root])).resolves.toBe(0);
    expect(output.mock.calls.join("\n")).toMatch(/^::warning::No \.restore-marker/mu);
    expect(existsSync(kept)).toBe(true);
  });
});
