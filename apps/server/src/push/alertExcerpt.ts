/**
 * alertExcerpt - The excerpt an approval or question alert carries (`docs/push-alerts.md`): what
 * the agent asks to do, or what it asks the person, sealed with the rest of the payload so the
 * phone can show it on the Lock Screen and open the thread with its card already there.
 *
 * Pure: it takes the open request the clients' own `derivePendingApprovals` /
 * `derivePendingUserInputs` derive, and fits the sealed plaintext to what the Hub takes. Text cut
 * short ends with "…"; whatever does not fit is left out, and when even the shortest excerpt does
 * not fit, the alert goes without one, exactly as before.
 *
 * @module push/alertExcerpt
 */
import type { PendingApproval, PendingUserInput } from "@ryco/client-runtime/state/session";
import {
  PUSH_ALERT_EXCERPT_MAX_BYTES,
  PUSH_SEALED_LEGACY_MAX_LENGTH,
  PUSH_SEALED_MAX_LENGTH,
  PUSH_SEALED_OVERHEAD_BYTES,
  type PushAlertExcerpt,
  type PushAlertInputExcerpt,
  type PushAlertPlaintext,
  type PushAlertQuestionExcerpt,
} from "@ryco/contracts/push-hub";

const encoder = new TextEncoder();
const byteLength = (text: string) => encoder.encode(text).byteLength;
const ELLIPSIS = "…";

/** Field caps before the byte budget: a question card never needs more on a phone. */
const HEADER_MAX_CHARS = 60;
const QUESTION_MAX_CHARS = 600;
const OPTION_MAX_CHARS = 80;
const OPTIONS_MAX = 8;
const QUESTIONS_MAX = 4;
const REASON_MAX_CHARS = 280;

/** The plaintext bytes a seal of at most `sealedMaxLength` base64url characters can carry. */
export function maxPlaintextBytes(sealedMaxLength: number): number {
  return Math.floor((sealedMaxLength * 6) / 8) - PUSH_SEALED_OVERHEAD_BYTES;
}

/**
 * The sealed length a Hub's answer allows: its `sealedMaxLength` within the bounds this node
 * knows, the legacy length when it names none (an older Hub).
 */
export function clampSealedMaxLength(advertised: number | undefined): number {
  if (advertised === undefined || !Number.isSafeInteger(advertised)) {
    return PUSH_SEALED_LEGACY_MAX_LENGTH;
  }
  return Math.min(PUSH_SEALED_MAX_LENGTH, Math.max(PUSH_SEALED_LEGACY_MAX_LENGTH, advertised));
}

/** Cuts `text` to at most `maxChars` code points, ending with "…" when it was cut. */
function clip(text: string, maxChars: number): string {
  const trimmed = text.trim();
  const points = Array.from(trimmed);
  if (points.length <= maxChars) return trimmed;
  return `${points
    .slice(0, Math.max(0, maxChars - 1))
    .join("")
    .trimEnd()}${ELLIPSIS}`;
}

/** The excerpt of an open approval: its kind, command or path, and the provider's reason. */
export function approvalExcerpt(
  approval: Pick<PendingApproval, "requestKind" | "detail" | "reason">,
): PushAlertExcerpt {
  const detail = approval.detail?.trim() ?? "";
  const reason = approval.reason?.trim() ?? "";
  return {
    a: {
      k: approval.requestKind,
      ...(detail === "" ? {} : { d: detail }),
      // The card shows a reason only when it says more than the request itself.
      ...(reason === "" || reason === detail ? {} : { r: clip(reason, REASON_MAX_CHARS) }),
    },
  };
}

/** The excerpt of an open question: its request, and its questions with their option labels. */
export function inputExcerpt(
  userInput: Pick<PendingUserInput, "requestId" | "userInputIdentity" | "questions">,
): PushAlertExcerpt | null {
  if (userInput.questions.length === 0) return null;
  let cut = userInput.questions.length > QUESTIONS_MAX;
  const questions = userInput.questions.slice(0, QUESTIONS_MAX).map((question) => {
    const header = question.header.trim();
    const options = question.options.slice(0, OPTIONS_MAX).map((option) => option.label);
    if (question.options.length > OPTIONS_MAX) cut = true;
    return {
      id: question.id,
      ...(header === "" ? {} : { h: clip(header, HEADER_MAX_CHARS) }),
      q: clip(question.question, QUESTION_MAX_CHARS),
      ...(options.length === 0 ? {} : { o: options.map((label) => clip(label, OPTION_MAX_CHARS)) }),
      ...(question.multiSelect === true ? { m: true as const } : {}),
    } satisfies PushAlertQuestionExcerpt;
  });
  const requestEventId = userInput.userInputIdentity?.requestEventId;
  return {
    u: {
      rq: userInput.requestId,
      ...(requestEventId === undefined ? {} : { ev: requestEventId }),
      qs: questions,
      ...(cut ? { c: true as const } : {}),
    },
  };
}

/** Shorter forms of an excerpt, longest first; each is tried until one fits. */
function* shorterExcerpts(excerpt: PushAlertExcerpt): Generator<PushAlertExcerpt> {
  if ("a" in excerpt) {
    const { k, d, r } = excerpt.a;
    yield excerpt;
    // The reason goes first: the command is what is approved.
    const withoutReason = { a: { k, ...(d === undefined ? {} : { d }) } };
    if (r !== undefined) yield withoutReason;
    if (d === undefined) return;
    const points = Array.from(d).length;
    for (let chars = Math.min(points - 1, 2_000); chars >= 16; chars = Math.floor(chars * 0.8)) {
      yield { a: { k, d: clip(d, chars) } };
    }
    yield { a: { k } };
    return;
  }
  const input = excerpt.u;
  yield excerpt;
  const base = (qs: ReadonlyArray<PushAlertQuestionExcerpt>, cut: boolean): PushAlertExcerpt => ({
    u: {
      rq: input.rq,
      ...(input.ev === undefined ? {} : { ev: input.ev }),
      qs,
      ...(cut || input.c === true ? { c: true as const } : {}),
    } satisfies PushAlertInputExcerpt,
  });
  // Fewer questions, then fewer options, then shorter text.
  for (let count = input.qs.length - 1; count >= 1; count -= 1) {
    yield base(input.qs.slice(0, count), true);
  }
  const first = input.qs[0]!;
  for (let options = (first.o?.length ?? 0) - 1; options >= 0; options -= 1) {
    const { o: _options, ...rest } = first;
    yield base([options === 0 ? rest : { ...rest, o: first.o!.slice(0, options) }], true);
  }
  const { o: _options, h: _header, ...bare } = first;
  for (
    let chars = Math.min(Array.from(bare.q).length - 1, QUESTION_MAX_CHARS);
    chars >= 16;
    chars = Math.floor(chars * 0.8)
  ) {
    yield base([{ ...bare, q: clip(bare.q, chars) }], true);
  }
}

/**
 * The plaintext to seal: `base` with the longest form of `excerpt` that keeps the excerpt within
 * {@link PUSH_ALERT_EXCERPT_MAX_BYTES} and the whole plaintext within `maxBytes`; without one
 * when none fits. `base` itself always goes (it fits the legacy limit by construction).
 */
export function fitAlertPlaintext(input: {
  readonly base: PushAlertPlaintext;
  readonly excerpt: PushAlertExcerpt | null;
  readonly maxBytes: number;
}): Uint8Array {
  const plain = encoder.encode(JSON.stringify(input.base));
  if (input.excerpt === null) return plain;
  for (const candidate of shorterExcerpts(input.excerpt)) {
    if (byteLength(JSON.stringify(candidate)) > PUSH_ALERT_EXCERPT_MAX_BYTES) continue;
    const bytes = encoder.encode(JSON.stringify({ ...input.base, x: candidate }));
    if (bytes.byteLength <= input.maxBytes) return bytes;
  }
  return plain;
}
