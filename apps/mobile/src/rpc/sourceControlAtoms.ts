// A checkout's source control reads for the phone's Git screens, in one
// bounded mobile query cache with the device copy on: each screen shows the
// last answer at once and reads again behind it. A saved answer is for
// reading only — the screens act on live answers (see `isLiveAnswer`).
//
// Status and the hosting provider come from the node's status stream; the
// screens write each push (`writeData(..., { live: true })`). Local changes
// are read by the staging controller, which binds every write to the revision
// it read; the mirror only shows the last review while that read runs.
import type { EnvironmentId } from "@ryco/contracts";
import { GitLocalChangesResult, VcsListRefsResult, VcsStatusResult } from "@ryco/contracts/git";
import {
  SourceControlDiscoveryResult,
  SourceControlProviderInfo,
} from "@ryco/contracts/source-control";
import { KEY_SEP, type KeyedQueryEnabledInput } from "@ryco/client-runtime/rpc";
import * as Schema from "effect/Schema";

import { ensureEnvironmentApi } from "../connection/environmentApi";
import { createMobileQueryCache, runWithRetry } from "./mobileQueryCache";
import { schemaSavedQueryCodec } from "./savedQueryCodec";

const sourceControlCache = createMobileQueryCache("source-control");

/** Checkouts a reader moves between; each keeps its status, refs and review. */
const CHECKOUT_RETAINED_KEY_LIMIT = 6;
/** Refs the branch picker and the compare screen ask for at once. */
export const REF_PAGE_SIZE = 100;

export interface CheckoutInput {
  readonly environmentId: EnvironmentId | null;
  readonly cwd: string | null;
  readonly enabled?: boolean;
}

type EnabledCheckoutInput<T extends CheckoutInput = CheckoutInput> = KeyedQueryEnabledInput<
  T,
  "environmentId" | "cwd"
>;

function checkoutEnabled<T extends CheckoutInput>(input: T): input is EnabledCheckoutInput<T> {
  return (input.enabled ?? true) && input.environmentId !== null && input.cwd !== null;
}

function checkoutKey(input: CheckoutInput): string {
  return `${input.environmentId}${KEY_SEP}${input.cwd}`;
}

const checkout = {
  retainedKeyLimit: CHECKOUT_RETAINED_KEY_LIMIT,
  isEnabled: checkoutEnabled,
  buildKey: checkoutKey,
  resolveEnvironmentId: (input: EnabledCheckoutInput) => input.environmentId,
} as const;

/** The checkout's full Git status; the status stream writes each push. */
export const vcsStatusQuery = sourceControlCache.defineQuery<
  CheckoutInput,
  VcsStatusResult,
  EnabledCheckoutInput
>({
  ...checkout,
  label: "status",
  staleTime: 5_000,
  persist: schemaSavedQueryCodec(VcsStatusResult, 1),
  run: (input) =>
    ensureEnvironmentApi(input.environmentId).vcs.refreshStatus({
      cwd: input.cwd,
    }),
});

export interface SourceControlProviderAnswer {
  readonly provider: SourceControlProviderInfo | null;
}

/**
 * The checkout's hosting provider, from the status summary stream: it decides
 * which pull request reads the host serves, so a saved one lets those screens
 * show their saved reads before the node answers.
 */
export const sourceControlProviderMirror = sourceControlCache.defineSavedMirror<
  CheckoutInput,
  SourceControlProviderAnswer,
  EnabledCheckoutInput
>({
  ...checkout,
  label: "provider",
  persist: schemaSavedQueryCodec(
    Schema.Struct({ provider: Schema.NullOr(SourceControlProviderInfo) }),
    1,
  ),
});

/** The last staging review, shown while the staging controller reads again. */
export const localChangesMirror = sourceControlCache.defineSavedMirror<
  CheckoutInput,
  GitLocalChangesResult,
  EnabledCheckoutInput
>({
  ...checkout,
  label: "changes",
  persist: schemaSavedQueryCodec(GitLocalChangesResult, 1),
});

/** The first page of refs (no search): the branch picker's list and compare's choices. */
export const vcsRefsQuery = sourceControlCache.defineQuery<
  CheckoutInput,
  VcsListRefsResult,
  EnabledCheckoutInput
>({
  ...checkout,
  label: "refs",
  staleTime: 15_000,
  persist: schemaSavedQueryCodec(VcsListRefsResult, 1),
  run: (input) =>
    runWithRetry(() =>
      ensureEnvironmentApi(input.environmentId).vcs.listRefs({
        cwd: input.cwd,
        limit: REF_PAGE_SIZE,
      }),
    ),
});

export interface RefSearchInput extends CheckoutInput {
  readonly query: string;
}

/** A typed ref search: asked of the node, never saved. */
export const vcsRefSearchQuery = sourceControlCache.defineQuery<
  RefSearchInput,
  VcsListRefsResult,
  EnabledCheckoutInput<RefSearchInput>
>({
  ...checkout,
  label: "ref-search",
  staleTime: 15_000,
  retainedKeyLimit: 4,
  isEnabled: (input): input is EnabledCheckoutInput<RefSearchInput> =>
    checkoutEnabled(input) && input.query.length > 0,
  buildKey: (input) => `${checkoutKey(input)}${KEY_SEP}${input.query}`,
  run: (input) =>
    ensureEnvironmentApi(input.environmentId).vcs.listRefs({
      cwd: input.cwd,
      limit: REF_PAGE_SIZE,
      query: input.query,
    }),
});

export interface NodeInput {
  readonly environmentId: EnvironmentId | null;
}

/** The hosts the node is signed in to (publish): the node's recent answer, then saved. */
type EnabledNodeInput = KeyedQueryEnabledInput<NodeInput, "environmentId">;

export const sourceControlDiscoveryQuery = sourceControlCache.defineQuery<
  NodeInput,
  SourceControlDiscoveryResult,
  EnabledNodeInput
>({
  label: "discovery",
  staleTime: 60_000,
  retainedKeyLimit: 2,
  isEnabled: (input): input is EnabledNodeInput => input.environmentId !== null,
  buildKey: (input) => `${input.environmentId}`,
  resolveEnvironmentId: (input) => input.environmentId,
  persist: schemaSavedQueryCodec(SourceControlDiscoveryResult, 1),
  run: (input) => {
    const server = ensureEnvironmentApi(input.environmentId).server;
    if (!server) return Promise.reject(new Error("This node cannot list its hosts."));
    return server.discoverSourceControl({ cached: true });
  },
});

/**
 * Whether a read is the node's live answer. A screen may offer actions only
 * on live answers: a saved one shows what was true, not what is.
 */
export function isLiveAnswer(read: { readonly data: unknown; readonly savedAt: number | null }) {
  return read.data !== null && read.savedAt === null;
}

/** After a change to a checkout (switch, commit, pull): its status and refs read again. */
export function refreshCheckoutReads(environmentId: EnvironmentId, cwd: string): void {
  sourceControlCache.refreshMatching(
    ([label, environment, checkoutCwd]) =>
      environment === environmentId &&
      checkoutCwd === cwd &&
      (label === "status" || label === "refs" || label === "ref-search"),
  );
}

export function resetSourceControlAtomsForTests(): void {
  sourceControlCache.resetForTests();
}
