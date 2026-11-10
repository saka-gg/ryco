// The app's `tsconfig` is the react-native one, which resolves no Node builtins;
// this test runs under Node, so it pulls the types in for itself.
/// <reference types="node" />
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { THREAD_ALERT_COPY } from "@ryco/client-runtime/state/settings";
import { PushAlertKind } from "@ryco/contracts/push";
import { pushSealAssociatedData, sealPushPayload } from "@ryco/shared/pushSeal";
import { e2eeX25519KeyPair } from "@ryco/shared/relayE2eeKeys";

import { notificationCategoryForKind } from "../../../src/notifications/notificationActionsModel";
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

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
const EXCERPT_KEY = e2eeX25519KeyPair();
const EXCERPT_AT = Date.parse("2026-11-10T12:00:00.000Z");

/** A payload sealed here, as a node seals one, with the extension's inputs beside it. */
function sealedCase(name: string, plaintext: Record<string, unknown>) {
  const environmentId = "env_excerpt000000000000";
  const enrollmentId = "enr_excerpt0000000000000000";
  const sequence = EXCERPT_AT;
  const sealed = sealPushPayload({
    recipientPublicKey: EXCERPT_KEY.publicKey,
    plaintext: new TextEncoder().encode(
      JSON.stringify({
        v: 1,
        t: "Fix the login race",
        e: environmentId,
        th: "thread-1",
        tu: "turn-1",
        q: sequence,
        at: EXCERPT_AT,
        ...plaintext,
      }),
    ),
    associatedData: pushSealAssociatedData({ environmentId, sequence, enrollmentId }),
  });
  return {
    name,
    recipientSecretKey: hex(EXCERPT_KEY.secretKey),
    environmentId,
    enrollmentId,
    sequence,
    sealed: Buffer.from(sealed).toString("base64url"),
    now: EXCERPT_AT + 60_000,
  };
}

const EXCERPT_CASES = [
  sealedCase("approval", {
    k: "approval",
    rq: "approval-1",
    x: { a: { k: "command", d: "npm run deploy -- --prod", r: "Ships it", extra: 1 } },
  }),
  sealedCase("question", {
    k: "input",
    x: {
      u: {
        rq: "question-1",
        ev: "event-1",
        qs: [
          {
            id: "target",
            h: "Target",
            q: "Where should it deploy?",
            o: ["Staging", "Prod"],
            m: true,
          },
        ],
        c: true,
      },
    },
  }),
  // An excerpt that does not match the alert's kind, or is malformed, is ignored: the alert
  // shows as it did before excerpts.
  sealedCase("mismatched", { k: "completed", x: { a: { k: "command", d: "ls" } } }),
  sealedCase("malformed", { k: "approval", rq: "a", x: { a: { k: "launch-rockets" } } }),
  sealedCase("none", { k: "approval", rq: "a" }),
  // The badge count (`b`) and the excerpt travel together or alone; either one malformed leaves
  // the other intact.
  sealedCase("excerpt-and-badge", {
    k: "approval",
    rq: "approval-2",
    x: { a: { k: "file-change", d: "src/main.ts" } },
    b: 4,
  }),
  sealedCase("excerpt-bad-badge", {
    k: "approval",
    rq: "approval-3",
    x: { a: { k: "command", d: "make" } },
    b: "3",
  }),
  sealedCase("badge-bad-excerpt", { k: "approval", rq: "approval-4", x: { a: 7 }, b: 2 }),
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
  readonly alert: Readonly<Record<string, string | null>> | null;
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

const expectedKindCategories = Object.fromEntries(
  PushAlertKind.literals.map((kind) => [kind, notificationCategoryForKind(kind)]),
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
      const casesPath = join(directory, "excerpts.json");
      writeFileSync(casesPath, JSON.stringify(EXCERPT_CASES));
      const output = JSON.parse(
        execFileSync(binary, [VECTORS_PATH, casesPath], { encoding: "utf8" }),
      ) as {
        readonly vectors: ReadonlyArray<HarnessVector>;
        readonly kindTitles: Readonly<Record<string, string>>;
        readonly kindCategories: Readonly<Record<string, string>>;
        readonly requestKindLabels: Readonly<Record<string, string>>;
        readonly excerpts: ReadonlyArray<{
          readonly name: string;
          readonly alert: Readonly<Record<string, string | number | null>> | null;
        }>;
        readonly badge: Readonly<Record<string, unknown>>;
      };

      // The approval card's words for each request kind.
      expect(output.requestKindLabels).toEqual({
        command: "Run command",
        "file-read": "Read file",
        "file-change": "Change file",
      });
      const excerpts = Object.fromEntries(output.excerpts.map((item) => [item.name, item.alert]));
      expect(excerpts.approval).toMatchObject({
        kind: "approval",
        body: "Fix the login race",
        excerptLine: "Run command: npm run deploy -- --prod",
      });
      // Only the keys a node sends reach the app.
      expect(JSON.parse(String(excerpts.approval!.excerpt!))).toEqual({
        a: { k: "command", d: "npm run deploy -- --prod", r: "Ships it" },
      });
      expect(JSON.parse(String(excerpts.approval!.record!))).toEqual({
        v: 1,
        e: "env_excerpt000000000000",
        th: "thread-1",
        tu: "turn-1",
        k: "approval",
        rq: "approval-1",
        at: EXCERPT_AT,
        x: { a: { k: "command", d: "npm run deploy -- --prod", r: "Ships it" } },
      });
      expect(excerpts.question).toMatchObject({ excerptLine: "Where should it deploy?" });
      expect(JSON.parse(String(excerpts.question!.excerpt!))).toEqual({
        u: {
          rq: "question-1",
          ev: "event-1",
          qs: [
            {
              id: "target",
              h: "Target",
              q: "Where should it deploy?",
              o: ["Staging", "Prod"],
              m: true,
            },
          ],
          c: true,
        },
      });
      expect(excerpts["excerpt-and-badge"]).toMatchObject({
        excerptLine: "Change file: src/main.ts",
        badgeCount: 4,
      });
      expect(JSON.parse(String(excerpts["excerpt-and-badge"]!.record!))).toMatchObject({
        x: { a: { k: "file-change", d: "src/main.ts" } },
      });
      expect(excerpts["excerpt-bad-badge"]).toMatchObject({
        excerptLine: "Run command: make",
        badgeCount: null,
      });
      expect(excerpts["badge-bad-excerpt"]).toMatchObject({
        excerptLine: null,
        excerpt: null,
        record: null,
        badgeCount: 2,
      });
      expect(excerpts.approval).toMatchObject({ badgeCount: null });
      for (const name of ["mismatched", "malformed", "none"]) {
        expect(excerpts[name], name).toMatchObject({
          excerptLine: null,
          excerpt: null,
          record: null,
        });
      }

      expect(output.kindTitles).toEqual(expectedKindTitles);
      // The extension's categories are the ones the app registers.
      expect(output.kindCategories).toEqual(expectedKindCategories);
      // The badge is every machine's last known count, the sending one's replaced.
      expect(output.badge).toEqual({
        replaced: { counts: { env_a: 0, env_b: 1 }, total: 1 },
        added: { counts: { env_a: 0, env_b: 1, env_c: 3 }, total: 4 },
      });
      expect(output.vectors.map((vector) => vector.name)).toEqual(
        vectors.map((vector) => vector.name),
      );
      for (const [index, vector] of vectors.entries()) {
        const opened = output.vectors[index]!;
        const plaintext = JSON.parse(vector.plaintext) as {
          readonly k: keyof typeof THREAD_ALERT_COPY;
          readonly t: string;
          readonly th: string;
          readonly tu: string | null;
          readonly rq?: string;
          readonly b?: number;
        };
        // Only an approval names its request.
        const requestId = plaintext.k === "approval" ? (plaintext.rq ?? null) : null;
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
          turnId: plaintext.tu,
          requestId,
          categoryIdentifier: notificationCategoryForKind(plaintext.k),
          // Older nodes seal no count.
          badgeCount: plaintext.b ?? null,
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
          body: {
            environmentId: vector.environmentId,
            threadId: plaintext.th,
            kind: plaintext.k,
            ...(plaintext.tu === null ? {} : { turnId: plaintext.tu }),
            ...(requestId === null ? {} : { requestId }),
          },
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
