// Adapted from pingdotgg/t3code (`scripts/lib/third-party-licenses.test.ts`, MIT).
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  collectThirdPartyPackages,
  findUnlistedBundledPackages,
  generateThirdPartyLicenseManifest,
} from "./third-party-licenses.ts";

const tempDirectories: string[] = [];

async function writeJson(path: string, value: unknown): Promise<void> {
  await NodeFSP.mkdir(NodePath.dirname(path), { recursive: true });
  await NodeFSP.writeFile(path, `${JSON.stringify(value)}\n`, "utf8");
}

interface Fixture {
  readonly appManifest: string;
  readonly configFile: string;
  readonly dependencyRoot: string;
  readonly root: string;
}

async function writePackage(
  fixture: Fixture,
  name: string,
  packageJson: Record<string, unknown> = {},
  license: string | null = `${name} license text`,
): Promise<string> {
  const packageRoot = NodePath.join(fixture.root, "node_modules", name);
  await writeJson(NodePath.join(packageRoot, "package.json"), {
    name,
    version: "1.0.0",
    license: "MIT",
    main: "index.js",
    ...packageJson,
  });
  await NodeFSP.writeFile(NodePath.join(packageRoot, "index.js"), "export {};\n", "utf8");
  if (license !== null) {
    await NodeFSP.writeFile(NodePath.join(packageRoot, "LICENSE"), `${license}\n`, "utf8");
  }
  return packageRoot;
}

async function createFixture(): Promise<Fixture> {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "ryco-licenses-"));
  tempDirectories.push(root);
  const fixture: Fixture = {
    appManifest: NodePath.join(root, "package.json"),
    configFile: NodePath.join(root, "third-party-licenses.config.json"),
    dependencyRoot: NodePath.join(root, "node_modules", "demo-dependency"),
    root,
  };
  await writeJson(fixture.appManifest, {
    name: "fixture-app",
    dependencies: { "demo-dependency": "1.2.3" },
  });
  await writePackage(
    fixture,
    "demo-dependency",
    { version: "1.2.3", repository: "example/demo-dependency" },
    "Demo MIT license text",
  );
  await NodeFSP.writeFile(NodePath.join(root, "asset-notice.txt"), "Asset notice text\n", "utf8");
  await writeJson(fixture.configFile, {
    customNotices: [
      {
        name: "demo-asset",
        license: "CC-BY-4.0",
        noticeFile: "asset-notice.txt",
        bundles: ["assets", "mobile"],
      },
    ],
  });
  return fixture;
}

function generate(fixture: Fixture, extra: { readonly customNoticeBundles?: string[] } = {}) {
  return generateThirdPartyLicenseManifest({
    configFile: fixture.configFile,
    packageManifests: [{ bundle: "mobile", path: fixture.appManifest }],
    ...extra,
  });
}

afterEach(async () => {
  await Promise.all(
    tempDirectories
      .splice(0)
      .map((directory) => NodeFSP.rm(directory, { force: true, recursive: true })),
  );
});

describe("third-party license generation", () => {
  it("collects production packages and custom notices", async () => {
    const fixture = await createFixture();

    expect(await generate(fixture)).toEqual({
      schemaVersion: 1,
      entries: [
        {
          bundles: ["assets", "mobile"],
          kind: "custom",
          license: "CC-BY-4.0",
          name: "demo-asset",
          noticeText: "Asset notice text",
          sourceUrl: null,
          version: null,
        },
        {
          bundles: ["mobile"],
          kind: "package",
          license: "MIT",
          name: "demo-dependency",
          noticeText: "Demo MIT license text",
          sourceUrl: "https://github.com/example/demo-dependency",
          version: "1.2.3",
        },
      ],
    });
  });

  it("renders generated notices from the committed SPDX templates", async () => {
    const fixture = await createFixture();
    await writeJson(NodePath.join(fixture.root, "third-party-licenses/spdx/v3.28.0/MIT.json"), {
      licenseId: "MIT",
      licenseText: "MIT License\n\nCopyright (c) <year> <copyright holders>\n\nPermission text",
    });
    await writeJson(fixture.configFile, {
      customNotices: [
        {
          name: "generated-asset",
          license: "MIT",
          generatedNotices: [
            {
              licenseId: "MIT",
              copyrights: ["Copyright (c) 2026 Example Author"],
              preamble: ["Adapted for Ryco."],
            },
          ],
          bundles: ["ios"],
        },
      ],
    });

    const manifest = await generate(fixture, { customNoticeBundles: ["ios", "mobile"] });

    expect(manifest.entries.find((entry) => entry.name === "generated-asset")?.noticeText).toBe(
      "Adapted for Ryco.\n\nMIT License\n\nCopyright (c) 2026 Example Author\n\nPermission text",
    );
  });

  it("fails when a generated notice's SPDX template is not committed", async () => {
    const fixture = await createFixture();
    await writeJson(fixture.configFile, {
      customNotices: [
        {
          name: "generated-asset",
          license: "MIT",
          generatedNotices: [{ licenseId: "MIT" }],
          bundles: ["mobile"],
        },
      ],
    });

    await expect(generate(fixture)).rejects.toThrow("SPDX license template MIT is missing");
  });

  it("omits custom notices for bundles the manifest does not show", async () => {
    const fixture = await createFixture();
    await writeJson(fixture.configFile, {
      customNotices: [
        { name: "web-only", license: "MIT", noticeFile: "asset-notice.txt", bundles: ["web"] },
        {
          name: "android-lib",
          license: "MIT",
          noticeFile: "asset-notice.txt",
          bundles: ["android"],
        },
      ],
    });

    const names = (await generate(fixture, { customNoticeBundles: ["android", "mobile"] })).entries
      .filter((entry) => entry.kind === "custom")
      .map((entry) => entry.name);

    expect(names).toEqual(["android-lib"]);
  });

  it("leaves Ryco's own packages and type-only packages out but walks their dependencies", async () => {
    const fixture = await createFixture();
    await writeJson(fixture.appManifest, {
      name: "fixture-app",
      dependencies: { "@ryco/shared": "workspace:*", "@types/demo": "1.0.0" },
    });
    await writePackage(fixture, "@ryco/shared", { dependencies: { "demo-dependency": "1.2.3" } });
    const typesRoot = await writePackage(fixture, "@types/demo", {
      main: "",
      types: "index.d.ts",
      dependencies: { "demo-runtime": "1.0.0" },
    });
    await NodeFSP.rm(NodePath.join(typesRoot, "index.js"));
    await writePackage(fixture, "demo-runtime");

    const names = (await generate(fixture)).entries.map((entry) => entry.name);

    expect(names).toEqual(["demo-asset", "demo-dependency", "demo-runtime"]);
  });

  it("lists the dev dependencies a build inlines, with their own dependencies", async () => {
    const fixture = await createFixture();
    await writeJson(fixture.appManifest, {
      name: "fixture-app",
      dependencies: {},
      devDependencies: { "inlined-renderer": "1.0.0", "test-tool": "1.0.0" },
    });
    await writePackage(fixture, "inlined-renderer", {
      dependencies: { "demo-dependency": "1.2.3" },
    });
    await writePackage(fixture, "test-tool");
    await writeJson(fixture.configFile, {
      bundledDevDependencies: [
        {
          bundle: "mobile",
          packageManifest: "package.json",
          names: ["inlined-renderer"],
          reason: "Inlined into a WebView document.",
        },
      ],
    });

    const names = (await generate(fixture)).entries.map((entry) => entry.name);

    expect(names).toEqual(["demo-dependency", "inlined-renderer"]);
  });

  it("skips build-only dependencies and everything only they reach", async () => {
    const fixture = await createFixture();
    await writeJson(fixture.appManifest, {
      name: "fixture-app",
      dependencies: { framework: "1.0.0" },
    });
    await writePackage(fixture, "framework", {
      dependencies: { cli: "1.0.0", "@tooling/babel": "1.0.0", "demo-dependency": "1.2.3" },
    });
    await writePackage(fixture, "cli", { dependencies: { "cli-only": "1.0.0" } });
    await writePackage(fixture, "cli-only");
    await writePackage(fixture, "@tooling/babel", { license: "GPL-3.0" });
    await writeJson(fixture.configFile, {
      buildOnlyDependencies: [
        { from: "framework", names: ["@tooling/*"], reason: "Babel plugins." },
        { from: "cli", names: ["*"], reason: "Its dependencies run in the terminal only." },
      ],
    });

    const names = (await generate(fixture)).entries.map((entry) => entry.name);

    expect(names).toEqual(["cli", "demo-dependency", "framework"]);
  });

  it("fails when a declared dependency is not installed", async () => {
    const fixture = await createFixture();
    await writeJson(fixture.appManifest, {
      name: "fixture-app",
      dependencies: { "not-installed": "1.0.0" },
    });

    await expect(generate(fixture)).rejects.toThrow("not-installed");
  });

  it("finds packages whose exports hide both their manifest and entry point", async () => {
    const fixture = await createFixture();
    await writeJson(NodePath.join(fixture.dependencyRoot, "package.json"), {
      name: "demo-dependency",
      version: "1.2.3",
      license: "MIT",
      exports: {},
      repository: "example/demo-dependency",
    });

    const manifest = await generate(fixture);

    expect(manifest.entries.some((entry) => entry.name === "demo-dependency")).toBe(true);
  });

  it("fails when a shipped package has no license or notice text", async () => {
    const fixture = await createFixture();
    await NodeFSP.rm(NodePath.join(fixture.dependencyRoot, "LICENSE"));

    await expect(generate(fixture)).rejects.toThrow("does not include a license or notice file");
  });

  it("fails when a shipped package declares no distributable license", async () => {
    const fixture = await createFixture();
    await writePackage(fixture, "demo-dependency", { version: "1.2.3", license: "UNLICENSED" });

    await expect(generate(fixture)).rejects.toThrow("does not declare a distributable license");
  });

  it.each([
    ["GPL-3.0-only", "copyleft"],
    ["LGPL-2.1-or-later", "copyleft"],
    ["AGPL-3.0", "copyleft"],
    ["CC-BY-SA-4.0", "copyleft"],
    ["SEE LICENSE IN LICENSE.md", "not a recognized license"],
  ])("fails on a shipped package licensed %s", async (license, message) => {
    const fixture = await createFixture();
    await writePackage(fixture, "demo-dependency", { version: "1.2.3", license });

    await expect(generate(fixture)).rejects.toThrow(message);
  });

  it("admits a weak copyleft package only through a reviewed entry", async () => {
    const fixture = await createFixture();
    await writePackage(fixture, "demo-dependency", { version: "1.2.3", license: "MPL-2.0" });

    await expect(generate(fixture)).rejects.toThrow("reviewedLicenses");

    await writeJson(fixture.configFile, {
      reviewedLicenses: [
        { name: "demo-dependency", license: "MPL-2.0", reason: "Unmodified, file-level copyleft." },
      ],
    });
    const manifest = await generate(fixture);
    expect(manifest.entries.find((entry) => entry.name === "demo-dependency")?.license).toBe(
      "MPL-2.0",
    );
  });

  it("fails on a custom notice with a copyleft license", async () => {
    const fixture = await createFixture();
    await writeJson(fixture.configFile, {
      customNotices: [{ name: "gpl-lib", license: "GPL-2.0-only", noticeFile: "asset-notice.txt" }],
    });

    await expect(generate(fixture)).rejects.toThrow("copyleft");
  });

  it("shows a non-SPDX license spelling as its SPDX id", async () => {
    const fixture = await createFixture();
    await writePackage(fixture, "demo-dependency", { version: "1.2.3", license: "apache-2.0" });

    const manifest = await generate(fixture);

    expect(manifest.entries.find((entry) => entry.name === "demo-dependency")?.license).toBe(
      "Apache-2.0",
    );
  });

  it("collects nested notices even when a package also has a root license", async () => {
    const fixture = await createFixture();
    await NodeFSP.mkdir(NodePath.join(fixture.dependencyRoot, "vendor", "zlib"), {
      recursive: true,
    });
    await NodeFSP.writeFile(
      NodePath.join(fixture.dependencyRoot, "vendor", "zlib", "LICENSE"),
      "Vendored notice\n",
      "utf8",
    );

    const manifest = await generate(fixture);

    expect(manifest.entries.find((entry) => entry.name === "demo-dependency")?.noticeText).toBe(
      "LICENSE\n\nDemo MIT license text\n\n---\n\nvendor/zlib/LICENSE\n\nVendored notice",
    );
  });

  it("uses package overrides for notices published outside the npm archive", async () => {
    const fixture = await createFixture();
    await NodeFSP.rm(NodePath.join(fixture.dependencyRoot, "LICENSE"));
    await NodeFSP.writeFile(NodePath.join(fixture.root, "override.txt"), "Override text\n", "utf8");
    await writeJson(fixture.configFile, {
      packageOverrides: [{ name: "demo-dependency", noticeFile: "override.txt" }],
    });

    const manifest = await generate(fixture);

    expect(manifest.entries[0]?.noticeText).toBe("Override text");
  });

  it("reuses a repository license for packages from the same monorepo", async () => {
    const fixture = await createFixture();
    await writeJson(fixture.appManifest, {
      name: "fixture-app",
      dependencies: { "demo-dependency": "1.2.3", "demo-sibling": "2.0.0" },
    });
    await writePackage(
      fixture,
      "demo-sibling",
      { version: "2.0.0", repository: "https://github.com/example/demo-dependency.git#main" },
      null,
    );

    const manifest = await generate(fixture);

    expect(manifest.entries.find((entry) => entry.name === "demo-sibling")?.noticeText).toBe(
      "Demo MIT license text",
    );
  });

  it("drops source links that are not web addresses", async () => {
    const fixture = await createFixture();
    await writePackage(
      fixture,
      "demo-dependency",
      { version: "1.2.3", homepage: "javascript:alert(1)", repository: "file:../somewhere" },
      "Demo MIT license text",
    );

    const manifest = await generate(fixture);

    expect(manifest.entries.find((entry) => entry.name === "demo-dependency")?.sourceUrl).toBe(
      null,
    );
  });

  it("collects the same packages it lists", async () => {
    const fixture = await createFixture();

    const packages = await collectThirdPartyPackages({
      configFile: fixture.configFile,
      packageManifests: [{ bundle: "mobile", path: fixture.appManifest }],
    });

    expect([...packages.keys()]).toEqual(["demo-dependency@1.2.3"]);
  });
});

describe("the bundle check", () => {
  it("names bundled npm packages the manifest does not list", async () => {
    const fixture = await createFixture();
    const unlisted = await writePackage(fixture, "unlisted", { version: "3.0.0" });
    await NodeFSP.mkdir(NodePath.join(unlisted, "lib"), { recursive: true });
    const manifest = await generate(fixture);

    expect(
      await findUnlistedBundledPackages(manifest, [
        NodePath.join(fixture.dependencyRoot, "index.js"),
        NodePath.join(unlisted, "lib", "index.js"),
        NodePath.join(unlisted, "index.js"),
        NodePath.join(fixture.root, "src", "App.tsx"),
        "\0polyfill:external-require",
      ]),
    ).toEqual(["unlisted@3.0.0"]);
  });
});
