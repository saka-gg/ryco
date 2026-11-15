import * as FS from "node:fs";

import { EnvironmentId } from "@ryco/contracts";
import { UNIFIED_WORKSPACE_MAX_CONNECTIONS } from "@ryco/client-runtime/state/workspace";

import { writeFileAtomicallySync } from "./atomicFileWrite.ts";

const DOCUMENT_VERSION = 1 as const;
const MAX_TEXT_LENGTH = 2_048;

/** Whose last warm set a list is: one Hub origin and one account on it. */
export interface DesktopWorkspaceWarmSetNamespace {
  readonly hubOrigin: string;
  readonly accountId: string;
}

/**
 * The last warm set of the signed-in account: the up to three most recently
 * used machines, newest first, so a new launch can restore it.
 */
export interface DesktopWorkspaceWarmSetStore {
  /** The stored list of this account, or none. */
  readonly read: (namespace: DesktopWorkspaceWarmSetNamespace) => ReadonlyArray<EnvironmentId>;
  /** Replaces the stored list, and with it any other account's. */
  readonly write: (
    namespace: DesktopWorkspaceWarmSetNamespace,
    environmentIds: ReadonlyArray<EnvironmentId>,
  ) => void;
  /** Deletes the stored list. */
  readonly clear: () => void;
}

interface DesktopWorkspaceWarmSetDocument {
  readonly version: typeof DOCUMENT_VERSION;
  readonly hubOrigin: string;
  readonly accountId: string;
  readonly environmentIds: ReadonlyArray<string>;
}

function normalizeOrigin(origin: string): string {
  return origin.replace(/\/+$/gu, "").toLowerCase();
}

function isBoundedText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_TEXT_LENGTH;
}

function readDocument(filePath: string): DesktopWorkspaceWarmSetDocument | null {
  let raw: string;
  try {
    raw = FS.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
  try {
    const value = JSON.parse(raw) as unknown;
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    const document = value as Partial<DesktopWorkspaceWarmSetDocument>;
    if (
      document.version !== DOCUMENT_VERSION ||
      !isBoundedText(document.hubOrigin) ||
      !isBoundedText(document.accountId) ||
      !Array.isArray(document.environmentIds)
    ) {
      return null;
    }
    return {
      version: DOCUMENT_VERSION,
      hubOrigin: document.hubOrigin,
      accountId: document.accountId,
      environmentIds: document.environmentIds.filter(isBoundedText),
    };
  } catch {
    return null;
  }
}

/**
 * Desktop UI-client state only: place the file below the dedicated
 * `desktop-workspace-client` directory. It holds one small list, written
 * owner-only and atomically whenever the most recently used machines change
 * order, and read once per sign-in. What it reads back is untrusted: anything
 * malformed reads as no list, and the list is bounded to the connection limit.
 */
export function createDesktopWorkspaceWarmSetStore(filePath: string): DesktopWorkspaceWarmSetStore {
  return {
    read: (namespace) => {
      const document = readDocument(filePath);
      if (
        document === null ||
        normalizeOrigin(document.hubOrigin) !== normalizeOrigin(namespace.hubOrigin) ||
        document.accountId !== namespace.accountId
      ) {
        return [];
      }
      return Array.from(new Set(document.environmentIds))
        .flatMap((environmentId) => {
          try {
            return [EnvironmentId.make(environmentId)];
          } catch {
            return [];
          }
        })
        .slice(0, UNIFIED_WORKSPACE_MAX_CONNECTIONS);
    },
    write: (namespace, environmentIds) => {
      const document: DesktopWorkspaceWarmSetDocument = {
        version: DOCUMENT_VERSION,
        hubOrigin: normalizeOrigin(namespace.hubOrigin),
        accountId: namespace.accountId,
        environmentIds: environmentIds.slice(0, UNIFIED_WORKSPACE_MAX_CONNECTIONS),
      };
      writeFileAtomicallySync(filePath, `${JSON.stringify(document)}\n`);
    },
    clear: () => {
      FS.rmSync(filePath, { force: true });
    },
  };
}
