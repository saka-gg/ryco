import { assert, describe, it } from "@effect/vitest";

import {
  classifyOpenCodeGeneration,
  describeUnsupportedOpenCodeVersion,
  isUnsupportedOpenCodeMajor,
  MINIMUM_OPENCODE_VERSION,
  normalizeOpenCodeVersion,
  OPENCODE_NON_JSON_HEALTH_MESSAGE,
  OPENCODE_UNKNOWN_CLI_VERSION_MESSAGE,
  OPENCODE_V2_ADVISORY_MESSAGE,
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

describe("isUnsupportedOpenCodeMajor", () => {
  it("is true for any parseable major of 2 or more", () => {
    assert.isTrue(isUnsupportedOpenCodeMajor("v2.0.0"));
    assert.isTrue(isUnsupportedOpenCodeMajor(" 2.0.0-beta.1 "));
    assert.isTrue(isUnsupportedOpenCodeMajor("3.1.0"));
    assert.isFalse(isUnsupportedOpenCodeMajor("1.99.99"));
    assert.isFalse(isUnsupportedOpenCodeMajor("garbage"));
  });
});

describe("describeUnsupportedOpenCodeVersion", () => {
  it("explains a 2.x binary and names the 1.x packages", () => {
    const message = describeUnsupportedOpenCodeVersion("2.0.18", "binary");
    assert.isNotNull(message);
    assert.include(message, "not supported yet");
    assert.include(message, "1.x");
    assert.include(message, "opencode-ai");
    assert.include(message, OPENCODE_V2_ADVISORY_MESSAGE);
  });

  it("explains a 2.x server with the normalised version", () => {
    assert.include(describeUnsupportedOpenCodeVersion("v2.0.18", "server"), "reports v2.0.18");
  });

  it("fails closed for unparseable versions", () => {
    assert.include(describeUnsupportedOpenCodeVersion("garbage", "server"), "unrecognized version");
    assert.strictEqual(
      describeUnsupportedOpenCodeVersion("garbage", "binary"),
      OPENCODE_UNKNOWN_CLI_VERSION_MESSAGE,
    );
  });

  it("keeps the too-old message for both sources", () => {
    assert.include(describeUnsupportedOpenCodeVersion("1.14.18", "binary"), "too old");
    assert.include(describeUnsupportedOpenCodeVersion("1.14.18", "server"), "too old");
  });

  it("accepts supported 1.x versions", () => {
    assert.isNull(describeUnsupportedOpenCodeVersion("1.18.34", "binary"));
    assert.isNull(describeUnsupportedOpenCodeVersion("1.18.34", "server"));
    assert.isNull(describeUnsupportedOpenCodeVersion(MINIMUM_OPENCODE_VERSION, "server"));
    assert.isNull(describeUnsupportedOpenCodeVersion("v1.19.0-beta.1", "binary"));
  });

  it("never uses a keyword the probe error formatter rewrites", () => {
    const messages = [
      describeUnsupportedOpenCodeVersion("2.0.18", "binary"),
      describeUnsupportedOpenCodeVersion("2.0.18", "server"),
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
