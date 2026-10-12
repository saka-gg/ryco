import { assert, describe, it } from "@effect/vitest";

import { parseArgs, scenarioFromArgs } from "./cli.ts";

describe("external performance CLI", () => {
  it("parses comparison refs and scenario values", () => {
    const parsed = parseArgs([
      "compare-refs",
      "--base",
      "origin/main",
      "--candidate",
      "HEAD",
      "--iterations",
      "7",
    ]);
    assert.equal(parsed.command, "compare-refs");
    assert.equal(parsed.values.get("base"), "origin/main");
    assert.equal(parsed.values.get("candidate"), "HEAD");
    assert.equal(parsed.values.get("iterations"), "7");
  });

  it("rejects unknown commands and missing option values", () => {
    assert.throws(() => parseArgs(["unknown"]), /Unknown command/u);
    assert.throws(() => parseArgs(["run", "--iterations"]), /requires a value/u);
    assert.throws(() => parseArgs(["run", "--mystery", "value"]), /Unknown option/u);
  });

  it("parses the active source-control profile and its bounded windows", () => {
    const parsed = parseArgs([
      "run",
      "--profile",
      "active-source-control",
      "--source-control-active-ms",
      "31000",
      "--source-control-status-rows",
      "8",
    ]);
    const scenario = scenarioFromArgs(parsed);

    assert.equal(scenario.profile, "active-source-control");
    assert.equal(scenario.sourceControlActiveMs, 31_000);
    assert.equal(scenario.sourceControlStatusRows, 8);
  });

  it("parses the bundle budget command and its dist directory", () => {
    const parsed = parseArgs(["bundle-budget", "--dist", "apps/web/dist"]);
    assert.equal(parsed.command, "bundle-budget");
    assert.equal(parsed.values.get("dist"), "apps/web/dist");
  });

  it("profiles boot CPU only when a profile directory is given", () => {
    assert.equal(scenarioFromArgs(parseArgs(["run"])).cpuProfileDir, null);
    const scenario = scenarioFromArgs(parseArgs(["smoke", "--cpu-profile", "out/profiles"]));
    assert.match(scenario.cpuProfileDir ?? "", /out[\\/]profiles$/u);
  });

  it("rejects unknown profiles", () => {
    assert.throws(
      () => scenarioFromArgs(parseArgs(["run", "--profile", "mystery"])),
      /--profile must be/u,
    );
  });
});
