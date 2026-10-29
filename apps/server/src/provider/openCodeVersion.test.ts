import { assert, describe, it } from "@effect/vitest";

import {
  classifyOpenCodeGeneration,
  describeUnsupportedOpenCodeVersion,
  MINIMUM_OPENCODE_V2_VERSION,
  MINIMUM_OPENCODE_VERSION,
  normalizeOpenCodeVersion,
  OPENCODE_NON_JSON_HEALTH_MESSAGE,
  OPENCODE_UNKNOWN_CLI_VERSION_MESSAGE,
  OPENCODE_V2_ADVISORY_MESSAGE,
  OPENCODE_V2_RUNTIME_SUPPORTED,
  openCodeVersionFloor,
} from "./openCodeVersion.ts";

// Every keyword `formatOpenCodeProbeError` (Layers/OpenCodeProvider.ts) rewrites into a canned
// auth / network / install message. A version message containing one would be replaced.
const PROBE_ERROR_KEYWORDS = [
  "401",
  "403",
  "unauthorized",
  "forbidden",
  "econnrefused",
  "enotfound",
  "fetch failed",
  "networkerror",
  "timed out",
  "timeout",
  "socket hang up",
  "enoent",
  "notfound",
  "quarantine",
  "corrupted",
];

describe("normalizeOpenCodeVersion", () => {
  it("trims and strips one leading v", () => {
    assert.strictEqual(normalizeOpenCodeVersion(" v2.0.18 "), "2.0.18");
    assert.strictEqual(normalizeOpenCodeVersion("V1.18.34"), "1.18.34");
    assert.strictEqual(normalizeOpenCodeVersion("1.18.34"), "1.18.34");
  });
});

describe("classifyOpenCodeGeneration", () => {
  it("maps majors 1 and 2 and nothing else", () => {
    assert.strictEqual(classifyOpenCodeGeneration("1.18.34"), "v1");
    assert.strictEqual(classifyOpenCodeGeneration("v2.0.18"), "v2");
    assert.isNull(classifyOpenCodeGeneration("3.0.0"));
    assert.isNull(classifyOpenCodeGeneration("0.9.0"));
    assert.isNull(classifyOpenCodeGeneration("garbage"));
    assert.isNull(classifyOpenCodeGeneration(null));
    assert.isNull(classifyOpenCodeGeneration(undefined));
  });
});

describe("OpenCode 2 gate", () => {
  it("is on, with the pinned client's version as the minimum", () => {
    assert.isTrue(OPENCODE_V2_RUNTIME_SUPPORTED);
    assert.strictEqual(MINIMUM_OPENCODE_V2_VERSION, "2.2.0");
  });
});

describe("openCodeVersionFloor", () => {
  it("floors every parseable major of 2 or more while 2.x is off", () => {
    assert.strictEqual(openCodeVersionFloor("v2.0.0", false), OPENCODE_V2_ADVISORY_MESSAGE);
    assert.strictEqual(openCodeVersionFloor(" 2.0.0-beta.1 ", false), OPENCODE_V2_ADVISORY_MESSAGE);
    assert.strictEqual(openCodeVersionFloor("2.9.0", false), OPENCODE_V2_ADVISORY_MESSAGE);
    assert.strictEqual(
      openCodeVersionFloor("3.1.0", false),
      "OpenCode v3.1.0 is not supported by this Ryco release.",
    );
  });

  it("floors 2.x below the minimum and 3.x and later in this build", () => {
    assert.isUndefined(openCodeVersionFloor(MINIMUM_OPENCODE_V2_VERSION));
    assert.isUndefined(openCodeVersionFloor("v2.4.0"));
    assert.strictEqual(
      openCodeVersionFloor(" 2.0.0-beta.1 "),
      "OpenCode v2.0.0-beta.1 is too old. Upgrade OpenCode 2 to v2.2.0 or newer.",
    );
    assert.strictEqual(
      openCodeVersionFloor("3.1.0"),
      "OpenCode v3.1.0 is not supported by this Ryco release.",
    );
  });

  it("leaves 1.x and unparseable versions to the manifest", () => {
    assert.isUndefined(openCodeVersionFloor("1.99.99"));
    assert.isUndefined(openCodeVersionFloor("1.0.0"));
    assert.isUndefined(openCodeVersionFloor("garbage"));
    assert.isUndefined(openCodeVersionFloor("1.99.99", true));
  });

  it("floors only 2.x below the minimum and 3.x once 2.x is on", () => {
    assert.isUndefined(openCodeVersionFloor(MINIMUM_OPENCODE_V2_VERSION, true));
    assert.isUndefined(openCodeVersionFloor("v2.9.1", true));
    assert.include(openCodeVersionFloor("2.1.4", true), "too old");
    assert.include(openCodeVersionFloor("3.0.0", true), "not supported by this Ryco release");
  });
});

describe("describeUnsupportedOpenCodeVersion", () => {
  it("explains a 2.x binary and names the 1.x packages while 2.x is off", () => {
    const message = describeUnsupportedOpenCodeVersion("2.0.18", "binary", false);
    assert.isNotNull(message);
    assert.include(message, "not supported yet");
    assert.include(message, "1.x");
    assert.include(message, "opencode-ai");
    assert.include(message, OPENCODE_V2_ADVISORY_MESSAGE);
  });

  it("explains a 2.x server with the normalised version while 2.x is off", () => {
    assert.include(
      describeUnsupportedOpenCodeVersion("v2.0.18", "server", false),
      "reports v2.0.18",
    );
  });

  it("runs 2.x from the minimum in this build and names the upgrade below it", () => {
    assert.isNull(describeUnsupportedOpenCodeVersion("2.2.0", "binary"));
    assert.isNull(describeUnsupportedOpenCodeVersion("v2.9.1", "server"));
    assert.strictEqual(
      describeUnsupportedOpenCodeVersion("2.0.18", "binary"),
      "OpenCode v2.0.18 is too old. Upgrade OpenCode 2 to v2.2.0 or newer.",
    );
  });

  it("fails closed for unparseable versions", () => {
    assert.strictEqual(
      describeUnsupportedOpenCodeVersion("garbage", "server"),
      'The OpenCode server reported an unrecognized version "garbage". Ryco requires OpenCode v1.14.19 or newer.',
    );
    assert.strictEqual(
      describeUnsupportedOpenCodeVersion("garbage", "binary"),
      OPENCODE_UNKNOWN_CLI_VERSION_MESSAGE,
    );
  });

  it("keeps the too-old message for both sources", () => {
    assert.include(describeUnsupportedOpenCodeVersion("1.14.18", "binary"), "too old");
    assert.include(describeUnsupportedOpenCodeVersion("1.14.18", "server"), "too old");
  });

  it("refuses major 3 and later for both sources and both gate states", () => {
    for (const v2Supported of [false, true]) {
      assert.strictEqual(
        describeUnsupportedOpenCodeVersion("v3.0.0", "server", v2Supported),
        "OpenCode v3.0.0 is not supported by this Ryco release.",
      );
      assert.strictEqual(
        describeUnsupportedOpenCodeVersion("12.4.1", "binary", v2Supported),
        "OpenCode v12.4.1 is not supported by this Ryco release.",
      );
    }
  });

  it("keeps the 1.x minimum for 0.x", () => {
    assert.include(describeUnsupportedOpenCodeVersion("0.15.8", "binary"), "too old");
    assert.include(describeUnsupportedOpenCodeVersion("0.15.8", "server", true), "too old");
  });

  it("refuses every 2.x while the gate is off", () => {
    for (const version of ["2.0.0", MINIMUM_OPENCODE_V2_VERSION, "2.9.0"]) {
      assert.include(describeUnsupportedOpenCodeVersion(version, "server", false), "2.x support");
      assert.include(describeUnsupportedOpenCodeVersion(version, "binary", false), "2.x support");
    }
  });

  it("accepts 2.x from the minimum once the gate is on and names the upgrade below it", () => {
    assert.isNull(describeUnsupportedOpenCodeVersion(MINIMUM_OPENCODE_V2_VERSION, "server", true));
    assert.isNull(describeUnsupportedOpenCodeVersion("v2.3.0-beta.1", "binary", true));
    assert.strictEqual(
      describeUnsupportedOpenCodeVersion("2.1.4", "server", true),
      "OpenCode v2.1.4 is too old. Upgrade OpenCode 2 to v2.2.0 or newer.",
    );
    assert.strictEqual(
      describeUnsupportedOpenCodeVersion("v2.1.4", "binary", true),
      "OpenCode v2.1.4 is too old. Upgrade OpenCode 2 to v2.2.0 or newer.",
    );
    // 1.x keeps its own minimum in both gate states.
    assert.isNull(describeUnsupportedOpenCodeVersion("1.18.34", "binary", true));
    assert.include(describeUnsupportedOpenCodeVersion("1.14.18", "server", true), "too old");
  });

  it("accepts supported 1.x versions", () => {
    assert.isNull(describeUnsupportedOpenCodeVersion("1.18.34", "binary"));
    assert.isNull(describeUnsupportedOpenCodeVersion("1.18.34", "server"));
    assert.isNull(describeUnsupportedOpenCodeVersion(MINIMUM_OPENCODE_VERSION, "server"));
    assert.isNull(describeUnsupportedOpenCodeVersion("v1.19.0-beta.1", "binary"));
  });

  it("never uses a keyword the probe error formatter rewrites", () => {
    const messages = [
      describeUnsupportedOpenCodeVersion("2.0.18", "binary", false),
      describeUnsupportedOpenCodeVersion("2.0.18", "server", false),
      describeUnsupportedOpenCodeVersion("2.1.4", "binary"),
      describeUnsupportedOpenCodeVersion("2.1.4", "server"),
      describeUnsupportedOpenCodeVersion("3.0.0", "server"),
      openCodeVersionFloor("2.0.18", false) ?? null,
      openCodeVersionFloor("2.0.18") ?? null,
      describeUnsupportedOpenCodeVersion("garbage", "server"),
      describeUnsupportedOpenCodeVersion("garbage", "binary"),
      describeUnsupportedOpenCodeVersion("1.14.18", "binary"),
      describeUnsupportedOpenCodeVersion("1.14.18", "server"),
      OPENCODE_UNKNOWN_CLI_VERSION_MESSAGE,
      OPENCODE_NON_JSON_HEALTH_MESSAGE,
      OPENCODE_V2_ADVISORY_MESSAGE,
    ];
    for (const message of messages) {
      assert.isNotNull(message);
      const lower = message!.toLowerCase();
      for (const keyword of PROBE_ERROR_KEYWORDS) {
        assert.notInclude(lower, keyword, `"${message}" contains "${keyword}"`);
      }
    }
  });
});
