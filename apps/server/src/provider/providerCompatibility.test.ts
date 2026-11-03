import { describe, expect, it } from "vite-plus/test";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderVersionAdvisory,
} from "@ryco/contracts";

import packageJson from "../../package.json" with { type: "json" };
import { BUNDLED_MODEL_MANIFEST, type ModelManifestData } from "./ModelManifest.ts";
import {
  MINIMUM_OPENCODE_V2_VERSION,
  MINIMUM_OPENCODE_VERSION,
  openCodeVersionFloor,
} from "./openCodeVersion.ts";
import {
  applyProviderCompatibility,
  compatibilityPoliciesOf,
  ratePolicy,
  rateProviderVersion,
  selectCompatibilityPolicy,
  type ProviderCompatibilityPolicy,
} from "./providerCompatibility.ts";

const OPENCODE = ProviderDriverKind.make("opencode");
const CODEX = ProviderDriverKind.make("codex");
const RYCO_VERSION = "0.1.30";

// The realistic kill switch: a provider release that breaks this Ryco release.
const CODEX_BROKEN_RELEASE_POLICY = {
  driver: "codex",
  rycoRange: ">=0.0.0",
  ranges: [
    { range: ">=0.200.0", status: "broken", message: "Codex 0.200 breaks approvals." },
    { range: "<0.200.0", status: "supported" },
  ],
} as const;

const manifestWith = (compatibility: unknown): ModelManifestData => ({
  ...BUNDLED_MODEL_MANIFEST,
  compatibility,
});

const advisory = (
  currentVersion: string,
  latestVersion: string | null,
): ServerProviderVersionAdvisory => ({
  status: latestVersion === null ? "unknown" : "behind_latest",
  currentVersion,
  latestVersion,
  updateCommand: null,
  canUpdate: false,
  checkedAt: null,
  message: null,
});

const snapshot = (overrides: Partial<ServerProvider> = {}): ServerProvider => ({
  instanceId: ProviderInstanceId.make("codex"),
  driver: CODEX,
  enabled: true,
  installed: true,
  version: "0.199.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-10-04T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
  ...overrides,
});

describe("selectCompatibilityPolicy", () => {
  it("prefers a remote policy over the bundled one", () => {
    const manifest = manifestWith([
      {
        driver: "opencode",
        rycoRange: ">=0.0.0",
        ranges: [{ range: ">=1.0.0", status: "graceful", message: "remote" }],
      },
    ]);
    const policy = selectCompatibilityPolicy({
      manifest,
      driver: OPENCODE,
      rycoVersion: RYCO_VERSION,
    });
    expect(policy?.ranges[0]?.message).toBe("remote");
    expect(
      rateProviderVersion({
        manifest,
        driver: OPENCODE,
        version: "1.18.34",
        rycoVersion: RYCO_VERSION,
      }),
    ).toEqual({ status: "graceful", message: "remote" });
  });

  it("falls back to the bundled policy when the remote rycoRange does not match", () => {
    const manifest = manifestWith([
      {
        driver: "opencode",
        rycoRange: "<0.0.1",
        ranges: [{ range: ">=1.0.0", status: "broken" }],
      },
    ]);
    const policy = selectCompatibilityPolicy({
      manifest,
      driver: OPENCODE,
      rycoVersion: RYCO_VERSION,
    });
    expect(policy).toEqual(
      selectCompatibilityPolicy({
        manifest: BUNDLED_MODEL_MANIFEST,
        driver: OPENCODE,
        rycoVersion: RYCO_VERSION,
      }),
    );
    expect(policy?.rycoRange).toBe(">=0.1.30 <0.1.36");
  });

  it("matches a nightly Ryco version by its release triple", () => {
    expect(
      selectCompatibilityPolicy({
        manifest: BUNDLED_MODEL_MANIFEST,
        driver: OPENCODE,
        rycoVersion: "0.1.31-nightly.20261004.12",
      }),
    ).toBeDefined();
  });

  it("rates nothing for a driver with no policy and no floor", () => {
    expect(
      rateProviderVersion({
        manifest: BUNDLED_MODEL_MANIFEST,
        driver: CODEX,
        version: "0.199.0",
        rycoVersion: RYCO_VERSION,
      }),
    ).toBeUndefined();
  });
});

describe("ratePolicy", () => {
  const policy: ProviderCompatibilityPolicy = {
    driver: "codex",
    rycoRange: ">=0.0.0",
    ranges: [
      { range: ">=1.0.0", status: "graceful" },
      { range: ">=1.5.0", status: "broken", message: "never reached" },
      { range: "<1.0.0", status: "unsupported", message: "Too old for Ryco." },
    ],
  };

  it("lets the first matching range win across overlapping ranges", () => {
    expect(ratePolicy(policy, "1.6.0")).toEqual({
      status: "graceful",
      message: "This version works with limited compatibility in this Ryco release.",
    });
  });

  it("rates an unparseable or unmatched version as unknown", () => {
    expect(ratePolicy(policy, "local")).toEqual({ status: "unknown", message: null });
    expect(
      ratePolicy({ ...policy, ranges: [{ range: "=9.9.9", status: "broken" }] }, "1.0.0"),
    ).toEqual({ status: "unknown", message: null });
  });

  it("uses a range message instead of the default", () => {
    expect(ratePolicy(policy, "0.9.0")).toEqual({
      status: "unsupported",
      message: "Too old for Ryco.",
    });
  });
});

describe("hard compatibility floors", () => {
  it("cannot be lifted by a manifest policy that calls OpenCode 3.x or an old 2.x supported", () => {
    const manifest = manifestWith([
      {
        driver: "opencode",
        rycoRange: ">=0.0.0",
        ranges: [{ range: ">=2.0.0", status: "supported" }],
      },
    ]);
    expect(rateProviderVersion({ manifest, driver: OPENCODE, version: "2.0.0" })).toEqual({
      status: "unsupported",
      message: "OpenCode v2.0.0 is too old. Upgrade OpenCode 2 to v2.2.0 or newer.",
    });
    expect(rateProviderVersion({ manifest, driver: OPENCODE, version: "3.0.0" })?.status).toBe(
      "unsupported",
    );
    // A 2.x this build runs is left to the manifest, like 1.x.
    expect(
      rateProviderVersion({ manifest, driver: OPENCODE, version: MINIMUM_OPENCODE_V2_VERSION }),
    ).toEqual({ status: "supported", message: null });

    const rated = applyProviderCompatibility(
      snapshot({
        instanceId: ProviderInstanceId.make("opencode"),
        driver: OPENCODE,
        version: "2.0.0",
        versionAdvisory: advisory("2.0.0", "2.1.0"),
      }),
      manifest,
    );
    expect(rated.compatibilityAdvisory?.status).toBe("unsupported");
    expect(rated.compatibilityAdvisory?.latestVersionStatus).toBe("unsupported");
  });

  it("lets a remote policy rate a specific 1.x release", () => {
    const manifest = manifestWith([
      {
        driver: "opencode",
        rycoRange: ">=0.0.0",
        ranges: [{ range: "=1.18.32", status: "graceful", message: "m" }],
      },
    ]);
    expect(rateProviderVersion({ manifest, driver: OPENCODE, version: "1.18.32" })).toEqual({
      status: "graceful",
      message: "m",
    });
  });
});

describe("applyProviderCompatibility", () => {
  const codexManifest = manifestWith([CODEX_BROKEN_RELEASE_POLICY]);
  const stale = { status: "broken", message: "stale" } as const;

  it("skips disabled, not-installed and version-less snapshots and strips their advisory", () => {
    for (const overrides of [
      { enabled: false },
      { installed: false },
      { version: null },
    ] satisfies ReadonlyArray<Partial<ServerProvider>>) {
      const rated = applyProviderCompatibility(
        snapshot({ ...overrides, compatibilityAdvisory: stale }),
        codexManifest,
      );
      expect("compatibilityAdvisory" in rated).toBe(false);
    }
  });

  it("strips a stale advisory when no policy applies any more", () => {
    const rated = applyProviderCompatibility(
      snapshot({ compatibilityAdvisory: stale }),
      BUNDLED_MODEL_MANIFEST,
    );
    expect("compatibilityAdvisory" in rated).toBe(false);
  });

  it("sets latestVersionStatus only when a latest version is known", () => {
    const withoutLatest = applyProviderCompatibility(
      snapshot({ versionAdvisory: advisory("0.199.0", null) }),
      codexManifest,
    );
    expect(withoutLatest.compatibilityAdvisory).toEqual({ status: "supported", message: null });
  });

  it("rates the installed and the latest Codex version separately", () => {
    const rated = applyProviderCompatibility(
      snapshot({ versionAdvisory: advisory("0.199.0", "0.200.1") }),
      codexManifest,
    );
    expect(rated.compatibilityAdvisory).toEqual({
      status: "supported",
      latestVersionStatus: "broken",
      message: null,
    });
  });

  it("reports an installed broken version with its message", () => {
    const rated = applyProviderCompatibility(snapshot({ version: "0.200.1" }), codexManifest);
    expect(rated.compatibilityAdvisory).toEqual({
      status: "broken",
      message: "Codex 0.200 breaks approvals.",
    });
  });
});

describe("compatibilityPoliciesOf", () => {
  it("ignores a non-array compatibility field", () => {
    expect(compatibilityPoliciesOf(manifestWith("nope"))).toEqual([]);
    expect(compatibilityPoliciesOf(manifestWith({}))).toEqual([]);
    expect(compatibilityPoliciesOf(manifestWith(undefined))).toEqual([]);
  });

  it("drops invalid entries whole and keeps valid ones", () => {
    const valid = {
      driver: "codex",
      rycoRange: ">=0.0.0",
      ranges: [{ range: ">=1", status: "broken" }],
    };
    expect(
      compatibilityPoliciesOf(
        manifestWith([
          valid,
          { driver: 1 },
          { ...valid, rycoRange: "^1" },
          { ...valid, ranges: [{ range: ">=1", status: "broken", message: "x".repeat(301) }] },
          { ...valid, ranges: [{ range: ">=1", status: "weird" }] },
        ]),
      ),
    ).toEqual([valid]);
  });
});

describe("bundled OpenCode policy drift guard", () => {
  /**
   * The release that ships OpenCode 2 support, where the bundled manifest splits the OpenCode
   * policy. Confirm it when that release is cut and change both together: the remote manifest on
   * main rates every running release, and the ones before this keep refusing 2.x.
   */
  const FIRST_RYCO_WITH_OPENCODE_2 = "0.1.36";
  const policyFor = (rycoVersion: string) =>
    selectCompatibilityPolicy({ manifest: BUNDLED_MODEL_MANIFEST, driver: OPENCODE, rycoVersion });

  it("exists for this Ryco version", () => {
    expect(policyFor(packageJson.version)).toBeDefined();
  });

  it("lists the newest policy first, from the release that ships OpenCode 2", () => {
    const policies = compatibilityPoliciesOf(BUNDLED_MODEL_MANIFEST).filter(
      (policy) => policy.driver === OPENCODE,
    );
    expect(policies.map((policy) => policy.rycoRange)).toEqual([
      `>=${FIRST_RYCO_WITH_OPENCODE_2}`,
      `>=0.1.30 <${FIRST_RYCO_WITH_OPENCODE_2}`,
    ]);
    expect(policyFor(FIRST_RYCO_WITH_OPENCODE_2)).toBe(policies[0]);
    expect(policyFor("0.1.35")).toBe(policies[1]);
  });

  it("agrees with this build's code-owned OpenCode floor from that release on", () => {
    const policy = policyFor(FIRST_RYCO_WITH_OPENCODE_2);
    const cases = [
      [MINIMUM_OPENCODE_VERSION, "supported"],
      ["1.99.99", "supported"],
      ["2.0.0", "unsupported"],
      ["2.1.9", "unsupported"],
      [MINIMUM_OPENCODE_V2_VERSION, "supported"],
      ["2.99.0", "supported"],
      ["3.0.0", "unsupported"],
    ] as const;
    for (const [version, status] of cases) {
      expect(ratePolicy(policy!, version).status, version).toBe(status);
      expect(openCodeVersionFloor(version) !== undefined, version).toBe(status === "unsupported");
    }
  });

  it("keeps refusing every 2.x for the releases before it", () => {
    const policy = policyFor("0.1.30");
    for (const version of ["2.0.0", MINIMUM_OPENCODE_V2_VERSION, "3.0.0"]) {
      expect(ratePolicy(policy!, version), version).toEqual({
        status: "unsupported",
        message: "Ryco works with OpenCode 1.x; 2.x support is coming.",
      });
    }
    expect(ratePolicy(policy!, MINIMUM_OPENCODE_VERSION).status).toBe("supported");
  });
});
