import { resolve } from "node:path";

import { assert, describe, it } from "@effect/vitest";

import {
  parseSmokeOptions,
  selectSmokeSimulator,
  type SimctlDevice,
} from "./device-helper-smoke-options.ts";

const RUNTIME = "com.apple.CoreSimulator.SimRuntime.iOS-27-0";

const device = (udid: string, state: string, name = "iPhone 17"): SimctlDevice => ({
  udid,
  name,
  state,
  runtime: RUNTIME,
});

describe("parseSmokeOptions", () => {
  it("defaults to the developer flow with the user cache", () => {
    const parsed = parseSmokeOptions([]);
    assert.deepStrictEqual(parsed, {
      ok: true,
      value: { probeOnly: false, cacheRoot: undefined, udid: undefined, allowBooted: false },
    });
  });

  it("reads --probe-only, --cache-dir, --udid and --allow-booted", () => {
    const parsed = parseSmokeOptions([
      "--probe-only",
      "--cache-dir",
      "/tmp/helper-cache",
      "--udid",
      "UDID-1",
      "--allow-booted",
    ]);
    assert.deepStrictEqual(parsed, {
      ok: true,
      value: {
        probeOnly: true,
        cacheRoot: "/tmp/helper-cache",
        udid: "UDID-1",
        allowBooted: true,
      },
    });
  });

  it("resolves a relative --cache-dir against the working directory", () => {
    const parsed = parseSmokeOptions(["--cache-dir", "helper-cache"]);
    assert.isTrue(parsed.ok);
    if (parsed.ok) assert.strictEqual(parsed.value.cacheRoot, resolve("helper-cache"));
  });

  it("rejects a flag whose value is missing or another flag", () => {
    assert.deepStrictEqual(parseSmokeOptions(["--cache-dir"]), {
      ok: false,
      error: "--cache-dir needs a value",
    });
    assert.deepStrictEqual(parseSmokeOptions(["--udid", "--allow-booted"]), {
      ok: false,
      error: "--udid needs a value",
    });
  });

  it("accepts --flag=value as well as --flag value", () => {
    const parsed = parseSmokeOptions(["--udid=UDID-1", "--cache-dir=/tmp/helper-cache"]);
    assert.deepStrictEqual(parsed, {
      ok: true,
      value: {
        probeOnly: false,
        cacheRoot: "/tmp/helper-cache",
        udid: "UDID-1",
        allowBooted: false,
      },
    });
    assert.deepStrictEqual(parseSmokeOptions(["--udid="]), {
      ok: false,
      error: "--udid needs a value",
    });
  });

  it("fails on an argument it does not understand instead of ignoring it", () => {
    // Ignoring a typo would fall back to the developer default, which drives
    // whatever simulator is already booted.
    for (const argv of [["--uuid", "UDID-1"], ["UDID-1"], ["--probe"], ["--probe-only=yes"]]) {
      const parsed = parseSmokeOptions(argv);
      assert.isFalse(parsed.ok, argv.join(" "));
    }
    assert.deepStrictEqual(parseSmokeOptions(["--uuid", "UDID-1"]), {
      ok: false,
      error:
        "unknown argument '--uuid' (expected --probe-only, --cache-dir <dir>, --udid <udid>, --allow-booted)",
    });
    assert.deepStrictEqual(parseSmokeOptions(["--probe-only=yes"]), {
      ok: false,
      error: "--probe-only takes no value",
    });
  });

  it("rejects a value flag given twice", () => {
    assert.deepStrictEqual(parseSmokeOptions(["--udid", "A", "--udid=B"]), {
      ok: false,
      error: "--udid was given more than once",
    });
  });

  it("rejects --allow-booted without --udid", () => {
    // Reusing "whatever is booted" is the developer default already; the flag
    // only loosens the agent-safe --udid path.
    assert.deepStrictEqual(parseSmokeOptions(["--allow-booted"]), {
      ok: false,
      error: "--allow-booted only applies together with --udid",
    });
  });
});

describe("selectSmokeSimulator with --udid", () => {
  const devices = [
    device("BOOTED", "Booted"),
    device("SHUTDOWN", "Shutdown"),
    device("BOOTING", "Booting"),
  ];

  it("boots exactly the requested shut-down simulator", () => {
    const selected = selectSmokeSimulator(devices, { udid: "SHUTDOWN", allowBooted: false });
    assert.isTrue(selected.ok);
    if (selected.ok) {
      assert.strictEqual(selected.value.device.udid, "SHUTDOWN");
      assert.isFalse(selected.value.wasBooted);
    }
  });

  it("refuses a booted simulator it did not boot", () => {
    const selected = selectSmokeSimulator(devices, { udid: "BOOTED", allowBooted: false });
    assert.isFalse(selected.ok);
    if (!selected.ok) {
      assert.include(selected.error, "refusing to drive a simulator this run did not boot");
    }
  });

  it("reuses a booted simulator only with --allow-booted, and never owns it", () => {
    const selected = selectSmokeSimulator(devices, { udid: "BOOTED", allowBooted: true });
    assert.isTrue(selected.ok);
    if (selected.ok) {
      assert.strictEqual(selected.value.device.udid, "BOOTED");
      // wasBooted keeps the smoke from shutting it down afterwards.
      assert.isTrue(selected.value.wasBooted);
    }
  });

  it("refuses a simulator that is mid-boot or mid-shutdown, even with --allow-booted", () => {
    const selected = selectSmokeSimulator(devices, { udid: "BOOTING", allowBooted: true });
    assert.deepStrictEqual(selected, {
      ok: false,
      error: "simulator BOOTING is Booting; refusing to drive a simulator this run did not boot",
    });
  });

  it("fails rather than falling back when the udid is unknown", () => {
    const selected = selectSmokeSimulator(devices, { udid: "MISSING", allowBooted: false });
    assert.deepStrictEqual(selected, {
      ok: false,
      error: "no available iOS simulator with udid MISSING",
    });
  });
});

describe("selectSmokeSimulator without --udid", () => {
  it("keeps the developer default of reusing a booted simulator", () => {
    const selected = selectSmokeSimulator(
      [device("SHUTDOWN", "Shutdown", "iPhone 17 Pro"), device("BOOTED", "Booted", "iPad")],
      { udid: undefined, allowBooted: false },
    );
    assert.isTrue(selected.ok);
    if (selected.ok) {
      assert.strictEqual(selected.value.device.udid, "BOOTED");
      assert.isTrue(selected.value.wasBooted);
    }
  });

  it("otherwise boots the first preferred model", () => {
    const selected = selectSmokeSimulator(
      [device("IPAD", "Shutdown", "iPad Air"), device("PRO", "Shutdown", "iPhone 17 Pro Max")],
      { udid: undefined, allowBooted: false },
    );
    assert.isTrue(selected.ok);
    if (selected.ok) {
      assert.strictEqual(selected.value.device.udid, "PRO");
      assert.isFalse(selected.value.wasBooted);
    }
  });

  it("reports when no iOS simulator is available", () => {
    const selected = selectSmokeSimulator([], { udid: undefined, allowBooted: false });
    assert.isFalse(selected.ok);
  });
});
