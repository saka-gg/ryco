import type { ThreadNotificationEvent } from "@ryco/client-runtime/state/threads";
import { ApprovalRequestId, EnvironmentId, EventId, ThreadId, TurnId } from "@ryco/contracts";
import {
  PUSH_ALERT_EXCERPT_MAX_BYTES,
  PUSH_ALERT_REQUEST_ID_MAX_LENGTH,
  PUSH_ALERT_TITLE_MAX_LENGTH,
  PushAlertPlaintext,
  type PushAlertExcerpt,
} from "@ryco/contracts/push-alert";
import { PUSH_SEALED_LEGACY_MAX_LENGTH, PUSH_SEALED_MAX_LENGTH } from "@ryco/contracts/push-hub";
import { openPushPayload, pushSealAssociatedData } from "@ryco/shared/pushSeal";
import { e2eeX25519KeyPair } from "@ryco/shared/relayE2eeKeys";
import { Schema } from "effect";
import { describe, expect, it } from "vite-plus/test";

import {
  approvalExcerpt,
  clampSealedMaxLength,
  fitAlertPlaintext,
  inputExcerpt,
  maxPlaintextBytes,
} from "./alertExcerpt.ts";
import { sealAttentionDeliveries } from "./attentionPublisher.ts";
import type { PushRegistration } from "./pushRegistrations.ts";

const decodePlaintext = Schema.decodeUnknownSync(PushAlertPlaintext);
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
const deviceKey = e2eeX25519KeyPair();

/** The longest ids a payload can carry: title, request id, environment, thread and turn ids. */
const WORST_ENVIRONMENT = `env_${"e".repeat(60)}`;
const worstBase = (excerptKind: "approval" | "input") =>
  ({
    v: 1,
    k: excerptKind,
    // Three UTF-8 bytes per character: the longest title in bytes.
    t: "語".repeat(PUSH_ALERT_TITLE_MAX_LENGTH),
    e: WORST_ENVIRONMENT,
    th: `thread-${"t".repeat(64)}`,
    tu: `turn-${"u".repeat(64)}`,
    ...(excerptKind === "approval" ? { rq: "r".repeat(PUSH_ALERT_REQUEST_ID_MAX_LENGTH) } : {}),
    q: Number.MAX_SAFE_INTEGER,
    at: Number.MAX_SAFE_INTEGER,
  }) as const;

const longCommand = `npm run build && ${"node scripts/check.mjs --all ".repeat(200)}`;

const bigQuestion = inputExcerpt({
  requestId: ApprovalRequestId.make("question-1"),
  userInputIdentity: { requestEventId: EventId.make("event-question-1") },
  questions: Array.from({ length: 6 }, (_, index) => ({
    id: `q${index}`,
    header: `Header ${index}`,
    question: `${"Which deployment target should the agent use for this release? ".repeat(12)}`,
    options: Array.from({ length: 10 }, (_, option) => ({
      label: `Option ${option} — ${"a fairly long label ".repeat(3)}`,
      description: "ignored",
    })),
    multiSelect: index === 0,
  })),
})!;

describe("alert excerpts", () => {
  it("keeps the approval's kind, command and a reason that adds something", () => {
    expect(
      approvalExcerpt({ requestKind: "command", detail: " npm test ", reason: "Runs tests" }),
    ).toEqual({ a: { k: "command", d: "npm test", r: "Runs tests" } });
    expect(
      approvalExcerpt({ requestKind: "file-change", detail: "src/a.ts", reason: "src/a.ts" }),
    ).toEqual({ a: { k: "file-change", d: "src/a.ts" } });
  });

  it("keeps a question's request, draft key, labels and multi-select, and marks what it left out", () => {
    const excerpt = bigQuestion as Extract<PushAlertExcerpt, { u: unknown }>;
    expect(excerpt.u.rq).toBe("question-1");
    expect(excerpt.u.ev).toBe("event-question-1");
    expect(excerpt.u.qs).toHaveLength(4);
    expect(excerpt.u.qs[0]!.o).toHaveLength(8);
    expect(excerpt.u.qs[0]!.m).toBe(true);
    expect(excerpt.u.c).toBe(true);
    expect(
      inputExcerpt({
        requestId: ApprovalRequestId.make("q"),
        questions: [{ id: "only", header: "Name", question: "What name?", options: [] }],
      }),
    ).toEqual({ u: { rq: "q", qs: [{ id: "only", h: "Name", q: "What name?" }] } });
  });

  it("names the legacy size until a Hub says it takes more, within known bounds", () => {
    expect(clampSealedMaxLength(undefined)).toBe(PUSH_SEALED_LEGACY_MAX_LENGTH);
    expect(clampSealedMaxLength(10)).toBe(PUSH_SEALED_LEGACY_MAX_LENGTH);
    expect(clampSealedMaxLength(PUSH_SEALED_MAX_LENGTH)).toBe(PUSH_SEALED_MAX_LENGTH);
    expect(clampSealedMaxLength(1_000_000)).toBe(PUSH_SEALED_MAX_LENGTH);
    expect(maxPlaintextBytes(PUSH_SEALED_LEGACY_MAX_LENGTH)).toBe(975);
    expect(maxPlaintextBytes(PUSH_SEALED_MAX_LENGTH)).toBe(1_999);
  });

  for (const sealedMaxLength of [PUSH_SEALED_LEGACY_MAX_LENGTH, PUSH_SEALED_MAX_LENGTH]) {
    for (const [name, excerpt] of [
      [
        "approval",
        approvalExcerpt({ requestKind: "command", detail: longCommand, reason: "x".repeat(400) }),
      ],
      ["question", bigQuestion],
    ] as const) {
      it(`fits a worst-case ${name} into ${sealedMaxLength} sealed characters`, () => {
        const base = worstBase(name === "approval" ? "approval" : "input");
        const maxBytes = maxPlaintextBytes(sealedMaxLength);
        const plaintext = fitAlertPlaintext({ base, excerpt, maxBytes });
        expect(plaintext.byteLength).toBeLessThanOrEqual(maxBytes);
        const decoded = decodePlaintext(JSON.parse(new TextDecoder().decode(plaintext)));
        // Even the legacy size leaves room for some excerpt beside the longest base.
        expect(decoded.x).toBeDefined();
        expect(bytes(decoded.x)).toBeLessThanOrEqual(PUSH_ALERT_EXCERPT_MAX_BYTES);
      });
    }
  }

  it("uses nearly the whole kilobyte for a long command once the Hub takes larger payloads", () => {
    const base = worstBase("approval");
    const excerpt = approvalExcerpt({ requestKind: "command", detail: longCommand });
    const legacy = JSON.parse(
      new TextDecoder().decode(
        fitAlertPlaintext({
          base,
          excerpt,
          maxBytes: maxPlaintextBytes(PUSH_SEALED_LEGACY_MAX_LENGTH),
        }),
      ),
    );
    const larger = JSON.parse(
      new TextDecoder().decode(
        fitAlertPlaintext({ base, excerpt, maxBytes: maxPlaintextBytes(PUSH_SEALED_MAX_LENGTH) }),
      ),
    );
    expect(legacy.x.a.d.endsWith("…")).toBe(true);
    expect(larger.x.a.d.length).toBeGreaterThan(legacy.x.a.d.length);
    expect(bytes(larger.x)).toBeGreaterThan(PUSH_ALERT_EXCERPT_MAX_BYTES * 0.75);
  });

  it("drops the reason before it shortens the command", () => {
    const base = { ...worstBase("approval"), t: "short" };
    const excerpt = approvalExcerpt({
      requestKind: "command",
      detail: "c".repeat(300),
      reason: "r".repeat(280),
    });
    const fitted = JSON.parse(
      new TextDecoder().decode(fitAlertPlaintext({ base, excerpt, maxBytes: 975 })),
    );
    expect(fitted.x.a).toEqual({ k: "command", d: "c".repeat(300) });
  });

  it("sends the alert without an excerpt when none fits", () => {
    const base = worstBase("approval");
    const plain = fitAlertPlaintext({ base, excerpt: bigQuestion, maxBytes: bytes(base) + 10 });
    expect(JSON.parse(new TextDecoder().decode(plain))).toEqual(base);
  });

  it("seals every device's copy within the size the Hub takes, and the phone can open it", () => {
    const candidate = {
      id: "n",
      groupKey: "g",
      ref: {
        environmentId: EnvironmentId.make(WORST_ENVIRONMENT),
        threadId: ThreadId.make(`thread-${"t".repeat(64)}`),
      },
      kind: "approval",
      title: "語".repeat(400),
      turnId: TurnId.make(`turn-${"u".repeat(64)}`),
      approvalRequestId: "r".repeat(PUSH_ALERT_REQUEST_ID_MAX_LENGTH),
      sequence: 1,
      generation: {},
    } satisfies ThreadNotificationEvent;
    const registration: PushRegistration = {
      enrollmentId: `enr_${"d".repeat(40)}`,
      keyId: "AAAAAAAAAAAAAAAAAAAAAA",
      publicKey: Buffer.from(deviceKey.publicKey).toString("base64url"),
      role: "owner",
      kinds: ["approval"],
      sound: true,
      collapseSalt: "s".repeat(43),
      createdAt: 0,
      refreshedAt: 0,
    };
    const excerpts = new Map([
      [candidate, approvalExcerpt({ requestKind: "command", detail: longCommand })],
    ]);
    for (const sealedMaxLength of [PUSH_SEALED_LEGACY_MAX_LENGTH, PUSH_SEALED_MAX_LENGTH]) {
      const [delivery] = sealAttentionDeliveries({
        environmentId: WORST_ENVIRONMENT,
        sequence: Number.MAX_SAFE_INTEGER,
        issuedAt: Number.MAX_SAFE_INTEGER,
        recipients: [{ registration, candidate }],
        excerpts,
        sealedMaxLength,
      });
      expect(delivery!.sealed.length).toBeLessThanOrEqual(sealedMaxLength);
      const opened = openPushPayload({
        recipientSecretKey: deviceKey.secretKey,
        sealed: Uint8Array.from(Buffer.from(delivery!.sealed, "base64url")),
        associatedData: pushSealAssociatedData({
          environmentId: WORST_ENVIRONMENT,
          sequence: Number.MAX_SAFE_INTEGER,
          enrollmentId: registration.enrollmentId,
        }),
      });
      const payload = decodePlaintext(JSON.parse(new TextDecoder().decode(opened!)));
      expect(payload.x).toMatchObject({ a: { k: "command" } });
    }
  });
});
