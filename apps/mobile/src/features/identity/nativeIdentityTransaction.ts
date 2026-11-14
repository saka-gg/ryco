import type { SecretKVService } from "@ryco/client-runtime/platform";
import { isRecord } from "@ryco/shared/unknownValue";

export const NATIVE_IDENTITY_TRANSACTION_KEY = "ryco.nativeIdentity.transaction.v1";

export type NativeIdentityTransactionRecord =
  | {
      readonly version: 1;
      readonly kind: "verified-email-login";
      readonly step: "password";
      readonly origin: string;
      readonly attemptId: string;
      readonly attemptSecret: string;
      readonly activationSecret: string;
      readonly expiresAt: number;
      readonly presentation: string;
    }
  | {
      readonly version: 1;
      readonly kind: "signup";
      readonly step: "mailbox" | "username" | "credential";
      readonly origin: string;
      readonly attemptId: string;
      readonly attemptSecret?: string;
      readonly activationSecret?: string;
      readonly expiresAt: number;
      readonly presentation: string;
    }
  | {
      readonly version: 1;
      readonly kind: "password-login";
      readonly step: "factor";
      readonly origin: string;
      readonly attemptId: string;
      readonly attemptSecret: string;
      readonly expiresAt: number;
      readonly presentation: "totp" | "email_code";
    }
  | {
      readonly version: 1;
      readonly kind: "password-reset";
      readonly step: "mailbox" | "new-password";
      readonly origin: string;
      readonly attemptId: string;
      readonly attemptSecret?: string;
      readonly resetSecret?: string;
      readonly expiresAt: number;
      readonly presentation: string;
      readonly requiresTotp?: boolean;
    };

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlyArray<string>): boolean {
  const keys = new Set(allowed);
  return Object.keys(value).every((key) => keys.has(key));
}

function isBoundedSecret(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 4096;
}

function isOrigin(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return (
      (url.protocol === "https:" || url.protocol === "http:") &&
      url.origin === value &&
      url.username === "" &&
      url.password === "" &&
      url.pathname === "/" &&
      url.search === "" &&
      url.hash === ""
    );
  } catch {
    return false;
  }
}

function decode(raw: string | null, now: number): NativeIdentityTransactionRecord | null {
  if (raw === null) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (
      !isRecord(value) ||
      value.version !== 1 ||
      !isOrigin(value.origin) ||
      !isBoundedSecret(value.attemptId) ||
      typeof value.expiresAt !== "number" ||
      !Number.isSafeInteger(value.expiresAt) ||
      value.expiresAt <= now ||
      !isBoundedSecret(value.presentation) ||
      value.presentation.length > 512
    ) {
      return null;
    }
    if (value.kind === "signup") {
      if (
        !hasOnlyKeys(value, [
          "version",
          "kind",
          "step",
          "origin",
          "attemptId",
          "attemptSecret",
          "activationSecret",
          "expiresAt",
          "presentation",
        ])
      ) {
        return null;
      }
      if (value.step === "mailbox") {
        if (!isBoundedSecret(value.attemptSecret) || value.activationSecret !== undefined) {
          return null;
        }
      } else if (value.step === "username" || value.step === "credential") {
        if (!isBoundedSecret(value.attemptSecret) || !isBoundedSecret(value.activationSecret)) {
          return null;
        }
      } else {
        return null;
      }
    } else if (value.kind === "verified-email-login") {
      if (
        !hasOnlyKeys(value, [
          "version",
          "kind",
          "step",
          "origin",
          "attemptId",
          "attemptSecret",
          "activationSecret",
          "expiresAt",
          "presentation",
        ]) ||
        value.step !== "password" ||
        !isBoundedSecret(value.attemptSecret) ||
        !isBoundedSecret(value.activationSecret)
      ) {
        return null;
      }
    } else if (value.kind === "password-login") {
      if (
        !hasOnlyKeys(value, [
          "version",
          "kind",
          "step",
          "origin",
          "attemptId",
          "attemptSecret",
          "expiresAt",
          "presentation",
        ])
      ) {
        return null;
      }
      if (
        value.step !== "factor" ||
        !isBoundedSecret(value.attemptSecret) ||
        (value.presentation !== "totp" && value.presentation !== "email_code")
      ) {
        return null;
      }
    } else if (value.kind === "password-reset") {
      if (
        !hasOnlyKeys(value, [
          "version",
          "kind",
          "step",
          "origin",
          "attemptId",
          "attemptSecret",
          "resetSecret",
          "expiresAt",
          "presentation",
          "requiresTotp",
        ])
      ) {
        return null;
      }
      if (value.step === "mailbox") {
        if (
          !isBoundedSecret(value.attemptSecret) ||
          value.resetSecret !== undefined ||
          value.requiresTotp !== undefined
        ) {
          return null;
        }
      } else if (value.step === "new-password") {
        if (
          !isBoundedSecret(value.attemptSecret) ||
          !isBoundedSecret(value.resetSecret) ||
          typeof value.requiresTotp !== "boolean"
        ) {
          return null;
        }
      } else {
        return null;
      }
    } else {
      return null;
    }
    return value as unknown as NativeIdentityTransactionRecord;
  } catch {
    return null;
  }
}

export function createNativeIdentityTransactionStore(
  secretKV: SecretKVService,
  now: () => number = Date.now,
) {
  return {
    read: async (): Promise<NativeIdentityTransactionRecord | null> => {
      const record = decode(await secretKV.get(NATIVE_IDENTITY_TRANSACTION_KEY), now());
      if (record === null) {
        try {
          await secretKV.remove(NATIVE_IDENTITY_TRANSACTION_KEY);
        } catch {
          // An unreadable expired record is never authority and cannot resume.
        }
      }
      return record;
    },
    write: (record: NativeIdentityTransactionRecord): Promise<boolean> =>
      secretKV.set(NATIVE_IDENTITY_TRANSACTION_KEY, JSON.stringify(record)),
    clear: () => secretKV.remove(NATIVE_IDENTITY_TRANSACTION_KEY),
  };
}
