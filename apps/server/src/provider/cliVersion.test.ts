import { assert, describe, it } from "@effect/vitest";

import {
  compareCliReleases,
  compareCliVersions,
  normalizeCliVersion,
  parseCliRelease,
} from "./cliVersion.ts";

describe("cliVersion", () => {
  it("normalizes versions with a missing patch segment", () => {
    assert.strictEqual(normalizeCliVersion("2.1"), "2.1.0");
  });

  it("compares prerelease versions before stable versions", () => {
    assert.isTrue(compareCliVersions("2.1.111-beta.1", "2.1.111") < 0);
  });

  it("rejects malformed numeric segments", () => {
    assert.isTrue(compareCliVersions("1.2.3abc", "1.2.10") > 0);
  });
});

describe("parseCliRelease", () => {
  it("parses the release triple and ignores prefixes, suffixes and whitespace", () => {
    assert.deepStrictEqual(parseCliRelease("v2.0.0"), { major: 2, minor: 0, patch: 0 });
    assert.deepStrictEqual(parseCliRelease(" V1.18.34 "), { major: 1, minor: 18, patch: 34 });
    assert.deepStrictEqual(parseCliRelease("2.0.0-beta.1"), { major: 2, minor: 0, patch: 0 });
    assert.deepStrictEqual(parseCliRelease("1.2.3+build.7"), { major: 1, minor: 2, patch: 3 });
    assert.deepStrictEqual(parseCliRelease("2.1"), { major: 2, minor: 1, patch: 0 });
    assert.deepStrictEqual(parseCliRelease("2026.04.09-f2b0fcd"), {
      major: 2026,
      minor: 4,
      patch: 9,
    });
  });

  it("returns null for anything that is not a release version", () => {
    assert.isNull(parseCliRelease("dev"));
    assert.isNull(parseCliRelease("local"));
    assert.isNull(parseCliRelease(""));
    assert.isNull(parseCliRelease("1.2.3abc"));
    assert.isNull(parseCliRelease("vv1.2.3"));
  });

  it("orders releases numerically", () => {
    const compare = (left: string, right: string) =>
      compareCliReleases(parseCliRelease(left)!, parseCliRelease(right)!);
    assert.isTrue(compare("1.18.34", "2.0.0") < 0);
    assert.isTrue(compare("1.14.19", "1.14.18") > 0);
    assert.strictEqual(compare("2.0.0-beta.1", "2.0.0"), 0);
  });
});
