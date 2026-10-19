import { assert, describe, it } from "@effect/vitest";

import {
  hostedColdLoadOptions,
  hostedCorrelateOptions,
  hostedFixtureOptions,
  hostedProbeBaseOptions,
  hostedSwitchOptions,
  parseArgs,
  scenarioFromArgs,
} from "./cli.ts";

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

  it("parses every hosted command and prints usage for --help", () => {
    for (const command of [
      "hosted-switch",
      "hosted-cold-load",
      "hosted-compare",
      "hosted-fixture",
      "hosted-correlate",
      "delay-proxy",
    ]) {
      assert.equal(parseArgs([command]).command, command);
      assert.isTrue(parseArgs([command, "--help"]).flags.has("help"));
      assert.throws(() => parseArgs([command, "--mystery", "value"]), /Unknown option/u);
    }
  });

  it("treats the hosted boolean options as flags that take no value", () => {
    const parsed = parseArgs([
      "hosted-switch",
      "--send",
      "--hub-url",
      "http://localhost:3100",
      "--interleave",
      "--candidate",
      "http://localhost:3102",
      "--cookie-file",
      "owner.json",
    ]);
    assert.isTrue(parsed.flags.has("send"));
    assert.isTrue(parsed.flags.has("interleave"));
    assert.equal(parsed.values.get("hub-url"), "http://localhost:3100");
    assert.equal(parsed.values.get("candidate"), "http://localhost:3102");
    assert.isFalse(parseArgs(["hosted-fixture", "--thread-cache"]).values.has("thread-cache"));
    assert.isTrue(parseArgs(["hosted-fixture", "--thread-cache"]).flags.has("thread-cache"));
    assert.throws(() => parseArgs(["hosted-switch", "--hub-url"]), /requires a value/u);
  });

  it("builds hosted probe options with defaults and validates the Hub arguments", () => {
    const options = hostedSwitchOptions(
      parseArgs([
        "hosted-switch",
        "--hub-url",
        "http://localhost:3100",
        "--cookie-file",
        "owner.json",
        "--cpu-profile",
        "out/cpu",
        "--dist",
        "out/dist",
        "--send",
        "--output",
        "out/results",
      ]),
    );
    assert.equal(options.iterations, 7);
    assert.equal(options.candidateHubUrl, null);
    assert.isTrue(options.send);
    assert.match(options.cookieFile, /owner\.json$/u);
    assert.match(options.cpuProfileDir ?? "", /out[\\/]cpu$/u);
    assert.match(options.distDir ?? "", /out[\\/]dist$/u);

    const coldLoad = hostedColdLoadOptions(
      parseArgs([
        "hosted-cold-load",
        "--hub-url",
        "http://localhost:3100",
        "--cookie-file",
        "owner.json",
        "--target-path",
        "/node/a/b/c",
        "--visited",
        "--iterations",
        "9",
      ]),
    );
    assert.equal(coldLoad.targetPath, "/node/a/b/c");
    assert.isTrue(coldLoad.visited);
    assert.equal(coldLoad.iterations, 9);

    assert.throws(
      () => hostedProbeBaseOptions(parseArgs(["hosted-switch", "--cookie-file", "owner.json"])),
      /--hub-url is required/u,
    );
    assert.throws(
      () =>
        hostedProbeBaseOptions(parseArgs(["hosted-switch", "--hub-url", "http://localhost:3100"])),
      /--cookie-file is required/u,
    );
  });

  it("alternates two Hubs only when both are given", () => {
    const base = ["hosted-cold-load", "--hub-url", "http://localhost:3100", "--cookie-file", "a"];
    assert.equal(
      hostedProbeBaseOptions(
        parseArgs([...base, "--interleave", "--candidate", "http://localhost:3102"]),
      ).candidateHubUrl,
      "http://localhost:3102",
    );
    assert.throws(
      () => hostedProbeBaseOptions(parseArgs([...base, "--interleave"])),
      /--interleave needs --candidate/u,
    );
    assert.throws(
      () => hostedProbeBaseOptions(parseArgs([...base, "--candidate", "http://localhost:3102"])),
      /needs --interleave/u,
    );
  });

  it("builds hosted fixture and correlation options", () => {
    const fixture = hostedFixtureOptions(
      parseArgs([
        "hosted-fixture",
        "--hub-url",
        "http://localhost:3100/some/path",
        "--base-dir",
        "out/fixture",
        "--approve-command",
        "approve --owner owner.json",
      ]),
    );
    assert.equal(fixture.hubOrigin, "http://localhost:3100");
    assert.equal(fixture.nodes, 2);
    assert.equal(fixture.portBase, 3200);
    assert.equal(fixture.approveCommand, "approve --owner owner.json");
    assert.isFalse(fixture.threadCache);

    const correlate = hostedCorrelateOptions(
      parseArgs([
        "hosted-correlate",
        "--probe",
        "p.json",
        "--node-dir",
        "a,b",
        "--hub-log",
        "h.log",
      ]),
    );
    assert.deepStrictEqual(
      correlate.nodeDirs.map((directory) => directory.split(/[\\/]/u).at(-1)),
      ["a", "b"],
    );
    assert.equal(correlate.hubEvent, "relay.connection.authenticated");
    assert.equal(correlate.hubRoute, "client");
    assert.throws(
      () => hostedCorrelateOptions(parseArgs(["hosted-correlate", "--probe", "p.json"])),
      /--node-dir/u,
    );
  });
});
