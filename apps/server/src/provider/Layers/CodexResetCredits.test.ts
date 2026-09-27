import { describe, expect, it, vi } from "vitest";
import { Effect } from "effect";
import { ProviderInstanceId, type CodexResetCreditOutcome } from "@ryco/contracts";
import type { CodexAppServerClientShape } from "effect-codex-app-server/client";
import {
  consumeResetCreditWithClient,
  readBoundResetAccount,
  parseResetCredits,
} from "./CodexResetCredits.ts";

const identity = (id: string) => ({
  account: { type: "chatgpt", email: "fixture@example.test" },
  workspaceRouting: { chatgptAccountId: id },
});
function fixture(outcome: CodexResetCreditOutcome = "reset") {
  const accounts = [identity("a")];
  const usage = { accountId: "a", rateLimitResetCredits: { availableCount: 1, credits: null } };
  const consume = vi.fn(() => Effect.succeed({ outcome }));
  const raw = vi.fn((method: string) =>
    Effect.succeed(
      method === "account/read" ? (accounts.length > 1 ? accounts.shift() : accounts[0]) : usage,
    ),
  );
  const client = {
    raw: { request: raw },
    request: consume,
  } as unknown as CodexAppServerClientShape;
  return { client, accounts, usage, consume };
}
async function attempt(client: CodexAppServerClientShape) {
  const account = await Effect.runPromise(readBoundResetAccount(client, "fixture-runtime"));
  return {
    instanceId: ProviderInstanceId.make("fixture-codex"),
    accountBinding: account.accountBinding!,
    idempotencyKey: "fixture-key",
  };
}
describe("Codex reset protocol (fixture clients only)", () => {
  it.each<CodexResetCreditOutcome>(["reset", "alreadyRedeemed", "noCredit", "nothingToReset"])(
    "preserves %s",
    async (outcome) => {
      const { client, consume } = fixture(outcome);
      const input = await attempt(client);
      expect(
        await Effect.runPromise(
          consumeResetCreditWithClient(client, input, "fixture-runtime", Effect.succeed(true)),
        ),
      ).toEqual({ outcome });
      expect(consume).toHaveBeenCalledWith("account/rateLimitResetCredit/consume", {
        idempotencyKey: "fixture-key",
      });
    },
  );
  it("rejects a process that loaded A when the selected account became B before startup", async () => {
    const a = fixture();
    const b = fixture();
    b.accounts[0] = identity("b");
    b.usage.accountId = "b";
    const input = await attempt(b.client);
    await expect(
      Effect.runPromise(
        consumeResetCreditWithClient(a.client, input, "fixture-runtime", Effect.succeed(true)),
      ),
    ).rejects.toThrow("changed");
    expect(a.consume).not.toHaveBeenCalled();
  });
  it("rejects an account change during usage read", async () => {
    const { client, accounts, consume } = fixture();
    const input = await attempt(client);
    accounts.push(identity("b"));
    await expect(
      Effect.runPromise(
        consumeResetCreditWithClient(client, input, "fixture-runtime", Effect.succeed(true)),
      ),
    ).rejects.toThrow("changed");
    expect(consume).not.toHaveBeenCalled();
  });
  it("rejects provider configuration changes before sending", async () => {
    const { client, consume } = fixture();
    await expect(
      Effect.runPromise(
        consumeResetCreditWithClient(
          client,
          await attempt(client),
          "fixture-runtime",
          Effect.succeed(false),
        ),
      ),
    ).rejects.toThrow("changed");
    expect(consume).not.toHaveBeenCalled();
  });
  it("rechecks the subprocess identity after provider revalidation", async () => {
    const { client, accounts, consume } = fixture();
    const input = await attempt(client);
    const verify = Effect.sync(() => {
      accounts[0] = identity("b");
      return true;
    });
    await expect(
      Effect.runPromise(consumeResetCreditWithClient(client, input, "fixture-runtime", verify)),
    ).rejects.toThrow("changed");
    expect(consume).not.toHaveBeenCalled();
  });
  it("reconciles an already redeemed attempt even when the new count is zero", async () => {
    const { client, usage, consume } = fixture("alreadyRedeemed");
    const input = await attempt(client);
    usage.rateLimitResetCredits.availableCount = 0;
    const result = await Effect.runPromise(
      consumeResetCreditWithClient(client, input, "fixture-runtime", Effect.succeed(true)),
    );
    expect(result.outcome).toBe("alreadyRedeemed");
    expect(consume).toHaveBeenCalledOnce();
  });
  it("does not query credits or consume for API-key accounts", async () => {
    const { client, consume } = fixture();
    const request = vi.mocked(client.raw.request);
    request.mockReturnValue(Effect.succeed({ account: { type: "apiKey" } }));
    const result = await Effect.runPromise(readBoundResetAccount(client, "fixture-runtime"));
    expect(result.unavailableReason).toContain("ChatGPT");
    expect(request).toHaveBeenCalledExactlyOnceWith("account/read", {});
    expect(consume).not.toHaveBeenCalled();
  });
  it("gates old runtimes without verifiable account identity", async () => {
    const { client, accounts, consume } = fixture();
    accounts[0] = { account: { type: "chatgpt", email: "fixture@example.test" } } as ReturnType<
      typeof identity
    >;
    const account = await Effect.runPromise(readBoundResetAccount(client, "fixture-runtime"));
    expect(account.accountBinding).toBeUndefined();
    expect(consume).not.toHaveBeenCalled();
  });
  it("keeps summary-only and empty details distinct", () => {
    expect(
      parseResetCredits({
        rateLimits: {},
        rateLimitResetCredits: { availableCount: 2, credits: null },
      }),
    ).toEqual({ availableCount: 2 });
    expect(
      parseResetCredits({
        rateLimits: {},
        rateLimitResetCredits: { availableCount: 2, credits: [] },
      }),
    ).toEqual({ availableCount: 2, credits: [] });
  });
});
