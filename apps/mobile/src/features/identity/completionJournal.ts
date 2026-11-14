import type { SecretKVService } from "@ryco/client-runtime/platform";
import type { HubSessionIdentity } from "@ryco/contracts/hosted-identity";

import type { MobileSessionCredentials } from "../../platform/sessionCredentials";
import { isRecord } from "@ryco/shared/unknownValue";

export const NATIVE_IDENTITY_COMPLETION_JOURNAL_KEY = "ryco.nativeIdentity.completion.v1";

export type NativeIdentityCompletionJournal =
  | {
      readonly version: 1;
      readonly phase: "recovery-pending";
      readonly origin: string;
      readonly token: string;
      readonly identity: HubSessionIdentity;
      readonly recoveryCodes: ReadonlyArray<string>;
    }
  | {
      readonly version: 1;
      readonly phase: "credential-committed";
      readonly origin: string;
      readonly token: string;
      readonly identity: HubSessionIdentity;
    };

function hasExactKeys(value: Record<string, unknown>, expected: ReadonlyArray<string>): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => keys.includes(key));
}

function isOrigin(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return (
      (url.protocol === "https:" || url.protocol === "http:") &&
      url.origin === value &&
      url.pathname === "/" &&
      url.search === "" &&
      url.hash === "" &&
      url.username === "" &&
      url.password === ""
    );
  } catch {
    return false;
  }
}

function decode(raw: string | null): NativeIdentityCompletionJournal | null {
  if (raw === null) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!isRecord(value) || value.version !== 1) return null;
    if (value.phase !== "recovery-pending" && value.phase !== "credential-committed") return null;
    if (
      !isOrigin(value.origin) ||
      typeof value.token !== "string" ||
      value.token.length === 0 ||
      value.token.length > 4096 ||
      !isRecord(value.identity)
    ) {
      return null;
    }
    if (value.phase === "recovery-pending") {
      if (
        !hasExactKeys(value, [
          "version",
          "phase",
          "origin",
          "token",
          "identity",
          "recoveryCodes",
        ]) ||
        !Array.isArray(value.recoveryCodes) ||
        value.recoveryCodes.length === 0 ||
        value.recoveryCodes.length > 256 ||
        !value.recoveryCodes.every(
          (code) => typeof code === "string" && code.length > 0 && code.length <= 512,
        )
      ) {
        return null;
      }
      return value as unknown as NativeIdentityCompletionJournal;
    }
    if (
      !hasExactKeys(value, ["version", "phase", "origin", "token", "identity"]) ||
      "recoveryCodes" in value
    ) {
      return null;
    }
    return value as unknown as NativeIdentityCompletionJournal;
  } catch {
    return null;
  }
}

export function createNativeIdentityCompletionJournal(input: {
  readonly secretKV: SecretKVService;
  readonly sessionCredentials: Pick<MobileSessionCredentials, "commitBearerToken">;
}) {
  const write = async (value: NativeIdentityCompletionJournal): Promise<boolean> =>
    input.secretKV.set(NATIVE_IDENTITY_COMPLETION_JOURNAL_KEY, JSON.stringify(value));

  return {
    read: async (): Promise<NativeIdentityCompletionJournal | null> =>
      decode(await input.secretKV.get(NATIVE_IDENTITY_COMPLETION_JOURNAL_KEY)),
    stage: async (value: NativeIdentityCompletionJournal): Promise<boolean> => write(value),
    acknowledgeRecovery: async (
      value: Extract<NativeIdentityCompletionJournal, { phase: "recovery-pending" }>,
    ): Promise<Extract<
      NativeIdentityCompletionJournal,
      { phase: "credential-committed" }
    > | null> => {
      const next: Extract<NativeIdentityCompletionJournal, { phase: "credential-committed" }> = {
        version: 1,
        phase: "credential-committed",
        origin: value.origin,
        token: value.token,
        identity: value.identity,
      };
      return (await write(next)) ? next : null;
    },
    commitCredential: async (
      value: Extract<NativeIdentityCompletionJournal, { phase: "credential-committed" }>,
    ): Promise<boolean> => {
      if (!(await input.sessionCredentials.commitBearerToken(value.token))) return false;
      try {
        await input.secretKV.remove(NATIVE_IDENTITY_COMPLETION_JOURNAL_KEY);
        return true;
      } catch {
        return false;
      }
    },
    clear: () => input.secretKV.remove(NATIVE_IDENTITY_COMPLETION_JOURNAL_KEY),
  };
}
