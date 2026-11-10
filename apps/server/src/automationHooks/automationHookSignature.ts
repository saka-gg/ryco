/**
 * automationHookSignature - Whether a hook request is authentic (`docs/automation-webhooks.md`).
 *
 * GitHub's format: `X-Hub-Signature-256: sha256=<hex HMAC-SHA256(secret, raw body)>`, or the same
 * value in `X-Ryco-Signature-256` when the GitHub header is absent. Directly, the node also takes
 * `Authorization: Bearer <secret>`. Every comparison is constant time.
 *
 * @module automationHooks/automationHookSignature
 */
import { createHmac, timingSafeEqual } from "node:crypto";

import {
  AUTOMATION_HOOK_RYCO_SIGNATURE_HEADER,
  AUTOMATION_HOOK_SIGNATURE_HEADER,
} from "@ryco/contracts/automation-hooks";

const SIGNATURE_PATTERN = /^sha256=([0-9a-fA-F]{64})$/u;

/** `sha256=` and the lowercase hex HMAC-SHA256 of `body` under the secret (as senders key it). */
export function signAutomationHookBody(secret: string, body: Uint8Array): string {
  return `sha256=${createHmac("sha256", Buffer.from(secret, "utf8")).update(body).digest("hex")}`;
}

function equalBytes(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Whether the request proves the secret: the signature header (GitHub's first, else Ryco's), or,
 * when `allowBearer` (the direct path only), a bearer equal to the secret.
 */
export function verifyAutomationHookRequest(input: {
  readonly secret: string;
  readonly body: Uint8Array;
  /** Lowercase header names. */
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly allowBearer: boolean;
}): boolean {
  const signature =
    input.headers[AUTOMATION_HOOK_SIGNATURE_HEADER] ??
    input.headers[AUTOMATION_HOOK_RYCO_SIGNATURE_HEADER];
  if (signature !== undefined) {
    const match = SIGNATURE_PATTERN.exec(signature.trim());
    if (match === null) return false;
    const expected = createHmac("sha256", Buffer.from(input.secret, "utf8"))
      .update(input.body)
      .digest();
    return equalBytes(Buffer.from(match[1]!.toLowerCase(), "hex"), expected);
  }
  if (!input.allowBearer) return false;
  const authorization = input.headers.authorization;
  if (authorization === undefined) return false;
  const bearer = /^Bearer[ \t]+(\S+)[ \t]*$/iu.exec(authorization)?.[1];
  if (bearer === undefined) return false;
  return equalBytes(Buffer.from(bearer, "utf8"), Buffer.from(input.secret, "utf8"));
}
