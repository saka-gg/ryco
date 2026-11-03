import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  NODE_LINKED_ACCESS_MAX_SUBJECTS,
  NodeLinkedAccessCheckInput,
  NodeLinkedAccessCheckResult,
} from "./nodeLinkedAccess.ts";

const proof = {
  nodeId: `node_${"n".repeat(22)}`,
  protocolMajor: 1,
  protocolMinor: 3,
  nonce: `${"A".repeat(42)}A`,
  signature: `${"B".repeat(85)}A`,
};
const subject = {
  accountId: "acct_1",
  enrollmentId: `enr_${"e".repeat(22)}`,
  clientFingerprint: "f".repeat(43),
};

describe("node linked access contracts", () => {
  const decodeInput = Schema.decodeUnknownSync(NodeLinkedAccessCheckInput);
  const decodeResult = Schema.decodeUnknownSync(NodeLinkedAccessCheckResult);

  it("asks about 1 to 64 devices by account, enrollment and 32-byte key fingerprint", () => {
    expect(decodeInput({ proof, subjects: [subject] }).subjects).toEqual([subject]);
    const { accountId: _accountId, ...beforeAccounts } = subject;
    expect(decodeInput({ proof, subjects: [beforeAccounts] }).subjects).toEqual([beforeAccounts]);

    for (const subjects of [
      [],
      Array(NODE_LINKED_ACCESS_MAX_SUBJECTS + 1).fill(subject),
      [{ ...subject, clientFingerprint: "f".repeat(44) }],
      [{ ...subject, clientFingerprint: `${"f".repeat(42)}=` }],
      [{ ...subject, accountId: "" }],
      [{ ...subject, accountId: "é".repeat(129) }],
      [{ ...subject, enrollmentId: "device-1" }],
    ]) {
      expect(() => decodeInput({ proof, subjects })).toThrow();
    }
  });

  it("answers active with a role, withdrawn or unknown, and tolerates added fields", () => {
    expect(
      decodeResult({
        protocolVersion: 1,
        results: [
          { status: "active", role: "operator" },
          { status: "withdrawn" },
          { status: "unknown", reason: "a field a later Hub adds" },
        ],
      }).results,
    ).toEqual([
      { status: "active", role: "operator" },
      { status: "withdrawn" },
      { status: "unknown" },
    ]);
    expect(() => decodeResult({ protocolVersion: 1, results: [{ status: "active" }] })).toThrow();
    expect(() => decodeResult({ protocolVersion: 2, results: [] })).toThrow();
  });
});
