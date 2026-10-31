// The app's `tsconfig` is the react-native one, which resolves no Node builtins;
// this test runs under Node, so it pulls the types in for itself.
/// <reference types="node" />
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";

import { encodeWidgetTimeline } from "../../../src/widgets/widgetTimeline";

/**
 * The widget extension is Swift the app's TypeScript feeds. On a Mac this
 * typechecks every extension source against the iOS Simulator SDK, and
 * compiles the timeline reader for the Mac to read a timeline the TypeScript
 * encoded. Elsewhere (CI on Linux) it is skipped and the iOS build covers
 * compilation.
 */
const MODULE_DIR = fileURLToPath(new URL("..", import.meta.url));
const SHARED_SOURCES = [join(MODULE_DIR, "ios/WidgetGroupStore.swift")];
const EXTENSION_SOURCES = [
  ...readdirSync(join(MODULE_DIR, "extension"))
    .filter((file) => file.endsWith(".swift"))
    .map((file) => join(MODULE_DIR, "extension", file)),
  ...SHARED_SOURCES,
];
const READER_SOURCES = [join(MODULE_DIR, "extension/WidgetTimelineStore.swift"), ...SHARED_SOURCES];

const swiftcAvailable =
  process.platform === "darwin" &&
  spawnSync("xcrun", ["--sdk", "iphonesimulator", "--find", "swiftc"], { stdio: "ignore" })
    .status === 0;

function withTemporaryDirectory<T>(use: (directory: string) => T): T {
  const directory = mkdtempSync(join(tmpdir(), "ryco-widgets-"));
  try {
    return use(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe.skipIf(!swiftcAvailable)("the widget extension's Swift", () => {
  it("typechecks against the iOS Simulator SDK", () => {
    const arch = process.arch === "arm64" ? "arm64" : "x86_64";
    execFileSync(
      "xcrun",
      [
        "--sdk",
        "iphonesimulator",
        "swiftc",
        "-typecheck",
        "-target",
        `${arch}-apple-ios17.0-simulator`,
        ...EXTENSION_SOURCES,
      ],
      { stdio: "pipe" },
    );
  }, 180_000);

  it("reads the timeline the app encodes, and only from files its kinds name", () => {
    withTemporaryDirectory((directory) => {
      const binary = join(directory, "reader");
      execFileSync(
        "xcrun",
        ["swiftc", "-o", binary, ...READER_SOURCES, join(MODULE_DIR, "test/main.swift")],
        { stdio: "pipe" },
      );
      const timeline = join(directory, "timeline.json");
      writeFileSync(
        timeline,
        encodeWidgetTimeline([
          { at: 1_700_000_900_000, content: { label: "later" } },
          { at: 1_700_000_000_000, content: { label: "now" } },
        ]),
      );
      const output = JSON.parse(
        execFileSync(binary, [join(directory, "group"), timeline], { encoding: "utf8" }),
      ) as Record<string, unknown>;

      expect(output).toEqual({
        beforeWrite: [],
        written: [
          { at: 1_700_000_000_000, seconds: 1_700_000_000, label: "now" },
          { at: 1_700_000_900_000, seconds: 1_700_000_900, label: "later" },
        ],
        file: "test-kind.json",
        rejectedKinds: [true, true, true, true, true, true],
        otherVersion: [],
        notJson: [],
        afterRemove: [],
      });
    });
  }, 180_000);
});
