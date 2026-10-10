import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  buildCachedNativeBinary,
  fingerprint,
  nativeBuildEnvironment,
  sourceTreeFingerprint,
} from "./native-build-cache.mjs";

let root;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ryco-native-cache-test-"));
  vi.stubEnv("RYCO_NATIVE_BUILD_CACHE_DIR", join(root, "cache"));
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

function setup() {
  const build = vi.fn((binary) => writeFileSync(binary, "verified binary"));
  const validate = vi.fn((binary) => readFileSync(binary, "utf8") === "verified binary");
  const options = {
    name: "fixture",
    key: fingerprint("inputs"),
    output: join(root, "checkout/resources/helper"),
    build,
    validate,
  };
  const cache = join(root, "cache/artifacts/fixture", options.key);
  return { options, cache };
}

describe("native build cache", () => {
  it("restores a verified artifact to another worktree without building", () => {
    const { options } = setup();
    buildCachedNativeBinary(options);
    options.output = join(root, "other-checkout/resources/helper");
    buildCachedNativeBinary(options);
    expect(options.build).toHaveBeenCalledTimes(1);
    expect(readFileSync(options.output, "utf8")).toBe("verified binary");
  });

  it.each([process.platform === "win32" ? "binary.exe" : "binary", "build.json"])(
    "rebuilds a corrupted cached %s",
    (file) => {
      const { options, cache } = setup();
      buildCachedNativeBinary(options);
      writeFileSync(join(cache, file), "corrupt");
      buildCachedNativeBinary(options);
      expect(options.build).toHaveBeenCalledTimes(2);
      expect(readFileSync(options.output, "utf8")).toBe("verified binary");
    },
  );

  it("rebuilds when executable validation fails despite a matching checksum", () => {
    const { options } = setup();
    buildCachedNativeBinary(options);
    options.validate.mockReturnValueOnce(false);
    buildCachedNativeBinary(options);
    expect(options.build).toHaveBeenCalledTimes(2);
  });

  it("does not publish or replace a working output after a failed build", () => {
    const { options, cache } = setup();
    buildCachedNativeBinary(options);
    options.key = fingerprint("changed inputs");
    options.build.mockImplementation(() => {
      throw new Error("compiler failed");
    });
    expect(() => buildCachedNativeBinary(options)).toThrow("compiler failed");
    expect(readFileSync(options.output, "utf8")).toBe("verified binary");
    expect(readdirSync(join(root, "cache/artifacts/fixture"))).toEqual([basename(cache)]);
  });

  it("accepts another builder's verified publication of the same key", () => {
    const { options } = setup();
    options.build.mockImplementationOnce((binary) => {
      buildCachedNativeBinary({
        ...options,
        output: join(root, "other/resources/helper"),
        build: (other) => writeFileSync(other, "verified binary"),
      });
      writeFileSync(binary, "verified binary");
    });
    buildCachedNativeBinary(options);
    expect(readFileSync(options.output, "utf8")).toBe("verified binary");
  });

  it.runIf(process.platform === "win32")(
    "executes the staged and cached Windows binary during validation",
    () => {
      const build = vi.fn((binary) => copyFileSync(process.execPath, binary));
      const validate = (binary) => {
        const result = spawnSync(binary, ["--version"], { encoding: "utf8" });
        return result.status === 0 && result.stdout.trim() === process.version;
      };
      const options = {
        name: "executable",
        key: fingerprint("executable"),
        output: join(root, "helper.exe"),
        build,
        validate,
      };
      buildCachedNativeBinary(options);
      expect(validate(options.output)).toBe(true);
      buildCachedNativeBinary(options);
      expect(build).toHaveBeenCalledTimes(1);
    },
  );

  it("fingerprints relative source contents while excluding compiler outputs", () => {
    const first = join(root, "first");
    const second = join(root, "second");
    for (const directory of [first, second]) {
      mkdirSync(join(directory, "src"), { recursive: true });
      writeFileSync(join(directory, "src/main.rs"), "source");
    }
    mkdirSync(join(first, "target"));
    writeFileSync(join(first, "target/output"), "compiled");
    expect(sourceTreeFingerprint(first)).toBe(sourceTreeFingerprint(second));
    writeFileSync(join(second, "src/main.rs"), "changed");
    expect(sourceTreeFingerprint(first)).not.toBe(sourceTreeFingerprint(second));
  });

  it("tracks build-affecting environment variables without unrelated shell state", () => {
    const original = fingerprint(nativeBuildEnvironment());
    vi.stubEnv("RYCO_UNRELATED_SETTING", "irrelevant");
    expect(fingerprint(nativeBuildEnvironment())).toBe(original);
    vi.stubEnv("RUSTFLAGS", "-C opt-level=1");
    expect(fingerprint(nativeBuildEnvironment())).not.toBe(original);
  });
});
