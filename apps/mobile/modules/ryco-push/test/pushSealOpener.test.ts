// The app's `tsconfig` is the react-native one, which resolves no Node builtins;
// this test runs under Node, so it pulls the types in for itself.
/// <reference types="node" />
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { THREAD_ALERT_COPY } from "@ryco/client-runtime/state/settings";
import { describe, expect, it } from "vite-plus/test";

/**
 * The notification service extension opens what the node seals, so its Swift
 * opener must agree with `packages/shared/src/pushSeal.ts` byte for byte. On a
 * Mac this compiles the opener with `swiftc` and opens every pinned vector;
 * elsewhere (CI on Linux) that part is skipped and the iOS build covers
 * compilation.
 */
const MODULE_DIR = fileURLToPath(new URL("..", import.meta.url));
const VECTORS_PATH = fileURLToPath(
  new URL("../../../../../packages/shared/src/pushSeal.vectors.json", import.meta.url),
);
const OPENER_SOURCES = [
  join(MODULE_DIR, "extension/PushSealOpener.swift"),
  join(MODULE_DIR, "extension/PushAlertOpener.swift"),
];

interface Vector {
  readonly name: string;
  readonly recipientPublicKey: string;
  readonly associatedData: string;
  readonly plaintext: string;
  readonly environmentId: string;
  readonly enrollmentId: string;
}

interface HarnessVector {
  readonly name: string;
  readonly publicKey: string;
  readonly associatedData: string;
  readonly plaintext: string | null;
  readonly rejects: Readonly<Record<string, boolean>>;
  readonly alert: Readonly<Record<string, string>> | null;
  readonly alertRejects: Readonly<Record<string, boolean>>;
  readonly userInfo: Readonly<Record<string, unknown>>;
  readonly userInfoWhenUnopened: Readonly<Record<string, unknown>>;
  readonly opensWithStoredEnrollmentOnly: boolean;
  readonly opensWithRoutedEnrollmentOnly: boolean;
}

const vectors = (
  JSON.parse(readFileSync(VECTORS_PATH, "utf8")) as { readonly vectors: ReadonlyArray<Vector> }
).vectors;

const expectedKindTitles = Object.fromEntries(
  Object.entries(THREAD_ALERT_COPY).map(([kind, copy]) => [kind, copy.title]),
);

const swiftcAvailable =
  process.platform === "darwin" &&
  spawnSync("xcrun", ["--find", "swiftc"], { stdio: "ignore" }).status === 0;

describe("the extension's alert copy", () => {
  it("uses the words of the app's own thread alerts", () => {
    const source = readFileSync(join(MODULE_DIR, "extension/PushAlertOpener.swift"), "utf8");
    const table = /static let kindTitles: \[String: String\] = \[([^\]]*)\]/u.exec(source)?.[1];
    const entries = Object.fromEntries(
      [...(table ?? "").matchAll(/"([^"]+)":\s*"([^"]+)"/gu)].map((match) => [match[1], match[2]]),
    );
    expect(entries).toEqual(expectedKindTitles);
  });
});

describe.skipIf(!swiftcAvailable)("the extension's Swift opener", () => {
  it("opens every pinned vector and refuses tampered or misrouted ones", () => {
    const directory = mkdtempSync(join(tmpdir(), "ryco-push-opener-"));
    try {
      const binary = join(directory, "opener");
      execFileSync(
        "xcrun",
        ["swiftc", "-O", "-o", binary, ...OPENER_SOURCES, join(MODULE_DIR, "test/main.swift")],
        { stdio: "pipe" },
      );
      const output = JSON.parse(execFileSync(binary, [VECTORS_PATH], { encoding: "utf8" })) as {
        readonly vectors: ReadonlyArray<HarnessVector>;
        readonly kindTitles: Readonly<Record<string, string>>;
      };

      expect(output.kindTitles).toEqual(expectedKindTitles);
      expect(output.vectors.map((vector) => vector.name)).toEqual(
        vectors.map((vector) => vector.name),
      );
      for (const [index, vector] of vectors.entries()) {
        const opened = output.vectors[index]!;
        const plaintext = JSON.parse(vector.plaintext) as {
          readonly k: keyof typeof THREAD_ALERT_COPY;
          readonly t: string;
          readonly th: string;
        };
        expect(opened.publicKey).toBe(vector.recipientPublicKey);
        expect(opened.associatedData).toBe(vector.associatedData);
        expect(opened.plaintext).toBe(vector.plaintext);
        expect(Object.values(opened.rejects)).not.toContain(false);
        expect(Object.keys(opened.rejects)).toHaveLength(10);
        expect(opened.alert).toEqual({
          kind: plaintext.k,
          title: THREAD_ALERT_COPY[plaintext.k].title,
          body: plaintext.t,
          environmentId: vector.environmentId,
          threadId: plaintext.th,
          threadIdentifier: `${vector.environmentId}/${plaintext.th}`,
          url: `ryco-dev://threads/${vector.environmentId}/${plaintext.th}`,
        });
        expect(opened.alertRejects).toEqual({
          stale: true,
          routedToOtherEnrollment: true,
          sequenceMismatch: true,
          sequenceAsString: true,
          environmentMismatch: true,
          tampered: true,
          noEnrollment: true,
        });
        // Only the opened payload names the thread a tap opens; the Hub's own
        // `body` and `url` never reach the app, opened or not.
        expect(opened.userInfo).toEqual({
          keys: ["aps", "body", "url"],
          body: { environmentId: vector.environmentId, threadId: plaintext.th },
          url: `ryco-dev://threads/${vector.environmentId}/${plaintext.th}`,
        });
        expect(opened.userInfoWhenUnopened).toEqual({ keys: ["aps"] });
        expect(opened.opensWithStoredEnrollmentOnly).toBe(true);
        expect(opened.opensWithRoutedEnrollmentOnly).toBe(true);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 180_000);
});
