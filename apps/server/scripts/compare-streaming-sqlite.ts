/** Sequential, alternating fresh-process samples. Run from the repository root.
 * node apps/server/scripts/compare-streaming-sqlite.ts [output.json]
 * Requires the base/review commits locally; no checkout or database is reused.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const refs = {
  base: "1b53113f4a91f8aefc0d42db6791940fad3b4418",
  reviewed: "da8127a58b9a2688b0abdf7e846367bda37d5489",
  fixed: "", // Current worktree, including uncommitted changes.
};
const output = process.argv[2] ?? "docs/measurements/streaming-sqlite-review.json";
const readsOnly = process.argv[3] === "reads";
const runs: unknown[] = readsOnly
  ? JSON.parse(readFileSync(output, "utf8")).runs.filter(
      (run: { profile: string }) => run.profile !== "reads",
    )
  : [];
const run = (version: keyof typeof refs, bytes: number, profile: string, sample: number) => {
  const stdout = execFileSync(
    process.execPath,
    [
      "--import",
      "./apps/server/scripts/streaming-sqlite-revision.ts",
      "apps/server/scripts/measure-streaming-sqlite.ts",
      String(bytes),
      "1",
      profile,
    ],
    {
      env: { ...process.env, RYCO_SQLITE_FIXTURE_REF: refs[version] },
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
    },
  );
  const result = JSON.parse(stdout.trim().split("\n").at(-1)!);
  runs.push({ version, sample, ...result });
  writeFileSync(
    output,
    JSON.stringify(
      {
        refs,
        methodology:
          "Sequential alternating fresh processes; no provider delays; read samples include 3 warmups and 20 checked operations per process",
        runs,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(`${version} ${profile} ${bytes} sample ${sample}`);
};
// Alternate order to reduce systematic warm-host/order bias.
for (let sample = 0; sample < (readsOnly ? 0 : 5); sample++) {
  for (const [profile, bytes] of [
    ["buffered", 4000],
    ["buffered", 50000],
    ["buffered", 200000],
    ["streaming", 50000],
    ["streaming", 200000],
    ["timer", 50000],
  ] as const) {
    for (const version of sample % 2 ? (["fixed", "base"] as const) : (["base", "fixed"] as const))
      run(version, bytes, profile, sample);
  }
}
for (let sample = 0; sample < 3; sample++) {
  for (const version of sample % 2
    ? (["fixed", "reviewed", "base"] as const)
    : (["base", "reviewed", "fixed"] as const))
    run(version, 40, "reads", sample);
}
