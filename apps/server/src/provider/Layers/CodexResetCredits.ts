import { scopedSafeTeardown } from "./scopedSafeTeardown.ts";
import { createHash } from "node:crypto";
import { Duration, Effect, Layer, Schema } from "effect";
import {
  CodexResetCreditError,
  type CodexResetCreditAccount,
  type CodexResetCreditInput,
  type CodexResetCredits,
} from "@ryco/contracts";
import * as CodexClient from "effect-codex-app-server/client";
import * as CodexSchema from "effect-codex-app-server/schema";
import { expandHomePath } from "../../pathExpansion.ts";

export function parseResetCredits(
  response: CodexSchema.V2GetAccountRateLimitsResponse,
): CodexResetCredits | undefined {
  const value = response.rateLimitResetCredits;
  if (!value) return undefined;
  return {
    availableCount: value.availableCount,
    ...(value.credits == null
      ? {}
      : {
          credits: value.credits.map((credit) => ({
            id: credit.id,
            status: credit.status,
            resetType: credit.resetType,
            grantedAt: credit.grantedAt,
            title: credit.title ?? undefined,
            description: credit.description ?? undefined,
            expiresAt: credit.expiresAt,
          })),
        }),
  };
}

export interface ResetCreditRuntime {
  readonly instanceId: string;
  readonly binaryPath: string;
  readonly homePath: string;
  readonly environment: NodeJS.ProcessEnv;
}
const unavailable = () =>
  new CodexResetCreditError({
    message:
      "Reset credits are unavailable for this runtime or account. Refresh usage and check Codex authentication.",
  });
const changed = () =>
  new CodexResetCreditError({
    message: "The selected Codex account or provider changed. Refresh before confirming a reset.",
  });
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

// Focused forward-compatible decoders verified against Codex 0.157.0's locally
// generated experimental JSON schema. Do not change the provider credential store.
const AccountIdentity = Schema.Struct({
  account: Schema.optional(
    Schema.NullOr(
      Schema.Struct({ type: Schema.String, email: Schema.optional(Schema.NullOr(Schema.String)) }),
    ),
  ),
  workspaceRouting: Schema.optional(
    Schema.NullOr(Schema.Struct({ chatgptAccountId: Schema.String })),
  ),
});
const CreditSnapshot = Schema.Struct({
  accountId: Schema.optional(Schema.NullOr(Schema.String)),
  rateLimitResetCredits: Schema.optional(
    Schema.NullOr(CodexSchema.V2GetAccountRateLimitsResponse__RateLimitResetCreditsSummary),
  ),
});
export const runtimeBinding = (input: ResetCreditRuntime) =>
  hash(
    JSON.stringify([
      input.instanceId,
      input.binaryPath,
      input.homePath,
      Object.entries(input.environment).toSorted(([a], [b]) => a.localeCompare(b)),
    ]),
  );
const accountBinding = (runtime: string, accountId: string, email: string) =>
  hash(JSON.stringify([runtime, accountId, email]));
const readClientAccount = (client: CodexClient.CodexAppServerClientShape) =>
  client.raw
    .request("account/read", {})
    .pipe(Effect.flatMap(Schema.decodeUnknownEffect(AccountIdentity)));
const readClientCredits = (client: CodexClient.CodexAppServerClientShape) =>
  client.raw
    .request("account/rateLimits/read", undefined)
    .pipe(Effect.flatMap(Schema.decodeUnknownEffect(CreditSnapshot)));

export const readBoundResetAccount = (
  client: CodexClient.CodexAppServerClientShape,
  runtime: string,
) =>
  Effect.gen(function* () {
    const before = yield* readClientAccount(client);
    if (before.account?.type !== "chatgpt")
      return {
        unavailableReason: "Reset credits require a ChatGPT-backed account.",
      } satisfies CodexResetCreditAccount;
    const limits = yield* readClientCredits(client);
    const after = yield* readClientAccount(client);
    const credits = parseResetCredits({
      rateLimits: {},
      rateLimitResetCredits: limits.rateLimitResetCredits ?? null,
    });
    const id = before.workspaceRouting?.chatgptAccountId;
    if (
      before.account?.type !== "chatgpt" ||
      !id ||
      !before.account.email ||
      before.account.email !== after.account?.email ||
      limits.accountId !== id ||
      after.workspaceRouting?.chatgptAccountId !== id ||
      after.account?.type !== "chatgpt"
    ) {
      return {
        ...(credits ? { credits } : {}),
        unavailableReason:
          "This runtime cannot verify a stable ChatGPT account identity. Refresh usage or update Codex.",
      } satisfies CodexResetCreditAccount;
    }
    return {
      ...(credits
        ? { accountBinding: accountBinding(runtime, id, before.account.email), credits }
        : { unavailableReason: "This Codex runtime or account does not report reset credits." }),
      ...(after.account.email ? { accountLabel: after.account.email } : {}),
    } satisfies CodexResetCreditAccount;
  }).pipe(Effect.map((value): CodexResetCreditAccount => value));

export const withResetCreditClient = <A, E, R>(
  input: ResetCreditRuntime,
  run: (client: CodexClient.CodexAppServerClientShape) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const context = yield* Layer.build(
      CodexClient.layerCommand({
        command: input.binaryPath || "codex",
        args: ["app-server"],
        cwd: process.cwd(),
        env: {
          ...input.environment,
          ...(input.homePath ? { CODEX_HOME: expandHomePath(input.homePath) } : {}),
        },
        requestTimeoutMs: 15_000,
      }),
    );
    const client = yield* Effect.service(CodexClient.CodexAppServerClient).pipe(
      Effect.provide(context),
    );
    yield* client.request("initialize", {
      clientInfo: { name: "ryco", version: "0.1.0" },
      capabilities: { experimentalApi: true },
    });
    yield* client.notify("initialized", undefined);
    return yield* run(client);
  }).pipe(Effect.timeout(Duration.seconds(20)), scopedSafeTeardown("codex-reset-credits"));

export const readResetAccount = (input: ResetCreditRuntime) =>
  withResetCreditClient(input, (client) =>
    readBoundResetAccount(client, runtimeBinding(input)),
  ).pipe(Effect.mapError(() => unavailable()));

/** Revalidate the ACTUAL subprocess account, not ambient auth files. Retry calls
 * reach upstream with the same key even after credits or usage fall to zero. */
export const consumeResetCreditWithClient = <R>(
  client: CodexClient.CodexAppServerClientShape,
  input: CodexResetCreditInput,
  runtime: string,
  verifyRuntime: Effect.Effect<boolean, never, R>,
) =>
  Effect.gen(function* () {
    const account = yield* readBoundResetAccount(client, runtime);
    if (account.accountBinding !== input.accountBinding || !(yield* verifyRuntime))
      return yield* Effect.fail(changed());
    const finalAccount = yield* readClientAccount(client);
    const finalId = finalAccount.workspaceRouting?.chatgptAccountId;
    if (
      finalAccount.account?.type !== "chatgpt" ||
      !finalId ||
      !finalAccount.account.email ||
      accountBinding(runtime, finalId, finalAccount.account.email) !== input.accountBinding
    )
      return yield* Effect.fail(changed());
    const result = yield* client.request("account/rateLimitResetCredit/consume", {
      idempotencyKey: input.idempotencyKey,
    });
    // Refresh is performed outside this timeout-bounded mutation by the RPC/UI.
    return result;
  });

export const consumeResetCredit = <R>(
  runtime: ResetCreditRuntime,
  input: CodexResetCreditInput,
  verifyRuntime: Effect.Effect<boolean, never, R>,
) =>
  withResetCreditClient(runtime, (client) =>
    consumeResetCreditWithClient(client, input, runtimeBinding(runtime), verifyRuntime),
  ).pipe(
    Effect.mapError((error) =>
      Schema.is(CodexResetCreditError)(error)
        ? error
        : new CodexResetCreditError({
            message:
              "The reset result is uncertain. Retry this same attempt after reconnecting; do not start another reset.",
          }),
    ),
  );
